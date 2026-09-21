/**
 * Matcher benchmark: how does deterministic quote matching behave on quotes
 * that are faithful-but-reformatted, near-verbatim-but-manipulated, and
 * simply absent from the source?
 *
 *   node bench/matcher/run.mjs [--json bench/results/matcher.json]
 *
 * Needs no API key and no labelled data: every item's ground truth comes from
 * the operator that produced it. Deterministic -- same output on every run.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchQuoteAgainstSource } from '../../dist/index.js';
import { loadCorpus, samplePassages } from '../lib/corpus.mjs';
import { makeRng } from '../lib/rng.mjs';
import { OPERATORS } from './mutations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = 20260921;
const PASSAGES_PER_DOC = 40;

// Raw scores, so a threshold sweep is possible; the shipped default is 0.4.
const RAW = { fuzzyThreshold: 0 };
const DEFAULT_THRESHOLD = 0.4;

// ---------------------------------------------------------------- build set

const corpus = loadCorpus();
if (corpus.length < 2) throw new Error('benchmark needs at least two corpus documents');

const rng = makeRng(SEED);
const passagesByDoc = corpus.map((doc) => samplePassages(doc.text, { max: PASSAGES_PER_DOC, rng }));

const paraphrases = JSON.parse(readFileSync(join(HERE, 'paraphrases.json'), 'utf8'));

/** @type {{op: string, family: string, realism: string, docIndex: number, quote: string}[]} */
const items = [];

for (let d = 0; d < corpus.length; d++) {
  const siblings = passagesByDoc[d];
  const otherDoc = (d + 1) % corpus.length;
  const foreignWords = [
    ...new Set(corpus[otherDoc].text.match(/\b[a-z]{5,}\b/gi)?.slice(0, 400) ?? []),
  ];

  for (let p = 0; p < siblings.length; p++) {
    const quote = siblings[p];
    const ctx = {
      siblings,
      foreignWords,
      foreignPassage: passagesByDoc[otherDoc][p % passagesByDoc[otherDoc].length],
    };
    for (const op of OPERATORS) {
      const mutated = op.fn(quote, rng, ctx);
      if (typeof mutated !== 'string' || !mutated.trim()) continue;
      items.push({ op: op.name, family: op.family, realism: op.realism, docIndex: d, quote: mutated });
    }
  }
}

// Hand-written honest paraphrases: same meaning, different words. A verbatim
// matcher must reject these -- that is the point of demanding a verbatim quote.
for (const p of paraphrases) {
  const docIndex = corpus.findIndex((d) => d.title === p.source);
  if (docIndex < 0) throw new Error(`paraphrase fixture references unknown source: ${p.source}`);
  items.push({ op: 'paraphrase', family: 'absent', realism: 'natural', docIndex, quote: p.paraphrase });
}

// ------------------------------------------------------------------ measure

for (const item of items) {
  const m = matchQuoteAgainstSource(item.quote, corpus[item.docIndex], RAW);
  item.score = m.score;
  item.method = m.method;
}

const byOp = new Map();
for (const item of items) {
  if (!byOp.has(item.op)) byOp.set(item.op, []);
  byOp.get(item.op).push(item);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const opOrder = [...OPERATORS.map((o) => o.name), 'paraphrase'];
const noteOf = Object.fromEntries(OPERATORS.map((o) => [o.name, o.note]));
noteOf.paraphrase = 'same meaning, different words (hand-written)';

const rows = opOrder
  .filter((name) => byOp.has(name))
  .map((name) => {
    const group = byOp.get(name);
    const scores = group.map((i) => i.score);
    const accepted = group.filter((i) => i.score >= DEFAULT_THRESHOLD).length;
    return {
      operator: name,
      family: group[0].family,
      n: group.length,
      medianScore: Number(median(scores).toFixed(3)),
      minScore: Number(Math.min(...scores).toFixed(3)),
      maxScore: Number(Math.max(...scores).toFixed(3)),
      acceptedRate: accepted / group.length,
      realism: group[0].realism,
      note: noteOf[name],
    };
  });

/**
 * Headline numbers cover `natural` operators only. Adversarial operators are
 * reported separately: mixing a deliberate attack into an average would either
 * flatter the matcher or slander it, depending on how many attacks you invent.
 */
const summarise = (group) => ({
  n: group.length,
  medianScore: Number(median(group.map((i) => i.score)).toFixed(3)),
  acceptedRate: group.filter((i) => i.score >= DEFAULT_THRESHOLD).length / group.length,
});

const families = ['faithful', 'manipulated', 'absent'].flatMap((family) =>
  ['natural', 'adversarial']
    .map((realism) => ({
      family,
      realism,
      group: items.filter((i) => i.family === family && i.realism === realism),
    }))
    .filter((x) => x.group.length)
    .map((x) => ({ family: x.family, realism: x.realism, ...summarise(x.group) })),
);

// Separation between the two families the matcher is actually responsible for.
const naturalFaithful = items.filter((i) => i.family === 'faithful' && i.realism === 'natural');
const naturalAbsent = items.filter((i) => i.family === 'absent' && i.realism === 'natural');
const separation = {
  lowestFaithfulScore: Number(Math.min(...naturalFaithful.map((i) => i.score)).toFixed(3)),
  highestAbsentScore: Number(Math.max(...naturalAbsent.map((i) => i.score)).toFixed(3)),
};
separation.gap = Number((separation.lowestFaithfulScore - separation.highestAbsentScore).toFixed(3));

// Threshold sweep: the trade-off the `fuzzyThreshold` default has to make.
const faithful = naturalFaithful.map((i) => i.score);
const absent = naturalAbsent.map((i) => i.score);
const sweep = [];
for (let t = 0.2; t <= 0.85001; t += 0.05) {
  const th = Number(t.toFixed(2));
  sweep.push({
    threshold: th,
    faithfulKept: faithful.filter((s) => s >= th).length / faithful.length,
    absentRejected: absent.filter((s) => s < th).length / absent.length,
  });
}

// ------------------------------------------------------------------- report

const md = [];
md.push(`Corpus: ${corpus.length} documents (${corpus.map((c) => `${c.title} rev ${c.revid}`).join(', ')})`);
md.push(`Items: ${items.length}  |  seed ${SEED}  |  threshold ${DEFAULT_THRESHOLD}`);
md.push('');
md.push('| operator | family | realism | n | median | min | max | accepted |');
md.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const r of rows) {
  md.push(
    `| ${r.operator} | ${r.family} | ${r.realism} | ${r.n} | ${r.medianScore.toFixed(3)} | ` +
      `${r.minScore.toFixed(3)} | ${r.maxScore.toFixed(3)} | ${pct(r.acceptedRate)} |`,
  );
}
md.push('');
md.push('| family | realism | n | median | accepted | reading |');
md.push('| --- | --- | ---: | ---: | ---: | --- |');
const reading = {
  faithful: 'must be accepted (a miss is a false accusation)',
  manipulated: 'matcher is blind here by design -- the judge must catch it',
  absent: 'must be rejected (an acceptance is a missed fabrication)',
};
for (const f of families) {
  md.push(
    `| ${f.family} | ${f.realism} | ${f.n} | ${f.medianScore.toFixed(3)} | ` +
      `${pct(f.acceptedRate)} | ${reading[f.family]} |`,
  );
}
md.push('');
md.push(
  `Separation (natural operators): lowest faithful score ${separation.lowestFaithfulScore.toFixed(3)}, ` +
    `highest absent score ${separation.highestAbsentScore.toFixed(3)}, gap ${separation.gap.toFixed(3)}.`,
);
md.push('');
md.push('| threshold | faithful kept | absent rejected |');
md.push('| ---: | ---: | ---: |');
for (const s of sweep) {
  md.push(`| ${s.threshold.toFixed(2)} | ${pct(s.faithfulKept)} | ${pct(s.absentRejected)} |`);
}

console.log(md.join('\n'));

const jsonFlag = process.argv.indexOf('--json');
if (jsonFlag !== -1) {
  const out = process.argv[jsonFlag + 1] ?? join(HERE, '..', 'results', 'matcher.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        generatedBy: 'bench/matcher/run.mjs',
        seed: SEED,
        threshold: DEFAULT_THRESHOLD,
        corpus: corpus.map((c) => ({ title: c.title, revid: c.revid })),
        itemCount: items.length,
        operators: rows,
        families,
        separation,
        thresholdSweep: sweep,
      },
      null,
      2,
    )}\n`,
  );
  console.error(`\nwrote ${out}`);
}
