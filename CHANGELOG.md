# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `bench/`: three benchmark harnesses, kept separate because a blended number
  for a two-stage pipeline would hide the failure modes the pipeline exists to
  separate.
  - `bench/matcher`: 2,061 items, deterministic, no API key and no labels —
    ground truth comes from the mutation operator that produced each item.
    Faithful-but-reformatted quotes are accepted at 100%, absent quotes
    rejected at 100%, and the two score distributions do not overlap
    (0.396 / 0.660), which is what puts the default `fuzzyThreshold` of 0.4 on
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
    `gpt-oss-120b` always emits an appendix but completes only 30.8% of its
    citations, while `mistral-medium` completes 92.3% and supplies quotes that
    are literally in the source only 66.5% of the time.
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
