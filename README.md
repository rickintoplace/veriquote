# VeriQuote

[![npm](https://img.shields.io/npm/v/veriquote)](https://www.npmjs.com/package/veriquote)
[![DOI](https://zenodo.org/badge/1311867832.svg)](https://doi.org/10.5281/zenodo.21552379)

**Make an LLM quote its sources, then check every quote twice: is it really in
the source, and does it support the claim?**

A `[1]` after a sentence looks like evidence and usually is not checked by
anyone. In our tests a third of one capable model's "verbatim" quotes were not
in the source verbatim, another left 69% of its cited answers with at least one
citation that had nothing behind it, and a judge model happily confirmed quotes
that were invented. VeriQuote makes the answering model commit to a verbatim
quote per citation and then verifies each one — deterministically where
possible, with an LLM only where it has to. TypeScript, zero dependencies, runs in Node and the
browser.

```console
$ curl -s https://raw.githubusercontent.com/rickintoplace/veriquote/main/examples/ozone-answer.md \
    | npx veriquote check - --source https://en.wikipedia.org/wiki/Ozone_layer

4 citation(s) · 1 source(s) · judge: glm-5.3-flash

✓ c1 [1]  verbatim 1.00 · entailed 1.00
    The ozone layer absorbs 97 to 99 percent of the Sun's medium-frequency ultraviolet light.
✗ c2 [1]  verbatim 1.00 · contradicted 0.00
    It was discovered in 1913 by the British meteorologist G. M. B. Dobson.
    Quote credits Fabry and Buisson, not Dobson
✗ c3 [1]  fuzzy 0.48 · contradicted 0.00
    Under the Montreal Protocol, all CFC production was banned immediately in 1987.
    Context says production capped at 1986 levels, not banned; Quote absent from context; appears fabricated
✗ c4 [1]  quote not in source (best 0.31) · entailed 0.90
    The treaty limited CFC production to the levels of 1986.
    the quoted text does not occur in the source
! uncited  Ozone depletion has since been fully reversed in every region of the atmosphere.

REVISE — 3 failed citation(s), 1 uncited sentence(s)
```

`c2` quotes the source correctly and still gets the facts wrong — only the judge
sees that. `c4` invents its quote and the judge calls it supported — only the
matcher sees that. Without an API key the CLI checks the quotes only; set
`VERIQUOTE_JUDGE_API_KEY` and `VERIQUOTE_JUDGE_MODEL` (any OpenAI-compatible
endpoint) for the judge.

**Try both checks in the browser:** [`demo/index.html`](demo/index.html) — eight
examples with recorded judge verdicts, or your own text with your own key.

## How it works

The answering model gets `veriquote prompt` (or `buildCitationInstructions()`)
in its system prompt. Every cited sentence ends with source and claim markers,
and the answer ends with a plain-text quote appendix:

```
Vitamin D supplementation reduced fall risk in older adults.[1]{c1}
It also improved bone mineral density.[2][3]{c2}

EVI1
c1|1|"supplementation reduced the rate of falls by 19%"
c2|2|"bone mineral density increased significantly"
c2|3|"BMD improved with \"high-dose\" regimens"
END_EVI1
```

Plain text rather than JSON, so it survives streaming, markdown renderers and
weak models, and the `[n]` markers stay readable if nothing checks them. Then,
per citation:

1. **Parse** — every cited claim must carry a quote; missing ones are reported.
2. **Match** — is the quote in the source? Deterministic fuzzy matching that
   tolerates whitespace, typography, OCR noise and elision, with offsets.
3. **Judge** — does the quote support the claim? An LLM at temperature 0 picks
   `entailed`, `partially_entailed`, `overstated`, `insufficient` or
   `contradicted`, with a support score.

The combined score is `min(match, support)`: no judge error can raise a
citation above what the matcher found, and a judge failure is reported, never
counted as support. The prompt is a transparency mechanism, not a cure —
quoting does not make a model hallucinate less, it makes every claim checkable.

## Does it actually work?

Three benchmarks, kept separate on purpose — one blended number for a two-stage
pipeline would hide the failures it exists to separate. Everything is in
[`bench/`](bench), including how to reproduce it.

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

## Use from an agent

An agent that reads sources and writes conclusions is exactly the case this was
built for. **[`verify-citations`](integrations/verify-citations)** is an
[Agent Skill](integrations/verify-citations/SKILL.md) that has the agent write
its sourced answer in the checkable format and run `veriquote check` on it
before presenting it. The CLI fetches every cited URL itself, so an agent cannot
pass with its own (truncated, misremembered) copy of a page, and the exit code
lets it branch without parsing anything:

```
exit 0  verdict "pass"    every cited claim is grounded     -> present the answer
exit 2  verdict "revise"  problems[] + instructionsForModel -> fix and re-check
exit 1  bad input or unreachable source -> do NOT claim the answer was verified
```

It works in any host that reads Agent Skills, such as Claude Code, and in
anything that can run a shell command.

## Use as a library

```bash
npm install veriquote
```

```ts
import { buildCitationInstructions } from 'veriquote';

const systemPrompt = `${yourAssistantPrompt}\n\n${buildCitationInstructions()}`;
// Give the sources to the model as numbered blocks [1], [2], …
```


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

`report.cleanText` is the answer without `{cX}` markers, ready to render. Show
each citation's match score, judge class and combined score next to its
footnote, so a reader can see which sentence is load-bearing without opening a
source.

| Export | Purpose |
| --- | --- |
| `buildCitationInstructions(options?)` | Prompt block for the answering model (budgets and quote-length rules configurable). |
| `verifyAnswer(options)` | Full pipeline: parse → match → judge → report. |
| `parseAnswer(answer)` | Parse claims, evidence, and protocol warnings without verifying. |
| `parseEvi1Appendix` / `stripEvi1Appendix` / `serializeEvi1Appendix` | Low-level EVI1 handling. |
| `matchQuoteAgainstSource(quote, source, options?)` | Deterministic quote matching on its own. |
| `ChatCompletionsJudge` | Entailment judge for any OpenAI-compatible API. |
| `EntailmentJudge` (interface) | Bring your own judge (local NLI model, other provider). |
| `gateReport(report, answer)` | Pass/revise verdict, problem list, uncited sentences, correction prompt. |
| `fetchSource(url)` / `htmlToText(html)` | Fetch a source independently of the model and extract its text. |

All inputs and outputs are plain, serializable data — see
[`src/types.ts`](src/types.ts) and, for scoring and thresholds,
[`docs/DESIGN.md`](docs/DESIGN.md).

| Class | Confidence band | Meaning |
| --- | --- | --- |
| `entailed` | 0.9–1.0 | Claim fully covered by the quote. |
| `partially_entailed` | 0.5–0.8 | Core message supported, details missing. |
| `overstated` | 0.3–0.6 | Claim stronger/more general than the evidence. |
| `insufficient` | 0.1–0.4 | Related but does not confirm the claim. |
| `contradicted` | 0.0 | Evidence says the opposite. |
| `error` | — | Judge unavailable for this item (never silently dropped). |

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

Closest in spirit is the concurrent academic work by Zhang et al.,
[“Verifiable by Construction”](https://arxiv.org/abs/2609.15964) (Johns Hopkins,
2026), which evaluates the same design — inline verbatim quotes, tiered
verbatim matching, an LLM judge — on clinical guidelines. VeriQuote is the
deployable library, CLI and agent skill, with the judge measured against human
labels.

## Security

- **Keep your key on the server.** `ChatCompletionsJudge` needs an API key; in
  your own app, call `verifyAnswer` from a backend. (The demo runs the judge in
  the browser only with a key the visitor enters.)
- **Source text is untrusted.** Judge inputs are length-capped, stripped of
  control characters and HTML, and pinned as data in the prompt. Output is
  validated against a closed vocabulary; unknown classes, out-of-range scores
  and invented item IDs are rejected. Nothing is ever `eval`ed.

## Reproducibility

The matcher is pure: same inputs, same score. The judge runs at temperature 0
(pass `seed` where the provider supports it), but hosted models are only
best-effort deterministic; pin the model version, or put a self-hosted model
behind the `EntailmentJudge` interface.

## Citing

If you use VeriQuote in academic work, please cite the Zenodo record (see
`CITATION.cff`).

## License

[MIT](LICENSE)
