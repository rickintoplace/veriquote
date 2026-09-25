# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-09-25

Measured on four open answering models with two judges: the revised citation
instructions raise the share of fully supported citations by 7.6 points (95%
interval 1.5–14.2, chat judge) and 14.1 points (7.6–21.5, decision model),
with all quotes verbatim and no fewer cited claims. Details in
`bench/README.md`.

### Changed
- `parseEvi1Appendix`, `stripEvi1Appendix` and `parseAnswer` accept the
  appendix as models and gateways actually emit it: `**EVI1**`, `EVI1:`,
  evidence on the `EVI1` line, a code fence around the block, `END_EVI11` or
  no `END_EVI1` at all, spaces around the `|` separators, and a trailing run of
  evidence lines without an `EVI1` line. A line only opens the appendix when
  evidence or `END_EVI1` follows it, so text about the EVI1 gene is left alone.
- A claim marker without its `[n]` group (`…sentence.{c1}`) takes its sources
  from the appendix instead of losing its evidence; the warning stays.
- Matcher: an ellipsis at either end of a quote no longer costs anything.
- A (claim, source) pair may carry several quotes, for a claim one passage
  does not cover. They are verified as one citation: joined for the judge,
  rated by the weakest quote. Only repeated quotes are dropped now.
- Without `END_EVI1`, the appendix ends at the first line that is not an
  evidence line, so an answer after an evidence-first block is kept.
- `buildCitationInstructions()`: sufficiency rules (the quotes must contain
  every detail of the sentence, otherwise the detail goes), several lines per
  pair allowed, no "..." inside quotes, and `[n]` required before every `{cX}`.
  Full support rose on every model tested (see above); no model wrote an
  elided quote any more.
- Protocol benchmark: the published numbers are the current instructions on
  `qwen3.8-27b`, `glm-5.3-flash`, `deepseek-v4-flash` and `qwen3.6-35b-a3b`,
  with verbatim and full support under two judges. The eight-model compliance
  table of the previous instructions moved to `bench/README.md`.

### Added
- Match method `elided`: a quote that leaves text out with `…`, `...` or `[…]`
  matches when every fragment occurs literally, in order, with at most
  `maxElisionGap` (default 300) characters between them; score 0.99. The judge
  then rates the full source passage, omitted text included, so an ellipsis
  cannot hide a negation. Collages of passages out of order or far apart stay
  fuzzy.
- `buildCitationInstructions({ evidenceFirst: true })`: the EVI1 block comes
  before the answer, so the model picks its passages before it writes.
  Measured and off by default: no reliable gain in support (+3.6 and −0.3
  points), one model dropped quotes, and a streamed answer stays hidden until
  the block is written.
- `omittedCues` on elided matches: negations, exceptions, "only" and
  contrasts in the text an ellipsis leaves out (English and German). The
  report warns; without a judge verdict the gate flags
  `ellipsis_hides_qualifier`, with one the judge decides, since it saw the
  full passage.
- `bench/protocol/run.mjs --rescore`: scores the stored answers again after a
  parser or matcher change, without an API call. `--prompt evidence-first`,
  `--judge-model` (strict and lenient support, with a verdict cache and the
  endpoint's rate limits applied to judge requests too) and `--judge-decisions`.
- `bench/lib/decisions-judge.mjs` and `bench/judge/run.mjs --decisions`: a
  judge backed by a decision model through OpenRouter's decisions endpoint.
  `jev-1.13` on the 240 ALCE pairs every judge gets: 12.5% false green (the
  lowest measured), binary agreement 79.6%, κ 0.497; on all 2,896 pairs 10.3%
  false green and κ 0.530, for $0.09. Closed model, no reasons, optional.
- `stripForDisplay(text)`: the answer body for rendering, safe to call on
  every streamed chunk — it hides an incomplete appendix, a half-written
  `EVI1` line and a half-written `{c` marker.

## [0.2.2] - 2026-09-23

0.2.0 (2026-09-22) to 0.2.2 shipped without changelog entries; this is what
they added, among them the `veriquote` CLI and the agent integration.

### Added
- `bench/`: three benchmark harnesses, kept separate because a blended number
  for a two-stage pipeline would hide the failure modes the pipeline exists to
  separate.
  - `bench/matcher`: 2,061 items, deterministic, no API key and no labels —
    ground truth comes from the mutation operator that produced each item.
    Faithful-but-reformatted quotes are accepted at 100%, absent quotes
    rejected at 100%, and the two score distributions do not overlap
    (0.396 / 0.851), which is what puts the default `fuzzyThreshold` of 0.4 on
    an empirical footing rather than a guess.
  - `bench/judge`: agreement with the 2,896 human-annotated pairs in the ALCE
    human evaluation set (MIT), with the five-class → three-level mapping fixed
    before any model runs. First result (`gpt-oss-120b`, 240 pairs): 76.7%
    agreement on ALCE's binary question against its TRUE-NLI baseline of 77.6%,
    but only 64.2% three-class accuracy (kappa 0.394) and a 25.0% false-green
    rate — the judge is not dependable enough to be a claim's only check, which
    is what `min(textMatch, judgeConfidence)` is for.
  - `bench/protocol`: mechanical EVI1 compliance per answering model over 18
    tasks, three of which the sources deliberately cannot answer. First results
    show two opposite failure modes, neither visible to a reader:
    `gpt-oss-120b` quotes nearly every citation but drops the inline `[n]`
    marker in nearly two thirds of its answers, while `mistral-medium` is nearly
    always complete and supplies quotes that are literally in the source only
    81% of the time.
  - `bench/probe.mjs`: checks an endpoint's models for reachability, JSON mode
    and EVI1 compliance before a run is spent on them.
  - `bench/lib/http.mjs`: rate-limit-aware client that paces itself from
    `x-ratelimit-*` headers and refuses runs that cannot fit the remaining
    budget.
- `demo/`: self-contained browser page for the matcher — no key, no server, no
  build step.
- CI now runs the matcher benchmark on every commit and fails the build if the
  matcher ever accepts a fabricated quote or rejects a faithful one.

### Changed
- README: corrected the claim that a high fuzzy score distinguishes light
  paraphrase from fabrication. Measurement shows the opposite — a quote with one
  digit altered scores 0.968 while an honest paraphrase scores 0.306. The score
  measures fidelity of copying, not truth.
- README/DESIGN: state plainly that prompting for verbatim quotes does not
  reduce hallucination rates; it makes claims checkable, which is why
  verification is not optional. Added a comparison against the Anthropic
  Citations API, LettuceDetect and eval frameworks, including when to use those
  instead.

### Fixed
- `.gitignore`: `.env.*` was swallowing `.env.example`.

## [0.1.1] - 2026-07-26

### Added
- `integrations/verify-citations/`: a portable Agent Skill (SKILL.md + Node
  CLI) that runs VeriQuote as an internal hallucination gate for
  source-grounded agents, with a coverage check for uncited factual sentences
  and a self-correction loop. Not part of the npm package.

### Changed
- `package.json`: added `homepage` and `bugs` for the npm listing (takes
  effect on the next publish).

## [0.1.1] - 2026-07-25
- DOI to README.md and CITATION.cff 

## [0.1.0] - 2026-07-25

### Added

- EVI1 protocol: prompt-block generator, appendix parser/serializer, claim
  extraction, and bidirectional completeness checking with warnings.
- Deterministic quote matcher: exact and typography-normalized substring
  search with raw-text offset mapping, plus rolling-window character-trigram
  Dice fuzzy matching with coarse/fine scanning and short-quote penalty.
- `ChatCompletionsJudge`: temperature-0 entailment judge for any
  OpenAI-compatible API, with batching, retries, timeouts, input
  sanitization, tolerant JSON recovery, and strict output validation.
- `verifyAnswer()`: end-to-end pipeline producing per-citation and
  per-answer transparency reports (`min(textMatch, entailment)` scoring).
- Test suite (40 tests), design documentation, Zenodo/CITATION metadata.
