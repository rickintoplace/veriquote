/**
 * Build the judge benchmark from ALCE's human annotations.
 *
 *   node bench/judge/prepare-alce.mjs [--out bench/judge/alce.jsonl]
 *
 * ALCE (Gao et al., EMNLP 2023, MIT licensed) had annotators rate every
 * (sentence, cited document) pair on a three-point scale:
 *
 *   2  the document fully supports all claims in the sentence
 *   1  the document partially supports the claims
 *   0  the document does not support any claim made in the sentence
 *
 * That is the same judgement VeriQuote's entailment judge makes, so the
 * annotations can be used directly -- no relabelling, and the published
 * TRUE-NLI baseline from the paper stays comparable.
 *
 * What this measures and what it does not: ALCE pairs a sentence with a whole
 * retrieved passage, not with a model-selected verbatim quote. So this scores
 * the JUDGE in isolation. The quote-matching step is covered by
 * bench/matcher, which needs no labels at all.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL =
  'https://raw.githubusercontent.com/princeton-nlp/ALCE/main/human_eval/human_eval_citations_completed.json';

const HERE = dirname(fileURLToPath(import.meta.url));
const outFlag = process.argv.indexOf('--out');
const OUT = outFlag !== -1 ? process.argv[outFlag + 1] : join(HERE, 'alce.jsonl');

/** ALCE's 0/1/2 scale, kept as the gold label. */
const GOLD = { 0: 'none', 1: 'partial', 2: 'full' };

console.error(`fetching ${SOURCE_URL} ...`);
const res = await fetch(SOURCE_URL);
if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
const raw = await res.json();

const rows = [];
for (const [dataset, runs] of Object.entries(raw)) {
  for (const [run, outputs] of Object.entries(runs)) {
    for (const [questionId, output] of Object.entries(outputs)) {
      const sentences = output.sentences ?? [];
      for (let s = 0; s < sentences.length; s++) {
        const sentence = sentences[s];
        const citations = sentence.citations ?? [];
        for (let c = 0; c < citations.length; c++) {
          const cit = citations[c];
          const score = cit.citation_precision_score;
          if (!(score in GOLD)) continue;
          if (!sentence.text?.trim() || !cit.text?.trim()) continue;
          rows.push({
            id: `${dataset}/${run}/${questionId}/s${s}/c${c}`,
            dataset,
            question: output.question ?? '',
            // The cited sentence, with its bracket markers removed: this is
            // the "claim" the judge is asked about.
            claim: sentence.text.replace(/\s*\[\d+\]/g, '').trim(),
            // ALCE cites whole passages. The judge takes a quote plus context;
            // here the passage plays both roles, which is the strictest
            // reading -- the judge gets no hint about which span matters.
            quote: cit.text.trim(),
            context: cit.text.trim(),
            sourceTitle: cit.title ?? '',
            gold: GOLD[score],
          });
        }
      }
    }
  }
}

rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

const dist = rows.reduce((acc, r) => ((acc[r.gold] = (acc[r.gold] ?? 0) + 1), acc), {});
console.error(`wrote ${rows.length} labelled pairs to ${OUT}`);
console.error(`gold distribution: ${JSON.stringify(dist)}`);
console.error(`datasets: ${[...new Set(rows.map((r) => r.dataset))].join(', ')}`);
