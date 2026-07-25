# VeriQuote

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

VeriQuote is extracted from and battle-tested in
[NavigNine](https://navignine.com), a source-grounded research assistant,
which serves as the reference deployment.

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
  but the "quote" is not in the source. The entailment judge might pass; the
  deterministic matcher catches it, with a percent score that distinguishes
  light paraphrase (high fuzzy score) from fabrication (low score).

The combined per-citation score is conservative:
`min(textMatchScore, judgeConfidence)`.

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
  model: 'google/gemini-2.5-flash-lite',
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
combined `score` next to the footnote — e.g. green/yellow/red per claim. This
is exactly what the NavigNine UI does with tooltips and colored footnotes.

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

## Citing

If you use VeriQuote in academic work, please cite the Zenodo record (see
`CITATION.cff`; DOI badge will appear here after the first release).

## License

[MIT](LICENSE)
