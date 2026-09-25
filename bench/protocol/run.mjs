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
 *
 * After a change to the parser or matcher, score the stored answers again
 * without a single API call (reads protocol-answers.jsonl next to the file):
 *
 *   npm run build && node bench/protocol/run.mjs \
 *     --rescore bench/results/protocol.json --json bench/results/protocol.json
 *
 * --prompt evidence-first puts the EVI1 block before the answer. --judge-model
 * adds strict/lenient support: every citation goes through the entailment
 * judge, so compliance is not the only thing measured. Verdicts are cached in
 * <json>-judge-cache.jsonl, so a rescore pays only for citations it has not
 * seen before. --judge-decisions judges with a decision model such as
 * typesafe/jev-1.13 through OpenRouter's decisions endpoint instead.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCitationInstructions,
  ChatCompletionsJudge,
  matchQuoteAgainstSource,
  parseAnswer,
  parseEvi1Appendix,
  verifyAnswer,
} from '../../dist/index.js';
import { loadCorpus } from '../lib/corpus.mjs';
import { DecisionsJudge } from '../lib/decisions-judge.mjs';
import { RateLimitedClient } from '../lib/http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

// --rescore: the run to score again; its settings replace the flags below.
const RESCORE = arg('rescore', null);
const previous = RESCORE ? JSON.parse(readFileSync(RESCORE, 'utf8')) : null;

const MODEL_ARG = arg('models', process.env.VERIQUOTE_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean);
// On a rescore, --models narrows the stored run (e.g. to judge only some models).
const MODELS = previous
  ? previous.models.filter((m) => !MODEL_ARG.length || MODEL_ARG.includes(m))
  : MODEL_ARG;
const BASE_URL = arg('base-url', process.env.VERIQUOTE_BASE_URL ?? 'https://openrouter.ai/api/v1');
const REPEATS = previous?.repeats ?? Number(arg('repeats', '1'));
const SOURCE_CHARS = previous?.sourceChars ?? Number(arg('source-chars', '4000'));
const CONCURRENCY = previous?.concurrency ?? Number(arg('concurrency', '3'));
const TIMEOUT_MS = Number(arg('timeout-ms', '300000'));

const WAIT = process.argv.includes('--wait');
const PROMPTS = ['end', 'evidence-first'];
const PROMPT = previous ? (previous.prompt ?? 'end (before 2026-09-25)') : arg('prompt', 'end');
if (!previous && !PROMPTS.includes(PROMPT)) {
  console.error(`--prompt must be one of: ${PROMPTS.join(', ')}`);
  process.exit(1);
}
const JUDGE_MODEL = arg('judge-model', null);
const JUDGE_THINKING = process.argv.includes('--judge-thinking');
const JUDGE_DECISIONS = process.argv.includes('--judge-decisions');

const apiKey = process.env.VERIQUOTE_JUDGE_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!apiKey && (!previous || JUDGE_MODEL)) {
  console.error('Set VERIQUOTE_JUDGE_API_KEY (e.g. in .env, then run with node --env-file=.env).');
  process.exit(1);
}
if (!MODELS.length) {
  console.error('Pass --models a,b,c (or set VERIQUOTE_MODELS).');
  process.exit(1);
}

// A rescore needs the client only for the judge.
const client = previous && (!JUDGE_MODEL || JUDGE_DECISIONS) ? null : new RateLimitedClient({
  baseUrl: BASE_URL,
  apiKey,
  concurrency: CONCURRENCY,
  timeoutMs: TIMEOUT_MS,
  log: (m) => process.stderr.write(`\n  [rate] ${m}\n`),
});

const corpus = loadCorpus();
if (previous) {
  const pinned = (c) => c.map((d) => `${d.title}@${d.revid}`).join(', ');
  if (pinned(previous.corpus) !== pinned(corpus)) {
    console.error(`--rescore: the corpus changed since that run\n  was: ${pinned(previous.corpus)}\n  now: ${pinned(corpus)}`);
    process.exit(1);
  }
}
const byTitle = new Map(corpus.map((d) => [d.title, d]));
const tasks = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const instructions = buildCitationInstructions({ evidenceFirst: PROMPT === 'evidence-first' });
const instructionsSha256 = previous ? previous.instructionsSha256 : createHash('sha256').update(instructions).digest('hex');

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

/**
 * Entailment judge with a verdict cache on disk: the same (claim, quote,
 * context) under the same judge settings is never paid for twice.
 */
function cachedJudge(inner, cachePath, settings) {
  const cache = new Map();
  if (existsSync(cachePath)) {
    for (const line of readFileSync(cachePath, 'utf8').split('\n').filter(Boolean)) {
      const { key, result } = JSON.parse(line);
      cache.set(key, result);
    }
  }
  const keyOf = (it) => createHash('sha256').update(JSON.stringify([settings, it.claim, it.quote, it.context])).digest('hex');
  const stats = { cached: 0, judged: 0 };
  return {
    stats,
    async judge(items, opts) {
      const keys = items.map(keyOf);
      const missing = items.filter((_, i) => !cache.has(keys[i]));
      stats.cached += items.length - missing.length;
      if (missing.length) {
        const results = await inner.judge(missing, opts);
        missing.forEach((it, i) => {
          const result = results[i];
          stats.judged++;
          // Errors are not cached: the next run should try them again.
          if (!result || result.class === 'error') return;
          cache.set(keyOf(it), result);
          appendFileSync(cachePath, `${JSON.stringify({ key: keyOf(it), result })}\n`);
        });
        const fresh = new Map(missing.map((it, i) => [it, results[i]]));
        return items.map((it, i) => cache.get(keys[i]) ?? fresh.get(it) ?? { class: 'error', confidence: null, reasons: ['missing_item'] });
      }
      return keys.map((k) => cache.get(k));
    },
  };
}

const judgeCachePath = JUDGE_MODEL
  ? (arg('json', null) ?? RESCORE ?? join(HERE, '..', 'results', 'protocol.json')).replace(/\.json$/, '-judge-cache.jsonl')
  : null;
const judge = JUDGE_MODEL && JUDGE_DECISIONS
  ? cachedJudge(new DecisionsJudge({ apiKey, model: JUDGE_MODEL }), judgeCachePath, { model: JUDGE_MODEL, kind: 'decisions' })
  : JUDGE_MODEL
  ? cachedJudge(
      new ChatCompletionsJudge({
        apiKey,
        model: JUDGE_MODEL,
        baseUrl: BASE_URL,
        extraBody: JUDGE_THINKING ? undefined : { chat_template_kwargs: { enable_thinking: false } },
        // Judge requests share the key's budget with the answers, so they go
        // through the same paced client (which also does the retrying).
        fetch: async (_url, init) =>
          new Response(JSON.stringify(await client.post('/chat/completions', JSON.parse(init.body))), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        maxRetries: 0,
        timeoutMs: TIMEOUT_MS,
      }),
      judgeCachePath,
      { model: JUDGE_MODEL, thinking: JUDGE_THINKING },
    )
  : null;

/** Mechanical verdict for one answer, plus the judge's when one is set. No labels involved. */
async function assess(answer, task) {
  const parsed = parseAnswer(answer);
  const citedPairs = parsed.claims.flatMap((c) => c.sourceIndexes.map((n) => `${c.id}|${n}`));
  const evidencedPairs = new Set(parsed.evidence.map((e) => `${e.claimId}|${e.sourceIndex}`));

  const covered = citedPairs.filter((p) => evidencedPairs.has(p)).length;
  const hasAppendix = parseEvi1Appendix(answer) !== null && parsed.evidence.length > 0;

  // Of the quotes the model did supply, how many are actually in the source?
  // Elided quotes (every fragment literal, "…" in between) are counted apart.
  let verbatim = 0;
  let elided = 0;
  for (const ev of parsed.evidence) {
    const doc = byTitle.get(task.sources[ev.sourceIndex - 1]);
    if (!doc) continue;
    const m = matchQuoteAgainstSource(ev.quote, doc);
    if (m.method === 'exact' || m.method === 'normalized') verbatim++;
    else if (m.method === 'elided') elided++;
  }

  // Support per citation: strict = the quote covers every detail of the claim.
  let support = null;
  if (judge && parsed.evidence.length) {
    const sources = task.sources.map((title) => byTitle.get(title));
    const report = await verifyAnswer({ answer, sources, judge });
    const classes = report.citations.map((c) => c.entailment?.class ?? 'error');
    support = {
      judged: classes.filter((c) => c !== 'error').length,
      entailed: classes.filter((c) => c === 'entailed').length,
      partial: classes.filter((c) => c === 'partially_entailed').length,
      errors: classes.filter((c) => c === 'error').length,
    };
  }

  return {
    taskId: task.id,
    unanswerable: Boolean(task.note),
    claims: parsed.claims.length,
    quoteChars: parsed.evidence.length ? mean(parsed.evidence.map((e) => e.quote.length)) : null,
    support,
    citedPairs: citedPairs.length,
    evidenceLines: parsed.evidence.length,
    hasAppendix,
    // The headline: did every citation the model made come with a quote?
    complete: citedPairs.length > 0 && covered === citedPairs.length,
    coverage: citedPairs.length ? covered / citedPairs.length : null,
    verbatimRate: parsed.evidence.length ? verbatim / parsed.evidence.length : null,
    elidedRate: parsed.evidence.length ? elided / parsed.evidence.length : null,
    warnings: parsed.warnings,
  };
}

// --------------------------------------------------------------------- run

// Refuse to start a run that cannot fit in what is left of the quota, rather
// than spending an hour of it and failing halfway.
const plannedRequests = previous?.plannedRequests ?? MODELS.length * REPEATS * tasks.length;
if (client) {
  try {
    await client.readBudget({ model: previous ? JUDGE_MODEL : MODELS[0] });
    if (!previous) client.assertBudget(plannedRequests, { wait: WAIT });
    console.error(`budget: ${client.describeLimits()}` + (previous ? '' : `  |  this run needs ${plannedRequests} requests plus the judge`));
  } catch (err) {
    console.error(String(err));
    if (String(err).includes('run needs')) process.exit(1);
  }
}

const jsonFlag = process.argv.indexOf('--json');
const jsonOut = jsonFlag === -1 ? null : (process.argv[jsonFlag + 1] ?? join(HERE, '..', 'results', 'protocol.json'));
// Raw answers, one JSON line per request, written as they arrive so a crashed
// run keeps what it already paid for. Every number is computed from these.
// A rescore reads the stored answers and must never truncate them.
const answersOut = jsonOut && !previous ? jsonOut.replace(/\.json$/, '-answers.jsonl') : null;
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
        rescored: previous ? true : undefined,
        prompt: PROMPT,
        instructionsSha256,
        judge: JUDGE_MODEL
          ? { model: JUDGE_MODEL, kind: JUDGE_DECISIONS ? 'decisions' : 'chat', thinking: JUDGE_DECISIONS ? null : JUDGE_THINKING }
          : undefined,
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

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const runs = [];
if (previous) {
  // Same runs, same failures, same finish reasons; only the scoring is redone.
  const stored = readFileSync(RESCORE.replace(/\.json$/, '-answers.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const key = (r) => `${r.model}|${r.repeat}|${r.taskId}`;
  const answers = new Map(stored.map((a) => [key(a), a.answer]));
  for (const old of previous.runs.filter((r) => MODELS.includes(r.model))) {
    if (old.failed) {
      runs.push(old);
      continue;
    }
    const answer = answers.get(key(old));
    if (answer === undefined) throw new Error(`--rescore: no stored answer for ${key(old)}`);
    runs.push({ ...old, ...(await assess(answer, tasks.find((t) => t.id === old.taskId))) });
  }
}
for (const model of previous ? [] : MODELS) {
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
          model, repeat: r, ...(await assess(answer, task)), failed: false,
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
if (client) console.error(`rate limit budget left: ${client.describeLimits()}  |  ${JSON.stringify(client.stats)}`);
if (judge) console.error(`judge: ${judge.stats.judged} citations judged, ${judge.stats.cached} from ${judgeCachePath}`);

// ----------------------------------------------------------------- measure


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
      elidedRate: mean(answerable.map((r) => r.elidedRate).filter((x) => x != null)),
      warningFreeRate: mean(answerable.map((r) => (r.warnings.length === 0 ? 1 : 0))),
      // On a question the sources cannot answer, declining while quoting related
      // context is fine; a citation without a real quote behind it is not.
      badCitationsOnUnanswerable: mean(unanswerable.map((r) =>
        (r.citedPairs > 0 && (!r.complete || (r.verbatimRate ?? 1) < 1) ? 1 : 0))),
      cutOffRate: mean(mine.map((r) => (r.finishReason === 'length' ? 1 : 0))),
      claimsPerAnswer: mean(answerable.map((r) => r.claims)),
      meanQuoteChars: mean(answerable.map((r) => r.quoteChars).filter((x) => x != null)),
      // Pooled over citations, as the judge rates each (claim, source) pair.
      ...(judge ? supportRates(answerable) : {}),
    };
  });
}

function supportRates(answers) {
  const s = answers.map((r) => r.support).filter(Boolean);
  const judged = sum(s.map((x) => x.judged));
  return {
    judgedCitations: judged,
    judgeErrors: sum(s.map((x) => x.errors)),
    strictSupport: judged ? sum(s.map((x) => x.entailed)) / judged : null,
    lenientSupport: judged ? sum(s.map((x) => x.entailed + x.partial)) / judged : null,
  };
}

const rows = summarise();

const md = [];
md.push(`Tasks: ${tasks.length} (${tasks.filter((t) => t.note).length} deliberately unanswerable) x ${REPEATS} repeat(s)`);
md.push(`Sources: ${corpus.length} pinned Wikipedia documents, first ${SOURCE_CHARS} chars each`);
md.push('');
md.push(`Prompt: ${PROMPT}${judge ? `  |  judge: ${JUDGE_MODEL}${JUDGE_THINKING ? ' (thinking)' : ''}` : ''}`);
md.push('');
const judgeCols = judge ? ' strict support | lenient support |' : '';
md.push(`| model | n | api fails | cut off | appendix | complete | coverage | verbatim | elided | warning-free | bad cites, unanswerable | claims/answer | quote chars |${judgeCols}`);
md.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |${judge ? ' ---: | ---: |' : ''}`);
const num = (x) => (x == null ? 'n/a' : x.toFixed(1));
for (const r of rows) {
  md.push(
    `| ${r.model} | ${r.n} | ${r.apiFailures} | ${pct(r.cutOffRate)} | ${pct(r.appendixRate)} | ${pct(r.completeRate)} | ` +
      `${pct(r.meanCoverage)} | ${pct(r.verbatimRate)} | ${pct(r.elidedRate)} | ${pct(r.warningFreeRate)} | ` +
      `${pct(r.badCitationsOnUnanswerable)} | ${num(r.claimsPerAnswer)} | ${r.meanQuoteChars == null ? 'n/a' : Math.round(r.meanQuoteChars)} |` +
      (judge ? ` ${pct(r.strictSupport)} | ${pct(r.lenientSupport)} |` : ''),
  );
}
md.push('');
md.push('api fails = requests the endpoint never answered; a property of the endpoint, not the model');
md.push('cut off = the provider stopped the answer at its token limit (finish_reason "length")');
md.push('appendix = emitted a parseable EVI1 block at all');
md.push('complete = every (claim, source) pair it cited also has an evidence line');
md.push('coverage = share of cited pairs that carry a quote, averaged over tasks');
md.push('verbatim = share of supplied quotes that are literally present in the source');
md.push('elided = share of supplied quotes whose fragments are literally present, in order, with "…" between them');
md.push('bad cites, unanswerable = share of unanswerable tasks with a citation that has no real quote behind it');
md.push('claims/answer, quote chars = cited sentences per answer and mean quote length, to see a prompt that makes answers say less');
if (judge) {
  md.push('strict support = share of judged citations rated entailed (the quotes cover every detail of the claim)');
  md.push('lenient support = entailed or partially entailed');
}

console.log(md.join('\n'));

flush(false);
if (jsonOut) console.error(`\nwrote ${jsonOut}`);
