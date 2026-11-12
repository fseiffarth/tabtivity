# Skill creator — plan (desktop + phone)

Status: **plan; Phase 0 done** (`InstalledSkill.folder`). Ticket: #2429. Builds on the Skills Library
(`docs/done/skills_plan.md`). Open decisions at the end; recommended option
first. Line numbers are as of 2026-11-06.

## Goal

Create and edit skills (`SKILL.md` frontmatter + body + supporting files)
inside the existing Skills menu, validate them, save to Personal (agent-global
layer) or a project's `.claude/skills/`; optionally let an agent draft one for
review. The phone can browse, install, create and edit too.

## Phase 0 — existing bug (fix first, independent)

`InstalledSkill` carries only the frontmatter `name`
(`src-tauri/src/schema/skills.rs:61-64`, set at `services/skills.rs:479`), and
uninstall uses it as the **folder** name (`installed_skill_dir`,
`services/skills.rs:398`; called from `SkillsLibraryView.tsx:284`). A folder
`foo/` whose frontmatter says `name: bar` makes Uninstall delete `bar/` — a
different skill. Fix: add `folder: String` to `InstalledSkill`, address
uninstall/edit by it, test it. Also correct the stale `~/.claude/skills/`
comments in `lib/agents/skills.ts:27` and `types/skills.ts:42`.

## Shared backend (one service, two clients)

New `src-tauri/src/services/skill_authoring.rs` (`skills.rs` is already 717
lines), reusing `plain_name`, `target_skills_dir`, `parse_skill_md`
(`services/skills.rs:51,366,226`, made `pub(crate)`). Wire shapes in
`schema/skills.rs`: `SkillFileIn`, `SkillDraftIn`, `SkillIssue
{code, field, severity}`, `SkillSnapshot {folder, skill_md, skill_md_hash,
files}`, `SkillWriteOutcome = Written{hash} | Changed{current, hash} |
Invalid{issues}`.

Commands — `#[cfg_attr(feature = "desktop", tauri::command)]`, `async` over
`try_blocking`, all **`Core`** (data lives where the daemon runs, same reasoning
as the existing `skills_*` rows, `command_class.rs:897-905`); regenerate
`commandClasses.ts`. Because `Core` means the server's web client reaches them
too, every write is compare-and-swap:

| Command | Purpose |
|---|---|
| `skills_validate(draft)` | The one validator (debounced ~300 ms from the editor). |
| `skills_read_installed(target, folder)` | Snapshot for editing; hashes per file. |
| `skills_create(target, draft)` | Exclusive mkdir; `SKILL.md` written **last** so a half-made folder never loads; on failure `HomeDir::remove_tree`. |
| `skills_write_file(target, folder, path, expected, content, executable)` | Per-file CAS (`None` = must not exist). |
| `skills_delete_file(target, folder, path, expected)` | Same check. |

The phone's "rev" is the same sha256 of `SKILL.md` — one CAS model for both.

**Validation:** name `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64, equals folder for new
skills (warning for existing); frontmatter parses to a mapping
(`serde_norway`); description required ≤1024; `SKILL.md` ≤256 KiB (>500 lines
warns); supporting paths — every segment `plain_name`, depth ≤4, no
dot-segments, no nested `SKILL.md`; ≤64 files, 1 MiB each, 8 MiB total; exec
bit only under `scripts/`; folders outside `scripts/ references/ assets/`
warn; binary files kept read-only, never written; bidi/zero-width characters
refused.

**Filesystem:** handles only — `HomeDir`/`HomeFile` (`home_io.rs:93-860`,
`read_capped` `:539`) or `mobile_control::files::ProjectDir`
(`files.rs:289`). No-follow, non-blocking, capped reads (planted FIFO/huge file
skipped); temp-file + rename. This also replaces the raceable
canonicalise-and-prefix check in `installed_skill_dir`. The service needs
`_in(state_dir)` variants (it currently resolves via global `state_dir()` /
`agent_global::global_dir()`, `skills.rs:33,37,374`; the sidecar uses
`config.state_dir`).

## Desktop UI

- No new tab: a written skill *is* an installed skill (disk is the record).
  "New skill" at the end of the `skills-tabs` row
  (`SkillsLibraryView.tsx:407`); "Edit" beside Uninstall on installed cards
  (`:303`); "Customize" in a catalog preview installs a copy and opens it.
  Catalog skills are never edited in place.
- `src/components/skills/SkillEditor.tsx`, split view: left = name,
  description, file strip (`SKILL.md`, supporting files, "+ Add file") over the
  existing `CodeEditor` (`embed/fileViewer/CodeEditor.tsx:209`) with the
  exported `MarkdownToolbar` (`MarkdownView.tsx:62`); right = the existing
  preview, extracted as `SkillPreviewBody` (`SkillsLibraryView.tsx:526-560`);
  footer = extracted `SkillScopePicker` (`:569-618`) + Save. Editing fixes
  scope and name. Personal shows "reaches agent tabs at their next spawn".
- Frontmatter edited surgically: `SKILL.md` text is the one saved thing; the
  name/description fields are views written back via `lib/viewers/yaml.ts`
  (`parseYaml`/`setValue`/`addRootEntry`), so other keys, comments and
  quoting survive. "Advanced frontmatter" shows the raw block.
- Issues under their field (error blocks Save, warning amber); dirty close asks
  via `useDialogs().confirmAction`; conflict banner: Reload (lose mine) /
  Overwrite (confirm, retry with the new hash).

### Agent drafting

`skills_draft_begin/list/load/discard` (Core). A draft lives in
`skill-drafts/<id>/` inside the **root scope's** agent home
(`agent_home::scope_home(None)`, `agent_home.rs:70`; fence binds it rw,
`agent_fence.rs:1396`). The agent tab opens in the root console like
`openHelpAgent` (`header/helpAgent.ts:157`) with the prompt as `initialInput`
(`{app}`, never the name). `draft_load` reads through handles and only fills
the editor; it never installs. Installing needs the user's Save with a scope;
Personal with scripts confirms ("reaches every agent on this machine; N
scripts"). Agents never write `agent_global`; none of these commands join an
MCP lane or the assistant scope.

## Phone

**Today:** the server web client already reaches `skills_*` via
`core_dispatch` (non-admin refused Personal, `core_dispatch.rs:308-310,
480-489, 639-646`); the phone PWA reaches none.

**Sidecar module `services/mobile_control/skills.rs`**, window-optional like
`git_overview.rs`/`uploads.rs`; after each write sends
`DesktopRequest::Refresh{slices:["skills"]}` (`protocol.rs:1474`).

| Route | |
|---|---|
| `GET /api/v1/skills` | switches + sources (id/label only, never the URL) |
| `GET /api/v1/skills/catalog?source=` | rows with `rel_path` sealed (`files::seal`, AAD `skills:<sourceId>`) |
| `GET /api/v1/skills/detail?source=&skill=` | preview |
| `GET /api/v1/skills/installed?scope=` · `…/{folder}?scope=` | list; `SKILL.md`, supporting names/sizes, `rev` |
| `POST /api/v1/skills/install` | `{source, skill, scope, replace_rev?}` |
| `PUT /api/v1/skills/installed/{folder}` | `{scope, name, description, body, base_rev\|null}` → 409 `skill_exists` / `skill_changed {rev,current}` |
| `DELETE …/installed/{folder}?scope=&rev=` | |

- `scope` = `"personal"` or the catalog's **opaque project id**, resolved via
  `Catalog::for_device`; folder from `discovery::mobile_root`, never the
  request. A hidden scope answers like a missing one. Boxes/root/assistant
  refused. Phase 1: local + container only; remote/VM →
  `skills_unsupported_here`.
- Switches in `tabtivity_mobile_host`, read per request: `skills` (read; off),
  `skills_write` (project writes; off, needs `skills`), `skills_personal`
  (off, needs `skills_write`; admin-role phone only on a server).
- Phone may edit only `name`/`description` frontmatter (other keys preserved
  byte-for-byte; can never add `allowed-tools`); writes `SKILL.md` only, never
  scripts.
- Caps: 96 KiB request, 64 KiB body, 30 writes/hour/device, 200 skills/scope;
  `mutation_guard` exact-origin check.
- Desktop-only: git sources (add/remove/refresh), agent drafting (phase 1).
- Every write logged to `<state_dir>/mobile-control/phone-skills.jsonl`
  (device, scope, folder, sha256); desktop notice with **Undo** on the
  `phone_uploads_list` pattern (`phone_skill_writes_list`, Core) — Undo only
  while content still matches.
- **Personal from the phone is staged** in
  `<state_dir>/mobile-control/skill-proposals/` and needs Accept on a desktop
  card (diff + device); no window → `desktop_unavailable`. Reason: the layer
  lands in *every* agent home, so a phone limited to one project could
  otherwise plant a skill everywhere, bypassing `for_device`.

**PWA:** a Skills row in Home's Desktop section (`Home.tsx:426-435`) and in the
project header menu next to Prompts (`Project.tsx:893`) →
`screens/SkillsSheet.tsx` (Installed / Browse). Preview via
`terminal/answerMarkdown.ts`; overwrites through `ConfirmSheet`. Full-screen
form: name (slug, live-checked, locked on edit), description (counter),
monospace body + Preview toggle, supporting files read-only (Upload here keeps
refusing dot folders). Drafts in `skillDrafts.ts` (the `drafts.ts` pattern),
cleared by `forgetDeviceData.ts`. 409 sheet: Load theirs (draft kept) /
Overwrite / Save as new name. Save disabled offline; a timed-out save re-reads
the rev, never retries blind. A 404 from an older backend reads as "update the
desktop". Switches in `MobileSettings.tsx:289-325`.

## Cross-cutting

- i18n: `skillsLibrary.{newSkill,edit,customize}`, `skillsCreator.*`
  (incl. `issue.<code>`), `mobile.skills.*` in `en.ts` + `de/es/fr/it` for the
  phone keys.
- UntestedTag rows (`src/lib/untested.ts`): `skillsLibrary.create`,
  `skillsLibrary.edit`, `skillsLibrary.agentDraft`, `mobile.skills`,
  `mobile.skills.write`, `mobile.skills.personal`, `mobile.skillsGate`,
  `desktop.skills.phoneProposal`.
- Tests — Rust: validation table; exclusive create; failed create leaves no
  `SKILL.md`; stale hash → `Changed`, file untouched; traversal/absolute refused;
  leaf link and linked `.claude/skills` refused (unix); caps; exec bit; draft
  reads skip links/FIFOs; `InstalledSkill.folder`; switches fail closed; hidden
  scope = missing; no path in any phone response; non-admin personal refused;
  rate limit; command-class tests. Paths via `Path::join` (cross-OS CI).
  Vitest: frontmatter splice keeps other keys/comments; conflict reducer;
  camelCase wrappers; `MobileSkills*.test.tsx`.
- Gates: all of `scripts/gates.sh` (backend + daemon build + frontend + phone
  bundle); `npm run mobile:bundle`; `npm run backend:stale` after backend edits.
- Docs: filemap rows; paragraph in `docs/context/mobile_sidecar.md`; "Writing
  skills" in `docs/context/mobile_access.md`.

## Phases (one commit each)

0. `InstalledSkill.folder` fix + stale comments.
1. Authoring service, schema, validation, CAS commands, class rows, tests.
2. Extract `SkillPreviewBody`, `SkillScopePicker`, `MarkdownToolbar` (no
   behaviour change).
3. `SkillEditor` + New / Edit / Customize, i18n, untested tags.
4. Phone read-only: sidecar routes, `skills` switch, `SkillsSheet` browse.
5. Phone project writes: install/create/edit/uninstall, log + Undo notice.
6. Agent drafting (desktop).
7. Phone Personal proposals + desktop Accept card.
8. Filemap + context docs.

## Risks

- Compare-then-rename still has a small race with a concurrent writer (same as
  `dev_todo`).
- Personal edits reach agent tabs only at next spawn; project edits may reach
  a running Claude tab at once.
- Windows has no handle-based I/O; path fallback is weaker there.
- Phone bundle can be newer than the running backend.
- Personal scope never reaches a remote-only project's host.

## Decisions

Taken by the user 2026-11-06:

1. Desktop placement: **New button + Edit on cards** (+ Customize), no new tab.
2. Phone Personal writes: **staged + desktop Accept** card.
3. Phone project writes: **direct + notice/Undo**.
4. Agent drafting: **yes, root console**, drafts in the root home.

Still open — the recommended option stands unless the user changes it:

5. Phone `skills` read switch default: off / on.
6. Remote/VM projects from the phone: refuse in phase 1 / write the mirror.
7. Supporting files: text editable on desktop, binary read-only; phone
   read-only / phone plain-text upload.
8. Rename an installed skill: not now / CAS folder move.
9. Name rule: strict new, warn existing / strict both.
10. Customize (copy a catalog skill to edit): yes / no.
11. Validation: Rust only, debounced / mirrored in TS.
