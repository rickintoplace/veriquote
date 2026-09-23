# VeriQuote benchmarks

Three separate questions, three separate benchmarks. Keeping them apart is the
point: a single blended "accuracy" number for a two-stage pipeline would hide
exactly the failure modes the pipeline exists to separate.

| benchmark | question | needs | labels |
| --- | --- | --- | --- |
| [`matcher/`](matcher) | Does deterministic matching accept faithful quotes and reject absent ones? | nothing | none; the right answer is known by construction |
| [`protocol/`](protocol) | Does a given answering model actually emit the EVI1 appendix? | an API key | none; the parser decides compliance |
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
  --json bench/results/protocol.json
```

Eighteen tasks over the same pinned corpus, three of them deliberately not
answerable from the sources. Each model gets `buildCitationInstructions()` in
its system prompt; `parseAnswer()` then decides mechanically whether it
complied. Nothing is labelled by hand, and every raw answer is kept in
[`results/protocol-answers.jsonl`](results/protocol-answers.jsonl) with the
provider's finish reason, so each number can be checked against the text.

Reported per model:

- **complete**: every `(claim, source)` pair it cited also carries a quote.
  The number that matters: a model that prints `[n]` markers and skips the
  appendix produces an answer that *looks* well-cited and carries no
  verifiable evidence.
- **verbatim**: share of supplied quotes literally present in the source.
- **appendix**, **coverage**, **warning-free**: finer grades of the same.
- **cut off**: the provider stopped the answer at its token limit, which would
  remove the appendix; counted separately so it is not blamed on the model.
- **bad cites, unanswerable**: on a question the sources cannot answer, a
  citation without a real quote behind it. Declining while quoting related
  context is not counted.

### Results (2026-09-22, 2 runs per task)

| model | n | api fails | cut off | appendix | complete | coverage | verbatim | warning-free | bad cites, unanswerable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| qwen3.6-35b-a3b | 36 | 0 | 0.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% |
| qwen3.5-397b-a17b | 24 | 12 | 0.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% |
| deepseek-v4-flash-0731 | 36 | 0 | 0.0% | 100.0% | 100.0% | 100.0% | 99.2% | 93.3% | 0.0% |
| glm-5.3-flash | 35 | 1 | 0.0% | 96.6% | 96.6% | 96.6% | 99.6% | 96.6% | 0.0% |
| gemma-4-31b-it | 36 | 0 | 0.0% | 80.0% | 80.0% | 80.0% | 96.6% | 80.0% | 0.0% |
| mistral-medium-3.5-128b | 36 | 0 | 0.0% | 96.7% | 93.3% | 100.0% | 81.0% | 96.7% | 0.0% |
| openai-gpt-oss-120b | 36 | 0 | 0.0% | 96.7% | 33.3% | 100.0% | 91.1% | 33.3% | 0.0% |
| meta-llama-3.1-8b-instruct | 36 | 0 | 0.0% | 66.7% | 43.3% | 76.7% | 50.3% | 20.0% | 0.0% |

- **The open models recommended here comply almost perfectly.**
  `qwen3.6-35b-a3b` is complete and verbatim on every answer; `deepseek-v4-flash`,
  `glm-5.3-flash` and `qwen3.5-397b` miss at most one quote or one appendix.
- **`gpt-oss-120b` almost always prints an appendix and is rarely complete**:
  only a third of its answers give every cited pair a quote.
- **`mistral-medium` is nearly always complete, but only 81% of its quotes are
  exact copies.** The rest mostly join passages with "..." or change a few
  words; the matcher finds all of them, at a lower score.
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

### Results (2026-09-21 and 2026-09-22)

Five open-weight models, the same 240 pairs (seed `20260921`), temperature 0,
the shipped judge prompt. Judge errors are reported, not dropped; they are
excluded from the scores.

| judge model | false green ↓ | binary agreement | 3-class acc. | macro-F1 | κ | `partial` F1 | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `glm-5.3-flash` | **16.1%** | **80.3%** | **71.5%** | **0.668** | **0.529** | **0.509** | 1 |
| `qwen3.5-397b-a17b` | 20.8% | 79.7% | 69.6% | 0.622 | 0.483 | 0.414 | 13 |
| `qwen3.6-35b-a3b` | 18.2% | 78.1% | 67.1% | 0.605 | 0.454 | 0.396 | 3 |
| `deepseek-v4-flash` | 18.2% | 78.7% | 66.5% | 0.570 | 0.435 | 0.282 | 1 |
| `gpt-oss-120b` | 25.0% | 76.7% | 64.2% | 0.551 | 0.394 | 0.306 | 8 |
| `qwen3.5-397b-a17b`, no reasoning | 21.4% | 77.7% | 64.7% | 0.554 | 0.410 | 0.286 | 2 |
| `qwen3.6-35b-a3b`, no reasoning | 21.4% | 77.3% | 64.3% | 0.520 | 0.397 | 0.164 | 2 |
| `glm-5.3-flash`, no reasoning | 24.4% | 74.0% | 63.2% | 0.549 | 0.373 | 0.304 | 36 |
| *TRUE (T5-11B), ALCE's automatic metric* | | *77.6%* | | | | | |

Full output per model: [`results/judge-*.json`](results/). Plotted with 95% intervals in [`figures/`](figures).

What this says:

- **General-purpose open models match a specialised NLI model** on ALCE's own
  binary question. The best one reaches κ 0.53 on the three-way labels; ALCE
  reports κ 0.525 between its automatic metric and the annotators on citation
  precision. With about 240 pairs per run the binary numbers carry roughly ±5
  points of sampling error, so read the top four as level with TRUE, not as
  beating it.
- **False green** (an unsupported citation shown as fully supported) ranges
  from 16% to 25%. With 56 unsupported pairs per run the 95% intervals overlap,
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
