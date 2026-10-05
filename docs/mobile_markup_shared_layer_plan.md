# Phone markup: one layer per project file, Clear all, jump between marks

Three phone-markup changes, asked for together (2026-10-04).

## 1. A PDF sent into the chat opens the same marks as the side panel

### Problem

The phone keeps a markup layer per record key (`mobile-web/src/markup/store.ts`
`layerKey`):

- side panel / files drawer (`ProjectFiles` → `OutboxViewer` with
  `scope = { files: projectId }`): `${projectId}:files:${place}/${name}`
  (`place` = folder trail, `""` at the root, so a root file is `…:files:/a.pdf`)
- a file `tabtivity-send` put in the chat (`Terminal` `outboxOpen`, the project
  screen's outbox shelf `Project.tsx:657`, the Focus banner's `markupAskFile`):
  `${projectId}:outbox:${leaf}` — the leaf is a stamped **copy** in
  `.tabtivity/outbox/`.

So the same `paper.pdf` has two unrelated layers, and marks made from the side
panel are missing when the reader opens the PDF from the chat. The copy also
loses SyncTeX lines at Submit (`markup.rs` `source_lines`: "an outbox copy has
no map beside it") and Reload looks for a newer *copy*, not the file.

The outbox copy does not know where it came from. Fix: record the origin when
sending, and let the phone open the project file itself whenever the origin is
a file the files drawer would show.

### Backend

1. `scripts/tabtivity-send.sh` — for file sends (not `-n` stdin), work out the
   source's project-relative path: physical dir via `cd "$(dirname -- "$source")"
   && pwd -P`; if it is `$root` or below, `rel=<dir minus $root>/<basename>`
   with the leading `/` dropped. Skip it when `rel` starts with `.tabtivity/`
   (re-sending an outbox file) or contains a newline. Pass it into `send_one`.
   Publish it as a second marker `.<leaf>.src` exactly like the tab marker
   (write in `$stage`, `mv` into place before the `link`, removed again if the
   link fails, `cleanup` also removes `$stage/src`), and extend the free-leaf
   loop to require `.$leaf.src` absent too. `--clear` already removes dotfiles.
   The script is `include_bytes!`'d by `services/agent_bin.rs`; no other change
   there.
2. `services/mobile_control/outbox.rs`
   - `fn source(dir, name) -> Option<String>`: read `.<name>.src` via
     `open_regular` (no links), bounded (4096 bytes), trimmed, non-empty,
     not under `OUTBOX_DIR`. Shape-check only; `files::entry` re-proves it.
   - `OutboxFile` gains `#[serde(skip)] pub source: Option<String>` (the raw
     path never crosses as such) filled by `list_for`.
   - `remove()` also deletes `.<name>.src`, like the sender marker.
   - Tests: marker read; linked marker ignored; removed with the file;
     missing marker → `None`.
3. `services/mobile_control/host.rs`
   - Factor the row-building body of `markup_banner_files` into one helper
     (e.g. `fn file_row(root, rel, key, raw_id) -> Option<MobileMarkupFile>`)
     and use it from both places.
   - `outbox_listing` (both the tab and the project route) serialises each
     file with `file_row` set from `source` — only when
     `files::files_open(state_dir)` and the scope is a real project (same
     gates as `markup_banner_files`), else absent. Thread `state`/raw project
     id in as needed; keep the directory walk and the sealing inside the one
     `spawn_blocking`. JSON shape: the existing file fields plus optional
     `file_row` (`protocol::MobileMarkupFile`).
   - A test for the listing route if the host tests have a harness for it;
     otherwise unit-test the helper.

### Phone

4. `mobile-web/src/api.ts`: `OutboxFile` gains `file_row?: PhoneMarkupFile`
   (document it as the project file this copy was sent from, sealed).
5. Move the "list the folder again for a fresh row" Reload
   (`Terminal.tsx` `refreshAskedFile`) into a reusable helper (e.g. in
   `OutboxViewer.tsx` or `api.ts`: `refreshProjectFile(projectId, folder)` →
   `(file) => Promise<OutboxFile | null>`) and use it from `Terminal` too.
6. `OutboxViewer.tsx`: when `file.file_row` is set, the scope is not already
   `files`, and the target project (`markup?.projectId ?? fresh?.projectId`)
   is a real project id (not the `tab:<id>` fallback), the **PDF reader** and
   the **Mark up** `MarkupView` (images too) open the project file instead of
   the copy: `scope = { files: projectId }`, file =
   `{ name, kind, size, modified, ref: token }` from the row,
   `place = row.place`, `refresh` = the helper from 5 with `row.folder`.
   Everything else (picture stepping, Save, Share of a picture in plain
   viewing) stays on the copy. Without `file_row` (drawer switched off, piped
   send, file outside the project) behaviour is unchanged.
7. One-time adoption of marks already drawn on the copy: `MarkupView` gets an
   optional `adoptFrom` key (the copy's outbox key). In the load effect, when
   the files key has no stored layer and `adoptFrom` has one, move it over with
   the existing `moveLayer` (check its contract) and show it. Never merge two
   non-empty layers; the files layer wins.
8. Untested pill + register row (`src/lib/untested.ts`), e.g.
   `mobile.markup.sharedLayer`, shown in the viewer title when the swap is in
   effect.

## 2. Clear all my marks

9. `markup/layer.ts`: `clearAll(layer, sent = false): Layer` — drops every
   pending page; with `sent`, the sent layer too (mirror `clearPage`'s
   semantics). Unit tests beside the existing `clearPage` ones.
10. `MarkupView.tsx` "more" popover: a **Clear all marks** button next to
    **Clear page N** (same markup/class/icon `⌧`), committed through
    `commit(...)` so Undo brings it back, disabled when there is nothing to
    clear (pending empty and — when `showSent` — no sent marks). Closes the
    popover. i18n key `mobile.markup.clearAll` (English holds it; add it
    wherever the other `mobile.markup.*` keys live). Untested pill + register
    row `mobile.markup.clearAll`.

## 3. Jump from mark to mark (PDF)

11. `markup/layer.ts`: a pure helper listing every visible mark's anchor in
    reading order — `(page, y)` with `y` the top of the mark's bounding box in
    its page's own units (`PageLayer.size`); pending marks always, sent marks
    when `showSent`. Unit tests (ink / box / text, multiple pages, sorted).
12. `MarkupView.tsx`, PDFs only, shown whenever that list is non-empty, in
    reading and in marking mode: **Previous mark** / **Next mark** buttons.
    Next = first anchor strictly below the current reading line
    (`scrollTop + viewHeight / 3`, converted per page with
    `places[n-1].top + y * cssWidth / size[0]` — the same maths as `showPin`),
    Previous = last anchor strictly above it, minus a few px of slack so a
    repeated tap moves on. Scroll exactly as `showPin` does (`scrollTo` with
    the `scrollTop` fallback). Disable each end when there is nothing further.
    Optional: reuse `pinFlash`-style brief highlight only if it is cheap.
    Placement: a small floating pair at the right edge of the page area,
    above the palette, styled by an existing button class (copy a sibling —
    the palette's `.markup-toolbar button` look); never a new visual
    treatment, never an animated blurred `box-shadow`. i18n
    `mobile.markup.prevMark` / `mobile.markup.nextMark`; untested pill +
    register row `mobile.markup.jump`.

## Tests

- Rust: `outbox.rs` marker tests; host helper/route test.
- `src/__tests__/mobile/MobileMarkup.test.ts` (layer helpers),
  `MobileMarkupView.test.tsx` (Clear all + undo; jump buttons scroll),
  an `OutboxViewer` test that a file with `file_row` opens `MarkupView` on the
  `files` scope and key, and that an existing outbox layer is adopted.

## Gates / delivery

All gates in `AGENTS.md`, `npm run mobile:bundle`, `npm run backend:stale`
(report its result), `scripts/brand-check.sh`, `git diff --check`. Docs: the
`docs/context/markup_mcp.md` / `docs/help/mobile.md` sentences about where marks
live, and `docs/filemap_*` rows only if a load-bearing file changes shape. Not
committed here (the tree carries other sessions' uncommitted work).
