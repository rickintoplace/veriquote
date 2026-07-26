# verify-citations (Agent Skill)

A portable **Agent Skill** that uses
[VeriQuote](https://github.com/rickintoplace/veriquote) as an **internal
hallucination gate** for source-grounded research: before an agent shows a
cited answer to the user, it checks that every cited claim is actually backed by
its source and that no factual sentence is left uncited. It then drives a
self-correction loop.

## Install

```bash
cd integrations/verify-citations
npm install
```

Then register the directory with your agent host (or publish it to that host's
skill registry). `SKILL.md` tells the agent when and how to invoke the gate; the
frontmatter fields (`name`, `description`, `user-invocable`) are the portable
subset understood by every Agent-Skills host.

## Use directly (without an agent)

```bash
echo '{ "answer": "...EVI1...", "sources": [ { "text": "..." } ] }' \
  | VERIQUOTE_JUDGE_API_KEY=sk-... node bin/verify-citations.mjs
```

Exit code: `0` pass · `2` revise · `1` error. See [SKILL.md](./SKILL.md) for the
full contract, the correction loop, and the honesty caveats (it establishes
faithfulness to the cited sources, not truth).

## Files

- [`SKILL.md`](./SKILL.md) — the Agent Skill (instructions the agent follows).
- [`bin/verify-citations.mjs`](./bin/verify-citations.mjs) — the verifier CLI.
- [`bin/print-citation-instructions.mjs`](./bin/print-citation-instructions.mjs)
  — prints the EVI1 prompt block for the synthesizer model.

## Relationship to VeriQuote

This skill is a thin adapter; all verification logic lives in
[VeriQuote](https://www.npmjs.com/package/veriquote), which it depends on as a
regular npm package (`"veriquote": "^0.1.1"`). The skill directory is therefore
self-contained: copy it out, run `npm install`, and it works.
