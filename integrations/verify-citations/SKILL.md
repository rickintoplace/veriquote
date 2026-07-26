---
name: verify-citations
description: Verify that a source-grounded research answer is actually backed by its cited sources before showing it to the user. Use after producing or synthesizing any answer that cites retrieved documents. Catches fabricated/paraphrased quotes, claims the source does not support, and factual sentences with no citation, then drives a self-correction loop.
user-invocable: true
metadata:
  openclaw:
    requires:
      bins: [node]
      env: [VERIQUOTE_JUDGE_API_KEY]
---

# verify-citations

Use this skill as an **internal hallucination gate**: whenever you have produced
(or orchestrated sub-models to produce) a research answer that cites retrieved
sources, verify it **before** presenting it to the user, and self-correct if it
fails.

## Prerequisites

1. **Install once** (from this skill directory): `npm install`.
2. **The answering/synthesizer model must emit the EVI1 protocol** — every
   cited sentence ends with `[n]` source markers and a `{cX}` claim marker, and
   the answer ends with a machine-readable quote appendix. Inject the required
   instructions into that model's system prompt:

   ```
   node bin/print-citation-instructions.mjs
   ```

   Append the output to your synthesizer system prompt. Provide the retrieved
   sources to the model as numbered blocks `[1]`, `[2]`, … in the same order you
   will pass them to the verifier.
3. **Keep the full text of every retrieved source**, indexed by the same `[n]`.
   You control retrieval, so keep each fetched document's extracted text in a
   list; its position is its citation index.

## How to run the gate

Build a JSON job and pipe it to the verifier:

```
echo '{
  "answer":  "<the raw model answer INCLUDING its EVI1 appendix>",
  "sources": [ { "title": "…", "url": "…", "text": "<full extracted source text>" }, … ]
}' | node bin/verify-citations.mjs
```

The verifier prints JSON and sets an exit code:

- **exit 0 / `"verdict":"pass"`** — every cited claim is grounded in its source
  and nothing factual is left uncited. Present the answer to the user.
- **exit 2 / `"verdict":"revise"`** — problems were found. The output contains:
  - `problems[]` — cited claims that fail (quote not in source, contradicted,
    overstated, or weakly supported), each with the reason.
  - `uncited[]` — factual sentences that assert something but cite nothing.
  - `instructionsForModel` — a ready-to-use correction prompt.
- **exit 1** — bad input or internal error (see stderr); do not claim the answer
  was verified.

## The self-correction loop

1. Run the gate on the draft answer.
2. If `verdict` is `revise`, send `instructionsForModel` back to the synthesizer
   model together with the original answer and sources, and ask it to re-output
   the full answer with a corrected EVI1 appendix. If a claim cannot be
   supported by any available source, retrieve a better source or drop the claim.
3. Re-run the gate. Repeat at most **3** times; if it still fails, present only
   the claims that passed and tell the user which points could not be verified.

## Configure the judge (recommended)

The deterministic quote match runs with no configuration. The semantic
entailment check (which catches verbatim-but-unsupported quotes — the c2 case)
needs an OpenAI-compatible endpoint, configured via environment variables,
**server-side only**:

- `VERIQUOTE_JUDGE_API_KEY` (or `OPENROUTER_API_KEY`)
- `VERIQUOTE_JUDGE_MODEL` (default `google/gemini-2.5-flash-lite`)
- `VERIQUOTE_JUDGE_BASE_URL` (default `https://openrouter.ai/api/v1`)

With no key present, verification degrades to text-match-only (still catches
fabricated/paraphrased quotes and uncited sentences, but not overstatement or
contradiction).

## What this gate does and does NOT establish — state this honestly to the user

- It **does** establish that cited claims are **faithful to the cited sources**:
  the quotes are real and they support the claims.
- It does **not** establish that the answer is **true**. If a source is itself
  wrong or outdated, a faithful quote still passes. Phrase results to the user as
  **"supported by the cited sources,"** never "verified true."
- The uncited-sentence check is a **heuristic** (tune `options.thresholds`); it
  reduces, but does not eliminate, unsupported assertions slipping through.
