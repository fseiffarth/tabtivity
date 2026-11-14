# Scaffold files: a lean default set and a "Project docs" group

Status: in implementation (2026-11-13, plan + implement + review routine;
handoff in `docs/scaffold_files_handoff.md`). Three research subagents
(agent-instruction files, doc files, display) read the code and searched the
web; their findings are condensed below. The user answered the five open
decisions on 2026-11-13; they are recorded under **Fixed decisions** —
reviewers may not undo them. Plan review done 2026-11-13 (paths checked
against the code, §3a filled, steps and organisation re-cut); its notes are in
the handoff under "Plan review".

---

## 1. Why

A new project gets ten root docs, `.gitignore` and `.claude/settings.json`
(`SCAFFOLD_FILES`, `src-tauri/src/commands/projects.rs:3490`; `CLAUDE_SETTINGS`
`:3577`). Most of them are noise:

| File | Who reads it | Finding |
|---|---|---|
| `AGENTS.md` | every wrapped CLI except Gemini CLI; `agents_empty_at` (`projects.rs:4233`) → `TerminalAgentsEmptyCard` | load-bearing |
| `CLAUDE.md` pointer | Claude Code < 2.1.277 only | Claude Code ≥ 2.1.277 reads `AGENTS.md` itself, but **only when no `CLAUDE.md` exists**: a pointer that loses its `@AGENTS.md` line silently drops `AGENTS.md`. Installed: 2.1.323 |
| `GEMINI.md` pointer | Gemini CLI (default `context.fileName` is `GEMINI.md`) | Antigravity, Codex, OpenCode, Vibe, Copilot and Cursor read `AGENTS.md` |
| `.claude/settings.json` | nothing but `claude_settings_present` (`:4042`) | empty `allow`/`deny` does nothing; it only makes the "no scaffold" tag fire |
| `README.md` | nothing in the app; git hosts and people by convention | keep |
| `PROJECT.md` | nobody parses it; it links mostly-empty files | a 2026 study (arXiv 2602.11988) found repo overviews don't help agents find files |
| `TODO.md`, `ROADMAP.md`, `STATUS.md`, `DOCUMENTATION.md` | nobody (the to-do board is `calendar.json`) | empty stubs |
| `REMARKS.md` | `src/lib/projects/projectRemarks.ts`, `stores/projectRemarks.ts:88` — experimental `project_remarks`, off by default | handles a missing file already and carries its own `REMARKS_TEMPLATE` |
| `.gitignore` | git | keep |

`scaffold_is_missing_at` (`:4021`) checks every entry, so deleting a useless
stub earns the amber "no scaffold" tag — the app nags users into keeping
empty files.

The display has its own problems (`src/components/files/FileTree.tsx:3069`,
`src/components/files/useFileTreeRows.ts:73`, `mobile-web/src/components/FilesLibrary.tsx:106`):

- every scaffold row is dimmed (`.file-entry.scaffold { opacity: .65 }`,
  `src/styles/file-tree.css:1405`), so an edited `AGENTS.md` looks disabled;
- missing files are invisible; the only signal is a boolean tag that is not
  clickable, never names the file, and is always false for remote-only
  projects (`scaffold_target_for_entry`);
- an untouched `# Roadmap` stub looks like a real doc;
- the section's open state resets on remount (`FileTree.tsx:633`; the
  gitignored section persists), and on the phone (`FilesLibrary.tsx:467`);
- `FileBrowser.tsx:74` keeps its own `separateScaffold`/`showStandardFiles`
  state and ignores the project pref `panel_separate_scaffold`;
- `STANDARD_PROJECT_FILES` (`src/lib/viewers/fileUtils.ts:17`) duplicates the
  Rust list with no test tying them together;
- Repair is reachable only from the project pill's context menu
  (`ProjectPill.tsx:1962`).

## 2. Fixed decisions (user, 2026-11-13)

1. **Lean default set.** New projects get `AGENTS.md`, `README.md`, and
   `.gitignore` (git projects only). `PROJECT.md`, `TODO.md`, `ROADMAP.md`,
   `STATUS.md`, `DOCUMENTATION.md` become *create on demand* from the docs
   group. `REMARKS.md` is created by the remarks feature on the first remark.
   `.claude/settings.json` is no longer scaffolded.
2. **No pointer files.** `CLAUDE.md` and `GEMINI.md` are not scaffolded.
   Gemini inside Tabtivity reads `AGENTS.md` because Tabtivity sets
   `context.fileName` in its own Gemini agent homes (never in the project,
   never in the user's own config).
3. **Display: "Project docs" group with status** on desktop and phone (design
   A of the display research; §4).
4. **Existing projects keep their stubs.** Nothing is deleted. Old stubs show
   as `template`; the tag stops nagging for files no longer in the default set.
5. **Project memory = show the CLIs' own memories, read-only.** No
   `MEMORY.md` in the project and no optimizer of Tabtivity's own. Claude
   Code's auto memory and Codex's memories already live per scope in the
   agent home and are maintained by their CLIs (Claude: the model writes it,
   *Auto Dream* consolidation reportedly rolling out; Codex: background
   extraction, preview behind a flag). The docs group gets an "Agent memory"
   entry that lists them (§4, step 8).

Decided 2026-11-14 (after the run): the `.gitignore` kind is **detected
from the folder**, no dialog field. The generic list stays whole; a detected
kind only adds its section (`scaffold::GITIGNORE_SECTIONS`, LaTeX first) at
create, import, git re-enable and Repair. Remote-only projects (scaffolded on
the host) keep the generic list.

## 3. Model: one catalog, three states

Replace the flat `SCAFFOLD_FILES` with a catalog in a **new
`src-tauri/src/services/scaffold.rs`** (pure, `AppHandle`-free, no project
list access; `projects.rs` is god module #1 and keeps only the callers):

```rust
pub struct ScaffoldDoc {
    pub name: &'static str,          // "AGENTS.md"
    pub template: &'static str,      // what create writes
    pub default: bool,               // written for a new project
    pub creatable: bool,             // has a "create" ghost row / button
    pub pointer: bool,               // CLAUDE.md / GEMINI.md: nested under AGENTS.md
    pub history: &'static [&'static str], // earlier shipped texts, byte for byte
}
```

- `default: true`: `AGENTS.md`, `README.md`. `.gitignore` stays its own
  rule (git only, appended defaults via `ensure_gitignore_defaults`).
- `default: false, creatable: true`: `PROJECT.md`, `TODO.md`, `ROADMAP.md`,
  `STATUS.md`, `DOCUMENTATION.md`.
- `default: false, creatable: false`: `REMARKS.md` (created by the remarks
  feature on the first remark; template = `REMARKS_SCAFFOLD`, which a Rust test
  pins byte-for-byte to `REMARKS_TEMPLATE` in `projectRemarks.ts`), and the
  two pointers `CLAUDE.md`, `GEMINI.md` (`pointer: true`; catalog entries only
  so existing pointers are recognised and shown nested; no create button).
- `history` holds every earlier template, including today's stubs
  (`"# TODO\n"`, `"# Roadmap\n"`, …) and `AGENTS_HISTORY`/`LEGACY_AGENT_STUBS`
  (move them over; `scaffold_history/*.md` stay where they are, `include_str!`
  path adjusted), so `template` is recognisable for files written by any
  older build. **Step 2 adds the AGENTS.md text shipped today as the newest
  history file** (`scaffold_history/AGENTS.2026-11-13.md`).

State per entry, from one capped no-follow read (`read_scaffold_doc`, which is
`home_io::read_record_capped`; keep it as the only reader):

- `missing`: nothing there (or not a plain file: links/FIFOs are never stubs);
- `template`: bytes equal `template` or an entry of `history`
  (CRLF-normalised, like the existing stub check), or empty/whitespace;
  for a `pointer` entry this state is reported as `pointer`;
- `edited`: anything else.

Rules that fall out (decided in plan review):

- `scaffold_is_missing_at` becomes "a `default` entry is `missing` (a symlink or
  dangling link counts as present, as today), or (git) no `.gitignore`, or (git)
  no `.git`". **It no longer treats a `template`-state `AGENTS.md` as missing.**
  Today it does (the repair would rewrite the file), but step 2 moves the text
  every existing project holds into `history`, so keeping that would put the
  amber tag on every existing project the moment this ships (decision 4: the
  tag must not nag). A repair (button, the migration dialog's `upgradeStub`
  step, and the once-per-legacy-entry startup `migrate_legacy_projects`) still
  rewrites a byte-identical history copy of **`AGENTS.md` only**; pointers are
  never rewritten any more (their legacy `# Claude Context` stubs just show as
  `pointer`).
- `agents_empty_at` (drives `TerminalAgentsEmptyCard`) becomes "AGENTS.md state
  is `missing` or `template`" on the same reader; today it uses an uncapped
  `fs::read_to_string` that follows a symlinked `AGENTS.md`.
- `claude_settings_present`, `scaffold_claude_dir`, the `claude_settings`
  migration step and `.claude/settings.json` in `scaffold_preview` go away.
  `CLAUDE_SETTINGS` is deleted (nothing reads an old file).
- `scaffold_preview` (import dialog) lists the `default` entries,
  `.gitignore`, `.git`; nothing else.
- Remote-only projects (`scaffold_target_for_entry` is `None`) get **no** status,
  ghost rows or create in this plan: the host listing already shows the docs
  that exist. Creating a remote-only project's host scaffold
  (`remote_scaffold.rs`) follows the lean default set (step 1).

## 3a. Which CLIs read AGENTS.md

Researched 2026-11-13 (plan review) for every id in
`services/agent/agent_registry.rs` (30). "Native" = read from the project
folder with no setting. Source tags: **O** official docs fetched that day,
**R** this repo's code or earlier research, **T** third-party/secondary only
(unverified, mark in handoff), **-** nothing found.

| id | Default instruction file | AGENTS.md native? | User-level setting to add it | Source |
|---|---|---|---|---|
| claude | `CLAUDE.md` | yes, **only if no `CLAUDE.md`/`CLAUDE.local.md` in cwd or any parent** (≥ 2.1.277); a stray `~/CLAUDE.md`-style parent file masks it | none needed; none possible beyond a `CLAUDE.md` import | O code.claude.com/docs/en/memory |
| codex | `AGENTS.override.md`, `AGENTS.md` | yes | n/a | O learn.chatgpt.com (ex developers.openai.com) agents-md |
| antigravity | `AGENTS.md`, `GEMINI.md`, `.agents/rules/*.md` | yes | n/a. Shares `~/.gemini/GEMINI.md` with Gemini CLI | O antigravity.google/docs/rules (via search) |
| gemini | `GEMINI.md` | **no** | **yes**: `~/.gemini/settings.json` → `context.fileName` = `["GEMINI.md","AGENTS.md"]` (string or array; keep `GEMINI.md` first, the first name is where `save_memory` writes) | O github.com/google-gemini/gemini-cli docs/cli/gemini-md.md |
| vibe | `AGENTS.md` (project, trusted folder; `~/.vibe/AGENTS.md`) | yes | n/a | O docs.mistral.ai/vibe/code/cli/agents (via search) + R `VIBE_INSTRUCTIONS` |
| kiro | `.kiro/steering/*`, `AGENTS.md` (workspace root, subdirs, `~/.kiro/steering/`) | yes (CLI too) | n/a | O kiro.dev/docs/steering |
| cline | `.clinerules/`, `AGENTS.md` | yes (docs list it as a supported rule type) | n/a | O docs.cline.bot/customization/cline-rules |
| aider | none (`--read`/`/read` only) | **no** | **yes**: `~/.aider.conf.yml` → `read: [AGENTS.md]` (string or list; cwd-relative, loaded home → git root → cwd) | O aider.chat/docs/config/aider_conf.html, /usage/conventions.html |
| opencode | `AGENTS.md` (falls back to `CLAUDE.md`), `~/.config/opencode/AGENTS.md` | yes | n/a (`instructions` array already used for the hint) | O opencode.ai/docs/rules |
| cursor-agent | `.cursor/rules`, `AGENTS.md`, `CLAUDE.md` | yes (project root) | n/a | O cursor.com/docs/cli/using |
| copilot | `.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` | yes | n/a | O docs.github.com copilot-cli add-custom-instructions |
| droid | `AGENTS.md` (also `CLAUDE.md`), `~/.factory/` | yes | n/a | O docs.factory.com/cli/configuration/agents-md |
| grok | `AGENTS.md` variants, `CLAUDE.md` variants, `.grok/rules/*.md` | yes | n/a | O docs.x.ai/build/features/project-rules (via search) |
| qwen | `QWEN.md` and `AGENTS.md` | yes since 0.11.1 (PR #2018, merged 2026-03-02); official settings page still lists `context.fileName` default as undefined | `context.fileName` only if an old build is installed (`~/.qwen/settings.json`); not set by this plan | O qwenlm.github.io memory page + T PR #2018 |
| openclaw | its own workspace `AGENTS.md` (`~/.openclaw/workspace`) | **not the project's**: a different file by design | none (and none wanted) | O docs.openclaw.ai/concepts/agent-workspace |
| auggie | `AGENTS.md`, else `CLAUDE.md`; `~/.augment/rules/` | yes | n/a | O docs.augmentcode.com/cli/rules |
| kilo | `AGENTS.md` ("loaded automatically"); `instructions` key in global `kilo.jsonc` | yes | n/a | O kilo.ai/docs/customize/agents-md |
| continue | `.continue/rules`, `--rule` | undocumented fallback `AGENTS.md` → `AGENT.md` → `CLAUDE.md` (T); the CLI may be winding down (T) | none found | T thepromptshelf.dev, O docs.continue.dev/cli/configuration (no mention) |
| junie | `.junie/AGENTS.md`, then `AGENTS.md`; `~/.junie/AGENTS.md` | yes | n/a | O junie.jetbrains.com/docs/guidelines-and-memory.html |
| codebuddy | `CODEBUDDY.md`, else `AGENTS.md` | yes while no `CODEBUDDY.md` | none (settings page has no file-name key; `memory.parentDiscovery` only) | O codebuddy.ai/docs/cli/memory, /settings |
| goose | `AGENTS.md`, `.goosehints` | yes (default `CONTEXT_FILE_NAMES=["AGENTS.md",".goosehints"]`) | n/a | O goose-docs.ai using-goosehints |
| pi | `AGENTS.md`, else `CLAUDE.md` (`AGENTS.override.md` first); `~/.pi/agent/` | yes | n/a | T pi.dev docs / jsdelivr usage.md (README itself silent) |
| plandex | none found | **no / unknown** | none found | - (searched; nothing documents an instruction file) |
| swe-agent | none (YAML templates) | **no** | none | - (searched; nothing) |
| mini-swe-agent | none (YAML templates) | **no** | none | - (docs page silent) |
| crush | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CRUSH.md` variants, `options.context_paths` | yes | n/a | T mintlify.com/charmbracelet/crush context-files (docs.mintlify mirror) |
| amp | `AGENTS.md` → `AGENT.md` → `CLAUDE.md`; `~/.config/amp/AGENTS.md` | yes | n/a | T secondary sources (manual page not fetchable) |
| kimi | `AGENTS.md` (`.kimi-code/AGENTS.md`, `$KIMI_CODE_HOME/AGENTS.md`, `~/.agents/AGENTS.md`) | yes | n/a | O kimi.com/code/docs/en/kimi-code-cli/customization/agents |
| qoder | `AGENTS.md`, `AGENTS.local.md`, `~/.qoder/AGENTS.md` | yes | n/a | T docs.qoder.com/cli/memory (search snippet; page fetch 404) |
| muse | `AGENTS.md` (`muse init`), falls back to `CLAUDE.md` | probably yes | none known | T codersera/others; Meta's own docs not found — **unverified** |

Summary:

- **Need a Tabtivity-written setting (two):** `gemini`
  (`.gemini/settings.json` → `context.fileName`), `aider`
  (`.aider.conf.yml` → `read`). Step 3 / agent step I2.
- **Cannot be fixed under decision 2** (no project pointer file, no user-level
  hook to AGENTS.md found): `plandex`, `swe-agent`, `mini-swe-agent` (no
  instruction-file concept found at all), `continue` (only an undocumented
  fallback), `openclaw` (reads its own workspace file by design). These are
  recorded as a known gap, not a blocker: none of them is an "agent with
  project instructions" in the first place. `muse` is unverified; the
  implementer of I2 runs the `verify-cli` harness against it if installed.
- **Conditional natives:** `claude` (a `CLAUDE.md` anywhere above the project
  hides `AGENTS.md`), `codebuddy` (a `CODEBUDDY.md` does), `opencode` (a
  `CLAUDE.md` is only a fallback). Nothing to set.
- **Re-check on CLI bumps:** the `verify-cli` skill / third-party checklist row
  for each CLI gets "reads `AGENTS.md`: yes/no" so a drift shows up there.

## 4. Display design

Desktop (`useFileTreeRows.ts`, `FileTree.tsx`, `file-tree.css`) and phone
(`FilesLibrary.tsx` `sectionsOf`/`section()`), same rules:

```
▾ Project docs   2/2 · 1 template
    AGENTS.md          template
      └ CLAUDE.md      pointer
    README.md
    .gitignore
    + PROJECT.md       create
    + TODO.md          create
  src/
  main.tex
```

- The group replaces the root "scaffold (n)" fold; it is still governed by
  `panel_separate_scaffold` (off = files sort into the normal list, ghost rows
  hidden). Root only, as today.
- Header summary: `<present defaults>/<defaults>`, plus `· n template` when any
  shown doc is still a template. `pointer` rows do not count as templates.
- Badges: `template` (muted pill), `pointer` for a nested pointer file. Edited
  files get no badge and **no dimming**; only `template` rows (not `pointer`
  rows) are dimmed. The dimming is its own class (`.file-entry.doc-template`):
  today's `.file-entry.scaffold` (`file-tree.css:1405`) is shared by the
  gitignored and hidden-ending sections (`FileTree.tsx:3033`) and keeps its
  look there.
- `CLAUDE.md`/`GEMINI.md` nest under `AGENTS.md` (one level, read-only nesting:
  selection and shift-range use the flattened order). If `AGENTS.md` is missing
  they show as ordinary rows of the group.
- Missing catalog entries with `creatable` show as ghost rows (`+ name`,
  `create`). Clicking creates that one file from its template
  (`write_scaffold_file`: create-new, no-follow) and opens it. Ghost rows are
  not files: no selection, no drag, no context menu, excluded from `rowCap`
  counts.
- Open state persisted like the gitignored section (localStorage key per
  project, wrapped in try/catch).
- The header's "no scaffold" tag in `ProjectFilesView.tsx:1261` (built by
  `projectTypeTags.ts:115`) becomes clickable: a popover (shared menu frame,
  `add-menu` skill) listing the missing defaults and a Repair button
  (`repairProjectScaffold`). The same tag in `ProjectHoverCard.tsx:122` and
  the project switcher stays a plain label (a hover card is not a click
  target); `projectTypeTags` takes an optional `onClick` only the files view
  passes. The popover gets the names from `project_docs_status`.
- `FileBrowser.tsx` (`src/components/files/`) reads `panel_separate_scaffold`
  instead of its own `separateScaffold`/`showStandardFiles` state.
- Phone: the same group in the library root; ghost rows → item menu "Create";
  the host side (`&on=host`) of a remote project is read-only (no create, as
  Upload today).

State comes from a new command, not from name matching in TS:

- `project_docs_status(projectId) -> Option<Vec<{ name, state, nestedUnder?, creatable }>>`
  — `None` when the project has no local scaffold target (remote-only, mirror
  not yet made). `#[cfg_attr(feature = "desktop", tauri::command)]`, `async`
  over `app_core::rt::try_blocking("project", … _blocking)` like
  `project_scaffold_missing`, takes `Ctx`-free plain args. `command_class`
  **`Core`** (it reads the project folder; `Client` means "the machine the
  user sits at, never exposed", which would make it unusable from a browser
  client); regenerate `commandClasses.ts`. The argument names `projectId`
  and `name` hold no path word, so `core_dispatch`'s `PATH_NAMED` test needs
  no row — keep it that way (no `file`/`path`/`dir` in names).
- `create_project_doc(projectId, name)` — `name` must be a catalog entry with
  `creatable`; no path from the renderer; create-new + no-follow; returns
  whether it was written. `Core`.
- Phone: no new status route. The root listing
  (`GET /api/v1/projects/{id}/files`, `host.rs` `project_files_list`) gains a
  `docs` array (same shape; root only, local side only) built from the same
  `services::scaffold` function against the `files_scope` root, and
  `POST /api/v1/projects/{id}/files/docs?name=<leaf>` creates one doc. Names
  only cross the API (the sealed project token is already the scope). Guards
  as `project_files_upload`: `upload_scope` (session, exact origin, both
  switches — a create is a phone write into the project), create-new,
  answer = the new row; no upload-log entry, no Undo (a template file the
  user can delete). Both routes get a row in the refusal matrices of
  `mobile_control/host/tests.rs` (the lists near lines 1826, 2258, 6494).
- `STANDARD_PROJECT_FILES` in `fileUtils.ts` stays only as a fallback before
  the status arrives (the phone imports it from there too); a Rust test checks
  it against the catalog (names of all catalog entries + `.gitignore`, `.git`;
  `.claude` is dropped from it: nothing scaffolds it any more) — same pattern
  as `the_generated_command_classes_ts_is_current`, but a check, not a
  generator, so the TS file stays hand-written.

## 5. Steps

1. **Catalog + states (backend).** New `services/scaffold.rs` with the
   `ScaffoldDoc` catalog, history (moved `AGENTS_HISTORY`/`LEGACY_AGENT_STUBS`),
   the state function and `create_doc_at` (create-new). Rewrite every caller of
   `SCAFFOLD_FILES`/`CLAUDE_SETTINGS` on it — all of these, found by `rg`:
   `scaffold_project` (:3592), `repair_project_scaffold_at` (:3953),
   `scaffold_preview` (:4179), `scaffold_is_missing_at` (:4021),
   `agents_empty_at` (:4233), **`migration_steps_at` (:4357) and
   `apply_migration_steps_at` (:4420)** (the Migrate-project dialog: drop the
   `claude_settings` step; step ids `file:<name>`/`stub:<name>` stay for the
   remaining entries), `project_scaffold_missing` (:4274), the startup
   `migrate_legacy_projects` (:4135, uses the repair), the import paths that
   call `scaffold_project` (:4804, :4810, :5142), and
   `services/remote/remote_scaffold.rs` (`scaffold_paths`, `plan_scaffold_writes`,
   `ScaffoldOutcome`, the `.claude` logic and the :273 expected-set; its
   `.claude/settings.json` plan entries and tests go). Also the integration
   tests `src-tauri/tests/projects_commands.rs` (:17–31 builds its expected
   set from `SCAFFOLD_FILES` + `CLAUDE_SETTINGS`) and
   `src-tauri/tests/file_ops_tests.rs` (:328–370, including
   `scaffold_project_claude_settings_is_valid_json`, which is deleted).
   `services/brand_migration/` has no scaffold-name dependency (checked).
   Tests: new project gets exactly AGENTS/README(/.gitignore/.git) and no
   `.claude/`; a project holding all ten old files reports no missing and each
   old stub as `template` (pointers as `pointer`); an edited doc is `edited`; a
   symlinked or FIFO doc is `missing`, never followed (also in
   `agents_empty_at`); pointers untouched by repair; a history copy of
   `AGENTS.md` is upgraded by repair but does not raise
   `scaffold_is_missing_at`; `REMARKS_SCAFFOLD` equals the TS
   `REMARKS_TEMPLATE`.
2. **AGENTS.md template.** New text: drop "`CLAUDE.md` and `GEMINI.md` import
   this file" and the `PROJECT.md` link; add two placeholder sections,
   *Boundaries* (never touch / ask first) and *Verify* (how to check work).
   First add the current text to `src-tauri/src/commands/scaffold_history/`
   (`AGENTS.2026-11-13.md`; a test pins it) so repair still upgrades
   byte-identical copies. Update the doc comment above `AGENTS_SCAFFOLD`.
3. **Agent-home instruction settings** (agent step I2; §3a is the table).
   Merge point for both: `services::agent_hint::register_in_home`
   (`agent_hint.rs:336`), called from `agent_session::register_hooks_in_home`
   (`agent_session.rs:2418`) in `agent_home::prepare_home_with` **after**
   `agent_global::apply_to_home`, so the global layer's value is already in the
   file and our merge is the last word; both are idempotent per spawn.
   - **Gemini**: next to the `SETTINGS_HOOKS` loop, for `.gemini/settings.json`
     only, a `merge_json` edit `add_context_file_names(root, &["GEMINI.md",
     "AGENTS.md"])`: `context` object via `slot`; `fileName` string → array,
     array → keep, absent → new; append the missing names, `GEMINI.md` first
     only when the array was empty/absent (never reorder the user's entries);
     return whether it changed. Never replace. `agent_global::MERGED` already
     lists `.gemini/settings.json` (arrays gain elements, a layer *string*
     replaces our array — which is why ours runs after). Tests: user's own
     `context.fileName` string and array both survive; idempotent; jsonc left
     alone (existing `a_config_that_is_not_plain_json_is_left_alone` pattern);
     a layer value + ours after `apply_to_home`.
   - **Aider**: `const AIDER_CONFIG = ".aider.conf.yml"` in `agent_hint.rs`,
     opened with `HomeFile` like `VIBE_INSTRUCTIONS`; parse with `serde_norway`
     (already a dependency, used by `skills.rs`); `read` string → list, list →
     keep, absent → `[AGENTS.md]`; append `AGENTS.md` if missing; a file that
     is not a YAML mapping is left alone (the `merge_json` policy). Comments
     in the file are not kept when it is rewritten — acceptable, the file sits
     in Tabtivity's own agent home; write only when the value changed. The
     implementer checks with `scripts/verify-cli` (aider) that a missing
     `AGENTS.md` in the cwd is silent or only a warning, and notes it in the
     handoff.
   - Not in scope: Qwen (reads it by default since 0.11.1), every "yes" row of
     §3a, remote-host tabs (they run in the host's own `$HOME`, which
     Tabtivity never edits — §7), and the assistant scope needs nothing
     special (its chat folder has no project `AGENTS.md` to read).
   - Also add the one-line "reads `AGENTS.md`" fact per CLI to the third-party
     update checklist rows the implementer touches (`docs/third_party_update_checklist.md`).
   - The CLIs of §3a with no way: listed in the handoff as a known gap.
4. **Status + create commands + agent memory (backend).** New
   `commands/project_docs.rs` (keep `projects.rs` from growing):
   `project_docs_status`, `create_project_doc` (§4), plus step 8's two
   commands. Register in `lib.rs` (:2025 area), `services::command_class`
   rows (`Core`), regenerate `commandClasses.ts` (the AGENTS.md command),
   catalog→TS check test, and the `fileUtils.ts` `STANDARD_PROJECT_FILES`
   edit (drop `.claude`). Tests: states over a temp tree; symlink/FIFO are
   `missing`; create never overwrites; unknown `name` refused; a name with a
   separator refused.
5. **Desktop group.** `useFileTreeRows` (in `src/components/files/`) ghost and
   nested rows, `FileTree` group header + badges, CSS (no new animation;
   static; `.doc-template` dim class), persisted open state, clickable tag
   popover (`ProjectFilesView.tsx`, `projectTypeTags.ts`), `FileBrowser` pref
   fix. i18n keys in `en.ts` **and `de.ts`, `es.ts`, `fr.ts`, `it.ts`**:
   `src/__tests__/shell/i18n.test.ts` fails unless every language holds every
   English key (and `{placeholders}` survive), and the phone reads the same
   dictionaries. Rewrite `fileTree.scaffoldSection`,
   `fileTree.collapseScaffold`/`expandScaffold`, `projectSettings.separateScaffold*`
   and `fileBrowser.separateScaffold` wording to "Project docs" in all five.
   `UntestedTag` row in `src/lib/untested.ts` (one id for the group, tag the
   header).
6. **Phone group.** Backend half: the `docs` array on the root listing and the
   `files/docs` create route in `mobile_control/host.rs` (new small module
   `mobile_control/project_docs.rs` for the bodies; `host.rs` is 376 KB, only
   the route line and two thin handlers go in it), matrix rows in
   `host/tests.rs`. Frontend: `mobile-web/src/api.ts` (`ProjectFileListing`
   gets `docs?`, new `createProjectDoc`), `FilesLibrary.tsx` section with
   badges, ghost rows, Create in the item menu, persisted open state (a
   `localStorage` key via `storageKey`, try/catch); `npm run mobile:bundle`.
   Then `npm run backend:stale`.
7. **Prompts and dialogs.** `buildScaffoldFillPrompt` (`src/lib/projects/scaffold.ts:135`)
   no longer mentions pointers or `PROJECT.md` as required (keep `PROJECT.md`
   advice only when it is among the files listed); `ProjectDialog.tsx` import
   preview lists only default entries (keep `AGENT_POINTER_DOCS` handling,
   `ProjectDialog.tsx:69`/`:1202`, for trees that already have pointers);
   `ProjectMigrationDialog`/`migration.ts`/`summarizeScaffoldRepair` stop
   listing dropped files (the `claude_settings` step id disappears; the dialog
   renders steps by `kind`, check there is no per-id label). Update the
   existing tests `ScaffoldAgentFill.test.ts`, `ScaffoldRepair.test.ts`,
   `ProjectMigration.test.ts`, `ProjectTypeTags.test.ts`. Box agent docs
   (`boxes.rs` `BOX_AGENT_DOCS`) are out of scope.
8. **Agent memory entry (decision 5).**
   Backend (in step 4's module): `project_agent_memory(projectId) ->
   Vec<{ cli, name, bytes, modified }>` listing, from the project scope's agent
   home (`agent_home::scope_home(Some(id))`, and the local-model home when it
   exists), Claude's `<home>/.claude/projects/<encoded root>/memory/*.md` (the
   index `MEMORY.md` first) and Codex's `<home>/.codex/memories/` files; and
   `project_agent_memory_read(projectId, cli, name) -> String` (capped,
   no-follow, `name` must be a leaf of the listing, never a path from the
   renderer). The agent home is **agent-writable**: every access goes through
   `services::home_io` (`HomeDir`/`HomeFile` handles, not `fs::*` on joined
   paths), regular files only, entry count and bytes capped. `Core`. Verify
   the encoded-root rule and Codex's directory against the installed CLI
   versions (`seed_claude_transcripts` in `agent_home.rs:466` already
   encodes roots for `.claude/projects`); if a path is wrong, the sub-group is
   simply empty — no error.
   Frontend (agent step I4): a collapsed "Agent memory (n)" sub-group at the
   end of the Project docs group. **An entry opens in a read-only preview
   dialog** (shared dialog frame, `renderMarkdown` from `lib/viewers/markdown`
   as `SkillsLibraryView.tsx` does for its preview) — not in the markdown
   viewer tab, whose files are scope-confined project paths and must not be
   widened to the agent home. Empty → the sub-group is hidden. Phone:
   deferred. Remote-only projects: out of scope. Agents own these files; the
   user edits them through the CLI (e.g. Claude `/memory`).
9. **Docs.** `docs/filemap_backend.md` rows (`projects.rs`, `remote_scaffold.rs`,
   new `services/scaffold.rs`, `commands/project_docs.rs`, `mobile_control/project_docs.rs`),
   `docs/filemap_frontend.md` rows for `FileTree.tsx`/`FilesLibrary.tsx`/`scaffold.ts`;
   user-facing text that lists the scaffold files: `docs/guide/building.md`
   (~lines 114–123) and `DOCUMENTATION.md` (~1140–1170, `rg -n "GEMINI.md|ROADMAP.md"`,
   edit only that range); README line ~42 mentions pointers in an import
   example — check, edit only if wrong. Done by the last implementer (I5).

## 6. Organisation

**Shape: partly parallel, mixed risk.** The agent-home step (I2) shares no
file with the project-scaffold chain, so it runs beside I1. Everything else is
a coupled chain (the frontend needs the commands' exact shapes, and the
backend steps share `projects.rs`) on one integration branch `scaffold-files`
(cut from `develop`). Per-step reviewers on the backend steps (attacker-
controlled project tree, agent homes, agent-writable home reads); the frontend
steps and the phone half are covered by the final review, which must check the
`mobile_control` invariant (names only, guards of `upload_scope`) explicitly.
At most 3 agents run at once (cargo-heavy: ≤ 2 builds at a time, `/tmp`
tmpfs); a reviewer never overlaps an implementer on files.
Total: 1 plan reviewer, 5 implementers, 2 step reviewers, 1 final reviewer.

Each agent works in its own `isolation: "worktree"` worktree and first runs
`git reset --hard scaffold-files` (worktrees start at `origin/main`), then
hardlink-copies `node_modules` (`cp -al <main>/node_modules .`), commits on
top, and reports its shas. The main agent fast-forwards `scaffold-files` to
them (I1 and I2 are rebased/merged by the main agent; disjoint files).
Cargo: `export PATH="$HOME/.cargo/bin:$PATH" CARGO_INCREMENTAL=0`.

Shared hot files (i18n dictionaries, `commandClasses.ts`, `command_class.rs`,
`untested.ts`, filemaps) are edited by whichever implementer owns the step;
the one parallel pair (I1, I2) touches none of them. I2 lists its checklist
edit in the handoff if another agent holds that file.

### Agent steps

| Agent step | Plan steps | Main files (large ones first) | Review |
|---|---|---|---|
| I1 Catalog | 1, 2 | new `services/scaffold.rs`, `commands/projects.rs`, `commands/projects/tests.rs`; small: `services/remote/remote_scaffold.rs`, `commands/scaffold_history/`, `tests/projects_commands.rs`, `tests/file_ops_tests.rs` | R1 |
| I2 Agent-home settings (parallel to I1) | 3 | `services/agent/agent_hint.rs` (+ its tests), `docs/third_party_update_checklist.md` | R2 (with I3) |
| I3 Commands | 4, 8 backend | new `commands/project_docs.rs`, `services/command_class.rs`, `src/lib/transport/commandClasses.ts`, `lib.rs`, `fileUtils.ts` | R2 |
| I4 Desktop | 5, 7, 8 frontend | `components/files/useFileTreeRows.ts`, `files/FileTree.tsx` (group + memory sub-group), `files/ProjectFilesView.tsx` + `projects/projectTypeTags.ts`, `files/FileBrowser.tsx`, `styles/file-tree.css`, `lib/projects/scaffold.ts`, `projects/ProjectDialog.tsx`, `projects/ProjectMigrationDialog.tsx` + `migration.ts`, new memory preview dialog, i18n (5 dicts), `untested.ts`, the four Scaffold/Migration tests. Over budget on purpose (shared `FileTree.tsx`/i18n; user prefers fewer implementers): commit step 5 first, then 7, then 8; low on context → stop at a green commit, write the handoff, a fresh agent continues | final |
| I5 Phone + docs | 6, 9 | `mobile_control/host.rs` (routes), new `mobile_control/project_docs.rs`, `host/tests.rs`, `mobile-web/src/api.ts`, `mobile-web/src/components/FilesLibrary.tsx`, i18n, filemaps, `docs/guide/building.md`, `DOCUMENTATION.md` | final |

Order: (I1 ∥ I2) → R1 → I3 → (R2 ∥ I4) → I5 → final. R2 must not change
command shapes or `commandClasses.ts` while I4 codes against them (bugs
only, and a changed shape goes to the handoff for the main agent).

## 7. Risks and invariants

- Never overwrite, never delete: every write is `write_scaffold_file`
  (create-new + `O_NOFOLLOW`); the state read is capped and no-follow. Old
  stubs stay (decision 4).
- Project tree is attacker-controlled: a `CLAUDE.md` symlink or FIFO is
  `missing`/not-a-stub, never read through (this also fixes
  `agents_empty_at`'s `read_to_string`).
- Agent home is agent-writable: the Gemini/Aider merges go through
  `home_io::HomeFile` (a linked `.gemini` dir is skipped, as the existing
  test pins), and the memory reads through `home_io` handles with caps.
  Tabtivity writes only into its own agent homes, never the user's config
  (`agent_global` is untouched: no new `MERGED` row, no layer write).
- `mobile_control`: the phone sees leaf names and states only; the create
  route takes a catalog name, never a path, behind the upload guards.
- Remote-only projects: out of scope for status/create (no local scaffold
  target); their host scaffold at creation follows the lean set.
- A Claude older than 2.1.277 (a collaborator's) sees no instructions in a new
  project, and a `CLAUDE.md` in any parent folder hides `AGENTS.md` from
  current Claude. Accepted with decision 2; existing projects keep their
  pointers.
- Gemini CLI outside Tabtivity, and in a remote-host tab (the host's own
  `$HOME`), reads no `AGENTS.md` in new projects. Accepted with decision 2
  (Tabtivity never edits the user's own config). In an existing project whose
  `GEMINI.md` pointer imports `AGENTS.md`, Gemini inside Tabtivity may load
  the text twice (once via the import, once via `context.fileName`); a
  token cost only, noted for the click-through.
- Aider's `read:` entry is cwd-relative: a tab started in a subfolder does not
  find it. Accepted.

## 8. Verification

- Gates per AGENTS.md (`scripts/gates-job.sh start`), `npm run backend:stale`
  after backend steps.
- Click-through (never run by an agent):
  1. New local project → root shows *Project docs 2/2 · 1 template*,
     `AGENTS.md` (template), `README.md`, `.gitignore`; ghost rows for
     PROJECT/TODO/ROADMAP/STATUS/DOCUMENTATION; no `.claude/`.
  2. Click `+ TODO.md` → file appears, opens, ghost row gone.
  3. Open an existing project with all ten old files → no "no scaffold" tag;
     untouched stubs badged `template`; `CLAUDE.md`/`GEMINI.md` nested under
     `AGENTS.md` badged `pointer`.
  4. Delete `README.md` → tag appears; click it → popover names `README.md`;
     Repair recreates it.
  5. Collapse/expand the group, switch projects and back → state kept.
  6. Gemini tab in a new project → ask it to quote its project instructions;
     it quotes `AGENTS.md`. Aider tab: `/ls` lists `AGENTS.md` as read-only.
  7. Phone: same group; Create from the item menu; host side shows no Create.
  8. In a project where Claude has saved memories → Project docs shows
     *Agent memory (n)*; `MEMORY.md` opens in the read-only preview. A project
     with none shows no sub-group.
