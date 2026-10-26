# GNOME/Wayland app parking — implementation handoff

Plan: `docs/wayland_app_parking_plan.md` (uncommitted in the main checkout
when A1a ran; A1a's worktree branched from develop `bfc89615`). One section
per agent step.

## A1a — tracking core (Phase 1 steps 1–3)

Commit: `756b9fd3` (code) + the commit adding this file (branch `worktree-agent-a4d856807ecbd3bc6`, on develop
`bfc89615`). Files: `commands/apps.rs`, `services/proc_table.rs`;
`commands/subwindow.rs`, `services/window_service.rs`,
`tests/services_tests.rs` got `launch_id: None` in their `TrackedWindow`
literals only.

### What landed

- **Marker.** `launch_command(exec, args, file, launch_id)` sets
  `app_env!("LAUNCH_ID")` when given one; the old body is
  `unmarked_launch_command`. `new_launch_id()` = 16 bytes of `getrandom` →
  32 hex chars (`None` without OS randomness → unmarked launch, old
  behaviour). Marked: `do_launch` (so `ide.rs`, `restore_service.rs`) and
  `open_file_blocking`'s handler branch; the `opener::open` branch stays
  unmarked, pid 0.
- **Row + registry.** `TrackedWindow::launch_id: Option<String>`,
  `#[serde(default, skip_serializing)]`. `WindowRegistry::launches:
  HashMap<row id, LaunchTrack>`; `LaunchTrack { since, family, ide_project }`:
  - `since` = the launcher's start tick (`proc_table::start_time(pid)` right
    after spawn — a zombie still answers), the floor for the marked scan;
  - `family: Option<Vec<FamilyMember{pid,start}>>` — `None` while the
    launcher runs, set by the exit watcher;
  - `ide_project: Option<(IdeId, Vec<String>)>` — **A1b fills it** (see below).
  `record_launch` inserts the track for marked rows; `prune_dead_windows`
  sweeps tracks whose row is gone (any removal path).
- **proc_table.** `UidCache` generalised into `EnvCache { parse }` (one per
  variable); `environ_launch_id` (empty value = no marker), `launch_id(proc)`
  (Linux; reads `/proc/<pid>/environ` only when `/proc/<pid>` is owned by our
  euid; elsewhere always `None`), `marked_procs(snap, id, since)` (only
  processes started ≥ `since` are asked), `start_time(pid)` (`alive` now uses
  it). Shared `environ_value` parser.
- **Family / exit.** `watch_child_exit` → fresh table walk
  (`snapshot_within(ZERO)`) → family = marked procs alive now; one window
  scan (`window_scan()` → `(WindowList, Vec<ClientWindow>)`); for a row
  without a window id: `resolve_window_for_launch` over the family pids, and
  only when the family is empty the old `find_new_window(&before, 1)` guess.
  `launched_exit_action(window_id, &WindowList, adopted, &family,
  project_opened)`:
  - family alive → `KeepFamily { lead, adopt }`: row `pid` := the family's
    oldest member (`family_lead`: min start, then pid) so "Close" reaps the
    app, not a dead/reused launcher pid; `track.family = Some(family)`;
  - else adopted window → `KeepDemoted(Some)`; listed window →
    `KeepDemoted(None)`; window provably gone → `Remove`;
  - list can't tell → project-opened row `KeepDemoted(None)` (pid 0,
    delist-only), global/manual row `Remove`.
  Demoted rows keep their track with `family = Some([])` (A1b's pid-0
  resolver can still use `launch_id`).
- **`WindowList`** = `Complete(ids)` (X11, Windows, macOS) |
  `XWaylandOnly(ids)` (Wayland: authoritative only for rows with an id) |
  `Unknown` (enumeration failed; non-desktop build). `shows(window_id) ->
  Option<bool>`.
- **Prune.** `prune_dead_windows_with(reg, scope, alive, live_lead,
  window_list)`: row with track `family: None` → left to its watcher; with a
  family → alive while `live_lead` (members with matching start time) answers,
  and the row moves to that lead; untracked row → `alive(pid)`. Dead rows:
  window listed → unchanged (as before); provably gone → removed (row +
  track); can't tell (Wayland, no id) → pid 0; `Unknown` list → nothing
  changes. pid-0 rows still never pruned (A1b adds window-only liveness).
- **Wayland scans.** `list_window_ids`, `find_window_for_pid`,
  `find_new_window` lost their Wayland short-circuits; `scan_attempts` caps
  the pass count at 1 under Wayland, and the retry loops no longer sleep
  after the last pass (X11 keeps 20 × 100 ms). `x11_client_windows` now
  returns `ClientWindow { id: u64, pid, protected, class, title }` with all
  property requests pipelined (sent before any reply is awaited);
  `window_pid`/`is_protected_window` helpers are gone.
  `find_window_for_title` (x11.rs) untouched — keeps its short-circuit.
- **Resolver.** `pub(crate) resolve_window_for_launch(row, windows, marked,
  held, ide: Option<(IdeId, &[String])>)`: first non-protected window whose
  `_NET_WM_PID` ∈ `marked`, not in `held` (`held_window_ids(reg, own)`), and
  for `ORIGIN_PROJECT_IDE` rows passing `ide_detect::window_shows_project`
  (no `ide` facts → resolves nothing for an IDE row).

### For A1b

- Fill `LaunchTrack::ide_project` for `ORIGIN_PROJECT_IDE` rows (after
  `do_launch` returns in `ide.rs`: `reg.launches.get_mut(&win.id)`), from
  `ide_detect::project_window_names(dir, target)`. Until then an IDE row's
  window is never resolved by the marker path (exit falls back to the
  family rule / `find_new_window` guess as before).
- Read-time resolve in `prune_dead_windows`: reuse `window_scan()`,
  `held_window_ids`, `resolve_window_for_launch`, and for marked pids
  `proc_table::marked_procs(&snapshot(), id, track.since)` (the cached
  snapshot is fine there). Note `prune_dead_windows` runs under the registry
  lock — keep the scan conditional (only when a windowless marked row exists).
- Window-only liveness for pid-0 rows with a window id is still yours (step 5).

### Gotchas

- The worktree was created from `main` (`d2d6083c`), not develop; A1a reset
  its branch to develop `bfc89615` before starting. Check the next
  worktrees' base.
- In this fence the RTK hook rewrites `git …` to `rtk git …`, which the
  worktree isolation check refuses: call `/usr/bin/git` directly.
- `platform/x11.rs` `session_is_wayland`'s doc comment still says the apps
  scans "skip themselves" under Wayland — now only `find_window_for_title`
  does. Left alone (A2's file); reword at merge or in A2.
- Under Wayland every launch now opens one X connection (the `before`
  baseline and the one-pass scan), which starts an on-demand XWayland if none
  runs — the same accepted cost as A2's `try_new`.

### Gates

All green on `756b9fd3` (own `CARGO_TARGET_DIR` = `<worktree>/target`,
`CARGO_INCREMENTAL=0`):

- `cargo test -q -p tabtivity --lib`: 4742 passed, 7 ignored (run before a
  clippy-only test tweak; the `commands::apps` + `services::proc_table`
  tests re-run after it: 69 passed). New: 15 tests in `apps.rs`
  (family keep/lead, unknowable list → demote vs remove, `WindowList::shows`,
  prune by family / later marked daemon ignored / watcher-pending /
  Wayland demote / failed enumeration / track sweep, resolver held + IDE
  title, `record_launch`, marker opaque + not serialized, `launch_command`
  env), 5 adapted; 3 in `proc_table.rs` (`environ_launch_id` absent/empty/
  `=`/exact + legacy name, `marked_procs` floor, `start_time`) plus a
  non-Linux-only one.
- `cargo test -p tabtivity --no-default-features --lib --test server_secrets`:
  4602 + 1 passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `cargo clippy -p tabtivity --no-default-features --lib -- -D warnings`: clean.
- `scripts/brand-check.sh`, `git diff --check`, `scripts/privacy-check.sh`: pass.
- Not run here: Windows/macOS cross-checks (`scripts/ci-local.sh`) — the
  new code is cfg'd (`start_time`/`launch_id` → `None`, `window_scan` →
  `Complete(list_window_ids())`); run ci-local at merge.
- `npm run backend:stale` not run (worktree; the main agent runs it after
  merge).
- The post-commit hook printed "EMBEDDED MOBILE PWA IS STALE" (the running
  sidecar vs the main checkout's `mobile-dist/`); unrelated, left alone.

### Wanted filemap rows (`docs/filemap_backend.md`, apply at merge)

- `commands/apps.rs` row: add "launch marker (`TABTIVITY_LAUNCH_ID`,
  `TrackedWindow::launch_id`, not serialized) + `WindowRegistry::launches`
  (`LaunchTrack`: launch family snapshotted at launcher exit, liveness = any
  member alive); `WindowList` (Complete / XWaylandOnly / Unknown) — an
  unknowable list never removes a project-opened row (demoted to pid 0);
  one-pass window scans under Wayland; `resolve_window_for_launch`".
- `services/proc_table.rs` row: add "`launch_id` / `environ_launch_id` /
  `marked_procs` (same-user environ reads, cached per process image like
  `tab_uid`), `start_time`".

### Flagged for user

- Nothing live-verified (no X display reachable from the fence). The plan's
  owed live facts (PyCharm XWayland? pid on cold start vs hand-off) still
  decide whether the marker resolver finds PyCharm's window.
- Choice made beyond the plan's letter: a family-kept row's `pid` becomes the
  family's oldest live member (so "Close" closes the app) instead of the dead
  launcher's pid or 0.
- Confirm when convenient (from the plan): a project-opened row whose window
  can't be seen and whose family died is kept delist-only rather than
  vanishing.

## A2 — GNOME on the x11 backend (Phase 2 steps 1–6)

Commit: `955c73dc` (code) + the commit adding this section (branch
`worktree-agent-a122d698db325032a`, on A1a's `bfe5480f`). Files:
`platform/{mod.rs, x11.rs, null.rs}`, new `platform/workspace_settings.rs`,
`lib.rs`, `tests/embed_capability_tests.rs`.

### What landed

- **Routing.** `platform::route(desktop, wayland) -> Route` (`KdeWayland` |
  `X11(X11Desktop)` | `Null`), pure, compiled everywhere. A `:` segment equal
  to `gnome` (any case) → `X11(Gnome)`, X11 and Wayland; KDE/Cinnamon as
  before; everything else `Null`. `X11Backend::try_new(X11Desktop)` (was
  `try_new()` reading the env itself); a failed connect → `null`.
- **Settings table.** `platform::workspace_settings` (pure, injected
  `get`/`set`, every OS): `CINNAMON` (its three keys, `strict` = a failed set
  fails the backend as before, `property_fallback` = the `ChangeProperty`
  fallback in `move_window`, Cinnamon only) and `GNOME` (mutter
  `dynamic-workspaces` → false, `workspaces-only-on-primary` → false,
  wm.preferences `num-workspaces` raised to 2 only when < 2,
  `workspace-names`; lenient: a failed set is logged and not recorded).
  `plan` / `restore_ops` / `take_over` / `give_back`. Unreadable or
  unparsable keys skipped; only differing keys written; restore in reverse
  write order. `cinnamon_workspace_names{,_value}` → `workspace_names{,_value}`
  there (now compares parsed lists, so `@as []` and spacing don't matter).
- **Crash leftovers.** `<state_dir>/workspace_settings_restore.json`
  (`RESTORE_FILE`, `storage::write_private_atomic`) written before the first
  set, rewritten if a lenient set failed, deleted by `give_back`.
  `take_over` restores a found file first (even with no table, e.g. KDE
  after a Cinnamon crash), then plans afresh. No file + `workspace-names`
  starting with the brand pair (current, or legacy counted via
  `legacy_hit("workspace-names")`) → recorded as `None` = `gsettings reset`.
  A corrupt file is logged and removed. A strict failure undoes its own
  earlier writes and removes the file.
- **cleanup.** `request_desktop_count(original)` only without a table (KDE);
  then `give_back`. `try_new` also gives back if `ensure_desktop_count`
  fails after the take-over.
- **Wayland gates.** `supports_embedding` = `embeds(wayland)`,
  `position_window` returns `Ok(())` untouched when `!positions(wayland)`
  (pure predicates, tested); `wayland` read once in `try_new`. Other methods
  unchanged as the plan's audit says; `PROTECTED_CLASSES` unchanged.
- **Exit.** `RunEvent::Exit` calls `backend.cleanup()` right after the
  Mobile host stop, before root MCP / PTY / container teardowns.
- **Docs.** `mod.rs` module doc, `null.rs` doc, x11 module doc, and the stale
  `session_is_wayland` doc A1a flagged.

### Choices beyond the plan's letter

- **Sidecar gets `null` (sibling bug, fixed).** The phone sidecar is the same
  binary (desktop feature) and built its singletons through
  `WorkspaceState::new()` → `detect_backend()`: on Cinnamon it already ran a
  second `X11Backend` (taking the settings over again, recording the
  window's values as the "originals"); with GNOME routed it would have done
  so on this host too and raced the restore file. `Singletons::new` now takes
  the `WorkspaceState`; the window passes `WorkspaceState::new()`,
  `standalone_core_state()` passes `NullBackend`. `workspace.rs` untouched.
- **No test constructs a live backend.** `platform::mod` tests that call
  `detect_backend()` are now `cfg(not(all(linux, desktop)))`, and the
  integration test `x11_backend_supports_embedding_when_available` (which ran
  `X11Backend::try_new()` against any reachable X server) is removed: on a
  developer's GNOME/Cinnamon desktop either would take over real GSettings
  and touch the real restore file. Covered by `route` + `embeds` tests.
- **Wait before the EWMH count request.** After a take-over, `try_new` polls
  `_NET_NUMBER_OF_DESKTOPS` up to 1 s (20 × 50 ms) before
  `ensure_desktop_count`, because GSettings land asynchronously and an early
  `_NET_NUMBER_OF_DESKTOPS` request would (on Mutter) write an unrecorded
  `num-workspaces`.
- GNOME write order: dynamic → only-on-primary → num → names.

### Gotchas

- Under Wayland `try_new` opens an X connection at startup — starts an
  on-demand XWayland and keeps it alive while the app runs (accepted cost).
- Integration tests live in the single `it` binary (`--test it`), not
  per-file targets.
- Two instances on one desktop (dev + packaged) still each take over; the
  second sees the first's values and records little (write-only-differs),
  and the first to quit restores under the other. Not new; not fixed.
- A leftover restore file is only consulted when the `x11` connect
  succeeds (a GNOME session with XWayland disabled never restores it).

### Gates

All green (own `CARGO_TARGET_DIR` = `<worktree>/target`,
`CARGO_INCREMENTAL=0`):

- `cargo test -q -p tabtivity --lib`: 4751 passed, 7 ignored (before the
  final x11.rs wait-loop/clippy-only edits; `platform::` re-run after: 73
  passed). New: 14 in `workspace_settings` (2 of them replace x11's 4
  Cinnamon-name tests), 2 in `platform::mod` (route table, settings per
  desktop), 1 in `x11` (gates).
- `cargo test -p tabtivity --no-default-features --lib --test server_secrets`:
  4619 passed, 7 ignored (2 suites).
- `cargo test -q -p tabtivity --test it embed`: 11 passed.
- `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo clippy -p tabtivity --no-default-features --lib -- -D warnings`,
  `cargo clippy -p app-serverd --all-targets -- -D warnings`: clean.
- `scripts/brand-check.sh`, `git diff --check`, `scripts/privacy-check.sh`:
  pass.
- Not run: `scripts/ci-local.sh` (Windows/macOS legs) — `workspace_settings`
  compiles on every OS (pure, `tempfile` tests); run at merge.
  `npm run backend:stale` is the main agent's after merge.

### Wanted filemap rows (`docs/filemap_backend.md`, apply at merge)

- `platform/mod.rs`: replace "There is no GNOME backend" wording with "pure
  `route(desktop, wayland)`: KDE (Wayland → `kde-wayland`), Cinnamon and
  GNOME (X11 and Wayland, `:`-segment match) → `x11` with
  `X11Desktop::settings()`, else/failed connect → `null`".
- `platform/x11.rs`: add "GNOME/Mutter too; under Wayland XWayland windows
  only, `embeds`/`positions` gates; workspace GSettings via
  `workspace_settings`, given back in `cleanup` (called from
  `RunEvent::Exit`)".
- New `platform/workspace_settings.rs`: "per-desktop workspace GSettings
  table (Cinnamon, GNOME): write only what differs, record/restore only what
  was written, crash restore file `<state_dir>/workspace_settings_restore.json`,
  brand-named leftovers reset; pure over injected gsettings, every OS".
- `lib.rs` / `standalone_core_state`: "null workspace backend (the window
  parks)".

### Must be verified live

- GNOME/Wayland: the backend comes up as `x11` (Settings → Layout), the
  four keys change (`gsettings get org.gnome.mutter dynamic-workspaces` …)
  and the restore file appears; after a clean quit all four are back and
  the file is gone; after `kill -9` + restart they are restored before the
  new take-over.
- Mutter honours `_NET_WM_DESKTOP` / `_NET_CURRENT_DESKTOP` from an
  XWayland client; the parked workspace is the one to the right.
- Mutter's `_NET_NUMBER_OF_DESKTOPS` → `num-workspaces` write (inferred), and
  that the 1 s wait suffices for the count to appear.
- Cinnamon: settings now restored on a clean quit (never before).
- Drop-to-open on GNOME/Wayland no longer moves the window.

### Flagged for user

- Nothing live-verified (no X display from the fence; no `gsettings set`
  run).
- Sidecar's backend changed to `null` (above) — it never parked anything for
  the phone, but on Cinnamon it had been taking the settings over.
- The removed integration test and the Linux-gated `detect_backend` tests
  mean no test exercises a live X server any more; that is deliberate.
