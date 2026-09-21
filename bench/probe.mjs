/**
 * Probe an OpenAI-compatible endpoint before spending a benchmark run on it.
 *
 *   node --env-file=.env bench/probe.mjs
 *   node --env-file=.env bench/probe.mjs --models qwen3.5-397b-a17b,glm-5.3-flash
 *
 * For each model it answers the three questions that decide whether that model
 * can appear in a benchmark at all:
 *
 *   1. Does it respond, and how fast?
 *   2. Does it honour `response_format: {type: "json_object"}`? The entailment
 *      judge depends on it; a model that ignores it can still be an answering
 *      model, but not a judge.
 *   3. Does it emit the EVI1 appendix from a minimal citation prompt? A model
 *      that fails this one-paragraph case will not manage a real answer.
 *
 * It also prints the rate-limit budget the server advertises, so the real
 * benchmark runs can be paced instead of guessed at.
 */

import { buildCitationInstructions, parseAnswer } from '../dist/index.js';
import { RateLimitedClient } from './lib/http.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const BASE_URL = arg('base-url', process.env.VERIQUOTE_BASE_URL ?? 'https://openrouter.ai/api/v1');
const apiKey = process.env.VERIQUOTE_JUDGE_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Set VERIQUOTE_JUDGE_API_KEY (e.g. in .env, then run with node --env-file=.env).');
  process.exit(1);
}

const client = new RateLimitedClient({
  baseUrl: BASE_URL,
  apiKey,
  concurrency: Number(arg('concurrency', '4')),
  timeoutMs: Number(arg('timeout-ms', '60000')),
  // Enough retries to ride out a shared endpoint's transient 500s, few enough
  // that triage stays quick. Too few and a healthy model is recorded as
  // unmeasurable; too many and one dead model stalls the whole run.
  maxRetries: Number(arg('max-retries', '3')),
  log: (m) => console.error(`  [rate] ${m}`),
});

const SOURCE = `In this randomised controlled trial of 2,300 adults aged 65 and over, daily vitamin D supplementation reduced the rate of falls by 19% over a 24-month follow-up period. No significant effect on fracture incidence was observed.`;

/** y = passed, n = failed, ? = could not be measured (endpoint error). */
const mark = (v) => (v === null ? '?' : v ? 'y' : 'n');

async function probeModel(model) {
  // `false` means the model failed the check; `null` means the check could not
  // be made (the endpoint errored). Collapsing the two would blame a model for
  // an outage.
  const out = { model, reachable: false, latencyMs: null, jsonMode: null, evi1: null, notes: [] };

  // 1. reachable + latency (the request itself, not time spent queued)
  try {
    const { body, fetchMs, attempts } = await client.postTimed('/chat/completions', {
      model,
      temperature: 0,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    });
    out.latencyMs = fetchMs;
    if (attempts > 1) out.notes.push(`${attempts} attempts`);
    // Reachable means the call succeeded. Some reasoning models return an
    // empty `content` for a trivial prompt while working perfectly on a real
    // one, so an empty reply is a note, not a failure.
    out.reachable = true;
    if (!body.choices?.[0]?.message?.content) out.notes.push('empty content on trivial prompt');
  } catch (err) {
    out.notes.push(String(err).slice(0, 120));
    return out;
  }

  // 2. JSON mode -- required to use the model as an entailment judge
  try {
    const body = await client.post('/chat/completions', {
      model,
      temperature: 0,
      // Reasoning models spend tokens on a thinking trace before any content.
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'Return JSON: {"items":[{"id":"a","class":"entailed","confidence":0.9}]}' }],
    });
    const text = body.choices?.[0]?.message?.content ?? '';
    JSON.parse(text.trim());
    out.jsonMode = true;
  } catch (err) {
    // A JSON parse failure is the model's fault; a transport error is not.
    out.jsonMode = err instanceof SyntaxError ? false : null;
    out.notes.push(`json_object: ${String(err).slice(0, 80)}`);
  }

  // 3. EVI1 compliance on a minimal case
  try {
    const body = await client.post('/chat/completions', {
      model,
      temperature: 0,
      max_tokens: 900,
      messages: [
        { role: 'system', content: `You are a research assistant. Answer only from the provided sources.\n\n${buildCitationInstructions()}` },
        { role: 'user', content: `SOURCES:\n\n[1] Vitamin D trial\n${SOURCE}\n\nQUESTION: Did vitamin D reduce falls, and did it affect fractures?` },
      ],
    });
    const answer = body.choices?.[0]?.message?.content ?? '';
    const parsed = parseAnswer(answer);
    const citedPairs = parsed.claims.flatMap((c) => c.sourceIndexes.map((n) => `${c.id}|${n}`));
    const evidenced = new Set(parsed.evidence.map((e) => `${e.claimId}|${e.sourceIndex}`));
    out.evi1 = parsed.evidence.length > 0 && citedPairs.length > 0 && citedPairs.every((p) => evidenced.has(p));
    out.claims = parsed.claims.length;
    out.evidenceLines = parsed.evidence.length;
    if (parsed.warnings.length) out.notes.push(`warnings: ${parsed.warnings.length}`);
  } catch (err) {
    out.evi1 = null; // endpoint failure, not a protocol failure
    out.notes.push(`evi1: ${String(err).slice(0, 80)}`);
  }

  return out;
}

const listed = await client.listModels().catch((err) => {
  console.error(`could not list models: ${err}`);
  return [];
});
console.error(`endpoint: ${BASE_URL}`);
console.error(`rate limit budget: ${client.describeLimits()}`);
console.error(`models listed: ${listed.length}`);

const requested = arg('models', null);
const models = requested ? requested.split(',').map((m) => m.trim()) : listed.map((m) => m.id);

/**
 * A pool over models, not over requests. Handing every model's first request
 * to the client at once makes them advance in lockstep, so nothing finishes
 * until almost everything does -- useless for watching a long run.
 */
const MODEL_PARALLELISM = Number(arg('models-in-parallel', '3'));
const queue = models.slice();
const results = [];
let finished = 0;

await Promise.all(
  Array.from({ length: Math.min(MODEL_PARALLELISM, models.length) }, async () => {
    for (;;) {
      const model = queue.shift();
      if (!model) return;
      const r = await probeModel(model).catch((err) => ({
        model, reachable: false, latencyMs: null, jsonMode: null, evi1: null,
        notes: [String(err).slice(0, 120)],
      }));
      results.push(r);
      finished++;
      console.error(
        `  [${String(finished).padStart(2)}/${models.length}] ${r.reachable ? 'ok  ' : 'FAIL'} ` +
          `${model.padEnd(30)} ${String(r.latencyMs ?? '-').padStart(6)}ms  ` +
          `json=${mark(r.jsonMode)}  evi1=${mark(r.evi1)}` +
          (r.notes.length ? `  (${r.notes.join('; ')})` : ''),
      );
    }
  }),
);
results.sort((a, b) => models.indexOf(a.model) - models.indexOf(b.model));

const tick = (b) => (b === null ? 'unmeasured' : b ? 'yes' : 'no');
console.log('');
console.log('| model | reachable | latency | json mode | EVI1 | notes |');
console.log('| --- | --- | ---: | --- | --- | --- |');
for (const r of results) {
  console.log(
    `| ${r.model} | ${tick(r.reachable)} | ${r.latencyMs ?? '-'}ms | ${tick(r.jsonMode)} | ` +
      `${tick(r.evi1)} | ${r.notes.join('; ') || '-'} |`,
  );
}
console.log('');
console.log(`judge candidates (json mode): ${results.filter((r) => r.jsonMode === true).map((r) => r.model).join(', ') || 'none'}`);
console.log(`answering candidates (EVI1):  ${results.filter((r) => r.evi1 === true).map((r) => r.model).join(', ') || 'none'}`);
const unmeasured = results.filter((r) => r.evi1 === null || r.jsonMode === null);
if (unmeasured.length) {
  console.log(`unmeasured (endpoint errors, re-run these): ${unmeasured.map((r) => r.model).join(', ')}`);
}
const outFlag = process.argv.indexOf('--json');
if (outFlag !== -1) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const out = process.argv[outFlag + 1] ?? 'bench/results/probe.json';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ generatedBy: 'bench/probe.mjs', results }, null, 2)}\n`);
  console.error(`wrote ${out}`);
}
console.error(`\nrate limit after probe: ${client.describeLimits()}  |  ${JSON.stringify(client.stats)}`);
