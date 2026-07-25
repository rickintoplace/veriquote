/**
 * Text-match-only verification (no API key needed):
 *   node examples/basic.mjs
 *
 * Demonstrates the three outcomes: a verbatim quote, a paraphrased quote
 * (high fuzzy score), and a fabricated quote (not found).
 */
import { verifyAnswer } from '../dist/index.js';

const sources = [
  {
    title: 'Vitamin D and falls (RCT)',
    url: 'https://example.org/trial-a',
    text:
      'In this randomized controlled trial of 2,000 community-dwelling older adults, ' +
      'vitamin D supplementation reduced the rate of falls by 19% compared with placebo ' +
      '(95% CI 5-31%) over 24 months. No significant effect on fracture incidence was observed.',
  },
];

const answer = [
  'Vitamin D lowered fall rates by roughly one fifth.[1]{c1}',
  'It did not significantly change fracture incidence.[1]{c2}',
  'It cured osteoporosis in all participants.[1]{c3}',
  '',
  'EVI1',
  'c1|1|"vitamin D supplementation reduced the rate of falls by 19% compared with placebo"',
  'c2|1|"No significant effects on fracture incidents were seen"',
  'c3|1|"vitamin D completely cured osteoporosis in every single participant"',
  'END_EVI1',
].join('\n');

const report = await verifyAnswer({ answer, sources });

console.log('Clean text:\n' + report.cleanText + '\n');
console.log('Summary:', report.summary, '\n');
for (const c of report.citations) {
  console.log(
    `${c.claimId}|[${c.sourceIndex}]  ${c.textMatch.method.padEnd(10)} ` +
      `${(c.textMatch.score * 100).toFixed(0).padStart(3)}%  "${c.quote.slice(0, 60)}..."`,
  );
}
if (report.warnings.length) console.log('\nWarnings:', report.warnings);
