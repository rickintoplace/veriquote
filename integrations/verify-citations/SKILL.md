---
name: verify-citations
description: Check that a research answer built from web pages or documents is actually backed by them before showing it to the user. Use whenever you answer from fetched sources (web search, docs, RAG results). Catches quotes that are not in the source, claims the source does not support, and factual sentences with no citation, then drives a self-correction loop.
user-invocable: true
metadata:
  openclaw:
    requires:
      bins: [node]
---

# verify-citations

Use this as a gate: whenever you answer from sources you fetched, verify the
answer **before** presenting it, and fix it if it fails. Do not skip it because
you feel confident; confidence is exactly what this check does not rely on.

## 1. Write the answer in the checkable format

Print the rules once and follow them when you write the answer:

```
npx -y veriquote prompt
```

Read each source with `npx -y veriquote source <url-or-file>` and copy your
quotes from that output: it is exactly the text the check uses. Web-fetch tools
often summarize or reformat pages, and a quote copied from their output may not
match the page.

Number your sources `[1]`, `[2]`, … in a fixed order. Every cited sentence ends
with its markers and a claim id, e.g. `…expands when freezing.[2]{c1}`, and the
answer ends with an `EVI1` appendix holding a **verbatim** quote per citation.
Save the full answer, appendix included, to a file such as `answer.md`.

## 2. Check it

Pass the sources in the same order as their numbers:

```
npx -y veriquote check answer.md --source <url-or-file-for-[1]> --source <…[2]> --json
```

URLs are fetched by veriquote itself, so the check does not depend on your copy
of the page. For sources without a URL (RAG chunks, tool output, local docs),
save each to a file and pass the path; `.html` files are converted to text. PDFs
are not supported: extract the text first (e.g. `pdftotext`).

- **exit 0**, `"verdict": "pass"`: present the answer (see step 4).
- **exit 2**, `"verdict": "revise"`: `problems[]` lists failing citations,
  `uncited[]` lists factual sentences without a citation, and
  `instructionsForModel` says how to fix them.
- **exit 1**: bad input, a source could not be loaded (see stderr), or
  `"verdict": "unverified"`: the judge failed on the citations in `unjudged[]`.
  Run the check again; do not claim the answer was verified until it passes.

## 3. Fix and re-check

Apply `instructionsForModel`: replace a quote with real text from the source,
weaken an overstated claim, cite or drop an uncited statement. If no source
supports a claim, find a better source or remove the claim. Re-run the check, at
most three rounds; if it still fails, present only what passed and tell the user
which points could not be verified.

## 4. Present the result

Show the user `cleanAnswer` from the JSON (the answer without `{cX}` markers and
without the appendix), followed by the numbered sources with their URLs, and one
line on the check, for example: "Checked with VeriQuote: all 6 quotes were found
in the sources and judged to support their claims (judge: glm-5.3-flash)." If
`judge` is `null`, say that only the quotes were checked, not whether they
support the claims.

## Semantic check

Without configuration, veriquote only checks that every quote really occurs in
its source. To also check that the quote **supports** the claim (catches
verbatim quotes attached to a claim they contradict), set:

- `VERIQUOTE_JUDGE_API_KEY`: a key for any OpenAI-compatible endpoint
- `VERIQUOTE_JUDGE_MODEL`: for example an open model such as GLM, Qwen or DeepSeek
- `VERIQUOTE_JUDGE_BASE_URL`: defaults to `https://openrouter.ai/api/v1`

The JSON field `judge` is `null` when only quotes were checked; say so when you
report the result.

## What a pass means, and how to tell the user

A pass means the cited claims are **faithful to the cited sources**: the quotes
are real and they support the claims. It does not mean the answer is **true**; a
wrong source quoted faithfully still passes. Say "supported by the cited
sources", never "verified true". The uncited-sentence check is a heuristic.
