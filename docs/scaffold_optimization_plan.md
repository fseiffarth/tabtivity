# Project scaffold optimization — plan

Evaluation of the files `scaffold_project` writes into a new project
(`src-tauri/src/commands/projects.rs`, `SCAFFOLD_FILES`) and the fill prompt
(`src/components/projects/scaffold.ts`), 2026-10-01.

**Status (2026-10-01): A–D landed, never live.** C and D in c3c8adce (which
also gave Gemini, Qwen, Auggie, CodeBuddy, Droid, Cursor, Copilot, Vibe and
OpenCode the hint through `services::agent_hint`); A and B in the commit after
it. A pin test on `AGENTS_SCAFFOLD` now forces the old text into
`commands/scaffold_history/` before the template can change again.

## Findings

1. **Canonical `AGENTS.md` copies freeze.** `AGENTS_SCAFFOLD` changed in
   de2bb125 (08-26), 27ec65b9 (08-30), e2ca0458 (09-05), 826cac59 (09-14) and
   60395a33 (09-28). `LEGACY_AGENT_STUBS` only knows the pre-08-26 one-line
   stubs, so repair/Migrate never upgrades an untouched copy of any later
   template. The e2ca0458 copy still says the outbox takes images only.
2. **Tabtivity runtime text lives in a user-owned, committed file.** The
   `tabtivity-send` section rides the initial scaffold commit, so it reaches
   collaborators, CI agents and public remotes where the command does not
   exist. Claude reads it twice (the agent hook prints the same hint at
   `SessionStart`). This volatile section is also what causes (1).
3. **Context cost.** The template is ~1.5 KB (~400 tokens), loaded every
   session of every project: ~1/3 is the `tabtivity-send` section, ~40% two link
   lists that duplicate `PROJECT.md` (including a link to itself).
4. **Fill prompt** asks for "architecture, workflows" in `AGENTS.md` (overview
   text agents don't need every turn) and doesn't protect Tabtivity-owned text.
5. Minor: five heading-only stubs; empty `.claude/settings.json`; Gemini has no
   Tabtivity hook.

## Changes

- **A. Upgrade untouched old templates.** Add each historical
  `AGENTS_SCAFFOLD` text byte-exact (extract with `git show <sha>:…` —
  never retype) to the set `is_legacy_agent_stub` matches. Same for the
  `CLAUDE.md`/`GEMINI.md` pointers if they changed. Byte-identical means
  untouched, so the never-overwrite rule holds. Test: each historical text is
  reported as `upgradeStub` and repaired to the current template.
- **B. Slim `AGENTS_SCAFFOLD`.** Keep Project / Running / Conventions
  placeholders and one line pointing to `PROJECT.md`; drop the two link lists
  and the `tabtivity-send` section. Keep `project_map_links_every_scaffold_file`
  green (the map stays in `PROJECT.md`).
- **C. Deliver the `tabtivity-send` hint from Tabtivity, not the project.** Claude:
  already done by the hook. Codex: Tabtivity registers a `SessionStart` hook —
  verify its stdout reaches the model before relying on it, then print the
  same line for `TABTIVITY_TAB_AGENT=codex` (POSIX + PowerShell bodies, and the
  hook test at `agent_session.rs` ~2949). Gemini (no hook): note the gap;
  candidate is a hook once Gemini support lands. Until C is verified for
  Codex, B costs Codex/Gemini the hint — land B and C together.
- **D. Fill prompt.** `AGENTS.md` holds rules an agent would otherwise get
  wrong (commands, constraints, conventions), not overviews; overview text
  goes to `README.md`/`DOCUMENTATION.md`. Update the prompt test if one pins
  the wording.

## Gates

`npm run build`, `npm test`, `cargo test`, `npm run lint`, `cargo clippy
--all-targets -D warnings`; then `npm run backend:stale`. Not live-verified:
create a new project and run Migrate on one scaffolded 08-26..09-28.
