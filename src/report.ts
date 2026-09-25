/**
 * End-to-end verification: parse an EVI1 answer, match every quote against
 * its source deterministically, optionally run the entailment judge, and
 * aggregate everything into a transparency report.
 */

import type {
  CitationVerification,
  EntailmentInput,
  EntailmentJudge,
  QuoteMatch,
  SourceDocument,
  VerificationReport,
  VerificationSummary,
} from './types.js';
import { parseAnswer } from './protocol/evi1.js';
import { matchQuoteAgainstSource, type MatchOptions } from './match/fuzzy.js';

export interface VerifyOptions {
  /** Raw model output, including the EVI1 appendix. */
  answer: string;
  /** Sources in citation order: `sources[0]` is `[1]`. */
  sources: SourceDocument[];
  /** Optional semantic judge; without it the report is text-match only. */
  judge?: EntailmentJudge;
  /** Options for the deterministic matcher. */
  match?: MatchOptions;
  /** Characters of source context around the match given to the judge. Default 420. */
  contextWindowChars?: number;
  /** Abort signal forwarded to the judge. */
  signal?: AbortSignal;
}

/** Verify one answer against its sources. */
export async function verifyAnswer(options: VerifyOptions): Promise<VerificationReport> {
  const { answer, sources, judge, match, signal } = options;
  const contextWindowChars = options.contextWindowChars ?? 420;

  const parsed = parseAnswer(answer);
  const warnings = [...parsed.warnings];
  const claimById = new Map(parsed.claims.map((c) => [c.id, c]));

  // One citation per (claim, source) pair; a pair may carry several quotes.
  const pairs = new Map<string, { claimId: string; sourceIndex: number; quotes: string[] }>();
  for (const item of parsed.evidence) {
    const key = `${item.claimId}|${item.sourceIndex}`;
    const pair = pairs.get(key) ?? { claimId: item.claimId, sourceIndex: item.sourceIndex, quotes: [] };
    pair.quotes.push(item.quote);
    pairs.set(key, pair);
  }

  const citations: CitationVerification[] = [];
  for (const [key, pair] of pairs) {
    const source = sources[pair.sourceIndex - 1];
    if (!source) {
      warnings.push(`EVI1: evidence ${key} references a source that was not provided.`);
      continue;
    }
    const parts = pair.quotes.map((quote) => ({ quote, textMatch: matchQuoteAgainstSource(quote, source, match) }));
    const textMatch = combineMatches(parts.map((p) => p.textMatch));
    for (const cue of textMatch.omittedCues ?? []) {
      warnings.push(`Citation ${key}: the ellipsis in the quote leaves out "${cue}".`);
    }
    citations.push({
      claimId: pair.claimId,
      sourceIndex: pair.sourceIndex,
      claimText: claimById.get(pair.claimId)?.text ?? '',
      quote: pair.quotes.join(' […] '),
      textMatch,
      ...(parts.length > 1 ? { parts } : {}),
      score: textMatch.score,
    });
  }

  if (judge) {
    const judgeable = citations.filter((c) => c.claimText && c.quote);
    const inputs: EntailmentInput[] = judgeable.map((c) => {
      const source = sources[c.sourceIndex - 1];
      const parts = c.parts ?? [{ quote: c.quote, textMatch: c.textMatch }];
      return {
        id: `${c.claimId}|${c.sourceIndex}`,
        claim: c.claimText,
        // An ellipsis must not hide what it left out (a "not", a qualifier):
        // the judge rates the passage as the source has it.
        quote: parts
          .map((p) => (p.textMatch.method === 'elided' ? matchedText(source, p.textMatch) ?? p.quote : p.quote))
          .join(' […] '),
        context: parts.map((p) => contextWindow(source, p.textMatch, contextWindowChars)).join(' […] '),
      };
    });
    const results = await judge.judge(inputs, { signal });
    if (results.length !== inputs.length) {
      warnings.push(
        `Judge returned ${results.length} results for ${inputs.length} items; missing items marked as errors.`,
      );
    }
    judgeable.forEach((c, i) => {
      const entailment = results[i] ?? {
        class: 'error' as const,
        confidence: null,
        reasons: ['missing_item'],
      };
      c.entailment = entailment;
      c.score =
        entailment.class === 'error' || entailment.confidence === null
          ? null
          : Math.min(c.textMatch.score, entailment.confidence);
    });
    for (const c of citations) {
      if (!c.claimText) {
        warnings.push(
          `Citation ${c.claimId}|${c.sourceIndex}: no claim text found for entailment check.`,
        );
      }
    }
  }

  return {
    cleanText: parsed.cleanText,
    claims: parsed.claims,
    citations,
    warnings,
    summary: summarize(citations, Boolean(judge)),
  };
}

/** Several quotes for one pair count as their weakest match, carrying every cue. */
function combineMatches(matches: QuoteMatch[]): QuoteMatch {
  if (matches.length === 1) return matches[0];
  const weakest = matches.reduce((a, b) => (b.score < a.score ? b : a));
  const cues = [...new Set(matches.flatMap((m) => m.omittedCues ?? []))];
  const { omittedCues: _, ...rest } = weakest;
  return cues.length ? { ...rest, omittedCues: cues } : rest;
}

/** The matched region of the source field, if its offsets are known. */
function matchedText(source: SourceDocument | undefined, m: QuoteMatch): string | undefined {
  if (!source || m.start === undefined || m.end === undefined) return undefined;
  const extra = /^extraTexts\[(\d+)\]$/.exec(m.field);
  const text = extra ? source.extraTexts?.[Number(extra[1])] : source.text;
  return text?.slice(m.start, m.end);
}

/** Source text around the matched region, for judge disambiguation. */
function contextWindow(
  source: SourceDocument | undefined,
  matchResult: QuoteMatch,
  windowChars: number,
): string {
  const text = source?.text ?? '';
  if (!text) return '';
  if (matchResult.start !== undefined && matchResult.field === 'text') {
    const start = Math.max(0, matchResult.start - windowChars);
    const end = Math.min(text.length, (matchResult.end ?? matchResult.start) + windowChars);
    return text.slice(start, end);
  }
  return text.slice(0, windowChars * 2);
}

function summarize(citations: CitationVerification[], judged: boolean): VerificationSummary {
  const n = citations.length;
  if (n === 0) {
    return {
      citationCount: 0,
      verbatimRate: null,
      entailedRate: null,
      meanScore: null,
      minScore: null,
    };
  }
  const verbatim = citations.filter(
    (c) => c.textMatch.method === 'exact' || c.textMatch.method === 'normalized',
  ).length;
  const judgedCitations = citations.filter((c) => c.entailment);
  const entailed = judgedCitations.filter((c) => c.entailment?.class === 'entailed').length;
  const scores = citations.map((c) => c.score).filter((s): s is number => s !== null);
  return {
    citationCount: n,
    verbatimRate: verbatim / n,
    entailedRate: judged && judgedCitations.length ? entailed / judgedCitations.length : null,
    meanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    minScore: scores.length ? Math.min(...scores) : null,
  };
}
