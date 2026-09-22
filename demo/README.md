# VeriQuote demo

One self-contained HTML file that runs both checks on a single citation: the
deterministic matcher (is the quote in the source?) and the LLM judge (does the
quote support the claim?).

- **Eight examples**, grouped into two that should pass and six that should be
  blocked. Each shows the matcher comparing *quote ⟷ source* next to the judge
  comparing *claim ⟷ quote*, so you can see what each check looks at and where it
  is blind. The list shows at a glance which check blocks which example. Judge
  verdicts were recorded once with `glm-5.3-flash` through the same pipeline and
  are replayed, so no key is needed. Examples are linkable: `index.html#fabricated`.
- **Your own text:** the matcher runs live in the page. The judge runs live
  only if you enter an endpoint, model and key; the key stays in the tab's
  memory and goes only to that endpoint. Any OpenAI-compatible endpoint that
  accepts browser requests works (OpenRouter does).

- **Measured, not claimed:** below the examples, four charts show the
  benchmark results — which check catches which failure, the matcher's score
  gap, the judge models against human labels (with and without reasoning), and
  how well eight answering models follow the protocol. The numbers sit in one
  data block that `node bench/figures/render.mjs` rewrites from
  `bench/results/`, so the page stays in step with the benchmarks.

Open `index.html` in a browser, or serve the directory. The page loads the
library from `https://esm.sh/veriquote@0.2.0`; to try an unreleased build, run
`npm run build` and point the import at `../dist/index.js` (served, not opened
as `file://`).

Any static host works: it is one file with no build step.
