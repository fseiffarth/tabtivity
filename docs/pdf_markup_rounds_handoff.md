# PDF markup rounds — handoff

Plan: `docs/pdf_markup_rounds_plan.md`. This file records what each phase
built and what the next one needs. Nothing is committed; nothing was run live.

## Phase A — shared core + phone rounds (done 2026-10-02, never live)

### Done

1. `mobile-web/src/markup/layer.ts` — `Layer.sent?: SentLayer` (`{ pages,
   rounds }`), `markSent(layer, only?)`, `clearSent`, `hasSent`; `isLayer`
   validates `sent` when present. **`addMark` and `withPage` now spread
   `...layer`** — before, they rebuilt `{ pages }` and would have dropped
   `sent` on every stroke, erase or note edit (the plan's "every function
   keeps working unchanged" was true only after this fix).
2. `mobile-web/src/markup/store.ts` — `saveLayer` deletes only when both
   sides are empty; `withinLimits` bounds `pages` and `sent.pages` separately;
   `loadLayer` salvages the unsent marks when only `sent` is unreadable
   (`readLayer`); new `moveLayer(from, to, fingerprint)`.
3. `mobile-web/src/markup/submitState.ts` — pure machine: `startRound(queued,
   now)`, `followRound(agent, now)` (reopened view, work seen over sent
   marks), `stepRound(round, agent, now)` (returns the same object when
   nothing changes), `nextCheck(round, agent, now)` (ms until a time-based
   edge, for a host timer). `SETTLE_MS = 3000`, `CONFIRM_MS = 20000`.
4. `mobile-web/src/components/MarkupView.tsx` — Submit → `markSent(present,
   sentPages)` + `startHistory` (no `clearLayer`, no `onClose`); sent marks
   drawn first at `SENT_ALPHA = 0.35` (`paintLayer`); round pill in
   `.markup-notes` (shown marking or reading) with the desktop's status glyph;
   ⋯ gets Reload PDF / Show sent marks (switch) / Clear sent marks; Reload
   remounts the iframe (`key={generation}`), resets the frame refs, drops the
   bitmaps, keeps the old `sizes` (gated by `reopening` so no page is asked of
   a frame that has not opened), moves the layer on a leaf switch; the load
   effect keys on `key` only (fingerprint via ref, `movedTo` skips the read
   after a move); pages past the PDF's end are kept, not drawn, not sent, with
   a note.
5. `Terminal.tsx` — `sendMarkup` returns `"queued" | "sent" | false` (reads
   `agentAtWorkRef` before `submitDraft`) and closes nothing;
   `refreshOutboxFile` (newest `from_tab` copy with the same `sentName`,
   `modified ≥` the shown one, else the shown leaf's fresh row); the
   `markupTarget` memo moved below `liveQuestion` and carries `agent`
   (`liveQuestion` → question, `liveBusy` → working — never
   `tab.agent_status`) and `refresh`. `OutboxViewer` passes both through;
   `ProjectFiles` supplies its own `refresh` (re-lists the current folder).
6. i18n: 15 `mobile.markup.*` keys (round.*, reload, noNewer, unchanged,
   showSent, clearSent, leftOut/leftOutOne) in en + de/es/fr/it. Untested id
   `mobile.markup.rounds` (pill on the round line and the ⋯ Reload entry);
   `mobile.markup.send` row text updated. CSS `.markup-round` in
   `mobile-web/src/style.css`. File-map row for MarkupView updated.

### Where Phase A filled gaps or deviated

- `refresh` takes the shown file: `refresh?: (file: OutboxFile) =>
  Promise<OutboxFile | null>` (plan: `() => …`). After a switch to a newer
  leaf the host's `file` prop is stale, so the view hands over what it shows.
- `MarkupTarget` (OutboxViewer.tsx) also exports `MarkupSend`; `ProjectFiles`
  takes `Omit<MarkupTarget, "projectId" | "place" | "refresh">`.
- `rasterize.ts` changed by one line: the highlighter sets
  `globalAlpha *= HIGHLIGHT_ALPHA` instead of `=`, so a sent box dims with the
  rest (it would otherwise have overridden `SENT_ALPHA`). PNGs unchanged
  (outer alpha is 1 there).
- `markSent` on a page whose size changed since its earlier sent round (a
  rebuilt PDF) scales the older sent marks to the new size — superseded
  2026-10-02 by the user's "never delete markers automatically": nothing
  drops or hides sent marks; the eraser and Clear page reach shown ones.
- `markSent(layer, only)` moves only the pages Submit carried; marks on pages
  past the PDF's end stay unsent.
- The PDF check at `finished` runs on every entry into `finished` (each
  later turn), not once per Submit. The pill words: "Agent finished — PDF
  changed / unchanged", or plain "Agent finished" with no `refresh`. After a
  Reload the pill's Reload turns secondary (`reloaded`).
- A Reload that finds no other version still re-renders and notes "No new
  version sent yet — reloaded the one shown." (outbox) / "The PDF is
  unchanged." (files drawer).
- Open user decisions (§5) taken at the plan's defaults: instruction as is,
  no "Make these changes" button; sent marks hidden (not dropped) after
  Reload; desktop prompts into the CLI queue (Phase C).

### Gotchas for B and C

- The pure modules are importable from the desktop as is (`layer.ts`,
  `store.ts`, `rasterize.ts`, `submitState.ts`): no ES2022 API, no DOM except
  `indexedDB` in `store.ts`'s default backend (lazily opened).
- `stepRound` must be fed on every agent edge *and* on `nextCheck`'s timer —
  see MarkupView's round effect (`[submitted, agent, sentShown, roundTick]`)
  for the host pattern; `followRound` starts the pill on a reopened view.
- Any new layer-editing helper must keep `sent`: spread `...layer`.
- The `MarkupView` test files mock `markup/store` and `markup/rasterize`
  wholesale; `moveLayer` is in the mocked set.

## Phase B — desktop backend (done 2026-10-02, never live)

### Done

1. `src-tauri/src/services/mobile_control/markup.rs`
   - `validate` = `validate_source` (token / outbox leaf shape) +
     `validate_body` (pages, marks, layer refs, picture, instruction). The
     sidecar still calls `validate`; behaviour unchanged.
   - `submit` split into `speakable` → `layers_present` → `read_source` →
     `bake_and_prompt`; `bake_and_prompt` is the **one bake path**, used by
     the sidecar's `submit` and the desktop's `submit_local`.
   - Prompt cap: `MAX_PROMPT_BYTES = 12 KB`. The layer list and the typed
     notes share what the fixed lines leave (notes are promised up to half);
     overflow lines: `(Pages A–B: N more layers, beside these in
     `.eldrun/inbox/`, named `…-p<page>-layer.png`.)` and `(N more notes —
     read them in the marked copy.)` ("the layers" when there is no copy).
     Prompts under the cap are byte-identical to before (exact-text test
     still green).
   - Desktop core: `LocalPage { n, size, marks, layer_png: Vec<u8> }`,
     `check_layer_png` (signature + `IHDR` first, sides 1..=16 384, ≤ 8 MiB
     each, ≤ 64 MiB together), `resolve_local_source(root, path)`,
     `submit_local(root, path, pages)`. New `MarkupError` variants
     `OutsideProject`, `HiddenPath`, `InvalidLayer`, `Inbox(InboxError)`.
   - `submit_local` checks **everything before the first write** (path,
     `validate_body` with placeholder layer refs, PNGs, the source read and
     being `application/pdf`); only then stores the layers
     (`inbox::store(root, "<stem>-p<n>-layer.png")`) and bakes. Instruction
     `DEFAULT_INSTRUCTION`, `send_back: false` (no `eldrun-send` line — the
     viewer reloads from disk).
2. `src-tauri/src/commands/pdf_markup.rs::pdf_markup_submit`, registered in
   `lib.rs` (beside `pdf_clip_*`), `pub mod pdf_markup` in `commands/mod.rs`.
   Root from `remote::project_directory` (projects.json), remoteness from
   `remote::remote_target_for`; the whole thing runs in `spawn_blocking`.
3. Rust tests (9 new in `commands/pdf_markup.rs`): payload camelCase + closed
   (`layer_png`, extra keys, a `sent` flag on a mark refused); remote /
   unknown project refused (`local_root`, pure); bake into `.eldrun/inbox/`
   with both layers + marked copy, source bytes and mtime unchanged, default
   instruction, no absolute path; same prompt as the sidecar for the same
   marks; `.eldrun/outbox/<leaf>` read as an outbox source; outside root,
   `..`, relative path, the root itself, `.git/…`, `.eldrun/inbox/…`,
   `.env*`, missing file, symlinked folder, symlinked leaf — all refused with
   **nothing written**; non-PDF (text, PNG) refused before any write; non-PNG
   / bad base64 / huge `IHDR` / oversized layer → `invalid_layer`; off-page
   mark / no pages → `invalid_markup`; 300 noted pages stay ≤ 12 KB.
4. `docs/filemap_backend.md`: new `pdf_markup.rs` row; the `mobile_control/`
   row's markup sentence names `validate_source`/`validate_body`,
   `submit_local` and the prompt cap. Plan status line updated.

### Command contract (for Phase C)

```ts
invoke<{ prompt: string; marked: string | null }>("pdf_markup_submit", {
  projectId: string,          // the project scope id (useFileScope)
  path: string,               // absolute path the viewer opened
  pages: Array<{
    n: number,                // 1-based page number
    size: [number, number],   // page size in points after /Rotate (cssSize at scale 1)
    marks: Mark[],            // exactly the phone's Mark shape (layer.ts); no extra keys
    layerPng: string,         // standard base64 of layerPng(page), no "data:" prefix
  }>,
})
```

- Pages carry only the unsent marks (`layer.pages`), one entry per marked
  page, as the phone's body does; every page must have ≥ 1 mark.
- `marked` is the project-relative `.eldrun/inbox/<stamp>-<stem>-marked.pdf`,
  or `null` when the bake failed (the prompt then says why); the prompt is
  ready to queue as is (≤ 12 KB, under the 16 KB scheduler cap).
- Errors reject with a **plain code string**:
  `remote_project`, `project_not_found` (no directory in projects.json),
  `outside_project` (not absolute, not below the root, `..`),
  `hidden_path` (`.git`, `.eldrun/…` other than `.eldrun/outbox/<leaf>`,
  `.env*`), `file_not_found` (missing, symlink on the way, the root itself),
  `file_too_large`, `read_failed`, `project_unavailable`,
  `unsupported_source` (not a PDF, or a name with a control char/backtick),
  `invalid_markup` (bounds: 1..=300 pages, marks inside the page ±2,
  5 000 marks / 200 000 points, 2 000 note chars per page, …),
  `invalid_layer`, `layer_missing`, `inbox_full`, `write_failed`,
  `empty_file`, `markup_failed` (the blocking task died).
- No typed frontend wrapper was added: the plan puts Phase B in Rust only.
  Phase C adds it (e.g. in `usePdfMarkup.ts`, or a small
  `src/lib/viewers/pdfMarkup.ts`) and maps the codes to i18n text.

### Deviations / decisions

- **Hidden paths**: refused by `files::hidden` (`.git`, `.eldrun`, `.env*`)
  — what `files::read` itself refuses — not every dot-folder; a PDF in
  `.build/` can be marked. Code `hidden_path` instead of the plain
  `file_not_found` the read would give.
- **Nothing written on refusal**: the source is read and type-checked before
  the layers are stored (one read; the bytes go straight into the bake).
  A failure *after* the layer writes (inbox full mid-way, a race) leaves the
  stored layers, as on the phone.
- `Pages A–B` in the overflow line names the first and last omitted page,
  not a contiguous range.
- `MarkupRequest.source` is a placeholder in `submit_local` (`bake_and_prompt`
  never reads it).
- Desktop marks PDFs only; a picture path is `unsupported_source`.

### Gotchas for Phase C

- The layer PNG must start with a real `IHDR` (the canvas's `toBlob`
  output does); sides ≤ 16 384 px. Base64 via `FileReader.readAsDataURL`
  → strip the `data:image/png;base64,` prefix.
- `path` must be the absolute path under the directory `projects.json`
  records (or its canonical form). The command does not follow symlinks
  anywhere on the path — a project opened through a symlinked folder inside
  the root fails with `file_not_found`.
- Each Submit writes `pages.length + 1` files into `.eldrun/inbox/`
  (1 GiB inbox cap → `inbox_full`).
- The prompt has no `eldrun-send` line; queue it with
  `queuePromptForTab` + `holdPhonePrompt` (plan §2.6 Delivery).

## Phase C — desktop markup mode UI (done 2026-10-02, never live)

### Done

1. `src/stores/activity.ts` — `agentTabStateOf(state, ptyId)` (pure over
   `busyByTab` / `attentionByTab`) and `agentTabState(ptyId)`;
   `MobileBridgeHost.tsx::mobileAgentState` now starts from it.
2. `src/lib/viewers/pdfMarkup.ts` (pure, no React) — `markupGate` (hidden:
   root/null scope, `box:`, `FileSource` ≠ `"none"`, popout, unloaded or
   > 24 MiB; blocked: not `isPristineExceptNotes` or `dirty` → `"arranged"`,
   another pane's claim → `"claimed"`), `diskChangeAction` (stale / markup /
   reload), the per-window claim registry (`claimMarkup` / `releaseMarkup` /
   `markupHolder` + `useSyncExternalStore` hooks), the typed
   `submitPdfMarkup` wrapper, `markupErrorCode` (bare code, `Error.message`, the
   backend's "at most N schedules" sentence → `schedule_cap`),
   `markupReasonKey` (every Phase B code → `pdfMarkup.reason.*`), `blobBase64`.
3. `src/components/embed/pdf/usePdfMarkup.ts` — layer + history + scratch,
   IndexedDB via `store.ts` (key `layerKey(projectId, { files: <absolute
   path> })`; read once per key while the pane is visible; saved after each
   committed change, never straight back after a load; fingerprint = loaded
   byte length + `file_mtime`, re-read after every load; `changed` sticky until
   a Reload); targets (`agentTargets`, `defaultTarget` by `lastTabReadAt`,
   fixed when markup comes on, falls back when the chosen tab closes); pill
   (`startRound` / `followRound` / `stepRound` / `nextCheck` on
   `agentTabStateOf` of the target); Submit = `layerPng` → base64 →
   `pdf_markup_submit` → read busy → `queuePromptForTab` → `holdPhonePrompt(id)`
   → only then `markSent` + `startHistory`; `beforeReload` (keeps sent marks shown,
   restamp the record once the new fingerprint is read); `holdsReload`.
4. `PdfMarkupLayer.tsx` — per-page `<div>` (z-index 7, over the remarks and
   blackout boxes) with a canvas redrawn from vectors at the viewer's scale
   (DPR ≤ 2, ≤ 8192 px); gestures as the phone's (ink with coalesced events and
   pen pressure, box, eraser with one undo step, note click / drag); the note
   editor reuses the remark card (`file-viewer-pdf-note-card`: Enter adds,
   Shift+Enter new line, Escape cancels, keys stop at the card). `pagePoint`
   maps client → page units off the layer's own box.
5. `PdfMarkupBar.tsx` — the tool strip wears `file-viewer-pdf-redact-bar`, the
   status line `file-viewer-pdf-copy-bar` (as the metadata panel / copy mode
   do): tools, four colour swatches, ↶/↷, Clear page N (page on screen), Show
   sent marks (checkbox) + Clear sent marks, target ("→ Claude" / "Send to"
   `<select>` / warning hint), Submit, Done; pill with `TabStatusMark`, Reload
   (leads while the PDF changed under the marks), sending / failure (Dismiss) /
   unsaved / changed / left-out / limit notes.
6. `PdfViewer.tsx` (thin wiring) — `marking` state beside `redacting` /
   `copySelecting` (each turns the others off; the Screenshot capture turns
   markup off), ✎ **Mark up** button after ▮ (`active`, `is-armed` while unsent
   marks wait, disabled + reason title when blocked), `PdfMarkupBar` under the
   toolbar, `markup={marking ? markup.edit : null}` into every
   `PdfPageCanvas` (adds `is-marking`, the layer, drops the remark right-click
   and the selection bar, closes an open remark menu/card); rail, ⊕, ↶/↷ of the
   arrangement disabled and the spring-loaded rail held shut while marking;
   Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo strokes (not inside a text field);
   Escape leaves; `diskChanged()` routes the mtime poll, `reloadNonce` and the
   SyncTeX `afterReload` reveal; `reloadUnderMarks` = `beforeReload` + mtime
   baseline + `diskVersion + 1`; leaving markup with a held-back version loads
   it; `docBytes` taken in the load effect before pdf.js detaches the buffer;
   the claim lives while marking.
7. CSS (`styles/viewers.css`, beside the copy bar): the layer, its canvas,
   `is-marking` remarks `pointer-events: none`, the strip's pressed state (the
   values of `.toolbar-btn.active`), swatches, pill row. No animation.
8. i18n: 33 `pdfMarkup.*` keys in en + de/es/fr/it; tool, colour, note,
   round, reload, sent-marks, limit and changed texts reuse the
   `mobile.markup.*` keys. Untested id `desktop.markup` (Mark up button and the
   pill line).
9. Docs (§2.7, owed by A/B): `DOCUMENTATION.md` (rounds paragraph after the
   phone's Mark up paragraph; a **PDF markup** bullet in the viewer list —
   "Three that carry…" → "Four"), `docs/help/mobile.md` (a Mark up / rounds
   bullet under "Using it", four keywords; the corpus is embedded in the Rust
   binary — `real_corpus_parses` stays green), `docs/filemap_frontend.md`
   (new `PdfMarkup{Layer,Bar}` + `usePdfMarkup` row, `PdfViewer` and
   `activity.ts` rows; the backend map was done in Phase B), QA under 31bt in
   `todo/group-h-crossplatform.md` (phone rounds + desktop item, each with the
   four platform ✅/❌ pairs), plan status line → implemented.
10. Tests (4 files, 44 tests): `PdfMarkupCore.test.ts` (gate, the three paths'
    rule, claims, codes ↔ words, targets, `agentTabStateOf`),
    `PdfMarkupLayer.test.tsx` (pointer → page units at 1×/2×/2.5×, ink, box,
    note, eraser, right button, busy), `PdfMarkupSubmit.test.tsx` (command →
    `queuePromptForTab` → `holdPhonePrompt("sched-1")` in that order, record
    keeps sent marks, pill follows working/question, no agent tab → disabled +
    hint, `message_too_long` and a backend refusal leave the marks unsent,
    picker, chosen tab closing), `PdfMarkupViewer.test.tsx` (the real
    `PdfView` over a stub pdf.js: button shown / hidden for root, box, remote,
    popout; markup turns ▮ off, layers on both pages, remark right-click off,
    rail off, Escape leaves; unsaved edit (metadata deletion) blocks it; second
    pane blocked; each of the three reload paths offers Reload without reading
    the file while marking, and reads it on its own with markup off).

### Deviations / decisions

- **No ⋯ popover on the desktop**: the strip has room, so Clear page, Show
  sent marks, Clear sent marks and Reload sit in the strip / status line,
  built from the redact bar's existing controls. Nothing is portaled, so no
  new menu/dialog surface (the target picker is the redact bar's `<select>`).
- **Untested id `desktop.markup`** (as instructed), not the plan's
  `pdfMarkup.toggle`.
- **Over-24 MB PDFs**: the button is hidden (plan's "shown only when"), not
  disabled with a reason.
- **SyncTeX `afterReload` with unsaved page edits** now raises the stale
  banner instead of reloading over the edits (the plan routes all three paths
  through one rule; before, that path alone had no dirty check). The reveal
  then waits for the version the reader loads.
- **"Agent finished"** says "— PDF changed" only when the viewer saw the file
  change (`stale`); otherwise plain "Agent finished" (the desktop has no
  one-shot `refresh` look like the phone — the mtime poll is the signal).
- Reload leads (pressed look) only while the file changed under the marks;
  it is offered whenever a round went out or the file changed.
- Remarks while marking: visible, `pointer-events: none` (CSS) under a layer
  that covers the page, right-click placement off, open menu/card closed —
  not an `inert` attribute (React 18 types lack it).
- Leaving markup keeps a note being typed (as the phone's Done) and loads a
  held-back new version (markup off = behaviour unchanged).

### Gotchas

- `usePdfMarkup` is called in `PdfCanvas` right after `loadedDiskVersion`;
  `diskChanged` must stay above the reveal / `reloadNonce` / poll effects.
- `edit.add` returns `false` at the backend's ceiling — the layer then
  redraws to drop the refused stroke's pieces.
- The layer's redraw effect depends on the page objects; every layer helper
  keeps untouched pages' identity, so a stroke repaints one page only.
- `PdfMarkupViewer.test.tsx` renders the real viewer over a pdf.js stub —
  if the viewer starts calling a new pdf.js API, extend the stub there.

## Gate status (after Phase C)

- `npm run build` — passes (tsc + both bundles + `mobile:build`); only vite's
  chunk-size notices.
- `npm test` — 680 files, 6 908 tests, all pass (+4 files, +44 tests).
- `npm run lint` — 0 errors, 31 warnings — the same 31 as before, all in
  other sessions' files (`PdfViewer.tsx:3745` is the load effect's old
  `viewPos.initial` one); the new files lint clean.
- Rust: no Rust source touched; `cargo test -q` run because the help corpus
  (`docs/help/mobile.md`) is embedded — lib 3 052 passed, 1 ignored, every
  integration suite green (`real_corpus_parses` included); clippy not needed.
- `git diff --check` clean on the touched files; new files have no trailing
  whitespace.
- Not run live. `pdf_markup_submit` (Phase B) is in the running window only
  after the user's next frozen build / restart; `src/` hot-reloads, so the
  button appears at once but Submit fails with an unknown-command error until
  then.

## Live check (desktop, for the user)

1. Rebuild/restart Eldrun yourself so the backend has `pdf_markup_submit`
   (`npm run backend:stale` says whether the running window is stale).
2. A **local** project with an agent tab (Claude) → open its PDF (or the TeX
   workspace's PDF) → the toolbar's **✎ Mark up** (right of ▮): a strip opens.
3. Draw with the mouse: pen, highlighter (turns yellow), T → click on the
   page, type, Enter; drag the note; eraser; colours; Ctrl+Z / Ctrl+Shift+Z.
   Zoom in/out: the marks stay on the same words. Right-click places no remark.
4. **Submit** → "Sent — waiting for the agent" then "Agent is working…"; the
   agent tab receives a prompt naming `.eldrun/inbox/…-paper-marked.pdf`;
   open that file — the marks are annotations. The strokes dim.
5. While the agent works: add a mark, Submit → it goes into the agent's queue
   at once (watch the tab).
6. Tell the agent to apply and rebuild: the PDF does not repaint under the
   marks; the status line says it changed → **Reload PDF** → new pages at the
   same zoom/scroll, sent marks still shown dimmed; the eraser removes a
   checked one.
7. Open a second agent tab: the strip shows a **Send to** picker defaulting to
   the tab you last looked at; close all agent tabs → Submit greyed with "Open
   an agent tab in this project to send".
8. Open the same PDF in a split pane: its Mark up is greyed ("being marked up
   in another pane"). Make a page edit in the rail first → Mark up greyed.
   Remote project / root console / box / popout window: no Mark up button.
9. Quit and restart Eldrun → reopen the PDF → Mark up: unsent marks are back.

## Gate status (after Phase A)

- `npm run build` — passes (tsc + both bundles + `mobile:build`, which runs
  `mobile:bundle`); only vite's usual chunk-size notices.
- `npm test` — 676 files, 6 864 tests, all pass (new: `MobileMarkupRoundsCore.test.ts`
  16 tests, `MobileMarkupRounds.test.tsx` 8 tests; `MobileMarkupView.test.tsx`
  updated for the new Submit).
- `npm run lint` — 0 errors, 31 warnings, none in Phase A's files (all in
  files other sessions are editing, e.g. `Terminal.tsx:1137/1800`,
  `PdfViewer.tsx`, `TerminalView.tsx`); the touched files lint clean.
- Rust untouched: cargo test / clippy not run for this phase.
- Not run live.

## Gate status (after Phase B)

- `cargo test -q` — lib 3 052 passed, 1 ignored (+ the integration suites, all
  green); markup: 11 existing sidecar tests unchanged and green, 9 new in
  `commands/pdf_markup.rs`.
- `cargo clippy --all-targets -- -D warnings` — clean (rustc 1.97.1).
- `npm run build` — passes (only vite's chunk-size notices).
- `npm test` — 676 files, 6 864 tests, all pass (no TS touched).
- `npm run lint` — 0 errors, 31 warnings, all pre-existing in other
  sessions' files; Phase B touched no TS.
- `npm run backend:stale` — "No Eldrun process was identified, but the
  sidecar on 127.0.0.1:8742 is serving … the bundle built in mobile-dist/.
  The Rust side could not be checked." The running window (if any) does not
  have `pdf_markup_submit` until the next frozen build / restart by the user.
- `git diff --check` clean on the touched files.
- Not run live.
