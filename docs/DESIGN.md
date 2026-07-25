# VeriQuote — Method and Design

This document describes the verification method in enough detail to reproduce
it independently. It accompanies the Zenodo record.

## 1. Problem

Source-grounded assistants (RAG, web-search agents) attach citations like
`[1]` to generated text. Citations alone are weak evidence: models routinely
cite real sources for claims those sources do not make ("citation
hallucination" / unfaithful attribution). Users cannot tell a grounded
statement from a confabulated one without opening every source.

VeriQuote makes the grounding claim itself falsifiable: the model must commit
to a **verbatim quote** per (claim, source) pair, and the system verifies that
commitment mechanically and semantically, then reports the outcome per claim.

## 2. Protocol (EVI1)

The answering model receives numbered sources and an instruction block
(`buildCitationInstructions()`) that mandates:

1. **Inline markers.** Every cited sentence/bullet ends with a citation group
   and a claim marker with no intervening characters:
   `…freezing.[2][5]{c1}`. Claim ids `c1, c2, …` are unique per answer.
2. **Quote appendix.** After the answer body:

   ```
   EVI1
   cX|n|"QUOTE"
   END_EVI1
   ```

   One line per (claim, source) pair; quotes are verbatim, single-line
   (`\n`, `\"`, `\\` escapes), preferably 80–240 characters.
3. **Completeness.** Every cited pair must have an appendix line; if the model
   cannot quote, it must drop the citation. The parser cross-checks both
   directions and emits warnings for violations (missing evidence, orphan
   evidence, duplicate ids, non-adjacent markers).

Design choices: line-oriented plain text survives streaming and markdown
pipelines better than JSON; the appendix is located by scanning **from the
end** of the answer so body text mentioning "EVI1" cannot confuse the parser;
the human-readable `[n]` markers remain meaningful for clients that ignore the
protocol.

## 3. Deterministic quote matching

Given a quote and the source's extracted text, the matcher returns
`{ method, score ∈ [0,1], start, end }`:

1. **Exact:** raw substring search → score 1.
2. **Normalized:** substring search after normalization → score 1.
   Normalization is per code point (NFKC, case folding, unified quote/dash
   variants, removal of soft hyphens and zero-width characters, whitespace
   collapse) with an **offset map**, so match positions are still reported in
   raw-source coordinates for highlighting.
3. **Fuzzy:** sliding-window comparison using **character-trigram multiset
   Dice similarity**. Windows of 0.85×, 1.0×, and 1.15× the quote length slide
   over the normalized source with a coarse step of `clamp(len/8, 10, 80)`;
   trigram counts and the multiset intersection are updated incrementally
   (rolling window), giving O(|source|) per window size. A fine pass with
   step 1 refines around the coarse optimum.

   The fuzzy score is `dice × min(1, len/90)` — short quotes are penalized
   because trigram similarity is spuriously high for short strings — and
   capped at **0.99**, so a score of 1 always implies a literal hit.
   Scores below a threshold (default 0.4) are reported as `not_found`.

The matcher is pure: no I/O, no randomness, no locale dependence.

## 4. Semantic entailment judge

Text presence does not imply support. A small LLM judge receives, per item:
the **claim** (marker-free sentence text), the **quote**, and a **context
window** of source text around the matched region (default ±420 chars). It
returns a class and a confidence (degree of support):

| class | confidence | semantics |
| --- | --- | --- |
| entailed | 0.9–1.0 | claim fully covered by quote |
| partially_entailed | 0.5–0.8 | core supported, details missing |
| overstated | 0.3–0.6 | claim stronger/more general than evidence |
| insufficient | 0.1–0.4 | related but not confirming |
| contradicted | 0.0 | evidence states the opposite |

Determinism and robustness measures:

- temperature 0, optional seed, `response_format: json_object`;
- closed class vocabulary; outputs failing validation become `error`;
- confidences clamped to [0, 1]; at most 2 short reasons, emitted in the
  claim's language;
- item IDs are echoed and matched — hallucinated IDs are discarded, missing
  IDs become `error` (never silently filled);
- tolerant JSON recovery (string-aware balanced-brace scanning) salvages
  intact items from truncated/broken model output without `eval`;
- inputs are length-capped and sanitized (control characters, HTML) and the
  prompt pins claim/quote/context as data, not instructions;
- batching (default 12 items/request), bounded retries with exponential
  backoff on 429/5xx, per-request timeout.

The judge is pluggable (`EntailmentJudge` interface); a local NLI model is a
drop-in replacement for the hosted default.

## 5. Scoring and reporting

Per citation: `score = min(textMatchScore, judgeConfidence)` — a claim is only
as trustworthy as its weakest check. Judge errors yield `score = null`
(unknown ≠ supported). Per answer, the report aggregates: citation count,
verbatim rate, entailed rate, mean and minimum combined score, plus all
protocol warnings. UIs are expected to surface the per-citation results (e.g.
NavigNine colors each footnote by its worst score and shows both checks with
percentages in the citation tooltip).

## 6. Threat model and limitations

- **Extraction quality bounds everything.** If source text extraction is poor
  (paywalls, PDFs, truncated snippets), verbatim quotes may legitimately fail
  to match. The matcher searches fallback fields (`extraTexts`) and reports
  which field matched.
- **The judge is itself an LLM.** It can err, particularly on long inference
  chains; temperature 0 makes it consistent, not infallible. The deterministic
  match provides a floor that no judge error can raise (min-combination).
- **Adversarial sources.** Source text is treated as untrusted input
  throughout; sanitization and instruction-pinning reduce, but cannot fully
  eliminate, prompt-injection risk against the judge. The judge has no tools
  and its output is schema-validated, bounding impact.
- **Quote selection bias.** A model may pick a technically-supporting quote
  for a misleading claim in context. VeriQuote verifies claim↔quote↔source
  consistency, not overall answer balance.

## 7. Reference deployment

NavigNine (https://navignine.com) runs this pipeline in production: the
matcher in the browser, the judge behind a serverless endpoint, with per-claim
colored footnotes and tooltips exposing both check results to end users.
