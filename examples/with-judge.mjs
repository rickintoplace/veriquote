/**
 * Full pipeline with the LLM entailment judge (server-side only):
 *   OPENROUTER_API_KEY=sk-... node examples/with-judge.mjs
 *
 * Works with any OpenAI-compatible endpoint; adjust baseUrl/model/apiKey.
 */
import { ChatCompletionsJudge, verifyAnswer } from '../dist/index.js';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Set OPENROUTER_API_KEY (or adapt this example to your provider).');
  process.exit(1);
}

const judge = new ChatCompletionsJudge({
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey,
  model: 'google/gemini-2.5-flash-lite',
  seed: 42,
});

const sources = [
  {
    title: 'Vitamin D and falls (RCT)',
    text:
      'In this randomized controlled trial of 2,000 community-dwelling older adults, ' +
      'vitamin D supplementation reduced the rate of falls by 19% compared with placebo ' +
      '(95% CI 5-31%) over 24 months. No significant effect on fracture incidence was observed.',
  },
];

// c1 is supported; c2 is deliberately overstated relative to its quote.
const answer = [
  'Vitamin D lowered fall rates by roughly one fifth.[1]{c1}',
  'Vitamin D prevents all fractures in older adults.[1]{c2}',
  '',
  'EVI1',
  'c1|1|"vitamin D supplementation reduced the rate of falls by 19% compared with placebo"',
  'c2|1|"No significant effect on fracture incidence was observed"',
  'END_EVI1',
].join('\n');

const report = await verifyAnswer({ answer, sources, judge });

for (const c of report.citations) {
  console.log(`${c.claimId}: "${c.claimText}"`);
  console.log(`  text match : ${c.textMatch.method} (${(c.textMatch.score * 100).toFixed(0)}%)`);
  console.log(
    `  entailment : ${c.entailment?.class} (${c.entailment?.confidence}) — ${c.entailment?.reasons.join('; ')}`,
  );
  console.log(`  combined   : ${c.score}`);
}
console.log('\nSummary:', report.summary);
