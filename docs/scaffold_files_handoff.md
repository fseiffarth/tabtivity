# Scaffold files — implementation handoff

Plan: `docs/scaffold_files_plan.md` (Fixed decisions §2 are final).
Integration branch: `scaffold-files` (from `develop` a2a5ecb45).

Each agent appends its own section: shas, choices made, gotchas, gate status
with test counts, and **Flagged for user**.

## Plan review

Reviewer: plan reviewer, 2026-11-13. Fixed decisions untouched. Every cited
path/line was checked against `develop` a2a5ecb45.

Changed in the plan, and why:

- **Wrong path:** `useFileTreeRows.ts` lives in `src/components/files/`, not
  `src/hooks/` (§1, §4, §5, agent table).
- **Missing callers of `SCAFFOLD_FILES`/`CLAUDE_SETTINGS`** added to step 1:
  `migration_steps_at` / `apply_migration_steps_at` (Migrate-project dialog,
  `claude_settings` step), `migrate_legacy_projects`, the three
  `scaffold_project` import call sites, `scaffold_claude_dir`, and the
  integration tests `src-tauri/tests/projects_commands.rs` and
  `tests/file_ops_tests.rs` (incl. the `claude_settings_is_valid_json` test).
  `brand_migration` has no scaffold-name dependency.
- **New module** `services/scaffold.rs` for the catalog (decided: keeps the
  god module `projects.rs` from growing); new `commands/project_docs.rs` for
  the commands.
- **Command class was wrong:** `Client` means "the machine the user sits at,
  never exposed". Status/create/memory read the project/agent home -> `Core`
  (like `project_scaffold_missing`). Noted the `PATH_NAMED` test in
  `core_dispatch.rs`: no `path/dir/file` words in the new arg names.
- **Behaviour trap fixed:** `scaffold_is_missing_at` counts a legacy-history
  `AGENTS.md` as missing today; step 2 moves the text every existing project
  holds into history, which would have put the amber tag on all of them
  (against decision 4). The tag now counts only missing defaults; repair
  still upgrades byte-identical history copies of `AGENTS.md`.
- `agents_empty_at` uses an uncapped, symlink-following `read_to_string`:
  moved onto the capped no-follow state reader.
- **Catalog flags:** added `creatable` (REMARKS and the pointers get no ghost
  row) and `pointer` (pointers report `pointer`, are never dimmed, never
  rewritten). Dim class is a new `.doc-template`: `.file-entry.scaffold` is
  shared with the gitignored/hidden sections.
- **Remote-only projects:** status/ghost/create dropped from this plan
  (`scaffold_target_for_entry` is `None`; the plan's SFTP create would need a
  new one-file create path and per-file lstat round trips). Their creation-time
  host scaffold follows the lean set.
- **Phone:** no separate status route; the root listing gains `docs`, plus one
  `files/docs` create route behind the `upload_scope` guards; refusal-matrix
  rows in `mobile_control/host/tests.rs`; new small module so `host.rs`
  (376 KB) barely grows. Phone also imports `STANDARD_PROJECT_FILES`.
- **Tag popover:** only the files-view tag becomes clickable; hover card /
  switcher keep a plain label.
- **i18n:** `de/es/fr/it` named explicitly; `i18n.test.ts` fails unless every
  language holds every English key; rewording list for the existing
  `*Scaffold*` keys.
- **Step 8 (agent memory):** the viewer tab is scope-confined to project
  paths, so entries open in a read-only preview dialog (the
  `SkillsLibraryView` `renderMarkdown` pattern) instead of widening the
  viewer; agent home is agent-writable, so reads go through `home_io`.
- **Docs step:** added `docs/guide/building.md` (~114-123) and
  `DOCUMENTATION.md` (~1140-1170) which still describe pointers/ten files.
- **Step 3 / §3a:** table filled for all 30 ids. Exact merge point:
  `agent_hint::register_in_home` (`agent_hint.rs:336`), runs after
  `agent_global::apply_to_home` (`agent_home.rs:341` then `:364`). Gemini:
  `.gemini/settings.json` `context.fileName` via `merge_json` (string ->
  array, union, `GEMINI.md` first so `save_memory` still writes there).
  Aider: new `~/.aider.conf.yml` `read` via `serde_norway`. Nothing for the
  rest; known gap list in §3a.
- **Organisation re-cut:** 4 -> 6 implementers (I1 catalog; I2 agent-home
  settings, runs beside I1; I3 commands; I4 desktop (tree, dialogs, memory UI; merged by the main agent, user prefers fewer implementers);
  I5 phone + docs) so none holds more than ~3 large files or two subsystems;
  2 step reviewers; order and concurrency (<= 3) in §6.

Left to implementers (verify, not blocking): Codex `memories/` dir and
Claude's encoded-root path against the installed versions; whether Aider
tolerates a missing `AGENTS.md` silently; whether Gemini de-duplicates an
`AGENTS.md` that a legacy `GEMINI.md` pointer also imports.

Unverified §3a rows (secondary sources only): continue, pi, crush, amp,
qoder, muse (see the Source column). plandex, swe-agent, mini-swe-agent:
nothing documents an instruction file.

### Flagged for user

None blocking. Informational: plandex, swe-agent, mini-swe-agent, continue and
openclaw cannot be pointed at the project `AGENTS.md` from user-level config
(decision 2 forbids pointer files), so they get no project instructions in new
projects. Claude Code also ignores `AGENTS.md` whenever any `CLAUDE.md` exists
in the project or a parent folder.

## I1 Catalog

## I2 Agent-home settings

## R1

## I3 Commands

## R2

## I4 Desktop

## I5 Phone + docs

## Final review
