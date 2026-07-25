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

  const citations: CitationVerification[] = [];
  for (const item of parsed.evidence) {
    const claim = claimById.get(item.claimId);
    const source = sources[item.sourceIndex - 1];
    if (!source) {
      warnings.push(
        `EVI1: evidence ${item.claimId}|${item.sourceIndex} references a source that was not provided.`,
      );
      continue;
    }
    const textMatch: QuoteMatch = matchQuoteAgainstSource(item.quote, source, match);
    citations.push({
      claimId: item.claimId,
      sourceIndex: item.sourceIndex,
      claimText: claim?.text ?? '',
      quote: item.quote,
      textMatch,
      score: textMatch.score,
    });
  }

  if (judge) {
    const judgeable = citations.filter((c) => c.claimText && c.quote);
    const inputs: EntailmentInput[] = judgeable.map((c) => ({
      id: `${c.claimId}|${c.sourceIndex}`,
      claim: c.claimText,
      quote: c.quote,
      context: contextWindow(
        sources[c.sourceIndex - 1],
        c.textMatch,
        contextWindowChars,
      ),
    }));
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
