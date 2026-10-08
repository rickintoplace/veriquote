/**
 * The decision-model judge now ships with the library (src/judge/
 * decisions-judge.ts) with the same class descriptions, instructions and
 * support values this adapter used, so the benchmarks run the code users
 * get. Kept as a re-export for the benchmark scripts. Retries are raised
 * to the four the original adapter used.
 */

import { DecisionsJudge as LibraryDecisionsJudge } from '../../dist/index.js';

export class DecisionsJudge extends LibraryDecisionsJudge {
  constructor(opts = {}) {
    super({ maxRetries: 4, ...opts });
  }
}
