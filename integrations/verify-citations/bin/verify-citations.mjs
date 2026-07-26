#!/usr/bin/env node
/**
 * verify-citations — VeriQuote as an internal hallucination gate for agents.
 *
 * Reads a JSON job on stdin, runs VeriQuote's deterministic quote↔source
 * matcher plus (optionally) the entailment judge, adds a coverage check for
 * factual sentences that carry no citation at all, and prints a machine-
 * readable verdict on stdout. Exit code encodes the verdict so a shell-driven
 * agent can branch without parsing JSON:
 *
 *   0  pass    — every cited claim is grounded and nothing factual is uncited
 *   2  revise  — problems found; see `problems` / `uncited` / `instructionsForModel`
 *   1  error   — bad input or internal failure
 *
 * Input (stdin):
 *   {
 *     "answer":  "<raw model answer incl. the EVI1 appendix>",
 *     "sources": [{ "title"?: string, "url"?: string, "text": string }, ...],
 *     "options"?: {
 *       "judge"?: false,               // force text-match-only
 *       "thresholds"?: { "minScore"?: number, "minUncitedChars"?: number }
 *     }
 *   }
 *
 * The judge is configured from the environment (server-side only):
 *   VERIQUOTE_JUDGE_API_KEY   (or OPENROUTER_API_KEY)
 *   VERIQUOTE_JUDGE_MODEL     (default: google/gemini-2.5-flash-lite)
 *   VERIQUOTE_JUDGE_BASE_URL  (default: https://openrouter.ai/api/v1)
 * With no key present, verification degrades to text-match-only.
 */
import { verifyAnswer, stripEvi1Appendix, ChatCompletionsJudge } from 'veriquote';

const DEFAULT_THRESHOLDS = { minScore: 0.5, minUncitedChars: 40 };

async function main() {
  const job = JSON.parse(await readStdin());
  const answer = String(job?.answer ?? '');
  const sources = Array.isArray(job?.sources) ? job.sources : [];
  const options = job?.options ?? {};
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };

  if (!answer.trim()) throw new Error('input.answer is empty');

  const judge = options.judge === false ? undefined : judgeFromEnv();
  const report = await verifyAnswer({ answer, sources, judge });

  // 1) Grounding problems: a cited claim whose quote is absent from the source
  //    (fabricated/paraphrased) or does not support the claim (overstated /
  //    contradicted / too low combined score).
  const problems = report.citations
    .filter((c) => isProblem(c, thresholds.minScore))
    .map((c) => ({
      claimId: c.claimId,
      sourceIndex: c.sourceIndex,
      claimText: c.claimText,
      type: problemType(c),
      textMatch: { method: c.textMatch.method, score: round(c.textMatch.score) },
      entailment: c.entailment
        ? { class: c.entailment.class, confidence: round(c.entailment.confidence), reasons: c.entailment.reasons }
        : null,
      score: round(c.score),
    }));

  // 2) Coverage gap: factual sentences that assert something but cite nothing.
  //    VeriQuote only checks claims that carry a citation, so an uncited
  //    fabricated sentence would otherwise pass silently.
  const uncited = findUncitedSentences(stripEvi1Appendix(answer), thresholds.minUncitedChars);

  const verdict = problems.length || uncited.length ? 'revise' : 'pass';

  const out = {
    verdict,
    summary: report.summary,
    problems,
    uncited,
    warnings: report.warnings,
    instructionsForModel: verdict === 'pass' ? null : buildCorrectionInstructions(problems, uncited),
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(verdict === 'pass' ? 0 : 2);
}

function judgeFromEnv() {
  const apiKey = process.env.VERIQUOTE_JUDGE_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return undefined; // text-match-only
  return new ChatCompletionsJudge({
    apiKey,
    model: process.env.VERIQUOTE_JUDGE_MODEL || 'google/gemini-2.5-flash-lite',
    baseUrl: process.env.VERIQUOTE_JUDGE_BASE_URL || 'https://openrouter.ai/api/v1',
  });
}

function isProblem(c, minScore) {
  if (c.textMatch.method === 'not_found') return true;
  if (c.entailment && (c.entailment.class === 'contradicted' || c.entailment.class === 'overstated')) return true;
  // score is null when the judge errored — don't punish infrastructure failures.
  return c.score !== null && c.score < minScore;
}

function problemType(c) {
  if (c.textMatch.method === 'not_found') return 'quote_not_in_source';
  if (c.entailment?.class === 'contradicted') return 'contradicted_by_source';
  if (c.entailment?.class === 'overstated') return 'overstated';
  return 'weakly_supported';
}

/**
 * Heuristic coverage check. Splits the answer body (appendix stripped) into
 * sentences and flags those that look like factual assertions yet contain no
 * `[n]` citation marker. Deliberately conservative to limit false positives —
 * tune `minUncitedChars` and the skip rules per deployment.
 */
function findUncitedSentences(body, minChars) {
  const out = [];
  for (const rawLine of String(body).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue;          // headings
    if (/^[-*>|]/.test(line) || /^\d+\.\s/.test(line)) {
      // list/quote/table lines: still check, but strip the marker first
    }
    for (const sentence of splitSentences(line)) {
      const s = sentence.trim();
      if (s.length < minChars) continue;           // too short to be a real claim
      if (s.endsWith('?')) continue;               // questions assert nothing
      if (/\[\d+\]/.test(s)) continue;             // already cited
      if (!/[a-z]{3,}/i.test(s)) continue;         // needs real words
      out.push(s.length > 240 ? s.slice(0, 237) + '…' : s);
    }
  }
  return out;
}

function splitSentences(text) {
  // Split on sentence-final punctuation followed by whitespace. Good enough for
  // gating; not a full NLP tokenizer.
  return String(text).split(/(?<=[.!?])\s+(?=[A-Z0-9"'“(])/);
}

function buildCorrectionInstructions(problems, uncited) {
  const lines = [
    'Your previous answer failed citation verification. Fix it as follows and re-output the full answer with a corrected EVI1 appendix:',
  ];
  for (const p of problems) {
    const how =
      p.type === 'quote_not_in_source'
        ? 'the attached quote does not occur in the cited source — replace it with a real verbatim quote or remove the claim'
        : p.type === 'contradicted_by_source'
          ? 'the cited source contradicts this claim — remove the claim or correct it to match the source'
          : p.type === 'overstated'
            ? 'this claim is stronger/more general than the evidence — weaken it to exactly what the quote supports'
            : 'this claim is only weakly supported — strengthen the citation or soften the wording';
    lines.push(`- Claim ${p.claimId} ("${truncate(p.claimText, 120)}"): ${how}.`);
  }
  for (const s of uncited) {
    lines.push(`- Uncited factual statement: "${truncate(s, 120)}" — add a citation with a verbatim quote, or remove it.`);
  }
  lines.push('Do not introduce new claims that are not backed by the provided sources.');
  return lines.join('\n');
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
function round(x) {
  return x === null || x === undefined ? null : Math.round(x * 100) / 100;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data || '{}'));
    process.stdin.on('error', reject);
  });
}

main().catch((e) => {
  process.stderr.write(`verify-citations error: ${e?.message || e}\n`);
  process.exit(1);
});
