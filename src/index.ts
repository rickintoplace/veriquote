/**
 * VeriQuote — deterministic + semantic verification of quote-grounded
 * LLM citations (EVI1 protocol).
 *
 * Pipeline:
 *   1. Prompt the answering model with `buildCitationInstructions()`.
 *   2. Parse its raw output with `parseAnswer()` (or let `verifyAnswer` do it).
 *   3. `verifyAnswer()` fuzzy-matches every quote against its source and
 *      optionally runs an `EntailmentJudge` for semantic support.
 *   4. Render the `VerificationReport` to give users transparent insight into
 *      which claims are verbatim-backed, supported, overstated, or unsupported.
 */

export * from './types.js';

export {
  EVI1_START,
  EVI1_END,
  parseAnswer,
  parseEvi1Appendix,
  stripEvi1Appendix,
  serializeEvi1Appendix,
  extractClaims,
  stripClaimMarkers,
} from './protocol/evi1.js';

export { buildCitationInstructions, type CitationPromptOptions } from './protocol/prompt.js';

export {
  matchQuoteAgainstSource,
  matchQuoteAgainstText,
  trigramCounts,
  diceSimilarity,
  bestFuzzyWindow,
  type MatchOptions,
} from './match/fuzzy.js';
export { normalizeForMatch, type NormalizedText } from './match/normalize.js';

export {
  ChatCompletionsJudge,
  ENTAILMENT_CLASSES,
  type ChatJudgeOptions,
} from './judge/chat-judge.js';

export { verifyAnswer, type VerifyOptions } from './report.js';
