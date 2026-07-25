/**
 * Core data model shared across the VeriQuote pipeline.
 */

/** A retrieved source document that the assistant may cite as `[n]`. */
export interface SourceDocument {
  /** Optional stable identifier (URL, DOI, internal id). Not used for matching. */
  id?: string;
  /** Human-readable title. */
  title?: string;
  /** Canonical URL of the source, if any. */
  url?: string;
  /** Main extracted text of the source. Quotes are verified against this first. */
  text: string;
  /**
   * Additional text fields to search when the quote is not found in `text`
   * (e.g. abstract, search-result snippet, title). Searched in order.
   */
  extraTexts?: string[];
}

/** One `cX|n|"QUOTE"` line from an EVI1 appendix. */
export interface EvidenceItem {
  /** Claim identifier, e.g. `"c1"`. */
  claimId: string;
  /** 1-based source index as used in `[n]` citation markers. */
  sourceIndex: number;
  /** Verbatim quote the model attributes to the source. */
  quote: string;
}

/** A cited claim extracted from the answer body via `{cX}` markers. */
export interface Claim {
  /** Claim identifier, e.g. `"c1"`. */
  id: string;
  /** Claim text with citation and claim markers removed. */
  text: string;
  /** 1-based source indexes cited directly before the claim marker. */
  sourceIndexes: number[];
}

/** Result of parsing a raw model answer that follows the EVI1 protocol. */
export interface ParsedAnswer {
  /** Answer body with the EVI1 appendix and all `{cX}` markers removed. */
  cleanText: string;
  /** Claims found in the answer body. */
  claims: Claim[];
  /** Evidence items found in the EVI1 appendix. */
  evidence: EvidenceItem[];
  /** Protocol violations detected during parsing (non-fatal). */
  warnings: string[];
}

/** How a quote was located inside a source. */
export type MatchMethod =
  /** Byte-for-byte substring of the raw source text. */
  | 'exact'
  /** Substring after Unicode/typography normalization and case folding. */
  | 'normalized'
  /** Best fuzzy window by character-trigram Dice similarity. */
  | 'fuzzy'
  /** No window reached the fuzzy score threshold. */
  | 'not_found';

/** Deterministic text-match result for one (quote, source) pair. */
export interface QuoteMatch {
  method: MatchMethod;
  /**
   * Similarity in [0, 1]. `1` only for exact/normalized hits; fuzzy scores
   * are capped at 0.99 so a perfect score always implies a literal hit.
   */
  score: number;
  /** Start offset of the matched region in the original source field, if known. */
  start?: number;
  /** End offset (exclusive) of the matched region, if known. */
  end?: number;
  /** Which source field matched: `"text"` or `"extraTexts[i]"`. */
  field: string;
}

/** Qualitative entailment classes produced by the LLM judge. */
export type EntailmentClass =
  | 'entailed'
  | 'partially_entailed'
  | 'overstated'
  | 'insufficient'
  | 'contradicted';

/** Judge output for one (claim, quote) pair. */
export interface EntailmentResult {
  /** Entailment class, or `"error"` when the judge failed for this item. */
  class: EntailmentClass | 'error';
  /** Degree of support in [0, 1]; `null` when unavailable. */
  confidence: number | null;
  /** Short judge rationales (at most two, in the claim's language). */
  reasons: string[];
}

/** Input unit for an entailment judge. */
export interface EntailmentInput {
  /** Caller-chosen identifier echoed back in the result. */
  id: string;
  /** The claim as stated in the answer. */
  claim: string;
  /** The verbatim quote attributed to the source. */
  quote: string;
  /** Surrounding source text for disambiguation (may be empty). */
  context: string;
}

/**
 * Pluggable semantic verifier. Implementations must be deterministic for
 * reproducibility (e.g. temperature 0) and must return exactly one result
 * per input, in input order, using `class: "error"` for individual failures.
 */
export interface EntailmentJudge {
  judge(items: EntailmentInput[], options?: { signal?: AbortSignal }): Promise<EntailmentResult[]>;
}

/** Combined verification result for one (claim, source) citation. */
export interface CitationVerification {
  claimId: string;
  sourceIndex: number;
  claimText: string;
  quote: string;
  textMatch: QuoteMatch;
  /** Absent when verification ran without a judge. */
  entailment?: EntailmentResult;
  /**
   * Conservative combined score: `min(textMatch.score, entailment.confidence)`.
   * When no judge ran, equals `textMatch.score`. `null` if the judge errored.
   */
  score: number | null;
}

/** Aggregate statistics over all citations in one answer. */
export interface VerificationSummary {
  citationCount: number;
  /** Share of citations whose quote is a literal (exact or normalized) hit. */
  verbatimRate: number | null;
  /** Share of judged citations classified `entailed`; `null` without a judge. */
  entailedRate: number | null;
  /** Mean of non-null combined scores; `null` if none. */
  meanScore: number | null;
  /** Minimum of non-null combined scores; `null` if none. */
  minScore: number | null;
}

/** Full transparency report for one answer. */
export interface VerificationReport {
  cleanText: string;
  claims: Claim[];
  citations: CitationVerification[];
  warnings: string[];
  summary: VerificationSummary;
}
