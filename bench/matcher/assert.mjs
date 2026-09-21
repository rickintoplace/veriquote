/**
 * Turn the matcher benchmark into a regression gate.
 *
 *   node bench/matcher/run.mjs --json /tmp/matcher.json
 *   node bench/matcher/assert.mjs /tmp/matcher.json
 *
 * Only the two guarantees the matcher actually makes are asserted. The
 * `manipulated` family is deliberately not checked: the matcher is blind there
 * by design, and a test that pinned those numbers would break every time the
 * scoring was legitimately improved.
 */

import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'bench/results/matcher.json';
const r = JSON.parse(readFileSync(path, 'utf8'));

const family = (name, realism) =>
  r.families.find((f) => f.family === name && f.realism === realism);

const faithful = family('faithful', 'natural');
const absent = family('absent', 'natural');
const failures = [];

if (!faithful || !absent) {
  failures.push('result file is missing the natural faithful/absent families');
} else {
  if (faithful.acceptedRate < 1) {
    failures.push(
      `faithful quotes must never be rejected, but ${((1 - faithful.acceptedRate) * 100).toFixed(1)}% ` +
        `of ${faithful.n} were (a false accusation against an honest answer)`,
    );
  }
  if (absent.acceptedRate > 0) {
    failures.push(
      `absent quotes must never be accepted, but ${(absent.acceptedRate * 100).toFixed(1)}% ` +
        `of ${absent.n} were (a missed fabrication)`,
    );
  }
  if (r.separation.gap <= 0) {
    failures.push(
      `faithful and absent score distributions overlap: lowest faithful ${r.separation.lowestFaithfulScore}, ` +
        `highest absent ${r.separation.highestAbsentScore}`,
    );
  }
  if (r.threshold <= r.separation.highestAbsentScore || r.threshold > r.separation.lowestFaithfulScore) {
    failures.push(
      `default threshold ${r.threshold} is outside the separating gap ` +
        `(${r.separation.highestAbsentScore}, ${r.separation.lowestFaithfulScore}]`,
    );
  }
}

if (failures.length) {
  console.error(`matcher benchmark regression in ${path}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `matcher ok: ${r.itemCount} items, faithful 100% accepted, absent 0% accepted, ` +
    `separating gap ${r.separation.highestAbsentScore}..${r.separation.lowestFaithfulScore} ` +
    `(threshold ${r.threshold})`,
);
