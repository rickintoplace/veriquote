# VeriQuote

[![npm](https://img.shields.io/npm/v/veriquote)](https://www.npmjs.com/package/veriquote)
[![DOI](https://zenodo.org/badge/1311867832.svg)](https://doi.org/10.5281/zenodo.21552379)

**Make an LLM quote its sources, then check every quote twice: is it really in
the source, and does it support the claim?**

A `[1]` after a sentence looks like evidence, but checking it means opening the
source and finding the passage. VeriQuote makes the answering model attach a
verbatim quote to every citation and then checks each quote twice: a
deterministic matcher confirms that the quote is in the source, and an LLM
judge decides whether the quote supports the claim.

Both checks are needed. Strong models copy quotes reliably: the best open
models in my tests quoted verbatim in over 99% of cases, and a recent study
measured 98% for a frontier model. But a real quote is not a supported claim;
in that study, only 37% of the model's claims were fully supported by their
quotes.[^zhang] Weaker models also leave citations without any quote, and a
judge asked whether a quote supports a claim is not built to notice that the
quote was made up. VeriQuote is written in TypeScript, has no dependencies and
runs in Node and in the browser.

**Try it in the browser:** [rickinto.place/veriquote](https://rickinto.place/veriquote)
has eight worked examples, a box for your own text, and the benchmark results as
interactive charts.

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

Look at `c2` and `c4`. The quote in `c2` is copied correctly, but the claim
names the wrong person; only the judge can see that. The quote in `c4` is made
up, and the judge still calls it supported; only the matcher can see that.
Without an API key the CLI checks the quotes alone. Set
`VERIQUOTE_JUDGE_API_KEY` and `VERIQUOTE_JUDGE_MODEL` (any OpenAI-compatible
endpoint) to add the judge.

## How it works

The answering model gets the output of `veriquote prompt` (or
`buildCitationInstructions()`) in its system prompt. Every cited sentence then
ends with source and claim markers, and the answer ends with a plain-text quote
appendix:

```
Vitamin D supplementation reduced fall risk in older adults.[1]{c1}
It also improved bone mineral density.[2][3]{c2}

EVI1
c1|1|"supplementation reduced the rate of falls by 19%"
c2|2|"bone mineral density increased significantly"
c2|3|"BMD improved with \"high-dose\" regimens"
END_EVI1
```

The format is plain text rather than JSON, so it survives streaming, Markdown
renderers and weak models, and the `[n]` markers stay readable if nothing
checks them. Each citation then goes through three steps:

1. **Parse.** Every cited claim must carry a quote. Missing quotes are reported.
2. **Match.** Is the quote in the source? Deterministic fuzzy matching that
   tolerates whitespace, typography, OCR noise and elisions, and reports where
   the quote was found.
3. **Judge.** Does the quote support the claim? An LLM at temperature 0 answers
   `entailed`, `partially_entailed`, `overstated`, `insufficient` or
   `contradicted`, with a support score.

A citation's combined score is the lower of its match score and its support
score. A judge error can therefore never lift a citation above what the matcher
found, and a failed judge call is reported as an error, never counted as
support. The quote format is not meant to make a model more accurate; it makes
every claim checkable.

## Benchmarks

There are three benchmarks, kept separate on purpose: one blended number for a
two-stage pipeline would hide exactly the failures it exists to separate.
Everything is in [`bench/`](bench), including how to reproduce it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/tango-dark.svg">
  <img alt="The matcher blocks all 187 quotes that are not in the source and none of the 586 real quotes whose meaning was changed; the judge blocks 84% of unsupported citations but does not check whether a quote exists; together they cover both kinds of failure." src="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/tango-light.svg">
</picture>

The two checks are blind in opposite places. The matcher never reads the claim,
so it cannot tell whether a real quote supports it. The judge is asked whether
the quote supports the claim, not whether the quote exists. It sees a little of
the source as context, but an invented quote that fits the claim can still pass
it: in the example above, it rates the made-up quote in `c4` as "entailed 0.90".

### Matcher

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/matcher-dark.svg">
  <img alt="Matcher score ranges for fifteen kinds of quote damage: faithful quotes score between 0.66 and 1.0, quotes that are not in the source between 0.14 and 0.40, and quotes whose meaning was changed score high because they are still near-verbatim." src="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/matcher-light.svg">
</picture>

The matcher benchmark needs no API key and no labels, because the right answer
is known by construction: 2,061 quotes built from five Wikipedia articles, then
copied faithfully, reformatted, altered or replaced in fifteen different ways. `npm run bench:matcher` reproduces it in
about two seconds. Faithfully copied quotes never score below 0.660, quotes
that are not in the source never above 0.396, and the default threshold of 0.4
sits in that gap. The amber rows are there on purpose: a quote whose meaning was
changed is still near-verbatim, and catching it is the judge's job.

There are two honest limits. Invented prose built from the source's own words
(an adversarial case) scores high, and so can a hand-written fabrication that
reuses the source's vocabulary, like `c3` above at 0.48. The CLI therefore
fails every citation below 0.5 and leaves the rest to the judge.

### Judge

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/judges-dark.svg">
  <img alt="Five open judge models against the human labels of ALCE: they catch between 75% and 84% of unsupported citations, and agree with the annotators on 76.7% to 80.3% of pairs, around the 77.6% of the TRUE NLI model." src="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/judges-light.svg">
</picture>

The judge is measured against the human annotators of ALCE[^alce], with the
mapping from VeriQuote's classes to ALCE's labels fixed before any model ran.
*Caught* is the share of citations the annotators marked as unsupported that
the judge did not call fully supported. On ALCE's yes-or-no question ("does the
source fully support the claim?"), general-purpose open models agree with the
annotators about as often as TRUE[^true], the specialised 11B NLI model that
ALCE uses for its own automatic scores (77.6%). The best of them, `glm-5.3-flash`,
reaches Cohen's κ 0.53 on the three-way labels (full, partial or no support).
For comparison, ALCE reports κ 0.525 between its automatic metric and the
annotators on citation precision.

Before trusting any of this, look at the left panel: even the best judge lets
one unsupported citation in six through as fully supported. No judge should be
the only check. With only 56 unsupported pairs per run the intervals are wide,
so neighbouring models are not really separated. With reasoning switched off,
all three hybrid models caught less and agreed less while answering five to ten
times faster; each difference is within the sampling error, but all three point
the same way. These pairs come from ALCE, where the judge gets a whole passage
rather than a quote, which makes its task harder than in normal use.

### Answering models

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/protocol-dark.svg">
  <img alt="Protocol compliance for eight answering models: qwen3.6, qwen3.5, deepseek-v4-flash and glm-5.3-flash are close to 100% complete and verbatim; gpt-oss-120b is complete in 33.3% of answers; mistral-medium quotes verbatim in 81.0% of citations; llama-3.1-8b manages about half." src="https://raw.githubusercontent.com/rickintoplace/veriquote/main/bench/figures/protocol-light.svg">
</picture>

Each model answered 18 questions twice, with the citation instructions in its
system prompt, and `parseAnswer()` decided mechanically whether it complied.
Every raw answer is in
[`bench/results/protocol-answers.jsonl`](bench/results/protocol-answers.jsonl).
The strongest open models tested follow the format almost perfectly. Two
others show failures a reader would not notice: `gpt-oss-120b` almost always
prints the appendix, yet only a third of its answers give every citation a
quote. `mistral-medium` is nearly always complete, but only 81% of its quotes
are exact copies; the rest mostly join passages with "..." or change a few
words, and the matcher still finds them at a lower score. On the three
questions the sources cannot answer, no model attached a citation without a
real quote.

<details>
<summary>The numbers behind the figures</summary>

| judge model | caught ↑ | agreement | Cohen's κ |
| --- | ---: | ---: | ---: |
| `glm-5.3-flash` | 83.9% | 80.3% | 0.529 |
| `deepseek-v4-flash` | 81.8% | 78.7% | 0.435 |
| `qwen3.6-35b-a3b` | 81.8% | 78.1% | 0.454 |
| `qwen3.5-397b-a17b` | 79.2% | 79.7% | 0.483 |
| `gpt-oss-120b` | 75.0% | 76.7% | 0.394 |
| `qwen3.5-397b-a17b`, no reasoning | 78.6% | 77.7% | 0.410 |
| `qwen3.6-35b-a3b`, no reasoning | 78.6% | 77.3% | 0.397 |
| `glm-5.3-flash`, no reasoning | 75.6% | 74.0% | 0.373 |
| TRUE (T5-11B), as reported by ALCE[^alce] | | 77.6% | |

| quote family | n | median score | accepted at 0.4 |
| --- | ---: | ---: | ---: |
| faithful but reformatted | 1,121 | 1.000 | 100.0% |
| near-verbatim, meaning changed | 586 | 0.932 | 100.0% |
| not in the source | 187 | 0.249 | 0.0% |

| answering model | appendix | complete | verbatim | warning-free |
| --- | ---: | ---: | ---: | ---: |
| qwen3.6-35b-a3b | 100.0% | 100.0% | 100.0% | 100.0% |
| qwen3.5-397b-a17b | 100.0% | 100.0% | 100.0% | 100.0% |
| deepseek-v4-flash | 100.0% | 100.0% | 99.2% | 93.3% |
| glm-5.3-flash | 96.6% | 96.6% | 99.6% | 96.6% |
| gemma-4-31b-it | 80.0% | 80.0% | 96.6% | 80.0% |
| mistral-medium-3.5-128b | 96.7% | 93.3% | 81.0% | 96.7% |
| gpt-oss-120b | 96.7% | 33.3% | 91.1% | 33.3% |
| llama-3.1-8b-instruct | 66.7% | 43.3% | 50.3% | 20.0% |

The figures are rendered from `bench/results/*.json` by
[`bench/figures/render.mjs`](bench/figures/render.mjs).
</details>

## Use from an agent

An agent that reads sources and writes conclusions is exactly the case
VeriQuote was built for. [`verify-citations`](integrations/verify-citations) is
an [Agent Skill](integrations/verify-citations/SKILL.md) that has the agent
write its sourced answer in the checkable format and run `veriquote check` on
it before showing it to you. The CLI fetches every cited URL itself, so the
agent cannot pass with its own truncated or misremembered copy of a page. The
exit code tells the agent what to do next without parsing anything:

```
exit 0  verdict "pass"    every cited claim is grounded     -> present the answer
exit 2  verdict "revise"  problems[] + instructionsForModel -> fix and re-check
exit 1  bad input or unreachable source -> do NOT claim the answer was verified
```

The skill works in any host that reads Agent Skills, such as Claude Code, and
the CLI in anything that can run a shell command.

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
  judge,                           // omit to check the quotes only
});

console.log(report.summary);
// { citationCount: 2, verbatimRate: 1, entailedRate: 0.5,
//   meanScore: 0.675, minScore: 0.4 }

for (const c of report.citations) {
  console.log(c.claimId, c.sourceIndex, c.textMatch.method,
              c.textMatch.score, c.entailment?.class, c.score);
}
```

`report.cleanText` is the answer without the `{cX}` markers, ready to render.
Show each citation's match score, judge class and combined score next to its
footnote, so a reader can see which sentence carries weight without opening a
single source.

| Export | Purpose |
| --- | --- |
| `buildCitationInstructions(options?)` | Prompt block for the answering model; budgets and quote lengths are configurable. |
| `verifyAnswer(options)` | The full pipeline: parse, match, judge, report. |
| `parseAnswer(answer)` | Claims, quotes and protocol warnings, without verifying anything. |
| `parseEvi1Appendix` / `stripEvi1Appendix` / `serializeEvi1Appendix` | Low-level handling of the appendix. |
| `matchQuoteAgainstSource(quote, source, options?)` | The deterministic matcher on its own. |
| `ChatCompletionsJudge` | Judge for any OpenAI-compatible API. |
| `EntailmentJudge` (interface) | Bring your own judge, such as a local NLI model. |
| `gateReport(report, answer)` | Pass or revise, the list of problems, uncited sentences and a correction prompt. |
| `fetchSource(url)` / `htmlToText(html)` | Fetch a source independently of the model and extract its text. |

All inputs and outputs are plain, serializable data. See
[`src/types.ts`](src/types.ts) for the data model and
[`docs/DESIGN.md`](docs/DESIGN.md) for scoring and thresholds.

| Class | Support score | Meaning |
| --- | --- | --- |
| `entailed` | 0.9–1.0 | The quote fully covers the claim. |
| `partially_entailed` | 0.5–0.8 | The core is supported, details are missing. |
| `overstated` | 0.3–0.6 | The claim is stronger or more general than the quote. |
| `insufficient` | 0.1–0.4 | The quote is related but does not confirm the claim. |
| `contradicted` | 0.0 | The quote says the opposite. |
| `error` | none | The judge failed for this item; it is reported, never dropped. |

## How this differs from the alternatives

| | verbatim quote checked | claim↔evidence checked | model-agnostic | runtime |
| --- | --- | --- | --- | --- |
| **VeriQuote** | yes, deterministic | yes, pluggable judge | yes | TypeScript, no dependencies, browser and edge |
| [Anthropic Citations API](https://platform.claude.com/docs/en/build-with-claude/citations) | not needed: spans are extracted, so they are real by construction | no | Claude only | hosted |
| [LettuceDetect](https://github.com/KRLabsOrg/LettuceDetect) | no quote protocol | yes, span-level model | yes | Python and model weights |
| [RAGAS](https://github.com/explodinggradients/ragas) and eval frameworks | no | yes, as an offline metric | yes | Python, offline evaluation |

**Use the Citations API instead** if you are on Claude and only need to know
that a span is real. It guarantees that by construction, which is stronger than
any matcher. It does not tell you whether the span supports the sentence built
on it; for that, pair it with VeriQuote's judge and skip the matcher.

**Use LettuceDetect instead** if you want unsupported spans flagged in an
answer that follows no citation protocol at all, and you are happy to run a
model in Python. It solves the problem after the fact; VeriQuote changes what
the answering model commits to in the first place.

VeriQuote's own niche is narrow, and worth stating plainly: you want the
answering model pinned to a quote *before* it writes, you want the
deterministic half of the check to run anywhere, including a browser, and you
want per-claim results you can show a reader rather than one score on a
dashboard.

The closest related work is a recent study by Zhang et al.[^zhang], which
evaluates the same design (inline verbatim quotes, tiered verbatim matching and
an LLM judge) on clinical guidelines. It found that `claude-opus-5` quoted
verbatim for 98.0% of its claims but fully substantiated only 37.1% of them.
VeriQuote is the reusable library, CLI and agent skill for that kind of check,
with its judge measured against human labels.

## Security

- **Keep your key on the server.** `ChatCompletionsJudge` needs an API key; in
  your own app, call `verifyAnswer` from a backend. The demo runs the judge in
  the browser only with a key the visitor enters.
- **Source text is untrusted.** Judge inputs are length-capped, stripped of
  control characters and HTML, and marked as data in the prompt. The judge's
  output is checked against a closed vocabulary: unknown classes, out-of-range
  scores and invented item IDs are rejected. Nothing is ever `eval`ed.

## Reproducibility

The matcher is pure: the same inputs always give the same score. The judge
runs at temperature 0 (pass `seed` where the provider supports it), but hosted
models are only deterministic on a best-effort basis. For strict
reproducibility, pin the model version or put a self-hosted model behind the
`EntailmentJudge` interface.

## Citing

If you use VeriQuote in academic work, please cite it[^veriquote]; the details
are also in [`CITATION.cff`](CITATION.cff).

## License

[MIT](LICENSE)

[^alce]: Gao, T., Yen, H., Yu, J., & Chen, D. (2023). Enabling large language models to generate text with citations. In *Proceedings of the 2023 Conference on Empirical Methods in Natural Language Processing* (pp. 6465–6488). Association for Computational Linguistics. https://doi.org/10.18653/v1/2023.emnlp-main.398

[^true]: Honovich, O., Aharoni, R., Herzig, J., Taitelbaum, H., Kukliansy, D., Cohen, V., Scialom, T., Szpektor, I., Hassidim, A., & Matias, Y. (2022). TRUE: Re-evaluating factual consistency evaluation. In *Proceedings of the 2022 Conference of the North American Chapter of the Association for Computational Linguistics: Human Language Technologies* (pp. 3905–3920). Association for Computational Linguistics. https://doi.org/10.18653/v1/2022.naacl-main.287

[^zhang]: Zhang, J., Chen, Y., Commodore-Mensah, Y., & Oberst, M. (2026). *Verifiable by construction: Claim-level evaluation of verbatim citation in clinical question answering* (Version 2) [Preprint]. arXiv. https://doi.org/10.48550/arXiv.2609.15964

[^veriquote]: Heilmann, E. (2026). *VeriQuote: Deterministic and semantic verification of quote-grounded LLM citations* (Version 0.2.2) [Computer software]. Zenodo. https://doi.org/10.5281/zenodo.21552379
