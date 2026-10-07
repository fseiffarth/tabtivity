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
