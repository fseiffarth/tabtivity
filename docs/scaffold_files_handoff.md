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

Branch `worktree-agent-a5b4aca46e1c4ce6e` (on top of `scaffold-files` 08e549f87).
Commits, oldest first: a24ec64ef (step 1), 6cd7c151e (step 2), 2ac3a8c88 (whitespace fix), bd5ca6f8d (clippy fix in tests) - squash the two fixes into step 1 if wanted; the handoff commit follows.

### What is done (plan steps 1 and 2)

- New `src-tauri/src/services/scaffold.rs` (+ `scaffold/tests.rs`), registered
  in `services/mod.rs`. Moved in: `AGENTS_SCAFFOLD`, `AGENTS_HISTORY`, the
  pointer texts, `PROJECT_SCAFFOLD`, `REMARKS_SCAFFOLD`, `read_scaffold_doc`,
  `write_scaffold_file`. `SCAFFOLD_FILES`, `CLAUDE_SETTINGS`,
  `LEGACY_AGENT_STUBS`, `is_legacy_agent_stub`, `scaffold_claude_dir`,
  `claude_settings_present` are gone. `scaffold_history/*.md` stayed in
  `commands/scaffold_history/` (`include_str!("../commands/...")`);
  `AGENTS.2026-11-13.md` added.
- `commands/projects.rs` callers rewritten on the catalog: `scaffold_project`,
  `repair_project_scaffold_at`, `scaffold_preview`, `scaffold_is_missing_at`,
  `agents_empty_at`, `migration_steps_at`, `apply_migration_steps_at`
  (step ids `file:<name>` / `stub:<name>` stay, only for default docs; the
  `claude_settings` step is gone). `migrate_legacy_projects`,
  `project_scaffold_missing` and the three import call sites go through them
  unchanged. `services/remote/remote_scaffold.rs` follows the lean set
  (`make_claude_dir` field and all `.claude` logic removed).
- Step 2: the old AGENTS.md text is `scaffold_history/AGENTS.2026-11-13.md`
  (hash-pinned), new text has no pointer/PROJECT.md line and gains `## Boundaries`
  and `## Verify`. The pin test now pins the new hash and the history file's.
- Tests: integration `tests/projects_commands.rs` (`scaffolds()` is the catalog
  defaults + `.gitignore`; the seed's `TODO.md` and `.claude/settings.json` are
  asserted untouched) and `tests/file_ops_tests.rs`
  (`..._claude_settings_is_valid_json` deleted).

### Catalog API for I3 (`crate::services::scaffold`)

```rust
pub struct ScaffoldDoc { name, template, default, creatable, pointer, history }
impl ScaffoldDoc { fn state_of(&self, Option<&str>) -> DocState; fn is_untouched(&self, &str) -> bool; fn upgradable(&self) -> bool }
pub enum DocState { Missing, Template, Edited, Pointer }      // serde camelCase -> "missing"|...
pub struct DocStatus { name: &'static str, state: DocState, nested_under: Option<&'static str>, creatable: bool } // serde camelCase
pub const DOCS: &[ScaffoldDoc];
pub fn doc(name: &str) -> Option<&'static ScaffoldDoc>;        // exact leaf name; the only lookup for a renderer-sent name
pub fn defaults() -> impl Iterator<Item = &'static ScaffoldDoc>;
pub fn read_scaffold_doc(path: &Path) -> Option<String>;       // capped, no-follow
pub fn state_at(dir: &Path, doc: &ScaffoldDoc) -> DocState;
pub fn present_at(dir: &Path, name: &str) -> bool;             // symlink_metadata ok
pub fn missing_defaults_at(dir: &Path) -> Vec<&'static str>;   // for the tag popover
pub fn create_doc_at(dir: &Path, doc: &ScaffoldDoc) -> io::Result<bool>;   // create-new + O_NOFOLLOW; false = something was there
pub fn upgrade_doc_at(dir: &Path, doc: &ScaffoldDoc) -> io::Result<bool>; // AGENTS.md only, only while untouched
pub fn agents_empty_at(dir: &Path) -> bool;
pub fn docs_status_at(dir: &Path) -> Vec<DocStatus>;
pub const AGENTS_MD / README_MD / CLAUDE_MD / GEMINI_MD / REMARKS_MD: &str;
```

- `project_docs_status` = `scaffold_target_for_entry` (private in `projects.rs`,
  make it `pub(crate)`) -> `docs_status_at(&dir)`. `create_project_doc` =
  `scaffold::doc(name)` -> refuse `None` and `!creatable` -> `create_doc_at`.
  A name with a separator is simply not in the catalog.
- `docs_status_at` lists, in catalog order, every entry that is present, plus
  the `creatable` absent ones (ghost rows). Absent `REMARKS.md` and absent
  pointers get no row. `nested_under` is `"AGENTS.md"` for pointers always;
  the frontend nests only when `AGENTS.md` is itself shown.
- `.gitignore` and `.git` are not catalog entries and not in the status: the
  tree already shows them as ordinary rows.
- The catalog-to-`STANDARD_PROJECT_FILES` check (step 4) can iterate `DOCS`
  names + `.gitignore`, `.git`.
- A symlink / FIFO / oversize / non-UTF-8 doc reports `missing` (so a ghost row
  appears for it) but `create_doc_at` refuses to write there (returns false).
  The frontend/command should tell that case apart from "created" by the bool.

### Choices and deviations

- Default docs are `creatable: true` (deleted `README.md` gets a ghost row).
- Repair rewrites only `AGENTS.md` (`ScaffoldDoc::upgradable`): the
  README/other stubs were never rewritten before either.
- `scaffold_is_missing_at` does **not** check `.git` (the plan's text says
  "or (git) no `.git`"): the existing doc comment and tests call `.git` the
  separate `git_type` axis, and counting it would put the tag on every project
  whose `.git` was removed. Say so if you want it added.
- `PROJECT.md` (now create-on-demand) got a new template without the pointer
  files, `REMARKS.md` and `.claude/settings.json` links; the old text is its
  `history` entry. Not in the plan; a stale map linking files that are no
  longer made seemed wrong. Template-state comparison ignores leading/trailing
  whitespace and CRLF (a bare `# Agents` still matches).
- Pointer state: an untouched, empty or legacy-stub `CLAUDE.md`/`GEMINI.md`
  reports `pointer`; a modified one reports `edited`.
- `write_no_follow` stays in `projects.rs` (used by fs.rs, clipboard.rs,
  boxes.rs); `scaffold.rs` imports it from there.

### Known follow-ups for others (not touched here)

- i18n still names `CLAUDE.md` / `.claude/settings.json` in the repair texts
  (`projectSettings...`, `pill.repairScaffoldTitle`) in all five dictionaries (I4).
- `scaffold_preview` no longer returns a `.claude/settings.json` item and
  `migration_steps_at` no longer returns the `claude_settings` step: the
  frontend must not rely on either (I4, step 7).
- `docs/filemap_backend.md` rows (new `services/scaffold.rs`, changed
  `projects.rs`/`remote_scaffold.rs`) are left to I5 as planned.

### Gates

Run with `scripts/gates-job.sh start --base scaffold-files` (the plain run sees
no diff once committed). Frontend gates skipped (no frontend change).
- brand-check PASS, `git diff --check` PASS.
- clippy `-p tabtivity -p app-serverd --all-targets`, daemon-lib clippy, `-p app-serverd` clippy: PASS, zero warnings.
- `cargo test -p tabtivity` lib: 5598 passed, **1 failed**:
  `services::mcp::git_push_mcp::tests::push_branch_patterns_reads_the_yaml_shapes_...`
  (a 5 s wall-clock bound on a YAML alias bomb, took 5.8 s under the full parallel
  run; passes alone in 0.1 s; fails the same way in two full runs; touches nothing
  of ours - looks load-flaky, not checked against `scaffold-files` without my change).
- Integration tests (run separately because the lib failure stops cargo): 144 passed
  (`projects_commands`), 39 passed, 1 passed, 0 failed.
- Daemon build `cargo test -p tabtivity --no-default-features --lib --test server_secrets`:
  5413 + 1 passed. New unit tests: `services/scaffold/tests.rs` (9), rewritten/new
  `commands/projects/tests.rs` scaffold tests, `remote_scaffold` (3). `scaffold`, `projects::`,
  `remote_scaffold` filter: 148 passed.

### Flagged for user

- `.git` is not part of the "no scaffold" tag (see above).
- `PROJECT.md` template changed (see above).

## I2 Agent-home settings

- Commit `5d7bbb410` (cherry-picked from `beb94b39e`, worktree branch `worktree-agent-aa4c8557fd593330f`).
- `agent_hint::register_in_home`: `.gemini/settings.json` gets `add_context_file_names` (via `merge_json`); `.aider.conf.yml` gets new `merge_aider_read` (`serde_norway`). Runs after `agent_global::apply_to_home`.
- Gemini: user entries keep order, missing `GEMINI.md`/`AGENTS.md` appended; string → `[user, GEMINI.md, AGENTS.md]`; non-object `context` or odd `fileName` never replaced.
- Aider: absent `read:` → `[AGENTS.md]`; string → list; list appended; comments-only file keeps text; a rewritten mapping loses YAML comments (accepted, plan §7).
- Extra hardening: `merge_json` reads capped at 1 MiB (also the OpenCode and hook merges) — an over-cap file is left alone instead of read as empty and overwritten.
- Docs: `docs/third_party_update_checklist.md` per-CLI "reads AGENTS.md" note + known gaps; `docs/filemap_backend.md` agent_hint row.
- Gates (worktree, `--base scaffold-files`): brand, whitespace, clippy ×3 PASS. `cargo test -p tabtivity -p app-serverd`: 5589 passed, 2 failed — `voice::session` timeouts under parallel load (pre-existing develop code, untouched); rerun alone 18/18 pass. test-dlib not run there (re-run on the integration branch).
- Flagged for user: no real Aider installed, `verify-cli` not run (behaviour read from Aider source); Aider `read:` is cwd-relative, so a tab started in a subfolder misses it; never live — click-through step 6.

## R1

## I3 Commands

## R2

## I4 Desktop

## I5 Phone + docs

## Final review
