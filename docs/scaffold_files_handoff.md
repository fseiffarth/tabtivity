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

Reviewer R1 of `08e549f87..scaffold-files` (I1 + I2). Branch `worktree-agent-a6275b33ada467acc`
(on top of `scaffold-files` 0fa966b29). Catalog API for I3 is unchanged.

### Checked and found sound

- Writes into the project tree: `create_doc_at` / `write_scaffold_file` are create-new + `O_NOFOLLOW`
  (`write_no_follow`); the only overwrite is `upgrade_doc_at` (AGENTS.md, only while untouched, also
  `O_NOFOLLOW`; link/FIFO/oversize never reach it). Reads all go through `read_record_capped`
  (4 MiB, no-follow, `O_NONBLOCK` + regular-file check).
- `AGENTS.2026-11-13.md` is byte-identical to the AGENTS.md text on `08e549f87`; every history copy
  (also CRLF) still upgrades; the pin test holds both hashes.
- "No scaffold" tag: a project holding the old 10 files + `.claude/settings.json` is not tagged
  (`a_project_holding_all_ten_old_files_reports_nothing_missing`); a missing default (or missing
  `.gitignore` on git projects) still tags; dangling links count as present.
- `migrate_legacy_projects` / import call sites / `migration_steps_at` / `apply_migration_steps_at`
  go through the catalog; step ids `file:` / `stub:` unchanged, `claude_settings` gone.
- `remote_scaffold.rs`: plan only creates catalog defaults + `.gitignore`, create-new over SFTP,
  `committable_paths` stages only scaffold paths that are plain files. No `.claude` logic left.
- I2: `merge_json` over-cap file is left alone for all five callers (`register_in_home` hook merges,
  Gemini, OpenCode config, both `opencode_session` merges); a link at the name is replaced
  (HomeFile rename), never followed; Gemini/Aider merges are append-only and idempotent, a user's
  entries and order stay; non-object `context`, odd `fileName`, non-mapping YAML, bad UTF-8, over-cap
  files are untouched. A 14-level YAML alias bomb (< 1 MiB) is refused by serde_norway quickly
  (now pinned by a test).
- Brand rule: no app-name literal in code in the range (comments only). No `AppHandle` in
  `services/scaffold.rs`.

### Fixed

- `a75485ff1` `agents_empty_at` read a real `AGENTS.md` that is not UTF-8 or is over 4 MiB as
  `Missing`, i.e. "empty": `TerminalAgentsEmptyCard` then invited an agent to fill (overwrite) a file
  with real guidance (the old `read_to_string` said "not empty" for these). A plain file the reader
  cannot take is now not empty; links, FIFOs and absent stay "empty" as the plan says. Test:
  `scaffold::tests::an_unreadable_plain_agents_md_is_not_empty` (failed before).
- `54e314311` `merge_aider_read`: a config that parses to `Null` because it is the scalar `null` / `~`
  (not just comments) got `read:` appended under it, producing invalid YAML. Now left alone. Test: two
  more rows in `an_aider_config_that_is_not_what_we_expect_is_left_alone` (failed before). Same commit
  adds `an_over_cap_or_bomb_config_is_left_exactly_as_it_is` (over-cap JSON for Gemini/OpenCode,
  YAML alias bomb; a pin, passed before too).

### Flagged for user (not changed)

- `docs_status_at` reports a symlinked / non-UTF-8 / over-cap *existing* doc as `missing` with
  `creatable: true`, so it shows a "create" ghost row that `create_doc_at` then refuses (`false`).
  Not harmful (nothing is written), but I3/I4 should either hide the ghost row when
  `present_at` is true or word the refusal; the status API would need a `present` bit for that.
- `upgrade_doc_at` reads, then truncates and writes through a second open: a user save between the
  two (microseconds) would be lost. Pre-existing shape; a single-fd read-check-write would close it.
- `git_scaffold_commit` (new local git project) runs `git add -A`, so an *imported* folder without
  `.git` gets its whole tree committed. Pre-existing and unchanged by this range (the old scaffold
  was in that tree too); the remote path stages only scaffold paths.
- `tests/projects_commands.rs` joins `".claude/settings.json"` as one literal (AGENTS.md wants per
  component; works on Windows anyway).
- Aider/Gemini: nothing new beyond I2's flags.

### For I4 (frontend references to dropped items; not touched)

- i18n, all five dictionaries (`en/de/es/fr/it`): the migration-repair text near `en.ts:2875`
  and `pill.repairScaffoldTitle` (`en.ts:5166`) still name `CLAUDE.md` / `.claude/settings.json`.
- `src/components/projects/ProjectDialog.tsx:69,1202` `AGENT_POINTER_DOCS` + `projectDialog.scaffoldPointsAtAgents`:
  `scaffold_preview` never lists `CLAUDE.md` / `GEMINI.md` now, so that branch is dead.
- `src/lib/projects/scaffold.ts:147,150` (`buildScaffoldFillPrompt`) still tells the agent that
  PROJECT.md maps "the other scaffold files" / pointers.
- `src/lib/viewers/fileUtils.ts:17` `STANDARD_PROJECT_FILES` (+ `FileBrowser.tsx:488`,
  `useFileTreeRows.ts:74`, `mobile-web/.../FilesLibrary.tsx:106`) still hardcode the ten names.
- Fixtures only (string fixtures, no behaviour): `src/__tests__/projects/ScaffoldRepair.test.ts`,
  `ProjectMigration.test.ts`, `agents/ScaffoldAgentFill.test.ts`. No frontend code reads the
  `claude_settings` step id or a `.claude/settings.json` preview item.
- `docs/filemap_backend.md`: `remote/remote_scaffold.rs` row still says `.claude/settings.json`;
  no row yet for `services/scaffold.rs` (I5).

### Gates

`scripts/gates-job.sh start --base 08e549f87` (frontend gates skipped: no frontend change).
- PASS: brand, whitespace, clippy `-p tabtivity -p app-serverd --all-targets`, daemon-lib clippy,
  `-p app-serverd` clippy: zero warnings.
- `cargo test -p tabtivity -p app-serverd` lib: 5606 passed, 1 failed = the known
  `git_push_mcp` YAML alias-bomb 5 s bound; alone it passes (0.14 s), and a second full run
  (`--tests`) was 5607 passed, 0 failed. Integration: `projects_commands` 144, 39, 1, 1 passed, 0 failed.
- test-dlib (`cargo test -p tabtivity --no-default-features --lib --test server_secrets`), run by hand
  because the job stops after a lib failure: 5421 + 1 passed. One earlier run of it failed my new
  `an_over_cap_or_bomb_config_...` once under heavy parallel load (it carried a 5 s wall-clock bound
  I had added); it passes alone and in the next full run, and I removed the bound in the last commit.
- The last commit changes only that test (a deleted timing assert); re-ran `agent_hint` filter (20 passed).

## I3 Commands

Branch `worktree-agent-ada22e8711c75010c` (on `scaffold-files` 3feb70193). Commits: `675119b60`
(R1's two bugs), `add234826` (commands, memory, TS), `0989466ff` (clippy type alias), `48967a5ae` (old status test
updated to the `edited` contract); the handoff commit follows.

### Commands (all `Core`, `async` over `*_blocking`, args hold no path word)

Rust: `commands/project_docs.rs` (registered in `lib.rs` after `project_scaffold_missing`; rows in
`command_class.rs`; `commandClasses.ts` regenerated). TS wrappers: **`src/lib/projects/projectDocs.ts`**
(new file; I4 owns `scaffold.ts`); test `src/__tests__/projects/ProjectDocs.test.ts`.

| Rust command | TS wrapper | Args | Result |
|---|---|---|---|
| `project_docs_status` | `projectDocsStatus(projectId)` | `{ projectId }` | `DocStatus[] \| null` |
| `create_project_doc` | `createProjectDoc(projectId, name)` | `{ projectId, name }` | `boolean` (written?) |
| `project_agent_memory` | `projectAgentMemory(projectId)` | `{ projectId }` | `AgentMemoryEntry[]` |
| `project_agent_memory_read` | `projectAgentMemoryRead(projectId, entry)` | `{ projectId, cli, home, name }` | `string` |

JSON shapes:

- `DocStatus = { name: string; state: "missing"|"template"|"edited"|"pointer"; nestedUnder: string|null; creatable: boolean }`
  in catalog order: AGENTS, README, PROJECT, TODO, ROADMAP, STATUS, DOCUMENTATION, REMARKS, CLAUDE, GEMINI.
  `null` for the whole result = no local folder (unknown project, remote-only, mirror not made, folder gone):
  show no status and no ghost rows. **Ghost row = `state === "missing" && creatable`.**
- **Shape change vs I1 (bug fix a):** a doc that is *there* but is a symlink (dangling too), FIFO, non-UTF-8 or
  over the 4 MiB cap reports `edited` (not `missing`), so it never gets a ghost row; a `CLAUDE.md -> AGENTS.md`
  link now shows as an `edited` row nested under `AGENTS.md`. A real folder named like a doc gets **no row** (the
  tree already lists the folder). No new field or state; `creatable` stays the catalog flag, so key ghost rows on
  `missing`, not on `creatable` alone. Such a row is "somebody's file": no dim, no badge; a link or FIFO may not
  open in a viewer (as before).
- `create_project_doc` rejects (`Err` string) for a name that is not a `creatable` catalog entry (a path, unknown,
  `CLAUDE.md`, `GEMINI.md`, `REMARKS.md`, `.gitignore`) or a project with no local folder. `false` = something is
  already at that name (never overwritten, never followed): refresh the status, don't toast an error.
- `AgentMemoryEntry = { cli: "claude"|"codex"; home: "scope"|"local"; name: string; bytes: number; modifiedSecs: number|null }`.
  Order: per home (scope, then local-model), Claude then Codex, `MEMORY.md` first in each folder, the rest sorted.
  Empty array = nothing (hide the sub-group). **Deviation from the plan** (`(projectId, cli, name)`): the scope home
  and the local-model home can hold the same name, so rows carry `home` and the read takes it.
  The read rejects when the entry is no longer in the listing, over 1 MiB, or not UTF-8: show "not available".

### Agent memory choices

- New `services/agent_memory.rs` (+tests): pure over `Source { kind, home }` + project dirs; the command resolves
  `agent_home::scope_home(Some(id))` and `local_model_home(Some(id))`.
- Claude: `<home>/.claude/projects/<name>/memory/*.md`, `name` = the project dir with every UTF-16 unit that is not an
  ASCII letter or digit turned into `-` (checked in the installed binary 2.1.321:
  `replace(/[^a-zA-Z0-9]/g,"-")`; a name over 200 chars gets a hash suffix we do not reproduce, so such a project
  lists nothing). Both the stored project path and its canonicalization are tried. Codex:
  `<home>/.codex/memories/*.md`, top level only. **Codex's folder is not verified live**: `~/.codex/memories` does
  not exist on this machine; a different or absent folder just lists nothing.
- Everything goes through `home_io` (`HomeDir::open_existing` walks `O_NOFOLLOW` from the home,
  `HomeFile::open_read`/`read_capped`): a linked `.codex`, memory folder or file is refused; FIFOs are never waited on
  (tested with `within_deadline`). Only `.md` names, regular files <= 1 MiB (<= 256 per folder, 200 in all).
  A read looks `(cli, home, name)` up in a fresh scan, so `../x`, `sub/x`, an absolute path or a stale name is refused.

### Bug fixes (R1's two flags)

- (a) `docs_status_at`: see above. Test `something_present_is_never_a_missing_ghost_row`.
- (b) `upgrade_doc_at`: reads the doc (descriptor + inode), writes the template to an exclusive dot-temp beside it
  (`write_no_follow` create-new, the old file's mode copied), re-reads the doc and renames over it only if the inode
  is unchanged and the text still untouched; otherwise removes the temp and returns `false`. The old file is never
  opened for writing. Residual window: between that second read and the `rename` (microseconds): a save there is
  lost, and a link swapped in there is replaced by the rename as itself, not followed. Tests (a `between` hook plays
  the user): in-place save, rename-over with the same bytes (other inode), link swap, no temp left, mode kept.

### Other

- `STANDARD_PROJECT_FILES` dropped `.claude`; `the_ts_fallback_list_is_the_catalog` (scaffold tests) parses the set and
  compares it to the catalog names + `.gitignore`, `.git`. (It is in the second commit; at `675119b60` alone it
  would fail, the TS edit is in `add234826`.)
- `scaffold_target_for_entry` is now `pub(crate)`. Filemap rows added for `project_docs.rs` and `agent_memory.rs`
  only; the rest of step 9 stays with I5.
- `core_dispatch`'s `PATH_NAMED` test passes with no row (`projectId`, `name`, `cli`, `home`).
- No test calls the commands through the project registry (it reads the real state dir); the name checks run before
  the lookup and are tested, the lookup is the same code as `project_agents_empty`.

### Gates

`scripts/gates-job.sh start --base 3feb70193` (final tree 48967a5ae):
- PASS: brand, whitespace, lint-fe, clippy `-p tabtivity -p app-serverd --all-targets`, clippy daemon-lib, clippy `-p app-serverd`
  (zero warnings), `npm run build`, vitest (changed set, incl. new `ProjectDocs.test.ts`).
- `cargo test -p tabtivity -p app-serverd` lib: 5621 passed, 1 failed = the known `git_push_mcp` YAML alias-bomb 5 s bound
  (reruns alone: 1 passed). An earlier run also failed `commands::projects::tests::doc_states_follow_the_capped_no_follow_read`
  - a real consequence of fix (a) (link/FIFO now `edited` in the status); the test now asserts the new contract.
- Integration (`--test it --test projects_commands`, run by hand because the job stops at the lib failure): 183 passed, 0 failed.
- test-dlib `cargo test -p tabtivity --no-default-features --lib --test server_secrets` by hand: 5436 + 1 passed.
- New tests: scaffold 5 (ghost row, upgrade temp/mode, save-during-upgrade, link swap, TS fallback list), `agent_memory` 8,
  `project_docs` 2, vitest 2.

### Flagged for user

- Codex memory folder layout is from docs, not seen on a live Codex (none installed with memories here); Claude's
  encoding was read from the installed binary. Never live: none of the four commands has run against the real app.
- `upgrade_doc_at` keeps a microsecond window (above); closing it fully would need a lock the other writers do not take.

## R2

Reviewer R2 of `3feb70193..scaffold-files` (I3). Branch `worktree-agent-a43cf1f1ad17276de`. **No code change:
no confirmed bug.** Nothing in the range needed a fix; the items below are checked or flagged.

### Checked and found sound

- Names: `create_project_doc` resolves the renderer's `name` only through `scaffold::doc` (exact leaf match) and
  `creatable`, before any project lookup; `..`, `/`, `\`, NUL, absolute, case variants (`todo.md`), trailing space,
  pointers, `REMARKS.md`, `.gitignore` are not catalog names. The write is create-new + `O_NOFOLLOW`
  (`write_no_follow`): a catalog name that is a folder, a link or a FIFO yields `false`, never a write. On a
  case-insensitive FS an `agents.md` makes `AGENTS.md` `AlreadyExists` -> `false`.
- Memory: `cli`/`home`/`name` are only compared with a fresh listing (`scan`), never joined. Folder names come from the
  root with every non-ASCII-alphanumeric turned into `-` (no `..`/separator possible); folders open through
  `HomeDir::open_existing` (`O_NOFOLLOW` walk), files through `HomeFile::open_read` (`O_NOFOLLOW|O_NONBLOCK`, regular
  file checked on the opened inode), read capped at 1 MiB + 1. Linked `.codex`/memory folder/file, FIFO, dir named
  `x.md`, over-cap, non-UTF-8 all refused. A listing returns only `cli`/`home` enums, a leaf name and sizes: no
  path, id or tmux target (mobile_control invariant); `Core` commands are not routed to the phone, and `projectId`
  is looked up in the account's own registry like `project_scaffold_missing`.
- Encoded-cwd collision: each project has its own scope home (`project_key(id)`), so two roots that encode alike cannot
  see each other's folder; `seed_claude_transcripts` already disambiguates by the recorded `cwd`. Two roots of one
  project (stored + canonical) are de-duplicated per `(cli, home, name)`.
- `upgrade_doc_at`: the temp is create-new + no-follow (a planted name, even a link or FIFO, is `AlreadyExists`/error,
  never a target); a save in place, a rename-over (same bytes, other inode), a link swap and a vanished file all back
  off and remove the temp; a swapped-in folder makes the `rename` fail and the temp is removed. `rename` onto a link
  replaces the link itself, never writes through it. Rust's `rename` replaces an existing file on Windows.
- `project_docs_status`: remote-only -> `None` via `scaffold_target_for_entry`; a mirror project reads the mirror;
  unknown/gone folder -> `None`; all four commands are `async` over `*_blocking` (source-scan test); argument keys
  (`projectId`, `name`, `cli`, `home`) hold no `PATH_NAMED` word; TS wrappers match serde (camelCase,
  `string | null` for `Option`); `commandClasses.ts` is current (`the_generated_command_classes_ts_is_current` passes).

### Flagged for user (minor, not fixed: no deterministic regression test, or a design call)

- `upgrade_doc_at` leaves a `.AGENTS.md.<slug>-<pid>-<n>.tmp` behind if the write into the temp fails midway
  (disk full): `write_no_follow(..)?` returns before the cleanup. Rare; the fix is to remove the temp on any error but
  `AlreadyExists`. Not testable without a full disk.
- `upgrade_doc_at` now replaces the inode: a hardlinked `AGENTS.md`, or one with another owner/ACL/xattrs, loses that
  on upgrade (the old in-place write kept it), and a project folder that is read-only while `AGENTS.md` is writable
  now errors (the temp cannot be made) where it used to rewrite. All rare; accepted trade for not truncating a
  concurrent save.
- `HomeDir::names_capped(256)` takes the first 256 names in directory order, then `agent_memory` sorts: in a memory
  folder with more than 256 entries `MEMORY.md` can fall outside the cap and the index is not listed. Agents do not
  write that many notes; fix if wanted: look `MEMORY.md` up by name besides the capped listing.
- `agent_memory::scan` keeps a `HomeFile` (a duplicated directory descriptor) per listed entry, up to 200 at once;
  where the descriptor limit is 256 (macOS default) a very full memory folder would briefly crowd other opens. Fix if
  wanted: `list` needs no handle, `read` only the one it returns.
- Claude keys its auto memory by the git root, so a Tabtivity project that is a subfolder of a repository lists nothing
  (its folder is the repo root's). Not looked up; documented behaviour is "empty list".

### Gates

`scripts/gates-job.sh start --base 3feb70193` (tree = `scaffold-files` `fbd232a8b` + this note): brand, whitespace,
lint-fe, clippy x3, `npm run build` PASS (zero warnings). vitest `--changed`: 2 timing failures under load 10+
(`PdfZoomRaster` "re-arms the commit", `BibCards` 20 s timeout); both pass alone (17 tests). Because the job stops there,
by hand: `cargo test -p tabtivity -p app-serverd --lib` 5622 passed, 0 failed (no load flake this run);
`--test it --test projects_commands` 144 + 39 passed; test-dlib `--no-default-features --lib --test server_secrets`
5436 + 1 passed.

## I4 Desktop

Branch `worktree-agent-ade237d8594501e4d` (on `scaffold-files` fbd232a8b). Commits: `8edff0350` (step 5), `923ecb86e`
(step 7), `89507a3d0` (step 8); the handoff commit follows. All of plan steps 5, 7 and 8 (frontend) are done.

### What is where

- `src/components/files/projectDocsGroup.ts`: pure `buildDocsGroup(standard, status)` -> `{ rows, files, summary }`.
  File rows keep the listing's order, a pointer (`nestedUnder` set and that doc listed) moves under its parent;
  ghost rows (`missing && creatable`, not in the listing) go last in catalog order; `summary` = present defaults
  over `DEFAULT_DOCS` (`AGENTS.md`, `README.md`, hardcoded here: the status has no `default` flag) plus the count of
  `template` rows (pointers never count). No status -> no ghosts, no states, `summary: null`.
- `useProjectDocs.ts`: `useProjectDocsStatus` (fetch only while the tree is on screen via `active` and
  `PaneVisibleContext`, at the root, a local listing, `separateScaffold` on; re-asked when `entries` changes, i.e.
  after an fs-change refresh), `useDocsGroupOpen` (localStorage `fileTree.docsExpanded.<projectId>`, try/catch,
  closed by default), `useAgentMemory`.
- `FileTree.tsx`: group now renders FIRST (above the regular rows, as in the plan's sketch; it used to be below),
  header "Project docs  2/2 · 1 template" (plain "Project docs (n)" when there is no status), `DocGhostRow`
  (one `<button class="file-entry doc-ghost">`: no `data-entry-path`, not draggable, no context handler, never in
  `rowWindow`/`orderedVisible`), template/pointer badges (`.file-doc-badge`), `.doc-template` dim and `.doc-nested`
  indent classes (the `.scaffold` class is untouched and still used by the gitignored/hidden sections). Clicking a
  ghost calls `createProjectDoc`, refreshes listing + status, opens the file as a double-click would; `false` is
  silent, a rejection shows a message. The row cap clips only file rows (`rowWindow.standard` is
  `docsGroup.files`).
- `useFileTreeRows.ts` takes `docsStatus`, returns `docsGroup`; shift-range order is docs, regular, gitignored, hidden.
- `ScaffoldTagPopover.tsx` + `projectTypeTags.ts` (optional `onScaffoldClick` -> `tag.onClick`; hover card and
  switcher pass nothing, stay labels) + `ProjectFilesView.tsx` (tag becomes `role=button`, popover anchored under it,
  `project_scaffold_missing` re-asked after Repair). Popover lists the missing `DEFAULT_DOCS` from
  `project_docs_status`; every default present -> names `.gitignore` (the only other thing the tag fires for);
  no status -> a generic sentence. Not offered for a remote-only project.
- `FileBrowser.tsx`: its own `showStandardFiles`/`separateScaffold` toggles are gone; reads
  `panel_separate_scaffold` from `get_project_panel_prefs` (default on); off = docs sort into the normal list. Keys
  `fileBrowser.scaffold`/`separateScaffold` deleted from all five dictionaries.
- Step 7: `buildScaffoldFillPrompt` has no pointer lines, PROJECT.md/REMARKS.md advice only when that file is in the
  list; repair/migration/tour/`pill.repairScaffoldTitle` texts no longer name `CLAUDE.md`/`.claude/settings.json`
  (all five languages); fixtures in `ScaffoldRepair`, `ProjectMigration`, `ScaffoldAgentFill` tests. `migration.ts`,
  `ProjectMigrationDialog` and `summarizeScaffoldRepair` needed no code change (the dialog renders by `kind`; no
  per-id label existed). `ProjectDialog` needed no logic change: the preview already lists only what
  `scaffold_preview` returns; `AGENT_POINTER_DOCS` kept (plan) with a corrected comment, it is dead for new previews.
- Step 8: `AgentMemoryDialog.tsx` (`DialogShell` `project-dialog` frame, `renderMarkdown` + `onMarkdownLinkClick`, read
  through `projectAgentMemoryRead`), sub-header "Agent memory (n)" collapsed, rows show a CLI badge
  (`Claude`/`Codex`, plus "local model" for the local home) and size; hidden when the list is empty; re-asked
  each time the Project docs group is unfolded (the files live in the agent home, no fs-change announces them).
- i18n: new keys in all five languages (`fileTree.docs*`, `fileTree.doc*`, `fileTree.agentMemory*`, `agentMemory.*`,
  `projectType.scaffoldPopover*`); reworded `fileTree.scaffoldSection`/`collapse`/`expandScaffold`/`totalSizeScaffold`,
  `projectSettings.separateScaffold*`, `treeGroupingHelp`, `fileBrowser.scaffoldDivider`,
  `projectType.titleMissingScaffold`. Untested register: `fileTree.docsSection`, `projectType.scaffoldPopover`,
  `fileTree.agentMemory`.

### Gotchas for I5 / reviewers

- The phone reads the SAME dictionaries: `fileTree.scaffoldSection` is now "Project docs ({count})" there too, and
  `MobileProjectFiles.test.tsx` expects the button name "Project docs (2)" (I changed three strings). I5 reshapes it.
- `STANDARD_PROJECT_FILES` still drives which listing entries enter the group; the status only adds states, nesting
  and ghosts. `DEFAULT_DOCS` is a second hardcoded list (no Rust pin test; a catalog `default` flag in the status
  would remove it, but R2 froze the shapes).
- The group's position moved above the regular rows. `rowWindow` spends the row-cap budget docs first.
- The status is fetched only for a local root listing; with the project in "Remote" source view or remote-only it is
  `null` and the old plain count shows (no ghosts) - by plan.
- Rendering a missing-but-listed doc: a listed row whose status says `missing` is shown as `edited` (listing wins).
- `useProjectDocsStatus` clears on project change with an effect; the first frame after a switch may still show the
  last project's states for one render (the FileTree is normally remounted per project anyway).
- Gate flake seen once: `TerminalAiSwitch.test.tsx` failed in a full run, passes alone (twice).

### Gates

`scripts/gates-job.sh start --base fbd232a8b` on the final tree (27 files, frontend only; Rust gates skipped, no Rust
change): brand PASS, whitespace PASS, lint-fe PASS (0 errors, 30 warnings, none in the files I added/changed:
`eslint` on them reports only 3 pre-existing `exhaustive-deps` warnings in FileBrowser/ProjectFilesView), `npm run
build` PASS, vitest PASS (the step-7 run before the last fixes: 867 files, 8820 tests, 2 failures fixed/flaky; the
final run all passed). New tests: `ProjectDocsGroup.test.ts` (8), `ProjectDocsTree.test.tsx` (5),
`ScaffoldTagPopover.test.tsx` (6), `AgentMemory.test.tsx` (4); `ScaffoldAgentFill.test.ts` gained one.

### Click-through (never run live)

1. Open a project with the Files panel; the root shows "▸ PROJECT DOCS 2/2" above the folders. Open it: AGENTS.md
   (dim + "template" while untouched), README.md, .gitignore, then "+ PROJECT.md create" ... "+ DOCUMENTATION.md create".
   Close and reopen the app panel: the fold is remembered for this project only.
2. Click "+ TODO.md": the file appears, opens in the editor, the ghost row is gone. Edit AGENTS.md, save: the
   template badge and dimming go, the header drops "· 1 template".
3. An old project with CLAUDE.md/GEMINI.md: they sit indented under AGENTS.md with a "pointer" badge, not dimmed.
4. Delete README.md on disk: the amber "no scaffold" tag appears; click it: popover "Not in the project folder:
   README.md" + Repair; Repair adds it and the tag goes. Hover card tags stay plain labels.
5. Project Settings -> turn "Separate project docs section" off: tree and Files (browser) tab both sort the docs
   into the normal list, no ghost rows.
6. If Claude has saved memories for the project: expand the group -> "▸ Agent memory (n)"; expand, click MEMORY.md:
   read-only preview dialog with rendered markdown. No memories: no sub-group.

### Flagged for user

- The group now sits ABOVE the file list (plan sketch), collapsed by default; say if it should stay at the bottom or
  start open.
- Remote-only / "Remote" source views get no ghost rows or status (plan decision); only the plain count.
- `DEFAULT_DOCS` hardcodes AGENTS.md + README.md on the frontend; a `.gitignore` is counted by the tag but not by the
  header summary.
- All of this is never live (UntestedTag on the group header, the tag popover, the memory sub-group).

## I5 Phone + docs

Branch `worktree-agent-a7e77b24eb092f724` (on `scaffold-files` 988c4af8e). Commits: `50be79b79` (`isDefault`),
`908f4e73b` (phone backend: listing `docs` + create route + tests), `3c398e073` (phone UI, i18n, register),
`674455e39` (step 9 docs); the handoff commit follows. Plan steps 6 and 9 are done; agent memory on the phone is
deferred, as planned.

### `isDefault` (the small addition)

`services::scaffold::DocStatus` gained `is_default: bool` (serde `isDefault`, the catalog's `default`): AGENTS.md and
README.md. Same flag in `DocStatus` (TS). The hardcoded `DEFAULT_DOCS` is gone: `buildDocsGroup`'s `present/total` is
`status.filter(isDefault)`, and `ScaffoldTagPopover` lists `status.filter(isDefault && missing)`. No other shape
changed. **New file `src/lib/projects/docStatus.ts`** holds `DocState`/`DocStatus` (no Tauri import);
`projectDocs.ts` re-exports them, so desktop imports are unchanged. It exists because
`MobileSteeringImports.test.ts` walks the phone's import graph and fails on any module that imports `@tauri-apps`
(even for a type) - the phone and `projectDocsGroup.ts` import from `docStatus`. Rust pin: the scaffold status test
asserts the flagged rows are exactly `scaffold::defaults()`.

### Routes (`mobile_control/project_docs.rs`, wired in `host.rs`)

- `GET /api/v1/projects/{id}/files` (root of this computer's side only; not in a folder, not `&on=host`) adds
  `docs: DocStatus[]` = `[{ name, state: "missing"|"template"|"edited"|"pointer", nestedUnder: string|null, creatable,
  isDefault }]`, catalog order, the exact desktop shape. Names only. Read by `docs_status_at` under `deadline::local`;
  a timed-out/stalled read **omits** `docs` (the listing still answers) and the phone shows the plain group.
- `POST /api/v1/projects/{id}/files/docs?name=<leaf>` (no body; 1 KiB body limit). Guards = `upload_scope` (session,
  exact origin, `files_off`/`project_not_found`/`uploads_off`). `name` is matched against the catalog's *creatable*
  leaves (`scaffold::doc(..).creatable`), never joined: a path, unknown name, `CLAUDE.md`, `GEMINI.md`, `REMARKS.md`,
  `.gitignore`, a case variant, empty -> `400 invalid_request`. Write = `create_doc_at` (create-new, `O_NOFOLLOW`),
  off the executor under `deadline::local`. `201 {"entry": <sealed listing row>}`; taken name -> `409 already_exists`
  (nothing touched); IO -> `500 write_failed`; stalled mount -> `504 timeout`. No upload-log entry, no Undo.
- Tests (`host/tests.rs`): a row for the create route in all three refusal matrices (assistant scope, folder-less
  project, "unknown id answers like a stranger"); new `the_root_lists_its_catalog_docs_and_a_ghost_row_creates_one`
  (files off / uploads off / wrong origin write nothing; `docs` only at the root; states, `isDefault`; create, 409, the
  400 name matrix; no host path or raw id in any body). Module tests in `project_docs.rs` (3). All cross-OS (tempdir,
  `Path::join`).

### Phone UI (`mobile-web/src/components/FilesLibrary.tsx`)

- `sectionsOf` runs the desktop's `buildDocsGroup` (made generic over the entry type) over the sorted standard files
  and the listing's `docs`. `docsSection()` replaces the old scaffold fold: header "Project docs  2/2 · 1 template"
  (the desktop's keys `fileTree.docsSection/docsSummary/docsTemplates*`; plain "Project docs (n)" with no status),
  template/pointer pills (`fileTree.docTemplate/docPointer` + titles), only `template` rows dimmed (`files-folded`),
  pointer files nested (`files-doc-nested`), ghost rows (`+ name`, "create" pill) after the files.
- **Position:** the group leads the list, like the desktop (the old phone fold came last). `MobileProjectFiles` sort test
  updated accordingly. Say if the phone should keep it at the end.
- **Create:** tap a ghost row -> option sheet titled with the name, one choice "Create" (`mobile.files.docs.*`) ->
  `createProjectDoc` -> relist and open the new file in the viewer. `already_exists` relists and says so; `uploads_off`
  /`files_off` say uploads are off; anything else "could not be created" (a `p.sheet-note.error`). Ghost rows show only
  when `listing.uploads === true` and not on the host side (read-only, no status there: the host side never gets `docs`).
- Fold persisted per project in `libraryView.ts` (`readDocsOpen`/`writeDocsOpen`, key `mobile.filesDocsOpen`, array of
  project ids, try/catch via `readJson`/`writeJson`); shut by default. The gitignored fold stays unpersisted as before.
- i18n: six new keys `mobile.files.docs.*` in en/de/es/fr/it. UntestedTag-equivalent on the phone: register row
  `mobile.files.docs` (`untested.ts`), included in the library header's `untested` pill expression like its siblings.
- Tests: new `MobileProjectDocs.test.tsx` (5); `MobileProjectFiles.test.tsx` expectation moved (group first).

### Docs (step 9)

Filemap rows: backend `services/scaffold.rs` (new), `mobile_control/project_docs.rs` (new), `projects.rs` and
`remote_scaffold.rs` rows corrected; frontend `FilesLibrary.tsx`, `libraryView.ts`, the projectDocs row (`docStatus.ts`,
generic builder). `docs/guide/building.md` and `DOCUMENTATION.md` ("Scaffold Files": lean set, on-demand docs, the
Project docs group, repair/tag semantics) rewritten; README step 2 no longer promises CLAUDE.md/GEMINI.md;
`docs/context/mobile_access.md` gained a "Project docs" paragraph in the upload section (threat note).
The rest of README was checked: no other pointer mention.

### Phone click-through (never run live; needs a restart of the desktop window for the new route)

1. `npm run backend:stale` says the running window lacks the route: the new `docs` array and `files/docs` exist only
   after the desktop is restarted/rebuilt; an old window answers no `docs` (the phone shows the old plain group) and
   404/405 on create.
2. Phone -> project -> Files (settings: "Project files on the phone" on; for Create also "Phone may add files to
   projects"). Root: "Project docs 2/2" first, shut. Open it: AGENTS.md (dim + "template" while untouched), README.md,
   then ghost rows "+ PROJECT.md create" ... (only with uploads on).
3. Tap "+ TODO.md" -> sheet "TODO.md" -> Create: the file is made on the desktop and opens in the viewer; back in the
   library the ghost row is gone and the header says "· 1 template".
4. Edit it on the desktop (or the phone): the pill goes. Close/reopen the library: the fold is as left. A project with
   CLAUDE.md: indented under AGENTS.md with a "pointer" pill, not dimmed.
5. Switch uploads off on the desktop: ghost rows vanish, pills and summary stay. Remote project, "Remote computer" side:
   the plain count, no ghost rows.

### Gates

`scripts/gates-job.sh start --base 988c4af8e` on tree `674455e39` (exit 0, 20m44s), all ten PASS: brand, whitespace,
lint-fe (no new warnings), clippy `-p tabtivity -p app-serverd --all-targets`, clippy daemon lib, clippy `-p app-serverd`
(zero warnings), `npm run build` (tsc 7 + desktop, mobile, web bundles; the mobile bundle was rebuilt by it), vitest
`--changed` (changed set), `cargo test -p tabtivity -p app-serverd`, test-dlib `--no-default-features --lib --test
server_secrets`. No load flake this run. The job log keeps no per-suite counts; by hand before the job: the new route
test + 3 `project_docs` module tests + the scaffold `is_default` assertion pass; vitest `src/__tests__/mobile` +
`src/__tests__/files`: 280 files, 2850 tests (the one failure, `MobileSteeringImports` flagging `projectDocs.ts` ->
Tauri, was fixed by `docStatus.ts` before the job); `MobileProjectDocs.test.tsx` 5 of 5. `npm run mobile:bundle` ran
as part of `npm run build`.

### Flagged for user

- The docs group now leads the phone list (desktop parity; before it was last).
- Phone shows no status for the remote side of a remote project (plan), and none from an older desktop (graceful: the
  plain group), so a phone updated before its desktop shows no ghost rows or pills.
- Create does not write an upload-log entry or notice on the desktop (plan); the new file is untracked until the user
  commits it, like any new file.
- A Create on the phone writes a file the agents then read (`AGENTS.md`/`TODO.md`...): the same note as a root Makefile
  upload (`mobile_access.md`), nothing new in kind.
- Never live: neither the route nor the group has run against the real desktop.

## Final review
