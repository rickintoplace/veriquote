/**
 * Judge benchmark: how well does the entailment judge agree with human
 * annotators on whether a cited source supports a claim?
 *
 *   node bench/judge/prepare-alce.mjs
 *   node --env-file=.env bench/judge/run.mjs \
 *     --model qwen3.5-397b-a17b --limit 600 \
 *     --json bench/results/judge-qwen3.5-397b.json
 *
 * Needs an API key. The class mapping below is fixed before any model is run,
 * so it cannot be tuned after seeing the results.
 *
 * --decisions judges with a decision model (e.g. typesafe/jev-1.13) through
 * OpenRouter's decisions endpoint instead of a chat model; see
 * bench/lib/decisions-judge.mjs.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatCompletionsJudge } from '../../dist/index.js';
import { makeRng } from '../lib/rng.mjs';
import { RateLimitedClient } from '../lib/http.mjs';
import { DecisionsJudge } from '../lib/decisions-judge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const MODEL = arg('model', process.env.VERIQUOTE_JUDGE_MODEL ?? '');
const BASE_URL = arg('base-url', process.env.VERIQUOTE_BASE_URL ?? 'https://openrouter.ai/api/v1');
const DATA = arg('data', join(HERE, 'alce.jsonl'));
const LIMIT = Number(arg('limit', '600'));
const SEED = Number(arg('seed', '20260921'));
const CONCURRENCY = Number(arg('concurrency', '3'));
const BATCH_SIZE = Number(arg('batch-size', '12'));
// The judge caps its inputs. Defaults measure the shipped configuration;
// raising them measures the method without the cap. Both are legitimate, so
// the run records which was used and how many items the cap actually touched.
const CAP_QUOTE = Number(arg('cap-quote', '700'));
const CAP_CONTEXT = Number(arg('cap-context', '1200'));

const WAIT = process.argv.includes('--wait');
// Hybrid reasoning models served by vLLM honour this switch; others ignore it.
const THINKING = !process.argv.includes('--no-thinking');
const DECISIONS = process.argv.includes('--decisions');

const apiKey = process.env.VERIQUOTE_JUDGE_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Set VERIQUOTE_JUDGE_API_KEY (e.g. in .env, then run with node --env-file=.env).');
  process.exit(1);
}
if (!MODEL) {
  console.error('Pass --model <id> (or set VERIQUOTE_JUDGE_MODEL).');
  process.exit(1);
}

/**
 * Pre-registered mapping from VeriQuote's five classes onto ALCE's three
 * annotator levels. Fixed before the first run; do not tune it afterwards.
 */
const TO_GOLD = {
  entailed: 'full',
  partially_entailed: 'partial',
  overstated: 'partial',
  insufficient: 'none',
  contradicted: 'none',
};
const LEVELS = ['full', 'partial', 'none'];

// ------------------------------------------------------------------- sample

const all = readFileSync(DATA, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const rng = makeRng(SEED);
const shuffled = all.slice();
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const sample = shuffled.slice(0, Math.min(LIMIT, shuffled.length));

const truncated = sample.filter((r) => r.quote.length > CAP_QUOTE).length;

console.error(
  `model=${MODEL}  items=${sample.length}/${all.length}  seed=${SEED}  ` +
    `gold=${JSON.stringify(LEVELS.reduce((a, l) => ((a[l] = sample.filter((s) => s.gold === l).length), a), {}))}`,
);
console.error(`quote cap ${CAP_QUOTE} chars truncates ${truncated} of ${sample.length} items (${((truncated / sample.length) * 100).toFixed(1)}%)`);

// --------------------------------------------------------------------- run

const judge = DECISIONS
  ? new DecisionsJudge({ apiKey, model: MODEL, caps: { quote: CAP_QUOTE, context: CAP_CONTEXT } })
  : new ChatCompletionsJudge({
      apiKey,
      model: MODEL,
      baseUrl: BASE_URL,
      batchSize: BATCH_SIZE,
      seed: SEED,
      extraBody: THINKING ? undefined : { chat_template_kwargs: { enable_thinking: false } },
      caps: { quote: CAP_QUOTE, context: CAP_CONTEXT },
      // Shared academic endpoints throttle; let the judge's own backoff absorb it.
      maxRetries: Number(arg('max-retries', '5')),
      timeoutMs: Number(arg('timeout-ms', '120000')),
      headers: BASE_URL.includes('openrouter')
        ? { 'HTTP-Referer': 'https://github.com/rickintoplace/veriquote', 'X-Title': 'VeriQuote bench' }
        : undefined,
  });

const batches = [];
for (let i = 0; i < sample.length; i += BATCH_SIZE) batches.push(sample.slice(i, i + BATCH_SIZE));

const results = new Map();
let done = 0;
const startedAt = Date.now();

let batchFailures = 0;

async function worker(queue) {
  for (;;) {
    const batch = queue.shift();
    if (!batch) return;
    try {
      const out = await judge.judge(
        batch.map((r) => ({ id: r.id, claim: r.claim, quote: r.quote, context: r.context })),
      );
      for (let i = 0; i < batch.length; i++) results.set(batch[i].id, out[i]);
    } catch (err) {
      // A batch that fails after its retries is recorded as errors for those
      // items, not as a reason to throw away an hour of quota.
      batchFailures++;
      process.stderr.write(`\n  batch failed (${batch.length} items): ${String(err).slice(0, 120)}\n`);
    }
    done += batch.length;
    process.stderr.write(`\r  judged ${done}/${sample.length}`);
  }
}

// Refuse to start a run that cannot fit in what is left of the quota.
if (!DECISIONS) try {
  const probe = new RateLimitedClient({ baseUrl: BASE_URL, apiKey });
  await probe.readBudget({ model: MODEL });
  probe.assertBudget(batches.length, { wait: WAIT });
  console.error(`budget: ${probe.describeLimits()}  |  this run needs ${batches.length} requests`);
} catch (err) {
  console.error(String(err));
  if (String(err).includes('run needs')) process.exit(1);
}

const queue = batches.slice();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
const elapsedMs = Date.now() - startedAt;
process.stderr.write('\n');

// ----------------------------------------------------------------- measure

const confusion = Object.fromEntries(
  LEVELS.map((g) => [g, Object.fromEntries(LEVELS.map((p) => [p, 0]))]),
);
let errors = 0;
const scored = [];

for (const row of sample) {
  const r = results.get(row.id);
  if (!r || r.class === 'error' || !TO_GOLD[r.class]) {
    errors++;
    continue;
  }
  const predicted = TO_GOLD[r.class];
  confusion[row.gold][predicted]++;
  scored.push({ gold: row.gold, predicted, rawClass: r.class, confidence: r.confidence });
}

const n = scored.length;
const agree = scored.filter((s) => s.gold === s.predicted).length;
const accuracy = agree / n;

// Macro-F1 over the three levels.
const perClass = LEVELS.map((level) => {
  const tp = confusion[level][level];
  const fp = LEVELS.reduce((a, g) => a + (g === level ? 0 : confusion[g][level]), 0);
  const fn = LEVELS.reduce((a, p) => a + (p === level ? 0 : confusion[level][p]), 0);
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { level, support: tp + fn, precision, recall, f1 };
});
const macroF1 = perClass.reduce((a, c) => a + c.f1, 0) / LEVELS.length;

// Cohen's kappa -- ALCE reports human/automatic agreement this way.
const pe = LEVELS.reduce((a, l) => {
  const goldN = LEVELS.reduce((x, p) => x + confusion[l][p], 0);
  const predN = LEVELS.reduce((x, g) => x + confusion[g][l], 0);
  return a + (goldN / n) * (predN / n);
}, 0);
const kappa = (accuracy - pe) / (1 - pe);

/**
 * ALCE's own citation-precision metric is binary: does the document fully
 * support the sentence, yes or no. Reported separately so the number is
 * comparable to the paper's TRUE-NLI baseline.
 */
const binary = scored.map((s) => ({ gold: s.gold === 'full', pred: s.predicted === 'full' }));
const tp = binary.filter((b) => b.gold && b.pred).length;
const fp = binary.filter((b) => !b.gold && b.pred).length;
const fn = binary.filter((b) => b.gold && !b.pred).length;
const tn = binary.filter((b) => !b.gold && !b.pred).length;
const binaryPrecision = tp + fp ? tp / (tp + fp) : 0;
const binaryRecall = tp + fn ? tp / (tp + fn) : 0;
// ALCE reports its automatic metric as plain agreement with the annotators on
// this binary question, so this is the number that lines up with its paper.
const binaryAccuracy = (tp + tn) / n;

/**
 * The failure that matters most in deployment: the judge calls a claim fully
 * supported when annotators said the source supports nothing. A citation that
 * is wrong AND shown green is worse than one flagged for review.
 */
const falseGreen = confusion.none.full / (confusion.none.full + confusion.none.partial + confusion.none.none);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const md = [];
md.push(
  `Model: ${MODEL}  |  items scored: ${n}  |  judge errors: ${errors}` +
    `${batchFailures ? `  |  failed batches: ${batchFailures}` : ''}  |  seed: ${SEED}`,
);
md.push(`Quote cap: ${CAP_QUOTE} chars, truncating ${truncated} of ${sample.length} items (${((truncated / sample.length) * 100).toFixed(1)}%)`);
md.push(`Wall clock: ${(elapsedMs / 1000).toFixed(1)}s  (${(elapsedMs / sample.length).toFixed(0)} ms/item at concurrency ${CONCURRENCY})`);
md.push('');
md.push(`Accuracy (3-class): ${pct(accuracy)}   Macro-F1: ${macroF1.toFixed(3)}   Cohen's kappa: ${kappa.toFixed(3)}`);
md.push(
  `ALCE citation-precision (binary "fully supports"): agreement ${pct(binaryAccuracy)}, ` +
    `precision ${pct(binaryPrecision)}, recall ${pct(binaryRecall)}`,
);
md.push('  (ALCE\'s own TRUE-NLI baseline agrees with its annotators 77.6% of the time on this question)');
md.push(`False green (gold "none" judged "full"): ${pct(falseGreen)}`);
md.push('');
md.push('| gold \\ predicted | full | partial | none |');
md.push('| --- | ---: | ---: | ---: |');
for (const g of LEVELS) md.push(`| ${g} | ${confusion[g].full} | ${confusion[g].partial} | ${confusion[g].none} |`);
md.push('');
md.push('| level | support | precision | recall | F1 |');
md.push('| --- | ---: | ---: | ---: | ---: |');
for (const c of perClass) {
  md.push(`| ${c.level} | ${c.support} | ${pct(c.precision)} | ${pct(c.recall)} | ${c.f1.toFixed(3)} |`);
}

console.log(md.join('\n'));

const jsonFlag = process.argv.indexOf('--json');
if (jsonFlag !== -1) {
  const out = process.argv[jsonFlag + 1] ?? join(HERE, '..', 'results', 'judge.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        generatedBy: 'bench/judge/run.mjs',
        model: MODEL,
        kind: DECISIONS ? 'decisions' : 'chat',
        thinking: DECISIONS ? null : THINKING,
        usage: DECISIONS ? judge.usage : undefined,
        seed: SEED,
        dataset: 'ALCE human_eval citations (MIT, princeton-nlp/ALCE)',
        datasetSha256: createHash('sha256').update(readFileSync(DATA)).digest('hex').slice(0, 16),
        classMapping: TO_GOLD,
        caps: { quote: CAP_QUOTE, context: CAP_CONTEXT },
        itemsTruncatedByCap: truncated,
        itemsRequested: sample.length,
        itemsScored: n,
        judgeErrors: errors,
        failedBatches: batchFailures,
        elapsedMs,
        accuracy,
        macroF1,
        kappa,
        binary: { accuracy: binaryAccuracy, precision: binaryPrecision, recall: binaryRecall, tp, fp, fn, tn },
        falseGreen,
        confusion,
        perClass,
      },
      null,
      2,
    )}\n`,
  );
  console.error(`\nwrote ${out}`);
}
