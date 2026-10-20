# SyncTeX simplification + fixes — plan

> Archived 2026-10-15: historical plan or handoff for work implemented on `develop`.
> Original status notes below describe the implementation run at the time.
> Pending live and platform checks are still pending; see the [archive index](README.md).

Two analysts reviewed SyncTeX on 2026-10-14: one looked for simplifications,
the other for bugs. They then critiqued each other's findings, and this plan
merges the result. The line numbers refer to the tree as of that date, so
re-check them before editing.

## Decisions

- **Drop the `synctex` CLI in both directions.** Native search covers every
  case the analysts probed (pdfTeX/XeTeX/LuaTeX, near-empty pages, spaced
  names). Running the CLI as a fallback would bring back the cross-file
  box-tag artefacts. It also bypasses the 512 MB inflate cap and spawns a
  process with a 10-minute timeout.
- **Native forward search takes over the CLI's nearest-line rule.**
- **Reverse search has no column.** The CLI printed `Column:-1`, which parsed
  to 0. Fix the doc at tex.rs:2448.
- **One set of sync notices for both directions** (`noMap`/`pdfNewer`/`stale`/`miss`
  + `noPdf`). Nothing says "PDF updated" unless a compile ran.
- **Skipped:** the shared cross-window broadcast helper (separate cleanup later),
  a per-map index, a "show caret in PDF" key, and the reveal into a hidden pane
  (not reproduced).

## Steps

### 1. Consolidate the backend (synctex.rs, tex.rs, lib.rs, filemap)

- Move `synctex_edit`, `synctex_status`, `synctex_view`, `synctex_page_lines`
  and `SyncSource`/`SyncRect` from tex.rs into synctex.rs. `view` returns
  `SyncRect` directly.
- Command names stay the same, so `command_class` and `commandClasses.ts`
  don't change. Keep the lib.rs:2165-2168 hunk to the path change only:
  other sessions are editing lib.rs.
- `synctex_view` → `async` + `try_blocking`, like `synctex_edit`. Drop its `column` parameter.
- Split `load_map` into a bounded `read_map(path, cap)` plus the cached wrapper.
  `synctex_page_lines` uses the **uncached** bounded reader, so a deck load
  doesn't evict the focused PDF's map. Find the main tag by stem over
  `pre.inputs` instead of `main_input_tag`, and reuse `parse_record` instead
  of `parse_record_tag_line`.
- `resolve` and `resolve_pages` share one per-point helper. Keep the public
  `resolve`, which `examples/synctex_probe.rs` uses.
- Tests: move tex.rs:3336-3385 + the `SYNCTEX` fixture. Add a tiny-cap test:
  an oversized `.gz` gives no lines.
- Update the docs/filemap_backend.md rows for tex.rs/synctex.rs (one line each).

### 2. Native forward search (synctex.rs)

- `input_tag` → `input_tags` (a set):
  1. every tag whose `absolutise(path)` == `absolutise(target)` (a file `\input`
     twice has two tags);
  2. basename fallback only when (1) is empty, the recorded path no longer
     exists on disk, and exactly one distinct recorded path has that basename;
  3. otherwise nothing: an honest miss, never another file's line.
- Box matching. A "surviving leaf" is one that survives `trim_line_fill`, is not
  an ancestor-tag artefact and is not a nested box's own record. Add an
  `is_box` flag to `Rec`. Rules, in order:
  1. boxes with a surviving leaf exactly at (tag, L);
  2. otherwise, boxes tagged (tag, L) whose surviving leaves are all from the
     same file (keeps "blank line after a paragraph → that paragraph", as the
     CLI does);
  3. otherwise the nearest line: the smallest surviving line ≥ L in that file,
     else the largest < L (rule 1 again for that line);
  4. otherwise a box tagged (tag, ·) whose material is the same file or empty
     (**check XeTeX**: its lines hold only `g`/`k`/`h`, so make sure
     `trim_line_fill` doesn't leave a XeTeX document with no surviving leaves);
     never a box whose material belongs to another file;
  5. keep only the innermost: drop a rect that contains another hit rect on the
     same page.
- Delete the `synctex_view` CLI fallback, `parse_synctex_view` and its tests
  (tex.rs ~3791-3830).
- Tests:
  - DOC fixture: intro.tex:1 → the intro:4 box, not main:3; second.tex:1 → not
    box (6,1)'s tag-5 material.
  - LUATEX fixture: 295:1 → one rect; 1:33 → not the artefact.
  - A single-file fixture: comment line, blank line after a paragraph, preamble
    line, past `\end{document}` → last line.
  - Double `\input` hits both tags; ambiguous basename → none; moved tree +
    unique basename → hit.
  - Flip the `main.tex:999 → empty` assertion (synctex.rs ~1141) to "last line".

### 3. Reverse search without the CLI, and path spelling (synctex.rs, markup.rs)

- Delete `parse_synctex_edit`, the `on_path`/`run_in` fallback and its tests
  (tex.rs ~3764-3789). Delete any helper left unused.
- `absolutise`:
  - The engine records its physical cwd, so a lexical cleanup is not enough.
    Re-root instead: for each ancestor A of the caller's PDF dir (as the caller
    spelled it), if `canonical(input)` starts with `canonical(A)`, return
    `A.join(rest)`.
  - Strip `\\?\` via `commands::fs::display_path` (fs.rs ~2358).
- markup.rs ~1319 strips against `root.canonicalize()`. Make it strip against
  `root` as spelled (falling back to canonical) so the project-relative
  `file:line` still resolves.
- Tests:
  - A `#[cfg(unix)]` test: a symlinked project dir keeps the caller's spelling.
  - The markup.rs ~1744 test still passes.
  - Paths are built with `Path::join` (cross-OS).

### 4. Frontend forward search (tex.ts, FileViewerPane.tsx)

- Delete `synctexViewBest`, `forwardInputCandidates`, `forwardRelative` and their
  tests (TexSync.test.ts ~479-530). Call `synctexView` once, without `column`.
- Merge the two forward blocks (FileViewerPane.tsx ~9796-9811 and ~9912-9930)
  into one helper. The compile reveal uses a **snapshot of the draft taken
  together with the caret** at compile start (~9843): typing during the build
  must not move the reveal.
- `pickSyncRect`: group by page (the first page with a hit), then apply the
  column fraction.
- Tests: page grouping; drop `column: 2` at TexViewer.test.tsx ~610; typing
  during a compile still reveals the snapshotted line.

### 5. One set of notices (tex.ts, FileViewerPane.tsx, PdfViewer.tsx, i18n)

- Forward search calls `synctexStatus` and `syncNoticeKind` the way reverse
  search does, plus `noPdf`.
- `stale` shows even on a hit. Ctrl+click also counts a dirty draft as stale
  (Compile saves first).
- A rejected IPC call reads as `miss`. Remove `fileViewer.syncUnavailMsg`.
- Reword `pdfViewer.syncNoMapMsg`/`syncPdfNewerMsg` so they work for either
  direction, and reuse them. Rewrite `fileViewer.syncMissMsg` without
  "PDF updated —".
- i18n: English holds every key; update de/es/fr/it. Those dictionaries are
  also being edited by other sessions, so touch only these keys.
- Tests: adjust TexViewer.test.tsx ~405-475; forward search uses `syncNoticeKind`.
- The forward stale notice is new behaviour: give it an `UntestedTag` and a row
  in `src/lib/untested.ts`.

### 6. Rotation (tex.ts, PdfViewer.tsx)

- Do all SyncTeX math in unturned page space (`pageTextItemBoxesUnturned` for
  the word refinement at PdfViewer.tsx ~1138, which today passes no `rot`).
  Convert only at the click and at render time, through the turned viewport
  (`convertToPdfPoint` / `convertToViewportRectangle`), allowing for the
  crop-box origin.
- Leave the Ctrl+F and link callers of `bigPointsToCssRect` alone: their boxes
  are already in turned space.
- Tests: pure conversion tests with a fake viewport at 0/90/180/270°.
- No pill (it's a fix). Live check: a pdflscape page, and a page turned in the
  viewer, in both directions.

### 7. Highlight under reduced motion (PdfViewer.tsx)

- Clear `highlight` after ~2.2 s, like `clickMark`; viewers.css ~5620 says "briefly".
- Fake-timer test.

### 8. Small follow-ups, if 1-7 land cleanly

- Remote: the `syncable` probe uses remote-aware `fileMtime`, but the synctex
  commands read local disk. Add an explicit remoteness gate (mirror paths stay
  local; a remote non-mirror PDF shows "not available for remote projects" and
  makes no call).
- `markup::source_lines` (~1298): drop lines whose source is in `newer_sources`
  (stale line numbers sent to the agent).

## Live checks for the user

- Ctrl+click from a comment line, a blank line and a line in an `\input`
  chapter: the highlight lands on the right paragraph.
- Click in the PDF on a symlinked project: the jump goes to the already open
  tab, with no duplicate.
- A landscape (pdflscape) page: click and highlight are both on target.
- Reduced motion on: the highlight disappears after about 2 s.
- Ctrl+click with unsaved edits: the stale notice appears.
