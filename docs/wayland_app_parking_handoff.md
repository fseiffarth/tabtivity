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

## A1b — switch + IDE (Phase 1 steps 4–5)

Commit: `ecde7510` (code) + the commit adding this section (branch
`worktree-agent-aef0a4200f53c2932`, on A1a's `bfe5480f`). Files:
`commands/apps.rs`, `commands/ide.rs`, `services/window_service.rs`,
`services/project_runtime.rs`. `commands/workspace.rs` untouched (A3's).

### What landed

- **Row resolver.** `window_service::resolve_missing_window_ids(windows,
  project_id, resolve: FnMut(&TrackedWindow) -> Option<u64>)`. Windows/macOS
  wrap `resolve_window_id_for_pid(w.pid)` and now skip pid-0 rows (they
  used to ask the OS for pid 0's windows).
- **Linux resolver.** `apps::resolve_missing_launch_windows(reg, scope)`
  (no-op off Linux-desktop) → `resolve_missing_launch_windows_with(reg,
  scope, windows, marked)` (pure, injected scan + marked lookup). Per
  windowless project-owned row: pids = `proc_table::marked_procs(&snapshot(),
  launch_id, track.since)` (cached snapshot) plus the row's own pid when
  non-zero → `resolve_window_for_launch`; a pid-0 `ORIGIN_PROJECT_IDE` row
  with `ide_project` facts additionally adopts the IDE's window showing the
  project (`adopt_project_window`). `held` starts as every row's window id
  and grows as rows resolve, so two rows never take one window. The scan is
  lazy (`OnceCell`): none when no row has pids or IDE facts.
- **Switch time.** `project_runtime::switch` step 5 calls it on Linux
  (cfg `not(windows|macos)`); the `allow(unused_mut)` cfg and the "Linux
  resolves at launch" comment are gone.
- **Read time.** `prune_dead_windows` runs the resolve first, then the prune;
  both share one `OnceCell` scan (`current_window_list` removed).
- **IDE facts on the launch.** Choice beyond the A1a note: instead of
  filling `LaunchTrack::ide_project` after `do_launch` returns (a race — a
  hand-off launcher can exit and its watcher read the track before
  `ide.rs` writes it), `do_launch_project_ide(registry, exec, args, target,
  project_id, ide, names)` passes them into `record_launch`, before the
  watcher thread starts. `do_launch` and it share `launch_tracked` (8 args,
  `allow(clippy::too_many_arguments)`). `ide.rs` computes
  `project_window_names` once and hands it to both the raise check and the
  launch.
- **Exit adoption.** `exit_adoption(row, clients, family_pids, held, ide,
  new_window)` (pure): family window by pid first; with no family, an IDE
  row with facts adopts by `adopt_project_window` (never the
  any-new-window guess), any other row keeps `find_new_window(&before, 1)`;
  a live family that shows no window gets no guess (as A1a).
- **Raise path.** `track_raised_window(reg, wid, exec, target, project)`
  returns the row holding the window or inserts `row_for_raised_window`:
  id `ide-window-<wid>`, pid 0, `window_id`, `ORIGIN_PROJECT_IDE`, role
  `ide`, file = target, no `launch_id`, no launch track.
  `open_project_in_ide` now always returns `Some(row)` on a raise (the
  frontend already refreshes after the call; no notify needed).
- **pid-0 window-only liveness.** `prune_dead_windows_with` gained
  `pid0_window_liveness: bool` (`PID0_WINDOW_LIVENESS = cfg!(linux)`): a
  pid-0 row with a window id is a prune candidate judged by the list alone
  (gone → removed with its track; `Unknown` → nothing). Applies to every
  pid-0 row with an id (OS-default opens, demoted hand-offs, raised rows),
  not just IDE rows. Off on Windows/macOS: their enumerations list *visible*
  windows only, so a parked (`SW_HIDE`) window would be pruned.

### Gotchas

- Heredocs/`python3 - <<EOF` in Bash are refused by this worktree's
  isolation check ("too complex"); scripts written to the scratchpad and run
  by path work.
- Under Wayland every Apps-view read of a scope holding a live, windowless
  (native) row now opens one X connection (the read-time resolve finds pids
  to try). `get_opened_windows` is a sync command (main thread) and holds
  the registry lock across it — a few ms per read. Making it `async` +
  `try_blocking` would be the fix; it is in `workspace.rs` (A3's file), so
  left alone — merge-time call.

### Gates

All green on `ecde7510` (`CARGO_TARGET_DIR=<worktree>/target`,
`CARGO_INCREMENTAL=0`):

- `cargo test -q -p tabtivity --lib`: 4752 passed, 7 ignored (A1a: 4742).
  New: 9 in `apps.rs` (hand-off adopts the project window → `KeepDemoted`,
  held skip, no guess; guess only without family/IDE facts; read/switch
  resolve by marker + IDE project from one scan; no scan without anything
  to resolve by; two rows never share a window; `row_for_raised_window` +
  `track_raised_window`; pid-0 window-only liveness incl. off-Linux and
  `Unknown`; adopted hand-off pruned once its window closes;
  `record_launch` keeps `ide_project`), 1 in `window_service.rs` (row
  resolver reaches pid-0 rows); 3 existing `resolve_missing_window_ids`
  tests adapted.
- `cargo test -p tabtivity --no-default-features --lib --test server_secrets`:
  4612 + 1 passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `cargo clippy -p tabtivity --no-default-features --lib -- -D warnings`: clean.
- `scripts/brand-check.sh`, `git diff --check`, `scripts/privacy-check.sh`
  (staged, 572 lines): pass.
- **Not run:** the Windows clippy / macOS check — the Windows build needs
  crates not in the read-only `~/.cargo` cache (`dyn-clonable`; "Read-only
  file system"). The only Windows/macOS-compiled change is the
  `project_runtime` resolver closure (`match w.pid { 0 => None, pid =>
  resolve_window_id_for_pid(pid) }`). Run `scripts/ci-local.sh` at merge.
- `npm run backend:stale` not run (worktree; main agent after merge).

### Wanted filemap rows (`docs/filemap_backend.md`, apply at merge)

- `commands/apps.rs` row (on top of A1a's): "`resolve_missing_launch_windows`
  (Linux switch-time + Apps-view-read resolve by marker pids / IDE project
  title, one lazy scan shared with the prune); pid-0 rows with a window id
  live while it stays in the X client list (Linux); `do_launch_project_ide`,
  `track_raised_window` / `row_for_raised_window` (raised IDE window → pid-0
  `project_ide` row)".
- `commands/ide.rs` row: add "a raised window no row holds gets a pid-0
  row; launches carry the IDE + project window names for hand-off adoption".
- `services/window_service.rs` row (line 284): add
  "`resolve_missing_window_ids` takes a row resolver (pid-0 rows resolve by
  launch marker)".
- `services/project_runtime.rs` row (line 257): "step 5 re-resolves missing
  window ids on every OS (Linux via `apps::resolve_missing_launch_windows`)".

### Flagged for user

- Nothing live-verified. Whether PyCharm's window is XWayland and titled
  `proj – file` (the owed live facts) decides whether hand-off adoption and
  the read-time resolve ever find it.
- Window-only liveness now also prunes OS-default opens (`opener::open`,
  pid 0) and demoted hand-offs once their window leaves the client list —
  previously such rows stayed until "Remove from list". Linux only.
- A raised IDE row has pid 0, so the Apps view offers "Remove from list",
  not "Close" — Tabtivity never signals an app it did not start.

## A3 — frontend honesty (Phase 3)

Commits: `dcbd253c` (code, tests, i18n, help, QA rows) + `05d37191` (a
stale-path test fix, see Gotchas) + the commit adding this section. Branch
`worktree-agent-a9a73212bba58156e`, on A1a's `bfe5480f`. Disjoint from A1b
(no `apps.rs`/`ide.rs`/`window_service.rs`/`project_runtime.rs` edits).

### What landed

- **Backend.** `WorkspaceCapabilities` gains `wayland_session: bool`;
  `capabilities_of(backend, wayland_session)` stays pure, the command passes
  `platform::session_is_wayland()`. `null_backend_reports_it_cannot_park`
  extended (flag passed through, snake_case JSON keys). No new command → no
  `command_class` row; `the_generated_command_classes_ts_is_current` passed
  in the lib run.
- **`src/lib/workspaceCaps.ts`** (new): `parseWorkspaceCaps` (null unless
  `can_park` is a boolean; a missing `wayland_session` → `false`, so an
  older backend never triggers the Wayland line), `loadWorkspaceCaps` (one
  module-level promise per session, failures → `null`), `useWorkspaceCaps`,
  `useCanPark`, `rowStaysVisible(caps, windowId)` (pure per-row rule:
  `canPark && waylandSession && window_id == null` → `"wayland"`),
  `resetWorkspaceCaps` (test seam, as `superKey.ts`).
- **Settings.** `WorkspaceParkingNote` uses `useCanPark()` (Linux only, as
  before); its stray doc comment moved onto it.
  `settings.workspaceNoParking` reworded in all five dictionaries (names
  GNOME X11/Wayland, Cinnamon, KDE X11; Wayland = XWayland windows only).
- **Apps view** (`ProjectFilesView.tsx`, `view === "windows"`): rows are now
  `Fragment`s so a muted `file-tree-empty` line can follow a row without
  wrapping `.file-entry`. New keys `projectFilesView.noParkingNote`,
  `projectFilesView.waylandStaysVisible` (+ `UntestedTag` and `untested.ts`
  rows with those ids).
- **Help** `docs/help/project-desktop.md`: table reworded, plus one
  paragraph on GNOME/Cinnamon workspace settings being set and restored.
- **QA** `todo/group-c-workspace.md` #22: seven 🖐️ items with ✅/❌ pairs
  (all four platforms on the PyCharm switch item, Linux X11/Wayland where
  only those apply — the file's precedent).

### Choices beyond the plan's letter

- **`!can_park` is said once for the list**, not on every row (one muted
  line above the rows, Linux only). Per row it would repeat the same
  sentence N times; the per-row line is kept for the Wayland case, where it
  distinguishes rows.
- **Help table sibling fix:** the old row "KDE Plasma (Wayland) — one
  virtual desktop per project" was wrong (`wayland_kde.rs`: show/hide are
  no-ops, `can_park` false), and "Linux, X11 — hidden desktop" was wrong for
  XFCE/X11 (→ `null`). Rows are now KDE X11 + Cinnamon / GNOME (X11 and
  Wayland) / KDE Wayland, XFCE and others.
- The Wayland line also shows on a pid-0 windowless row (hand-off/OS-default
  open) — true there too: nothing can hide it.

### Gotchas

- The plan file is untracked in the main checkout, not in any branch; A3
  read it from there.
- `src/__tests__/mail/MailAutoCheck.test.ts` read
  `services/mail_engine.rs`, moved to `services/mail/` by `dd8cb0f1`: the
  only failing vitest test on the base. Fixed in `05d37191` (path only).
- Render tests of `ProjectFilesView` with a catch-all `invoke` mock must
  answer `git_repo_root` with `null`, not `[]` (an unhandled `p.replace`
  rejection otherwise).
- The worktree's isolation check refuses compound shell lines (`$PWD`,
  `&&` around `rtk`, `cd` into the main checkout); use literal paths and
  simple commands.

### Gates (on `05d37191`)

- `npm run build`: green (tsc + desktop, mobile, web bundles).
- `npm test -- --reporter=dot`: 955 files, 9506 tests — 9505 passed + the
  mail test above, which passes after `05d37191` (5/5 re-run). New: 5 in
  `files/AppsViewParking.test.tsx` (first Apps-view render test: Wayland
  line only on windowless rows, nothing on X11, one list line when nothing
  parks, silence on `{}`, pid-0 IDE row has "Remove from list"); 3 added to
  `projects/WorkspaceParkingNote.test.tsx` (pre-field backend, `{}`, one
  fetch for two mounts).
- `npm run lint`: 0 errors, 28 warnings — none new (the two in
  `ProjectFilesView.tsx` are the existing `refresh`/`refreshGit` deps).
- `cargo test -q -p tabtivity --lib`: 4742 passed, 7 ignored.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `cargo clippy -p tabtivity --no-default-features --lib -- -D warnings`: clean.
- `scripts/brand-check.sh`, `git diff --check`, `scripts/privacy-check.sh`
  (staged): pass.
- Not run: `cargo test` for the daemon build (`--no-default-features --test
  server_secrets`) — `workspace.rs`'s change is in code both builds compile,
  covered by the no-default-features clippy; `scripts/ci-local.sh`;
  `npm run backend:stale` (main agent, after merge).

### Wanted filemap rows (apply at merge)

- `docs/filemap_frontend.md`, new row near the other `lib/` rows:
  "`lib/workspaceCaps.ts` | `workspace_capabilities` fetched once per session
  (`useWorkspaceCaps`/`useCanPark`; `null` on the browser client's `{}` or an
  older backend) + `rowStaysVisible`: under Wayland a row without a window id
  (not XWayland) stays on screen on a project switch."
- `files/ProjectFilesView.tsx` row: Apps view "says once when the desktop
  parks nothing and marks Wayland rows it can't hide (`lib/workspaceCaps`)".
- `docs/filemap_backend.md` `commands/workspace.rs` row: `workspace_capabilities`
  also answers `wayland_session`.

### Flagged for user

- Nothing live-verified; both new lines wear `UntestedTag`
  (`projectFilesView.noParkingNote`, `projectFilesView.waylandStaysVisible`).
- Decide when convenient: the "parks nothing" note is one line per list
  rather than per row (see Choices).
- The help table claims GNOME parks on X11 and Wayland — true only once A2
  lands and the owed live facts (Mutter honouring `_NET_WM_DESKTOP` from
  XWayland) hold.
