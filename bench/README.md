# VeriQuote benchmarks

Three separate questions, three separate benchmarks. Keeping them apart is the
point: a single blended "accuracy" number for a two-stage pipeline would hide
exactly the failure modes the pipeline exists to separate.

| benchmark | question | needs | labels |
| --- | --- | --- | --- |
| [`matcher/`](matcher) | Does deterministic matching accept faithful quotes and reject absent ones? | nothing | none; the right answer is known by construction |
| [`protocol/`](protocol) | Does a given answering model emit verbatim quotes that cover its claims? | an API key | none; the parser and matcher decide compliance, a judge rates support |
| [`judge/`](judge) | Does the entailment judge agree with human annotators? | an API key | ALCE human annotations[^alce] (MIT) |

Two of the three need no labelled data at all, which is why they can run on
every commit. Only the judge needs human labels, and those already exist.

## 1. Matcher

```bash
npm run build
node bench/matcher/run.mjs --json bench/results/matcher.json
```

Deterministic, offline, ~2 s. Takes 167 passages from five pinned Wikipedia
articles and puts each through fourteen mutation operators plus twenty
hand-written paraphrases, in three families:

- **faithful**: the quote still reports the source honestly but the string
  differs: whitespace damage, smart quotes, case, OCR-style typos, scholarly
  elision, PDF hyphenation. The matcher **must** accept these; a miss here is a
  false accusation against an honest answer.
- **manipulated**: near-verbatim, but the meaning was changed: a figure
  swapped, a negation inserted, a hedge strengthened, two distant fragments
  spliced together. The matcher is **not** expected to catch these. They are
  measured to size the blind spot the entailment judge has to cover.
- **absent**: the text is not in the source: a real quote attributed to the
  wrong document, or an honest paraphrase instead of a quote. The matcher
  **must** reject these; an acceptance is a missed fabrication.

Operators are also tagged `natural` or `adversarial`. Headline numbers cover
natural operators only, and adversarial ones are reported in their own row.
Otherwise the score would say more about how many attacks were invented than
about the matcher.

Current results: [`results/matcher.json`](results/matcher.json).

## 2. Protocol compliance

```bash
node --env-file=.env bench/protocol/run.mjs \
  --models glm-5.3-flash,qwen3.6-35b-a3b,deepseek-v4-flash-0731 --repeats 2 \
  --judge-model deepseek-v4-flash-0731 --judge-thinking \
  --json bench/results/protocol-v2-end.json
```

Eighteen tasks over the same pinned corpus, three of them deliberately not
answerable from the sources. Each model gets `buildCitationInstructions()` in
its system prompt; `parseAnswer()` then decides mechanically whether it
complied, the matcher checks every quote, and a judge rates every citation.
Every raw answer is kept next to its results file (`*-answers.jsonl`) with the
provider's finish reason, so each number can be checked against the text.

Reported per model:

- **complete**: every `(claim, source)` pair it cited also carries a quote.
  A model that prints `[n]` markers and skips the appendix produces an answer
  that *looks* well-cited and carries no verifiable evidence.
- **verbatim**: share of supplied quotes literally present in the source;
  **elided**: quotes whose fragments are all literally present, in order and
  close together, with "…" between them (counted apart).
- **fully supported** (strict support): share of judged citations rated
  `entailed`, i.e. the quotes cover every detail of the claim; **lenient**:
  `entailed` or `partially_entailed`.
- **claims/answer**, **quote chars**: to catch a prompt that buys support by
  saying less.
- **appendix**, **coverage**, **warning-free**: finer grades of completeness.
- **cut off**: the provider stopped the answer at its token limit, which would
  remove the appendix; counted separately so it is not blamed on the model.
- **bad cites, unanswerable**: on a question the sources cannot answer, a
  citation without a real quote behind it. Declining while quoting related
  context is not counted.

Options: `--prompt evidence-first` puts the EVI1 block before the answer.
`--judge-model` adds the support columns (`--judge-thinking` keeps the model's
reasoning on); `--judge-decisions` uses a decision model through OpenRouter's
decisions endpoint instead of a chat model. Verdicts are cached next to the
results file (`*-judge-cache.jsonl`), so a rescore only pays for citations it
has not judged yet. After a change to the parser, matcher or judge, the stored
answers are scored again without new generations:

```bash
npm run build && node bench/protocol/run.mjs \
  --rescore bench/results/protocol-v2-end.json --json bench/results/protocol-v2-end.json \
  --judge-model deepseek-v4-flash-0731 --judge-thinking
```

### Results: current instructions (2026-09-25, 2 runs per task)

Four good open models; `qwen3.8-27b` through OpenRouter, the others through
the endpoint the previous run used. Every citation is judged twice:
`deepseek-v4-flash` (reasoning on; it also judges its own answers) and the
decision model `jev-1.13` as an independent check (see the judge benchmark
below). *old* is the previous instructions on the same models, from the stored
answers of 2026-09-22, judged the same way.

| model | verbatim | complete | claims/answer | fully supported, old → new (deepseek judge) | fully supported, old → new (jev) |
| --- | ---: | ---: | ---: | ---: | ---: |
| qwen3.8-27b | 100.0% | 100.0% | 2.8 | – → 97.4% | – → 97.4% |
| glm-5.3-flash | 100.0% | 100.0% | 4.7 | 88.5% → 95.1% | 79.2% → 93.0% |
| deepseek-v4-flash | 100.0% | 100.0% | 3.3 | 82.2% → 88.0% | 75.2% → 90.0% |
| qwen3.6-35b-a3b | 100.0% | 96.7% | 3.0 | 67.0% → 76.9% | 58.2% → 71.4% |

Pooled over `glm-5.3-flash`, `deepseek-v4-flash` and `qwen3.6-35b-a3b`, with a
bootstrap over answers within each model (95% intervals):

| change | deepseek judge | jev |
| --- | ---: | ---: |
| new instructions vs. old | **+7.6** points (1.5 to 14.2) | **+14.1** points (7.6 to 21.5) |
| evidence first vs. evidence after | +3.6 (−2.8 to 9.5) | −0.3 (−7.0 to 5.5) |

- **Asking for sufficiency works.** The new rules (the quotes must contain every
  number, population, condition and hedge of the sentence, otherwise the detail
  goes; several quotes per pair allowed; no "…" inside quotes) raise full
  support under both judges, with the same number of cited claims per answer.
  No model wrote an elided quote any more, and all quotes were verbatim.
- **Evidence first does not help.** The pre-registered bar was +5 points
  without losing completeness or claims. It missed the bar under both judges,
  and `qwen3.6-35b-a3b` fell from 96.7% to 90.0% complete because it cited
  sources in the answer that its evidence block did not quote. It also hides a
  streamed answer until the block is written. The option stays, measured and
  off by default.
- **The model matters more than the judge.** Both judges rank the models the
  same way; the decision model is stricter by 7–9 points on the old answers.
  `deepseek-v4-flash` does not visibly favour its own answers: its gap to the
  independent judge is no larger on them than on the others.
- No answer was cut off, and no model put an unsupported citation on an
  unanswerable question.

Caveats: 36 answers per model, so per-model differences carry wide intervals
(the pooled ones do not); the old answers are three days older, and only
`deepseek-v4-flash-0731` is a pinned version; `qwen3.8-27b` has no old run and
ran through a different provider. Files: `results/protocol-baseline*.json`,
`results/protocol-v2-*.json`, with `-jev` for the second judge and
`-openrouter` for `qwen3.8-27b`.

### Previous instructions: eight models (answers from 2026-09-22, scored 2026-09-25)

Compliance only, no judge. Weaker models are kept here because their failure
modes are the ones the parser and matcher were hardened against.

| model | n | api fails | cut off | appendix | complete | coverage | verbatim | elided | warning-free | bad cites, unanswerable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| qwen3.6-35b-a3b | 36 | 0 | 0.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 100.0% | 0.0% |
| qwen3.5-397b-a17b | 24 | 12 | 0.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 100.0% | 0.0% |
| deepseek-v4-flash-0731 | 36 | 0 | 0.0% | 100.0% | 100.0% | 100.0% | 99.2% | 0.0% | 100.0% | 0.0% |
| glm-5.3-flash | 35 | 1 | 0.0% | 96.6% | 96.6% | 96.6% | 99.6% | 0.0% | 96.6% | 0.0% |
| gemma-4-31b-it | 36 | 0 | 0.0% | 80.0% | 80.0% | 80.0% | 96.6% | 3.4% | 80.0% | 0.0% |
| mistral-medium-3.5-128b | 36 | 0 | 0.0% | 96.7% | 93.3% | 100.0% | 81.0% | 4.6% | 96.7% | 0.0% |
| openai-gpt-oss-120b | 36 | 0 | 0.0% | 96.7% | 96.7% | 100.0% | 92.0% | 3.7% | 33.3% | 0.0% |
| meta-llama-3.1-8b-instruct | 36 | 0 | 0.0% | 73.3% | 70.0% | 87.2% | 59.9% | 0.0% | 33.3% | 0.0% |

**elided**: quotes that leave text out with "…" and whose fragments are all
literally in the source, in order and close together; counted apart from
verbatim.

- **The open models recommended here comply almost perfectly.**
  `qwen3.6-35b-a3b` is complete and verbatim on every answer; `deepseek-v4-flash`,
  `glm-5.3-flash` and `qwen3.5-397b` miss at most one quote or one appendix.
- **`gpt-oss-120b` quotes almost every citation but drops the `[n]` marker in
  nearly two thirds of its answers** (`…sentence.{c1}`), naming the source only in the
  appendix. The parser takes the source from there and warns, hence
  96.7% complete but 33.3% warning-free. Scored strictly, as before
  2026-09-25, only a third of its answers were complete.
- **`mistral-medium` is nearly always complete, but only 81% of its quotes are
  exact copies.** A few are clean elisions; most of the rest stitch passages
  together with "..." out of order or more than 300 characters apart, or change
  a few words. Those are collages, not quotes, and the matcher reports them as
  fuzzy, at a lower score.
- **`llama-3.1-8b` is not usable with this protocol.**
- No answer was cut off, and no model put an unsupported citation on an
  unanswerable question. Four such answers from `qwen3.5-397b` and two each
  from `deepseek-v4-flash` and `glm-5.3-flash` say the sources do not answer
  the question and quote related context, which is correct, as the raw answers show.

Caveats: 36 answers per model (fewer where the endpoint dropped requests, see
`api fails`) separate usable from unusable models, not close neighbours.

## 3. Judge

```bash
node bench/judge/prepare-alce.mjs
node --env-file=.env bench/judge/run.mjs \
  --model glm-5.3-flash --limit 240 \
  --json bench/results/judge-glm-5.3-flash.json
```

`prepare-alce.mjs` downloads the human annotations from
[ALCE](https://github.com/princeton-nlp/ALCE)[^alce] (MIT licence) and converts
them to JSONL: **2,896 (claim, cited document) pairs**
rated by human annotators as *fully supports* (1,569), *partially supports*
(685) or *does not support* (642).

The mapping from VeriQuote's five classes onto those three levels is written
down in `run.mjs` **before** any model is run, so it cannot be tuned after
seeing results:

| VeriQuote class | ALCE level |
| --- | --- |
| `entailed` | full |
| `partially_entailed`, `overstated` | partial |
| `insufficient`, `contradicted` | none |

Reported: three-class accuracy, macro-F1, Cohen's kappa, the full confusion
matrix, and separately the binary "fully supports" precision/recall that ALCE
itself reports. That makes the number comparable to ALCE's automatic metric,
the TRUE NLI model[^true], which the paper reports agreeing with the annotators
85.1% of the time on citation recall and 77.6% on citation precision.

One number is called out on its own: **false green**, how often the judge
calls a claim fully supported when the annotators said the source supports
nothing. The README and the demo show its complement, *caught*.
A wrong citation shown in green is worse than one flagged for review, so that
rate matters more than the average.

### Results (2026-09-21 and 2026-09-22; `jev-1.13` on 2026-09-25)

Five open-weight models, the same 240 pairs (seed `20260921`), temperature 0,
the shipped judge prompt. Judge errors are reported, not dropped; they are
excluded from the scores.

| judge model | false green ↓ | binary agreement | 3-class acc. | macro-F1 | κ | `partial` F1 | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `jev-1.13` (decision model) | **12.5%** | 79.6% | 69.2% | 0.641 | 0.497 | 0.430 | 0 |
| `glm-5.3-flash` | 16.1% | **80.3%** | **71.5%** | **0.668** | **0.529** | **0.509** | 1 |
| `qwen3.5-397b-a17b` | 20.8% | 79.7% | 69.6% | 0.622 | 0.483 | 0.414 | 13 |
| `qwen3.6-35b-a3b` | 18.2% | 78.1% | 67.1% | 0.605 | 0.454 | 0.396 | 3 |
| `deepseek-v4-flash` | 18.2% | 78.7% | 66.5% | 0.570 | 0.435 | 0.282 | 1 |
| `gpt-oss-120b` | 25.0% | 76.7% | 64.2% | 0.551 | 0.394 | 0.306 | 8 |
| `qwen3.5-397b-a17b`, no reasoning | 21.4% | 77.7% | 64.7% | 0.554 | 0.410 | 0.286 | 2 |
| `qwen3.6-35b-a3b`, no reasoning | 21.4% | 77.3% | 64.3% | 0.520 | 0.397 | 0.164 | 2 |
| `glm-5.3-flash`, no reasoning | 24.4% | 74.0% | 63.2% | 0.549 | 0.373 | 0.304 | 36 |
| *TRUE (T5-11B), ALCE's automatic metric* | | *77.6%* | | | | | |

Full output per model: [`results/judge-*.json`](results/). Plotted with 95% intervals in [`figures/`](figures).

`jev-1.13` (TypeSafe, through OpenRouter's decisions endpoint) is not a chat
model: it returns a probability per class, no text and no reasons. The class
descriptions and the conversion of its probabilities into a support score are
fixed in [`lib/decisions-judge.mjs`](lib/decisions-judge.mjs) and were not
tuned on these results:

```bash
node --env-file=.env bench/judge/run.mjs --decisions --model typesafe/jev-1.13 \
  --json bench/results/judge-typesafe-jev-1.13.json
```

Because it costs next to nothing ($0.007 for these 240 pairs, 6 seconds), it
was also run on **all 2,896 pairs**: false green 10.3% (66 of 642, 95% interval
about 8–13%), binary agreement 81.6%, 3-class accuracy 71.5%, κ 0.530, `partial`
F1 0.505, no errors, $0.09 in 70 seconds
([`results/full-alce/`](results/full-alce/)). It is a closed model and an
optional backend; the chat models above are open.

What this says:

- **General-purpose open models match a specialised NLI model** on ALCE's own
  binary question. The best one reaches κ 0.53 on the three-way labels; ALCE
  reports κ 0.525 between its automatic metric and the annotators on citation
  precision. With about 240 pairs per run the binary numbers carry roughly ±5
  points of sampling error, so read the top four as level with TRUE, not as
  beating it.
- **False green** (an unsupported citation shown as fully supported) ranges
  from 12.5% to 25%. With 56 unsupported pairs per run the 95% intervals overlap,
  so neighbouring models are not separated; a larger `--limit` would settle the
  ranking.
- **Reasoning pays for itself in quality.** With `--no-thinking` (vLLM's
  `enable_thinking: false`, passed through the judge's `extraBody`) all three
  hybrid models lose agreement and gain false greens, while answering five to
  ten times faster. The `glm-5.3-flash` run without reasoning lost 36 of 240
  items to endpoint errors, so read its row with care.
- **`partial` is the weak class for every model** (F1 0.28–0.51). Judges
  mostly collapse "partially supports" into full or none.

No judge is reliable enough to be the only check. That is why the combined
score is the lower of match score and support score, and a judge error becomes
`null`, never a pass.

### What this does and does not measure

ALCE pairs a sentence with a whole retrieved passage, not with a
model-selected verbatim quote. So this benchmarks the **judge in isolation**,
under a harder condition than deployment: the judge is handed the passage with
no indication of which span is supposed to matter. The quote-matching step is
covered by the matcher benchmark, and the two are deliberately never averaged
together.

## Endpoints, keys and budget

Any OpenAI-compatible endpoint works. Put the key in `.env` (git-ignored) and
run with Node's own loader, so no dependency is needed:

```bash
cp .env.example .env    # fill in VERIQUOTE_JUDGE_API_KEY and VERIQUOTE_BASE_URL
node --env-file=.env bench/probe.mjs
```

`probe.mjs` is a quick triage before spending a run: for every model it checks
that it responds, honours `response_format: {type: "json_object"}` (needed for
a judge) and emits a parseable EVI1 appendix on a one-paragraph case.
`GET /models` alone is not enough: endpoints list models as ready that fail
every request.

`bench/lib/http.mjs` reads `x-ratelimit-*` headers and paces itself, and
refuses to start a run that cannot fit in the remaining budget. `--wait` lets a
run sit out a short window instead. Transient `5xx` are retried and counted as
`apiFailures`, separately from the numbers being measured. Cost per model:
18 requests for the protocol benchmark, 20 for a 240-item judge run.

## Corpus

`corpus/` holds five English Wikipedia extracts, pinned by revision id so runs
stay reproducible, licensed [CC BY-SA
4.0](https://creativecommons.org/licenses/by-sa/4.0/):
Antimicrobial resistance (rev 1374703868), Insulin (1373900133), Ozone layer
(1371936690), Photosynthesis (1371284103), Vitamin D (1375852830).

## Reproducibility

Matcher and protocol runs are seeded (`20260921`) and the judge sample is drawn
with the same seed, so a re-run selects the same items. The judge itself runs at
temperature 0 with a seed where the provider supports it; hosted APIs are
best-effort deterministic, so judge numbers will move slightly between runs.
Every result file records the model, seed, and a hash of the input data.

[^alce]: Gao, T., Yen, H., Yu, J., & Chen, D. (2023). Enabling large language models to generate text with citations. In *Proceedings of the 2023 Conference on Empirical Methods in Natural Language Processing* (pp. 6465–6488). Association for Computational Linguistics. https://doi.org/10.18653/v1/2023.emnlp-main.398

[^true]: Honovich, O., Aharoni, R., Herzig, J., Taitelbaum, H., Kukliansy, D., Cohen, V., Scialom, T., Szpektor, I., Hassidim, A., & Matias, Y. (2022). TRUE: Re-evaluating factual consistency evaluation. In *Proceedings of the 2022 Conference of the North American Chapter of the Association for Computational Linguistics: Human Language Technologies* (pp. 3905–3920). Association for Computational Linguistics. https://doi.org/10.18653/v1/2022.naacl-main.287
