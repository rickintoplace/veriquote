# VeriQuote

[![DOI](https://zenodo.org/badge/1311867832.svg)](https://doi.org/10.5281/zenodo.21552379)

**Deterministic + semantic verification of quote-grounded LLM citations.**

VeriQuote makes source-grounded assistant answers *auditable*. Instead of
trusting that a `[1]` citation means anything, the answering model must attach
a **verbatim quote** for every cited claim, and VeriQuote then checks per
claim whether:

1. the quote **actually occurs in the source** (deterministic fuzzy text
   matching with a percent score), and
2. the quote **actually supports the claim** (a small, temperature-0 LLM judge
   classifying entailment strength).

The result is a transparent, per-citation report telling users exactly which
statements are verbatim-backed and supported, which are overstated, and which
are unsupported or confabulated.

**Try the matcher in your browser** — [`demo/index.html`](demo/index.html) is a
single self-contained page: open the file, or host it anywhere. No API key, no
server, no build step, nothing leaves the page.

- **Zero runtime dependencies.** Runs in Node ≥ 18, browsers, and edge runtimes.
- **Deterministic by construction.** The text matcher is pure; the judge runs
  at temperature 0 with a closed class vocabulary and strict output validation.
- **Model-agnostic.** Works with any answering model and any OpenAI-compatible
  chat-completions endpoint for the judge (OpenAI, OpenRouter, Azure, local
  gateways) or bring your own `EntailmentJudge` (e.g. a local NLI model).

## How it works

```
                        ┌───────────────────────────┐
  numbered sources ───► │  Answering LLM            │
  + citation prompt     │  (any model)              │
                        └────────────┬──────────────┘
                                     │  answer body with [n]{cX} markers
                                     │  + EVI1 quote appendix
                                     ▼
                        ┌───────────────────────────┐
                        │ 1. parseAnswer()          │  claims, quotes, protocol
                        │    (deterministic)        │  completeness warnings
                        └────────────┬──────────────┘
                                     ▼
                        ┌───────────────────────────┐
                        │ 2. Quote ↔ source match   │  exact / normalized /
                        │    (deterministic, fuzzy) │  fuzzy %, offsets
                        └────────────┬──────────────┘
                                     ▼
                        ┌───────────────────────────┐
                        │ 3. Entailment judge       │  entailed / partially /
                        │    (LLM, temp 0, optional)│  overstated / insufficient
                        └────────────┬──────────────┘  / contradicted + conf.
                                     ▼
                        ┌───────────────────────────┐
                        │ 4. VerificationReport     │  per-citation scores +
                        │    (transparency for user)│  answer-level summary
                        └───────────────────────────┘
```

### The EVI1 protocol

The answering model is instructed (via `buildCitationInstructions()`) to end
every cited sentence with citation markers and a claim marker, and to append a
machine-readable quote appendix:

```
Vitamin D supplementation reduced fall risk in older adults.[1]{c1}
It also improved bone mineral density.[2][3]{c2}

EVI1
c1|1|"supplementation reduced the rate of falls by 19%"
c2|2|"bone mineral density increased significantly"
c2|3|"BMD improved with \"high-dose\" regimens"
END_EVI1
```

The protocol is intentionally plain text (not JSON): it survives streaming,
markdown renderers, and weak models. And `[n]` citations remain human-readable
even if a client ignores VeriQuote entirely.

### Why two checks?

The two checks fail independently, and both failure modes occur in practice:

- A quote can be **verbatim yet irrelevant**: the model copied real text that
  doesn't support its claim (scope drift, outcome switching, overstatement).
  Text match passes; the entailment judge catches it.
- A quote can be **paraphrased or fabricated**: the claim may even be true,
  but the "quote" is not in the source. The entailment judge might wave it
  through; the deterministic matcher rejects it outright.

The combined per-citation score is conservative:
`min(textMatchScore, judgeConfidence)`.

**Read the text-match score correctly.** It measures *fidelity of copying*, not
truth, and the two run in opposite directions. Change one digit in a real quote
and it still scores 0.968; write an honest paraphrase of the same passage and it
scores 0.306. A high score means the characters were copied faithfully — it says
nothing about whether the sentence built on them is true. That is not a defect to
be tuned away: it is why the entailment judge is not optional, and the numbers
behind it are in [`bench/`](bench).

### What the prompt does not do

The EVI1 prompt is a **transparency** mechanism, not a hallucination mitigation.
Asking a model for verbatim quotes does not measurably reduce how often it makes
things up; it changes what happens afterwards, because now every claim carries
something that can be mechanically checked. That is the whole design, and it is
why the verification step is not optional: run the prompt without the verifier
and you have added ceremony, not safety.

Protocol compliance also varies by answering model and by the prompt you wrap
around it. Some models print `[n]` markers but omit the evidence appendix
entirely, which looks perfectly well-cited to anyone reading the answer. Check
the completeness warnings from `parseAnswer()`, and measure a new answering
model with [`bench/protocol`](bench) before relying on it.

## Does it actually work?

Three benchmarks, kept separate on purpose — a single blended number for a
two-stage pipeline would hide the failure modes the pipeline exists to
separate. Everything is in [`bench/`](bench), including how to reproduce it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/tango-dark.svg">
  <img alt="Matcher catches 100% of quotes that are not in the source and 0% of real quotes attached to unsupported claims; the judge catches 84% of the latter and cannot see the former; together they cover both." src="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/tango-light.svg">
</picture>

The two checks are blind in opposite places. The matcher cannot tell whether a
real quote supports the claim; the judge only compares claim and quote, so a
fabricated quote that fits the claim sails through it — in
[`examples/ozone-answer.md`](examples/ozone-answer.md) `deepseek-v4-flash` rates an
invented quote "entailed 1.00", and only the matcher notices it is not in the
source. That is why the combined score is `min(textMatchScore, judgeConfidence)`.

### Matcher

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/matcher-dark.svg">
  <img alt="Matcher score ranges per mutation: faithful quotes score 0.66 to 1.0, quotes not in the source 0.14 to 0.40, meaning-changed quotes score high by design." src="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/matcher-light.svg">
</picture>

2,061 quotes, no API key, no labels — ground truth by construction;
`npm run bench:matcher` reproduces it in about two seconds. Faithfully copied
quotes never score below 0.660, missing ones never above 0.396, and the default
threshold of 0.4 sits in that gap. The orange rows are the point, not an
embarrassment: a quote whose meaning was changed is still near-verbatim, and
catching it is the judge's job. Two honest limits: invented prose built from the
source's own words (adversarial) scores high, and so can hand-written
fabrications that reuse the source's vocabulary (0.48 in the example above) —
the CLI therefore fails any citation below 0.5 and leaves the rest to the judge.

### Judge

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/judges-dark.svg">
  <img alt="Five open judge models against ALCE human labels: false green from 16.1% (glm-5.3-flash) to 25.0% (gpt-oss-120b); binary agreement 76.7% to 80.3%, around the TRUE-NLI baseline of 77.6%." src="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/judges-light.svg">
</picture>

Agreement with the human annotators of
[ALCE](https://github.com/princeton-nlp/ALCE) (Gao et al., EMNLP 2023, MIT),
class mapping fixed before any model ran. Open general-purpose models are level
with a specialised 11B NLI model on ALCE's binary question, and the best reaches
Cohen's κ 0.53 — the agreement ALCE reports for its own automatic metric.
**Read the left panel before trusting any of this:** even the best judge calls
one unsupported citation in six "fully supported", which is why no judge should
be the only check. The intervals are wide (56 unsupported pairs per run), so
the ranking between neighbouring models is not settled; size is not what
decides it — a 3B-active MoE lands ahead of a 120B model.

### Does the answering model play along?

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/protocol-dark.svg">
  <img alt="Protocol compliance: gpt-oss-120b complete in 30.8% of answers, mistral-medium quotes verbatim in 66.5% of citations; gemma-4-31b and llama-3.1-8b shown for comparison." src="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/protocol-light.svg">
</picture>

Decided mechanically by `parseAnswer()` over 18 tasks, three of which the
sources deliberately cannot answer. Two ways to fail, neither visible to a
reader: `gpt-oss-120b` always prints an appendix, but only 30.8% of its answers
give every citation a quote — the rest are footnotes with nothing behind them.
`mistral-medium` is almost always complete, yet a third of its "quotes" are not
in the source: it paraphrased into the quote slot. Both answers look impeccably
cited. All four models cited nothing on the three unanswerable questions.

<details>
<summary>The numbers behind the figures</summary>

| judge model | false green ↓ | binary agreement | Cohen's κ |
| --- | ---: | ---: | ---: |
| `glm-5.3-flash` | 16.1% | 80.3% | 0.529 |
| `qwen3.5-397b-a17b` | 20.8% | 79.7% | 0.483 |
| `qwen3.6-35b-a3b` | 18.2% | 78.1% | 0.454 |
| `deepseek-v4-flash` | 18.2% | 78.7% | 0.435 |
| `gpt-oss-120b` | 25.0% | 76.7% | 0.394 |
| ALCE's TRUE-NLI (T5-11B) | | 77.6% | |

| quote family | n | median score | accepted at 0.4 |
| --- | ---: | ---: | ---: |
| faithful but reformatted | 1,121 | 1.000 | 100.0% |
| near-verbatim, meaning changed | 586 | 0.932 | 100.0% |
| absent from the source | 187 | 0.249 | 0.0% |

| answering model | appendix | complete | verbatim | warning-free |
| --- | ---: | ---: | ---: | ---: |
| gpt-oss-120b | 100% | 30.8% | 93.3% | 23.1% |
| mistral-medium-3.5-128b | 100% | 92.3% | 66.5% | 92.3% |
| gemma-4-31b-it | 86.7% | 86.7% | 100% | 86.7% |
| llama-3.1-8b-instruct | 71.4% | 50.0% | 62.8% | 14.3% |

Figures are rendered from `bench/results/*.json` by
[`bench/figures/render.mjs`](bench/figures/render.mjs).
</details>

## How this differs from the alternatives

| | verbatim quote checked | claim↔evidence checked | model-agnostic | runtime |
| --- | --- | --- | --- | --- |
| **VeriQuote** | yes, deterministic | yes, pluggable judge | yes | TS, zero deps, browser/edge |
| [Anthropic Citations API](https://platform.claude.com/docs/en/build-with-claude/citations) | n/a — spans are extracted, so they are real by construction | no | Claude only | hosted |
| [LettuceDetect](https://github.com/KRLabsOrg/LettuceDetect) | no — no quote protocol | yes, span-level model | yes | Python + model weights |
| [RAGAS](https://github.com/explodinggradients/ragas) and eval frameworks | no | yes, as an offline metric | yes | Python, offline eval |

**Use the Citations API instead** if you are on Claude and only need to know
that a span is real: it guarantees that by construction, which is stronger than
any matcher. It does not tell you whether the span supports the sentence built
on it — for that, pair it with this library's judge and skip the matcher.

**Use LettuceDetect instead** if you want unsupported spans flagged in an
answer that has no citation protocol at all, and you are happy running a model
in Python. It solves the post-hoc problem; VeriQuote changes what the answering
model commits to in the first place.

VeriQuote's own niche is narrow and worth stating plainly: you want the
answering model pinned to a quote *before* it generates, you want the
deterministic half of the check to run anywhere including a browser with no
dependencies, and you want per-claim numbers to put in front of a reader rather
than an aggregate score for a dashboard.

## Command line

```bash
npx veriquote prompt                  # the rules to give the answering model
npx veriquote check answer.md \
  --source https://en.wikipedia.org/wiki/Ozone_layer --source notes.txt
```

Sources are numbered in the order given. URLs are fetched by VeriQuote itself,
so the check never depends on the answering model's copy of a page. Without
configuration only the quotes are checked; set `VERIQUOTE_JUDGE_API_KEY` and
`VERIQUOTE_JUDGE_MODEL` (any OpenAI-compatible endpoint) to also check that each
quote supports its claim. `--json` gives machine-readable output; the exit
status is `0` pass, `2` revise, `1` error. Try it on
[`examples/ozone-answer.md`](examples/ozone-answer.md), which contains one
correct citation and three different ways of getting it wrong.

## Installation

```bash
npm install veriquote
```

## Quickstart

### 1. Prompt the answering model

```ts
import { buildCitationInstructions } from 'veriquote';

const systemPrompt = `${yourAssistantPrompt}\n\n${buildCitationInstructions()}`;
// Provide sources as numbered blocks [1], [2], ... in the user/context prompt.
```

### 2. Verify the raw answer

```ts
import { ChatCompletionsJudge, verifyAnswer } from 'veriquote';

const judge = new ChatCompletionsJudge({
  baseUrl: 'https://openrouter.ai/api/v1',   // any OpenAI-compatible endpoint
  apiKey: process.env.OPENROUTER_API_KEY,    // server-side only!
  model: 'your-judge-model',                 // pick one with bench/judge
});

const report = await verifyAnswer({
  answer: rawModelOutput,          // including the EVI1 appendix
  sources: [
    { title: 'Trial A', url: 'https://…', text: extractedFullText1 },
    { title: 'Trial B', url: 'https://…', text: extractedFullText2 },
  ],
  judge,                           // omit for text-match-only verification
});

console.log(report.summary);
// { citationCount: 2, verbatimRate: 1, entailedRate: 0.5,
//   meanScore: 0.675, minScore: 0.4 }

for (const c of report.citations) {
  console.log(c.claimId, c.sourceIndex, c.textMatch.method,
              c.textMatch.score, c.entailment?.class, c.score);
}
```

`report.cleanText` is the answer with all `{cX}` markers removed, ready to
render (the `[n]` markers remain as human-readable citations).

### 3. Show it to the user

Render each citation's `textMatch.score` (percent), `entailment.class`, and
combined `score` next to the footnote — e.g. colour each footnote by its worst
score and put both check results in the tooltip. The whole point is that the
reader can see which sentence is load-bearing and which is not, without
opening a single source.

## API overview

| Export | Purpose |
| --- | --- |
| `buildCitationInstructions(options?)` | Prompt block for the answering model (budgets and quote-length rules configurable). |
| `verifyAnswer(options)` | Full pipeline: parse → match → judge → report. |
| `parseAnswer(answer)` | Parse claims, evidence, and protocol warnings without verifying. |
| `parseEvi1Appendix` / `stripEvi1Appendix` / `serializeEvi1Appendix` | Low-level EVI1 handling. |
| `matchQuoteAgainstSource(quote, source, options?)` | Deterministic quote matching on its own. |
| `ChatCompletionsJudge` | Entailment judge for any OpenAI-compatible API. |
| `EntailmentJudge` (interface) | Bring your own judge (local NLI model, other provider). |

All inputs and outputs are plain, serializable data — see
[`src/types.ts`](src/types.ts) for the complete, documented data model and
[`docs/DESIGN.md`](docs/DESIGN.md) for the method description (scoring,
thresholds, and design rationale).

### Entailment classes

| Class | Confidence band | Meaning |
| --- | --- | --- |
| `entailed` | 0.9–1.0 | Claim fully covered by the quote. |
| `partially_entailed` | 0.5–0.8 | Core message supported, details missing. |
| `overstated` | 0.3–0.6 | Claim stronger/more general than the evidence. |
| `insufficient` | 0.1–0.4 | Related but does not confirm the claim. |
| `contradicted` | 0.0 | Evidence says the opposite. |
| `error` | — | Judge unavailable for this item (never silently dropped). |

## Security

- **Keep the judge server-side.** `ChatCompletionsJudge` needs an API key;
  never instantiate it in a browser. Expose a thin authenticated endpoint that
  calls `verifyAnswer` instead.
- **Prompt-injection hardening.** Source text is untrusted. Judge inputs are
  length-capped, stripped of control characters and HTML, and the judge prompt
  pins them as data ("never instructions"). Output is validated against a
  closed vocabulary; unknown classes, out-of-range confidences, and
  hallucinated item IDs are rejected.
- **No dynamic evaluation.** Tolerant JSON recovery is a string-aware scanner;
  nothing is ever `eval`ed.
- **Failure transparency.** Judge failures degrade to `class: "error"` with a
  `null` score — they are reported, never counted as "supported".

## Reproducibility

For a fixed answer, fixed sources, and a fixed judge model, results are
reproducible: the matcher is pure, and the judge runs at temperature 0 (pass
`seed` for providers that support it). Note that hosted LLM APIs are
best-effort deterministic; for strict reproducibility, pin the model version
or use a self-hosted judge behind the `EntailmentJudge` interface.

## Use from an agent

An agent that reads sources and writes conclusions is exactly the case this was
built for: the claims are checkable, so they should be checked before the agent
hands them over — not after a human notices.

**[`verify-citations`](integrations/verify-citations)** is an
[Agent Skill](integrations/verify-citations/SKILL.md) that has the agent write
its sourced answer in the checkable format and run `veriquote check` on it
before presenting it. The CLI fetches every cited URL itself, so an agent cannot
pass the check with its own (truncated, misremembered) copy of a page. On failure
it returns a ready-to-use correction prompt, and the exit code lets the agent
branch without parsing anything:

```
exit 0  verdict "pass"    every cited claim is grounded     -> present the answer
exit 2  verdict "revise"  problems[] + instructionsForModel -> fix and re-check
exit 1  bad input or unreachable source -> do NOT claim the answer was verified
```

It works in any host that reads Agent Skills, such as Claude Code,
and in anything that can run a shell command.

## Citing

If you use VeriQuote in academic work, please cite the Zenodo record (see
`CITATION.cff`).

## License

[MIT](LICENSE)
