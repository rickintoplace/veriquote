/**
 * The EVI1 protocol: a plain-text convention that lets an LLM attach
 * verifiable evidence to its answer.
 *
 * In the answer body, every cited sentence ends with citation markers and a
 * claim marker, e.g. `...water expands when freezing.[2][5]{c1}`. After the
 * answer, the model appends:
 *
 *     EVI1
 *     c1|2|"verbatim quote from source 2"
 *     c1|5|"verbatim quote from source 5"
 *     END_EVI1
 *
 * A (claim, source) pair may have several lines when one passage does not
 * cover the whole claim. With `evidenceFirst` prompting the block comes
 * before the answer instead; the parser accepts either position.
 *
 * Quotes are single-line, with `\n`, `\"` and `\\` escapes.
 *
 * The parser is lenient about how the appendix is framed (see
 * `parseEvi1Appendix`), strict about the evidence lines themselves.
 */

import type { Claim, EvidenceItem, ParsedAnswer } from '../types.js';
import { collapseWhitespace } from '../match/normalize.js';

export const EVI1_START = 'EVI1';
export const EVI1_END = 'END_EVI1';

const EVIDENCE_LINE = /^(c\d+)\s*\|\s*(\d+)\s*\|\s*"([\s\S]*)"$/;
const CLAIM_MARKER = /\{c(\d+)\}/g;
const CITATION_GROUP_BEFORE_CLAIM = /((?:\[\d+\])+)$/;

// Models and gateways garble the appendix slightly: "**EVI1**", "EVI1:",
// "EVI1 c1|2|...", a code fence around it, END_EVI11 or no END_EVI1 at all.
// The lookahead keeps a sentence about the EVI1 gene from opening an appendix.
const START_LINE = /^[\s*_`>#]*EVI1[\s*_`:]*(?=$|c\d+\s*\|)/;
const END_LINE = /^[\s*_`]*END_EVI1/;
const EVIDENCE_PREFIX = /^\s*c\d+\s*\|\s*\d+\s*\|/;
// Without END_EVI1, the appendix runs as long as lines look like evidence,
// malformed ones included (they get a warning, not the answer body).
const EVIDENCE_LIKE = /^\s*c\d+\s*\|/;
const FENCE_LINE = /^\s*```\s*\w*\s*$/;
// While streaming, the last line may be the beginning of an EVI1, evidence or END_EVI1 line.
const PARTIAL_START =
  /^[\s*_`>#]*(?:E(?:V(?:I(?:1[\s*_`:]*(?:c\d*)?)?)?)?)?$|^[\s*_`]*EN(?:D(?:_(?:E(?:V(?:I1?)?)?)?)?)?$|^\s*c\d*(?:\s*\|\s*\d*)?\s*$/;
const PARTIAL_MARKER = /\{(?:c\d*)?$/;

/** Unescape an EVI1 quote payload (`\\`, `\n`, `\"`) in a single pass. */
function unescapeQuote(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
}

/** Escape a quote for serialization into an EVI1 line. */
function escapeQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

interface AppendixLocation {
  /** First line to cut: the EVI1 line (or first evidence line), or a fence opened just before it. */
  cutStart: number;
  /**
   * First line after the appendix: past END_EVI1 and a closing fence, or,
   * without END_EVI1, the first line that is not evidence (an answer after an
   * evidence-first block), else `lines.length`.
   */
  cutEnd: number;
  /** Candidate evidence lines, the text after an inline `EVI1` header included. */
  body: string[];
}

const isBlank = (line: string) => !line.trim();

/**
 * Whether the EVI1 line at `start` really opens the appendix: the next
 * non-blank line is evidence, or END_EVI1 follows somewhere.
 * A heading "## EVI1" followed by prose does not.
 */
function opensAppendix(lines: string[], start: number): boolean {
  if (lines[start].replace(START_LINE, '').trim()) return true; // "EVI1 c1|…"
  let i = start + 1;
  while (i < lines.length && (isBlank(lines[i]) || FENCE_LINE.test(lines[i]))) i++;
  if (EVIDENCE_PREFIX.test(lines[i] ?? '')) return true;
  return lines.slice(i).some((l) => END_LINE.test(l));
}

/**
 * Start of the appendix: the last EVI1 line, or else a run of evidence lines
 * that ends the text. -1 if there is none.
 */
function findAppendixStart(lines: string[]): number {
  // Scan from the end so answer text that merely mentions "EVI1" is ignored.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (START_LINE.test(lines[i]) && opensAppendix(lines, i)) return i;
  }
  let i = lines.length - 1;
  while (i >= 0 && (isBlank(lines[i]) || END_LINE.test(lines[i]) || FENCE_LINE.test(lines[i]))) i--;
  const last = i;
  while (i >= 0 && EVIDENCE_PREFIX.test(lines[i])) i--;
  return i < last ? i + 1 : -1;
}

function locateAppendix(lines: string[]): AppendixLocation | null {
  const start = findAppendixStart(lines);
  if (start < 0) return null;

  const headerRest = lines[start].replace(START_LINE, '');
  let endLine = END_LINE.test(headerRest) ? start : -1;
  for (let i = start + 1; endLine < 0 && i < lines.length; i++) {
    if (END_LINE.test(lines[i])) endLine = i;
  }
  let stop = endLine >= 0 ? endLine : start + 1;
  if (endLine < 0) {
    while (stop < lines.length && (isBlank(lines[stop]) || FENCE_LINE.test(lines[stop]) || EVIDENCE_LIKE.test(lines[stop]))) stop++;
    // Blank lines before the answer that follows belong to the answer.
    if (stop < lines.length) while (stop > start + 1 && isBlank(lines[stop - 1])) stop--;
  }
  const body = endLine === start ? [] : [headerRest, ...lines.slice(start + 1, stop)];

  // A fence the model opened around the appendix goes with it, but not one
  // that closes an earlier code block.
  let cutStart = start;
  let openedFence = /^\s*```/.test(lines[start]);
  let before = start - 1;
  while (before >= 0 && isBlank(lines[before])) before--;
  if (!openedFence && before >= 0 && FENCE_LINE.test(lines[before])) {
    const fences = lines.slice(0, before + 1).filter((l) => FENCE_LINE.test(l)).length;
    if (fences % 2 === 1) {
      cutStart = before;
      openedFence = true;
    }
  }

  let cutEnd = endLine < 0 ? stop : endLine + 1;
  if (openedFence && endLine >= 0 && !/```/.test(lines[endLine])) {
    let after = cutEnd;
    while (after < lines.length && isBlank(lines[after])) after++;
    if (after < lines.length && FENCE_LINE.test(lines[after])) cutEnd = after + 1;
  }
  return { cutStart, cutEnd, body };
}

/**
 * Parse the EVI1 appendix of a raw model answer.
 * Returns the evidence items plus warnings for malformed lines;
 * `null` when no appendix is present.
 *
 * Tolerant of common deviations: a decorated start line (`**EVI1**`,
 * `EVI1:`, `EVI1 c1|…`), a code fence around the appendix, a missing or
 * garbled `END_EVI1`, and a missing `EVI1` line when the answer ends in
 * evidence lines.
 */
export function parseEvi1Appendix(
  answer: string,
): { items: EvidenceItem[]; warnings: string[] } | null {
  const loc = locateAppendix(String(answer).split('\n'));
  if (!loc) return null;

  const items: EvidenceItem[] = [];
  const warnings: string[] = [];
  for (const raw of loc.body) {
    const line = raw.trim();
    if (!line || FENCE_LINE.test(line)) continue;
    const m = line.match(EVIDENCE_LINE);
    if (!m) {
      warnings.push(`EVI1: malformed evidence line ignored: ${truncate(line, 80)}`);
      continue;
    }
    const sourceIndex = Number.parseInt(m[2], 10);
    if (!Number.isFinite(sourceIndex) || sourceIndex < 1) {
      warnings.push(`EVI1: invalid source index in line: ${truncate(line, 80)}`);
      continue;
    }
    items.push({ claimId: m[1], sourceIndex, quote: unescapeQuote(m[3]) });
  }
  return { items, warnings };
}

function cutAppendix(lines: string[], loc: AppendixLocation): string {
  const head = lines.slice(0, loc.cutStart);
  const tail = lines.slice(loc.cutEnd);
  // An evidence-first block leaves blank lines before the answer.
  if (head.every(isBlank)) {
    head.length = 0;
    while (tail.length && isBlank(tail[0])) tail.shift();
  }
  return head.concat(tail).join('\n').trimEnd();
}

/** Remove the EVI1 appendix from a raw answer; returns the answer body. */
export function stripEvi1Appendix(answer: string): string {
  const lines = String(answer).split('\n');
  const loc = locateAppendix(lines);
  return loc ? cutAppendix(lines, loc) : answer;
}

/** Whether the last line may be the beginning of an appendix (but not a fence closing a code block). */
function isPartialStart(lines: string[]): boolean {
  const last = lines[lines.length - 1];
  if (isBlank(last) || !PARTIAL_START.test(last)) return false;
  return !/```/.test(last) || lines.filter((l) => /^\s*```/.test(l)).length % 2 === 1;
}

/**
 * The answer as a reader should see it, also while it is still streaming:
 * the appendix (complete or not) is cut, as is a last line that may be the
 * beginning of one (`E`, `EV`, `EVI`, `EVI1`, `c1|…`), and all `{cX}`
 * markers are removed, including a half-streamed `{c…` at the end.
 * `[n]` citation markers are kept.
 */
export function stripForDisplay(text: string): string {
  let lines = String(text).split('\n');
  const popBlank = () => {
    while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
  };
  popBlank();
  while (lines.length && isPartialStart(lines)) {
    lines.pop();
    popBlank();
  }
  const loc = locateAppendix(lines);
  if (loc) lines = cutAppendix(lines, loc).split('\n');
  return stripClaimMarkers(lines.join('\n').replace(PARTIAL_MARKER, '')).trimEnd();
}

/** Serialize evidence items into an EVI1 appendix block. */
export function serializeEvi1Appendix(items: EvidenceItem[]): string {
  const body = items.map(
    (it) => `${it.claimId}|${it.sourceIndex}|"${escapeQuote(it.quote)}"`,
  );
  return [EVI1_START, ...body, EVI1_END].join('\n');
}

/**
 * Extract cited claims from an answer body (appendix already stripped).
 *
 * A claim is the text segment ending at a `{cX}` marker, bounded by the start
 * of its line/block or the previous claim marker. Its cited sources are the
 * contiguous `[n]` group immediately preceding the marker, per protocol.
 */
export function extractClaims(body: string): { claims: Claim[]; warnings: string[] } {
  const claims: Claim[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const block of String(body).split('\n')) {
    if (!block.includes('{c')) continue;
    let segmentStart = 0;
    CLAIM_MARKER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLAIM_MARKER.exec(block)) !== null) {
      const id = `c${m[1]}`;
      const segment = block.slice(segmentStart, m.index);
      segmentStart = m.index + m[0].length;

      const groupMatch = segment.match(CITATION_GROUP_BEFORE_CLAIM);
      const sourceIndexes = groupMatch
        ? [...groupMatch[1].matchAll(/\[(\d+)\]/g)].map((g) => Number.parseInt(g[1], 10))
        : [];
      if (!groupMatch) {
        warnings.push(`Claim ${id}: no citation group directly before marker.`);
      }
      if (seen.has(id)) {
        warnings.push(`Claim ${id}: duplicate claim id; keeping first occurrence.`);
        continue;
      }
      seen.add(id);
      claims.push({
        id,
        text: cleanClaimText(segment),
        sourceIndexes: [...new Set(sourceIndexes)],
      });
    }
  }
  return { claims, warnings };
}

/** Strip citation `[n]` and claim `{cX}` markers, collapse whitespace. */
function cleanClaimText(segment: string): string {
  return collapseWhitespace(segment.replace(/\[\d+\]/g, '').replace(/\{c\d+\}/g, ''));
}

/** Remove all `{cX}` claim markers from a text. */
export function stripClaimMarkers(text: string): string {
  return String(text).replace(/\{c\d+\}/g, '');
}

/**
 * Parse a raw model answer end-to-end: strip the appendix, extract claims and
 * evidence, and cross-check completeness (every cited (claim, source) pair
 * should have exactly one evidence item, and vice versa).
 */
export function parseAnswer(answer: string): ParsedAnswer {
  const warnings: string[] = [];

  const appendix = parseEvi1Appendix(answer);
  const evidence = appendix?.items ?? [];
  if (appendix) warnings.push(...appendix.warnings);

  const body = stripEvi1Appendix(answer);
  const { claims, warnings: claimWarnings } = extractClaims(body);
  // A claim marker without its [n] group still names its sources in the
  // appendix; take them from there instead of losing the claim's evidence.
  const noGroup = new Set<string>();
  for (const c of claims) {
    if (c.sourceIndexes.length) continue;
    const fromAppendix = [...new Set(evidence.filter((e) => e.claimId === c.id).map((e) => e.sourceIndex))];
    if (!fromAppendix.length) continue;
    c.sourceIndexes = fromAppendix;
    noGroup.add(`Claim ${c.id}: no citation group directly before marker.`);
  }
  warnings.push(
    ...claimWarnings.map((w) =>
      noGroup.has(w) ? w.replace(/\.$/, '; sources taken from the EVI1 appendix.') : w,
    ),
  );

  const cited = new Set(
    claims.flatMap((c) => c.sourceIndexes.map((n) => `${c.id}|${n}`)),
  );
  // Several lines for one (claim, source) pair are allowed: a claim may need
  // two passages of the same source. Only repeated quotes are dropped.
  const evidenced = new Set<string>();
  const seenLines = new Set<string>();
  const dedupedEvidence: typeof evidence = [];
  for (const it of evidence) {
    const key = `${it.claimId}|${it.sourceIndex}`;
    const line = `${key}|${collapseWhitespace(it.quote)}`;
    if (seenLines.has(line)) {
      warnings.push(`EVI1: repeated quote for ${key}; keeping first occurrence.`);
      continue;
    }
    seenLines.add(line);
    dedupedEvidence.push(it);
    if (!evidenced.has(key) && !cited.has(key)) {
      warnings.push(`EVI1: evidence for ${key} has no matching citation in the answer.`);
    }
    evidenced.add(key);
  }
  for (const key of cited) {
    if (!evidenced.has(key)) {
      warnings.push(`Citation ${key} has no evidence item in the EVI1 appendix.`);
    }
  }

  return { cleanText: stripClaimMarkers(body), claims, evidence: dedupedEvidence, warnings };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
