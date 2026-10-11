# Performance plan — handoff

*One section per agent step of [`performance_plan.md`](performance_plan.md)
§11. Each step's implementer appends its own section; its reviewer appends a
"Review" subsection. Nothing here was run live unless a section says so.
Worktree: `.claude/worktrees/perf`, branch `perf`, created from `develop` at
`a6ed2c7a`.*

Section template:

```
## S<n> — <title>

*Written <date> by the S<n> implementer. Base `<sha>`. Nothing run live.*

### Commits
| Commit | Content |

### What was built / choices made
### Gotchas for later steps
### Gates (worktree)
| Gate | Result (with test counts) |
### Flagged for user
### Live click-through (user)

### Review (S<n> reviewer, <date>)
- range reviewed, bugs fixed (sha + regression test), gates after, flagged
```

## S1 — backend quick wins

*Written 2026-10-06 by the S1 implementer. Base `be7260da`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `2857a41a` | §7.1 state-file commands off the GTK thread (ordered lane) + `patch_json` no-op skip |
| `ecb98708` | §7.3 `agent_auth` keeper stat gate |
| `8440c3a8` | §7.2 quick wins: relaxed descendant cache for the header poll, GPU section cached 10 s |

### What was built / choices made
- **§7.1, ordering kept:** not `#[tauri::command(async)]`. Tauri's pool loses
  arrival order, and the window does not serialise all of these calls itself
  (`updateSettings` fires `patch_settings` without awaiting the previous one;
  `save_projects` callers overlap) — two back-to-back saves could land in either
  order. Instead `commands::persist_lane::ordered` wraps the generated invoke
  handler in `lib.rs`: the ten state-file commands (`get/save/patch_settings`,
  `save_window_state`, `get/save_projects`, `load_tab_session`,
  `workspace_snapshot`, `workspace_sync`, `save_tab_layout`) are queued, in
  arrival order, on one worker thread (`services::ordered_lane`, FIFO, lazy,
  panic-tolerant); their bodies are unchanged sync fns. Reads are on the lane
  too, so read-after-write still holds. `RunEvent::Exit` drains the lane
  (5 s bound) before teardown. Ordering against *other* sync commands is no
  longer guaranteed — the same as any off-thread approach.
- `patch_json` compares the serialised bytes with what it read and skips the
  temp-file + two fsyncs when equal (no `durability::record` entries either).
  A missing file is still created; a file in another layout (compact, no
  trailing newline) is still rewritten once. `save_window_state` always bumps
  `rev`, so it never no-ops (the frontend already skips equal geometry).
- **§7.3:** `reconcile_file` sits behind a stat gate: a pair (home copy, store
  file, placed sidecar) last seen *settled* (home bytes == store bytes, nothing
  written) is skipped while all three `stat` identically (len, mtime, and on
  unix dev/ino/ctime). A stamp whose mtime is younger than 3 s is never
  trusted (coarse-timestamp same-length rewrite). A pending or refused
  adoption is never cached (it also depends on the home's account file).
  **Poll stays 5 s**: a `notify` watcher on the store dir would only see the
  place direction; logins land in homes, and a 60 s poll would delay their
  adoption into running sibling tabs by up to a minute. The stat pass is a
  few `stat`s per home × CLI × path. "Skip homes with no live tab" not done:
  `services/` has no tab registry (plan item left for S11, which gets one).
  `link_claude_identity`/`strip_claude_identity` still read `.claude.json`
  per home per pass (small, not in the plan's list).
- **§7.2:** `CACHE_TTL` (1.5 s) stays the default — the Windows/macOS
  `find_window_for_pid` retry loops poll `descendant_pids` for a launcher's
  just-forked child and cannot be compile-checked here, and the CPU pills want a
  fresh tree. New `descendant_pids_relaxed` (4 s) is used by
  `debug_app_resource_usage` (the 2.5 s header poll), so that poll now hits
  the cache. The GPU half of that command (`total_vram_in_use` loopback +
  `gpustat::snapshot`) is cached 10 s (`reuse_within`).
  `running_outputs` left as is: it already returns before any walk when no
  background shell is open; restricting to agent_turn's shell pids needs the
  per-tab pid plumbing S11's `proc_table` brings.

### Gotchas for later steps
- S11: any new state-file command must be added to `persist_lane::ORDERED`
  if a caller relies on save-then-read ordering.
- `cargo test` filters: `storage::tests`, `services::ordered_lane`,
  `commands::persist_lane`, `agent_auth::tests::{an_unchanged_login,a_changed_size}`.

### Flagged for user
- Plan §7.2 says `debug_app_resource_usage` reaches `gpustat::amd_fdinfo_procs`.
  It does not: that walk is only in `process_snapshot()` (the monitor pane's
  per-process list, already cached 1 s). The header path calls `snapshot()`.
- Plan §7.1 proposes `command(async)`; the lane was chosen for the ordering
  reason above. If a reviewer prefers the plan's form, `updateSettings` and
  `save_projects` callers need frontend serialisation first.
- Behaviour change to feel: `settings.json`/`projects.json`/session files no
  longer fsync when the content is unchanged; file watchers on them fire less.

### Live click-through (user)
1. Rename and reorder tabs while an agent streams: no stall (§7.1).
2. `inotifywait -m <state_dir>/projects.json` while switching projects: no
   MODIFY/MOVED_TO events for an unchanged list (no-op skip).
3. Sign in to a CLI in one tab; a sibling tab of another scope sees the login
   within ~5 s as before (§7.3 gate must not delay it).
4. `pidstat -p $(pgrep -f tabtivity | head -1) 5` at idle: backend CPU lower
   than before (§7.3 + §7.2).
5. Quit with unsaved layout changes made in the last second: layout restored
   on next launch (lane drain at exit).

### Review (S1 reviewer, 2026-10-07)
Range `be7260da..c9a339f1` (`2857a41a`, `ecb98708`, `8440c3a8` + handoff).
**No bugs confirmed; no code commits.** Checked and found sound:
- Lane wrapper: non-lane commands pay one 10-entry string scan, no
  allocation, no blocking; a lane command's body runs unchanged and answers
  through Tauri's thread-safe resolver (the same path async commands use).
  The worker is spawned once (lazily, under the sender mutex); `drain` posts
  a sentinel and waits ≤ 5 s on the main thread at `RunEvent::Exit`.
- Quit: `AppShell.onCloseRequested` awaits `save_window_state`, the layout
  flush and `shutdownDetachedWindows` before `destroy()`, so those saves are
  on disk before Exit; the drain only covers the exits that never run
  frontend code (SIGTERM → `app.exit`). No lane command needs the main
  thread (`workspace_sync`'s emit posts to the event-loop proxy without
  waiting; `invalidate_copilot` → `stop_all_now` is non-blocking).
- No deadlock: lane jobs take `JSON_MUTATION_LOCK` + the file lock, which
  the main thread never holds while waiting on the lane. A panicking job is
  caught; the lane continues, that one promise never settles (Tauri's own
  async commands behave the same on panic). Read-after-write holds:
  `get_projects` after `save_projects` from the same window is FIFO.
- `patch_json`: compares `to_vec_pretty` + `\n`, the exact bytes
  `write_bytes_atomic_unlocked` writes; both locks still release on the skip;
  legacy normalisation (`get_projects`) still rewrites since its bytes differ;
  `patch_settings`/`save_window_state` bump `rev` and never no-op.
  `services::remote`'s `(mtime, len)` projects cache stays consistent (same
  bytes, same stamp).
- `agent_auth` gate: a stamp is recorded only when every mtime is ≥ 3 s old,
  so an equal-length rewrite lands ≥ 3 s after the recorded mtime — distinct
  on any filesystem with ≤ 2 s granularity; `symlink_metadata` means a
  symlink swapped in stats differently; unix adds dev/ino/ctime. A pair is
  cached only when `reconcile_file_now` wrote nothing and found home == store
  — adoption, refusal and placement all take the full path, so logins stay
  shared per CLI. Test `an_unchanged_login_is_not_read_again` counts full
  passes through a thread-local, so it does exercise the gate.
- `descendant_pids_relaxed`: keyed per sorted root set; a 1.5–4 s-old entry
  now survives `retain` but the default lookup still recomputes past 1.5 s
  (`relaxed_lookup_reuses_an_entry_the_default_would_recompute`). Neither
  cache holds its mutex across the `/proc` walk or the GPU read.
- Cross-OS: `cargo check --target x86_64-pc-windows-msvc` (RC/lib shims)
  passes; the range has no macOS-only code.

Gates after (worktree, 2026-10-07): `npm run build` ok · `cargo test -q`
3722 passed, 0 failed · `npm run lint` 0 errors, 28 warnings (pre-existing;
the range touches no TS) · `cargo clippy --all-targets -D warnings` clean ·
`scripts/brand-check.sh` ok · `git diff --check` clean · `npm test` not run
(no frontend change in the range).

**Flagged for user**
- Ordering against non-lane sync commands is gone (as the plan's own
  `command(async)` form would also lose it). Concrete shape: a `void
  setActive()` / `updateSettings()` followed at once by a sync command that
  reads `projects.json` (`fs.rs` `allowed_roots` with no scope, `boxes.rs`,
  `project_runtime.rs`) or `settings.json` (`ide.rs`, `browser.rs`,
  `mail.rs`, `ollama.rs`) can read the pre-save file while the lane is mid-
  fsync. `save_projects` merges status/position by id, so nothing is lost,
  only briefly stale. No caller found that depends on it; not fixed.
- A lane job that panics leaves its JS promise pending (before, the panic
  would have unwound the GTK thread). The quit path awaits lane promises, so
  a panic in `save_window_state`/`save_tab_layout` at quit would stall the
  close handler until the user kills the window. Not seen; left as is.
- The implementer's section has no "Gates (worktree)" table; the counts
  above stand in for it.

## S2 — PDF render + reload

*Written 2026-10-07 by the S2 implementer. Base `c633b0b4`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `45472270` | §4.1 Ctrl+wheel zoom previewed with a CSS transform, rasterised and persisted once per gesture (`PDF_ZOOM_COMMIT_MS` 120 ms) |
| `3261bc4a` | §4.2 hidden pane keeps painted pages for `PDF_PAGE_RELEASE_MS` (30 s); `rootMargin` 150 % → 100 %; a document that changed while hidden is painted on show |
| `6ce389d5` | §4.4 size-settled reload (`file_size` command), poll held during a TeX build (`beginCompile`/`endCompile`), page-size pass skipped on an unchanged reload, no per-page `cleanup()` fetch on a fresh document |

### What was built / choices made
- **§4.1:** `scale` stays the one committed zoom (layout, layers, persist,
  find-bar and link math all read it). A wheel tick writes a `ZoomPreview`
  (`{scale, originX, originY}`) and re-arms a 120 ms timer; the page stack
  gets `transform: scale(preview/scale)` with `transform-origin` at the
  cursor's stack coordinate measured on the gesture's first tick (later ticks
  keep it — the stack is already transformed). The cursor-anchored
  `pendingScroll` is computed against the committed scale and overwritten per
  tick; the existing ResizeObserver applies it when the stack relays out at
  the commit, in the same React commit that removes the transform. `+`/`−`
  commit a pending preview first; `fitWidth` drops one. The toolbar % shows the
  preview. Persist is untouched: its effect depends on `scale`, which only
  moves at the commit.
- **§4.2:** `PdfPageCanvas` reads `usePaneVisible()` through a ref (so a tab
  flip re-runs nothing). The observer callback: intersecting → `near=true`
  (and cancel a hold); not intersecting while the pane is hidden → a 30 s
  timer that sets `near=false`; not intersecting while visible → release at
  once. On show the engine reports again, so a page the pane is no longer near
  is released then. The render effect returns early when the pane is hidden
  (`hiddenStale`); a `catchUp` counter re-runs it on show, where the
  fingerprint decides whether the pixels can stay. No `paneVisible` in the
  render effect's deps on purpose: that would re-fingerprint every near page
  on every tab switch (`getOperatorList` is the parse half of a render).
- **§4.4, stat gate:** a new backend command `file_size` (`commands/fs.rs`,
  registered in `lib.rs`; local + remote via `remote_metadata`, confined like
  `file_mtime`) and `fileSize()` in `embed/fileAccess.ts`. `settledFileSize`
  stats until two stats 300 ms apart agree (≤ 10 rounds), on same-path reloads
  with a document on screen and on every parse retry; a failing or unknown
  command (tests' mocked `invoke` answers `null`) ends the wait at once. A
  first open reads immediately. `file_mtime` is whole seconds, so it could not
  carry this — the plan's "stat twice" needed the size.
- **§4.4, compile hold:** the existing compile → PDF linkage is the
  `pdfSync` store (`requestReload` / `requestReveal(afterReload)` after a
  build); it was extended with `compilingByPath` + `beginCompile`/`endCompile`
  (+ `PDF_COMPILE_EVENT` across windows, registered in `listenPdfReveal`).
  `TexView.compile` marks the PDF it will rewrite (the previous build's
  `pdfPath`; the first build of a session has none and is not held) and
  releases it in `finally`. The viewer's mtime poll effect returns while held
  and, on resuming, skips its immediate check (the build's reload request is
  recording the mtime it read at — an immediate check would read the file a
  second time); the interval's first tick covers a build that ended without
  asking. The hold is bounded at 10 min (`PDF_COMPILE_HOLD_MAX_MS`) so a window
  that dies mid-build cannot leave the poll off.
- **§4.4, metadata pass:** `measuredRef` keeps the last full measurement of the
  identity arrangement; a reload with the same count measures page 1 and N and
  keeps the array when both match. Reset on `path`/`scope` change — never kept
  across a file switch. Found while testing: the render effect's not-near
  branch fetched `doc.getPage(n)` on every fresh document for every page just
  to `cleanup()` it — one worker round trip per page per build. Now only for
  a document the canvas actually drew from (`touchedDoc`).

### Gotchas for later steps
- **S3 (hidden PDF release / viewPos seeding):** `PdfPageCanvas` now holds
  `near=true` for 30 s after its pane hides and defers a hidden repaint to
  `catchUp` on show. An unmount/remount of the viewer (the plan's suggested
  shape) clears all of that naturally. If S3 instead destroys the document in
  place, note `touchedDoc` (compared by `PDFDocumentProxy` identity) and
  `measuredRef` (reset only on path/scope change — a destroyed-and-reloaded
  same-path document will hit the first/last skip, which is correct).
  `zoomPreview` holds a window timer; unmount clears it. `compileHeld` gates
  the poll alongside `paneVisible`; a hidden viewer never polls anyway.
- The viewer's `scale` state is the committed zoom; `zoomPreview?.scale ??
  scale` is what the reader sees. Anything S3 persists at release time should
  use `scale` (a preview is never persisted).
- The pdfSync store's `compilingByPath` count must be balanced: any new
  compile path (phone-triggered builds, a future `compile_tex` caller) must
  call `endCompile` in a `finally`.
- Tests mounting `PdfView` need a 2D context to exercise the render path
  (`vi.spyOn(HTMLCanvasElement.prototype, "getContext")` returning
  `{ drawImage() {} }`); `PdfMarkupViewer.test.tsx` returns `null` on purpose.
  An `IntersectionObserver` stub must be installed before mount — `near`'s
  initial value is decided at mount.

### Gates (worktree)
| Gate | Result (with test counts) |
|---|---|
| `npm run build` | ok (tsc + both bundles) |
| `npm test` | 731 files / 7520 tests passed (S1: 728 / 7507; +3 files, +13 tests) |
| `cargo test -q` | 3722 passed, 0 failed |
| `npm run lint` | 0 errors, 28 warnings (pre-existing, unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check` | clean |

### Flagged for user
- The step touched two files the brief did not list: `src-tauri/src/commands/fs.rs`
  + `src-tauri/src/lib.rs` (the `file_size` command — `file_mtime` is whole
  seconds and cannot gate a 300 ms settle) and `src/stores/viewers/pdfSync.ts`
  (the compile hold; this IS the existing compile → PDF linkage, extended).
  `lib.rs` is modified in the main checkout by another session: the change here
  is one line in the `generate_handler!` list next to `file_mtime`.
- `FileViewerPane.tsx`: besides nothing in `onCompiled` itself, three small
  hunks inside `TexView.compile` (lines ~9770 and ~9880: `beginCompile` at the
  start, `endCompile` in `finally`, `pdfPath` in the deps) — inside the
  9602–10098 region the brief warned about. They are the only place the compile's
  START is known; `onCompiled` fires only at its end, and the end was already
  wired (`requestReload`/`requestReveal`). Expect a trivial merge conflict there.
- Plan §4.1's "fingerprint op-list runs again on each success" is per zoom
  commit, not per tick, after this step; it still runs once per near page per
  commit (`finalFp`). Not changed — it is what makes a recompile's unchanged
  pages keep their pixels.
- The CSS preview is a `transform: scale()` on the whole `.file-viewer-pdf-pages`
  stack. On the WebKitGTK software path this is a layer scale of the painted
  canvases; it was not measured live. If it stutters, the alternative is a
  per-page `transform` (same math, one origin per wrap). A transform does not
  change layout, so during the ≤ 120 ms preview the scroll range is the old one
  (a zoom-out shows a blank band at the bottom until the commit).
- §4.2's hidden-pane repaint gate means a recompile while a PDF tab is hidden
  paints on the next show, not before (one fingerprint per near page then).
- No Rust unit test for `file_size_local`: it is `file_mtime_local` with
  `meta.len()`, and the confinement it calls has no test fixture in `fs.rs`.
- Not done from the plan text: nothing in §4.4 named `onCompiled` needed changing.

### Live click-through (user)
1. Open a dense PDF, Ctrl+wheel five notches quickly: the page scales under the
   cursor at once (slightly soft), sharpens ~120 ms after the last notch, the
   point under the cursor stays put, the % label follows every notch. Text
   selection and link boxes line up after it sharpens. `+`/`−`/Fit width
   behave as before.
2. Switch from the PDF tab to a terminal and back within a few seconds: the
   pages are there instantly, no blank-then-paint. Leave it hidden > 30 s and
   come back: pages repaint (as before).
3. In a TeX workspace, Compile a document whose PDF is open: the PDF reloads
   once at the end of the build; during a multi-pass latexmk run the page does
   not flicker through intermediate builds. A build that fails leaves the old
   PDF; a later change outside Tabtivity (e.g. `latexmk` in a shell) still
   reloads within ~2 s.
4. `strace -e trace=read -p <app pid>` is overkill; cheaper: watch the
   renderer's RSS during a build of a large PDF — it should not climb by a file
   size per retry.

### Review (S2 reviewer, 2026-10-07)
Range reviewed: `c633b0b4..727fae72` (45472270, 3261bc4a, 6ce389d5, 727fae72).
Nothing run live.

**Bugs fixed**
- `c5bf7c62` — §4.1 the zoom commit's scroll target was the pre-S2 formula
  (stack scales uniformly from the scroll origin). The scroller's 12 px padding
  and the constant 28 px page-number gap under every page do not scale, so the
  target drifted by `pagesAbove × 28 × (eff − 1)` (≈ 280 px for one notch at
  page 50) — the preview (which scales gaps) made that a visible jump at the
  commit. Also: a gesture wheeled back to its start left a `pendingScroll`
  armed for the next unrelated relayout to apply (and `1.2 × 1.2 / 1.2` is not
  always `1.2` in floating point, so it could also re-render every near page at
  a scale a rounding error away). Now the first tick records the page wrap under
  the cursor and the point as a fraction of its box (`pageAnchorAt`); the commit
  pins that point to where the preview shows it (a plain scroll meanwhile is
  accounted for), resolved by the ResizeObserver against the wrap's live box
  (`anchoredScrollTarget`); a net-zero gesture commits nothing. The +/− button
  after a tick now lands exactly too (the fraction is scale-free). Tests:
  `PdfZoomRaster` "lands where the preview showed …" and "commits nothing …".
- `d3af5bbb` — §4.4 the kept measurement (same count, same first/last page)
  left a middle page the build resized with its old reservation: the canvas drew
  the true size (the render effect sets its CSS box), but the remark, markup,
  copy-region and link layers are laid out by `cssSize` and sat on the stale
  box. `PdfPageCanvas` now compares the page it already fetched to render
  against `cssSize` (`onSize`, via refs — the effect's deps are unchanged) and
  the viewer patches that one entry and the kept measurement; a corrected page
  above the viewport pins the page under the viewport's top edge through the
  same anchored target. Zero extra worker round trips. Test: `PdfReloadSettle`
  "corrects a middle page the build resized under a kept measurement".

**Checked and found sound**
- §4.1 text/annotation/markup/search layers: all sized by `scale` (committed) under one stack transform — aligned during preview and after; `fitWidth` drops, +/− commit, no other `setScale` path (no keyboard zoom exists); persist effect reads `scale` only; unmount clears the timer; transform only, no shadow animation; reduced-motion moot (no transition).
- §4.1 wheel mid-render: the commit is one `setScale`, the render effect's existing cancel/`task.cancel()` path handles it; no per-tick canvases.
- §4.2 hold timer cleared in the observer effect's cleanup (unmount); `catchUp` only increments when `hiddenStale` was set in the dark and the pane is shown — cannot loop; hidden-at-mount pages never paint in the dark; the visible-page tracker scans live rects and thumbnails use their own observer, so the `rootMargin` change touches only page canvases/text/link layers (all `near`-gated together).
- §4.4 `file_size`: confinement and mirror/remote routing byte-for-byte `file_mtime`'s; `remote_metadata`/`sftp::metadata_on` return `(size, modified)` so the right field is read; registered in `generate_handler!`. `beginCompile`/`endCompile` balanced (begin → sync `setState`s → `try … finally endCompile`); popouts and the main window both `listenPdfReveal`; 10 min bound resumes the poll if a window dies. First build of a session not held = lost optimisation only (the poll + settle gate still reload). Resume skips the immediate check; the test proves no second read. Removed not-near `getPage(n).cleanup()` on a document the canvas never drew from: it fetched the page to free it — net zero; text scans/link reads keep their own pages.
- Mobile `MarkupView` imports none of this.
- Tests: all three assert the claimed behaviour (render counts, persist writes, transform, timer windows, stat/read order, page-ask counts).

**Gates (worktree, after fixes)**
| Gate | Result |
|---|---|
| `npm run build` | ok |
| `npm test` | 731 files / 7523 tests passed (+3 regression tests) |
| `cargo test -q` | 3722 passed, 0 failed |
| `npm run lint` | 0 errors, 28 warnings (pre-existing, unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check` | clean |

**Flagged for user**
- No Rust unit test for `file_size_local` (confirmed: `confine_abs_read` reads
  `projects.json` from the state dir; `fs.rs` has fixtures only for the pure
  `compute_allowed_roots`/`confine_abs_within` — the same gap `file_mtime_local`
  has always had).
- The preview scales the inter-page gaps, the commit does not: the anchor point
  is exact, pages far above/below it shift by 28 px × (eff − 1) per gap at the
  commit. Exact everywhere would need per-page transforms (the implementer's
  flagged alternative) — a design choice, not changed.
- A corrected middle page (d3af5bbb) that lies above the viewport is pinned by
  anchor, but one that intersects the viewport resizes in place (unavoidable: it
  is what the reader is looking at). Only reachable through the §4.4 skip path.
- `FileViewerPane.tsx` / `lib.rs`: untouched by the review (merge note stands).

## S3 — viewer state + hidden PDF release

*Written 2026-10-07 by the S3 implementer. Base `348e5ddd`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `ea5873f9` | §3.1 viewer positions staged in a module-level Map (`pendingViewerState`), folded into the store on pane hide / viewer unmount / popout seed / 5 s; every save path reads the stage; `pruneCollapseCollect` and the per-scope maps keep identity when nothing changed. Also: the S2 hidden-pages test's two timing races fixed |
| `550af44e` | §4.3 `PdfView` sleeps a pane hidden for `PDF_DOC_RELEASE_MS` (5 min): canvas unmounted (documents destroyed, worker slot ended), remounted on show at the persisted zoom/scroll; held by unsaved marks/page edits, a Submit in flight, a running build, a popout mirror. New `lib/sleepWhenHidden.ts` (`useSleepWhenHidden`) is the seam |

### What was built / choices made
- **§3.1, the stage:** `setViewerState` splits each patch. The position-like
  fields (`scrollTop`, `scrollLeft`, `scale`, `pdfFitted`, `offsetX`, `offsetY`,
  `yamlScrollTop`) go to `stagedViewerState` (a `Map<tabKey, ViewerState>` in
  `stores/tabs.ts`, next to the detached registry) and arm ONE one-shot 5 s
  timer (`VIEWER_STATE_FLUSH_MS`; no timer while nothing is staged). Every other
  field (`fontSize`, folds, breakpoints, `texActivePath`, …) writes through as
  before — the shell reads those reactively and they change on a click, not on
  a scroll. Callers are unchanged: all the plan's `FileViewerPane`/`PdfViewer`
  persist sites keep their 200 ms timers and still call `viewPos.persist`; the
  routing is inside the store, so no viewer needed a hunk (the brief's "write
  the Map" is what `setViewerState` now does for them).
- **Flush points:** `useViewerState` (in `FileViewerPane.tsx`) reads
  `usePaneVisible()` and calls `flushViewerState(tabKey)` on the visible→hidden
  edge and on unmount; `reseedDetached`/`answerSeed` (`stores/detached.ts`)
  flush everything before building a popout seed; the 5 s timer flushes
  everything. The quit path needs no flush: `toSavedTabEntry` merges the stage
  over the store's `viewerState`, so `persistScope` (AppShell's `saveLayout`)
  and the project-switch snapshot (`projects.ts`) both persist the latest
  position without a store write. A flushed key whose tab is gone (closed) is
  dropped. Persisted JSON shape: unchanged (the stage is only ever merged into
  the same `viewerState` object).
- **Dedup:** `queueViewerState` compares against store + stage, so a viewer
  re-persisting its restored scale on mount arms nothing; the flush compares
  again, so a no-op fold does not change `tabsByScope`.
- **Popouts:** in the popout `setViewerState` still writes the detached
  registry + `pushEdit` (unchanged). On the main side, `applyDetachedEdit`'s
  `setViewerState` case now stages position fields the same way, so a popout
  scroll no longer rewrites the main store per 200 ms pause either.
- **Identity:** `pruneCollapseCollect` returns the original group node when no
  key was pruned and the active key stands, and the original split when every
  child came back identical (its sizes were normalized when last set).
  `writeScope` keeps `layoutByScope`/`focusedGroupByScope` identity when the
  scope's entry did. With the stage, a scroll touches none of this anyway; it
  matters for the write-through fields (a `fontSize` change no longer rebuilds
  the tree).
- **§4.3, the seam:** `useSleepWhenHidden({hidden, afterMs, hold})` → boolean.
  Asleep after `afterMs` hidden with no hold; awake in the render that shows
  the pane (`asleep && hidden`); a hold cancels the countdown and restarts it
  when lifted; a hold raised while asleep changes nothing. `PdfView` (the
  outer component, `PdfViewer.tsx`) renders `<div data-sleeping="pdf">` in
  place of `PdfCanvas` while asleep. The canvas's existing unmount effect does
  the release: `loadingTask.destroy()` on every source, `PdfWorkerSlot.dispose`
  (ends the worker after the teardown settles — never bypassing `pdfLoad.ts`).
  The remount is a fresh `didInitialLoad`, so the load effect's first-load
  branch restores `viewPos.initial` (store + stage) — never the hidden
  element's `scrollTop` (0 under `display:none`).
- **Holds:** `PdfCanvas` reports `onHoldChange(held)` with `held = (storage ===
  "unsaved" && (hasUnsent || round !== null)) || sending || dirty`. `dirty`
  (unsaved page-arrangement edits) was not in the plan's list but an unmount
  would drop them — added. `PdfView` adds `compilingByPath[path] > 0`
  (`pdfSync`) and `isTabInPopout(s, tabKey)` (new selector in `tabs.ts`: the key
  is in some `detachedGroupsByScope` subtree).
- **Composition with S2:** hidden < 30 s → pages painted; 30 s–5 min → canvases
  released (S2's `PDF_PAGE_RELEASE_MS`), document alive, `catchUp` pending;
  > 5 min → unmount clears the hold timers, `catchUp`, `zoomPreview` and the
  200 ms persist timer with it. A `reloadByPath` nonce that arrives while asleep
  is moot: the wake mount reads the file anyway (`!doc && !error` guard).

### Gotchas for later steps
- **S9 (`<SleepingPane>`):** reuse `useSleepWhenHidden` as is; the host's job
  is only to unmount the body and keep a region marker. For viewer kinds the
  body's unmount already flushes its position (`useViewerState` unmount
  flush) and its remount seeds from stage-then-store, so a sleeping viewer
  restores correctly without S9 doing anything about positions. Keep the two
  gates composable: a `PdfView` inside a sleeping pane is simply unmounted
  (its own 5 min timer never runs); a `PdfView` in an awake-but-hidden pane
  still sleeps on its own after 5 min.
- **What the stage guarantees:** (1) the store never lags a position by more
  than 5 s while the tab is shown; (2) at hide, unmount, popout seed and every
  save the latest position is in the store or merged into the saved entry;
  (3) `pendingViewerState(key)` + the store's `viewerState` is always the
  truth for a seed. What it does NOT do: readers of `tab.viewerState` straight
  off the store (not via `useViewerState`) can see a position up to 5 s old —
  no such reader of a position field exists today (grep found none); if one
  is added, read `pendingViewerState` first or call `flushViewerState(key)`.
- **Hold vs. `compileHeld`:** `PdfView`'s compile hold is the raw
  `compilingByPath` count, not the canvas's 10 min bounded `compileHeld`. A
  window that dies mid-build leaves the count stuck and the PDF never sleeps
  (status quo for that PDF). S9 may want one bounded signal in `pdfSync`.
- **Tests:** `PdfSleepHidden.test.tsx` is the harness for anything that needs a
  tab in the store behind `PdfView` (tab + `viewerState` in `tabsByScope`,
  fake timers via `advanceTimersByTimeAsync` so the worker slot's microtask
  teardown runs). `flushViewerState()` in `beforeEach` of any test that writes
  positions, or a stale stage from the previous test seeds the next mount.
  S2's `PdfHiddenPages` harness now waits for the page observers to register
  before reporting intersection and waits on the fingerprint count instead of
  sleeping 50 ms — both raced under load (load average 14–16 during this step).

### Gates (worktree)
| Gate | Result (with test counts) |
|---|---|
| `npm run build` | ok (tsc + both bundles) |
| `npm test` | 734 files / 7539 tests passed (S2 review: 731 / 7523; +3 files, +16 tests) |
| `cargo test -q` | 3722 passed, 0 failed (Rust untouched) |
| `npm run lint` | 0 errors, 28 warnings (pre-existing, unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check` | clean |

### Flagged for user
- `FileViewerPane.tsx`: one hunk only, in `useViewerState` (~line 310–345),
  outside the 9602–10098 region the brief warned about. `stores/tabs.ts`: the
  new block sits after `getDetachedViewerState` (~line 566), plus small hunks
  in `toSavedTabEntry`, `pruneCollapseCollect`, `writeScope`, `setViewerState`,
  `applyDetachedEdit` and a new `isTabInPopout` before the tree serialisers —
  none near ~2468.
- The plan's "`CenterPanel.tsx` persist effect must not fire for a
  viewer-state-only change" needed no CenterPanel hunk: the store does not
  change on a position write, so the effect's deps do not either; it fires
  once per 5 s fold at most, and that fold is the write that persists the
  position. `AppShell.tsx` likewise untouched: the quit `saveLayout` reads the
  stage through `toSavedTabEntry`.
- "The tab a popout mirrors" holds the main-window PDF awake, as instructed.
  That mirror is exactly the second document §4.5 wants to drop; when §4.5
  lands (a stub in the main window), the hold becomes moot and can go.
- A PDF tab restored hidden at launch still parses its document once (the
  load effect does not gate on visibility) and releases it 5 min later. Not
  loading until first shown is §5.3's call (it changes what a first click
  shows); not done here.
- The unsaved-markup hold is not covered by a unit test (driving
  `usePdfMarkup` into `storage === "unsaved"` with marks needs a markup
  layer); the seam's hold semantics are (`SleepWhenHidden.test.tsx`) and the
  compile and popout holds are (`PdfSleepHidden.test.tsx`).
- No setting for the 5 min: there is no `settings.performance` group and no
  sibling constant is a setting (`RENDERER_RELEASE_MS`, `PDF_PAGE_RELEASE_MS`
  are constants), so `PDF_DOC_RELEASE_MS` is a constant as the brief allowed.
- A forward search (`requestReveal`) aimed at a PDF center that is asleep in a
  TeX workspace: the reveal is stored by path and the center switch wakes the
  viewer, which then reads it on mount — by inspection only, not tested.

### Live click-through (user)
1. Open a long PDF, scroll to the middle, wait 6 s, quit Tabtivity, relaunch:
   it reopens at that position (the 5 s fold + quit save). Repeat with a quit
   within 2 s of the last scroll: still the latest position (the quit save
   reads the stage).
2. Scroll a PDF for a while with `htop` on the app: the renderer's CPU should
   no longer spike at each scroll pause; the session file in
   `<state_dir>/sessions/<id>/` should change at most every ~5 s.
3. Switch away from a PDF tab for > 5 min (a terminal in front), then back: it
   shows "Loading…" briefly and lands at the same page/zoom/scroll. Renderer
   RSS (`ps -o rss`) drops by roughly the file size × 2 while it is asleep.
4. With marks drawn in markup mode (unsent) or a page rotated and unsaved,
   leave the tab hidden > 5 min: it does not reload on return, the marks/edits
   are still there.
5. Pop the PDF tab out into its own window and leave the main window on
   another tab > 5 min: the popout keeps working (the main copy stayed awake),
   and scrolling in the popout no longer makes the main window's session file
   change on every pause.

### Review (S3 reviewer, 2026-10-07)
Range reviewed: `348e5ddd..2210d029` (ea5873f9, 550af44e, 2210d029).
Nothing run live.

**Bugs fixed**
- `16fdf97e` — §3.1 `duplicateTab` copied the source's `viewerState` straight
  off the store, which now lags the reader by up to the 5 s flush: a tab
  duplicated after a scroll opened where the reader was before it. The copy
  takes `savedViewerState(source)` (store + stage), the merge every save path
  uses. Test: `TabDuplicate` "copies the reader's position as it is now …".
  Same commit, tests the brief asked for: `ViewerStatePersist` "still yields a
  new tree for every genuine layout change" (active tab, reorder, split added,
  ratio, focused group, group collapsed) and `PdfSleepHidden` "answers a
  forward search that arrived while asleep on the wake" (the implementer's
  by-inspection claim, now asserted: the reveal stays by path, the wake's
  canvas consumes it and the highlight lands on page 2's wrap).

**Checked and found sound**
- Every persist path reads the stage: `persistScope` (periodic, quit
  `saveLayout`, scope switch at `tabs.ts:2601`) and the project-switch
  snapshot (`projects.ts:1334`) go through `toSavedTabEntry`; both popout seed
  builders (`reseedDetached`, `answerSeed`) flush first; the mobile catalog
  reads session files; no other serialiser of `viewerState` exists.
- Keys never change: `retargetTabs` rewrites paths only, `moveTab*`/detached
  moves keep keys, there is no cross-scope move — no stale Map key. Closed
  tabs: the unmount flush or the 5 s timer drops the entry; TeX sub-pane
  keys (`<key>#<path>`, never in the store, pre-existing) are dropped the same
  way. No growth. The one-shot timer re-arms only on a staged change.
- `flushViewerState` is never reached from inside `writeScope`/a `set`
  updater; `applyDetachedEdit` only calls `queueViewerState` there (reads
  `getState()`, no nested `set`).
- Identity: `pruneCollapseCollect` returns the *input* node, which every
  mutating action already replaced (`mapGroup`, `applyResize`), so a real
  change still yields a new tree (now tested). Un-normalised split sizes
  (e.g. a fresh `[1, 1]` split no longer renormalised by the prune) are safe:
  every consumer uses them as `flex` ratios or pairwise sums.
- Seed precedence: no store write of a position field bypasses the stage
  (`openTexWorkspace` sets `texActivePath` only; `retargetTabs` keeps the
  object), so a stage entry is never older than the store's. The one live
  `viewerState` selector (`FileViewerPane.tsx:8715`) reads `texActivePath`,
  a write-through field.
- §4.3 teardown: the canvas's mount effect cleanup destroys every source's
  `loadingTask` and `slot.dispose(pending)`s the `PdfWorkerSlot` — `pdfLoad.ts`
  stays the only path; the "no timer left" test proves the S2 hold timers,
  `catchUp`, zoom and persist timers go with it. Wake reads `viewPos.initial`
  (stage, then store), tested at scale 1.5 / scrollTop 640 and 900.
- Holds: `endCompile` runs in `TexView.compile`'s `finally`
  (`FileViewerPane.tsx:9897`) opposite its one `beginCompile`; `markup_done`
  ticks are re-read on `visible` (and on the MCP-changed event) from the
  store, rounds live in IndexedDB — nothing arriving for a sleeping PDF is
  lost. `isTabInPopout` walks the detached subtrees only, so a sibling tab in
  a scope with popouts is not held. Print/export live in the canvas toolbar of
  a visible (awake) tab; steering reaches the pane, not the body. The mobile
  `MarkupView` imports none of this.
- `useSleepWhenHidden`: timer cleared on unmount, on show, on hold change;
  show → hide within 5 min keeps the canvas (no reload storm).

**Gates (worktree, after the fix)**
| Gate | Result |
|---|---|
| `npm run build` | ok |
| `npm test` | 734 files / 7542 tests (S3: 7539, +3); one `PdfZoomRaster` timing failure at load average 36 (three gates in parallel), 5/5 twice alone |
| `cargo test -q` | 0 failed, exit 0 (Rust untouched; S3 count 3722 stands); one `api_usage` book-flush failure at load average 36, passed alone and in a full rerun |
| `npm run lint` | 0 errors, 28 warnings (pre-existing, unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check` | clean |

**Flagged for user**
- A redundant `setActive` on the already-active tab still rebuilds the layout
  tree (`mapGroup` allocates the path unconditionally) — pre-existing, outside
  §3.1's scope; a §5.1 candidate.
- The popout-mirror hold does not cover a TeX workspace's PDF *center* in a
  popped-out TeX tab (its key is `<key>#<path>`, not a tab): the main
  window's hidden copy sleeps after 5 min and reloads at the default position
  on reattach. Those sub-pane positions were never persisted (pre-existing),
  and the mirror's own document is the one §4.5 drops anyway.
- After a reattach the main window's viewer keeps the scroll it had before
  the detach (its pane stayed mounted); the popout's position reaches the
  payload, not the live element. Pre-existing (#231), unchanged by S3.
- The unsaved-markup hold stays untested (implementer's note stands).

## S4 — terminal frontend

*Written 2026-10-07 by the S4 implementer. Base `3e1a8406`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `3c763604` | §3.2 activity store on demand: `startActivityTicks` (trailing recompute + one-shot window-expiry timer, no interval), bus tap feeds the classifier, lean non-agent path, looked-at set once per recompute |
| `2447d23c` | §3.2 screen readers: Reader window 300 rows, `readableScreen` `plain` option for the words-only readers, Reader clock only while no terminal, `watchTerminal` in the registry |
| `5b84f824` | §3.2 `pty_resize` 80 ms trailing debounce + §5.2 xterm built on first show (`buildTerm`/`onBuild`), spawn not deferred |
| `f6ec9062` | §5.2 `launch_prep`: agent/host home preparation on `spawn_blocking` (`home_off_thread`), file-map rows |

### What was built / choices made
- **Recompute is armed, not ambient.** `scheduleRecompute` and the expiry
  timer are no-ops until `startActivityTicks` (AppShell's effect, re-armed
  with ×3 trail while quiesced) has run. A first cut subscribed the tabs
  store at import and fired trailing recomputes in every test; tests that
  hand-set derived state (`attentionByTab: "done"`) with real timers had it
  wiped 300 ms later (MobileTabSeen). Armed by AppShell, tests and popouts
  behave exactly as under the interval, which only AppShell ever ran.
- **Expiry windows** (`nextWindowEnd`): raw+`BUSY_WINDOW_MS`,
  out+`TEXT_GAP_MS`, onset+`WORK_ONSET_MS`, quiet+`DECISION_QUIET_MS`,
  quiet+`DONE_QUIET_MS`, paint+`HOOK_WORK_SILENCE_MS` (working verdict, no
  job); plus `BILL_TICK_MS` (2 s) while anything is busy so the usage
  recap's per-tick billing never sees a gap past `MAX_WORK_TICK_MS`. Once
  every window is past, no timer runs (`ActivityEventDriven` proves it).
- **"Evaluate only dirty PTYs"** was not done: each tab's reading is
  time-gated, so a quiet tab's answer can change with no event; the per-tab
  work is a few map reads, and the expensive part — a layout walk per tab
  for `isTabLookedAt` — became one `lookedAtPtyIds()` set per recompute.
- **Lean non-agent path** keeps `lastRawByPty`, `lastOutputByPty`,
  `onsetByPty`, `workAtByPty` and the echo gate (`bytesSayWorking`, the
  last-working mark and the hover card read them) and drops `stripAnsi`,
  the braille scrub and the tail. Every frame of a shell tab counts as text
  (a shell paints nothing while idle). Unknown ids take the full path.
- **Tab-kind lookup**: a `Set` of agent ids rebuilt when `tabsByScope`'s
  identity changes (one `getState()` + identity check per chunk).
- **Bus tap** (`onAnyTerminalOutput`) runs after the pane's handlers.
  Tauri 2 evaluates one script per listener with the payload inlined
  (`emit_js` per listener id), so the second `listen` really did parse every
  chunk twice; `terminal-activity` stays a plain listener in AppShell (one).
- **Readers that need style** (kept styled): `readReaderLive` (select
  prompts read the highlighted row by background/underline/colour,
  `isLiveEcho` by painted background), `lastPromptEcho` (`chatTurns`).
  Words-only (`plain`): `sessionStatus` callers (`screenModelTag`,
  `screenModeMarks` → `TabLocalityBadges`, `TerminalReaderFacts.readStatus`,
  all 80–120 rows) and `readCodexStatus` (`TerminalReaderStatus`, 120 rows).
- **Reader clock**: `TerminalReaderView` reads on `onWriteParsed` and on
  `watchTerminal` (built / respawned / retired); the 1.5 s clock runs only
  while `terminalFor` is empty. The test fake now fires the write event on a
  `rows.splice` and repaints each second in the "keeps a sent prompt while
  working" case — a real TUI repaints its busy row every second, which is
  what refreshes `workingSeenAt`.
- **Lazy xterm**: `let term: Terminal | null`; `buildTerm()` from `tryOpen`
  constructs, loads fit, runs the `onBuild` registrations, then
  `registerTerminal` (last, so a watcher reads a complete terminal).
  Call-time closures (key select, paste, font size, mouse handlers,
  renderer manager) guard on `term`; `pty_spawn` passes xterm's default
  80×24 when no terminal exists yet, which is what an unfitted terminal
  reported before. `applyFontSize` on an unbuilt pane is a no-op: the
  build reads the persisted size. Teardown disposes `termDisposables`,
  flushes a pending resize, then `term?.dispose()`.
- **`create_dir_all` of the root workspace** stays inline: one stat on an
  existing directory, cheaper than the thread hop. The home preparation is
  the real cost and is on the blocking pool for all three homes.

### Gotchas for later steps
- **S5 (batched digests → activity feed):** `notePtyOutput` is the only
  entry; it calls `scheduleRecompute()` per chunk (cheap no-op while a
  trail is pending). A digest must still arrive inside `BUSY_WINDOW_MS`
  (800 ms) of the last one for a hidden working tab to read busy — the
  expiry timer fires at raw+800 and clears it otherwise. `terminal-activity`
  is still a plain `listen` in AppShell; move it onto the bus only if the
  backend starts emitting it under `streamEventName`.
- **S5 (replay trim):** `terminal-replay` is still not fed to the
  classifier; the pane buffers it into `pendingOutput` and flushes through
  `stripTerminalQueries`. An unbuilt pane (never shown) holds replay in the
  same string — the first show builds, opens, flushes.
- **S10 (sleep/wake):** the attach path is unchanged; waking an asleep
  terminal tab remounts `TerminalView`, which builds nothing until the pane
  has a layout box and `visible` — exactly the first-show path, so
  attach-on-wake needs no new seam. `unregisterTerminal` fires
  `watchTerminal` callbacks: the Reader over a sleeping tab drops to its
  clock and resubscribes on wake. `pty_remove_view` on sleep: the pane's
  `pendingOutput` is lost with the unmount; the backend buffer
  (`ROUTE_SCROLLBACK_CAP`) is what the wake reads.
- **Anything hand-setting activity maps in tests** stays safe only because
  ticks are armed by AppShell; a test that calls `startActivityTicks` must
  stop it in `afterEach` (see `ActivityEventDriven.test.ts`).
- **Tests of `TerminalView` that type or read the mocked buffer** need a
  layout box (`clientWidth/Height`, `offsetParent`) or there is no terminal.

### Gates (worktree)
| Gate | Result (with test counts) |
|---|---|
| `npm run build` | clean: tsc + desktop bundle + mobile bundle (tsc clean on every commit) |
| `npm test` | 737 files / 7555 tests passed (base 734 / 7542; +`ActivityEventDriven` 6, `MobileReadableScreenPlain` 4, `TerminalLazyXterm` 3) |
| `cargo test -q` | lib 3557 passed (3 new `home_off_thread` tests), every other target green |
| `npm run lint` | 0 errors, 28 warnings (pre-existing, unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | clean |
| `git diff --check` | clean |

### Flagged for user
- `isTabLookedAt` had a subtle rule — a tab inside a popout group answered
  for that group only, never falling through to the main layout. The set
  version unions popout active keys with the current scope's; it answers
  the same as long as a key sits in one group, which the store guarantees.
- A shell tab's frames with no visible text (a cursor move, a title
  update) now count as text, where before they only counted as paint; no
  program known to run in a shell tab emits only those, and a redrawing TUI
  (htop, vim) already counted since its frames carry text. No agent tab is
  affected.
- `TerminalReaderView`: a working agent whose busy row never repaints (none
  known) would no longer refresh `workingSeenAt` and a sent prompt would be
  let go after `PENDING_MS`.

### Live click-through (user)
1. Open a project with a shell tab and an agent tab; run a long `ls -R` in
   the shell: its ring turns green and goes out within ~1 s of the output
   stopping (expiry timer, no interval). `top` keeps it on while it redraws,
   as before.
2. Ask the agent something and switch to another tab: the pill shows
   working, then finished (`done`) once it stops; switching back clears it.
3. Open the Reader over a Codex tab, open Status: the card fills and its
   timers tick; close it. Switch Reader on over a Claude tab while it works:
   the busy row's seconds advance (write-driven, no clock).
4. Restart into the dev build with many tabs: hidden tabs show nothing until
   first shown, then their buffered output appears at once; a tab first
   shown after its agent printed a sign-in link still shows the card.
5. Drag a splitter across an agent pane: the TUI repaints once at the end
   of the drag (one resize), not continuously.

### Review (S4 reviewer, 2026-10-07)
Range reviewed: `3e1a8406..e78dd33f` (3c763604, 2447d23c, 5b84f824,
f6ec9062, e78dd33f). Nothing run live.

**Bugs fixed**
- `aa2a6470` — `nextWindowEnd` waited out the done silence only from
  `max(lastText, bell)`, which is what the attention lamp reads; the turn-end
  mark (`lastDoneByTab`, read by the phone bridge's `doneAt`, the schedules
  view and the prompt history) waits it out from the last text alone, so a
  lone bell after the output stopped pushed that mark back by the bell gap
  (the 300 ms clock caught it by accident). `out + DONE_QUIET_MS` is listed.
  Test: `ActivityEventDriven` "marks the finished turn on the output's own
  silence when a bell came later". Same commit, the transition tests the
  brief asked for, driven off the store's own timers only: decision window
  expiry, hook-silence retirement (and no timer left after), the 2 s bill
  tick (≥18 of 19 silent busy seconds booked), scope switch mid-turn → done,
  no done for a turn watched to its end, bell shortcut, quiesce re-arm keeps
  the pending windows and `stop` clears them, ≤ 1 trail + 1 expiry timer
  under 40 chunks, popout open/close recompute.

**Checked and found sound**
- Every `note*` schedules or recomputes: `notePtyOutput`, `noteUserInput`,
  `notePtySpawn`, `noteBackgroundWork` (trail); `noteAgentTurn`,
  `noteScheduleProposal`, `noteTurnCutOff`, `noteBell` (direct, which arms
  the expiry). `clearAttention` only moves `seenAt` and sets the maps itself;
  nothing time-gated depends on it. The popout's `detached-activity` events
  land in those same calls. Tab list / layout / popout / scope changes come
  through the tabs-store subscription.
- Every time gate `recompute` reads is in `nextWindowEnd`: `BUSY_WINDOW`,
  `TEXT_GAP`, `WORK_ONSET`, `DECISION_QUIET`, `DONE_QUIET` (both from
  `quietFrom` and, now, from the text), `HOOK_WORK_SILENCE` on `max(raw,
  turn.at)`. `INPUT_SUBMIT_GRACE_MS` gates only the delivery readers (polled
  by their callers), not the maps. `armExpiry` clears before arming, the
  trail is guarded by `trailTimer !== null`, `startActivityTicks`'s stop
  clears both; the `+1` ms keeps a window past on the firing tick and an
  early fire would only re-arm.
- Quiesce: `startActivityTicks(saverInterval(300, quiesce))` re-arms on each
  flip — the trail stretches ×3 as the interval did; the expiry is exact.
- Bus tap order is the old listener order (the bus's `listen` registered by
  the first pane, AppShell's second); the classifier reads only `inputByPty`,
  which the output path never writes, so neither order changes a result.
  An id with no tab record takes the full (agent) path, as before.
- Lean path: `tailByPty` is read only by `tailLooksLikeDecision`
  (agent-only `attentionFor`/`clearAttention`); no code promotes a shell tab's
  `kind` to agent (the shim marks nothing on the tab record), so a shell's
  tail was never read. `lastOutputByPty`/`lastRaw`/onset/`workAt`/the echo
  gate are kept for `bytesSayWorking`, the hover card and the last-working
  mark.
- `readableScreen(buffer, maxRows, { plain })` is additive; the phone's two
  callers pass one argument; `sessionStatus` and `readCodexStatus` read no
  span style. An answer past 300 rows: `start` stays 0, the tail is the
  window, a dialog at the bottom is still found; no throw, no re-read loop.
- `watchTerminal`: unwatched in the Reader effect's cleanup (deps `visible,
  ptyId, agentLabel`); a respawn's unregister → clock, register → resubscribe
  (`subscribed.term !== term`); the clock starts only in the no-terminal
  branch and is cleared in the first read that finds one. Disposing the write
  subscription after `term.dispose()` is a no-op in xterm's emitter.
- `pty_resize`: `tryOpen` sends the first size at once; `doFit` queues the
  last of a burst (trailing, 80 ms); teardown flushes (not cancels) — right
  for the popout move and S10's sleep, harmless for a killed PTY.
  `pty_spawn`'s `term?.cols ?? 80` is read after its awaits, so a pane opened
  meanwhile spawns at its fitted size.
- Lazy xterm: every call-time `term.` use outside an `onBuild` closure is
  guarded (`loadCanvas`, `applyRenderer`, `flushPending`, `writeTerm`, key
  select, paste, font size, the three mouse handlers, `dispose`,
  `unregisterTerminal`); the theme/focus/`initialInput`/trust-dialog paths
  go through `termRef.current?.`. `terminal-exit` before build → `writeTerm`
  → `pendingOutput` → shown on first open. A never-shown pane disposes
  nothing and still kills its PTY (`TerminalLazyXterm`).
- `terminalFor` consumers (`TabLocalityBadges`, `agentModels` model tag and
  prompt-echo fallback, `terminalScroll`, `useKeyboard`, `SteeringLegend`,
  the Reader) all take `undefined`; a never-shown pane's xterm buffer was
  empty before (writes were buffered past an unopened pane), so they read
  the same.
- `launch_prep`: the three home preparations `.await` in sequence before
  the fence wrap / env steps that need the directory; a panic is a
  `JoinError` → the spawn's error; tests cover value, named error, panic.
- Harness changes: the two layout stubs only make the mocked terminal exist
  (jsdom lays nothing out); `TerminalThemeRenderer` still proves no theme
  write reaches an unopened xterm (now: none exists to reach) and the
  watchdog reopen; the Reader fake's write event is what a real xterm fires.

**Gates after (worktree)**
| Gate | Result |
|---|---|
| `npm run build` | clean (tsc + desktop + mobile bundles) |
| `npm test` | 737 files / 7565 tests passed (+10) |
| `cargo test -q` | lib 3557 passed, 3 ignored; every other target green |
| `npm run lint` | 0 errors, 28 warnings (pre-existing) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | clean |
| `git diff --check` | clean |

**Flagged for user**
- `SteeringLegend`'s `terminal:` flag and `useKeyboard`'s steering scroll
  target read `terminalFor` at render/keypress: for the frame between a tab
  becoming active and its first open, the active tab now reads as having no
  terminal (before, it had an unopened one). Cosmetic at most.
- The Reader over a working agent whose busy row never repaints (none
  known) would let a sent prompt go after `PENDING_MS` — the implementer's
  flag stands; the 1.5 s clock is gone once a terminal exists.
- The handoff says "the phone reads the same tail" for the 300-row Reader
  window; the phone's `readableScreen` still reads `MAX_ROWS` (1200). Not a
  behaviour change on either side.
- A `done` mark/bill tick after a long idle: the first busy tick's
  `sinceLastTick` can exceed the 5 s clamp and books 0 for that one tick
  (≤ a trail's worth); the interval never had a gap. Negligible.

## S5 — terminal backend

*Written 2026-10-07 by the S5 implementer. Base `c7f6149e`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `3c4745d9` | §3.2b replay trim: new `terminal/replay_trim.rs` (cut at the last full clear, `ScreenState` re-applied in front, main-screen phases kept across an alt-screen cut, `REPLAY_TRIM_FLOOR` 128 KB); `OutputRoute.carried` folds what the pending cap trims off; route tests |
| `f24adf80` | §7.6 batched digests: one `DigestClock` (clock → routes lock order) replaces the per-route `last_activity`/`digest_armed`; a tick drains every hidden route into one `terminal-activity-batch`; `lib/terminal/activityDigests.ts` feeds it from `AppShell`; tests both sides |

### What was built / choices made
- **The cut rule** (`replay_trim::find_cut`), from what the TUIs emit — Ink
  (Claude, Gemini) `ESC[2J ESC[3J ESC[H`, `clear`/curses `ESC[H ESC[2J`,
  ratatui `Clear(All)` = `ESC[2J` then absolute positioning: a cut is the
  start of the *last* of
  1. `ESC[2J` whose contiguous run of sequences (no text in between, ≤ 32
     sequences) also positions the cursor absolutely (`H`/`f`);
  2. a cursor-home (`ESC[H`, `1;1H`, `;H`, `f`) whose run also erases to the
     end (`J`, `0J`, `2J`);
  3. `ESC[?1049h` entering the alternate screen (which clears it) — only a
     *real* enter: a redundant one (already on alt by the buffer's own
     switches) is ignored, as xterm ignores it;
  4. `ESC c` (RIS): no state from before it is re-applied.
  A bare `2J` with text after it, a mere home, `1J`, `3J`, `2K`-style
  line erases are not cuts. Cuts are only ever at a sequence start: the
  buffer is tokenised (CSI / OSC / DCS-SOS-PM-APC strings / two-byte and
  charset escapes / text), so no cut lands inside a sequence; an
  unterminated sequence at the end is left as it is. OSC/DCS strings end at
  BEL, ST, or a bare ESC (xterm's parser does the same), so a title without
  a terminator cannot swallow a later clear.
- **The state re-applied** (`ScreenState`, last value wins, first-seen
  order, nothing untouched is mentioned): DEC private (`?`) and ANSI modes
  (`h`/`l`, multi-param forms split — `?1049`, `?1000/1002/1003/1006`,
  `?2004`, `?1004`, `?25`, `?7`, `?2026`, `4`, …); SGR (the sequences since
  the last full reset, written after an `ESC[0m` only if the dropped bytes
  touched attributes); DECSCUSR cursor shape; DECSTBM scroll region; charset
  designations `ESC ( ) * +`; OSC title/icon (0/1/2), fg/bg/cursor colour
  (10/11/12 and their 110/111/112 resets), palette entries (4/104). A query
  (`OSC 10;?`) is never replayed. `ESC[!p` (DECSTR) clears modes/attributes/
  cursor/region/charsets but keeps the title; `ESC c` clears all. Order
  written: charsets, SGR, cursor shape, modes, scroll region, OSC.
- **Alt-screen phases.** When the cut is on the alternate screen (including
  a `?1049h` cut), the main-screen phases of the dropped prefix are written
  first, raw, then the state prefix, then the tail: the program's exit
  restores a main screen that has what the hidden spell printed there (a
  hidden-spawned alt-screen TUI's banner, a shell before `less`). A cut on
  the main screen after the program left drops the alt content and the
  prefix carries `?1049l` so xterm leaves the alt screen too. Which screen
  the buffer *starts* on is unknown (xterm's state before hiding is not
  tracked) until its first switch; without any switch the whole buffer is
  one screen and the cut rule needs nothing more.
- **`REPLAY_TRIM_FLOOR` 128 KB** (a choice beyond the plan's wording): a
  buffer under it replays whole — milliseconds of xterm work — because a
  main-screen cut drops lines the hidden spell scrolled off before its last
  clear (Ink's `3J` wipes them anyway; a bare `2J H` does not). Above it
  the freeze is the cost that matters. Alt-screen TUIs lose nothing either
  way.
- **Carried state across the pending cap**: `push_pending` folds the bytes
  `ROUTE_PENDING_CAP`'s hysteresis cuts off the front into
  `OutputRoute.carried` before dropping them (`hysteresis_cut` split out of
  `trim_with_hysteresis`); `take_pending` spends it (in front of a whole
  replay too). Before, a mode set in the trimmed-off megabyte was lost.
- **Replay offsets** stay the covered stream range (`pending_start` →
  `output_offset`) though the text is shorter: the only reader
  (`outputAfterScrollback`) drops a replay that ends inside the popout's
  scrollback snapshot, which the whole-range comparison still answers; a
  partial overlap cannot happen (the replay is emitted under the routes
  lock before the snapshot is taken).
- **`DigestClock`**: `arm(now)` returns the deadline when no tick is armed —
  `now` if the last tick is a window or more ago (leading edge), else
  `last + ACTIVITY_INTERVAL` (trailing); `tick(now)` marks the drain. One
  short-lived task per armed tick (`arm_digest_tick`), none while no hidden
  PTY streams (the zero-idle-wakeups discipline holds). The clock is a
  separate mutex taken **before** the routes lock on every path
  (`route_chunk_at`, `route_finish`, `route_digest_batch_take`).
  `digest_batch_take_in` drains every unsubscribed route with a non-empty
  digest, id-sorted, and emits nothing when the batch is empty. Payload:
  `Vec<TerminalOutput>` (`id`, `data`, offsets `None`).
- **Frontend**: `noteActivityDigests(batch)` (new
  `lib/terminal/activityDigests.ts`) loops `notePtyOutput` per entry in
  order; `AppShell` listens on `terminal-activity-batch` instead of
  `terminal-activity`. No popout listens to either (grepped: only AppShell
  did); `activity.ts` is untouched. `terminal-replay` is still not fed to
  the classifier.
- Tests: `replay_trim` 13 unit tests (every cut shape, the non-cuts, modes
  last-value-wins, attributes/title/charset/cursor/region, DECSTR, alt
  phases, redundant enter, mid-sequence safety incl. multi-byte and
  unterminated tails, carried state, unterminated OSC); route-level
  `showing_replays_from_the_last_clear_with_the_modes_in_front`,
  `a_short_hidden_spell_replays_whole`,
  `a_mode_trimmed_off_by_the_cap_still_replays`; `DigestClock` +
  `one_tick_batches_every_hidden_digest_due` (private map and clock, so
  parallel tests never drain each other's digests —
  `route_chunk_clocked` takes the test's own clock); the `batch_output`
  paused-clock tests are untouched and green. TS
  `ActivityDigestBatch.test.ts`: five ticks of three digests through
  `noteActivityDigests` leave `lastPtyOutputAt`/`busyByTab`/`attentionByTab`
  exactly as the single `notePtyOutput` calls did; batch order; empty batch.

### Gotchas for later steps
- **S10 (sleeping terminal tabs):** the attach path replays
  `route_scrollback` (`retained`, `ROUTE_SCROLLBACK_CAP` 256 KB) — a *whole*
  tail, NOT trimmed: `trim_replay` is applied only to `pending` in
  `take_pending`. A sleeping tab that wakes via `pty_scrollback` + a view
  registration gets up to 256 KB written in one go (the snapshot) plus the
  hidden-spell replay (trimmed) — both pass `flushPending`'s query strip.
  If S10 wants the snapshot cut too, `trim_replay(retained.clone(),
  &ScreenState::default(), floor)` is the call; its state prefix is then
  computed over the snapshot's own prefix only (a mode set before the
  256 KB tail is gone — the same as today's snapshot). Note `pty_remove_view`
  on sleep makes the route unsubscribed, so a sleeping tab's PTY buffers
  into `pending` and digests like a hidden one; on wake the first
  `pty_set_visible(true)` drains `pending` as the trimmed replay *and* the
  attach path reads the snapshot — `outputAfterScrollback` drops the replay
  if its range ends inside the snapshot (it does, the snapshot is read
  after). Keep that order (register view → snapshot), as `TerminalView`
  does today.
- A replay's `data.len()` no longer equals `end_offset − start_offset`.
  Nothing reads it that way now; don't start.
- `terminal-activity` (singular) no longer exists. The mobile sidecar and
  headless owner never listened to it (grepped).
- A PTY silent at a tick that speaks right after waits for the next tick:
  its digests can be two windows (1 s) apart where its own clock gave
  `≤ 500 ms + chunk gap`. A working TUI repaints every tick, so continuous
  streams still digest every 500 ms (< `BUSY_WINDOW_MS` 800). If a hidden
  tab with ~600–800 ms output cadence is seen flickering between working and
  idle, that is this; the fix would be a shorter `ACTIVITY_INTERVAL` (the
  plan fixes it at 500) — not a per-PTY clock again.
- The final EOF digest of a PTY whose route is removed at exit (no view
  registered, no watcher) is lost; before, it was emitted synchronously.
  It is at most the decoder's trailing partial codepoint plus the last
  window's tail; a pane that exists keeps the route (`seq = 0`) and the
  armed tick still drains it.

### Gates (worktree)
| Gate | Result (with test counts) |
|---|---|
| `npm run build` | clean: tsc + desktop bundle + mobile bundle |
| `npm test` | 738 files / 7568 tests passed (base 737 / 7565; +`ActivityDigestBatch` 3) |
| `cargo test -q` | lib 3574 passed, 3 ignored (base 3557; +13 `replay_trim`, +3 route replay, +1 digest batch); every other target green |
| `npm run lint` | 0 errors, 28 warnings (pre-existing, unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | clean |
| `git diff --check` | clean |

### Flagged for user
- **Scrollback after a long hidden spell** (main-screen TUIs only — Claude,
  Codex, Gemini): once the hidden buffer passes 128 KB, lines the agent
  scrolled off before its last full clear are no longer written into
  xterm's scrollback on show; what xterm had before hiding stays, and the
  last repaint onward is replayed. Under 128 KB everything replays as
  before. The Reader/transcript views are unaffected (they read the
  transcript, not the pane). Alt-screen TUIs (opencode) have no scrollback
  to lose.
- Codex's ratatui inline viewport may never emit a full clear (it scrolls
  history above the viewport instead); then its replay is whole and capped
  as today — no gain, no loss. Not verifiable here.
- The plan's line "`ESC[2J`/`ESC[H`" was taken as the *shapes above*, not
  as "any `H`": a lone cursor-home is every frame's cell move in a TUI and
  cannot be a cut.
- The per-PTY digest latency change above (two windows worst case).
- `activity.ts` was left untouched as the plan says; the batch feed is a
  one-function module beside the bus rather than an inline loop, so it is
  unit-tested.

### Live click-through (user)
1. Start an agent in a tab, let it work for a few minutes **hidden** (switch
   to another tab); switch back: the pane appears at once (no freeze) with
   the current frame drawn correctly.
2. In that tab right after showing it: the mouse still scrolls/selects as
   the agent set it (wheel over Claude scrolls its transcript, not xterm's
   scrollback; no `[<35;…M` garbage typed into the input); paste a
   multi-line snippet: it arrives as one bracketed paste, not line by line
   executed; Ctrl+click a URL still opens it; the cursor is hidden/shown as
   before.
3. opencode (alt screen): hide it while it works, show it: still on its
   full-screen UI, `q`/exit returns to the shell prompt as before.
4. Open a shell tab, run `clear`, hide it, run something long in it from
   the phone or let a script print, show it: the output is there.
5. Pill check with many agents working while hidden: pills stay "working"
   (green) without flicker; a decision prompt in a hidden tab still turns
   the pill within ~1 s; nothing changes in the visible tab's behaviour.
6. Pop out an agent tab while it is hidden in the main window: the popout
   opens with the tab's current frame and keeps streaming.
### Review (S5 reviewer, 2026-10-07)
Range reviewed: `c7f6149e..7c63373b` (3c4745d9, f24adf80, 7c63373b). Nothing
run live.

**Bugs fixed**
- `660b5283` — `ScreenState` dropped *every* tracked mode at a DECSTR
  (`ESC[!p`), but xterm.js's `softReset` leaves the alternate screen and
  mouse reporting alone (it resets `?1 ?6 ?7 ?25 ?45 ?66 ?1004 ?2004`, IRM,
  SGR, charsets, margins, the saved cursor): a TUI soft-resetting after
  `?1049h` replayed onto the main screen with the mouse still reporting.
  Only what DECSTR resets is dropped now, and the `!p` itself is replayed
  (for the saved cursor / origin mode the state does not track). Same
  commit: a full reset (`ESC c`) *inside* the kept prefix was folded into
  the state but never replayed, and the main-screen phases printed before
  it were kept as live — the reset is written first, the phases after it,
  and `find_cut` forgets the phases before a RIS. Tests:
  `a_soft_reset_before_the_cut_keeps_the_screen_mouse_and_title`,
  `a_reset_inside_the_prefix_is_replayed_before_what_follows_it`, and the
  randomized `a_trimmed_replay_leaves_the_state_the_whole_buffer_would`
  (3000 streams from a pool of what the TUIs emit — modes incl. `?47`/
  `?1047`, SGR, DECSCUSR, DECSTBM, charsets, OSC 0/2/4/10/11/104 incl. a
  query, DECSC/DECRC, every clear shape, RIS, DECSTR, `6n`: the cut is at
  an ESC, the tail verbatim, no spliced sequence in the replay, and folding
  the replay into a fresh state gives the whole buffer's).
- `42e1b827` — `route_open` cleared `pending` but not `carried`: a tab
  respawned under its id while hidden (mode switch, HMR) replayed the old
  program's `?1049h`/mouse modes in front of the new program's output.
  Test: `a_respawn_drops_the_state_carried_from_its_predecessor`.
- `8a015b0b` — the digest-latency flag was a real regression: beside one
  continuously repainting hidden tab (ticks at every window end), a hidden
  tab speaking every 700 ms had its digests drained at 0 / 1000 / 1500 /
  2500 ms — a 1 s gap > `BUSY_WINDOW_MS` 800, and `nextWindowEnd` re-reads
  the tab exactly at `raw + 800`, so `bytesSayWorking` went false for
  200 ms and the pill flickered; the per-PTY timers gave max(500, gap).
  Each route now stamps `last_digest` at its drain and a chunk is due by
  `max(last + ACTIVITY_INTERVAL, now)`; `DigestClock` holds the earliest
  deadline, an earlier one pulls the armed tick forward (generation-tagged;
  the superseded task wakes and drains nothing). Still one event per tick,
  routes in the same window share it, nothing armed while nothing streams;
  worst-case ticks equal the old per-PTY event count, typical is one per
  window. Test: `a_pty_keeps_its_own_cadence_beside_a_continuous_one`
  (private map + clock: leading-edge pull, window-end pull via a third
  PTY, superseded generation drains nothing, in-window chunk arms nothing).
  The S5 "Gotchas" paragraph on two-window latency no longer applies.

**Checked and sound**
- Cut never inside a sequence / multi-byte char: cuts are at an ESC token
  start; `string_end` ends OSC/DCS at BEL, ST or a bare ESC exactly as
  xterm.js's table does (`OSC_STRING` + 0x1b → `OSC_END`, then ESCAPE);
  randomized test covers splicing.
- `?1049h` cut: kept main phases are raw and in order; xterm.js copies the
  main cursor into the alt buffer on `activateAltBuffer`, and the phases
  reproduce the same main cursor the whole stream would have (alt phases
  never move it; `1049l` restores). A redundant enter is a no-op in
  xterm.js too (`activateAltBuffer` returns if already alt).
- Modes: last value wins, split multi-param forms, `?1004`, `?1`, DECSCUSR,
  DECSTBM, SGR after a reset, charsets, OSC 0/1/2/10/11/12/4/104 (queries
  skipped) — all verified by the randomized fold. 8-bit C1 (`U+009B`) is
  text to the tokenizer (flagged below); a cut can never land inside one.
- Carried fold: each cap trim folds only the newly dropped front, once;
  `take_pending` spends it; the 128 KB floor applies to the trimmed length
  (≤ 1 MB after hysteresis, so always above the floor once the cap bit).
- `trim_replay` runs only in `take_pending` (show / watch rising edge),
  two linear passes (lookahead ≤ 32 tokens per clear candidate) under the
  routes lock — milliseconds for 1 MB; `stripTerminalQueries` sees whole
  sequences.
- Lock order: `digest_clock()` is taken at exactly three sites
  (`route_chunk_at`, `route_finish`, `route_digest_batch_take`), each
  before `routes()`; no site takes the clock while holding routes.
- Route removed between arm and tick: only when no view and no watcher
  (`route_close`), i.e. no pane; the pill's exit comes from `terminal-exit`
  (`terminalBus.ts:106`), so the lost EOF digest is negligible as flagged.
- Batch: id-sorted, no event when empty, emitted globally like the old
  event; no popout, the sidecar or the headless owner ever listened to
  `terminal-activity`. `noteActivityDigests` loops `notePtyOutput` in
  order; `ActivityDigestBatch.test.ts` asserts store equality with the
  per-event path.

**Gates (worktree, after fixes)**
| Gate | Result |
|---|---|
| `npm run build` | clean (tsc + desktop + mobile bundles) |
| `npm test` | 738 files / 7568 tests passed (unchanged) |
| `cargo test -q` | lib 3578 passed, 3 ignored (S5: 3574; +4 net: +3 replay_trim, +2 route, −1 renamed); other targets green |
| `npm run lint` | 0 errors, 28 warnings (pre-existing) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | clean |
| `git diff --check` | clean |

**Flagged for user**
- The pending cap (`ROUTE_PENDING_CAP`, pre-existing) still cuts at a char
  boundary, not a sequence boundary: a mode split across the cut is lost
  (neither `carried` nor `pending` sees it) and the kept front starts with
  the sequence's remainder as text. Rare (one cut per megabyte); the fix
  would be a token-boundary cut in `hysteresis_cut`.
- 8-bit C1 controls (`U+009B` CSI, `U+009D` OSC) are text to the tokenizer
  while xterm.js parses them; no TUI emits them in UTF-8 mode. Harmless for
  cuts; a mode set that way would not be re-applied.
- `?47h`/`?1047h` also clear the alt buffer in xterm.js but are not cuts
  (conservative: whole replay, as today). `on_alt` is unknown until the
  first switch, so a `?1049h` from a program already on the alt screen
  before hiding (xterm ignores it) is taken as a real enter and the bytes
  before it are kept as main-screen phases — harmless, rare.
- Design note, not a bug: with every hidden tab silent-then-speaking at a
  staggered ≥ 500 ms cadence, the pulled ticks approach the old one-event-
  per-PTY count; continuous streams (the §7.6 case) still batch to ~2/s.

## S6 — many-tabs memoisation

*Written 2026-10-07 by the S6 implementer. Base `2a19c24c`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `45bcd8a9` | §5.1 pane layer: the per-tab derivation moves from `CenterPanel`'s map into a `memo`'d `PaneSlot` (`components/layout/PaneSlot.tsx`); a redundant `setActive` on the already-active tab of the focused group is a store no-op (the S3 reviewer's note); `ContainerScope.test.ts`'s source tripwire now reads `PaneSlot.tsx` |
| `cdd2a37f` | §5.1 tab strip: a plain tab is a `memo`'d `TabItem` (in `TabBar.tsx`) with per-key activity + schedule subscriptions and a stable `TabItemBar` handler object; the bar reads the whole activity maps only while it holds a tab group |
| `91e780de` | §5.1 file tree: a row is a `memo`'d `FileRow` (in `FileTree.tsx`) fed primitives, the entry and two stable objects (`moveTargetAttrs`, the `RowActions` dispatcher) |

### What was built / choices made
- **`PaneSlot` boundary.** `CenterPanel` keeps the positioned `.center-pane`
  box (its `style` is the only thing a `groupRects` measure changes), the
  `visible`/`focused` booleans, the `projects.find`/`boxes.find` lookups and
  the per-scope `getConnect` handler; everything after that — remote hold per
  host, mirror cwd, files dir, container flag, tmux session, the Mobile
  first-seen map — is `PaneSlot`'s. Its props are the `TabEntry`, the pane's
  own `ProjectEntry`/`ProjectBox` (store references), the project's primary
  SSH lamp (a string), its worker-lamp record, the folded
  `persist_local_sessions` boolean, the stable `onConnect` and the shared
  `mobileAgentTmuxReady` Map (one object, mutated, never replaced — it must
  outlive a slot, since an inactive project's slots unmount and remount).
  `TabPane` stays `memo` underneath; `PaneSlot` renders it directly.
- **`setActive` no-op.** Guarded on `found.group.activeKey === key &&
  s.focusedGroupId === found.group.id`: a click on the active tab of an
  *unfocused* group must still move focus, so that half is not short-cut.
  `setGroupActiveInScope`/`revealTabInScope` are untouched (they take a
  group/scope and are not the hot re-click path).
- **`TabItem`.** Lives in `TabBar.tsx` (module level) rather than a new file:
  it is the bar's old per-tab JSX verbatim, and the pointer drag, context
  menu, inline rename, steering `data-tab-index`, badges and i18n all stay
  where they were — only the closures are reached through `bar`
  (`TabItemBar`), one object per bar built once (`useMemo([])`) whose
  forwarders read a ref refreshed in a `useLayoutEffect` after every commit.
  The bar's `selectOnMount` became a module function (same single identity).
  The status ring is `useTabStateClass`: three primitive selectors on
  `<scope>:<key>`; the pure `tabStateClassOf` is shared with the bar's
  `tabStateClass`, which still serves `TabStackChip`'s folded members from the
  whole maps — but those three subscriptions now return module constants
  unless some tab in the bar has a `stack`, so a bar without a group never
  re-renders on activity at all.
- **Schedule indicator.** `TabItem` subscribes to its own
  `byTarget[scheduleCacheKey(scope, scheduleTargetId)]` list and memoises the
  enabled count + next occurrence on that list's identity (the plan's "cache
  by schedule identity"). The "now" is the time of the last list change or
  item mount, not of the hover: see Flagged.
- **`FileRow`.** The derivation per row (git letter, sizes, run/compile
  flags, sync state, `notOnRemote`, …) still runs in `renderEntry` — it is
  cheap lookups — and ends in `<FileRow …/>` with ~27 scalar props. The eleven
  per-row closures became `rows` (`RowActions`, same latest-ref pattern as
  `TabItemBar`); `moveTargetAttrs` is `useMemo`'d on `(projectDir,
  remoteListing)` because its spread is on every folder row (the
  `FileMove.test.ts` source tripwire still finds the spread two lines under
  each `data-move-rel`). `rel` is now computed for every row (it was `""` on
  an unsynced tree; only the sync lookups read it and they are still gated).
  Keyboard navigation, selection, drag, context menus, gitignored folding and
  sync badges are byte-for-byte the old JSX.
- **Tests** (render counts via a mocked leaf each component renders once —
  `TabPane` for a slot, `TabMarkBadge` for an item, `FileIcon` per unique
  extension for a row): `PaneLayerMemo.test.tsx` (60 tabs: a rect change →
  0 slot renders and the shown box takes the new width; one `renameTab` →
  1 slot; redundant `setActive` → `layoutByScope`/`tabsByScope` identity
  kept and 0 renders; a real one → 2), `TabBarItemMemo.test.tsx` (60 tabs:
  one busy flip → 1 item, one attention flip → 1 item, hover card open/close
  → 0, activation → 2), `FileTreeRowMemo.test.tsx` (300 rows through two
  "show more" clicks: tooltip dwell → 0 rows, one row selected → 1 row).

### Gotchas for later steps
- **S9 (`SleepingPane`):** the swap point is inside `PaneSlot`, not the
  layer: keep `CenterPanel`'s `.center-pane` box (steering's
  `data-steer-region`/pane class and the drag ghost's `data-tab-key` lookup
  both hang off it, as does `onMouseDownCapture` → `focusGroup`), and let
  `PaneSlot` return `<SleepingPane>` instead of `<TabPane>` when its tab is
  asleep. A sleeping tab needs none of the derived props, so a `SleepingPane`
  branch placed *before* the derivation keeps a sleeping slot's render
  trivially cheap — but the `mobileAgentTmuxReady` first-seen write must
  still happen on the first render (move it above the branch, or a tab that
  sleeps before it was ever derived loses its eligibility stamp). Wake-up
  (`visible` true, focus, steering) is a prop change on that one slot, so
  nothing else re-renders. Add `asleep` (or `hiddenSince`) as a scalar prop;
  don't pass a Map of sleep states or every slot re-renders on each tick.
- **S9/S10:** `TabPane`'s props are unchanged; a `SleepingPane` for a
  terminal tab should keep rendering through `PaneSlot` so the `tmuxSession`
  / `sandbox` / `terminalCwd` it will need on wake are derived by the same
  code (`TerminalView` has them in its spawn deps — a wake must hand it the
  identical values or it respawns).
- **`TabItemBar`/`RowActions` latest-ref pattern:** the ref is refreshed in a
  `useLayoutEffect` with no deps, i.e. after every commit of the bar/tree. A
  handler fired between a render and its commit is impossible, so it never
  sees a stale closure. Anything new a `TabItem`/`FileRow` must call goes
  through that object (one more field), never as a fresh prop.
- **`TabAgentModeMarks`** (inside every `TabItem`) still subscribes to the
  whole `modeByTab`/`goalByTab` maps of `useAgentModelsStore`; a mode change
  on any agent re-renders that badge in every tab (the badge only, the item's
  memo holds). Worth a per-key selector if it shows up.
- **Tests that render `TabBar` with agent tabs** now pay 60 × 3 activity
  selectors; the activity store must be reset in `beforeEach`
  (`busyByTab`/`busyKindByTab`/`attentionByTab`) or a previous test's lamp
  leaks into a count. `FileTreeRowMemo` runs with fake timers and the row
  cap: `mountAll` clicks "show more" until it is gone.

### Gates (worktree)
| Gate | Result (with test counts) |
|---|---|
| `npm run build` | ok (tsc + both bundles) |
| `npm test` | 741 files / 7576 tests (base 738 / 7568) |
| `cargo test -q` | lib 3578 passed, 3 ignored (base 3574 + the S5 review's 4); every other target green (unchanged by S6: no Rust touched) |
| `npm run lint` | 0 errors, 28 pre-existing warnings |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check` | clean |

### Flagged for user
- **Schedule tooltip "next" is cached by schedule identity.** The ◷ title on
  an agent tab used to compute the next occurrence from a fresh `Date` on
  every bar render (which, with status ticks, was near-continuous). It is
  now computed when the tab's schedule list changes or the tab mounts; after
  the shown occurrence passes with no list change, the tooltip names the
  past one until the next republish (a run or an edit saves the list; the
  count is unaffected). Not a behaviour the plan asked to keep; say so if
  it should refresh per hover instead (one `onMouseEnter` recompute, no
  timer).
- **`TabBar.tsx` carries uncommitted edits in the main checkout** by another
  session: the `TabItem` extraction replaces the bar's per-tab JSX block and
  three hook lines (activity maps, schedules, `selectOnMount`) wholesale, so
  a merge of that session's hunks into those regions will conflict. The
  bar's remaining 1,900 lines are untouched.
- **Load flakes during the gates:** DeckAutosave, Autocomplete, BibCards,
  TexViewer, the viewer auto-reload/font-size/GIF/Python/YAML files and
  MobileIndicator timed out (20 s) under load average 23–40 in a full run
  and passed when rerun in batches of two or three; none import the S6 files.
- The plan's line numbers for all three files had drifted (the pane map now
  starts near `CenterPanel.tsx:1176`, the tab map near `TabBar.tsx:1354`,
  `renderEntry` near `FileTree.tsx:3878` before the patch); the mechanisms
  were as described.

### Live click-through (user)
1. Open a project with many tabs (a dozen is enough): drag a split divider —
   panes follow the divider with no visible lag; every pane's content is
   live after the drag (nothing respawned, terminal scrollback intact).
2. Click the already-active tab in the focused subwindow: nothing changes
   (no flicker, no re-layout). Click the active tab of the *other* subwindow:
   the focus frame moves to it.
3. Start an agent turn in one tab and watch another tab's lamp — the busy
   ring appears/clears on the right tab only; hover a tab: the hover card
   opens, no other tab repaints.
4. On an agent tab with a schedule, hover ◷: the tooltip names the next
   occurrence (see Flagged if it is stale).
5. Files panel on a big folder: click "show more" twice, then move the
   mouse across rows and rest on one — the tooltip opens after the dwell and
   scrolling stays smooth; click a row (selected), Ctrl-click another; drag
   a file onto a folder; right-click a row — all as before. On a remote
   project the sync badges and the Run ▶ on a `.sh`/main `.py` still act.

### Review (S6 reviewer, 2026-10-08)
Range reviewed: `2a19c24c..HEAD` (45bcd8a9, cdd2a37f, 91e780de, plus the
first S6 reviewer's e10c5fe8, 3e067ec6, 8d274703). Two sessions: the first
was stopped after its PaneSlot work and the schedule fix; this one finished
`TabItem`/`FileRow`, rechecked those fixes and ran the gates. Nothing run
live.

**Bugs fixed**
- `e10c5fe8` (first reviewer) — `TabItem` cached the ◷ tooltip's next
  occurrence by the schedule list's identity, so once a slot passed with no
  republish (a skipped run) the title named the past slot; the bar's
  per-render computation never did. Hovering the indicator now recomputes
  when the shown slot is behind the clock (one comparison, no timer). Test:
  `TabBarItemMemo.test.tsx` "refreshes a passed occurrence when the indicator
  is hovered". Rechecked: the span's `title` beats the `.tab`'s fast-mode
  title, and a hover while the slot is still ahead renders nothing. The
  Flagged item above about a stale tooltip no longer applies.
- `3e067ec6` + `8d274703` (first reviewer) — not a code change: memo-key
  tests for `PaneSlot` (remote status flip to a *different* state, project
  record change, tab moved between groups, scope switch, popout detach +
  re-attach, `setActive` on the active tab of an unfocused group still
  moving focus), each asserting the one slot re-renders with the new answer
  and the root scope's sixty do not.
- `11bc2c3c` — e10c5fe8 put `scheduleEpoch` in the memo's deps, which the
  linter calls unnecessary (the body reads the clock, not the epoch): lint
  went 28 → 29 warnings. The dep is the point, so it stays with the same
  documented disable `useT` uses for `dictGen`. Gate: lint back to 28.

**Checked and sound**
- `TabItem` vs the old per-tab JSX: every attribute, class, handler and
  child is carried over; `isActive`/`editing`/`landing`/`isDragging`/`index`
  are props, so activation, inline rename (Enter/Escape/blur, `selectOnMount`
  now module-level and still one identity), the landing animation and the
  pointer drag all see current values. Every bar closure goes through
  `TabItemBar`; the forwarders read a ref refreshed in a deps-less
  `useLayoutEffect`, and none of the forwarded handlers
  (`onTabContextMenu`, `onTabPointerDown`, `commitRename`, hover, locality,
  `clearLanded`, `setActive`) depend on render-time state a commit could
  leave behind. Steering's `data-tab-index` and the drop slot are unchanged.
- Subscriptions: `useTabStateClass` reads the same three entries the old
  `tabStateClass` read, through the same pure `tabStateClassOf`;
  `tabStateClass` is now called only for `TabStackChip` members, and the
  bar's whole-map subscriptions fall back to constants exactly when no tab
  of the bar has a `stack` (no other bar code reads the maps). The children
  `TabItem` renders (`TabMarkBadge`, `TabSourceBadge`, `TabAgentModeMarks`,
  `TabLocalityBadge`, `TabTexLinkBadge`, `TabStatusMark`) take only props
  that cross the memo or subscribe themselves; `useT`/`useChordHint`
  re-render on language/dict/binding changes. Item props are stable
  (`computeHosts` is a store reference, `texPdfTabs` is `useShallow`'d).
- `FileRow` vs the old row JSX: classes, `data-entry-path`,
  `data-move-rel` followed by the `moveTargetAttrs` spread (the
  `FileMove.test.ts` tripwire), click/double-click/context menu, Ctrl-armed
  native drag vs pointer drag, tooltip dwell (`mouseLeave` takes no event,
  as `handleEntryMouseLeave` never did), sync slot (busy flags computed from
  the same `syncProgress`/`rel`), Run ▶ + right-click args (`runArgsByPath`
  read at click time), compile spinner, local-only tag, folder sizes and the
  scan-excluded note. `rel` now always computed changes nothing: every reader
  is still gated on `syncTracked` or `is_dir`. `remarkCount` reproduces the
  old `remarksEnabled && projectId && !e.is_dir` gate. Re-lists keep entry
  identity when unchanged (`fileEntriesEqual`), so the row memo survives the
  fs-change / poll refreshes. The new hooks sit above every early return
  (rules-of-hooks is a lint error, lint has 0).
- `PaneSlot` (spot-check after the first reviewer): the derivation is the
  old block verbatim (`localRunning` uses the cached `location`, same value);
  `remoteStatus.byHost[project]` is replaced on change, never mutated, so the
  `hostSsh` prop changes with a worker lamp. The `setActive` short-cut only
  skips a `writeScope` whose result would equal the current state.

**Gates (worktree, at 11bc2c3c)**
| Gate | Result |
|---|---|
| `npm run build` | clean (tsc + desktop + mobile bundles) |
| `npm test` | 741 files / 7583 tests: 7581 passed, 2 failed — both in `MobileHeldPromptStore.test.ts`, a date time-bomb (see Flagged), fails alone, file and module untouched by the range; S6 implementer had 7576, +7 from the review tests |
| `cargo test -q` | lib 3578 passed, 3 ignored; every other target green (no Rust in S6) |
| `npm run lint` | 0 errors, 28 warnings (pre-existing; was 29 before 11bc2c3c) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | clean |
| `git diff --check 2a19c24c..HEAD` | clean |

**Flagged for user**
- `MobileHeldPromptStore.test.ts` fails from 2026-10-07 on, independent of
  this run: its fixtures' `sentAt` is fixed at 2026-09-30T11:59:50Z and
  `heldPrompts.ts` drops prompts older than `MAX_AGE_MS` (7 days) against the
  real clock, so "keeps only held prompts, per tab" and "hands a late
  answer…" read back nothing. The test needs a faked clock (its unused
  `NOW` constant suggests that was the intent). The main checkout has
  uncommitted edits to this file — probably that fix; not touched here so
  the landing merge doesn't conflict.
- The comment above `tooltipTimer` in `FileTree.tsx` still says "the rows
  are not memoized"; the dwell reasoning holds (the tree still re-renders),
  but the sentence is now wrong. Comment-only.
- `TabAgentModeMarks` whole-map subscription stays as the implementer
  flagged (badge-only re-render in every tab on any agent's mode change).

## S7 — pollers, git dots, launch chain

*Written 2026-10-08 by the S7 implementer. Base `48b3b398`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `87b10d07` | §3.3 first three sites: header resources 2.5 s → 5 s (relaxed tree cache 4 s → 9 s); `ollama_is_installed` at mount + on reveal/overlay close, no timer; `mobile_host_status` as one refcounted store (`stores/mobileHostStatus.ts`) shared by `MobileIndicator` and every Files view |
| `ee376977` | §3.4 (+§7.4): full git reading on `fs-change` only in the Git view, pill-dot probe elsewhere, both through `lib/coalescedRun.ts` (≤ 1/s, never overlapping); `fs-change` payload = the folder as asked, FileTree/ProjectFilesView filter on it; `git_dirty_probe` reads unpushed off the `##` header; switcher timer shares the store's probe stamps |
| `d551f300` | §3.5: `load_side_panel_folder` chained onto `get_projects` inside the `Promise.all` with `root_work_dir`; no `backdrop-filter` on `.tab-bar` / `.subwindow-files` in the glass themes |

### What was built / choices made
- **§3.3 resources.** `RESOURCE_POLL_MS = 5_000` (still `saverInterval`, ×3
  quiesced). S1's relaxed descendant cache was sized for 2.5 s (4 s); at a 5 s
  poll it would never hit, so `CACHE_TTL_RELAXED` is now 9 s: every other
  reading skips the `/proc` walk. The GPU half was already cached 10 s off
  that path by S1 (and per S1's Flagged, the header never reached the fdinfo
  walk).
- **§3.3 Ollama.** `checkInstalled()` runs at mount, on each `reveal` and on
  the overlay's open→closed edge (the overlay's Ollama tab is where it gets
  installed), and is a no-op once `installed` is true. Trade-off: after an
  install from a tab, the header lamp appears on the next hover / overlay
  close instead of within 5 s.
- **§3.3 Mobile host.** `useMobileHostStatus(enabled)` retains/releases; one
  15 s interval + one window-focus listener while ≥ 1 surface retains; a
  plain refresh is skipped while one is in flight. The indicator's
  reconnect guard (`reconnectingRef` + request generation) moved into the
  store as `beginRestart`/`endRestart` + a request counter; `publish()`
  (pairing's fresh read) supersedes in-flight reads. Unlike `hostSessions`,
  the reading is dropped on the last release (each surface used to start
  from "no reading"; a stale `running` must not light a phone toggle).
  The indicator's action error is still cleared by each status read (an
  effect on `refreshing`), as before; a failed read shows the store's error.
- **§3.4 Files view.** The plan's "subscribe only while the git view/bar is
  rendered, otherwise set stale and refresh on show" taken as: the full
  reading (`git_status` + `git_unpushed_commits`, 5 spawns) follows
  `fs-change` only while `view === "git"` (the bar lives only there now);
  outside it the event runs `useGitDirtyStore.refresh` (one
  `git_dirty_probe`, deduped with the switcher's) and the Git button's flag
  is drawn from the pill-dot level (`dotFlagColor`) — this keeps the
  "pending git work visible from the Files view" behaviour
  `GitBarRefresh.test.tsx` locks in, at one spawn per second at most. Nested
  repos, remote projects, boxes or no dot reading fall back to the last
  counts. "Refresh on show" is the existing unconditional active/entry
  refresh, so no separate stale flag. A scope with no project (root) keeps
  the coalesced full reading. User actions (add/commit/push) keep the
  120 ms `refreshGit` debounce.
- **`coalescedRun`** (not a debounce): first trigger arms a 1 s timer,
  later ones are absorbed, a trigger during a run = one follow-up after it
  settles. A steady agent write stream therefore refreshes once a second
  instead of never (a trailing debounce would starve).
- **FileTree path filter.** The backend's `fs-change` payload was the
  *canonical* folder, which the frontend cannot compare with its own path
  (symlinks). `watch_dir` now emits the path as the frontend passed it (the
  state remembers that spelling; a same-dir re-watch with another spelling
  re-creates the watcher). A tree ignores events whose payload is not its
  `absDir`; `.git` events arrive under the same payload, so they still
  count. ProjectFilesView ignores payloads outside its `projectDir`.
- **Dots.** The dot probe already skipped `remote`/`tag` (earlier work);
  the remaining extra spawns were `rev-parse @{u}` + `log` for a clean tree.
  `GitStatus.upstream_ahead` (serde-skipped) carries the `##` header's
  `ahead` when the branch tracks a live upstream; `unpushed_count()` uses it
  and falls back to the namesake lookup only without one (or `[gone]`).
  Clean tracked tree: 3 spawns → 1. The headless phone dot uses the same
  helper. "Drive refresh from the `.git` watcher instead of the timer": the
  watcher drives the dot through the Files view (above); `gitDotProbedAt`
  (module map in `stores/gitDirty.ts`, stamped by `refresh` and `set`)
  replaces the switcher's private ref, so a watched project just refreshed
  is not probed again by the next tick. The 12 s/36 s timer stays as the
  backstop (the one watch slot is shared by every window, so "this project
  is watched" cannot be known reliably from one window).
- **§3.5 launch.** `load_side_panel_folder` needs the current project's
  `local_file`, so it cannot literally join the first `Promise.all`; it is
  chained on `get_projects` inside it (same "first current by position"
  pick as `activeId`). Startup waits for max(root chain, projects + folder)
  instead of the sum. `loaded` is still set once, with the folder, so the
  tree never opens at the root and then jumps.
- **§3.5 glass.** Only the filter is dropped; the translucent fills
  (`--glass-subheader`, `--glass-panel`) stay — beneath both is the shell's
  smooth ambient wash, which the blur barely changed (saturate 130–150 %
  is the visible part). `fillBrand` lazy fill skipped (plan: low value).

### Gotchas for later steps
- **S12 (`usePoll` sweep):** `stores/mobileHostStatus.ts`'s interval and
  `ProjectFilesView`'s Git-view poll are direct `setInterval`s, not yet
  quiesce-aware (the old ones weren't either). The Git-view poll now calls
  `full.request()`, so its effective cadence is 5 s + up to 1 s. Direct
  `setInterval(` lines in `src/` (non-test): 87 (base 89).
- **S11 (`proc_table`):** `debug_app_resource_usage` now leans on
  `CACHE_TTL_RELAXED` = 9 s; if the shared snapshot replaces the descendant
  cache, keep the header reading at most every other poll.
- `fs-change`'s payload is now the requested spelling. Anything new that
  listens must compare with the path it passed to `watch_dir`, not a
  canonical one. A window still running an older backend emits the
  canonical path: a tree whose `projectDir` is a symlink spelling would
  ignore every event until the backend is rebuilt (dev builds ship both
  halves together; hot reload into an old backend is the exposure).
- Tests driving `fs-change` must pass `{ payload: <dir> }` and wait past
  `GIT_WATCH_COALESCE_MS` (1 s) — see `GitBarRefresh.test.tsx`'s `fire()`.
- `useGitDirtyStore.set` now stamps `gitDotProbedAt`: only call it with a
  fresh reading.

### Gates (worktree)
| Gate | Result (with test counts) |
|---|---|
| `npm run build` | ok (tsc + both bundles) |
| `npm test` | 744 files / 7602 tests, 2 failing = the known `MobileHeldPromptStore.test.ts` date time-bomb (base 741 / 7583) |
| `cargo test -q` | lib 3580 passed, 3 ignored (base 3578 + 2); every other target green |
| `npm run lint` | 0 errors, 28 pre-existing warnings |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check` | clean |

`npm run backend:stale` not run: it measures the main checkout's running
window, which this worktree's backend edits (`commands/git.rs`,
`fs_watch.rs`, `sysstat.rs`, `debug.rs`, `headless.rs`) cannot reach until
landing + a dev build.

### Flagged for user
- **Git button flag outside the Git view now follows the pill dot** (one
  `git_dirty_probe`, ≤ 1/s) instead of a full five-spawn re-read 120 ms
  after every event. Same colours; for a nested repo the flag only updates
  on show / entering the Git view.
- **Ollama installed mid-session** shows on the next hover of the Models
  button or overlay close, not within 5 s.
- **Header resources** update every 5 s (was 2.5 s).
- **Glass themes:** tab bars and the docked file column lose their frost
  (saturation lift of the wash beneath); fills unchanged. Say if the look
  should be compensated with a more opaque fill.
- `fillBrand` lazy fill not done (plan said keep last or skip).

### Live click-through (user)
1. Header idle: `pidstat -p $(pgrep -f tabtivity | head -1) 5` — backend CPU
   lower than before; the CPU/RAM readout ticks every ~5 s.
2. With Ollama not installed: no `ollama` PATH probe every 5 s (e.g.
   `strace -f -e execve -p <pid>` quiet). Hover the Models button: menu as
   before.
3. Mobile on: open the side panel and a Files tab on a local project; the
   header phone lamp and the Files phone button agree; Reconnect in the
   header menu still waits through the restart and ends green.
4. Agent writing files in a local project, Files view open: no tree flicker,
   the Git button's flag turns red within ~1 s and the pill dot with it;
   `pgrep -c git` stays low (no spawn storm). Switch to the Git view: counts
   are current; let the agent commit — "Add (N)" goes away within ~1 s.
5. Two windows (popout) showing different folders: each tree updates only
   for its own folder.
6. Quit in a project whose side panel was in a subfolder; relaunch: the tree
   opens straight in that subfolder.
7. Theme `fancy_dark` / `light_lavender`: tab bars and the docked file
   column look as before minus the frost; scrolling a busy terminal beside
   them stays smooth.

### Review (S7 reviewer, 2026-10-08)
Range reviewed: `48b3b398..fe07922e` (87b10d07, ee376977, d551f300, handoff
fe07922e). Nothing run live.

**Bugs fixed**
- `3934cd7e` — `stores/mobileHostStatus.ts` skipped every plain refresh
  while *any* read was in flight, including one the last `release` (or
  `publish`, or `beginRestart`) had already superseded and whose answer
  would be dropped. A surface leaving and coming back inside that window —
  React StrictMode's mount → cleanup → mount (`bootstrap.tsx` wraps the app),
  a Files view flipping `active` — showed no reading for a whole 15 s poll
  (header lamp grey, Files phone toggle hidden). Now the skip applies only
  while the *newest* read is pending (`reading` set of request ids). Test:
  `MobileHostStatusShared.test.tsx` "a surface that leaves and returns while
  a read is in flight gets a fresh read" (fails without the fix).

**Checked and sound**
- `mobileHostStatus`: retain/release balanced through the one effect
  (`[enabled]` deps, cleanup = `release`); one interval + one focus listener
  per 0→1, both removed on 1→0; refs clamp at 0. The restart guard keeps the
  old semantics: `beginRestart` blocks plain reads and supersedes in-flight
  ones, `refresh(true)` bypasses the block, `endRestart` clears a
  `refreshing` no current read will clear. The indicator's
  clear-error-on-read moved to an effect on `refreshing` — same edges as the
  old in-`refresh` `setError(null)`. Local admin socket only, so the
  connected-gate invariant does not apply; Files views retain only while
  `active`.
- `coalescedRun`: no lost trailing run (a trigger during a run or a timer
  firing during one → exactly one follow-up after settle), never concurrent,
  sync throw and rejection both release `inFlight`, `cancel` kills the timer
  and the follow-up while a run in flight finishes harmlessly (its write is
  gated by `gitContextKeyRef`). A run that never settles would wedge it, but
  both callers end in backend calls with git timeouts.
- `fs-change` payload: only `FileTree` and `ProjectFilesView` listen (no Rust
  or phone listener). `FileTree` compares with the exact `absDir` it passed;
  `ProjectFilesView` accepts payloads under `projectDir` with either
  separator and a trailing-slash `projectDir`; Windows `C:\p/sub` spellings
  match. Remote projects never watch (`remote_target_for_dir` no-op, and the
  view's listener is local-only). Every surface derives `projectDir` the same
  way (`resolveProjectDirectory`), so the same folder is spelled the same.
- `git_dirty_probe` / `unpushed_count`: `run_git` is the hardened, hookless
  path. Header cases: no upstream (`main`), detached (`HEAD (no branch)`),
  `[gone]` → namesake fallback exactly as before; `[ahead N, behind M]` →
  N, the same set `git log @{u}..` counts (merges included); unborn branch
  with upstream → 0 either way; upstream on a local branch (`remote = .`) or
  another-named branch → same `@{u}` base. Porcelain v1 ignores
  `status.aheadBehind`; ref names cannot contain `[` or `..`.
- `gitDotProbedAt`: stamped only by a probe that actually starts or by
  `set` from a fresh, context-checked full reading (non-nested, no
  worktree). The watcher only stamps when it really probes, so a dot cannot
  go permanently stale: with no events the switcher's backstop resumes at
  its normal cadence.
- S1 relaxed cache 4 s → 9 s: `descendant_pids_relaxed` has one caller
  (`debug_app_resource_usage`); strict callers still filter at `CACHE_TTL`
  (1.5 s), the 9 s bound only widens the prune window.
- Launch chain: `root_work_dir` is a pure path join, so nothing needed it
  before `load_side_panel_folder`; the folder's project pick matches
  `activeId` (same sort, first `current`), a failed read degrades to no
  folder as before, `loaded` still set once with the folder.
- Glass: no other rule or test relied on the `.tab-bar` /
  `.subwindow-files` backdrop selectors; fills unchanged.
- The Files-view Git flag's dot fallback excludes nested repos, remote,
  boxes, and is never used in the Git view (where a selected worktree lives).

**Gates (worktree, at 3934cd7e)**
| Gate | Result |
|---|---|
| `npm run build` | ok (tsc + both bundles) |
| `npm test` | 744 files / 7603 tests, 2 failing = the known `MobileHeldPromptStore.test.ts` date time-bomb (S7: 7602 + 1 new) |
| `cargo test -q` | lib 3580 passed, 3 ignored; every other target green |
| `npm run lint` | 0 errors, 28 pre-existing warnings |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check` | clean |

**Flagged for user**
- Two trees active at once on the *same* folder spelled two ways (a
  symlinked project path and its real path) now re-create the one watcher
  for whichever asked last, and the other tree ignores its events (it used
  to re-list on every event). Every surface spells a project's folder the
  same way today, so this needs a hand-built path; not changed.
- A full Git-view reading that lands after a newer dot probe overwrites the
  dot and stamps it, so the next switcher tick skips it; the next
  `fs-change` or tick after that corrects it (pre-existing overwrite race,
  only the stamp is new).

## S8 — bundle + thin LTO

*Written 2026-10-08 by the S8 implementer (finished by a second implementer after the first one's session ended: LTO commit, measurements, gates). Base `c162de8d`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `2e570eab` | §6 Rollup warnings: the eight `await import()`s that split nothing (plugin-dialog, `boxes`, `stopProjectPrompt` in `stores/projects.ts`; projects/settings/remoteStatus/hpcHost/remoteHosts in `hpcGuard.ts`) made static; the build prints no "dynamically imported but also statically imported" warning |
| `e5c8a0bd` | §6 `TabPane`: calendar, browser, print manager, network/system/disk monitors, 3D projects view, skills library, prompt chart are `React.lazy` behind `LazyPane` (`.pane-loading` fallback); their other importers follow (calendar overlay, global machine monitor lazy-load the same chunks; `formatBytes`/`isPromptTargetTab` moved off the panes) |
| `42ae9aa1` | §6 `AppShell` & co.: Machines overlay, Remote machines, HPC wizard, Models overlay mounted lazily once their store flag opens (`LazyWhen`); How to start / remote-features prompt / lessons lazy; Settings dialog + project dialogs lazy in `ProjectSwitcher`; recap lazy inside `StatsRecapHost`; header Machines member lazy and mounted only while `machines_enabled`; `DetachedApp` lazy in `App` |
| `4273a1cc` | §6 `FileViewerPane`: GIF, ODT, media, sync/git merge views lazy (under the pane's existing Suspense); nested YAML tree/grid, bib cards, markdown graph, image annotator lazy with local Suspense |
| `f1c7281f` | §6 root `Cargo.toml`: `[profile.release] lto = "thin"` |

### What was built / choices made
- **Measured with a scratch Rollup report** (a `generateBundle` plugin in the
  scratchpad, not committed): per-chunk module sizes plus the static import
  graph, and a "retained size" pass (bytes that leave startup if a module's
  inbound static edges are cut) to pick cuts that actually move bytes. A
  lazy site only helps if *every* static importer in the startup graph goes
  too — several plan targets had a second importer (CalendarPane ← the
  calendar overlay; SystemMonitorPane ← the global machine monitor;
  NetworkTrafficPane ← StatsRecap's `formatBytes`; PromptChartTab ←
  AgentSchedulesView's `isPromptTargetTab`; SettingsSubPanels ← ModelsOverlay;
  MachinesIndicator ← StatusCluster + ExtendToRemoteDialog's `targetLabel`).
- **Bundle numbers** (`bootstrap-*.js`, raw, minified):

  | Step | bootstrap | JS chunks |
  |---|---|---|
  | base `c162de8d` | 3,973 kB (gz 1,149.5 kB) | 79 |
  | static imports | 3,971 kB | 79 |
  | TabPane split | 3,755 kB | 89 |
  | AppShell/Settings split | 3,397 kB | 104 |
  | viewer split | 3,319 kB (gz 974.3 kB) | 115 |

  −654 kB raw (−16.5 %), −175 kB gz (−15.2 %). The bootstrap chunk's only static import is the
  tiny `index-*.js` entry, so "initial JS" = bootstrap + 7 kB. **The plan's
  ~1.5 MB target is not reached and not reachable with §6's list**: what
  stays is the English dictionary (`lib/i18n.ts`, ~709 kB pre-minify), the
  xterm stack (xterm + webgl + canvas addons, ~490 kB), react-dom (~134 kB),
  `stores/tabs.ts`, `untested.ts` (kept on purpose, §6), and the always-
  visible shell (HeaderBar, ProjectPill, FileTree, ProjectFilesView,
  CenterPanel, TabBar, TerminalReaderView, MobileBridgeHost).
- **Rollup warnings.** Plan said 5; the build printed 8. All were in-bundle
  modules, so the fix is static imports. `hpcGuard`'s "cycle" comment was
  stale (no static path from any target back to it). `projects ↔ boxes`
  becomes a static cycle: safe, both sides touch each other only inside
  actions (verified: no module-scope use).
- **`TabPane` fallback.** The Suspense sits inside the host's `.center-pane`
  box, which is what carries `data-scope-key`/`data-tab-key` (drag ghost),
  the focus `onMouseDownCapture` and steering's lookups; no steering region
  lives inside a pane (regions are side panel, header, tab card, overlays,
  settings). `.pane-loading` only fills the box (`flex: 1 1 auto`).
- **Hosts gated, not always-mounted-lazy**: a host that renders null until a
  store flag is set gets an eager two-line wrapper in AppShell that reads the
  flag (from the store's own module) and mounts the lazy host only then —
  the mail/to-do pattern already there. DOM position unchanged (modal stacking
  is DOM order). Hosts with always-on work stay eager: TourHost (listens for
  `app:start-tour`; a lazy mount could miss an early event), RootOverlayHost
  (review refresh listener), CalendarOverlayHost (chrome eager, only its
  pane lazy), StatsRecapHost (event + daily check eager, recap lazy).
- **Machines header member**: rendered nothing while `machines_enabled` is
  off, so StatusCluster now mounts it only while on; unmounting clears its
  header report exactly as its `!enabled` branch did.
- **`DetachedApp` lazy in `App`**: none of the five modules only it reaches
  has module-scope side effects, so the main window loses nothing by not
  evaluating them. I did **not** lazy `AppShell` for popouts (would shrink a
  popout's startup by ~1/3 but make the main window's startup a two-hop
  waterfall and turn the bootstrap figure into a meaningless number) —
  flagged below.
- **TeX module not made dynamic.** `tex.ts` has 12 non-test importers (not 29)
  and `FileViewerPane` uses ~60 of its names synchronously across the editor
  (completions, ref-highlighting, click handlers, diagnostics; also generic
  helpers like `offsetToLineCol`), plus `FileTree` and the PDF viewer. A
  dynamic import would mean an async loader state threaded through all of
  them for ~66 kB pre-minify (~1.7 % of startup). Not done; flagged.
- **DiffView / CompareView / PresentationOverlay stay eager**: DiffView's row
  is imported by the Reader's changes view, CompareView by the text editor's
  compare mode, PresentationOverlay is mounted over every viewer.
- **Phone PWA**: `vite.mobile.config.ts` / `vite.pdf-frame.config.ts` build a
  separate entry; none of the split modules is in its graph. `npm run build`
  (which runs `mobile:build` = tsc + `mobile:bundle`) is green. pdf.js still
  loads only through `lib/viewers/pdfLoad.ts` (PdfView was already lazy;
  nothing here touches it).
- **Thin LTO**: measured with `cargo build --release --features custom-protocol`
  (the exact command `scripts/package-dev.sh` runs, so frozen dev builds
  **do** use the release profile and pay thin LTO on every post-commit
  build; CI's three `package*` jobs on push do too), separate target dir,
  `nice -n 10`, machine shared with other sessions:

  | | full build | incremental (touch `lib.rs`) | binary |
  |---|---|---|---|
  | no LTO (base) | 494 s | 409 s | 111,106,960 B |
  | `lto = "thin"` | 643 s (+30 %) | 453 s (+11 %) | 113,888,008 B (+2.5 %) |

  The binary got **bigger**, not smaller, and builds are slower. The point
  of thin LTO is cross-crate inlining (runtime / startup speed), which was
  **not measured** here — plan §6 says "measure the gain against §1 before
  keeping it", so that measurement is owed (perf-numbers after a dev build
  with and without the profile). Kept in its own commit so reverting it is
  one `git revert`. Debug/test/clippy builds are unaffected (dev profile).

### Gotchas for later steps
- **A new importer of a split module pulls its chunk back into startup**
  (Rollup keeps a module in the chunk of any static importer). Check with
  `npm run build`: the chunk must still be listed, and a "dynamically imported
  but also statically imported" warning means a split stopped working. Rows
  in `filemap_frontend.md` (`TabPane`, `AppShell`, `FileViewerPane`) say so.
- **Tests: a `findBy*` inside `act(async () => …)` never sees lazily loaded
  content** — React holds the Suspense retry until the act scope ends, so the
  query times out. Await the lazy content outside `act`, then act on it
  (`YamlViewer.test.tsx` `renderCards`). First import after `vi.resetModules`
  is a fresh transform: give it a longer `findBy` timeout under load.
- **S9 (`SleepingPane`)**: `TabPane`'s lazy kinds wake through `LazyPane`; a
  slept-and-woken calendar/monitor pane re-renders from the module cache (no
  second fetch). Keep `SleepingPane` outside `LazyPane` (in `PaneSlot`) so a
  sleeping slot does not trigger a chunk load.
- `StatusCluster` tests must set `machines_enabled: true` to see the Machines
  member, and await it.
- New gated overlay host → add it to AppShell's `LazyWhen` wrappers only if
  its open flag lives in a module other than the host's own.

### Gates (worktree)
| Gate | Result (with test counts) |
|---|---|
| `npm run build` | ok (tsc + both bundles); `bootstrap-*.js` 3,319.15 kB / gz 974.30 kB, 115 JS chunks; 0 "dynamically imported but also statically imported" warnings |
| `npm test` | 745 files / 7607 tests, 2 failing = the known `MobileHeldPromptStore.test.ts` date time-bomb (S7 review 744 / 7603) |
| `cargo test -q` | lib 3580 passed, 3 ignored (unchanged); every other target green (3748 total) |
| `npm run lint` | 0 errors, 28 pre-existing warnings |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check c162de8d HEAD` | clean |

`npm run backend:stale` not run: S8's only backend change is the cargo
profile, which affects release builds only and nothing in the running window.
The scratch release target dir (`target/s8-release`) was deleted.

### Flagged for user
- **Thin LTO made the binary 2.5 % bigger and builds 11–30 % slower**
  (table above), with no measured runtime gain yet. Every post-commit frozen
  dev build and every CI `package*` job pays it. Decide after a startup /
  §1 measurement whether to keep `f1c7281f` or revert it.
- **The ~1.5 MB bootstrap target is not reachable with §6's list**: after
  the splits the bootstrap is 3,319 kB raw / 974 kB gz (−16.5 % / −15 %).
  What remains is mostly the English dictionary, the xterm stack, react-dom,
  `stores/tabs.ts`, `untested.ts` (kept on purpose) and the always-visible
  shell. Going further needs a different lever (e.g. a lazily loaded or
  split English dictionary), not more lazy panes.
- **`AppShell` is not lazy for popouts**: a popout window still evaluates the
  whole main shell's chunk. Making it lazy would cut a popout's startup by
  ~1/3 but turn the main window's startup into a two-hop waterfall. Say if
  popout startup matters more.
- **TeX module (`lib/tex.ts`) not made dynamic**: ~60 synchronous uses across
  the editor, `FileTree` and the PDF viewer for ~66 kB pre-minify (~1.7 % of
  startup); an async loader through all of them was not worth it.
- First open of each split pane / overlay / viewer now shows a brief
  `.pane-loading` box (one chunk fetch from the local bundle, then cached).

### Live click-through (user)
On a frozen dev build of this branch (after landing). Each item: it opens
as before; at most a blink of the loading box on the very first open, never
a blank or broken pane; devtools console free of chunk-load errors.
1. Launch: main window comes up as before (header, file tree, terminal tabs).
2. Open one tab of each lazily loaded pane kind: calendar, browser, print
   manager, network monitor, system monitor, disk monitor, 3D projects view,
   skills library, prompt chart. Close and reopen one: no loading box the
   second time.
3. Overlays: Machines, Remote machines, HPC wizard, Models; the calendar
   overlay; the stats recap; How to start / lessons pages. Turn the Machines
   feature off and on in Settings: the header Machines member disappears and
   comes back.
4. Settings dialog from the project switcher, plus a project dialog (new /
   edit project).
5. Viewers in a Files tab: a GIF, an `.odt`, an audio/video file, a sync or
   git merge view, a YAML file in tree and grid mode, a `.bib` in card view,
   the markdown graph, the image annotator. Switching into each nested mode
   must not blank the editor.
6. Pop a tab out into its own window (and one root subwindow): the popout
   opens and shows its tab; closing it returns the tab.
7. Optional (LTO): compare startup time and idle CPU of this build with the
   previous dev build.

### Review (S8 reviewer, 2026-10-08)
Range reviewed: `c162de8d..6ce56f89` (2e570eab, e5c8a0bd, 42ae9aa1,
4273a1cc, f1c7281f, handoff 6ce56f89). Nothing run live.

**Bugs fixed**
- None. No confirmed bug in the range, so no code commit.

**Checked and sound**
- Static cycles (2e570eab). `projects ↔ boxes`: every use of the other side
  sits inside a function or action (no column-0 use anywhere of
  `useBoxesStore`, and boxes' other exports are hoisted function
  declarations or re-exports that resolve to `ptyId`/`tabs` directly).
  `projects.ts` imports `./tabs` (line 42) before `./boxes` (line 54), so
  when projects evaluates first, boxes' own deps are already done and its
  body (a `create(...)`) touches nothing across the cycle; the
  boxes-first order existed before S8. `hpcGuard`: a static-import graph
  walk finds no path from projects, settings, remoteStatus, hpcHost or
  remoteHosts back to it, and its only module-scope statement is
  `envName(...)` from `brand`. The phone and pdf-frame bundles import
  neither store nor `hpcGuard`.
- What left the startup graph. A static-import closure from
  `main.tsx`/`bootstrap.tsx` at `c162de8d` against HEAD: 88 modules left
  startup. None has a module-scope side effect (no column-0 call,
  `listen`, `addEventListener` or `.subscribe`); every Tauri or window
  listener in them is in an effect of a component that mounted only while
  shown before S8 too. The listeners for `app:open-settings`,
  `OPEN_PROJECT_DIALOG_EVENT`, `OPEN_STATS_EVENT` and
  `OVERLAY_AGENT_EVENT` live in hosts that stayed eager (ProjectSwitcher,
  StatsRecapHost, the calendar overlay chrome via `useOverlayAgent`).
- `LazyWhen` hosts. Each wrapper's flag is the host's own gate or a looser
  one (Remote machines: `!!projectId` against the host's
  `projectId && project.remote`). Every hand-off into them is store state
  (`pendingDrop`, overlay `section`, wizard `open`), read on mount, not an
  event. No host reset or persisted anything on mount.
- Machines header member. Unmounting runs `useHeaderStatusReport`'s
  cleanup (`report("machines", null)`), the same thing the old `!enabled`
  branch published. Turning it on mounts it and runs `load()`, the same
  thing the `[load, enabled]` effect did. The overlay host keeps its own
  `enabled` gate inside `MachinesSurface`.
- `DetachedApp` lazy: `setDetachedWindowContext` still runs in
  DetachedApp's render, before any popout effect. The seed is pulled: the
  request is emitted only after the listener is registered, and it
  retries. None of the five popout-only modules has module-scope effects,
  and the startup modules' module-scope subscriptions (settings class
  toggle, activity `script-finished`, overlayAgent and agentModels
  subscribers) don't route through the detached context.
- Suspense placement. Every lazy pane in `TabPane` has its own `LazyPane`
  boundary, so a suspend never hides a sibling terminal. The calendar
  overlay's boundary wraps only the pane: the docked agent column is a
  sibling outside it. FileViewerPane's top-level lazy viewers are each the
  whole `view`. Its nested ones (tree, grid, cards, graph, annotator) each
  have a local boundary, and no other site renders a newly lazy viewer.
  Fallbacks are either empty (`.pane-loading`, `null`) or
  `t("common.loading")`; the portaled ones (GlobalMachineMonitor,
  Settings, project dialogs) have no text, so they need no colour.
  `PaneVisibleContext` and `visible` props pass through unchanged.
- Moved helpers. `lib/formatBytes`, `promptTarget.isPromptTargetTab` and
  `lib/remote/machineLabel.targetLabel` are byte-identical to the old
  bodies. Every importer (tests included) uses the new module or the kept
  re-export.
- Steering into the lazy Settings: `placeCursorSoon` retries for about 1 s
  (20 × 50 ms). Tours poll for their anchors (`ANCHOR_WAIT_MS`).
- `Cargo.toml`: `[profile.release] lto = "thin"` is in the workspace root
  (members `src-tauri`; the patched `tauri-runtime-wry` is excluded but is
  built as part of this workspace's graph). `src-tauri/Cargo.toml` has no
  `[profile]`, and there is no `panic = "abort"` and no `codegen-units`.

**Gates (worktree, at 6ce56f89; review adds only this section)**
| Gate | Result |
|---|---|
| `npm run build` | ok (tsc + both bundles); `bootstrap-*.js` 3,319.15 kB / gz 974.30 kB; no "dynamically imported but also statically imported" warning |
| `npm test` | 745 files / 7607 tests, 2 failing = the known `MobileHeldPromptStore.test.ts` date time-bomb |
| `cargo test -q` | lib 3580 passed, 3 ignored; every other target green |
| `npm run lint` | 0 errors, 28 pre-existing warnings |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check c162de8d HEAD` | clean |

**Flagged for user**
- Turning Machines off (`machines_enabled`) while a Machines "sign in in a
  terminal" add or edit is still waiting now unmounts the menu, which
  clears that poll (`clearAddPoll`/`clearEditPoll`) and the half-filled
  form. Before S8 the hidden menu stayed mounted and would still adopt the
  login. Not changed: this only happens if you switch the feature off
  in the middle of adding a machine.
  **Fixed afterwards at the user's request** (`bd8004f3`, cherry-picked from
  `7453933c`): `StatusCluster` keeps the member mounted from its first
  switch-on, so its own `!enabled` branch handles "off" again and the poll
  and form survive; regression test in `StatusCluster.test.tsx`.
- Steering's `,` → Settings on the very first open now waits for a chunk.
  If parsing it takes more than about 1 s (heavy machine load), the cursor
  isn't placed until the next steering key. Not observed; not changed.
- The S8 implementer's thin-LTO numbers (+2.5 % binary, +11–30 % build
  time, runtime gain not measured) are still the open decision on
  `f1c7281f`.

## S9 — sleeping tabs I

*Written 2026-10-08 by the S9 implementer. Base `3cb56a8c`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `6dbbafed` | §5.3 pane layer + viewer kinds + setting: `PaneSlot` renders the new `SleepingPane` instead of `TabPane` for a hidden viewer tab after the "Unload hidden tabs after" delay (Settings → Performance, `sleep_tabs_after_min`, default 10 min, Never = 0; named Rust field + round-trip test); pane holds (`PaneSleepHoldContext`/`usePaneSleepHold`) from `useUnsavedWork`, the text buffer, TeX compile, `PdfView` (marks/page edits/Submit/build) and playing media; i18n (en/de/es/fr/it), `UntestedTag` row `settings.sleepTabs`, filemap rows |
| `b1761c56` | §4.5 stub: `CenterPanel` passes `inPopout` (one `Set` over `detachedGroupsByScope`); a sleepable viewer a popout shows renders `SleepingPane` in the main window at once (never mounted on a restore) unless its main copy holds unsaved work |

### What was built / choices made
- **Where it sleeps.** Exactly the S6 swap point: inside `PaneSlot`, after
  the hooks and the Mobile first-seen stamp (moved above the branch, as S6
  asked), before the derivation — a sleeping slot renders one
  `<div class="sleeping-pane" data-sleeping="<kind>" aria-hidden>`. The
  layer's `.center-pane` box (steering region/pane class, `data-tab-key` for
  the drag ghost, `onMouseDownCapture` focus) is untouched, and
  `SleepingPane` sits outside `LazyPane` (S8). The store is never written:
  sleep is a render decision, so `tabsByScope`/`layoutByScope` keep identity
  (tested).
- **Timer: per slot, one-shot, not a 30 s layer tick.** The plan sketched
  `hiddenSince` + a 30 s interval in the layer; S3's gotcha said reuse
  `useSleepWhenHidden` as is, and S6's said pass scalars, never a Map of
  sleep states. So each sleepable slot runs `useSleepWhenHidden({hidden:
  sleepable && !visible, afterMs, hold})`: one `setTimeout` per *hidden
  viewer* slot, armed on hide, cleared on show/hold/unmount, none for
  terminal kinds or shown panes, none left once asleep (tested:
  `getTimerCount() === 0`). No interval anywhere. Waking is the same render
  that shows the pane (`asleep && hidden`), so focus and keyboard steering
  wake through `visible` (`focused` implies `visible` here).
- **Sleepable kinds (`isSleepableTab`, `lib/sleepWhenHidden.ts`):** `embed`
  with a `viewer` (every `FileViewerPane` viewer — PDF, text/code, markdown,
  TeX workspace, deck, YAML, media, …) and `projectfiles` (folder on
  `TabEntry.folder`, source choice by `viewerId`). **Not:** terminal kinds
  (S10), a viewer-less `embed` (its mount opens the file in an external app —
  a wake would open it again), the plain `files` browser (its folder lives in
  `FileBrowser` component state — it would come back at the root), nor
  browser / calendar / monitors / printing / skills / prompt chart / 3D
  (component state not on the tab; see Flagged).
- **Holds.** `PaneSlot` provides a reporter (`PaneSleepHoldContext`); any
  component in the pane calls `usePaneSleepHold(held)` with its own token
  (holds lift independently; unmount releases). Wired: `useUnsavedWork`
  (so PDF page edits, `PdfNoteLayer`, `DeckView`, `CompareView` hold for
  free), `useEditableFile` (`isDirty || saving` — the text/code/markdown/
  YAML/bib buffer), `TexView` (`compiling`), `PdfView` (`held || compiling`
  — unsent/unsaved marks, Submit in flight, page edits, a build of the
  file), `MediaView` (playing — new `onPlay/onPause/onEnded`). A hold cancels
  the countdown; lifting it while hidden restarts the full delay (tested).
  Outside `PaneSlot` (popouts, side panel, root console) there is no
  provider and a hold is a no-op.
- **Composition with S3.** A `PdfView` inside a sleeping pane is simply
  unmounted (its 5 min timer never fires); one in an awake-but-hidden pane
  still sleeps its canvas after 5 min. The viewer's unmount flushes its
  staged position (`useViewerState` unmount flush), the wake mount seeds from
  stage-then-store — the integration test (`PdfPaneSleep.test.tsx`, real
  `PaneSlot → TabPane → FileViewerPane → PdfView`) scrolls to 900 at 150 %,
  sleeps the pane, sees the document destroyed and `viewerState.scrollTop
  === 900` in the store, wakes, and lands at 900 / 150 %.
- **§4.5 popout stub.** For a viewer tab in a popout the main window's pane
  is a hidden duplicate: it renders `SleepingPane` at once (`inPopout &&
  !held`) — on a restore with popouts it is never mounted, so no second
  `readFileBytes`/worker document. A main copy that holds unsaved work at
  detach time stays mounted until that clears. Docking back mounts it from
  `viewerState`, which carries the popout's staged position (so the S3
  reviewer's #231 note — main viewer keeps its pre-detach scroll — no longer
  applies to sleepable viewers).
- **Setting.** `sleep_tabs_after_min?: number` (TS) / `Option<u32>` (Rust,
  named field, `skip_serializing_if`, round-trip test for absent/0/30).
  Read only through `sleepTabsAfterMs` (absent/negative/NaN → 10 min, 0 →
  null = off). Dropdown: Never / 5 / 10 / 30 / 60 min; a hand-edited other
  value still works. "Never" also turns the popout stub off (one switch to
  back out of the feature). `CenterPanel` folds it into one scalar prop.

### Gotchas for later steps
- **S10 (terminal kinds):** extend `isSleepableTab` only together with the
  no-kill mount — today `TerminalView` kills its PTY on unmount, so letting
  a terminal kind through `isSleepableTab` before S10's `persistOnUnmount`-
  from-the-start change would kill PTYs. Keep terminal kinds **out of the
  `inPopout` immediate stub** forever: the main window's `TerminalView` is the
  PTY owner a popout attaches to. Host sessions and a key the overlay dock
  draws (`overlayAgentShown` in `CenterPanel`) must never sleep: either
  exclude them in the predicate (pass a scalar like `dockShown`) or report a
  hold. Closing an *asleep* terminal tab needs the explicit `pty_kill`
  (no view exists) — the slot knows it is asleep only in render; the close
  path in `stores/tabs.ts` will need its own answer (e.g. a module-level
  `Set` of asleep PTY ids maintained by `PaneSlot` effects).
- **Derivation on wake:** a sleeping slot skips the derivation; on wake it
  re-runs from the same props, so `tmuxSession`/`sandbox`/`terminalCwd` come
  back identical (pure function of props + the first-seen Map, whose stamp is
  written before the branch). S10 can rely on that.
- **The hold seam is general:** anything new inside a pane that must not be
  unmounted (a long-running viewer job, an unsent form) calls
  `usePaneSleepHold(cond)`. `useUnsavedWork` already reports, so registering
  unsaved work is enough for most.
- **Tests:** `SleepingTabs.test.tsx` mocks `TabPane` with a stand-in that
  counts mounts/unmounts and raises a hold from a module `Set` — use fake
  timers *before* `render` (the countdown starts at mount). `PdfPaneSleep`
  needs a `getContext` Proxy (the presentation overlay's canvas calls
  `clearRect`).

### Gates (worktree, at b1761c56)
| Gate | Result (with test counts) |
|---|---|
| `npm run build` | ok (tsc + both bundles); `bootstrap-*.js` 3,321.36 kB / gz 975.00 kB (S8 3,319.15 kB) |
| `npm test` | 747 files / 7619 tests (S8 745 / 7607; +2 files, +12 tests); 3 failed: the 2 known `MobileHeldPromptStore` date time-bomb + `MobileIndicator` "lists paired devices…" under load average 39 — 5/5 alone |
| `cargo test -q` | lib 3581 passed, 3 ignored (S8 3580, +1 round-trip test); every other target green |
| `npm run lint` | 0 errors, 28 warnings (unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check 3cb56a8c HEAD` | clean |

`src-tauri/` changed (the settings field only): run `npm run backend:stale`
after landing. A running older backend still round-trips the key (it rides
in `Settings.extra`), so nothing breaks before a rebuild.

### Flagged for user
- **Which kinds sleep.** Only file viewers and Files (Project) tabs. The
  plain Files browser, browser, calendar, monitors, print manager, skills,
  prompt chart and 3D view keep state that is not on the tab (browsed folder,
  page/scroll, monitor history) and stay mounted; say if any should sleep
  (each needs its state moved onto the `TabEntry` first).
- **What a wake does not bring back:** the position (scroll, zoom, page,
  folds, TeX active file) comes back via `viewerState`; transient state that
  was never persisted does not — a clean editor's undo history (autosave
  users: Ctrl+Z after coming back to a tab hidden ≥ 10 min has nothing to
  undo), a text selection, an open find bar, a paused video's playhead. Only
  after the delay, never for unsaved work.
- **Plan wording:** §5.3 says "never sleep … the tab a popout mirrors" while
  §4.5 says render a stub in the main window for a popped-out PDF. Built per
  §4.5 for viewer kinds (the main copy is the redundant one; unsaved work
  still holds it). The "never sleep" rule stays true for terminal kinds (S10).
- **"Never" disables the §4.5 stub too** (one switch to back out); say if the
  popout stub should be unconditional.
- **Scopes not shown** sleep their viewers by the same per-tab timer (every
  tab of a hidden scope is hidden), not by a separate scope-level pass.
- A popped-out TeX workspace's main copy is stubbed; its sub-pane positions
  (`<key>#<path>`) were never persisted (pre-existing, S3 review), so a
  dock-back opens the workspace's PDF centre at its default position.

### Live click-through (user)
On a frozen dev build of this branch (after landing). To see it quickly set
Settings → Performance → "Unload hidden tabs after" → 5 min.
1. Settings → Performance: the new row shows "10 min" on a profile that never
   set it, with the untested pill; pick 5 min, reopen Settings: still 5 min.
2. Open a long PDF, zoom to 150 %, scroll to page 20; open a markdown file
   and scroll it; open a Files (Project) tab on a subfolder. Switch each
   group to a terminal tab and wait > 5 min. Switch back to each: the PDF is
   at page 20 / 150 % (brief reload), the markdown at its scroll, the Files
   tab on its subfolder. A terminal/agent tab hidden as long is untouched
   (scrollback, running process).
3. Type into a text file with autosave off, hide it > 5 min, come back: the
   unsaved text is still there. Same for a PDF with unsent markup.
4. Start an audio file, switch tabs, wait > 5 min: it keeps playing.
5. Pop a PDF tab out into its own window: it opens there as before; dock it
   back: the main window shows it at the popout's page.
6. Keyboard steering (Shift+Space) onto a tab card of a long-hidden viewer
   and activate it: it opens and shows its content.
7. Settings → "Never": nothing unloads any more.

### Review (S9 reviewer, 2026-10-08)
Range reviewed: `3cb56a8c..bdc494a4` (6dbbafed, b1761c56, handoff 44d4f721;
plus the S8 follow-up bd8004f3 and its note bdc494a4). Nothing run live.

**Bugs fixed** (each with a regression test that fails without the fix)
- `96397d6d` — a Files (Project) tab with its **commit box open** slept
  after the delay and dropped the message: `commitMsg` (the user's edited
  text) lives only in `ProjectFilesView` state. Now
  `usePaneSleepHold(commitMsg !== null || gitBusy)`; no-op in the side
  panel (no provider). Test `git/GitCommitSleepHold.test.tsx`.
- `69eef2a4` — an image tab left **mid-annotation** slept and lost the
  drawing (strokes live only on `ImageAnnotator`'s canvas, never registered
  as unsaved work). The open annotator now holds the pane; Save/Close
  (unmount) releases it. Test `viewers/ImageAnnotatorSleepHold.test.tsx`.
- `0cd729e0` — a deck **presenting** could be slept: `DeckPresenter` is
  portaled into `#root`, so the deck tab can be hidden under a running talk
  (a project switch, an agent opening a file in that group). After the delay
  the presenter unmounted mid-talk and, since its unmount does not close the
  audience window, left a slide on the projector. `usePaneSleepHold(presenting)`
  in `DeckView`. Test `deck/DeckPresentingSleepHold.test.tsx`.

**Checked and sound**
- Holds: `useUnsavedWork` (PDF marks/page edits, `PdfNoteLayer`, `DeckView`
  edits, `CompareView` decisions — the only `useUnsavedWork` callers),
  `useEditableFile` (`isDirty || saving`; every text/markdown/code/YAML/bib/
  table buffer goes through it; `TableView` sheets are read-only), `TexView`
  `compiling`, `PdfView` `held || compiling`, `MediaView` play/pause/ended.
  Each hook's effect releases on lift and on unmount; tokens are per caller.
  A hold raised while asleep is impossible: the pane's children are
  unmounted. YAML/table cell buffers commit on blur (no hold needed).
- `useSleepWhenHidden` in `PaneSlot`: one timer per hidden sleepable slot,
  cleared on show, hold, unmount and `afterMs` change; a setting change
  re-arms the full delay; Never (`null`) makes `hidden` false, so every
  asleep slot wakes (mounts hidden) and no timer is left. `asleep && hidden`
  wakes in the render `visible` flips; `focused` implies `visible`.
- `PaneSlot` memo: the two new props are scalars (`sleepAfterMs` from a
  primitive selector, `inPopout` a boolean from a `Set` memoised on
  `detachedGroupsByScope`, which CenterPanel already subscribed to for the
  current scope). Mobile first-seen stamp sits above the sleep branch.
- `.center-pane` box (steering region, `data-tab-key`, focus capture,
  `PaneVisibleContext` inside `TabPane`) untouched; the drag ghost only
  clones the visible pane, which is never asleep.
- Wake path: SyncTeX reverse search and `FileTreeSearch` go through
  `useEditorJumpStore` (read on mount), forward search through the stored
  reveal (S3), so a sleeping target still lands. Popout stub: `inPopout &&
  !held`; dock-back, `recoverDetachedGroup` (popout that never came up or was
  killed) and `hideDetachedGroup` all drop the key from
  `detachedGroupsByScope`, so the main copy wakes/re-arms normally; a
  Wayland scope-out keeps the record while the scope is hidden (stub
  harmless, its panes are hidden anyway).
- Terminal kinds: `isSleepableTab` admits only `embed`+`viewer` and
  `projectfiles`; no `FileViewerPane`/files component mounts a PTY; the
  popout stub is gated by the same predicate.
- Rust: `Option<u32>`, `serde(default, skip_serializing_if)`, named field
  (not `extra`) like the sibling `mail_check_interval_min`; snake_case key
  matches the TS `Settings` type; no Python-era key exists. i18n: en + all
  four maintained locales; `untested.ts` row + pill on the label.
- bd8004f3 (Machines): `useState(machinesEnabled)` + set-during-render latch
  only ever turns on; `MachinesIndicator`'s own `!enabled` branch returns
  null and its report is `null` while off; its test drives on→off→on and
  sees one mount, no unmount.

**Gates (worktree, at 0cd729e0)**
| Gate | Result |
|---|---|
| `npm run build` | ok (tsc + both bundles); `bootstrap-*.js` 3,321.42 kB / gz 975.05 kB |
| `npm test` | 750 files / 7623 tests (+3 files, +3 tests); 3 failed: the 2 known `MobileHeldPromptStore` date time-bomb + `MobileIndicator` "lists paired devices…" at load ≈ 35 — 3/3 alone |
| `cargo test -q` | lib 3581 passed, 3 ignored; every other target green |
| `npm run lint` | 0 errors, 28 warnings (unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check 3cb56a8c HEAD` | clean |

**Flagged for user**
- A narrow race, not fixed: if a hold is raised in a hidden pane in the same
  few milliseconds its sleep timer fires, both state updates can land in one
  render and the pane sleeps with the hold up. Only a hold that can rise
  while hidden can hit it (a TeX build of a hidden PDF starting); none of
  the data-holding sources (unsaved edits/marks) can become dirty while
  hidden, and a PDF reloads on wake anyway.
- More component-only state a wake does not bring back (add to the
  implementer's list): the PDF/viewer **presentation marker** strokes
  (`PresentationOverlay`, session-only by design), an open SQLite query, a
  `ProjectFilesView` dialog or sort order. Say if any of these should hold.
- `DeckPresenter` does not close its audience window on unmount (only via
  Exit). With the hold the sleep path no longer reaches it; closing the deck
  tab mid-talk still would (pre-existing).
- The settings help text says "Terminals and agents are never unloaded";
  S10 must reword it when terminal kinds start sleeping.

## S10 — sleeping tabs II

*Written 2026-10-08 by the S10 implementer. Base `40738fea`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `300c8d76` | §5.3 scrollback cap (backend): `pty_remove_view` takes `sleeping`; a sleeping route keeps a 1 MB catch-up tail (`ROUTE_SLEEP_SCROLLBACK_CAP`, was 256 KB) and outlives its spawn's end (`ended`); `pty_scrollback` `wake` returns the tail cut at its last full clear (`trim_replay`), with `exited`, and ends the sleep; `pty_kill` forgets a sleeping route (`route_forget_sleep`); 5 route tests |
| `45ba7dd8` | §5.3 no-kill mount + attach wake (`TerminalView`): new `lib/terminal/sleepingPtys` registry and `lib/terminal/terminalSpawn` (`tabTerminalSpawn` mapping shared with `TabPane`, `terminalSpawnKey`); an unmount of a PTY marked asleep parks instead of `pty_kill` (plus a scheduled-input stand-in); a mount finding it parked under the same key attaches; `TerminalSleepWake.test.tsx` (9) |
| `4df49caa` | §5.3 kill on close + dock view (`PaneSlot`/`CenterPanel`): terminal kinds sleep (`isSleepableTerminalTab`), marked in render; the slot's unmount kills an asleep PTY; spawn key = sleep `identity` (a change wakes); Host sessions, popouts and root tabs drawn by the console/dock never sleep; help text reworded (en/de/es/fr/it); `settings.sleepTabs` untested row extended; `SleepingTabs` +6 tests |
| `16b40766` | Fix found while testing: a pane woken while still hidden got the hidden-spell buffer replayed on first show on top of the wake tail (same output twice) — the wake read drops the superseded `pending` when it is the route's only view; route test |

### What was built / choices made
- **No "no-kill flag from the start".** The plan's `persistOnUnmount`-at-mount
  would also stop an *awake* close from killing. Instead a module registry
  (`sleepingPtys`): `PaneSlot` marks `<scope>:<key>` asleep in the render that
  swaps in `SleepingPane` (before the commit, like the Mobile first-seen
  stamp), so the `TerminalView` unmounting in that commit sees it and parks
  (`parkPty`: spawn key, terminal-ready seen, first output, settled) instead
  of `pty_kill`/`clearTabTitle`; its `pty_remove_view` says `sleeping`.
  Nothing in `TerminalView`'s spawn deps changed, so no visibility change can
  kill or respawn.
- **Wake = the existing attach path, as owner.** The spawn effect peeks the
  registry at setup; parked under an equal `terminalSpawnKey` →
  `historyPending`, no `launchName`/held input, no silent-start timer,
  `initialInputSent`, refs restored from the parked state. The entry is
  *taken* only in `setupAndSpawn` (after the microtask), so Strict Mode's
  synthetic cleanup still sees it parked and neither kills nor parks. Then:
  register view → `pty_scrollback {wake:true}` → write; `exited` appends
  `[process exited]` (the plan's "AppShell window-wide exit listener" does
  not exist — nothing else would ever say it). A parked PTY under a
  *different* key (relaunched/container toggled while asleep) is killed
  (`killAsleepPty`) and the mount spawns — what the effect re-running would
  have done.
- **Spawn identity, one mapping.** `tabTerminalSpawn(tab, scope, derived)`
  is now what `TabPane` spreads into `TerminalView`; `PaneSlot` hashes the
  same object (+ `holdRemoteTerminal`) as `useSleepWhenHidden`'s new
  `identity`: a change while asleep wakes the slot in that render (relaunch,
  container/tmux toggle, the host pool dropping into the remote hold — the
  hold then kills the parked PTY as the view leaving for it did). The
  derivation in `PaneSlot` therefore runs before the sleep branch (only on a
  slot re-render; S9 skipped it for asleep slots).
- **Close.** `PaneSlot`'s unmount effect calls `killAsleepPty` (no-op when
  awake): closing, closing the group/all, unloading the scope — every path
  that unmounts the slot, exactly where `TerminalView`'s unmount used to kill.
  Not in `stores/tabs.ts`: one place covers every close path.
- **Owner duties while asleep.** The scheduled-input registration (scheduler,
  auto-continue, steering's agent prompt, phone held prompts) is re-registered
  by the parking view as a stand-in (`ready` = was ready + quiet ≥ 1.2 s by
  the digest stamp, `bracketedPaste` as last parsed); the wake's own
  registration replaces it, `killAsleepPty` drops it.
- **Dock view / never sleep.** Views are per-viewer-id in the router, so the
  main pane's leaving never silences another; still, per S9/plan, a terminal
  never sleeps while a popout, the root console (all root tabs) or an
  overlay's docked column (that key) draws it (`drawnElsewhere`, a boolean
  prop), nor a Host session. The §4.5 immediate popout stub stays viewer-only.
- **Backend.** `asleep` set only by a `sleeping` remove-view; cleared by the
  wake read, `pty_kill`, or a respawn from a registered pane. Exit while
  asleep keeps the route (`seq = 0`, `ended`); the usual `seq == 0 && no
  viewers` collection skips sleeping routes. The wake tail is cut by
  `trim_replay` (≥ 128 KB only), so a TUI's megabyte of redraws arrives as
  its last frame; the popout read is unchanged (untrimmed, 256 KB).

### Gotchas for later steps
- **A new spawn dep in `TerminalView` must also go into
  `TerminalSpawnInputs`/`terminalSpawnKey` and `tabTerminalSpawn`**, or a
  sleeping tab wakes by attaching to a PTY a mounted pane would have
  respawned.
- **A new owner-only duty registered at `TerminalView` mount and needed while
  hidden** (like the scheduled input) needs a parked stand-in in the teardown's
  sleep branch, or a `usePaneSleepHold`.
- `PaneSlot` marks in render; `TerminalView` teardown and the remove-view
  cleanup only *read* the registry. `parkPty` never creates an entry, so a view
  torn down after `killAsleepPty` cannot resurrect it.
- Tests mounting `PaneSlot`/`CenterPanel` with terminal tabs and fake timers:
  `_clearAsleepPtysForTest()` in `beforeEach`; `PaneSlotProps` gained
  `drawnElsewhere`.
- Final review / landing: `src-tauri/` changed — `npm run backend:stale` owed.
  New frontend on an old backend: the extra `sleeping`/`wake` args are
  ignored, so a program that exits while asleep wakes to a blank pane and the
  wake tail is 256 KB untrimmed; nothing else breaks.

### Gates (worktree, at 16b40766)
| Gate | Result (with test counts) |
|---|---|
| `npm run build` | ok (tsc + both bundles); `bootstrap-*.js` 3,324.63 kB / gz 976.08 kB (S9 review 3,321.42 kB) |
| `npm test` | 751 files / 7638 tests (S9 review 750 / 7623; +`TerminalSleepWake` 9, `SleepingTabs` +6). Full runs at load average 55–62 failed 129 tests in 14 files, all 20 s timeouts and their cascades (YamlViewer, TexViewer, Autocomplete, PythonViewer, BibCards, …); the 14 files rerun alone: 145/147, only the 2 known `MobileHeldPromptStore` date time-bomb failures |
| `cargo test -q` | lib 3587 passed, 3 ignored (S9 3581; +6 route tests); every other target green |
| `npm run lint` | 0 errors, 28 warnings (unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check 40738fea HEAD` | clean |

### Flagged for user
- **Terminal and agent tabs now unload** after the same "Unload hidden tabs
  after" delay (default 10 min) — the program keeps running, only the xterm
  goes. Busy terminals and working agents are not held awake (the plan does
  not ask for it); their output buffers in the backend meanwhile (up to
  ~2 MB replay buffer + ~2 MB tail per chatty PTY, with hysteresis).
- **What a wake does not bring back:** scrollback older than the 1 MB tail,
  and — for tails over 128 KB — anything before the last full-screen clear
  (a `clear`, a TUI redraw); a text selection, keyboard-select, an open find
  bar. A TUI repaints fully; a plain shell shows its recent lines.
- **A tab whose spawn failed** (error printed in the pane) has no PTY to park:
  after the delay it unloads and its wake *retries the spawn* (an HPC refusal
  asks again). Say if a failed pane should hold awake instead.
- **Root tabs never unload while the root console is open** (it draws them),
  an addition to the plan's never-sleep list.
- While asleep, mode marks / model tag read off the xterm fall back to the
  transcript/tmux readings, as for a never-shown tab.
- `npm run backend:stale` after landing (terminal router + commands).

### Live click-through (user)
On a frozen dev build of this branch (after landing), Settings → Performance →
"Unload hidden tabs after" → 5 min.
1. Open a shell tab, run `seq 1 200`, then `sleep 400; echo done-sleeping`;
   switch to another tab in that group for > 5 min. Switch back: the numbers
   and the prompt are there, then `done-sleeping` appears (the process ran on).
2. In a hidden shell run `sleep 10; exit` and leave it > 5 min: switching back
   shows its output and `[process exited]`.
3. Ask an agent a long task, switch away > 5 min: its tab pill still shows
   working/done; switching back shows the current screen, no restart, the
   prompt not retyped.
4. Schedule a prompt (Agents view) into an agent tab that has been hidden
   > 5 min: it is delivered without opening the tab.
5. Close a tab that has been hidden > 5 min: `ps`/System monitor shows its
   program gone (subtree too, e.g. a `sleep` under the shell).
6. Relaunch a hidden, unloaded agent tab from its tab menu (or switch its
   container toggle): it restarts at once, not when next shown.
7. Open the root console (or dock a root agent in the mail overlay) for > 5
   min: its tabs keep working and are not unloaded; pop a terminal tab out:
   it keeps working in the popout.
8. Settings → "Never": nothing unloads.

### Review (S10 reviewer, 2026-10-08)
Range reviewed: `40738fea..a61038a8` (300c8d76, 45ba7dd8, 4df49caa,
16b40766, handoff a61038a8). Nothing run live.

**Bugs fixed** (each with a regression test that fails without the fix)
- `8fa6b60b` (backend) — a woken pane lost the **terminal modes** its
  program set at start. The wake (and a popout's attach) builds a fresh
  xterm from `retained`; in a session that ran for hours the TUI's
  `?2004h` (bracketed paste), `?1049h`, mouse reporting and cursor keys had
  long fallen off that tail, so after a sleep a multi-line paste into an
  agent submitted its first line and scheduled prompts were typed line by
  line (`bracketedPaste()` false). `OutputRoute::retained_carried` now
  folds the tail cap's cut-off front (as `carried` does for `pending`);
  `route_wake_scrollback` and `route_scrollback` write it ahead of the tail;
  `route_open` drops it. Cost: one `ScreenState::observe` per cap's worth
  of output. Test `a_catch_up_keeps_the_modes_the_tail_cap_cut_off`.
- `2e5e8108` — the wake replayed **old OSC 52 clipboard writes**: the tail
  is output an earlier xterm already parsed, and the woken pane is focused,
  so an agent's copy from an hour ago overwrote the clipboard again (with
  the toast). The OSC 52 handler now skips anything parsed as a catch-up
  (`staleParse`, the gate terminal replies already use). Test in
  `TerminalSleepWake`.
- `0b584a7c` — a pane put to sleep with **`pty_spawn` still in flight** (a
  session container starting, the HPC / unfenced-platform question
  waiting) parked nothing: the spawn then made a PTY nobody owned, and the
  wake killed it and spawned another — a respawn by a visibility change.
  The launch now holds the pane awake (`PaneSleepHoldContext`, imperative
  token) until `setupAndSpawn` settles; released on unmount; attach/wake
  mounts take none. Two tests in `TerminalSleepWake`.

**Checked and sound**
- Kill/park ordering: React runs a deleted subtree's passive cleanups
  parent-first, so a close runs `PaneSlot`'s `killAsleepPty` before any
  `TerminalView` teardown; the sleep transition deletes only the
  `TabPane` subtree, so the view parks. A stale mark (none found; renders
  here are synchronous) would still end in a kill on close and a
  kill+spawn on relaunch. Pane layer key is `<scope>/<key>`, so group
  moves, `detachTab`/`detachGroup` (tabs stay in `tabsByScope`), hidden
  groups and popout dock-back never unmount a slot; scope unload, close,
  close-all and a project going inactive unmount it and kill, as the
  view's unmount did. StrictMode: the slot's synthetic cleanup finds no
  entry at a fresh mount; the waking view's finds it parked and does
  nothing.
- Spawn identity: `tabTerminalSpawn` covers every spawn-effect dep except
  `persistOnUnmount`/`attachOnly`, both constant for the owning pane;
  relaunch, container/tmux toggle and the remote hold wake the slot, and the
  mounted view kills the parked PTY before `pty_set_visible` + `pty_spawn`
  (the same order an effect re-run used).
- While asleep: busy lamps/attention come from `terminal-activity-batch`
  (the router digests with zero viewers too) and the hook verdicts; the
  stand-in reads `lastPtyOutputAt` off those digests; scheduler, phone holds
  (`queueableWhileBusy` via `started`), auto-continue, steering's agent
  prompt and the phone's Undo clear go through `scheduledAgentInput` →
  `pty_write`, so they reach the parked PTY; the waiting-for-idle check
  matches by `ptyId`, which the stand-in keeps. The phone bridge reads no
  desktop xterm (tmux / transcripts / stores), so Focus chat, held prompts,
  lazy history, `/model` probes, sign-in tabs and `tab_seen` are untouched.
  Reader, Diffs, Reader facts/status and the sign-in card live inside the
  pane (shown ⇒ awake); `terminalFor` readers (`agentModels`, mode marks,
  steering, scroll) already handled a never-built xterm. `useOverlayAgent`
  hears exit/ready on the bus, independent of the pane. Root console and the
  docked column keep the owner mounted (`drawnElsewhere`); popouts use
  `TabPane` directly (no slot, no sleep).
- Backend: sleeping tail ≤ 2 MB (cap 1 MB, 2× hysteresis) plus `pending`
  ≤ 2 MB; an ended sleeping route is freed by the wake read + the woken
  view's close, or by `pty_kill` → `route_forget_sleep` (also when the PTY
  is gone from the registry; `pty_kill_scope`'s unload is followed by the
  slots' own kills); quit tears down every registry PTY, parked ones
  included. A visible wake's registration replay ends inside the wake
  snapshot and is dropped by offset; the hidden wake clears `pending`
  (16b40766). Compatibility: `sleeping`/`wake` are single-word, optional
  (`Option<bool>`), ignored by an old backend; `exited` is optional on the
  frontend.

**Gates (worktree, at 0b584a7c)**
| Gate | Result |
|---|---|
| `npm run build` | ok (tsc + both bundles); `bootstrap-*.js` 3,324.85 kB / gz 976.10 kB |
| `npm test` | 751 files / 7641 tests (+3); full run at load ≈ 7: 3 failed — the 2 known `MobileHeldPromptStore` date time-bomb + `MobileIndicator` "lists paired devices…" (passes alone) |
| `cargo test -q` | lib 3588 passed, 3 ignored (+1); every other target green (`api_usage` flush-timing test flaked once in a loaded run, green alone and on the rerun) |
| `npm run lint` | 0 errors, 28 warnings (unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `git diff --check 40738fea HEAD` | clean |

**Flagged for user**
- The OSC 52 fix also covers the hidden-spell replay: a copy an agent made
  while its pane was hidden no longer lands on the clipboard when the tab is
  shown (it was never focused when the copy happened — the focus gate's
  intent). Say if such late copies should still go through.
- More component-only state a wake does not bring back (add to the
  implementer's list): a dismissed sign-in card comes back
  (`dismissedSignIns` is a ref), and an agent tab's prompt line for a CLI
  with no transcript prompt read (`agentModels.refresh` falls back to the
  xterm echo) empties on its next refresh while asleep — as for a tab never
  shown.
- The launch hold also keeps a hidden pane awake while the HPC or unfenced-
  platform question is open; it sleeps on the normal delay once answered.

## S11 — backend structural

*Written 2026-10-08 by the S11 implementer. Base `ccea64d7`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `f637fa9d` | §7.2 structural: new `services::proc_table` (one pid → ppid/`comm`/start snapshot, ≤ 1 s old, shared as `Arc`; `snapshot_within(ZERO)` walks fresh and shares it; per-process-image tab uid from `environ`; `alive`) read by `agent_turn`, the fence marker, `ui_priority`, `running_outputs` and `sysstat`'s descendant trees (Linux); 7 tests |
| `84cd8be0` | §7.5: new `services::transcript_watch` (`notify` on the files a read went by, 250 ms settle, ≥ 1 s apart per id, ≤ 128 ids) + `agent_transcript::watch_targets`; `agent_tab_transcript`/`agent_tab_changes` take `watch`, answer `watched`; `agent_transcript_unwatch`; sink → `transcript-changed` in `lib.rs`; frontend `lib/agents/transcriptWatch.ts` `watchedReads` used by the Reader, its subagent view and the Changes panel; 6 Rust + 6 vitest tests |
| `39686cac` | §7.7: `hostSessions` 7 s → 20 s + re-read on window focus (≥ 5 s apart); `net_usage` samples every 60 s unless a Network pane read within 30 s (then every 15 s tick); link row found by the master's socket inode in `ss -H -t -i -n -e` (no `-p`), `ssh -O check` skipped while the confirmed master (pid + start time) still runs; 4 Rust + 2 vitest tests |

### What was built / choices made
- **`proc_table`.** `Table::get(max_age, read)` re-checks under a walk
  mutex, so callers missing together walk once. `MAX_AGE` 1 s for the
  periodic readers. `sysstat::descendant_pids` (the strict, 1.5 s path the
  PTY reaper and window resolvers use) asks `snapshot_within(ZERO)` — its
  semantics are unchanged and its walk is now everyone's; the relaxed header
  path (`descendant_pids_relaxed`) takes a ≤ 1 s table, so it can reuse a walk
  `agent_turn` just took. The descendant cache (generation + TTL) stays as
  S1/S7 left it. Non-Linux: the table is `sysstat::parent_map` with empty
  names and `compute_descendant_pids` keeps its own walk there; no non-Linux
  consumer reads `comm`.
- **`agent_turn`.** `tool_shell_uids` reads a table no older than
  `JOB_SCAN_MAX_AGE` (500 ms, the verdict-reuse window), `comm` from the
  table, the tab uid once per process image (key pid + start + `comm`, so an
  `exec` or reused pid reads again; pruned when the process leaves the
  table), `cmdline` fresh for matched shells only — and a match counts only
  if `proc_table::alive` (same pid, same start) still holds: a stale table
  must not report a shell that ended as a job (a false "job" flash at every
  Stop otherwise).
- **Fence marker** walks the shared table's `children()`; `cmdline` +
  `ns/mnt` per subtree pid as before. Only the pill counter; the fence launch
  path is untouched (still fails closed).
- **`ui_priority`** caches each process image's renderer verdict (key pid +
  start + `comm`), so the 15 s rescan reads no `cmdline` for known processes.
- **`running_outputs`**: pids from the shared table, shells first (the Bash
  tool's wrapper shell holds a running output), then every other process
  before an output is called closed (a command that `exec`ed holds it — the
  existing test's holder is `sleep`). Plan's "restrict to agent_turn's shell
  pids" not taken: it would miss exec'd holders and contained agents.
- **Transcript watch.** Targets per read: Claude main = the file (`Exact`),
  its folder (`Created` — a `/clear`'s new transcript, the session's
  `<id>/` folder appearing), `<id>/subagents` (`Any`, part of the read's
  version) once it exists; Claude subagent = its folder (`Any`); Codex = the
  rollout + `Created` in its day folder; OpenCode = the store's folder with a
  `Prefix(<db name>)` rule (`-wal`). The command re-arms on every read not
  answered `unchanged` (that is how a rotation is followed: the new file has a
  new version) and keeps an armed watch on `unchanged`. Unwatchable (nothing
  on disk, remote tab, no store) → `watched: false` → the frontend keeps the
  2 s clock — the "missing file" case. Watched → 15 s backstop (catches a
  background shell dying with its CLI, a Codex rollout started in another
  day folder, Codex spawn edges in sqlite). Not modelled on
  `agent_turn::start(AppHandle)`: the service takes a sink closure;
  `lib.rs` points it at `transcript-changed`. Event ids are `rw-<window
  random>-<n>`; `watchedReads` never overlaps reads (a change mid-read runs
  one more after it) and disarms on stop — and again if an in-flight read
  re-armed after the stop. Leaked watches (a window reload never disarms)
  are bounded by the 128-id cap (oldest armed evicted; an evicted live Reader
  re-arms on its next backstop read).
- **Sleeping tabs (S10):** the Reader lives in the pane, so a sleeping tab
  has no Reader and no watch; the wake remounts it, which reads and arms
  again. Nothing depends on the xterm.
- **`net_usage`.** The loop still wakes every 15 s (disconnect detection and
  the ~30 s flush keep their clock); a tick samples when due —
  `sample_due(since_last, pane_open)`: every tick while a Network pane read
  (`network_ssh_link_snapshot`/`network_host_snapshot` call
  `net_usage::note_pane_read`) within `PANE_OPEN_MS` 30 s, else every 60 s.
  Plan said "`ss -tni` filtered by the master's local port"; chosen instead:
  the master's socket inodes from its own `/proc/<pid>/fd`, matched against
  `ino:` in one shared `ss -H -t -i -n -e` dump — exact, needs no port first,
  and the dump without `-p` walks no process fds. `ssh -O check` result is
  cached per project keyed by the check args; reused while `/proc/<pid>/stat`
  shows the same start time and `comm` `ssh`. Linux only; macOS (`nettop`
  per pid, `ssh -O check` each time) unchanged. No new remote probe: both
  only ever run for projects in `connected_ids` / behind `is_connected`.
- **`hostSessions`.** `HOST_SESSIONS_POLL_MS` 20 s; a `focus` listener per
  retained project (removed on the last release) re-reads unless a reading
  started < `FOCUS_REFRESH_MIN_MS` 5 s ago. Not watcher-driven: nothing local
  sees a host's tmux change.

### Gotchas for later steps
- **New `/proc` readers go through `services::proc_table`**; one that must
  see a process forked a moment ago asks `snapshot_within(Duration::ZERO)`.
  Tests that spawn a process and expect a ≤ 1 s-table reader to see it must
  force a fresh walk first (`running_outputs` now re-walks on its own
  before calling an output closed — S11 review).
- **S12 (`usePoll`):** `watchedReads` (15 s backstop / 2 s unwatched) and
  `hostSessions`' 20 s interval + focus listener are the new timers; the
  Reader's two transcript intervals and the Changes interval are gone.
  Direct `setInterval(` lines in `src/` (non-test): 84 (S7: 87).
- Reader tests: a mock answering `watched: true` drives the watch path;
  `_notifyTranscriptChangedForTest(id)` delivers a change (the id is the
  `watch` arg of the read).
- `AgentTranscript`/`AgentChanges` gained `watched` (serde-skipped when
  false); a new struct literal needs it.
- Final review / landing: `src-tauri/` changed — **`npm run backend:stale`
  owed**. New frontend on an old backend: `watch` is ignored and `watched`
  absent, so the Reader polls every 2 s as before; `agent_transcript_unwatch`
  is rejected and swallowed.

### Gates (worktree, at 39686cac)
| Gate | Result (with test counts) |
|---|---|
| `npm run build` | ok (tsc + both bundles); `bootstrap-*.js` 3,325.66 kB / gz 976.32 kB |
| `npm test` | 752 files / 7649 tests (S10 review 751 / 7641; +`TranscriptWatch` 5, Reader watch 1, hostSessions 2); 2 failed — the known `MobileHeldPromptStore` date time-bomb pair. Load ≈ 5–10, no timeouts |
| `cargo test -q` | lib 3606 passed, 3 ignored (S10 review 3588; +18); every other target green (all targets 3774 passed) |
| `npm run lint` | 0 errors, 28 warnings (unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `cargo check --target x86_64-pc-windows-msvc` (RC/lib shims) | ok |
| `scripts/brand-check.sh` | ok |
| `git diff --check ccea64d7 HEAD` | clean |

### Flagged for user
- **Reader latency changes shape.** A write shows ~0.25–1 s after it lands
  (was up to 2 s); what no file event says now waits for the 15 s backstop
  (was 2 s): a background shell that died with its CLI leaving the shell row,
  a Codex conversation continued in a rollout of another day's folder.
  Unwatchable reads (before the first record, remote tabs) still poll 2 s.
- **Job mark:** a background shell started < 500 ms before the hook record
  that triggers a scan shows on the next 2 s tick instead (ended shells are
  never reported — liveness check).
- **Sessions list** refreshes every 20 s (was 7 s); a session started from
  another terminal shows when the window regains focus or within 20 s.
- **SSH traffic totals** sample every 60 s with no Network pane open: a
  ControlMaster that dies between samples takes up to a minute of traffic
  with it (was 15 s). Totals are otherwise the same (cumulative counters).
- A ProxyJump/ProxyCommand master talks through pipes and has no TCP socket
  of its own: its link reads "counters not visible" — as before (`ss -p`
  never showed it either).
- Not done: S1's "skip agent-auth homes with no live tab" — `proc_table` is
  not a tab registry; still open under §7.3.
- `npm run backend:stale` after landing (new commands, `watch` args, sampler).

### Live click-through (user)
On a frozen dev build of this branch (after landing):
1. Open a Claude tab in Reader view, send a prompt: the answer appears about
   a second after Claude writes it; leave it idle — `strace -f -e trace=openat
   -p <tabtivity pid> 2>&1 | grep jsonl` shows no read of the transcript every
   2 s, only one each ~15 s.
2. `/clear` in that tab: the Reader switches to the empty chat within a
   second or two; Undo clear brings the old one back.
3. Ask for a subagent: it appears in the Subagents list; open it — its
   conversation follows live. Open Diffs: an edit shows as a New card.
4. Ask for `sleep 120` with run_in_background: the shell row and the tab's
   job mark appear; after it ends both go. Kill the CLI with one running: the
   row goes within 15 s.
5. OpenCode tab in Reader view: answers still appear live.
6. Remote project, Sessions view open: start `tmux new -d -s x` on the host
   from another terminal, click back into the window: `x` is listed.
7. Network pane → SSH link: rates update every second as before; close the
   pane, transfer a file over the project, reopen after a few minutes: the
   hour total includes it.
8. Fence pill and UI priority unchanged: `ps -o ni= -p $(pgrep -f
   WebKitWebProcess | head -1)` shows -10; an unfenced live tab still counts
   on the project pill.

### Review (S11 reviewer, 2026-10-08)
Range reviewed: `ccea64d7..7f764e41` (f637fa9d, 84cd8be0, 39686cac, handoff
7f764e41). Nothing run live.

**Bugs fixed** (each with a regression test that fails without the fix)
- `8244017d` — the OpenCode watch **re-armed itself**: a read-only SQLite
  open that finds no other connection (OpenCode not running) rewrites the
  store's `-shm` index (`IN_MODIFY`, checked with inotify), and the
  `Prefix(<db>)` rule counted it, so each read caused the next — one read a
  second for as long as the Reader showed, more than the 2 s poll it
  replaced. `Rule::Prefix` now leaves `-shm` out (every committed write lands
  in the store or its `-wal`). Test `reading_the_opencode_store_is_not_a_change_but_a_write_is`
  (real rusqlite store + watcher).
- `64e680bb` — the 128 cap **evicted live Readers first**: a shown Reader
  arms once, then every read keeps it (`unchanged` → `armed`) or re-arms it
  onto the same files (early return) — neither moved its eviction order, so
  watches leaked later by a reload / closed popout outlived it and the live
  Reader dropped to the 15 s backstop. Both paths now touch the order
  (`transcript_watch::keep` replaces the command's `armed` check). Test
  `a_watch_still_read_is_not_the_one_the_cap_evicts`.
- `64eb3ce8` — `running_outputs` on a ≤ 1 s table **missed a just-started
  background shell**: the watch fires on the very record that started it, so
  the triggered read often had a table from before the start, called the
  output closed and hid the shell row (and the `BACKGROUND_SEEN` memory)
  until the next change or the 15 s backstop. Before calling an output
  closed it now looks at the processes a fresh walk adds (new pid or start;
  fds are read live, so nothing else can hold what it missed). The existing
  test now walks the table *before* spawning its holder.
- `8622f907` — `proc_table::tab_uid` **cached a mid-exec read**: `exec`
  names the new image (`comm` "bash") before it sets up the environment, so a
  scan in that window read an empty `environ` and remembered "no tab uid" —
  that shell was never a job for its whole life. Seen as a real failure of
  `a_live_backgrounded_shell_is_a_job_and_a_live_tool_call_is_not` in a
  loaded full run (green alone). An empty block is no longer remembered; an
  unreadable one (another user's) still is. Test
  `an_empty_environment_read_mid_exec_is_read_again`.
- `e496fd1b` (sibling) — `ui_priority`'s per-image renderer verdict had the
  same window: no `cmdline` yet → remembered "not a renderer" → never
  raised. `renderer_verdict` keeps a verdict only once the command line was
  read. Test `a_renderer_verdict_is_kept_per_image_but_not_before_its_command_line`.

**Checked and sound**
- `proc_table`: `Table::get` re-checks under the walk mutex; a ZERO caller
  always walks after taking it (never handed a walk that started before its
  call); no lock is held across a caller's own work, the uid cache lock is
  never taken with the walk lock in the other order. The strict path
  (`descendant_pids` → `snapshot_within(ZERO)`, descendant cache TTL and
  generation as before) still walks per miss, roots always included. No
  caller runs on the GTK thread (agent_turn/ui_priority/fence threads,
  `spawn_blocking` commands, PTY kill paths that walked before). Keys are
  pid + start (+ `comm`), so a recycled pid reads again; `alive` gates the
  job verdict. Fence marker on a stale table only misses a < 1 s-old tree
  (→ Idle, not Unfenced); the launch path is untouched. Windows type-check
  ok; macOS cfg read: `read_table` uses `sysstat::parent_map` (present),
  `running_outputs` is gated at run time, network's cache is Linux-only.
- `transcript_watch`: unwatch on effect stop (hidden pane, sleeping tab per
  S10 = unmount, `sessionId`/`readTick` change); an in-flight read that armed
  after the stop disarms again. Debounce never drops the last write (a change
  after a send is due at `max(settle, last + 1 s)`). `/clear`: the Reader's
  effect depends on `sessionId`, so the hook's new id re-reads at once; the
  new file exists only with the first turn, until then the read is unwatched
  (2 s clock). Watched folders are the scope's agent home (`claude_projects_roots`,
  `codex_sessions_root`, the OpenCode store), never the project folder; a
  symlink the fenced agent plants there is followed by inotify, but only the
  watch id is emitted (no path, no data) and the reads went by those paths
  before. Phone API: `watched` never set. Old backend: `watch` ignored,
  `watched` absent → 2 s.
- §7.7: `ino:` parsing matches iproute2 6.19 output (`uid:… ino:N sk:…`, the
  same tokens since `-e` exists); IPv6 brackets leave fields 3/4 intact;
  `ino:0` and a missing `ino:` are skipped. The `ssh -O check` cache is keyed
  by the check args (socket + host) and pid + start + `comm` `ssh`, so pid
  reuse or a new master asks again. That check only feeds the Network pane's
  link reading and the traffic sampler — the connection lamp never read it,
  so the skip cannot hold a dead link green (a live master over a dead TCP
  link answered `-O check` "running" before too). `note_pane_read` is a
  process-wide atomic, so a popout's Network pane counts. `hostSessions`
  focus re-read is gated on `connected` like the timer and throttled 5 s.
- Hidden window / HPC: no new timer runs for a hidden Reader (effect gated on
  `visible`); `net_usage` ticks as before (local `ss` + `ssh -O check` on the
  control socket, no host probe) and samples less; `hostSessions` only while
  a Sessions view retains it.

**Gates (worktree, at e496fd1b)**
| Gate | Result |
|---|---|
| `npm run build` | ok (tsc + both bundles); `bootstrap-*.js` 3,325.66 kB / gz 976.32 kB |
| `npm test` | 752 files / 7649 tests; 2 failed — the known `MobileHeldPromptStore` date time-bomb pair (load ≈ 2–5) |
| `cargo test -q` | lib 3610 passed, 3 ignored (+4); all targets 3778 passed. First full run (before `8622f907`) failed `a_live_backgrounded_shell_is_a_job…` — the bug that commit fixes |
| `npm run lint` | 0 errors, 28 warnings (unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `cargo check --target x86_64-pc-windows-msvc` (RC/lib shims) | ok |
| `scripts/brand-check.sh` | ok |
| `git diff --check ccea64d7 HEAD` | clean |

**Flagged for user**
- The cached ControlMaster is trusted while its process runs. If a master's
  control socket is replaced while the old process lingers (ControlPersist
  with channels still open, socket unlinked), the link reading and traffic
  totals follow the old master until it exits, where `ssh -O check` would
  name the new one. Not seen in Tabtivity's own reconnect paths; say if it
  should also confirm the master still serves the socket.
- Watches leaked by a window reload or a closed popout (no unmount runs) stay
  armed — one inotify watch per folder, bounded by the 128 cap and now
  evicted before any Reader still reading.
- Still open from S11: the job mark's < 500 ms start window and the 15 s
  backstop for what no file event says (implementer's Flagged list).

## S12 — poll helper + QA rows

*Written 2026-10-09 by the S12 implementer. Base `037ba352`. Nothing run live.*

### Commits
| Commit | Content |
|---|---|
| `528a5066` | §3.3 helper: `src/lib/usePoll.ts` — `startPoll` (stores) / `usePoll` (components); 17 tests (`UsePoll.test.tsx`) |
| `2d051ccc` | Stores onto `startPoll`: `mobileHostStatus` (S7 leftover), `remote/hostSessions`, `todo` urgent-mail backstop, `lib/ollamaStatus`; blur tests in `MobileHostStatusShared`, `HostSessionsShared`, `OllamaStatusPoller` |
| `70628b5e` | Helper: `PollRun.stopped` handed to every run (replaces the effects' `cancelled` flags); store reads tolerate a module mocked down to its hook; +1 test |
| `4761558e` | Header/menus/dialogs onto `usePoll`: `MobileIndicator` devices, `InboxIndicator`, `MachinesIndicator` utilization sweep, `RootOverlay` review, `ProjectPill` VM glyph, `VmSettingsDialog`, `SettingsPanel` VM install re-check, `SidePanel` debug renderer RSS |
| `14f4ff41` | Panes onto `usePoll`: `ProjectFilesView` Git-view backstop (S7 leftover) and Slurm Jobs queue, `TerminalReaderFacts` usage limits, `usePromptChartUsage`, `NetworkTrafficPane` persisted totals; blur test in `GitBarRefresh` |
| `d804ab39` | `ProjectDialog` VM install re-check onto `usePoll` |
| `778585a4` | §8 + measurement: `todo/group-u-performance.md` items 2400–2413; `scripts/perf-numbers.sh` + `docs/performance_numbers.md` copied from the main checkout; plan §10 lists the 66 direct sites left; file map row for `lib/usePoll.ts` |

### What was built / choices made
- **What pauses a poll:** this window blurred (`stores/power` `blurred`, per
  window — a popout has its own), `document.visibilityState === "hidden"`,
  and for the hook a hidden pane (`usePaneVisible()`; only `FileViewerPane`
  provides the context, other panes pass their `visible` as `enabled`) or the
  caller's `enabled` off. `quiesce: false` keeps only cadence + overlap guard
  (no site uses it yet; the exempt hosts keep their own timers).
- **Energy Saver widens (×3, `saverInterval`), it does not stop.** The plan
  says "built on `useQuiesce`, blurred → stop"; `useQuiesce` is saver OR
  blurred, and stopping every poll on battery while the user works in the
  window would blank lamps — so only the blur half stops.
- **Catch-up:** on return (blur → focus, hidden → shown, a `focus` event) a
  run happens at once if the last one started ≥ `catchUpAfterMs` ago
  (default: the interval, i.e. only when one fell due); otherwise the cadence
  carries on. `catchUpAfterMs: 0` keeps the old "re-read on every focus" of
  `mobileHostStatus` and `InboxIndicator`; `hostSessions` keeps its 5 s focus
  throttle through `catchUpAfterMs: FOCUS_REFRESH_MIN_MS` + `lastRunAt`
  (its forced refreshes count). The two stores' own focus listeners are gone
  (the poll's resume is the focus re-read).
- **Start:** the first run happens even in a blurred window (a surface
  mounted while unfocused still gets its reading); not in a hidden window
  (deferred to the catch-up). `immediate: false` for sites whose caller
  already reads at start (Root review, Git view, hostSessions, urgent mail,
  Ollama, the two VM install re-checks).
- **Cadence:** fixed rate from the last run's start; the next run is armed
  only when the previous promise settles, and ticks a slow run covered are
  skipped, not made up (`setInterval` + in-flight guard semantics — a wedged
  backend is asked once per interval, never back to back).
- **Hook API:** `usePoll(run, ms, { enabled, … })`; `run` is a dependency —
  pass a `useCallback`; a new `run` (its inputs changed) or `enabled` turning
  on restarts with an immediate run, which is how the replaced effects
  behaved (e.g. a Files view switching project re-reads at once).
- **Not changed:** any site's interval; the Ollama poller's shortest-wins
  re-timing (`setIntervalMs`); `hostSessions`' connectivity re-poll;
  `mobileHostStatus`' restart hold.
- **Skipped (behaviour would change), listed in plan §10 with the rest:**
  `VpnIndicator` (its 10 s refresh is what detects a dropped tunnel and gates
  the SSH probes riding it — background work runs unfocused); `AppShell`'s
  SSH-pool reconcile (silent reconnect for background HPC tabs); the
  persistence flushes; `DetachedApp`'s hidden-window probe (it *is* the
  hidden detection); `MailIndicator` (mail check / new-mail notice); file
  auto-reload polls (a viewer beside an external editor or `latexmk -pvc`
  must follow saves while unfocused — `FileViewerPane:1583` already chose
  ×3-on-blur for the same reason); live monitors (`NetworkTrafficPane`'s 1 s
  rate, `PrintManagerPane`); the sites already on `saverInterval(…,
  quiesce)` (×3 on blur by design: header readouts on a visible window);
  local clocks/xterm reads (no IPC); S11's `watchedReads` (setTimeout-based,
  not counted: 15 s backstop / 2 s unwatched transcript read while a Reader
  shows — a candidate, but it is S11's watch-arming logic); `stores/power`'s
  battery reading (feeds the helper).
- **Untested register:** the run's only new UI is S9/S10's
  `settings.sleepTabs` (row present). The §8 cluster has no UI → no pills.
- `setInterval(` lines in `src/` (non-test): **66** (S11: 84).

### Gotchas for later steps
- A new UI poll goes through `usePoll`/`startPoll`; a new direct
  `setInterval` needs a line in plan §10's list.
- `usePoll`'s `run` must be stable (`useCallback`) — an inline closure
  restarts the poll every render (an immediate run per render).
- Tests: the helper reads `usePowerStore.blurred`; set
  `usePowerStore.setState({ blurred: false })` in `beforeEach` of a test
  that blurs. A store module mocked down to its hook (no `getState`/
  `subscribe`) reads as focused / on AC. A run whose promise has not settled
  blocks the catch-up (flush with `advanceTimersByTimeAsync(0)` first).
- Final review / landing: S12 changed no `src-tauri/`; the earlier steps'
  `npm run backend:stale` still owed.

### Gates (worktree, at 778585a4)
| Gate | Result (with test counts) |
|---|---|
| `npm run build` | ok (tsc + both bundles); `bootstrap-*.js` 3,326.60 kB / gz 977.08 kB; no "also statically imported" warning |
| `npm test` | 753 files / 7671 tests (S11 review 752 / 7649; +`UsePoll` 18, blur cases 4); 2 failed — the known `MobileHeldPromptStore` date pair. Load ≈ 25 |
| `cargo test -q` | lib 3610 passed, 3 ignored; all targets 3778. First run (concurrent with vitest, load ≈ 25) failed two `git_bounded` FIFO timeout tests; 6/6 alone and the full rerun green (S12 touched no Rust) |
| `npm run lint` | 0 errors, 28 warnings (unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `scripts/privacy-check.sh 037ba352..HEAD` | ok (2150 added lines, 28 paths, 7 commits) |
| `git diff --check 037ba352 HEAD` | clean |

### Flagged for user
- **Blurred = stopped** for the migrated polls (plan §2): with the window on
  a second monitor but unfocused, the phone lamp, devices list, inbox,
  sessions list, VM glyph, Slurm queue, Reader usage limits, Machines bars and
  the Git view's counts stop updating until you click back (then at once).
  Header readouts on `saverInterval` keep ticking ×3 slower as before.
- **Not migrated, your call:** the Network pane's 1 s rate and the print
  queue (monitors you may watch from another window), and file auto-reload
  (would stop live PDF preview beside an external editor). Say if any of
  them should pause unfocused.
- `docs/performance_plan.md` in the main checkout is identical to the
  branch's (no diff); the branch's is kept. `scripts/perf-numbers.sh` and
  `docs/performance_numbers.md` are now on the branch — the main checkout's
  untracked copies will collide on landing (delete them first, or take the
  branch's).
- QA: `todo/group-u-performance.md` 2400–2413 (75 🖐️ boxes for S1–S12's
  click-throughs, 8 for the §8 cluster, item 2413 the open CPU-pressure
  auto-engage). Numbers start at 2400 because branch `hosted` uses up to
  2389.

### Live click-through (user)
On a frozen dev build of this branch (after landing):
1. Local git project, side panel on the Git view; click into another app
   and commit there; no `git status` runs for it while away; click back:
   counts current within ~1 s.
2. Mobile on: with the window unfocused stop the Mobile host from a
   terminal; click back: the phone lamp turns red at once.
3. Ollama running: load a model from a terminal while unfocused; click back:
   the Models lamp shows it loaded within a second.
4. Send a file from the phone while the window is unfocused; click back:
   the header inbox lists it at once.
5. Slurm project, Files → Jobs: refreshes every ~7 s focused, no `squeue`
   while unfocused, current at once on return.
6. Popout focused: its polls run, the main window's stop (and vice versa).
7. Scheduled prompt one minute out, switch to another app: delivered (the
   exempt hosts still run unfocused).
8. Energy Saver "Always": the polls above run ~3× slower while focused.

### Review (S12 reviewer, 2026-10-09)
Range `037ba352..d21157cf`. Checked `startPoll`/`usePoll` (catch-up once per
return — power-store and `focus` resumes collapse on the in-flight guard or
the `catchUpAfterMs` test; no overlap; stop during an in-flight run arms
nothing; `stopped` reaches every site that writes after an await; `enabled`
and interval changes; Energy Saver re-arm; per-window focus state; the
mocked-store fallbacks only apply where a module lacks `getState`/`subscribe`,
never in the real path), all 18 sites (same intervals, same first-run
timing — `immediate: false` exactly where the old code read outside the
interval, same connected/remote gates, no lost side effect, all `enabled`
values real booleans so `?? true` never turns a gate on), what each site's
readers do while the window is in the background, the QA rows (83 🖐️ boxes,
all with the four platform pairs; ids 2400–2413 unused on `develop`, `hosted`
and the main checkout's working tree), and `perf-numbers.sh` (reads `/proc`
only, appends to the doc, paths quoted, brand from `scripts/lib/brand.sh`) +
`performance_numbers.md` (pids, process names, no hosts).

**Fix**
| Commit | Bug | Regression test |
|---|---|---|
| `e114dc6c` | The urgent-mail backstop (`stores/todo`) also feeds the **phone's Alerts screen** (`MobileBridgeHost` → `useAlertsFeed({ ignoreVisibility })`). Quiesced, it stopped exactly while the phone was in use (desktop window in the background): mail read, moved or re-flagged elsewhere stayed on the phone until the desktop was focused (only arrivals re-read via `newCount`). The old 60 s tick ran unfocused. A retainer that serves the phone (`retainUrgentMailPoll(true)`) now keeps the tick unquiesced; desktop-only retainers still stop on blur. | `todo/UrgentMailPoll.test.ts` (3; 2 fail on the unfixed store) |

**Gates (worktree, at e114dc6c)**
| Gate | Result |
|---|---|
| `npm run build` | ok (tsc + both bundles) |
| `npm test` | 754 files / 7674 tests; 2 failed — the known `MobileHeldPromptStore` date pair |
| `cargo test -q` | lib 3610 passed, 3 ignored; all targets 3778 |
| `npm run lint` | 0 errors, 28 warnings (unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `scripts/brand-check.sh` | ok |
| `scripts/privacy-check.sh 037ba352..HEAD` | ok |
| `git diff --check 037ba352 HEAD` | clean |

**Flagged for user (not changed)**
- **An iframe takes the window's focus.** `startFocusTracking` sets `blurred`
  on the window's `blur` event, which also fires when focus moves into a
  same-window `<iframe>` (mail body, Browser reader view, `FileViewerPane`'s
  frame) while `document.hasFocus()` stays true. Before S12 that only paused
  animations and slowed `saverInterval` readouts ×3; now the migrated polls
  stop while you read a mail body in the window, and catch up when you click
  back into the app's own UI. A fix would re-check `document.hasFocus()` on
  blur in `startFocusTracking` (changes the animation pause too) — your call.
- **Focus at startup.** `startFocusTracking` seeds `blurred` from
  `document.hasFocus()` at mount; if WebKitGTK reports false there and no
  `focus` event follows, every migrated poll waits for the first blur/focus
  round trip. Worth watching in S12.1–S12.4.
- The implementer's three flags stand (blurred = stopped on a second
  monitor; Network rate / print queue / file auto-reload kept direct; main
  checkout's untracked `perf-numbers.sh`/`performance_numbers.md` collide on
  landing).

## Final review (2026-10-09)

Range `a6ed2c7a..b53f2c7c` (96 commits, S1–S12 with their reviews), plus the
fixes below. Nothing run live.

**Checked (cross-step, what the per-step reviews could not see)**
- Sleep × everything mounted in a pane: a sleeping viewer or terminal slot
  unmounts the whole `TabPane` subtree, so S12 `usePoll`s (Reader facts,
  Git view, Slurm queue, prompt chart, Network totals), S11 `watchedReads`
  (unwatch on stop), S7 `useMobileHostStatus` retains and `coalescedRun`s,
  and S3's `useViewerState` (unmount flush) all stop with it and restart on
  the wake mount (immediate run / fresh read / seed from stage-then-store).
  S8's `LazyPane` sits inside `TabPane`, so a sleeping slot loads no chunk;
  a woken lazy pane renders from the module cache.
- Parked PTYs × S5 digests / S4 lamps: `pty_remove_view(sleeping)` leaves the
  route unsubscribed, so a sleeping tab digests through
  `terminal-activity-batch` exactly like a hidden one; the S4 recompute reads
  only stores; `lookedAtPtyIds` cannot contain a sleeping tab (it is hidden).
  The S10 scheduled-input stand-in reads `lastPtyOutputAt` off those digests.
- S6 memo × S9/S10 props: `sleepAfterMs`, `inPopout`, `drawnElsewhere` are
  scalars; `held`/asleep are slot-local state; `markPtyAsleep` in render is
  idempotent (StrictMode double render safe).
- Holds: deck presenting (S9 review) still holds — `DeckPresentingSleepHold`
  green after the deck fix below; PdfView `held || compiling`, TexView,
  editors, media, annotator, commit box, launch-in-flight all report through
  the one `PaneSleepHoldContext`.
- Quit: `RunEvent::Exit` drains the persist lane, then `kill_all` over the
  PTY registry — parked PTYs included (they stay registered); transcript
  watches and `proc_table` are in-process (threads/statics, no child
  process); `net_usage`'s `ss`/`ssh -O check` are waited for synchronously.
- Leftovers: no TODO/FIXME/XXX, debug logging or `any` added (the
  `eprintln!`s are error paths and one test skip note); new exports unused
  outside their module are test seams or types only; clippy `-D warnings`
  covers Rust dead code.
- i18n: the range adds 4 keys (`settings.sleepTabs*`), present in en, de, es,
  fr, it; the help text covers terminal kinds (S10 rewording). No hardcoded
  display text in the new components (`SleepingPane` renders none).
- Untested register: `settings.sleepTabs` row + pill (covers S9 and S10);
  the other steps are behaviour changes with QA rows 2400–2413.
- File maps: rows present for `PaneSlot`, `SleepingPane`, `sleepingPtys`,
  `terminalSpawn`, `usePoll`, `coalescedRun`, `mobileHostStatus`,
  `transcriptWatch`, `sleepWhenHidden`, `activityDigests`, `proc_table`,
  `transcript_watch`, `replay_trim`; S1's `persist_lane.rs` and
  `ordered_lane.rs` had none — added (`23633fad`).

**Fixes**
| Commit | Bug | Regression test |
|---|---|---|
| `a0703586` | Deck audience window (known bug c). The presenter's unmount close already existed for a window whose open had answered; the gap was an open still in flight: closing the deck tab (or ending the talk) before `open_presenter_window` answered left the window on the projector. The open now closes what it lands if the presenter is gone. | `deck/DeckAudienceUnmount.test.tsx` (2; the in-flight case fails unfixed) |
| `edaad214` | Known bug a: focus moving into an iframe of the window (mail body, reader view, viewer frame) fired `blur` and stopped every S12 poll. `startFocusTracking` decides a blur one task later; an iframe as active element or `document.hasFocus()` counts as focused; a same-origin frame's own blur/focus track leaving/returning. | `Quiesce.test.ts` "startFocusTracking with an iframe" (3) |
| `dc9dd67e` | Known bug b: `blurred` seeded from `document.hasFocus()`. A visible document now starts focused until a real `blur`; a hidden one starts blurred. | `Quiesce.test.ts` "startFocusTracking at startup" (2) |
| `2bdc8ec2` | Found by a full `cargo test` (S11 × S1 timing): the job scan read a shared table up to 500 ms old, so a shell started just before a turn ended could be missing; the Stop scan then *settled* the tab and the 2 s tick skipped it — the job mark waited for the 30 s backstop (the S11 flag said "next 2 s tick"). Made `a_live_backgrounded_shell_is_a_job…` fail intermittently. A scan that can settle a tab (turn over, no job on record, not settled) walks fresh. | `a_turn_end_scan_sees_a_shell_younger_than_the_shared_table` |

**Gates (worktree, at 2bdc8ec2)**
| Gate | Result |
|---|---|
| `npm run build` | ok (tsc + both bundles); `bootstrap-*.js` 3,327.37 kB / gz 977.38 kB |
| `npm test` | 755 files / 7681 tests; 2 failed — the known `MobileHeldPromptStore` date pair (load < 1) |
| `cargo test -q` | lib 3611 passed, 3 ignored; all targets 3779 passed, 0 failed (first full run, before `2bdc8ec2`: the agent_turn failure that commit fixes) |
| `npm run lint` | 0 errors, 28 warnings (unchanged) |
| `cargo clippy --all-targets -D warnings` | clean |
| `cargo check --target x86_64-pc-windows-msvc` (RC/lib shims) | ok |
| `scripts/brand-check.sh` | ok |
| `scripts/privacy-check.sh a6ed2c7a..HEAD` | ok (18,752 added lines, 163 paths, 101 commits) |
| `git diff --check a6ed2c7a HEAD` | clean |

**Flagged for user — consolidated (every open item from S1–S12 and their reviews; fixed ones marked)**

*Decisions owed* (decided by the user 2026-10-09, except where marked)
- Thin LTO (`f1c7281f`): binary +2.5 %, builds +11–30 %, runtime gain unmeasured — keep or revert (S8). **Decided:** keep until measured with `scripts/perf-numbers.sh`; revert if it shows no gain. **Reverted 2026-10-11** (user): the after-merge run idles the app process at 0.8 % of a core, so LTO's share cannot be worth 11–30 % slower builds.
- Bootstrap stays 3.3 MB (gz 977 kB); the 1.5 MB target needs another lever (lazy English dictionary), not more lazy panes (S8). **Decided:** measure first; lazy-load the dictionary only if parse time shows.
- `AppShell` not lazy for popouts (popout startup vs main-window waterfall); `lib/tex.ts` not made dynamic (S8). **Decided:** leave as is.
- Glass themes: tab bars / docked file column lost their frost; compensate with a more opaque fill? (S7). **Decided:** more opaque fill — done in S13 (`2198c80a`).
- Blurred = stopped for the migrated polls (second-monitor case); Network 1 s rate, print queue, file auto-reload kept on direct timers (S12). **Decided:** stop when unfocused, as built.
- Which kinds sleep: viewers, Files (Project), shell/agent terminals; browser, calendar, monitors, print, skills, prompt chart, 3D, plain Files stay mounted (S9). **Decided:** as built.
- Busy terminals / working agents are not held awake; their output buffers in the backend (≈ 2 MB replay + 2 MB tail per chatty PTY) (S10). **Decided:** let them sleep, as built.
- A failed-spawn pane unloads and its wake retries the spawn (an HPC refusal asks again) (S10). **Decided:** never sleep it — done in S13 (`81077229`).
- "Never" also turns off the §4.5 popout stub (S9). **Decided:** fine as is.
- OSC 52 copies made while a tab was hidden no longer reach the clipboard on show (S10 review). **Decided:** drop them, as built.
- Plan §7.1 `command(async)` replaced by the ordered lane (S1). (Not raised 2026-10-09.)
- The cached ControlMaster is trusted while its process runs, even if its socket was replaced (S11 review). **Decided:** trust while running, as built.
- TeX workspace sub-pane positions (below, *What a wake does not bring back*). **Decided:** persist — done in S13 (`b13a0df5`).

*Behaviour changes to expect*
- No fsync / watcher event for an unchanged settings/projects/session write (S1).
- Header resources every 5 s; Ollama installed mid-session shows on next hover/overlay close; Files-view Git flag follows the pill dot (nested repos update on show) (S7).
- Reader: writes show in ~0.25–1 s; what no file event says (shell dying with its CLI, Codex rollout in another day folder) waits for the 15 s backstop; unwatchable reads still 2 s (S11).
- Job mark: a shell started < 500 ms before a mid-turn hook shows on the next 2 s tick (S11); the turn-end case is fixed (`2bdc8ec2`).
- Sessions list 20 s + on focus; SSH traffic totals every 60 s without a Network pane (S11).
- After a hidden spell > 128 KB, lines scrolled off before the last full clear are not replayed into xterm's scrollback; Codex's inline viewport may never be trimmed (S5).
- First open of each split pane/overlay shows a brief loading box; steering `,` to Settings on first open waits for the chunk (S8, S8 review).
- Zoom preview scales inter-page gaps, the commit does not (pages far from the cursor shift ≤ 28 px × (eff − 1) per gap); a corrected middle page in the viewport resizes in place (S2 review).

*What a wake does not bring back* (S9, S9 review, S10, S10 review, final)
- A clean editor's undo history, a text selection, an open find bar, keyboard-select, a paused video's playhead, presentation marker strokes, an open SQLite query, a `ProjectFilesView` dialog or sort order, a dismissed sign-in card (comes back), scrollback past the 1 MB tail / before the last clear, a CLI's prompt line read off the xterm.
- New here: a TeX workspace's sub-pane positions (`<key>#<path>`: the PDF centre's zoom/scroll, a child file's scroll) were never persisted, so any wake after the delay (not only a popout dock-back, S3/S9) reopens them at the default position; S3's 5 min PdfView sleep inside a TeX workspace does the same. Fixed in S13 (`b13a0df5`): persisted in the workspace tab's `viewerState.texPanes`.

*Minor gaps left as they are*
- S1: ordering against non-lane sync commands is gone (only briefly stale reads found); a panicking lane job leaves its promise pending (a quit could stall).
- S2: no Rust unit test for `file_size_local`.
- S3: a window dying mid-build leaves `compilingByPath` raised — that PDF never sleeps (S3) and, since S9, its pane never unloads; a PDF restored hidden at launch still parses once; the unsaved-markup hold is untested; (#231 reattach scroll: moot for sleepable viewers since S9).
- S4: `SteeringLegend`/`useKeyboard` read no terminal for the frame before first open; a busy row that never repaints would drop a sent prompt in the Reader; the phone still reads 1200 rows; first bill tick after a long idle books 0; `isTabLookedAt` unions popout and scope keys; a shell tab's text-less frames count as text.
- S5: the pending cap cuts at a char boundary (a mode split across it is lost); 8-bit C1 controls are text to the tokenizer; `?47h`/`?1047h` are not cuts; staggered ≥ 500 ms cadences approach one event per PTY.
- S6: `TabAgentModeMarks` subscribes to the whole mode maps (badge-only re-render); `FileTree.tsx` comment above `tooltipTimer` still says rows are not memoised.
- S7: one folder spelled two ways by two trees re-creates the one watcher for the last asker; a full Git-view reading landing after a newer dot probe overwrites and stamps it.
- S9: a hold raised in the same few ms the sleep timer fires can lose to it.
- S10: root tabs never unload while the root console is open; the launch hold keeps a pane awake while the HPC/unfenced question is open; mode marks / model tag fall back to transcript/tmux while asleep.
- S11: watches leaked by a reload or closed popout stay armed (bounded by the 128 cap, evicted first); ProxyJump masters show no counters (as before); "skip agent-auth homes with no live tab" (§7.3) still open.
- S12/final: leaving the window from *inside* a sandboxed (opaque-origin) iframe is not seen until the next focus change there — polls run on meanwhile (fails open, as before S12).
- Final: `DeckPresenter.closeAudience` closes `presenterLabel(path)`, not the recorded `audience` label — a deck renamed mid-talk leaves its audience window open on D/Exit (pre-existing, not in the range). Fixed in S13 (`9a48f8a1`).
- Fixed: S6 schedule tooltip (`e10c5fe8`); S8 Machines off mid-add (`bd8004f3`); S9 deck audience window on unmount (`a0703586`); S9 help text (S10); S12 iframe focus (`edaad214`); S12 startup focus (`dc9dd67e`).

*Landing*
- `npm run backend:stale` after landing (S1 lane, S2 `file_size`, S5/S10 terminal router, S7 git/fs_watch, S9 settings field, S11 commands + sampler). New frontend on an old backend: a program that exits while asleep wakes to a blank pane, the Reader polls every 2 s, a symlink-spelled `projectDir` ignores `fs-change` until rebuilt.
- Merge conflicts expected with the main checkout's uncommitted edits in `TabBar.tsx`, `TerminalView.tsx`, `TerminalReaderView.tsx`, `tabs.ts`, `FileViewerPane.tsx` (S2's `TexView.compile` hunks), `lib.rs`, `agent_auth.rs`; check `ProjectFilesView.tsx`, `FileTree.tsx`, `MobileIndicator.tsx`, `projects.ts`, `commands/git.rs`, `fs_watch.rs`. The main checkout's untracked `scripts/perf-numbers.sh` / `docs/performance_numbers.md` collide with the branch's.
- `MobileHeldPromptStore.test.ts` (date time-bomb, 2 failures) is being fixed in the main checkout, not here.

### S13 (follow-up fixes, 2026-10-09)

The user's decisions on the final review's flagged list (recorded above);
four of them needed code. Worktree, branch `perf`, on top of `7746648d`.
Nothing run live.

| Commit | What | Regression test |
|---|---|---|
| `9a48f8a1` | Deck: `closeAudience` closes the recorded `audience` label, not `presenterLabel(path)` — a deck renamed mid-talk no longer leaves its audience window on the projector on D / the second-display toggle / Exit. The in-flight open (`a0703586`) already closes the label it opened (captured before its await). | `deck/DeckAudienceUnmount.test.tsx` "after a rename mid-talk" (2) |
| `81077229` | Terminal: a launch that ends without a PTY (spawn error, declined HPC / unfenced-platform question) keeps its `PaneSleepHoldContext` launch hold, so the pane never sleeps and nothing re-spawns on a wake; the effect cleanup (close, relaunch) lifts it. | `terminal/TerminalSleepWake.test.tsx` "a launch that failed keeps holding the pane awake" |
| `2198c80a` | Glass themes: `--glass-panel` (the fill of the unblurred tab bars and docked file column; `--glass-subheader` mixes over it) 0.6 / 0.58 → 0.9 alpha in `fancy_dark` / `light_lavender`. No blur, no shadow. | `theme/GlassChromeBlur.test.ts` "glass chrome fill without the blur" (2) |
| `b13a0df5` | TeX workspace sub-panes (`<key>#<path>`) persist in the workspace tab's `viewerState.texPanes[path]` through the §3.1 stage, the popout edit and the viewer seed (`persistedViewerState`); at most `TEX_PANES_CAP` = 32 paths, least recently written dropped; gone with the tab. Sibling: PdfView's popout-mirror hold now asks for the workspace tab, not the sub-pane key. | `viewers/ViewerStateTexPanes.test.tsx` (5); `windows/DetachedTwoHeap.test.ts` sub-pane dock-back; `pdf/PdfSleepHidden.test.tsx` workspace PDF pane (2) |

Gates (worktree, at `b13a0df5`): build ok (`bootstrap-*.js` 3,352.53 kB /
gz 985.56 kB); vitest 765 files / 7764 tests, all pass; lint 0 errors /
28 warnings; brand-check ok; privacy-check `7746648d..HEAD` ok; diff
--check clean. No Rust touched (cargo/clippy not rerun).

Flagged: a sub-pane's per-tab settings (a child file's `fontSize`, AI
toggles, breakpoints) now persist in `texPanes` too, since they go through
the same `setViewerState` — before, they were dropped. A workspace's
`texPanes` entries for files no longer in the structure are inert until
they age out of the 32 cap (no structure-driven pruning). The glass fill
is 0.9 in both themes, picked without a live look.

### Review (S13 reviewer, 2026-10-09)

Range `7746648d..8e40abf4`. Nothing run live.

**Checked**
- `texPanes` round-trip: the backend keeps `viewerState` opaque
  (`schema/project.rs` `TabEntry.extra`, flattened `Value`), so the field
  survives `workspace_sync` and the legacy save; `restoreSavedTab` copies it;
  a session without it reads as no entry; no other persisted shape changes.
  `toSavedTabEntry` folds staged `<key>#<path>` positions in, so a quit inside
  the 5 s interval keeps them; `duplicateSpec` carries them.
- Popout: the popout writes its seed registry under the workspace tab's key
  (`withViewerPatch`) and forwards the raw sub key; the main side's
  `applyDetachedEdit` stages / writes through with the same split. Reseeds
  flush first. The only composite pane key in the tree is `centerFor`'s.
- Cap: re-writing an entry moves it last; deduped writes do not bump it.
  Within one flush interval the order is first-staged, not last-written (the
  stage is a Map) — immaterial at 32.
- Close with sub-pane state staged: the flush drops it (no tab); the
  unmount flush of the sub-pane runs after the tab is gone and is a no-op.
- Launch hold: lifted on any PTY (first spawn, unfenced retry, HPC retry),
  on cleanup (close, relaunch via `relaunchSeq`, identity change), on Strict
  Mode's synthetic cleanup; never taken by attach-only or waking mounts.
- `--glass-panel`: read only by `.subwindow-files` and through
  `--glass-subheader` (`--subwindow-header-bg`, the tab bars), both only
  under the two glass themes; dialogs/menus use `--glass-elevated`, the side
  panel `--bg-side-panel`. The Theme Customizer lists the token by name only.

**Fixes**
| Commit | Bug | Regression test |
|---|---|---|
| `34459a71` | Pre-existing, flagged by the implementer: the HPC connect-then-spawn retry set `ownsPty` but left `spawnState` "failed", so a tab started after the user chose Connect never got the silent-start notice. The S13 hold already lifted there (`ownsPty`); the test pins both. | `terminal/TerminalSilentStart.test.tsx` "speaks for a tab the HPC connect-then-spawn retry started" (fails unfixed) |

QA rows: `todo/group-u-performance.md` 2414 (S13.1–S13.4).

**Gates (worktree, after the fix)**: build ok (`bootstrap-*.js` 3,352.54 kB
/ gz 985.56 kB); vitest 765 files / 7765 tests, all pass; lint 0 errors /
28 warnings; brand-check ok; privacy-check ok; `git diff --check` clean. No
Rust touched.

**Flagged for user**
- Each sub-pane flush now changes the workspace tab's `viewerState`, so the
  TeX workspace (and its centred viewer) re-renders once per flush (≤ every
  5 s while scrolling a child file or the PDF centre), as the main document's
  own pane already did. Not measured.
- A failed-spawn pane is held awake until relaunch/close, including a
  declined HPC question — by the decision; a later Connect from the pill does
  not retry that tab by itself (it never did).

## Resume state (paused 2026-10-07, 11:40 CEST; S1–S12 implemented + reviewed by 2026-10-09; final review done 2026-10-09; landed on develop 2026-10-09)

The run was paused by the user after S6's implementer and partway through
S6's reviewer; a second S6 reviewer finished the review on 2026-10-08.
Everything is on branch `perf` in worktree
`.claude/worktrees/perf`; the main checkout is untouched (its
`docs/performance_plan.md`, `docs/performance_numbers.md` and
`scripts/perf-numbers.sh` are untracked copies/tools; S12 put the latter two
on the branch, so delete or overwrite the main checkout's copies when landing).

- Done, implemented + reviewed: S1 (backend quick wins), S2 (PDF render +
  reload), S3 (viewer state + hidden PDF release), S4 (terminal frontend),
  S5 (terminal backend), S6 (many-tabs memoisation: 45bcd8a9, cdd2a37f,
  91e780de; review fixes e10c5fe8, 3e067ec6, 8d274703, 11bc2c3c — see
  `### Review (S6 reviewer, 2026-10-08)`).
- Done, implemented + reviewed: S7 (pollers, git dots, launch chain:
  87b10d07, ee376977, d551f300; review fix 3934cd7e — see
  `### Review (S7 reviewer, 2026-10-08)`).
- Done, implemented + reviewed: S8 (bundle + thin LTO: 2e570eab,
  e5c8a0bd, 42ae9aa1, 4273a1cc, f1c7281f; review found no bug — see
  `### Review (S8 reviewer, 2026-10-08)`; thin LTO keep/revert is the
  user's call).
- Done, implemented + reviewed: S9 (sleeping tabs I: 6dbbafed,
  b1761c56; review fixes 96397d6d, 69eef2a4, 0cd729e0 — see
  `### Review (S9 reviewer, 2026-10-08)`).
- Done, implemented + reviewed: S10 (sleeping tabs II, terminal kinds:
  300c8d76, 45ba7dd8, 4df49caa, 16b40766; review fixes 8fa6b60b,
  2e5e8108, 0b584a7c — see `### Review (S10 reviewer, 2026-10-08)`).
- Done, implemented + reviewed: S11 (backend structural: f637fa9d,
  84cd8be0, 39686cac; review fixes 8244017d, 64e680bb, 64eb3ce8, 8622f907,
  e496fd1b — see `### Review (S11 reviewer, 2026-10-08)`).
- Done, implemented + reviewed: S12 (poll helper + QA rows: 528a5066,
  2d051ccc, 70628b5e, 4761558e, 14f4ff41, d804ab39, 778585a4; review fix
  e114dc6c — see `### Review (S12 reviewer, 2026-10-09)`);
  `scripts/perf-numbers.sh` and `docs/performance_numbers.md` are now on the
  branch.
- Done: the final whole-range review (2026-10-09; fixes a0703586, edaad214,
  dc9dd67e, 2bdc8ec2, filemap 23633fad — see `## Final review (2026-10-09)`).
- Landed on `develop` 2026-10-09 by fast-forward to the merge `cd238b86`
  ("Merge develop into perf": 52 develop commits since base `a6ed2c7a`;
  conflicts in `agent_turn.rs` (Linux `proc_table` scan + develop's macOS
  probe walk), `agents.rs`, `agent_auth.rs`, `network.rs`, `TerminalView`,
  Reader views, `AppShell`, `TabPane`, filemaps; `TerminalDrop.test` given a
  layout for the lazy xterm). Gates on the merge: build ok; vitest 764 files
  / 7751 tests all green (`MobileHeldPromptStore` fixed on develop); cargo
  lib 3653 passed, 3 ignored, every target green; lint 0 errors / 28
  warnings; clippy clean; Windows `cargo check` (shims) ok; brand-check ok;
  privacy-check ok. Also on the branch: the user-requested Machines sign-in
  fix `bd8004f3` (S8 follow-up). Owed: `npm run backend:stale`, the frozen
  dev build, the user's click-through (`todo/group-u-performance.md`
  2400–2413) and the flagged decisions under `## Final review`.
- Done: S13 (2026-10-09, on `perf` after the landing, not yet on
  `develop`): the user's decisions on the flagged list recorded, and the four
  that needed code — `9a48f8a1`, `81077229`, `2198c80a`, `b13a0df5` (see
  `### S13`). Owed: `git merge --ff-only perf` on `develop`, the frozen dev
  build, a click-through (no backend change, so no `backend:stale`).
- Gates at the S6 review's HEAD (11bc2c3c): build ok; vitest 741 files /
  7583 tests, 2 failing in `MobileHeldPromptStore.test.ts` (date time-bomb,
  not this run's — S6 review Flagged); cargo lib 3578 passed; lint 0 errors /
  28 pre-existing warnings; clippy clean; brand ok; diff --check clean.
- Gates at S7's HEAD (d551f300): build ok; vitest 744 files / 7602 tests,
  the same 2 `MobileHeldPromptStore` failures; cargo lib 3580 passed; lint
  0 errors / 28 warnings; clippy clean; brand ok; diff --check clean.
- Gates at the S7 review's HEAD (3934cd7e): build ok; vitest 744 files /
  7603 tests, the same 2 `MobileHeldPromptStore` failures; cargo lib 3580
  passed; lint 0 errors / 28 warnings; clippy clean; brand ok; diff --check
  clean.
- Gates at S8's HEAD (f1c7281f): build ok (bootstrap 3,319 kB / gz
  974 kB); vitest 745 files / 7607 tests, the same 2 `MobileHeldPromptStore`
  failures; cargo lib 3580 passed; lint 0 errors / 28 warnings; clippy
  clean; brand ok; diff --check clean.
- Gates at the S8 review (6ce56f89 + review doc): identical to S8's HEAD
  (build ok, bootstrap 3,319 kB; vitest 745 / 7607, same 2 failures; cargo
  lib 3580; lint 0 / 28; clippy, brand, diff --check clean).
- Gates at S9's HEAD (b1761c56): build ok (bootstrap 3,321 kB / gz
  975 kB); vitest 747 files / 7619 tests, the 2 `MobileHeldPromptStore`
  failures + a `MobileIndicator` load flake (passes alone); cargo lib 3581
  passed; lint 0 errors / 28 warnings; clippy clean; brand ok; diff --check
  clean. `npm run backend:stale` owed after landing (settings field).
- Gates at the S9 review's HEAD (0cd729e0): build ok (bootstrap 3,321 kB /
  gz 975 kB); vitest 750 files / 7623 tests, the 2 `MobileHeldPromptStore`
  failures + the `MobileIndicator` load flake (3/3 alone); cargo lib 3581
  passed; lint 0 errors / 28 warnings; clippy clean; brand ok; diff --check
  clean.
- Gates at S10's HEAD (16b40766): build ok (bootstrap 3,325 kB / gz
  976 kB); vitest 751 files / 7638 tests, the 2 `MobileHeldPromptStore`
  failures (129 load timeouts at load ≈ 60 all pass alone); cargo lib 3587
  passed; lint 0 errors / 28 warnings; clippy clean; brand ok; diff --check
  clean. `npm run backend:stale` owed after landing (terminal router).
- Gates at S11's HEAD (39686cac): build ok (bootstrap 3,326 kB / gz
  976 kB); vitest 752 files / 7649 tests, the 2 `MobileHeldPromptStore`
  failures; cargo lib 3606 passed; lint 0 errors / 28 warnings; clippy
  clean; Windows cross-check ok; brand ok; diff --check clean.
  `npm run backend:stale` owed after landing (new commands, sampler).
- Gates at the S11 review's HEAD (e496fd1b): build ok (bootstrap 3,326 kB /
  gz 976 kB); vitest 752 files / 7649 tests, the 2 `MobileHeldPromptStore`
  failures; cargo lib 3610 passed (all targets 3778); lint 0 errors / 28
  warnings; clippy clean; Windows cross-check ok; brand ok; diff --check
  clean.
- Gates at S12's HEAD (778585a4): build ok (bootstrap 3,327 kB / gz
  977 kB); vitest 753 files / 7671 tests, the 2 `MobileHeldPromptStore`
  failures; cargo lib 3610 passed (all targets 3778; two `git_bounded` FIFO
  tests flaked once under load, green alone and on rerun); lint 0 errors /
  28 warnings; clippy clean; brand ok; privacy ok; diff --check clean.
- Gates at the S12 review's HEAD (e114dc6c): build ok; vitest 754 files /
  7674 tests, the 2 `MobileHeldPromptStore` failures; cargo lib 3610 passed
  (all targets 3778); lint 0 errors / 28 warnings; clippy clean; brand ok;
  privacy ok; diff --check clean.
- Gates at the final review's HEAD (2bdc8ec2): build ok (bootstrap 3,327 kB /
  gz 977 kB); vitest 755 files / 7681 tests, the 2 `MobileHeldPromptStore`
  failures; cargo lib 3611 passed (all targets 3779); lint 0 errors / 28
  warnings; clippy clean; Windows cross-check ok; brand ok; privacy ok
  (a6ed2c7a..HEAD); diff --check clean.
- Process gotchas learned: run cargo in the FOREGROUND (background shells
  have no cargo on PATH and die silently — S5's implementer hung on it); an
  `until grep -q …` wait loop gets rewritten to `rtk grep -q` by the shell
  hook — avoid wait loops on marker files; under machine load ≈60–90 a few
  timing tests (`PdfZoomRaster`, `api_usage`) flake — rerun alone.
- Baseline numbers are at the top of `docs/performance_plan.md`; take
  `scripts/perf-numbers.sh after-<step>` from the main checkout after each
  dev build (stopwatch lines still unfilled).
