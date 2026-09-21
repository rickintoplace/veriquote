# verify-citations (Agent Skill)

An [Agent Skill](./SKILL.md) that makes a coding or research agent such as
Claude Code check its own sourced answers with the
[`veriquote`](https://www.npmjs.com/package/veriquote) CLI before showing them:
every quote must occur in its source, every quote must support its claim, and
factual sentences need a citation.

Install by copying or linking this directory into your agent's skills folder,
e.g. `~/.claude/skills/verify-citations`. It needs Node ≥ 18 and nothing else;
the CLI is fetched on first use with `npx`.

Use without an agent:

```bash
npx veriquote check answer.md --source https://en.wikipedia.org/wiki/Ozone_layer
```
