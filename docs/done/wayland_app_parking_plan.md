# GNOME/Wayland: launched apps in the Apps view and parked on project switch

Status: implemented and landed on develop 2026-10-26 (A1a `756b9fd3` through
the final review `d658df66`); never run live. Written from three read-only
investigations (tracking, parking backend, switch flow + frontend). None could
reach the X display from the fence, so live window facts are still owed.
Handoff: `docs/wayland_app_parking_handoff.md` (per-step notes and the final
review's "Flagged for user").

## Fixed decisions (user, 2026-10-26 — reviewers may not undo)

- User's requirement, verbatim intent: on project switch, **every window of
  the current project goes to the hidden workspace — the one to the right
  (Ctrl+Alt+→)** — on X11 and on Wayland; the next project's windows come
  back. GNOME (X11 *and* Wayland) is routed to the existing `x11` backend
  (desktop 0 = active project, desktop 1 = parked). No new backend, no
  minimize mode.
- Like Cinnamon (`x11.rs:786-858`), the backend sets GNOME's workspace
  gsettings while it runs and restores them in `cleanup`:
  `org.gnome.desktop.wm.preferences num-workspaces` (raise to ≥ 2) and
  `workspace-names`, `org.gnome.mutter dynamic-workspaces` → false, and
  `org.gnome.mutter workspaces-only-on-primary` → false (so secondary-monitor
  windows park too).
- Under Wayland only XWayland windows can be parked; native Wayland windows
  are listed but never hidden, and the UI says so.
- All three phases are implemented.
- Native Wayland apps (PyCharm here: no `jetbrains` X window, JetBrains'
  default Wayland toolkit — verified live 2026-10-26) are **listed only**.
  Tabtivity sets no XWayland launch hints (`GDK_BACKEND`, `JAVA_TOOL_OPTIONS`
  awt toolkit, `QT_QPA_PLATFORM`, Electron ozone) and ships no Shell
  extension; the Apps view says they stay on screen (user, 2026-10-26).

## Bug

GNOME Wayland (`ubuntu:GNOME`): PyCharm opened through **Open in <IDE>** never
appears in the side panel Apps view and stays on screen when switching to
another project.

## Root causes (verified in code)

1. **GNOME never reaches the parking backend.** `platform::detect_backend`
   (`platform/mod.rs:174-222`) sends only KDE and Cinnamon to `x11`;
   `ubuntu:GNOME` falls to `null`, whose `hide_window` / `show_window` are
   no-ops (`platform/null.rs:21-31`). The hidden-workspace parking the user
   remembers is the `x11` backend on Ubuntu Cinnamon/X11 (the box was
   reinstalled with GNOME/Wayland on 2026-09-07). The Python-era app also
   parked on GNOME/X11 (`dd8a9d1e`: gsettings count + dynamic off, EWMH moves);
   the Rust port stubbed GNOME as null (`c6c002f0`) and never filled it.
   Muffin (Cinnamon) is a Mutter fork, so the same EWMH path applies.
2. **No window id under Wayland.** `list_window_ids`, `find_window_for_pid`,
   `find_new_window` return empty at once when `session_is_wayland`
   (`commands/apps.rs:2209-2245`, `:2294`, from 5a0b51c1). Every launched row
   has `window_id: None`; `project_window_ids` (`window_service.rs:77`)
   `filter_map`s those away, so even a working backend would get nothing.
3. **The row is deleted when the launcher exits.** `watch_child_exit`
   (`apps.rs:278`) → `launched_exit_action(None, [], None)` → `Remove`
   (`apps.rs:258-271`). "Window list unknowable" is treated as "no windows".
   `prune_dead_windows_with` (`apps.rs:2153`) does the same on every Apps-view
   read. An IDE launcher that hands the folder to a running instance, or a
   wrapper that forks, exits within milliseconds → the row vanishes.
4. **Raise path records nothing.** `open_project_in_ide` (`ide.rs:160-166`)
   raises an already-open IDE window via `named_client_windows` (which *does*
   see XWayland), then returns only an existing registry row — none exists
   for a window not launched this run (registry resets at startup). Also true
   on X11.
5. **Late windows, also on X11.** `find_window_for_pid(pid, 20)` gives up
   after 2 s (a JVM window is often later); the switch-time
   `resolve_missing_window_ids` is cfg'd to Windows/macOS only
   (`project_runtime.rs:214-221`) on the false premise that Linux resolves at
   launch.
6. **Silent.** Nothing in the switch flow checks `can_park`; the only hint is
   `WorkspaceParkingNote` in Settings → Layout (`SettingsPanel.tsx:208`).

## What Mutter allows (inference from Mutter's X11 path, to verify live)

- XWayland windows are ordinary X11 clients to Mutter: `_NET_WM_DESKTOP`
  (move to an existing workspace), `_NET_CURRENT_DESKTOP` and
  `_NET_ACTIVE_WINDOW` (already used by `activate_window`) client messages
  are honoured. Whether `_NET_CURRENT_DESKTOP` from an X client is honoured
  in a *Wayland* session is the one fact to verify first (step 2.4).
- Why the gsettings writes are needed: `dynamic-workspaces=true` collapses an
  empty hidden workspace; `workspaces-only-on-primary=true` (this host) shows
  secondary-monitor windows on every workspace. Both are set and restored the
  way Cinnamon's are (precedent for the "another app's config" invariant).
- **Native Wayland windows: impossible.** No foreign-toplevel protocol in
  Mutter, no portal, `Shell.Eval` locked since GNOME 41. Only a Shell
  extension could — rejected.

## Fix

### Phase 1 — tracking (backend, all Linux)

1. **Launch marker.** The row id (`{exec}-{pid}`, `apps.rs:223`) only exists
   *after* `spawn`, so it cannot be the marker. Generate an opaque token
   before spawning (random/uuid, never a path or project id), set it as
   `crate::app_env!("LAUNCH_ID")` (→ `TABTIVITY_LAUNCH_ID`; the macro
   `environ_tab_uid` uses — no legacy-name lookup, nothing older wrote it) on
   the `Command` from `launch_command` (`apps.rs:349`) — covers `do_launch`
   (`:197`, so also `ide.rs:168` and `restore_service.rs:73`) and
   `open_file_blocking`'s handler branch (`:618`). The OS-default branch
   (`opener::open`, `:640`) has no `Command` and stays unmarked (pid 0, as
   today). Store the token on the row as a new
   `TrackedWindow::launch_id: Option<String>` with
   `#[serde(default, skip_serializing)]` (the frontend never needs it; 12
   struct literals in `apps.rs`, `subwindow.rs`, `window_service.rs` tests
   get `launch_id: None`). Add `proc_table::environ_launch_id` (pure parse,
   next to `environ_tab_uid`, `proc_table.rs:369`) and a cached reader
   modelled on `UidCache` (keyed by pid + start time, so pid reuse is
   harmless); read `/proc/<pid>/environ` only for same-user pids of the
   cached snapshot, and only when a row with a `launch_id` needs an answer.
   Linux only: on Windows/macOS the marker is set (harmless) but the reader
   answers "no marked process", so behaviour there is unchanged.
   **Leak:** the variable is inherited by everything the app spawns — an
   IDE's integrated terminal, run configs, language servers, Gradle/Maven
   daemons (which detach and live for hours), a browser the IDE starts.
   Hence the *family* rule in step 2 and the claimed-window rule in step 3;
   with them the leak is acceptable (the token is not a secret).
2. **Alive = the launch family alive.** When the launcher exits
   (`watch_child_exit`, `apps.rs:278`), snapshot the marked processes alive
   at that moment as the row's *family* (pid + start time, kept in the
   registry next to the row, not serialized). From then on the row's
   liveness is "any family member alive" — later-spawned marked processes
   (daemons, terminals) never extend it. `launched_exit_action` (`:258`)
   and `prune_dead_windows_with` (`:2153`) take an injected `family_alive`
   answer. Window evidence: under X11 the window list is authoritative; under
   Wayland it is authoritative only for rows that *have* a `window_id`
   (XWayland) — a row without one is judged by its family alone. With no
   family, no window and no adoption (step 5), a project-opened row is
   demoted to pid 0 (delist-only, the view already offers "Remove from
   list") instead of removed; a non-project row (`global_app`,
   `manual_launch`) is removed as today.
3. **Cheap scan instead of none under Wayland.** Replace the blanket
   short-circuits in `list_window_ids` (`:2210`), `find_window_for_pid`
   (`:2238`) and `find_new_window` (`:2294`) with one no-sleep pass under
   Wayland (keep the 20× retry loops X11-only — the cost 5a0b51c1 removed was
   the sleeps, not the scan). Add a marked-pid resolver
   `resolve_window_for_launch(row, windows)`: candidate = a non-protected
   client window whose `_NET_WM_PID` is a family/marked pid, **not already
   held by another registry row**, and — for `ORIGIN_PROJECT_IDE` rows —
   whose class/title also pass `ide_detect::window_shows_project` (one JVM
   can host several projects' windows, and the leak in step 1 can put an
   unrelated app's window under a marked pid). XWayland windows get ids;
   native ones simply aren't listed. `find_window_for_title`
   (`x11.rs:627`) keeps its Wayland short-circuit (Tabtivity's own windows
   are native).
4. **Switch-time re-resolve on Linux.** `resolve_missing_window_ids`
   (`window_service.rs:193`) takes a resolver over the row
   (`Fn(&TrackedWindow) -> Option<u64>`) instead of a pid — a demoted pid-0
   row can still be resolved through its `launch_id`; the Windows/macOS
   callers wrap `resolve_window_id_for_pid(w.pid)`. Enable the call for
   Linux at `project_runtime.rs:213-218` with step 3's resolver; drop the
   `allow(unused_mut)` cfg and fix the "Linux resolves at launch" comment.
   Also run the same one-pass resolve on every Apps-view read: inside
   `apps::prune_dead_windows` (`apps.rs:2147`, which `get_opened_windows`,
   `commands/workspace.rs:87`, already calls — so `workspace.rs` stays
   untouched by this step), so the Apps view (and
   Phase 3's "can't be hidden" line) sees a late JVM window without waiting
   for a switch. Fixes cause 5 on X11 too.
5. **IDE hand-off + raise path.** `raise_open_window` (`ide.rs:186`) /
   the raise branch of `open_project_in_ide` (`ide.rs:159-166`): when the
   raised window has no row, insert a pid-0 `ORIGIN_PROJECT_IDE` row with
   that `window_id` (pure helper `row_for_raised_window`, unit-tested). At
   launcher exit with no family and no window, adopt the window
   `ide_detect::window_shows_project` (`ide_detect.rs:351`) matches (class +
   project title, needs the IDE id + `project_window_names` — carry them on
   the registry next to the family, not in `TrackedWindow`) instead of
   `find_new_window`'s "any new window" guess; such a row is pruned once
   its `window_id` leaves the client list (pid-0 rows with a window id get
   window-only liveness; pid-0 rows without one stay delist-only).

### Phase 2 — GNOME on the existing `x11` backend

1. **Route GNOME.** Pull the decision out of `detect_backend`
   (`platform/mod.rs:174-222`, cfg linux+desktop, connects to X) into a pure
   `fn route(desktop: &str, wayland: bool) -> Route` compiled on every OS, so
   the routing table is unit-tested on all CI legs. A `:`-separated
   `XDG_CURRENT_DESKTOP` segment equal to `gnome` (`ubuntu:GNOME`,
   `pop:GNOME`, `GNOME`; X11 or Wayland) → `x11::X11Backend::try_new()`;
   on `Err` (no `DISPLAY`/XWayland disabled, EWMH refused) fall back to
   `null` as today. KDE/Cinnamon/XFCE/sway unchanged. Update the module doc
   (`mod.rs:1-10`), `null.rs`'s doc and the filemap wording ("There is no
   GNOME backend"). Note: under Wayland `try_new` opens an X connection at
   startup, which starts an on-demand XWayland and keeps it alive while
   Tabtivity runs — accepted cost, record it in the handoff.
2. **Per-desktop workspace settings.** Generalise `CinnamonWorkspaceState` /
   `configure_cinnamon_workspaces` / `restore` (`x11.rs:86-90`, `:793-858`)
   into one table-driven `DesktopWorkspaceSettings` (schema + key + desired
   value per desktop): Cinnamon keeps its three keys exactly; GNOME uses
   `org.gnome.desktop.wm.preferences` `num-workspaces` (only raised when
   < 2) + `workspace-names` (same GVariant `as` format — reuse and rename
   `cinnamon_workspace_names{,_value}`), `org.gnome.mutter`
   `dynamic-workspaces` → false and `workspaces-only-on-primary` → false.
   Split it pure: `plan(table, current: Fn(schema,key)->Option<String>) ->
   (writes, record)` and `restore_writes(record)`; only the thin caller runs
   `gsettings`. **Write only what differs, record and restore only what was
   written.** A key `gsettings get` cannot read (missing schema/key, GNOME
   < 40 where `org.gnome.shell.overrides` shadowed the mutter keys) is
   skipped; a failed `set` on GNOME is logged, never an `Err` that kills the
   backend (Cinnamon keeps today's `?` on its writes). The
   `cinnamon`-only branches follow the table: the `restore` call in
   `cleanup` (`x11.rs:270`) and the `ChangeProperty` fallback in
   `move_window` (`x11.rs:294`, keep it Cinnamon-only — a per-desktop flag
   in the table).
   **`_NET_NUMBER_OF_DESKTOPS` on Mutter:** Mutter turns that client message
   into a write of the `num-workspaces` GSetting itself (inference from
   Mutter's X11 event handler; verify live). So on a desktop with a settings
   table, `cleanup` must **not** call `request_desktop_count(original)`
   (`x11.rs:261-268`) — under dynamic workspaces `original_desktop_count` is
   just the momentary dynamic count, and writing it would leave the user
   with a fixed `num-workspaces` they never set. The table restore is the
   only thing that restores the count there; `request_desktop_count` stays
   for KDE (no table). `try_new` writes the gsettings *before*
   `ensure_desktop_count` (as Cinnamon does today), so that call is a no-op
   on GNOME.
3. **Audit what else turns on under Wayland** (the `x11` backend has only
   run on a real X server). Per method of `X11Backend`, the decision:
   - `name()` `"x11"` — consumed only by `workspace_capabilities`' `backend`
     string and a platform test list; nothing branches on it. Keep.
   - `info()` — reads XWayland's root `_NET_CURRENT_DESKTOP` /
     `_NET_NUMBER_OF_DESKTOPS`, which Mutter publishes there too; no live
     frontend consumer (`HeaderBar.tsx:39` dropped it). Keep.
   - `show_window` / `hide_window` / default `switch_to_project` — the point
     of the change; act on XWayland ids only (native windows never get an
     id). Keep; see step 4 for `_NET_CURRENT_DESKTOP`.
   - `supports_embedding()` → return `!session_is_wayland()` (reparenting
     into a native Wayland Tabtivity window is impossible). `embed_capability`
     (`apps.rs:1214-1217`) already gates it; this makes the backend safe for
     any future caller.
   - `can_park()` — stays `true` (default); Phase 3 explains per window.
   - `make_sticky` — a no-op with no caller. Unchanged.
   - `position_window` → `Ok(())` without touching the window under Wayland:
     the drop point the frontend sends is not a global coordinate there
     (`subwindow.rs:738-755`, `window_positions_readable`), and Mutter
     honours `ConfigureWindow` on an XWayland window, so it would *move* the
     app to a wrong place. Today it is never reached under Wayland only
     because the id is `None`; Phase 1 step 3 changes that.
   - `set_parkable` / `unset_parkable` / `set_main_window_id` — their ids
     come from `find_window_for_title`, which keeps its Wayland
     short-circuit, so they are never called with an id there; popouts keep
     the Tauri hide path (`sync_detached_scope`). Unchanged.
   - `cleanup` — see step 2 and step 6.
   - `PROTECTED_CLASSES` — unchanged. Do **not** add `gnome`/`shell`
     tokens: `is_protected_class` matches `.`/`-`-separated segments, so a
     `gnome` token would protect every `org.gnome.*` app. GNOME Shell's own
     surfaces are not in `_NET_CLIENT_LIST`.
   - Free functions: `named_client_windows` / `activate_window` already run
     under Wayland; `find_window_for_title` and
     `frontmost_window_under_pointer` stay as they are (they look for
     Tabtivity's own native windows). `desktop_claims_super`
     (`mod.rs:261`) is keyed on the desktop string, not the backend —
     unaffected.
4. **`_NET_CURRENT_DESKTOP` under Wayland.** `show_window` forces desktop 0
   (`x11.rs:159`). Keep it; if Mutter ignores it from an X client under
   Wayland, parking still works (windows return to desktop 0) — just record
   it in the handoff. Tabtivity's own window is native Wayland and can't be
   made sticky; the design already assumes the user lives on desktop 0.
5. **Crash leftovers.** Verified: there is **no** guard today. After a
   crash, Cinnamon's next `try_new` reads Tabtivity's own values
   (`dynamic-workspaces=false`, names `['Tabtivity','Tabtivity-Hidden']`)
   as the "originals" and restores those forever; with step 2's
   write-only-what-differs rule it would record nothing at all. Fix, shared
   by both desktops: before the first write, persist the record (desktop,
   schema, key, original) to `<state_dir>/workspace_settings_restore.json`
   (`storage` helpers, atomic write); `cleanup` deletes it after restoring.
   `try_new` that finds the file first restores from it (its originals win
   over whatever is current), then plans afresh. Fallback without a file
   (a crash under an older build): a `workspace-names` whose first two
   entries are exactly the brand pair (`brand::WM_CLASS`,
   `WM_CLASS_HIDDEN`, or `LEGACY_WM_CLASS{,_HIDDEN}` — counted with `brand::legacy_hit`) is
   recorded as the GSettings default (`gsettings reset` on restore) rather
   than as the user's value. Pure, tested with a temp state dir.
6. **Clean quit really restores (sibling bug, Cinnamon too).** Verified:
   nothing calls `backend.cleanup()` on exit — only `Drop for X11Backend`
   (`x11.rs:317-321`). Tauri never drops managed state on quit (tao's `run`
   ends in `process::exit`, and AppHandle clones live on in threads), so
   Cinnamon's restore most likely never runs today. Add
   `workspace.lock_ok().backend.cleanup()` to the `RunEvent::Exit` arm
   (`lib.rs:2645`), before the long teardowns; `cleanup` is idempotent
   (`cleaned_up` flag). This also moves parked windows back to desktop 0 on
   quit. SIGINT/SIGTERM already route into `RunEvent::Exit`; a hard crash is
   step 5's job.

### Phase 3 — frontend honesty

- `lib/workspaceCaps.ts` `useWorkspaceCaps()` / `useCanPark()` (one
  `workspace_capabilities` fetch per session; `null` when the answer lacks
  the fields — an older backend, or the browser client, whose
  `clientAdapters.ts:87` answers `{}`); `WorkspaceParkingNote`
  (`SettingsPanel.tsx:208`) uses it.
- `WorkspaceCapabilities` (`commands/workspace.rs:43-46`) gains
  `wayland_session: bool` (from `platform::session_is_wayland`). A field
  on an existing command: no new `command_class` row and no
  `commandClasses.ts` regeneration (only a *new* command needs those —
  re-run the generator test anyway as the check). Extend the existing
  `null_backend_reports_it_cannot_park` test (`workspace.rs:839`).
- Per-row answer, derived in the frontend (no `TrackedWindow` change):
  `can_park && wayland_session && window_id == null` → "can't be hidden
  (a native Wayland window)"; `!can_park` → the existing desktop-limit
  wording. Phase 1 step 4's read-time resolve keeps a late XWayland window
  from showing the line for long. The Apps view (`ProjectFilesView.tsx`,
  the `view === "windows"` list at `:2868`) shows one muted line per such
  row (new i18n keys in `en.ts` + every dictionary, `UntestedTag` +
  `untested.ts` row). Wording states it as a desktop limit, not an error.
- `settings.workspaceNoParking` (`en.ts:2173`, "Supported on X11 with KDE
  Plasma and Cinnamon") and the user help table (`docs/help/project-desktop.md:27-33`,
  row "Linux, other Wayland (GNOME, …) — No parking") become wrong: reword
  both (GNOME X11/Wayland parks XWayland windows on the workspace to the
  right; native Wayland windows stay).

## Tests

All pure, no X server, no `gsettings`, no `/proc` of foreign processes — they
run on every CI leg (Rust ones in `x11.rs` only on Linux, where the module
compiles; paths via `Path::join`).

- Rust (`apps.rs` tests): launcher dead + family member alive → keep; family
  dead + window gone → remove; Wayland + row without `window_id` + family
  dead + no adoption → project row demoted to pid 0, global row removed;
  later-spawned marked daemon does **not** keep a row alive (family rule);
  resolver skips a window id another row holds and, for an IDE row, a
  window whose title doesn't show the project; hand-off adoption by
  project-window match → pid 0 + adopted id; raise path inserts a missing
  row (`row_for_raised_window`).
- `proc_table`: `environ_launch_id` parsing (absent, empty, `=` in value,
  the legacy-free name).
- `window_service`: `resolve_missing_window_ids` with a row resolver
  (including a pid-0 row with a `launch_id`).
- `platform`: `route(desktop, wayland)` table (`ubuntu:GNOME`/Wayland,
  `GNOME`/X11, `KDE`, `X-Cinnamon`, `XFCE`, `sway`, `budgie:GNOME`);
  `DesktopWorkspaceSettings` — Cinnamon writes unchanged, GNOME writes only
  what differs and records only what it wrote, restore writes back exactly
  the recorded originals, unreadable keys skipped, the restore file wins over
  current values, brand-named `workspace-names` without a file → reset;
  `X11Backend::supports_embedding` / `position_window` gates are cfg-free
  predicates (`fn embeds(wayland: bool)`) so they are testable.
- Frontend: Apps-view render test (mocked `get_opened_windows` +
  `workspace_capabilities`): the line appears only for a windowless row under
  Wayland with `can_park`; nothing on `{}` capabilities; a pid-0
  `project_ide` row renders with "Remove from list". `WorkspaceParkingNote`
  test (`src/__tests__/projects/WorkspaceParkingNote.test.tsx`) still passes
  through the hook.
- 🖐️ QA (`todo/group-c-workspace.md`, one ✅/❌ pair per platform): PyCharm
  via Open in IDE is listed, moves to the hidden workspace on switch,
  returns on switch-back — cold start and hand-off to a running instance,
  primary and secondary monitor; GNOME workspace settings restored after a
  clean quit, and after a `kill -9` + restart; Cinnamon settings restored
  after a clean quit (step 2.6 — never did before); a native-Wayland app is
  listed with the "can't be hidden" line; drop-to-open on GNOME/Wayland no
  longer moves the window; Cinnamon/X11 regression.

## Owed live facts (user, one minute — before A2 starts)

`xprop -root _NET_CLIENT_LIST _NET_NUMBER_OF_DESKTOPS _NET_CURRENT_DESKTOP`,
then `xprop -id <id> WM_CLASS _NET_WM_PID` for PyCharm's window: confirms it
is XWayland (`jetbrains-pycharm`; recent JetBrains releases can run as a
native Wayland client, which no part of this plan can park) and that its pid
is the launched one (cold start) or not (hand-off), and that Mutter publishes
the desktop atoms on the XWayland root.

## Touches

`commands/apps.rs`, `commands/ide.rs`, `commands/subwindow.rs` (struct
literals only), `services/proc_table.rs`, `services/window_service.rs`,
`services/project_runtime.rs`, `platform/{mod.rs, x11.rs, null.rs}`,
`lib.rs` (one call in `RunEvent::Exit`), `commands/workspace.rs`,
`src/lib/workspaceCaps.ts` (new), `ProjectFilesView.tsx`,
`SettingsPanel.tsx`, `stores/windows.ts` (type only, if needed), i18n,
`untested.ts`, `docs/help/project-desktop.md`, `todo/group-c-workspace.md`,
filemap rows.

## Organisation

Mixed risk, two disjoint subsystems (tracking in `commands/`+`services/`,
GNOME routing in `platform/`) with the existing `WorkspaceBackend` trait as
the contract. Phase 1 is split in two (A1 alone was ~5 files with the two
largest edits in `apps.rs` plus a new cache and the IDE adoption — over one
agent's budget):

1. **A1a ∥ A2** in separate worktrees.
2. **A1b ∥ A3**, both on top of A1a (A1b needs the marker/family/resolver;
   A3 needs A1a's row semantics and Phase 1 step 4's read-time resolve only
   for accuracy, not to compile). Disjoint files: A1b touches `ide.rs`,
   `window_service.rs`, `project_runtime.rs` and the resolver/prune code in
   `apps.rs`; A3 touches `workspace.rs` and the frontend.
3. One final reviewer over the merged tree.

Agents: 1 plan reviewer → 2 parallel → 2 parallel → 1 final reviewer (never
more than 2 at once; all build-heavy). No per-step reviewer: every step is
covered by pure unit tests and the final review.

Hot shared files: A1a/A1b/A2 do **not** edit the filemaps, i18n dictionaries
or `untested.ts`; they list wanted rows in the handoff. A3 owns i18n +
`untested.ts` + the help doc; the main agent applies filemap rows at merge.
`lib.rs` is touched only by A2 (one call). After merge: `npm run
backend:stale` and report it (AGENTS.md); never restart the app.

## Agent steps

| Step | Plan sections | Files |
|------|---------------|-------|
| A1a tracking core | Phase 1 steps 1–3 + their Rust tests | `services/proc_table.rs`, `commands/apps.rs` (marker, `TrackedWindow::launch_id`, family, `launched_exit_action`/`watch_child_exit`/`prune_dead_windows_with`, one-pass Wayland scan, `resolve_window_for_launch`), `commands/subwindow.rs` + `services/window_service.rs` (struct literals only) |
| A1b switch + IDE | Phase 1 steps 4–5 + their Rust tests | `services/window_service.rs`, `services/project_runtime.rs`, `commands/ide.rs`, `commands/apps.rs` (read-time resolve in `prune_dead_windows`, IDE adoption at launcher exit) |
| A2 GNOME on x11 backend | Phase 2 (1–6) + its Rust tests | `platform/mod.rs`, `platform/x11.rs`, `platform/null.rs`, `lib.rs` (exit `cleanup` call) |
| A3 frontend honesty | Phase 3 + frontend tests + QA rows | `commands/workspace.rs` (capabilities field), `src/lib/workspaceCaps.ts` (new), `ProjectFilesView.tsx`, `SettingsPanel.tsx`, i18n, `untested.ts`, `docs/help/project-desktop.md`, `todo/group-c-workspace.md` |

## Plan review (2026-10-26)

Checked against the code at `ebb707f6` + working tree. Fixed decisions
untouched. Changes:

- **Phase 1.1:** the marker can't be the row id (that is built from the pid
  *after* `spawn`); now a pre-spawn opaque token on a non-serialized
  `TrackedWindow::launch_id`, set in `launch_command`'s callers, via
  `app_env!("LAUNCH_ID")`. OS-default opens stay unmarked. Linux-only reader.
  Leak into IDE children (terminals, Gradle daemons, browsers) named and
  bounded.
- **Phase 1.2:** "any marked process alive" would keep a row alive for hours
  through a detached Gradle daemon → *family* = marked processes alive when
  the launcher exits. Window evidence is partial under Wayland; rules
  spelled out.
- **Phase 1.3:** resolver skips windows other rows hold and requires a
  project-title match for IDE rows (one JVM, several projects).
- **Phase 1.4:** `resolve_missing_window_ids` takes a row resolver (a pid-0
  row has no pid to resolve); read-time resolve added via
  `prune_dead_windows`, keeping `workspace.rs` out of A1.
- **Phase 2.1:** pure `route()` for cross-OS tests; segment match on
  `XDG_CURRENT_DESKTOP`; on-demand XWayland cost noted.
- **Phase 2.2:** write/record/restore only what differs; on Mutter
  `cleanup`'s `request_desktop_count` would itself write `num-workspaces`,
  so it is skipped where a settings table exists.
- **Phase 2.3:** made concrete per method. New gates: `supports_embedding`
  and `position_window` under Wayland (the latter would otherwise move
  XWayland windows to a garbage drop point once ids resolve). No
  `gnome` protected token (segment matching would protect `org.gnome.*`).
- **Phase 2.5:** no crash guard exists (verified); restore file in the state
  dir + brand-name fallback.
- **Phase 2.6 (new, sibling bug):** `backend.cleanup()` is never called on a
  clean quit — only from `Drop`, which Tauri never runs at exit — so
  Cinnamon's settings are very likely never restored today. Explicit call
  in `RunEvent::Exit`.
- **Phase 3:** `wayland_session` capability field instead of a per-window
  backend answer; browser client's `{}` handled; no command-class change
  needed; stale `workspaceNoParking` string and help table added.
- **Organisation:** A1 split into A1a (core) and A1b (switch + IDE);
  schedule A1a∥A2 → A1b∥A3 → final review; `lib.rs` added to A2.

Not verified (needs a live session, user's job): Mutter honouring
`_NET_CURRENT_DESKTOP` / `_NET_WM_DESKTOP` from an XWayland client, Mutter's
`_NET_NUMBER_OF_DESKTOPS` → GSettings write, whether PyCharm is XWayland on
this host, and that Cinnamon's restore truly never ran (inferred from tao's
`process::exit`, not observed).

Blocking questions for the user: none. One to confirm when convenient: a
project-opened row whose window can't be seen and whose launch family died
(e.g. a hand-off to an already-running native-Wayland app) is now kept as a
delist-only row instead of vanishing — the plan assumes "keep, the user
removes it" is wanted.
