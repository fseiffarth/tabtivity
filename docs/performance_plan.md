# Performance — plan

Status: plan only (2026-10-06, revised after two reviews the same day). No
code changed. Findings come from five read-only code audits (frontend render
cost; backend hot paths; startup, IPC and bundle; existing perf debt +
terminal/viewer paths; many open tabs + PDF viewers), then a correctness
review against the tree and a priority review. Nothing was measured live —
the app was not launched — so every "cost" below is derived from code and
must be confirmed by §1 first.

User request: "Tabtivity is too slow", in particular with many tabs open at
once and with heavy PDF viewers.

## 0. Diagnosis in one paragraph

The renderer is a single WebKitGTK thread (DMABUF is off, so JS, layout and
paint share it), and the app never lets it idle. Three things keep it busy
with no user input: (a) store churn — a viewer scroll pause, a tab status
flip or a layout measure replaces `tabsByScope`/`layout` and re-renders the
whole shell, then rewrites the session file; (b) standing clocks — the
activity classifier ticks every 300 ms over every tab, the Reader walks up to
1200 terminal rows cell by cell several times a second, and a handful of
pollers add IPC round trips at idle; (c) every tab of every active project is
mounted at once, with a live xterm buffer and, for PDFs, a whole document
parsed in a worker — memory, GC pressure and a ~300 MB canvas rebuild on each
switch to a PDF tab. On the backend, every session, project and settings save
(and even the `get_projects` read) runs on the GTK main thread with two
fsyncs, and five independent full `/proc` walkers run every 2–15 s. The 4 MB
bootstrap chunk makes launch and every popout slow on top. The earlier
typing-latency work (PTY batcher, blur quiescence, visible-only streaming,
rtkit boost) is in the tree but almost none of it was verified live, and the
release-build baseline it asked for was never taken. Note the user already
runs a release-profile binary: CI `tauri build` and `scripts/package-dev.sh`
both use `cargo build --release` with default profile settings.

## 1. Measure first (user, host shell; nothing to launch)

The app is already running; everything below reads it from outside. The
frozen build has no devtools (`tauri.conf.json`, no `devtools` feature), so
there is no Timeline; external observation only.

Four numbers gate everything — record them at the top of this file before
step 2 of §9 and again after each step:

1. **Renderer busiest-thread CPU at idle**, normal tab set, 30 s —
   `P=$(pgrep -n WebKitWebProcess); ps -L -o tid,ni,pcpu,comm -p $P | sort -k3 -nr | head`
   plus `cat /proc/$P/schedstat; sleep 10; cat /proc/$P/schedstat` (fields
   1/2 = ns run / ns waiting). `ni` should read −10 on the busiest thread if
   `services::ui_priority` took; `systemctl status rtkit-daemon` says whether
   it could. Proves Phase A/B.
2. **Backend idle wakeups and main-thread CPU** —
   `B=$(pgrep -nx tabtivity); grep ctxt /proc/$B/status; sleep 10; grep ctxt /proc/$B/status; pidstat -t -u -p $B 5 3`.
   Voluntary switches/s at rest should be far below the 647 the old PTY loop
   produced. Add the mobile sidecar's pid if Mobile is on. Proves §7.1 and
   §7.2.
3. **Renderer RSS with all PDFs open vs closed** —
   `grep -E 'VmRSS|VmSwap' /proc/$P/status` before/after closing the PDF
   tabs. Proves §4.3/§5.3.
4. **Two stopwatch latencies** — switch to a busy agent tab; switch to a
   100-page PDF tab; time to first paint, by eye or phone video. Proves §3.2
   and §4.2.

Also check once: `settings.debug` off — not for the SidePanel meters (those
are `import.meta.env.DEV`-only and absent from the frozen build) but because
`experimental.ts:71` falls back to `settings.debug` for every unset
experimental flag, so debug on means every experimental entry point is
mounted. And which theme is active: `fancy_dark` and `light_lavender` put a
`backdrop-filter` on the always-visible `.tab-bar` (`themes.css:731-737`).
`tail -n 20 ~/.local/share/tabtivity/crash.log | grep -E 'renderer-watchdog|ipc-fallback'`
for RSS context.

## 2. Decisions

- Fix store churn, PDF rendering and the GTK-thread fsyncs before anything
  structural: cheap, high-confidence, and the §1 numbers tell whether they
  were the felt cost.
- "Sleeping tabs" (unmount long-hidden panes, keep PTYs) is the structural
  answer to many tabs. Hidden-PDF release is its first customer and lands on
  its own, earlier.
- Hidden-pane behaviour already follows a pattern (`PaneVisibleContext`,
  `RENDERER_RELEASE_MS`): extend it, don't invent a second gate.
- No new always-on timers. Periodic UI polls go through one quiesce-aware
  helper that stops when the window is blurred — **except** schedulers,
  cron, calendar alarms, CalDAV sync and the timer-lease heartbeat, which
  must run unfocused and are exempt by construction.
- PTY ownership does not change: no step may let a PTY be killed or
  double-spawned by a visibility change. The phone can start a listed tab
  via tmux at any time, so desktop spawn order stays as it is.
- Nothing here changes what the backend streams; `terminal/mod.rs` changes
  are limited to replay trimming with mode-state preservation.
- Each step is verifiable without launching the app (unit tests, build chunk
  table, `rg` counts) plus one live check the user clicks through.

## 3. Phase A — store churn and standing clocks

### 3.1 Viewer scroll must not rewrite the shell (½ day)

- `src/stores/tabs.ts:2011-2046` `pruneCollapseCollect` allocates fresh
  group/split nodes on every `writeScope`, so a `viewerState` write changes
  `layout`/`layoutByScope` identity. Return the existing `layout` when the
  key set is unchanged. This alone does not stop the persist effect
  (`CenterPanel.tsx:329-344` depends on `tabs` too), so:
- `src/stores/tabs.ts:3265-3300` `setViewerState`: move scroll/zoom state into
  a module-level `Map<tabKey, ViewerState>` (shape of
  `getDetachedViewerState`), flushed into the store on pane hide, tab close,
  the quit path (`AppShell` `onCloseRequested` → `saveLayout`,
  `AppShell.tsx:~740-750`; there is no `beforeunload` path) and at most every
  5 s. `persistScope` reads the Map at save time. The quit flush covers the
  active scope; background scopes rely on the 5 s flush.
- `useViewerState.initial` (`FileViewerPane.tsx:322-333`) must seed from the
  Map before the store, or §5.3's remount restores a stale position.
- Callers that keep their 200 ms local timer but write the Map:
  `FileViewerPane.tsx:3348-3353, 7386-7391, 7989-7992, 9339, 10612`,
  `PdfViewer.tsx:4138-4139` and the per-zoom-tick `scale` write at
  `PdfViewer.tsx:3970-3977`.
- Test: scroll a viewer 50 times; `layout` and `tabsByScope` identity
  unchanged; `syncWorkspace` called at most once.

### 3.2 Per-chunk and per-tick terminal work (½ day)

- `src/stores/activity.ts:230-250` `notePtyOutput`: look up the tab kind once
  per ptyId (a `Set` of agent pty ids kept in step with the tabs store); for
  non-agent tabs stamp `lastRawByPty`/`lastOutputByPty` only — no `stripAnsi`,
  no braille regex, no tail concat.
- `AppShell.tsx:867-878` + `src/lib/terminal/terminalBus.ts:65`: feed the
  activity store from the bus so each `terminal-output` payload is
  deserialised once.
- `activity.ts:1049-1100` `recompute` + `AppShell.tsx:921-926`: event-driven —
  a trailing 300 ms recompute scheduled only by a `note*` call or a
  BUSY/DECISION window expiry; evaluate only dirty PTYs.
- Screen readers: the Reader (`readerLive.ts:66-80`) keeps everything after
  the last echoed prompt as the shown tail, so it must **not** be clipped to
  the viewport (long answers would truncate). Give it a bounded window
  (~300 rows) instead of `MAX_ROWS` 1200 (`readableScreen.ts:414`). Clip
  hard to the bottom rows only `TerminalReaderStatus.tsx:46-54` (500 ms) and
  `TabLocalityBadges.tsx:457-467`. Make the no-style fast path in `rowSpans`
  (`readableScreen.ts:227-230`, today only when `getCell` is absent)
  caller-selected. `TerminalReaderView.tsx:716-735`: drop the 1.5 s clock
  only once `term` exists (the clock also covers "terminal not created yet").
- `TerminalView.tsx:1523-1543` `doFit`: keep `fit()` immediate,
  trailing-debounce `pty_resize` ~80 ms.

### 3.2b Replay trim on show (own step, backend; ½ day with the test)

- Backend `terminal/mod.rs:55-100` drains `pending` (cap `ROUTE_PENDING_CAP`
  1 MB, `:92`) as one `terminal-replay`; frontend caps at 2×1 MB
  (`TerminalView.tsx:1360-1362`) and writes it in one `term.write`. Agent
  TUIs repaint whole screens, so most of it is dead.
- Fix: on show replay only from the last full clear (`ESC[2J`/`ESC[H`), not
  a byte tail (a byte cut lands mid-frame). **Must preserve mode state**: a
  TUI's one-time DECSET/DECRST (`?1049h` alt screen, `?1000h/?1006h` mouse,
  `?2004h` bracketed paste) may precede the cut; track them per route and
  prepend them to the trimmed replay, or xterm ends up on the wrong screen
  typing mouse reports into Claude. Unit test in `mod.rs`: DECSET before the
  cut still replays; `batch_output` paused-clock tests stay green. The
  classifier is unaffected (AppShell deliberately ignores replays,
  `AppShell.tsx:886-887`). Until the test exists, keep the 1 MB cap.

### 3.3 Pollers (three sites first; helper sweep last)

Correct the audit: `AppResourceDisplay.tsx:82`, `StatusCluster.tsx:104`,
`DevBuildIndicator.tsx:141`, `LocalModelMenu.tsx:99`,
`ProjectSwitcher.tsx:225,248` already use `saverInterval(…, quiesce)` (×3 on
blur); `InboxIndicator.tsx:60-62` skips when not visible. Genuinely ungated:
`VpnIndicator.tsx:156`, `TimerLeaseHost.tsx:14`, `MobileIndicator.tsx:163`,
`ProjectFilesView.tsx:499`, `hostSessions.ts:158`, `AppShell.tsx:813`
(returns before IPC when nothing is connected). Today: 90 `setInterval(`
sites in 68 files.

- **First (½ day, measurable):** `AppResourceDisplay` 2.5 s → 5 s with the
  GPU `fdinfo` walk off that path (pairs with §7.2's `CACHE_TTL`, one
  change); `LocalModelMenu` `ollama_is_installed` once at mount then on menu
  open, not every 5 s; `mobile_host_status` polled by both
  `MobileIndicator.tsx:163` and `ProjectFilesView.tsx:499` → one refcounted
  store (pattern `hostSessions.ts`).
- **Last (1.5–2 days, medium gain):** `src/lib/usePoll.ts` built on
  `useQuiesce`, blurred → stop; sweep the remaining UI pollers through it.
  **Exempt** (`quiesce: false`): `AgentScheduleHost` (15 s),
  `AgentContinueHost` (30 s), `AgentCronHost` (60 s), `CalDavSyncHost`
  (60 s, `components/calendar/`), `calendar/alarms.ts:167`, and
  `TimerLeaseHost` (10 s heartbeat against a 30 s backend TTL,
  `stores/timerLease.ts:36`) — stopping these when another window is focused
  would stop scheduled prompts, cron, reminders, CalDAV and the lease.
- Gate: the `setInterval(` count must not grow; list remaining direct sites
  in §10 once the helper lands.

### 3.4 Git dots and fs-change (merged with §7.4; ½ day)

- `src/components/files/ProjectFilesView.tsx:1271-1281` listens to
  `fs-change` whatever `view` shows (debounce 120 ms, `:609-615`) and runs
  two git subprocesses per fire; `:97` also polls every 5 s while the git
  view is open. Fix: subscribe only while the git view/bar is rendered,
  otherwise set `stale` and refresh on show; debounce ≥1 s; skip while a
  refresh is in flight.
- `src/components/files/FileTree.tsx:1452-1490`: hidden trees already
  unwatch (`:1450-1475`); the remaining cost is the active tree refreshing on
  every event regardless of path. Compare the emitted path
  (`fs_watch.rs:158,191`) with the watched dir — but keep `.git` paths,
  which arrive through the same single watch slot (`fs_watch.rs:92-102`).
- Pill dots (`commands/git.rs:791` `git_dirty_probe`, already async): today
  three spawns — `status --porcelain --branch` (ahead/behind already parsed
  from the `##` header, `:701-735`), `remote`, `tag --points-at HEAD` — per
  project per tick (12 s foreground / 36 s others; 20 projects ≈ 1.5
  spawns/s). Target two (drop the has-remote spawn, cache it per project) or
  gix for status; drive refresh from the existing `.git` watcher instead of
  the timer.

### 3.5 Launch chain, cheap parts (¼ day)

- `src/stores/projects.ts:1141-1177`: issue `load_side_panel_folder` in the
  same `Promise.all` as `get_projects`/`root_work_dir`, or set `loaded`
  first.
- `src/styles/themes.css:731-737`: the `backdrop-filter` on `.tab-bar`
  (`fancy_dark`, `light_lavender`) and `.subwindow-files` (`light_lavender`)
  re-blurs on every repaint beneath on WebKitGTK's software path → semi-opaque
  backgrounds.
- `fillBrand` (`brand.ts:171-181`, `i18n.ts:9421,9443`) is one linear pass
  over 9,004 keys at module evaluation; `en` feeds `i18nDicts/all.ts` and
  the `TranslationKey` type, so lazy filling must keep `en` typed. Low value;
  keep last or skip.

## 4. Phase B — PDF viewers

All in `src/components/embed/pdf/PdfViewer.tsx` unless noted. Only 3 of the
20 pdf test files mount `PdfViewer`, so §4.1/4.2 need new render-effect
tests: budget 1 day for the pair.

### 4.1 Zoom without re-rasterising per wheel tick (quick win)

- `:4154-4176` Ctrl+wheel calls `setScale` per tick; `PdfPageCanvas`'s render
  effect depends on `scale` (`:807`), so each tick allocates an off-screen
  canvas up to `PDF_MAX_CANVAS_PIXELS` (2^25 px = 128 MB, `raster.ts:14`) per
  near page and cancels the previous render (`:759-767`); the fingerprint
  `getOperatorList` runs again per success (`:726, :799`).
- Fix: scale the page stack with CSS on wheel (wrappers already size by
  `cssSize * scale`, `:1119`), commit the rasterising `scale` ~120 ms after
  the last tick, and hold back the `scale` persist effect (`:3970-3977`)
  until commit.

### 4.2 Don't rebuild every page on each switch to the tab (quick win)

- `:639-644` IntersectionObserver with `rootMargin: "150% 0px"` → ~4 pages
  "near"; hiding the pane fires not-intersecting, zeroes their canvases and
  calls `page.cleanup()` (`:672-688`), so each switch back re-decodes and
  re-renders ~300 MB at fit-width on a 2× screen.
- Fix: mirror the terminal's release timer (`RENDERER_RELEASE_MS` 60 s,
  `TerminalView.tsx:200`): keep painted near pages for ~30 s after hide
  (gate the release effect on `paneVisible` + timer); reduce `rootMargin` to
  75–100 % (3 pages).

### 4.3 Hidden PDF tabs release the document (standalone; 1 day)

- `:3680-3760, :3716, :3837`: the `PDFDocumentProxy` plus raw bytes stay in
  the worker for every open PDF tab, hidden or not (≈1.5–4× file size each;
  reload holds old + new until swap, `:3714-3716`).
- Fix: after N min hidden (default 5), `destroy()` the document and the
  worker slot; on show reload. **Restore position from the persisted
  `viewPos`** (`:4138`, seeded at `:3684-3690`), not from the live element:
  the same-path reload branch reads `el.scrollTop` (`:3697-3706`) which is 0
  under `display:none`. Simplest is to implement this as an unmount/remount
  of the viewer (the mechanism §5.3 generalises) so `didInitialLoad` is fresh
  and `viewPos.initial` is used. Never while the markup `storage` state is
  unsaved (`usePdfMarkup.ts:258/342/394`) or a linked TeX compile is running.
- Lands before sleeping tabs: it is the single largest memory lever for
  "heavy PDFs" and has its own restore path.

### 4.4 Reload during a TeX compile (½ day)

- `:3733-3760` retries a truncated read up to 13× at 250 ms, each a full IPC
  read; a 130 MB thesis can push >1 GB through IPC per build.
- Fix: stat twice (size stable for 300 ms) before reading; have
  `TexWorkspaceView`'s `onCompiled` (`FileViewerPane.tsx:~8923-8926`) tell the
  linked PDF tab to reload once instead of polling through its own compile.
  `FileViewerPane.tsx` has uncommitted TexView hunks (9602–10098) from
  another session right now — coordinate before touching.
- `:3844-3880` per-page `getPage()`+`getViewport()` on every reload: skip when
  `numPages` and first/last page sizes are unchanged.

### 4.5 Popped-out PDFs (½ day)

- Detached tabs stay mounted in the main window (`detached.ts:116`,
  `CenterPanel.tsx:1176-1212`), by design for PTYs. For non-PTY kinds a PDF
  costs two `readFileBytes` and two worker documents → render a stub in the
  main window.

## 5. Phase C — many open tabs

### 5.1 Memoise the per-tab work (1 day)

- `src/components/layout/CenterPanel.tsx:1185-1385`: the per-pane derivation
  (`projects.find`, `boxes.find`, `effectiveTabLocation`×2, `localTabCwd`×2,
  `shouldPersistTab`…) re-runs for all N tabs on any of the component's ~20
  `useTabsStore` subscriptions firing, including every `groupRects` change.
  Hoist into a memoised `PaneSlot` keyed on `(tab, paneProject, remote
  status)` so a rect change re-renders positions only.
- `src/components/tabs/TabBar.tsx:1354-1560`: extract a `memo`'d `TabItem`
  taking `(tab, busy, kind, attention, active)`; memoise
  `nextScheduleOccurrence` (`:1495`, computed per tab per render); subscribe
  to the activity maps per tab key, not whole maps.
- `src/components/files/FileTree.tsx:943-952`: memoise the row (stable
  handlers via one per-tree dispatcher keyed by path).

### 5.2 Launch: lazy xterm construction only (½ day)

- `src/stores/projects.ts:1039-1046, 1230` restores every active project's
  scope at startup; `CenterPanel.tsx:1070-1083` mounts all of them;
  `TerminalView.tsx:387` builds `new Terminal({scrollback: 5000})` at mount
  and `:1387-1399` spawns regardless of `visible`; each `pty_spawn` runs
  `launch_prep::prepare` (`launch_prep.rs:281-290`, async fn doing sync fs:
  `create_dir_all`, `agent_home.rs:125-205` read_dirs + copy pass).
- Do: defer `new Terminal` until first show (`pendingOutput` is already a
  string, `term.open()` is already deferred); `initialInput`/scheduled-ready
  arming (`:1364-1368`) must still run on first show. Wrap `launch_prep`'s
  fs work in `spawn_blocking`.
- **Do not** defer the PTY spawn itself. The phone's catalog lists tabs from
  the session file (`discovery.rs:1150-1168`), and the host restarts a listed
  tab via tmux on its resume args when the phone opens it (`host.rs:1421`,
  `:6685`); a desktop spawn deferred to first show would then `pty_spawn` an
  id the phone already started — the duplicate-id kill-and-respawn case
  `TerminalView.tsx:1316-1320` warns about. Revisit only with a host test
  where the phone starts first and the desktop attaches.

### 5.3 Sleeping tabs (structural; 3 days)

Prerequisites: §3.1 (Map-first seeding), §4.3 (viewer remount path), and the
PTY-ownership rules below.

- `CenterPanel.tsx:1176` pane layer: track `hiddenSince` per tab; a 30 s
  timer flips tabs hidden longer than N min (default 10; setting under
  Performance) to `asleep` and renders `<SleepingPane>` instead of
  `<TabPane>`; `visible`, focus or keyboard steering wakes it. The `TabEntry`
  record is untouched — it already holds everything a remount needs
  (`viewerState`, `folder`, `url`, `sessionId`; `FileViewerPane.tsx:8695-8698`
  and `PdfViewer.tsx:3680-3710` restore from it).
- Viewer/embed kinds sleep whole (PDF reloads bytes on wake, = §4.3).
- **Terminal kinds — PTY ownership.** `TerminalView`'s teardown kills the PTY
  on unmount (`TerminalView.tsx:1741`: `if (!attachOnly &&
  !isDetachedPtyId(id) && !persistOnUnmount) invoke("pty_kill")`), and
  `attachOnly`/`persistOnUnmount` are in the spawn effect's deps (`:1787`),
  so flipping them on a mounted pane re-runs the effect (kill + respawn).
  Therefore: every sleepable `TerminalView` mounts with the no-kill flag from
  the start; closing an *asleep* terminal tab calls `pty_kill` explicitly
  (no view exists to do it, or PTYs leak past close); wake mounts through the
  existing attach path (`attachOnly`, `:250`, `:1316-1372`: register view,
  `pty_scrollback` tail, live stream) — the "spawn-or-attach flag" already
  exists. On sleep call `pty_remove_view` so the backend buffers; raise
  `ROUTE_SCROLLBACK_CAP` (256 KB, `mod.rs:111`) to ~1 MB for sleeping PTYs.
  A process that exits while asleep has no `terminal-exit` listener in a
  pane: AppShell's window-wide listener marks the tab exited.
- The overlay agent dock draws a root agent tab as an attach-only `TabPane`
  while its main pane is hidden (`OverlayAgentColumn`): `pty_remove_view` on
  sleep must count that view, or the docked column goes blank.
- Keyboard steering finds regions by DOM query
  (`steeringRegion.ts:54-75`; `tabCard` has `scopes: ["panes"]`,
  `steeringBindings.ts:122`): `<SleepingPane>` renders the same region
  markers (`data-steer-region`, pane class) and wakes on focus.
- Never sleep: dirty editors (until `draftSaver` flushed), unsaved markup
  layers, a running TeX compile, Host sessions, the tab a popout mirrors, a
  tab shown in the overlay dock.
- Scopes not shown for N min sleep their viewers wholesale (inactive projects
  are already unmounted, `CenterPanel.tsx:1072-1083`).
- Tests: CenterPanel with 30 tabs where 25 sleep → 25 `TabPane` unmounts,
  store unchanged, wake remounts with the persisted viewer state, steering
  still reaches sleeping cards, dock view counted; TerminalView: attach-not-
  spawn on wake, no `pty_kill` on sleep, `pty_kill` on close while asleep.

## 6. Phase D — bundle and binary (1–2 days)

Build facts (`npm run build`, 2026-10-06): 79 JS chunks, no `manualChunks`;
`bootstrap-*.js` 3,963 kB raw / 1,143 kB gz plus 632 kB CSS parsed by every
window including each popout; pdf.js, mermaid, katex, pdf-lib, cytoscape,
the mail overlay are already lazy; only 11 `lazy()` sites exist
(`App.tsx`, `AppShell.tsx:124-142`, `FileViewerPane.tsx:292-296`). Largest
sources in bootstrap: `lib/i18n.ts` 720 kB (English), `FileViewerPane.tsx`
465 kB, `stores/tabs.ts` 292 kB, `FileTree.tsx` 233 kB,
`SettingsSubPanels.tsx` 164 kB, `MobileBridgeHost.tsx` 133 kB,
`ProjectPill.tsx` 119 kB, `MachinesIndicator.tsx` 119 kB.

- `src/components/tabs/TabPane.tsx:1-14`: `React.lazy` the pane kinds
  (calendar, browser, TeX, monitoring, print, skills, prompt chart); keep
  terminal and the plain file viewer eager. The Suspense fallback must carry
  the pane class and steering region markers (steering queries the DOM).
- `src/components/layout/AppShell.tsx:1-118`: lazy `SettingsPanel`/
  `SettingsSubPanels`, `MachinesIndicator`/`RemoteMachinesWindow`,
  `HpcPipelineWizard`, `TourHost`, intro pages, `StatsRecapHost`.
- Split `FileViewerPane.tsx` so text/markdown/code is the eager path; the
  TeX module `src/lib/viewers/tex/tex.ts` (167 kB) has 29 static importers —
  make it a dynamic import from the TeX path.
- Fix the 5 Rollup "dynamically imported but also statically imported"
  warnings (`plugin-dialog`, `stores/settings.ts`, `remoteStatus.ts`,
  `hpcHost.ts`, `boxes.ts`) — those splits do nothing today.
- `src/lib/untested.ts` stays in the bundle: the frozen dev build is a PROD
  bundle and the only build the user tests on; stripping the register would
  blank every pill there. (~30 kB gz, not worth an alias stub.)
- `src-tauri/Cargo.toml` has no `[profile.*]`; add `[profile.release]
  lto = "thin"` only. **No `panic = "abort"`**: `catch_unwind` guards the
  markup bake (`services/mobile_control/markup.rs:545`) and the park guards
  (`platform/x11.rs:943`, `macos_park.rs:236`, `windows_park.rs:212`), and
  `lib.rs:63` installs a crash-log panic hook. Leave `codegen-units`. Cost:
  longer builds on every push (three `package*` jobs run on push,
  `ci-cd.yml:330,397,456`, macOS universal = two targets) and every
  post-commit frozen build; measure the gain against §1 before keeping it.
- Target: bootstrap under ~1.5 MB raw; verify from the chunk table.

## 7. Phase E — backend

`cargo clippy -W clippy::await_holding_lock` is clean: no lock held across an
await; contention is not a finding. Startup `setup` is marker-gated one-shots
and off-thread sweeps; nothing to fix there.

### 7.1 Persistence off the GTK thread, no needless fsyncs (½ day; ship first)

- `commands/projects.rs:2731` `save_tab_layout`, `:2675` `workspace_sync`,
  `:2662` `workspace_snapshot`, `:2649` `load_tab_session` (a read), `:604`
  `get_projects`, `:690` `save_projects`, and `commands/settings.rs:7,48,79,124`
  are sync `#[tauri::command] pub fn` (59 sync vs 2 async in `projects.rs`)
  → Tauri runs them on the main GTK/IPC thread.
- Each write is `storage::write_json_atomic_unlocked`
  (`src-tauri/src/storage.rs:106-130`, crate root): temp → `sync_all` →
  rename → dir `sync_all`, under the process-wide `JSON_MUTATION_LOCK`
  (`:102`); `patch_json` (`:76-99`) always rewrites and fsyncs even when the
  patch changed nothing, so `get_projects` → `patch_projects_list` (a
  *read*) and every project switch is two fsyncs on the main thread, queued
  behind any background atomic write (`usage_stats.rs:398`, net_usage,
  agent_tasks). The 300 ms layout autosave (`CenterPanel.tsx:329-344`)
  fires on every `tabs`/`layout` identity change — which §3.1 says is every
  viewer scroll pause today. (`write_export_copy`,
  `terminal_service.rs:221-229`, already skips equal content; leave it.)
- Fix: `#[tauri::command(async)]` / `spawn_blocking` for all of them (the JS
  side already awaits a promise, `tabs.ts:5302-5306`); in `patch_json`
  compare serialized output with what was read and skip equal writes; keep
  `durability::record` ordering. Unit test in `storage.rs` (41 test attrs
  exist): a no-op patch leaves mtime unchanged.

### 7.2 One process-table snapshot instead of five `/proc` walkers (structural, with quick wins)

Each is `read_dir("/proc")` plus a file read per pid:
- `services/agent_turn.rs:444-477` `tool_shell_uids` every 2 s while any
  bound agent tab is unsettled (`JOB_POLL` `:231`; a 30 s settled cadence
  exists, `JOB_POLL_SETTLED` `:242`), plus on every hook record older than
  500 ms (`:321-327`).
- `commands/debug.rs:35` `debug_app_resource_usage` (async) every 2.5 s from
  the header: `src-tauri/src/sysstat.rs:1499` `parent_map()` full walk
  because `CACHE_TTL` 1.5 s (`sysstat.rs:206`) < the 2.5 s poll, so the cache
  never hits; then `src-tauri/src/gpustat.rs:923` `amd_fdinfo_procs` opens
  every pid's `fdinfo/` — the most expensive walk in the tree, for a header
  number.
- `services/agent_fence.rs:1924` `live_unfenced_by_scope` every 15 s
  (`agent_fence_marks`): full walk + `read_link(ns/mnt)` per pid.
- `services/ui_priority.rs:39,123` every 15 s: descendants walk + `cmdline`.
- `services/agent_transcript.rs:1444-1451` `running_outputs`: every pid's
  `fd/` dir per Reader poll (2 s) whenever a transcript has background
  shells, even on the "unchanged" fast path (`:889-898`).
- Quick wins (with §3.3's first step): `CACHE_TTL` ≥ 3 s; GPU section cached
  ≥10 s and off the 2.5 s path; `running_outputs` restricted to the shell
  pids agent_turn already identified per tab.
- Structural: a `services::proc_table` snapshot (pid → ppid, comm, lazily
  environ-uid) refreshed at most once per second and shared by all four
  walkers. Keep it `AppHandle`-free.

### 7.3 `agent_auth` keeper (quick win, ½ day)

- `services/agent_auth.rs:57` `POLL` 5 s, `:724-732` two passes over every
  agent home, `:299-337` `reconcile_file` reads + SHA-256s the home copy and
  the store copy per home × CLI × path, forever, whether a tab is open or not.
- Fix: gate on (mtime, size) before hashing (`copilot_auth.rs:59`'s 3 s stat
  sweep is the model); poll 5 s → 60 s with a `notify` watcher on the store
  dir; skip homes with no live tab.

### 7.4 Git dots — merged into §3.4.

### 7.5 Reader polls → transcript watcher (½ day)

- `TerminalReaderView.tsx:47,817,848` `agent_tab_transcript` and
  `TerminalReaderChanges.tsx:37` `agent_tab_changes` every 2 s per visible
  Reader; the version fingerprint avoids a re-parse but each is an IPC round
  trip + stat + the fd walk in §7.2.
- Fix: `notify` on the transcript file emitting `transcript-changed`; keep a
  15 s backstop timer. Do **not** copy `agent_turn::start(app: AppHandle)`
  (`agent_turn.rs:491`) — it already breaks the `AppHandle`-free services
  rule; hand change notifications out through a channel/callback the command
  layer forwards.

### 7.6 Hidden-pane digests (low; after the rest)

- `terminal/mod.rs:346-390`: one `terminal-activity` per hidden streaming PTY
  per 500 ms (`ACTIVITY_INTERVAL` `:88`), emitted once globally
  (`:1199,1218,1236`); only `AppShell.tsx:888` listens. 30 working agents →
  60 events/s into the main renderer.
- Fix: coalesce due digests into one `terminal-activity-batch` per tick (30
  → 2 events/s). This changes the payload shape, so `AppShell.tsx:886-891`
  changes with it; `activity.ts` is unaffected. The 500 ms floor stays
  (must remain under `BUSY_WINDOW_MS` 800 ms in `activity.ts`).

### 7.7 Remote standing load (½ day)

- `stores/remote/hostSessions.ts:76,158` → `remote_tmux_list` (ssh over
  ControlMaster) every 7 s per connected (project, host) while the sessions
  panel is mounted → 20 s or watcher-driven.
- `services/net_usage.rs:45,125`: every 15 s a system-wide `ss -p` (walks
  every `/proc/<pid>/fd` in a child) + `ssh -O check` per connection → `ss
  -tni` filtered by the master's local port, 60 s when the Network pane is
  closed.
- `git_peer` 12 s and `sync_auto` 25 s per connected project stay as
  designed.

## 8. Verify the earlier perf work (no code; user + QA rows)

The 2026-10-01 cluster has no `untested` rows and no QA boxes: rtkit nice −10
(`services/ui_priority.rs`, `lib.rs:1036` — silently a no-op without
`rtkit-daemon`/polkit consent), settled `/proc` walk (61652af5), sync `/proc`
commands off the GTK thread (bc53afbc), renderer release (614ce75b), PTY
batcher (`batch_output`), visible-only streaming, blur quiescence. §1 items
1–2 verify the first three. Add a `todo/group-u-performance.md` 🖐️ box per
item with the platform child pairs, and register `UntestedTag` rows where a
UI exists. The deleted `docs/typing_latency_plan.md` (recover with
`git show 15a1774d^:docs/typing_latency_plan.md`) leaves one open half:
CPU-pressure auto-engage of quiescence. Its "GPU-compositing setting" is
dropped: the 2026-08 DMABUF retest produced silent artifacts and a crash with
no salvageable config (memory `project_dmabuf_retest_2026_08`).

## 9. Order and gates

| Step | Phase | Effort | Confidence it is felt | Live check |
|---|---|---|---|---|
| 1 | §1 four numbers | 30 min | — | recorded at the top of this file |
| 2 | §7.1 persistence off the GTK thread | ½ day | high | rename/reorder tabs while an agent streams: no stall |
| 3 | §4.1 + §4.2 PDF zoom, keep painted | 1 day | high | Ctrl+wheel on a 100-page PDF stays smooth; switch back is instant |
| 4 | §3.1 scroll churn | ½ day | high | scroll a PDF beside a streaming agent tab: no stutter |
| 5 | §4.3 hidden PDF release | 1 day | high for memory | §1.3 RSS drops with 10 PDFs open |
| 6 | §3.2 chunk/tick work | ½ day | high | busy agent tab + Reader open: typing stays smooth |
| 7 | §3.2b replay trim (with DECSET test) | ½ day | medium | switch to a busy agent tab: no freeze; alt-screen/mouse still right |
| 8 | §5.1 memo pane/tab | 1 day | medium | 60 tabs: tab-bar status flips cheap |
| 9 | §3.3 first three sites + §7.2 quick wins | ½ day | medium | renderer and backend CPU at idle drop |
| 10 | §3.4 git dots + fs-change | ½ day | medium | agent writing files: no tree flicker, no git spawn storm |
| 11 | §7.3 auth keeper, §3.5 launch chain | ½ day | medium | backend CPU at idle, `pidstat` |
| 12 | §5.2 lazy xterm construction | ½ day | medium | launch time |
| 13 | §6 bundle + thin LTO | 1–2 days | medium | launch and popout time; CI minutes |
| 14 | §5.3 sleeping tabs | 3 days | high for memory | 60 tabs for an hour: RSS flat; agents survive sleep |
| 15 | §7.2 shared proc table, §7.5–7.7 | 1–2 days | medium | backend CPU with 30 working agents |
| 16 | §3.3 `usePoll` sweep, §8 QA rows | 2 days | low | — |

Ship-this-week pick: step 2 (one file pair, backend only, unit-testable,
hits every project switch and every layout persist); if a second lands,
step 3.

Concurrency: `stores/tabs.ts` (:2468), `FileViewerPane.tsx` (9602–10098) and
`src-tauri/src/lib.rs` (:1884) have uncommitted hunks from other sessions at
the time of writing; steps 4, 5 and the §4.4 half of step 3 touch the first
two — check `git status` before starting them.

Gates for every step: `npm run build`, `npm test`, `cargo test`, `npm run
lint`, `cargo clippy -D warnings`, `scripts/brand-check.sh`; backend edits →
`npm run backend:stale`. Each step is its own commit so the frozen dev build
can be compared step by step with the §1 numbers.

## 10. Not in the audits, worth adding

- **Per-tab cost readout.** `AppResourceUsage` is process-wide; the renderer
  is one process so `/proc` cannot attribute per tab. Cheap JS proxy: per
  tab, xterm `buffer.length` rows and, for PDFs, `numPages` + byte length,
  shown in the tab tooltip or the Power & performance settings page. Without
  it the user cannot tell which tab to close, and later steps cannot be
  attributed.
- **`scrollback` is hard-coded** at 5,000 rows (`TerminalView.tsx:388`); make
  it a setting (default 2,000 for non-agent tabs).
- **Soft warning at N open PDF documents** (none exists) — a day's work that
  gives the user agency before §4.3 lands.
- **Experimental flags default to `settings.debug`** (`experimental.ts:71`):
  list which entry points that mounts, and make the fallback explicit.
- Mobile host and the overlay agent dock add no frontend timers (grep 0); the
  sidecar's standing cost is unassessed — §1.2 covers it.

Remaining direct `setInterval` sites after step 16 are listed here once the
helper lands (today: 90 sites in 68 files).
