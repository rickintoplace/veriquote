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
 * Quotes are single-line, with `\n`, `\"` and `\\` escapes.
 */

import type { Claim, EvidenceItem, ParsedAnswer } from '../types.js';
import { collapseWhitespace } from '../match/normalize.js';

export const EVI1_START = 'EVI1';
export const EVI1_END = 'END_EVI1';

const EVIDENCE_LINE = /^(c\d+)\|(\d+)\|"([\s\S]*)"$/;
const CLAIM_MARKER = /\{c(\d+)\}/g;
const CITATION_GROUP_BEFORE_CLAIM = /((?:\[\d+\])+)$/;

/** Unescape an EVI1 quote payload (`\\`, `\n`, `\"`) in a single pass. */
function unescapeQuote(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
}

/** Escape a quote for serialization into an EVI1 line. */
function escapeQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

interface AppendixLocation {
  /** Index of the line containing EVI1_START. */
  startLine: number;
  /** Index of the line containing EVI1_END. */
  endLine: number;
}

function locateAppendix(lines: string[]): AppendixLocation | null {
  // Scan from the end so answer text that merely mentions "EVI1" is ignored.
  for (let end = lines.length - 1; end >= 0; end--) {
    if (lines[end].trim() !== EVI1_END) continue;
    for (let start = end - 1; start >= 0; start--) {
      if (lines[start].trim() === EVI1_START) return { startLine: start, endLine: end };
    }
    return null;
  }
  return null;
}

/**
 * Parse the EVI1 appendix of a raw model answer.
 * Returns the evidence items plus warnings for malformed lines;
 * `null` when no complete appendix is present.
 */
export function parseEvi1Appendix(
  answer: string,
): { items: EvidenceItem[]; warnings: string[] } | null {
  const lines = String(answer).split('\n');
  const loc = locateAppendix(lines);
  if (!loc) return null;

  const items: EvidenceItem[] = [];
  const warnings: string[] = [];
  for (let i = loc.startLine + 1; i < loc.endLine; i++) {
    const line = lines[i].trim();
    if (!line) continue;
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

/** Remove the EVI1 appendix from a raw answer; returns the answer body. */
export function stripEvi1Appendix(answer: string): string {
  const lines = String(answer).split('\n');
  const loc = locateAppendix(lines);
  if (!loc) return answer;
  return lines
    .slice(0, loc.startLine)
    .concat(lines.slice(loc.endLine + 1))
    .join('\n')
    .trimEnd();
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
  warnings.push(...claimWarnings);

  const cited = new Set(
    claims.flatMap((c) => c.sourceIndexes.map((n) => `${c.id}|${n}`)),
  );
  const evidenced = new Set<string>();
  const dedupedEvidence: typeof evidence = [];
  for (const it of evidence) {
    const key = `${it.claimId}|${it.sourceIndex}`;
    if (evidenced.has(key)) {
      warnings.push(`EVI1: duplicate evidence for ${key}; keeping first occurrence.`);
      continue;
    }
    evidenced.add(key);
    dedupedEvidence.push(it);
    if (!cited.has(key)) {
      warnings.push(`EVI1: evidence for ${key} has no matching citation in the answer.`);
    }
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
