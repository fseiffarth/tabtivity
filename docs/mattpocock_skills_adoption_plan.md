# mattpocock/skills for Tabtivity development — plan

Status: **done (2026-11-06)** — six skills adapted into the repo's
`.claude/skills/` (committed; user's choice), #2430. Installed by hand from a
pinned clone, since the creator's Customize does not exist yet. Source: <https://github.com/mattpocock/skills>
(MIT, 27 skills in `skills/engineering/` and `skills/productivity/`, each a
folder with `SKILL.md`). Read 2026-11-06. Companion to
`docs/skill_creator_plan.md`.

## How to bring them in

**Not** `claude plugin install mattpocock-skills@…`: it auto-updates, so
upstream edits would reach agents that hold write access to this public repo
without review, and it installs all 27 (several clash, below). Instead, through
Tabtivity's own Skills Library — which doubles as dogfooding it:

1. Add `https://github.com/mattpocock/skills` as a source. The catalog walker
   already finds `**/SKILL.md` (`services/skills.rs`, `walk_for_skills`), so
   the nested `skills/<category>/<name>/` layout needs no change. The cached
   clone is a pinned snapshot; Refresh is a deliberate update.
2. Install a chosen subset, then adapt each one to Tabtivity's rules —
   once the creator exists that is its **Customize** path (decision 10 of the
   creator plan: yes), until then a hand edit of the installed copy.
3. Keep upstream's attribution line in each adapted `SKILL.md`.

## Adopt (adapted)

| Skill | Why here | Adaptation |
|---|---|---|
| `diagnosing-bugs` | The repo's hardest work is diagnosis (heap corruption, webview freeze, typing latency, root git-status loop). Its feedback-loop → minimise → ranked hypotheses → instrument → regression test at a seam loop is what those fixes needed. | The loop must never start or stop Tabtivity: use vitest/cargo tests, the headless WebKit probe, the CLI verify harness; the human-in-the-loop step is "give the user exact click steps". After backend edits `npm run backend:stale`. Close with `scripts/gates.sh`. |
| `to-tickets` | Plans in `docs/*_plan.md` are turned into `todo/<group>.md` entries by hand today. | Output = numbered entries in the matching `todo/<group>.md`, each with 🤖/🖐️ boxes and the four-platform ✅/❌ pairs; new UI gets an `UntestedTag` row. No issue tracker. |
| `handoff` | Many multi-session strands already end in `docs/*_handoff.md`. | Write `docs/<feature>_handoff.md` (or project `tmp/` when it is throwaway), never `$TMPDIR` — `/tmp` is a small tmpfs here and invisible to the user. Reference plans/commits by path. |
| `writing-for-agents` | AGENTS.md, the file maps and `docs/context/` are agent-read and kept terse on purpose. Also the right style guide for the creator's **Draft with an agent** prompt. | Add the repo's own rules: one-line filemap rows, no nested `AGENTS.md`/`CLAUDE.md`, rationale in `docs/context/`, `{app}` not the name. |
| `retro` | Session lessons land in memory and AGENTS.md today, unevenly. | Targets: the memory index, AGENTS.md (only rules an agent would otherwise get wrong), and mechanical rules → deterministic checks (ESLint rule, source-scan test, `brand-check`/`privacy-check` style), which the repo already prefers. Output stays in the conversation. |
| `tdd` (optional) | Fits regression-first fixes. | Drop its `codebase-design`/`code-review` calls or point them at the built-in `/code-review`; confirm seams via AskUserQuestion; finish with `scripts/gates.sh`. |

## Skip

- `setup-matt-pocock-skills`, `triage`, `to-spec`: built around an issue
  tracker, triage labels and `GLOSSARY.md`/ADRs, and write an "Agent skills"
  block into AGENTS.md. Tabtivity uses `todo/` + `docs/context/`.
- `implement`, `implement-spec`: fan out parallel subagents on their own;
  here subagents run only when asked.
- `code-review`: collides with the built-in `/code-review` and the repo's
  `CODE_REVIEW*.md`.
- `domain-modeling`, `codebase-design`, `ask-matt`, `wayfinder`, `pr`,
  `wizard`, `teach`, `wait-what`, `to-questionnaire`, `grill-me`/`grilling`:
  low fit or covered (decisions already go through AskUserQuestion; plans and
  handoffs through `docs/`). `prototype` is a maybe for UI design questions.

## What it teaches the Skills Library / creator

- Frontmatter beyond `name`/`description` is real: `disable-model-invocation`,
  `argument-hint`. The creator's surgical frontmatter editing and "keep other
  keys" rule are right; the validator must not reject unknown keys. The
  catalog could badge **user-invoked** (`disable-model-invocation: true`).
- Skills reference each other (`retro` → `writing-for-agents`, `tdd` →
  `codebase-design`, `code-review`). Installing one alone leaves a dangling
  reference: the preview could list referenced skill names that are not
  installed in the chosen scope.
- One source can hold skills that should not all be installed — supports the
  per-skill install, no "install all".

## Decision

The adapted copies live in the repo's `.claude/skills/`, committed (user,
2026-11-06): reviewable, versioned, reaching every clone and remote host via
lockstep. Claude Code only — a rule every agent must follow stays in
`AGENTS.md`.
