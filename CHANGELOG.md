# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
