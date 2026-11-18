---
name: retro
description: Conduct a retrospective on a coding session and propose improvements to the agent environment (AGENTS.md, checks, docs, memory, tooling).
disable-model-invocation: true
---

<!-- Adapted for Tabtivity from mattpocock/skills@4ae2317
     skills/engineering/retro (MIT, see ../THIRD_PARTY_NOTICES.md). -->

You are suggesting improvements to the coding agent's **environment** so
future runs go better.

## Steps

1. Call the Skill tool with `writing-for-agents` for the style guide.
2. Read the primary sources for the session the user names (default: this
   one). Claude transcripts are `$HOME/.claude/projects/<cwd-slug>/*.jsonl`;
   in a Tabtivity agent tab `$HOME` is that scope's agent home. Read with
   `rg`/`jq` excerpts, never a whole transcript.
3. Find candidates in these categories:
   - **Navigation** — the session searched long for something: a file-map
     row, a `docs/context/` pointer, or a sharper existing pointer.
   - **Automated checks** — a mistake a check could have caught. Read what
     exists first (`scripts/gates.sh --list`, `eslint.config.js`, the
     source-scan tests, `scripts/brand-check.sh`, `scripts/privacy-check.sh`,
     the CI workflows): an existing check that is unwired or broken is the
     finding. A **mechanical** rule (banned API, import shape, file location)
     becomes a deterministic check — a custom ESLint rule, a source-scan
     test, a script in `gates.sh`. Default to the check over prose.
   - **AGENTS.md** — a rule that should become a check instead; a line that
     changes no behaviour (a **no-op**); something every agent got wrong that
     is missing. It is loaded by every agent, so every line pays.
   - **Memory** — a lesson the agent will need again that the repo does not
     record; or a memory that is stale or duplicates the repo.
   - **Tool economy** — expensive calls that could be cheaper (whole-file
     reads of 100 KB docs, unfiltered logs, repeated gate runs).
   - **Information access** — a fact the agent could not reach (a log, a
     probe, a read-only view) that a script or doc would have exposed.
4. Present the candidates ranked by severity, each with the evidence (a
   transcript excerpt or file:line) and the concrete change. Ask with
   AskUserQuestion (multi-select) which to apply; apply only those.
