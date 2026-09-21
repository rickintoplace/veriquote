# VeriQuote matcher demo

A single self-contained HTML file. The deterministic matcher runs in the page;
nothing is sent anywhere and no API key is involved. The entailment judge is
deliberately absent — it needs a model and belongs server-side.

## Run it

Open `index.html` in a browser, or serve the directory:

```bash
npx serve demo        # or: python3 -m http.server -d demo
```

The page pulls the library from `https://esm.sh/veriquote@0.1.1`. To test an
unreleased build instead, run `npm run build` and change the import at the
bottom of `index.html` to `../dist/index.js` (this needs the page to be served
rather than opened as `file://`).

## Hosting

Any static host works, since it is one file with no build step.

- **GitHub Pages**: Settings → Pages → deploy from branch `main`, folder `/`.
  The demo then lives at `https://<user>.github.io/veriquote/demo/`.
- **Anywhere else**: copy `index.html`.

## What it shows

Seven preset examples walk through the cases the matcher is and is not
responsible for — a verbatim hit, extraction damage, a changed number, a
negation, an honest paraphrase, a real quote on the wrong document, and an
invention. The changed-number and negation cases are the point: they score
nearly as high as the untouched quote, which is why a text match alone is never
a verdict on truth.
