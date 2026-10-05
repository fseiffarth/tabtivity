# Rename phase 2 — the migration engine (2026-10-01); handoff to phase 3

Branch `rename`, worktree `.claude/worktrees/rename`. The plan is the untracked
`docs/rename_plan.md` (never `git add` it). The new name is no longer secret
(the user removed its denylist entry on purpose): it may appear in tracked
files and commit messages. Read
`docs/rename_phase1_handoff.md` first for the brand modules' conventions, and
`docs/context/brand_migration.md` for why the engine is shaped as it is.

**The brand is unchanged and so is behaviour.** While the current and the old
name are equal nothing in this phase runs, looks anything up twice, or writes
anything. **Nothing was run live**: the app was never started, and no code path
of the migrator ran against a real home, state dir, keyring, Docker, tmux
server or network — tests only, in temp dirs, under an invented brand.

## Where things are

- `src-tauri/src/brand.rs`: `Forms`, `Pair`, `PAIR`, `Name` (every `names!`
  entry as a value — `pair.cur(Name::X)`; `pair.legacy(Name::X)` is `None`
  when unchanged), `env()` / `env_os()`, `Pair::{env_in, adopt_legacy_env,
  export_both}`, `legacy_hit(id)`, `is_project_dir`. Also compiled into
  `build.rs`, so it stays std-only: the hit sink is installed by
  `services::brand_migration::hits::install()` (first line of `main` and `run`).
- `src-tauri/src/services/brand_migration/`: `mod.rs` (record, runner, lazy
  markers, `resolve_named_dir`, `status`), `hits.rs`, `host.rs`
  (`Env::for_this_machine`, production `World`, `run_at_launch`),
  `state_dir.rs`, `persisted.rs`, `agent_homes.rs`, `project.rs`, `keyring.rs`,
  `docker.rs`, `compat.rs`, `testing.rs` (`RENAMED`, `Machine`,
  `seed_install`), `tests.rs`.
- `src/lib/brandMigration.ts` + `brandMigrationBoot.ts`: the window's and the
  phone's half. `src/components/layout/LegacyNamesSummary.tsx`: the summary in
  Settings → Updates (there is no About panel).
- `scripts/lib/brand.sh`: `app_share_dir` and `app_env` read current, then old.

## Status of the migration table, row by row

done = implemented and tested here under the invented brand; lazy = runs when
the thing is present; prepared = the pieces exist, the flip must finish it.

| Row | Status | How |
|---|---|---|
| State dir | done | Step `state-dir`: rename, link at the old path, `started` marker travels with the folder. `share-dir` does the same for `~/.local/share/<name>` on Windows/macOS. `state-paths` re-points `*.json` in the state dir, `sessions/*`, `remote-projects/*` and `archive/*/entry.json`. `mobile-host` retires the old host first. Lookups fall back to the old folder while the move is pending. |
| `~/<name>` tree | done | `paths::app_home_in`: env override, else current if it exists, else old if it exists, else current. |
| Webview data dir | done (Linux) | Step `webview-data`: copy to a staging name, compare size and count, rename into place; the old copy stays. Windows/macOS paths are unknown (`state_gc::webview_data_root` returns `None` there) — **not done on those**. |
| localStorage keys | done | `migrateStorageKeys`, all three shapes, before any store loads. The pre-paint script in `index.html` is a flip point (below). |
| Mail labels | **pending, not attempted** | `key.json` records the label set; an old store opens under its own set untouched; a new store uses the current set. No re-encryption (see below). |
| HKDF salt of file tokens | done | `files::unseal_for` tries both; sealing uses the current salt. |
| Agent-home markers | done | Step `agent-homes` + at spawn (`prepare_home_in`) for a home met later. |
| Hook script, hook entries | done | Scripts renamed in `<state>/hooks`; the old command is rewritten in place in every CLI config, so the per-spawn registration finds its entry. `is_app_hook` recognises the old hooks dir on import. |
| MCP server and tool names | done | Allow rules rewritten in the homes and the app-wide layer; the help MCP accepts a tool called by its old name. Old *server* names are not registered (an old session's endpoint died with the old process anyway), so the Vibe globs list the current names only. |
| Box-links markers, manifest | done | `boxes::merge_box_doc_for` finds a block between the old markers and replaces it in place; `adopt_named_file` renames the manifest. A synced peer still on an older build appends a second block, as the plan says: update all machines together. |
| Serde keys | done by rewriting, not by alias | Step `persisted-names` rewrites the keys in the state files before anything reads them. `#[serde(alias)]` cannot be added while both names are the same literal: add it at the flip. |
| Saved tab commands, timer id | done | `persisted-names` (sessions, time log; two tallies of the same row are added) + `currentTabCommand` on layout load. A saved tab's env keys move too. |
| Keyring services | lazy | Copy on a read that was happening anyway; kernel-keyring cache only while locked; clearing clears both names. |
| Mobile host | done / prepared | Old unit, launch agent or `Run` value is stopped and removed by `World::retire_legacy_mobile_host`; the ordinary launch path installs the current one. Linux code path is real but untested (it calls `systemctl`); macOS and Windows are unverified. |
| PWA IndexedDB, SW cache | done | `adoptLegacyDatabase` for both databases. The service worker already deletes every cache but its own on activate. |
| Subprotocol, cookie | done | The host accepts both and counts the old ones. There are no `x-<slug>-*` headers on the phone host (the plan's line pointed at the cookie). |
| In-project folder, exclude line, worker bundle | lazy | `project::migrate_project` at project open, at remote connect, and for every known project on a background thread at launch. Remote side: `remote_script` over the live session, never on a careful/HPC host. |
| Export manifest, extension | done | Import accepts both; export writes the current names. |
| git refs | lazy | With the project. Not reported through `local_loss` (see "Plan corrections"). |
| tmux names | done | `compat::tmux_session_rest` in discovery, the Sessions view and the quit reap. |
| Docker labels, image | lazy | Sweep filters by both owner labels; `docker tag` when the stock image exists only under the old name. |
| VM names | done | `VmNames::of_existing`: an existing VM is seeded byte-for-byte as before. Base image found under its old name, never renamed. |
| Ollama drop-ins | lazy | The command that writes a drop-in also removes the old file. |
| Dev launcher, dev scripts | prepared | `brand.sh` dual reads. Renames and stubs are the flip's. |
| CLI shim alias | done | Old name installed as an alias on an upgraded install; counted through a note in the outbox. Windows `.cmd` alias type-checked only. |
| Env vars | done | `brand::env`, `adopt_legacy_env` at spawn, `export_both` before the wrappers and before the spawn. **Secrets are never exported twice.** Generated scripts read the old variable when the current one is unset. |
| Crate name | done in phase 1 | |
| deb / NSIS replacement | **not built** | See "Flip points". |

## Decided by the user (2026-10-01)

1. **Mail: the old label set stays for good.** No re-key is built. A store
   opens under the label set its `key.json` records; a new store uses the
   current set.
2. **`<slug>-screenshots` / `<slug>-emails`: a project keeps the folder it
   has.** `commands::projects::generated_dir_name` answers the old name where
   a project has that folder and not the current one (a real directory only),
   else the current name. The mail save uses it; the two dialogs ask through
   `project_generated_dir` (`src/lib/generatedDir.ts`). Not a legacy hit: the
   folder is the user's. A remote project's host is not asked — it gets the
   current name.
3. **Pinned ids are literals that belong to no brand:**
   `brand::PINNED_GATEWAY_ID_CONTEXT`, `brand::PINNED_SUBAGENT_TOKEN_CONTEXT`
   (out of the `names!` table, so there is no `Name::` for them) and
   `PINNED_ICS_UID_DOMAIN` in `src/lib/brand.ts`.
4. **Careful/HPC hosts: accepted.** The remote side is never migrated there.
5. **Ref moves stay out of `local_loss`: accepted.**
6. **The `AGENTS.md` additions stay** (gate line, context entry, brand rule).
7. **The copy run comes before the flip** — see the next section.

Dev tooling state (per developer) is untouched: git config
`<slug>.autoDevBuild`, `~/.local/share/<slug>-dev`, `dev-builds/<slug>-<commit>`,
the desktop entries, `~/.config/<slug>-release-signing`,
`~/.config/<slug>/privacy-denylist`, `.git/<slug>-release-signing-secret-ok`.

## The copy run (the gate before phase 3)

`scripts/brand-copy-run.sh [NewName] [--keep]`, from the user's own terminal
(a fenced agent tab sees a stand-in for the state dir). It copies the state
dir, the webview data and the archive entries into a private temp home,
re-points the stored absolute paths at the copy, and runs the ignored test
`services::brand_migration::copy_run::copy_run` over it: the real
`run_startup` with the test `Machine` at that home, the machine-wide side
recorded instead of done. It prints the steps done and pending, the record,
a second launch, and every file that still holds a path under the old state
dir or the old hook script's name. The report lands in the git dir
(`brand-copy-run-report.txt`); the copy is deleted unless `--keep`.

Not the plan's recipe (state-dir override on a copy + a local flip): an
overridden state dir marks the instance sandboxed, and a sandboxed instance
skips the state-dir move — the step most worth running.

**Status: run by the user against their real install on 2026-10-01 — passed.**
All seven launch steps finished (state dir moved and linked, 14 files
re-pointed, 42 state files' names rewritten, 109 agent-home files renamed or
re-pointed, 1,663 webview files copied), a second launch did nothing, and no
step was pending. `mail-store` and `docker-image` stay pending by design.

What still held a path under the old state dir afterwards, and why each is
harmless (the link keeps every one of them resolving):
- agent history: Claude transcripts, paste cache, file history and shell
  snapshots, Codex rollouts and shell snapshots, Vibe session logs (~1,350
  files). Text the CLIs wrote; never read back as paths by the app.
- `bin/*` (the CLI shims) and the hook script's body: both are rewritten at
  every launch (`agent_bin::install`, `install_session_start_hook`), which
  the driver does not run.
- `remote-projects/<id>/<project dir>/sessions/terminals.json`: the copy of
  the tab layout kept in the mirror; written, never read.
- logs and one settings backup.
Release B's link removal must wait until these have aged out or are
rewritten; the transcripts are the long tail.

## Flip points phase 3 must handle

- `index.html` pre-paint reads four dashed keys before any module runs. After
  the flip it reads the new names, which exist only once `brandMigrationBoot`
  has run — so the first paint after an upgrade uses the default theme. Give
  the script a fallback to the old key.
- The serde `rename` literals (`schema/settings.rs`, `schema/boxes.rs`,
  `mobile_control/config.rs`, `mobile_control/discovery.rs`) need
  `alias = "<old>"`.
- deb: add `"provides"`, `"conflicts"`, `"replaces"` with the old package name
  to `bundle.linux.deb` in `tauri.conf.json`. Not added now: a package cannot
  be built here to check it.
- NSIS: no hook was written. Tauri's uninstaller can delete the app's data,
  and whether a silent run of the old one keeps `%APPDATA%\<old>` could not be
  checked here. Verify on Windows before wiring `installerHooks`.
- `scripts/install_phone.{sh,ps1}` spell the state dir and the settings key.
  After the flip they read only the new ones; on a machine whose state-dir
  move is pending they report "settings are unavailable". Proposed: let
  `mobile_prepare_phone_install_script` write the resolved state dir into the
  script.
- `GITIGNORE_DEFAULT` (`commands/projects.rs`) builds its `<slug>-screenshots/`
  and `<slug>-emails/` lines from the current slug. Add the old-named lines
  beside them at the flip: a project that keeps its old folder (decision 2)
  must not lose the ignore rule when its `.gitignore` is regenerated.
- `scripts/<slug>-send.*` are static and spell the project folder and the
  variables; the flip rewrites them.
- Remove `// brand-check: allow` markers that the flip makes unnecessary, and
  add the migrator's files to the `brand-check.sh` allowlist only if they need
  to spell the old name (they do not today: every old name comes from `LEGACY`).

## Plan corrections

- **"Settings → About"** does not exist; the summary is in Settings → Updates.
- **Ref moves are not reported through `services::local_loss`.** That log
  raises a "local files were lost" dialog. A ref is deleted under its old name
  only after the same commit is verified under the new one, so nothing is lost
  and the dialog would be false.
- **The state-dir link cannot go as easily as the plan says.** A VM overlay
  names its base image by absolute path inside the state dir. Release B needs
  `qemu-img rebase -u` on every overlay before the link is removed.
- **Codex asks for hook trust again** after the flip: its trust record is per
  hook command, and the command changes. Add to "Expected at release A".
- **Old-name conveniences are installed on upgraded installs only**
  (`migrations.json` → `upgraded`), so that a fresh install has no file that
  spells the old name: the send alias and the old-variable preamble.
- **A sandboxed instance** (`<PREFIX>STATE_DIR` set) runs no machine-wide step.
- The plan's gate "phase 2 has been run against a copy of a real state dir"
  is still open: point `<PREFIX>STATE_DIR` and `<PREFIX>HOME` at a copy and
  flip the three macros in `brand.rs` plus `BRAND` in `brand.ts` locally.
- The privacy denylist no longer holds the new name; do not re-add it.

## Edits inside non-Linux `cfg` code

Windows-only, type-checked (`cargo check --target x86_64-pc-windows-msvc --lib
--tests`), never run:
- `services/mobile_control/admin.rs`: `pipe_name_with`, and `connect` falling
  back to the pipe under the old prefix.
- `services/brand_migration/host.rs`: `retire_legacy_mobile_host` (reg query /
  delete, shutdown over the old state dir's pipe).
- `services/brand_migration/state_dir.rs`: `link_dir` (junction via `mklink
  /J`), `is_reparse_point`.
- `services/agent_bin.rs`: the `.cmd` alias.
- `services/agent_session.rs`, `services/agent_hint.rs`: `{legacy_env}` in the
  PowerShell script bodies.

macOS-only, **not compiled**:
- `services/brand_migration/host.rs`: `retire_legacy_mobile_host` (launchctl
  bootout, plist removal).

Compiled and tested on Linux though they serve another OS: the park lists in
`platform/windows_park.rs` and `platform/macos_park.rs` (both binary names).

## Not verified

- Anything live. The Linux `systemctl` path, real keyring reads, real Docker,
  a real SSH session, a real VM boot.
- Windows and macOS code paths beyond the Windows type-check.
- `databaseHost` / `databasePort` against a real IndexedDB (the copy logic is
  tested through an in-memory port).
- That `fs::rename` of a live state dir is safe while a tmux-surviving agent
  holds files open in an agent home (on Linux open files follow the inode).
