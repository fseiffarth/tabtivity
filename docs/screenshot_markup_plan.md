# Screenshot markup: capture, mark up, send to the agent tab

Status: **plan only** (2026-10-23), nothing built. TODO #2425 in
`todo/group-m-viewers.md`. Builds on the desktop PDF markup
(`docs/done/pdf_markup_rounds_plan.md` §2.6, `docs/done/markup_tools_plan.md`)
and the screenshot staging flow (`src-tauri/src/commands/screenshot.rs`,
`ScreenshotSaveOverlay`).

> **2026-10-26 — the "built" pieces below were deleted.** The code screen
> (`docs/code_screen_plan.md`, step 15) removed the unreachable capture chain:
> `commands/screenshot.rs` (`capture_screenshot` and the pending-shot commands,
> the per-OS backends), `ScreenshotSaveOverlay`, `stores/screenshotPending.ts`,
> `lib/window/screenshot.ts`, `copy_png_bytes_to_clipboard` and the clipboard
> image-out helpers. Its trigger had gone with the header launcher (f1aa440a)
> and the PDF region capture. Building this plan starts from `git show
> <step-15 commit>^:src-tauri/src/commands/screenshot.rs` and the overlay, not
> from live code. The phone's "From the desktop" list is unaffected.

---

## 1. Context

The user's idea (2026-10-23): a screen-capture button inside Tabtivity and a
markup mode like the PDF one, for screenshots, to describe errors to an agent.

Decisions taken so far (AskUserQuestion, 2026-10-23):

- The button sits on the **agent tab's prompt strip**: capture → mark up →
  Submit goes to that tab.
- The old **`ImageAnnotator` is folded into markup**: an image viewer's
  Annotate opens the same markup mode; flatten-and-save becomes one action of it.

Most of the pieces already exist:

| Piece | Where | State |
|---|---|---|
| Region capture per OS, staged outside every project, clipboard copy | `commands/screenshot.rs` (`capture_screenshot`, `screenshot-captured`) | built; Linux tool or Wayland portal, Windows GDI whole screen, macOS `screencapture -i` |
| In-app capture (PDF viewer's region crop) as bytes | `lib/window/screenshot.ts` `requestInAppCapture`, `stores/screenshotPending.ts` `kind: "bytes"` | built |
| Consent step: pick project + folder, `tabtivity-screenshots/` gitignored before the write | `ScreenshotSaveOverlay`, `save_pending_screenshot` | built |
| Picture as a one-page markup source in the one bake path | `mobile_control/markup.rs` `bake_and_prompt` (`is_picture`, `request.picture`) | built, phone only |
| Picture rounds in the MCP: page 1, `m<mark>` refs, no pins, quote optional | `services/markup_mcp.rs`, `docs/context/markup_mcp.md` | built |
| Desktop markup: layer, pen bar, rounds, pill, Submit → queue + hold, questions, ticks, model chip | `embed/pdf/PdfMarkup{Layer,Bar}.tsx`, `usePdfMarkup.ts`, `lib/viewers/pdfMarkup.ts` | built, **PDF only** |
| Image annotate (pen/rect/arrow/text, flatten, save `-annotated.png`) | `embed/ImageAnnotator.tsx`, called from `FileViewerPane.tsx` image body | built, separate tool — no rounds, no Submit |

So the work is: let the desktop markup run on a single picture, route a
capture into it, and retire `ImageAnnotator`.

## 2. Design

### 2.1 Where the screenshot lives

A markup source must resolve through `markup::resolve_local_source`: a project
file or an outbox leaf (the inbox is hidden, so the MCP's `markup_done` /
`markup_ask` could not name it). The capture therefore goes through the
**existing Save path** first: into the chosen project's
`tabtivity-screenshots/` (or the folder the user typed), whose ignore line
`save_pending_screenshot` already ensures before the write. The PNG is then an
ordinary project picture. Submit puts the composed copy into the inbox the
way the phone does (`.tabtivity/` is gitignored too).

The overlay's preview is the consent step for what leaves the machine: the
user sees the whole shot before **Mark up**. Nothing is filed without the
overlay's answer, so `feedback_no_auto_file_into_projects` holds. No extra
warning dialog.

### 2.2 Backend: the desktop's Submit takes pictures (`mobile_control/markup.rs`, `commands/pdf_markup.rs`)

`submit_local_with_undo` today sets `picture: None` and documents "PDFs only".
Change:

- Read the source's kind as now. For `image/*` (not GIF, as on the phone):
  exactly one page `n = 1` with `composed: true`; its `layer_png` is the
  picture with the marks drawn on. Store it into the inbox as
  `<stem>-marked.png` (`inbox::store`), set `request.picture` to that
  reference, and add the page's layer reference as the phone does. Then the
  one `bake_and_prompt`. Everything stays checked before the first write.
- Size: a Windows whole-virtual-screen grab can be 7680×2160. The composed PNG
  must stay ≤ `MAX_LAYER_BYTES` (8 MB) and ≤ `MAX_LAYER_SIDE`. The frontend
  downscales the composed copy in steps (long side ×0.75) until it fits; the
  backend still refuses with `invalid_layer`.
- Mode (§4 decision 2): `undo_snapshot`
  drops its `!is_pdf → NotPdf` early return for pictures and calls
  `markup_rounds::begin(.., pdf: None)` (the outbox path already passes
  `None`), so the snapshot covers the project's work tree and Undo works as
  for PDFs.
- Instruction: the picture defaults of §4 decision 1 when the user set none.
- The command name stays `pdf_markup_submit`, since a rename would touch the
  command class table, the TS wrapper and the tests for no behaviour. Its doc
  comment and the `command_class` row's note say "PDF or picture".

### 2.3 Frontend: one markup session, two sources

`usePdfMarkup.ts` (1288 lines) mixes source-neutral state with PDF work.
Split it, don't fork it (`feedback_no_redundant_variants`):

- **`useMarkupSession`** (source-neutral, new file beside it): the IndexedDB
  layer keyed by project + absolute path, rounds and the sent log, targets
  (`agentTargets` / `defaultTarget` / chosen), the pill off `agentTabState`,
  Submit → `queuePromptForTab` + `holdPhonePrompt`, the questions (`markup_ask`
  card, `markup-mcp-changed`, pane-visible catch-up), ticks and approve, the
  model chip, Go to tab, `markupLinks` registration.
- **PDF adapter** (what is left in `usePdfMarkup`): pages from the viewer's
  doc, `markupPage.ts`, `anchors.ts` / `pageText.ts` words and text marks,
  disk-change reload under the marks, the apply/Undo UI.
- **Picture adapter** (new, in the image viewer): one page, `size` = the
  image's natural pixels, the compose step = `mobile-web/src/markup/rasterize.ts`
  over the decoded bitmap (the same drawing routine as the phone and
  `markup_pdf.rs`), no words. A disk change of the picture reloads under the
  marks (the same `diskChangeAction` rule; rare for a screenshot).

`PdfMarkupLayer` already takes `(n, size, scale, edit)` and is page-agnostic.
It mounts over the image at the viewer's zoom. `PdfMarkupBar` gets a
`source: "pdf" | "picture"` prop that hides what needs words (text-run marks,
snapping to text) and the PDF-only items. Pen, marker, dashed, arrow, box,
typed note, stamps, select, presets and eraser stay. Ticks: `PdfMarkupTicks`
works on pictures too (`docs/context/markup_mcp.md`: "PDFs and pictures
alike"). Questions: the card only, no pins (as on the phone).

Leave the `Pdf*` file names as they are; a rename is churn across tests and the
filemap. Update the filemap rows to say "PDF or picture".

### 2.4 ImageAnnotator folded in

- The image viewer's **Annotate** button becomes the same **✎ Mark up**
  toggle as the PDF viewer's (same class, `feedback_copy_working_sibling`).
- The picture bar gets **Save flattened copy…**: the composed PNG at full
  size (no downscale) via `writeFileBytes`, `<stem>-annotated.png`, or
  Overwrite when the source is a `.png`. That is `ImageAnnotator`'s save,
  same dialogs (`useDialogs`).
- Delete `ImageAnnotator.tsx` + `.css`, its lazy import and state in
  `FileViewerPane.tsx`, its i18n keys (all dicts) and tests. Grep
  `DeckObjectView.tsx`'s comment that cites it as the canvas precedent and
  point it at the markup layer.
- Losses to accept: the 7-colour palette narrows to the markup's four
  (red/blue/black/yellow), and free stroke widths become the pen bar's sizes.
  This follows `feedback_markup_keep_simple`.

### 2.5 The capture button on the agent prompt strip

- **📷** at the strip's right end (`terminal/TerminalPromptStrip.tsx`) on an
  agent / local-agent tab with a `scheduleTargetId`, in a **local** project
  (`pdf_markup_submit` refuses remote projects; see §5). Hidden in the
  assistant scope (Tabby has no file affordances) and while the AI switch ⏻ is
  off.
- Click → `capture_screenshot(exec)` with the global Screenshot app's
  configured `exec`, the same call the header menu makes. A small ▾ offers
  **In 5 s** (`startDelayedCapture`), because Tabtivity's window is usually
  the one on top when the error is in another app.
- The strip records the **origin** in the pending store:
  `PendingScreenshot.origin?: { projectId, scheduleTargetId }`, carried on
  both the `staged` and `bytes` shapes, plus `hintDir` = that project's dir.
  A capture from the header menu has no origin; the overlay still offers Mark up
  and Submit picks `defaultTarget`.

### 2.6 The overlay's third answer: Mark up

`ScreenshotSaveOverlay` gets **Mark up** beside Save and Discard:

1. Save exactly as Save does: the chosen project + folder + name, the
   gitignore line ensured, staged copy dropped.
2. Open the saved file in a file-viewer tab of that project with markup on.
   A one-shot intent in `stores/viewers/markupLinks.ts`
   (`requestMarkupOpen({ projectId, path, scheduleTargetId? })`) is consumed
   by the image viewer's session on mount. It turns marking on and preselects
   the origin tab when it belongs to the chosen project, else `defaultTarget`.
3. Disabled with a tooltip for a remote project (Save stays) and for a GIF.

The preselected project is the origin's when there is one (`hintDir`).

### 2.7 i18n, untested register, docs

- New keys in `i18n.ts` (English holds all) + de/es/fr/it: strip button and
  its ▾ item, overlay Mark up + its disabled tooltips, Save flattened copy,
  the picture instruction's Settings label. Delete the
  `ImageAnnotator` keys.
- `UntestedTag` rows in `src/lib/untested.ts`: `screenshot.markup` (strip
  button + overlay Mark up) and `image.markup` (picture markup in the image
  viewer, incl. flattened save).
- Filemap rows: `FileViewerPane` image body, `ScreenshotSaveOverlay`,
  `TerminalPromptStrip`, the markup rows (PDF or picture), `pdf_markup.rs`,
  `mobile_control/markup.rs` (desktop pictures). `docs/context/markup_mcp.md`:
  desktop pictures join the phone's.
- TODO #2425 gets its 🤖/🖐️ boxes with the four platform pairs.

## 3. Phases (each one a commit; gates per `scripts/gates.sh`)

| Phase | Scope | Tests |
|---|---|---|
| **S1** backend | §2.2: picture branch in `submit_local_with_undo`, mode rule, instruction | `mobile_control::markup` unit tests: picture submit stores `<stem>-marked.png` + layer, prompt is the picture prompt, `pages != [1]` and GIF refused, too-large refused before any write; apply round on a picture takes a snapshot and Undo restores the tree, list switch → list round; `cargo test --workspace`, both clippy lines, daemon build |
| **S2** split | §2.3 `useMarkupSession` + PDF adapter, **no behaviour change** | the existing `PdfMarkup*.test.tsx` pass unchanged (they are the safety net), test count unchanged |
| **S3** picture markup | §2.3 picture adapter + §2.4 fold-in | vitest: image viewer Mark up → marks → Submit calls `pdf_markup_submit` with one composed page and queues for the target; downscale loop; Save flattened copy writes `-annotated.png`/overwrite; ticks render on a picture |
| **S4** capture route | §2.5 strip button + §2.6 overlay Mark up + intent | vitest: button visibility (local agent tab yes; remote, assistant, AI-off no); origin carried through the store; Mark up saves then opens with the origin tab preselected; remote disables it |
| **S5** docs | §2.7 | `scripts/brand-check.sh`, `git diff --check` |

S2 must land before S3, and S1 before S3's Submit test against the real
command. S4 needs S3. Backend edits don't hot-reload: after S1 run
`npm run backend:stale` and report it.

## 4. Decisions (user, 2026-10-23)

1. **Instruction for picture rounds: a separate default** with its own
   Settings field beside the PDF one (Settings → Agents → PDF markup), since
   the PDF text talks about strike-throughs and rebuilding the PDF. In the
   backend: `DEFAULT_PICTURE_INSTRUCTION` / `DEFAULT_PICTURE_APPLY_INSTRUCTION`
   in `mobile_control/markup.rs`, mirrored in `mobile-web/src/markupInstruction.ts`
   with the same mirror test as the PDF pair. The phone's picture rounds get
   the new default too. List round: "The marks on this picture point at what
   I mean (a screenshot of a problem, or a design to change). Say what you
   see, find the cause in this project, and list the changes you would make —
   do not change files yet." Apply round: "…find the cause in this project
   and fix it; afterwards list what you changed, and any mark you could not
   read."
2. **Apply rounds for pictures follow the Apply marks directly switch**
   (`pdf_markup_direct`, on when unset), with a project snapshot and Undo
   (§2.2). S1 removes the `NotPdf` early return for pictures.

## 5. Out of scope

- **Remote projects.** Save reaches the host over SFTP, but
  `pdf_markup_submit` refuses remote projects (the bake and inbox are local).
  It would need the remote inbox write and the source re-proved over SFTP,
  the same gap as PDF markup on a remote project.
- **Phone.** It already marks pictures. Marking a desktop screenshot from
  the phone (`desktop_images.rs`) is a separate item.
- **OCR / word anchors** on screenshots: the agent reads the composed picture.
- **Capturing only Tabtivity's own window** without a region tool: the
  in-app capture path exists for the PDF viewer; a whole-window variant would
  be a later item.
