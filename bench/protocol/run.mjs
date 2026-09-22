/**
 * Protocol compliance benchmark: which answering models actually emit the EVI1
 * evidence appendix when you put `buildCitationInstructions()` in their system
 * prompt -- and does what they emit survive parsing?
 *
 *   node --env-file=.env bench/protocol/run.mjs \
 *     --models qwen3.5-397b-a17b,glm-5.3-flash,deepseek-v4-flash-0731 \
 *     --json bench/results/protocol.json
 *
 * This is the number that decides whether VeriQuote is usable with a given
 * model at all. A model that prints [n] markers but skips the appendix looks
 * perfectly well-cited to a reader while carrying no verifiable evidence --
 * the exact failure the protocol exists to make visible.
 *
 * Needs an API key. No labelling: compliance is decided mechanically by
 * `parseAnswer()`, and quote accuracy by the deterministic matcher.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCitationInstructions, matchQuoteAgainstSource, parseAnswer } from '../../dist/index.js';
import { loadCorpus } from '../lib/corpus.mjs';
import { RateLimitedClient } from '../lib/http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const MODELS = arg('models', process.env.VERIQUOTE_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean);
const BASE_URL = arg('base-url', process.env.VERIQUOTE_BASE_URL ?? 'https://openrouter.ai/api/v1');
const REPEATS = Number(arg('repeats', '1'));
const SOURCE_CHARS = Number(arg('source-chars', '4000'));
const CONCURRENCY = Number(arg('concurrency', '3'));
const TIMEOUT_MS = Number(arg('timeout-ms', '300000'));

const WAIT = process.argv.includes('--wait');

const apiKey = process.env.VERIQUOTE_JUDGE_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Set VERIQUOTE_JUDGE_API_KEY (e.g. in .env, then run with node --env-file=.env).');
  process.exit(1);
}
if (!MODELS.length) {
  console.error('Pass --models a,b,c (or set VERIQUOTE_MODELS).');
  process.exit(1);
}

const client = new RateLimitedClient({
  baseUrl: BASE_URL,
  apiKey,
  concurrency: CONCURRENCY,
  timeoutMs: TIMEOUT_MS,
  log: (m) => process.stderr.write(`\n  [rate] ${m}\n`),
});

const corpus = loadCorpus();
const byTitle = new Map(corpus.map((d) => [d.title, d]));
const tasks = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const instructions = buildCitationInstructions();

/** Numbered source blocks, exactly as the instruction block tells the model to expect them. */
function renderSources(task) {
  return task.sources
    .map((title, i) => {
      const doc = byTitle.get(title);
      if (!doc) throw new Error(`task ${task.id} references unknown source: ${title}`);
      return `[${i + 1}] ${doc.title}\n${doc.text.slice(0, SOURCE_CHARS)}`;
    })
    .join('\n\n');
}

async function complete(model, task) {
  const body = await client.post('/chat/completions', {
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `You are a research assistant. Answer only from the provided sources.\n\n${instructions}`,
      },
      { role: 'user', content: `SOURCES:\n\n${renderSources(task)}\n\nQUESTION: ${task.question}` },
    ],
  });
  const choice = body.choices?.[0] ?? {};
  const message = choice.message ?? {};
  return {
    answer: message.content ?? '',
    // `length` means the provider cut the answer off, which silently removes
    // the appendix at the end; it must not be mistaken for non-compliance.
    finishReason: choice.finish_reason ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
    reasoningChars: (message.reasoning_content ?? message.reasoning ?? '').length,
  };
}

/** Mechanical verdict for one answer. No labels involved. */
function assess(answer, task) {
  const parsed = parseAnswer(answer);
  const citedPairs = parsed.claims.flatMap((c) => c.sourceIndexes.map((n) => `${c.id}|${n}`));
  const evidencedPairs = new Set(parsed.evidence.map((e) => `${e.claimId}|${e.sourceIndex}`));

  const covered = citedPairs.filter((p) => evidencedPairs.has(p)).length;
  const hasAppendix = /^\s*EVI1\s*$/m.test(answer) && parsed.evidence.length > 0;

  // Of the quotes the model did supply, how many are actually in the source?
  let verbatim = 0;
  for (const ev of parsed.evidence) {
    const doc = byTitle.get(task.sources[ev.sourceIndex - 1]);
    if (!doc) continue;
    const m = matchQuoteAgainstSource(ev.quote, doc);
    if (m.method === 'exact' || m.method === 'normalized') verbatim++;
  }

  return {
    taskId: task.id,
    unanswerable: Boolean(task.note),
    claims: parsed.claims.length,
    citedPairs: citedPairs.length,
    evidenceLines: parsed.evidence.length,
    hasAppendix,
    // The headline: did every citation the model made come with a quote?
    complete: citedPairs.length > 0 && covered === citedPairs.length,
    coverage: citedPairs.length ? covered / citedPairs.length : null,
    verbatimRate: parsed.evidence.length ? verbatim / parsed.evidence.length : null,
    warnings: parsed.warnings,
  };
}

// --------------------------------------------------------------------- run

// Refuse to start a run that cannot fit in what is left of the quota, rather
// than spending an hour of it and failing halfway.
const plannedRequests = MODELS.length * REPEATS * tasks.length;
try {
  await client.readBudget({ model: MODELS[0] });
  client.assertBudget(plannedRequests, { wait: WAIT });
  console.error(`budget: ${client.describeLimits()}  |  this run needs ${plannedRequests} requests`);
} catch (err) {
  console.error(String(err));
  if (String(err).includes('run needs')) process.exit(1);
}

const jsonFlag = process.argv.indexOf('--json');
const jsonOut = jsonFlag === -1 ? null : (process.argv[jsonFlag + 1] ?? join(HERE, '..', 'results', 'protocol.json'));
// Raw answers, one JSON line per request, written as they arrive so a crashed
// run keeps what it already paid for. Every number is computed from these.
const answersOut = jsonOut ? jsonOut.replace(/\.json$/, '-answers.jsonl') : null;
if (answersOut) writeFileSync(answersOut, '');

/**
 * Flush after every model. A run against a shared, rate-limited endpoint can
 * stall for a long time or be interrupted; losing four completed models
 * because the fifth never started would be its own kind of waste.
 */
function flush(partial) {
  if (!jsonOut) return;
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(
    jsonOut,
    `${JSON.stringify(
      {
        generatedBy: 'bench/protocol/run.mjs',
        models: MODELS,
        modelsCompleted: [...new Set(runs.map((r) => r.model))],
        partial,
        concurrency: CONCURRENCY,
        repeats: REPEATS,
        sourceChars: SOURCE_CHARS,
        plannedRequests,
        corpus: corpus.map((c) => ({ title: c.title, revid: c.revid })),
        summary: partial ? undefined : summarise(),
        runs,
      },
      null,
      2,
    )}\n`,
  );
}

const runs = [];
for (const model of MODELS) {
  const jobs = [];
  for (let r = 0; r < REPEATS; r++) for (const task of tasks) jobs.push({ r, task });
  let done = 0;
  // RateLimitedClient caps real concurrency; this just keeps its queue fed.
  const settled = await Promise.all(
    jobs.map(async ({ r, task }) => {
      try {
        const { answer, finishReason, completionTokens, reasoningChars } = await complete(model, task);
        if (answersOut) {
          appendFileSync(answersOut, `${JSON.stringify({ model, repeat: r, taskId: task.id, finishReason, answer })}\n`);
        }
        return {
          model, repeat: r, ...assess(answer, task), failed: false,
          answerChars: answer.length, finishReason, completionTokens, reasoningChars,
        };
      } catch (err) {
        return { model, repeat: r, taskId: task.id, failed: true, error: String(err).slice(0, 200) };
      } finally {
        done++;
        process.stderr.write(`\r  ${model}: ${done}/${jobs.length}            `);
      }
    }),
  );
  runs.push(...settled);
  process.stderr.write(`\r  ${model}: done (${settled.filter((x) => x.failed).length} failures)        \n`);
  flush(true);
}
console.error(`rate limit budget left: ${client.describeLimits()}  |  ${JSON.stringify(client.stats)}`);

// ----------------------------------------------------------------- measure

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function summarise() {
  return MODELS.filter((m) => runs.some((r) => r.model === m)).map((model) => {
    const mine = runs.filter((r) => r.model === model && !r.failed);
    const answerable = mine.filter((r) => !r.unanswerable);
    const unanswerable = mine.filter((r) => r.unanswerable);
    return {
      model,
      n: mine.length,
      apiFailures: runs.filter((r) => r.model === model && r.failed).length,
      appendixRate: mean(answerable.map((r) => (r.hasAppendix ? 1 : 0))),
      completeRate: mean(answerable.map((r) => (r.complete ? 1 : 0))),
      meanCoverage: mean(answerable.map((r) => r.coverage).filter((x) => x !== null)),
      verbatimRate: mean(answerable.map((r) => r.verbatimRate).filter((x) => x !== null)),
      warningFreeRate: mean(answerable.map((r) => (r.warnings.length === 0 ? 1 : 0))),
      // On a question the sources cannot answer, declining while quoting related
      // context is fine; a citation without a real quote behind it is not.
      badCitationsOnUnanswerable: mean(unanswerable.map((r) =>
        (r.citedPairs > 0 && (!r.complete || (r.verbatimRate ?? 1) < 1) ? 1 : 0))),
      cutOffRate: mean(mine.map((r) => (r.finishReason === 'length' ? 1 : 0))),
    };
  });
}

const rows = summarise();

const md = [];
md.push(`Tasks: ${tasks.length} (${tasks.filter((t) => t.note).length} deliberately unanswerable) x ${REPEATS} repeat(s)`);
md.push(`Sources: ${corpus.length} pinned Wikipedia documents, first ${SOURCE_CHARS} chars each`);
md.push('');
md.push('| model | n | api fails | cut off | appendix | complete | coverage | verbatim | warning-free | bad cites, unanswerable |');
md.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of rows) {
  md.push(
    `| ${r.model} | ${r.n} | ${r.apiFailures} | ${pct(r.cutOffRate)} | ${pct(r.appendixRate)} | ${pct(r.completeRate)} | ` +
      `${pct(r.meanCoverage)} | ${pct(r.verbatimRate)} | ${pct(r.warningFreeRate)} | ` +
      `${pct(r.badCitationsOnUnanswerable)} |`,
  );
}
md.push('');
md.push('api fails = requests the endpoint never answered; a property of the endpoint, not the model');
md.push('cut off = the provider stopped the answer at its token limit (finish_reason "length")');
md.push('appendix = emitted a parseable EVI1 block at all');
md.push('complete = every (claim, source) pair it cited also has an evidence line');
md.push('coverage = share of cited pairs that carry a quote, averaged over tasks');
md.push('verbatim = share of supplied quotes that are literally present in the source');
md.push('bad cites, unanswerable = share of unanswerable tasks with a citation that has no real quote behind it');

console.log(md.join('\n'));

flush(false);
if (jsonOut) console.error(`\nwrote ${jsonOut}`);
