# VeriQuote benchmarks

Three separate questions, three separate benchmarks. Keeping them apart is the
point: a single blended "accuracy" number for a two-stage pipeline would hide
exactly the failure modes the pipeline exists to separate.

| benchmark | question | needs | labels |
| --- | --- | --- | --- |
| [`matcher/`](matcher) | Does deterministic matching accept faithful quotes and reject absent ones? | nothing | none — ground truth by construction |
| [`protocol/`](protocol) | Does a given answering model actually emit the EVI1 appendix? | an API key | none — compliance is decided by the parser |
| [`judge/`](judge) | Does the entailment judge agree with human annotators? | an API key | ALCE human annotations (MIT) |

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

- **faithful** — the quote still reports the source honestly but the string
  differs: whitespace damage, smart quotes, case, OCR-style typos, scholarly
  elision, PDF hyphenation. The matcher **must** accept these; a miss here is a
  false accusation against an honest answer.
- **manipulated** — near-verbatim, but the meaning was changed: a figure
  swapped, a negation inserted, a hedge strengthened, two distant fragments
  spliced together. The matcher is **not** expected to catch these. They are
  measured to size the blind spot the entailment judge has to cover.
- **absent** — the text is not in the source: a real quote attributed to the
  wrong document, or an honest paraphrase instead of a quote. The matcher
  **must** reject these; an acceptance is a missed fabrication.

Operators are also tagged `natural` or `adversarial`. Headline numbers cover
natural operators only, and adversarial ones are reported in their own row —
otherwise the score says more about how many attacks were invented than about
the matcher.

Current results: [`results/matcher.json`](results/matcher.json).

## 2. Protocol compliance

```bash
node --env-file=.env bench/protocol/run.mjs \
  --models qwen3.8-27b,glm-5.3-flash,mistral-medium-3.5-128b \
  --json bench/results/protocol.json
```

Eighteen tasks over the same pinned corpus, three of them deliberately not
answerable from the sources. Each model gets `buildCitationInstructions()` in
its system prompt; `parseAnswer()` then decides mechanically whether it
complied. Nothing is labelled by hand.

Reported per model:

- **appendix** — emitted a parseable `EVI1` block at all.
- **complete** — every `(claim, source)` pair it cited also carries an evidence
  line. This is the number that matters: a model that prints `[n]` markers and
  skips the appendix produces an answer that *looks* well-cited and carries no
  verifiable evidence whatsoever.
- **coverage** — share of cited pairs that carry a quote.
- **verbatim** — share of supplied quotes literally present in the source.
- **restraint** — on the unanswerable tasks, did it cite nothing rather than
  manufacture evidence?

Cost is a few cents per model for a full pass.

### Results (2026-09-21)

| model | n | api fails | appendix | complete | coverage | verbatim | warning-free | restraint |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| openai-gpt-oss-120b | 15 | 3 | 100.0% | 30.8% | 100.0% | 93.3% | 23.1% | 100.0% |
| mistral-medium-3.5-128b | 16 | 2 | 100.0% | 92.3% | 100.0% | 66.5% | 92.3% | 100.0% |
| gemma-4-31b-it | 18 | 0 | 86.7% | 86.7% | 86.7% | 100.0% | 86.7% | 100.0% |
| meta-llama-3.1-8b-instruct | 17 | 1 | 71.4% | 50.0% | 70.0% | 62.8% | 14.3% | 100.0% |

Full output: [`results/protocol.json`](results/protocol.json).

The two large models fail in opposite directions, and both failures are
invisible to a reader:

- **`gpt-oss-120b` always emits an appendix and is almost never complete.**
  Only 30.8% of its answers give every cited pair an evidence line, and 23.1%
  parse without a warning. Its quotes are good when it supplies them (93.3%
  verbatim) — it just does not supply them for most of what it cites.
- **`mistral-medium` is nearly always complete and its quotes are often not
  quotes.** 92.3% complete, but only 66.5% of the strings it puts in the quote
  slot are literally in the source: it paraphrased where the protocol demands
  verbatim text. This is the failure the matcher exists to catch, occurring at
  a third of all citations from a capable model.
- **`gemma-4-31b` is the most honest of the four**: it skips the appendix more
  often (86.7%), but everything it does quote is verbatim.
- **`llama-3.1-8b` is not usable with this protocol** — 71.4% appendix rate,
  14.3% warning-free.

All four cited nothing on all three unanswerable tasks, which is the one thing
that went uniformly right.

Caveats: `n` varies because the endpoint dropped requests (`api fails`), and
this is one pass of 18 tasks per model — enough to separate "usable" from "not
usable", not enough to rank two close models. Raise `--repeats` for that.

## 3. Judge

```bash
node bench/judge/prepare-alce.mjs
node --env-file=.env bench/judge/run.mjs \
  --model glm-5.3-flash --limit 240 \
  --json bench/results/judge-glm-5.3-flash.json
```

`prepare-alce.mjs` downloads the human annotations from
[ALCE](https://github.com/princeton-nlp/ALCE) (Gao et al., EMNLP 2023, MIT
licensed) and converts them to JSONL: **2,896 (claim, cited document) pairs**
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
itself reports, so the number is directly comparable to the paper's TRUE-NLI
baseline (85.1% citation-recall accuracy, 77.6% citation-precision accuracy).

One number is called out on its own: **false green** — how often the judge
calls a claim fully supported when annotators said the source supports nothing.
A wrong citation shown in green is worse than one flagged for review, so that
rate matters more than the average.

### Results (2026-09-21)

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
| *TRUE-NLI (T5-11B), ALCE's own metric* | | *77.6%* | | | | | |

Full output per model: [`results/judge-*.json`](results/). Plotted with 95% intervals in [`figures/`](figures).

What this says:

- **General-purpose open models match a specialised NLI model** on ALCE's own
  binary question, and the best one reaches κ 0.53 against the annotators —
  the same agreement ALCE reports for its automatic metric (0.525). With about
  240 pairs per run the binary numbers carry roughly ±5 points of sampling
  error, so read the top four as level with TRUE-NLI, not as beating it.
- **False green** — an unsupported citation shown as fully supported — ranges
  from 16% to 25%. With 56 unsupported pairs per run the 95% intervals overlap,
  so neighbouring models are not separated; a larger `--limit` would settle the
  ranking. Size is not the predictor: `qwen3.6-35b-a3b`, with 3B active
  parameters, lands ahead of the 120B `gpt-oss`.
- **`partial` is the weak class for every model** (F1 0.28–0.51). Judges
  mostly collapse "partially supports" into full or none.

No judge is reliable enough to be the only check. That is why the combined
score is `min(textMatch, judgeConfidence)` and a judge error becomes `null`,
never a pass.

### What this does and does not measure

ALCE pairs a sentence with a whole retrieved passage, not with a
model-selected verbatim quote. So this benchmarks the **judge in isolation**,
under a harder condition than deployment: the judge is handed the passage with
no indication of which span is supposed to matter. The quote-matching step is
covered by the matcher benchmark, and the two are deliberately never averaged
together.

## Endpoints, keys and budget

Any OpenAI-compatible endpoint works. Put the key in `.env` (git-ignored) and
run with Node's own loader — no dependency needed:

```bash
cp .env.example .env    # fill in VERIQUOTE_JUDGE_API_KEY and VERIQUOTE_BASE_URL
node --env-file=.env bench/probe.mjs
```

`probe.mjs` is a quick triage before spending a run: for every model it checks
that it responds, honours `response_format: {type: "json_object"}` (needed for
a judge) and emits a parseable EVI1 appendix on a one-paragraph case.
`GET /models` alone is not enough — endpoints list models as ready that fail
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
