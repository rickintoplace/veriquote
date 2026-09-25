# VeriQuote | Method and Design

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

   One line per (claim, source) pair, or several when one passage does not
   cover the claim; quotes are verbatim, single-line (`\n`, `\"`, `\\`
   escapes), one contiguous passage each, preferably 80–240 characters.
   With `evidenceFirst` the block comes before the answer: the model selects
   its passages first and then writes only what they support.
3. **Completeness and sufficiency.** Every cited pair must have an appendix
   line; if the model cannot quote, it must drop the citation. The quotes of a
   sentence must together contain every detail it states (numbers,
   populations, conditions, hedges); otherwise the detail goes. The parser cross-checks both
   directions and emits warnings for violations (missing evidence, orphan
   evidence, duplicate ids, non-adjacent markers). A claim marker without its
   `[n]` group takes its sources from the appendix, with a warning.

Design choices: line-oriented plain text survives streaming and markdown
pipelines better than JSON; the appendix is located by scanning **from the
end** of the answer so body text mentioning "EVI1" cannot confuse the parser;
the human-readable `[n]` markers remain meaningful for clients that ignore the
protocol.

The parser is strict about evidence lines and lenient about their framing,
because models and gateways vary it: `**EVI1**`, `EVI1:`, evidence on the
`EVI1` line, a code fence around the block, a garbled or missing `END_EVI1`,
and a trailing run of evidence lines with no `EVI1` line are all accepted. A
line counts as the start only when evidence or `END_EVI1` follows, so a
heading about the EVI1 gene does not swallow the answer. `stripForDisplay()`
applies the same rules to a partial answer, so a streaming client never shows
a half-written appendix or marker.

## 3. Deterministic quote matching

Given a quote and the source's extracted text, the matcher returns
`{ method, score ∈ [0,1], start, end }`:

1. **Exact:** raw substring search -> score 1.
2. **Normalized:** substring search after normalization -> score 1.
   Normalization is per code point (NFKC, case folding, unified quote/dash
   variants, removal of soft hyphens and zero-width characters, whitespace
   collapse) with an **offset map**, so match positions are still reported in
   raw-source coordinates for highlighting. An ellipsis at either end of the
   quote is dropped: nothing inside the quote is missing.
3. **Elided:** the quote leaves text out, marked `…`, `...`, `[…]` or `(...)`.
   Every fragment must occur literally (after normalization), in the quote's
   order, with at most 300 characters between neighbours, and one fragment
   must be at least 20 characters long -> score 0.99. `start`/`end` span the
   whole passage including what was left out, and **that passage, not the
   elided quote, goes to the judge**, so an ellipsis cannot hide a "not" or a
   qualifier. Fragments out of order or far apart are a collage, not an
   elision, and fall through to the fuzzy step.

   The omitted stretches are also scanned for words that reverse or limit a
   statement (English and German negations, exceptions, "only", contrasts;
   whole words, plus `n't`) and reported as `omittedCues`. That is a hint, not
   a verdict: "not only … but also" is harmless. A judge that has read the full
   passage decides; without a judge verdict, the gate treats the citation as
   a problem (`ellipsis_hides_qualifier`).
4. **Fuzzy:** sliding-window comparison using **character-trigram multiset
   Dice similarity**. Windows of 0.85×, 1.0×, and 1.15× the quote length slide
   over the normalized source with a coarse step of `clamp(len/8, 10, 80)`;
   trigram counts and the multiset intersection are updated incrementally
   (rolling window), giving O(|source|) per window size. A fine pass with
   step 1 refines around the coarse optimum.

   The fuzzy score is `dice × min(1, len/90)` (short quotes are penalized
   because trigram similarity is spuriously high for short strings) and
   capped at **0.99**, so a score of 1 always implies a literal hit.
   Scores below a threshold (default 0.4) are reported as `not_found`.

The matcher is pure: no I/O, no randomness, no locale dependence.

## 4. Semantic entailment judge

Text presence does not imply support. A small LLM judge receives, per item:
the **claim** (marker-free sentence text), the **quote**, and a **context
window** of source text around the matched region (default ±420 chars). A pair
with several quotes is one item: the quotes are joined with ` […] ` and the
pair's text match is its weakest quote's, so one invented quote fails it. It
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
- item IDs are mirrored and matched. Hallucinated IDs are discarded, missing
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

Per citation: `score = min(textMatchScore, judgeConfidence)`. A claim is only
as trustworthy as its weakest check. Judge errors yield `score = null`
(unknown ≠ supported). Per answer, the report aggregates: citation count,
verbatim rate, entailed rate, mean and minimum combined score, plus all
protocol warnings. UIs are expected to surface the per-citation results:
colour each footnote by its worst score and show both checks, with
percentages, in the citation tooltip.

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
  for a misleading claim in context. VeriQuote verifies claim<->quote<->source
  consistency, not overall answer balance.

## 7. Empirical validation

The method claims above are measured, not asserted; `bench/` holds the
harnesses and `bench/README.md` the protocol.

**Matcher** (2,061 items, ground truth by construction, no labels or API
needed). Quotes that are faithful but reformatted -- whitespace damage,
typography, OCR-style noise, scholarly elision, PDF hyphenation -- are accepted
at 100% (n=1,121, median score 1.000). Quotes absent from the source -- a real
quote attributed to the wrong document, or an honest paraphrase offered in
place of a quote -- are rejected at 100% (n=187, median 0.249). The two
distributions do not overlap: no faithful quote scores below 0.851 and no
absent quote above 0.396. The default `fuzzyThreshold` of 0.4 sits in that gap,
and the whole band from 0.40 to 0.85 yields 100% on both sides.

Quotes that are near-verbatim but semantically altered (a figure swapped, a
negation inserted, a hedge strengthened, two fragments spliced) are accepted at
100%, median score 0.932. This is the designed blind spot quantified: character
trigrams cannot see which character carried the meaning. It bounds what
Section 3 can contribute and is the empirical case for Section 4 not being
optional. A worked example: swapping one digit in a real quote costs 0.032 of
score, while paraphrasing the same sentence honestly costs 0.694 -- fidelity of
copying and truth of the claim run in opposite directions, and only the first
is what the matcher measures.

**Judge**. Agreement with human annotators is measured against the ALCE human
evaluation set (Gao et al., EMNLP 2023; MIT): 2,896 (sentence, cited document)
pairs rated *fully supports* / *partially supports* / *does not support*. The
mapping from the five classes of Section 4 onto those three levels is fixed
before any model is run. Reported as three-class accuracy, macro-F1 and Cohen's
kappa, plus the binary "fully supports" precision and recall that ALCE itself
publishes, keeping the figures comparable to its TRUE-NLI baseline. One rate is
called out separately -- how often the judge calls a claim fully supported when
annotators found no support at all -- because a wrong citation displayed in
green is worse than one flagged for review. Note that ALCE pairs a sentence
with a whole passage rather than a model-selected quote, so this measures the
judge in isolation, under a harder condition than deployment.

**Protocol compliance and support**. Whether a given answering model emits a
parseable appendix at all is decided mechanically by `parseAnswer()` over 18
tasks, three of which the sources deliberately cannot answer. Compliance varies
enough between models that it must be measured per model before deployment,
not assumed. With the current instructions, four good open models quote
verbatim in 100% of cases, and a judge rates 71–97% of their citations as fully
supported, depending on the model. Adding explicit sufficiency rules to the
instructions raised full support by 7.6 points (95% interval 1.5–14.2) under
the chat judge and by 14.1 points (7.6–21.5) under an independent decision
model, with no fewer cited claims; putting the evidence before the answer did
not add a reliable gain. Verbatim copying is therefore close to solved for
strong models, and sufficiency -- a quote that covers only part of its claim --
is the main remaining failure, which is what the judge is for. Separately, prompting for verbatim quotes is not itself a
hallucination mitigation: it is not designed to reduce how often a model
fabricates; it makes the fabrication checkable. The verification step is
therefore not optional.
