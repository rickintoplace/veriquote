# VeriQuote demo

One self-contained HTML file that runs both checks on a single citation: the
deterministic matcher (is the quote in the source?) and the LLM judge (does the
quote support the claim?).

- **Eight examples** cover a supported citation, extraction damage, and six
  ways to fail. The judge verdicts for them were recorded once with
  `glm-5.3-flash` through the same pipeline and are replayed, so the page needs
  no key to show the whole picture. The table at the bottom shows which check
  catches which failure.
- **Your own text:** the matcher runs live in the page. The judge runs live
  only if you enter an endpoint, model and key; the key stays in the tab's
  memory and goes only to that endpoint. Any OpenAI-compatible endpoint that
  accepts browser requests works (OpenRouter does).

Open `index.html` in a browser, or serve the directory. The page loads the
library from `https://esm.sh/veriquote@0.2.0`; to try an unreleased build, run
`npm run build` and point the import at `../dist/index.js` (served, not opened
as `file://`).

Any static host works: it is one file with no build step.
