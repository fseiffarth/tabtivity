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
Range reviewed: `c7f6149e..7c63373b` (3c745d9, f24adf80, 7c63373b). Nothing
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
