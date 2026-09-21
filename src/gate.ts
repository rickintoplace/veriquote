/**
 * Pass/revise gate on top of a `VerificationReport`: decides whether an answer
 * can be shown as-is, lists what is wrong, and writes a correction prompt the
 * answering model can act on. Also flags factual-looking sentences that carry
 * no citation at all, which `verifyAnswer` alone never sees.
 */

import type { CitationVerification, EntailmentClass, VerificationReport } from './types.js';
import { stripEvi1Appendix } from './protocol/evi1.js';

export interface GateThresholds {
  /** Combined scores below this fail. Default 0.5. */
  minScore?: number;
  /** Uncited sentences shorter than this are ignored. Default 40. */
  minUncitedChars?: number;
}

export type ProblemType =
  | 'quote_not_in_source'
  | 'contradicted_by_source'
  | 'overstated'
  | 'weakly_supported';

export interface GateProblem {
  claimId: string;
  sourceIndex: number;
  claimText: string;
  quote: string;
  type: ProblemType;
  textMatch: { method: string; score: number };
  entailment: { class: EntailmentClass | 'error'; confidence: number | null; reasons: string[] } | null;
  score: number | null;
}

export interface GateResult {
  verdict: 'pass' | 'revise';
  problems: GateProblem[];
  /** Factual-looking sentences without any `[n]` marker. Heuristic. */
  uncited: string[];
  /** Ready-to-send correction prompt; `null` on pass. */
  instructionsForModel: string | null;
}

const DEFAULTS: Required<GateThresholds> = { minScore: 0.5, minUncitedChars: 40 };

/** Apply the gate to a report produced by `verifyAnswer` for `answer`. */
export function gateReport(
  report: VerificationReport,
  answer: string,
  thresholds: GateThresholds = {},
): GateResult {
  const t = { ...DEFAULTS, ...thresholds };
  const problems = report.citations
    .filter((c) => isProblem(c, t.minScore))
    .map((c) => ({
      claimId: c.claimId,
      sourceIndex: c.sourceIndex,
      claimText: c.claimText,
      quote: c.quote,
      type: problemType(c),
      textMatch: { method: c.textMatch.method, score: round(c.textMatch.score) },
      entailment: c.entailment
        ? {
            class: c.entailment.class,
            confidence: c.entailment.confidence === null ? null : round(c.entailment.confidence),
            reasons: c.entailment.reasons,
          }
        : null,
      score: c.score === null ? null : round(c.score),
    }));
  const uncited = findUncitedSentences(stripEvi1Appendix(answer), t.minUncitedChars);
  const verdict = problems.length || uncited.length ? 'revise' : 'pass';
  return {
    verdict,
    problems,
    uncited,
    instructionsForModel: verdict === 'pass' ? null : correctionInstructions(problems, uncited),
  };
}

function isProblem(c: CitationVerification, minScore: number): boolean {
  if (c.textMatch.method === 'not_found') return true;
  const cls = c.entailment?.class;
  if (cls === 'contradicted' || cls === 'overstated') return true;
  // A null score means the judge errored; an outage is not evidence against the claim.
  return c.score !== null && c.score < minScore;
}

function problemType(c: CitationVerification): ProblemType {
  if (c.textMatch.method === 'not_found') return 'quote_not_in_source';
  if (c.entailment?.class === 'contradicted') return 'contradicted_by_source';
  if (c.entailment?.class === 'overstated') return 'overstated';
  return 'weakly_supported';
}

/**
 * Split the answer body into sentences and keep those that look like factual
 * assertions but contain no `[n]` marker. Deliberately conservative: headings,
 * questions and short fragments are skipped.
 */
function findUncitedSentences(body: string, minChars: number): string[] {
  const out: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line)) continue;
    for (const sentence of splitSentences(line)) {
      const s = sentence.trim();
      if (s.length < minChars || s.endsWith('?')) continue;
      if (/\[\d+\]/.test(s) || !/\p{L}{3,}/u.test(s)) continue;
      out.push(truncate(s, 240));
    }
  }
  return out;
}

/** Initials and common abbreviations end in a period without ending the sentence. */
const NON_TERMINAL = /(?:^|[\s(])(?:\p{Lu}|e\.g|i\.e|etc|al|approx|ca|cf|vs|Dr|Mr|Mrs|Ms|Prof|St|Fig|No|Nr|bzw|z\.\s?B|u\.\s?a|d\.\s?h)\.$/u;

function splitSentences(line: string): string[] {
  const out: string[] = [];
  for (const piece of line.split(/(?<=[.!?])\s+(?=[\p{Lu}0-9"'“(])/u)) {
    if (out.length && NON_TERMINAL.test(out[out.length - 1])) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out;
}

const FIX: Record<ProblemType, string> = {
  quote_not_in_source:
    'the attached quote does not occur in the cited source — replace it with a real verbatim quote or remove the claim',
  contradicted_by_source: 'the cited source contradicts this claim — remove the claim or correct it to match the source',
  overstated: 'this claim is stronger or more general than the evidence — weaken it to exactly what the quote supports',
  weakly_supported: 'this claim is only weakly supported — cite a better passage or soften the wording',
};

function correctionInstructions(problems: GateProblem[], uncited: string[]): string {
  const lines = [
    'Your previous answer failed citation verification. Fix it as follows and re-output the full answer with a corrected EVI1 appendix:',
  ];
  for (const p of problems) {
    lines.push(`- Claim ${p.claimId} ("${truncate(p.claimText, 120)}"): ${FIX[p.type]}.`);
  }
  for (const s of uncited) {
    lines.push(`- Uncited factual statement: "${truncate(s, 120)}" — add a citation with a verbatim quote, or remove it.`);
  }
  lines.push('Do not introduce new claims that are not backed by the provided sources.');
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
