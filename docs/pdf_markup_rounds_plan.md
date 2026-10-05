# PDF markup: stay open while the agent works, reload under the marks, and the same on the desktop

Status: **implemented 2026-10-02** — phases A, B and C built (uncommitted,
never run live; `docs/pdf_markup_rounds_handoff.md`; QA under 31bt in
`todo/group-h-crossplatform.md`, untested ids `mobile.markup.rounds`,
`desktop.markup`). Reviewed against the code the same day (see §5); the open
questions of §5 were taken at the plan's defaults. Builds on
`docs/mobile_pdf_markup_plan.md` (phone markup, QA 31bt).

---

## 1. Context

Today the phone's **Mark up** (`mobile-web/src/components/MarkupView.tsx`)
ends at Submit: the layer PNGs go to the inbox, `submitMarkup` bakes
`<stem>-marked.pdf` and returns the prompt, `onSend` → `Terminal.tsx::sendMarkup`
→ `submitDraft`, then `clearLayer(key)` and `onClose()`, and `sendMarkup` also
closes the viewer, the gallery and the files drawer. Reviewing a draft is a
loop, not one shot: mark → agent answers / fixes → look at the rebuilt PDF →
mark again. Closing on Submit breaks that loop every round.

What the user asked for, in their words (2026-10-02):

> Add markup mode also to desktp, improve the mode (also for phone): do not
> close on submit, let work agent in the background and add info that is
> working, when finished add button to reload pdf in layer under changes,
> adding new remarks should be possible while agent is working.

So, on both phone and desktop:

1. **Submit keeps the view open.** The sent marks stay visible (dimmed, as
   sent); the agent works in the background.
2. **A status pill** says what the agent is doing since the last Submit:
   sent / queued / working / asking / finished.
3. **When the agent has finished, a Reload button** re-renders the PDF under
   the marks layer (the layer stays; the pages change beneath it).
4. **Marking goes on while the agent works.** New marks form the next round;
   Submit again sends only the new round (queued like a typed prompt while the
   agent is busy).
5. **The desktop gets the same mode** in its own PDF viewer, sending to an
   agent tab of the same project.

Non-goals: changing the original PDF from the markup layer; desktop picture
(image) markup; remote (SSH) projects, popout windows and the presenter on
the desktop in v1 (§2.6); merging with the desktop viewer's PDF remarks
(`embed/pdf/notes.ts`, `PdfNoteLayer`) — those are the PDF's own annotations;
Reload of a *picture* source (pictures get rounds and the pill only).

## 2. Decisions

### 2.1 Rounds: sent marks move aside, dimmed, and are never sent twice

`mobile-web/src/markup/layer.ts` today: `Layer = { pages: Record<number, PageLayer> }`.
It becomes

```ts
type Layer = { pages: Record<number, PageLayer>; sent?: { pages: Record<number, PageLayer>; rounds: number } };
```

- `pages` holds only the **unsent** marks. So every existing function —
  `eraseAt`, `noteAt`/`moveNote`, `clearPage`, `markedPages`, `isEmpty`,
  `canAdd`/`canReplace`, `markCount`, undo/redo — keeps working unchanged;
  Submit builds its body from `pages` exactly as today. Sent marks are never
  removed automatically (user, 2026-10-02: "Do not delete markers
  automatically so one can check manually the changes and then erase them"):
  the eraser and Clear page reach them while they are shown (`eraseAt` /
  `clearPage` with `sent = true`), notes stay undraggable, and neither a
  Submit (size change, ceilings) nor a Reload drops or hides them.
- No flag on a `Mark`: the server's `markup::Mark` is
  `#[serde(deny_unknown_fields)]`, so a `sent` field on a mark would make every
  second-round Submit fail with `invalid_markup`.
- New `markSent(layer)`: merges `pages` into `sent.pages` (page sizes kept),
  empties `pages`, `rounds += 1`. If `sent` would exceed `LIMITS` (5 000 marks /
  200 000 points) it keeps only the newest round. New `clearSent(layer)`.
- **Submit success** (prompt accepted by `onSend`): `setHistory(startHistory(markSent(present)))`
  — history reset, nothing before the Submit can be undone — the layer is
  **saved, not cleared**, the view **stays open and marking**.
- Rendering: `LayerCanvas` draws `sent.pages[n]` first at one alpha
  (`SENT_ALPHA = 0.35`, a `globalAlpha` around `drawPage`), then `pages[n]`.
  `rasterize.ts` needs no change: `layerPng`/`composedPng` are called with
  `pages[n]` only, so the round's PNGs and composed picture carry only that
  round.
- ⋯ menu: "Show sent marks" (switch; on until a Reload, off after one —
  §2.3) and "Clear sent marks". "Clear page" keeps clearing unsent marks only
  (it already only sees `pages`).
- Each round's prompt is the existing `markup::prompt` over that round's marks.
  No backend field for rounds (`MarkupRequest` is `deny_unknown_fields`; the
  inbox stamps keep round files apart).
- Persisted shape (`store.ts`): a record from before this change has no `sent`
  → all marks unsent (correct: until now a successful Submit cleared it).
  `isLayer` validates `sent` when present and ignores it otherwise, so an
  older build reading a newer record still loads the unsent marks.
  **`saveLayer` must change**: it deletes the record when every `pages` entry
  is empty — after `markSent` that is always true and would drop the sent
  marks; delete only when `pages` *and* `sent.pages` are empty. `withinLimits`
  keeps bounding `pages` (the Submit bound) and adds the `sent` bound.

### 2.2 The status pill

One pure reducer, `mobile-web/src/markup/submitState.ts`, used by phone and
desktop:

```
input per tick: agent = "working" | "question" | "idle", now
Submit ok ─► queued (agent was working)  ─┐
          └► sent   (agent was idle)     ─┼─ working seen ─► working ⇄ question
                                          │                    │ idle ≥ SETTLE_MS (3 s)
                                          │                    ▼
                                          │                 finished ── working again ─► working
                                          └─ no work within 20 s of "sent" ─► unconfirmed
```

- **sent** "Sent — waiting for the agent"; **queued** "Queued — the agent
  takes it after its current step"; **working** "Agent is working…" (reuse
  `AgentStatusPill`/`AgentStatusMark` on the phone, `TabStatusMark` on the
  desktop — no new animation, and never an animated blurred `box-shadow`);
  **question** "The agent is asking something — answer in the chat" (phone) /
  "…in its tab" (desktop); **finished** "Agent finished" + **Reload PDF**
  (primary); **unconfirmed** "Sent" with Reload secondary (an agent whose
  state the screen/hooks don't show).
- `finished` needs idle to hold for `SETTLE_MS` (3 s, as
  `AgentScheduleHost`'s `COMPLETION_STABLE_MS`): between a turn and a queued
  prompt the CLI is briefly idle, and a permission prompt is `question`, not
  idle.
- **The pill keeps following the tab after `finished`.** The default
  instruction (`markup.rs::DEFAULT_INSTRUCTION`) tells the agent to *list* the
  changes and edit nothing until told, so the real loop is: Submit → agent
  lists → user says "go" in the chat → agent edits and rebuilds → Reload. A
  later turn flips the pill back to working and then to finished again. A new
  Submit restarts the machine; the pill always describes the latest round.
- The machine is per view, not persisted. Reopening shows the sent marks
  dimmed and the pill only once the agent is seen working (no "finished"
  without a working edge seen in this view).
- **Phone signal** (`Terminal.tsx`): `working` = `liveBusy`
  (`agentWork(liveScreen)`, the screen's busy row — Claude, Codex, Gemini, Qwen,
  OpenCode); `question` = `liveQuestion !== null` (`readSelectPrompt`).
  *Not* `agentAtWork`: its `tab.agent_status` half is the `TabRow` snapshot
  `App.tsx` took when the tab was opened (`setTerminal`, never refreshed), so a
  tab opened mid-turn would read "working" forever. `liveQuestion` is declared
  ~860 lines below the `markupTarget` memo — move the memo below it.
  `MarkupTarget` gains `agent: "working" | "question" | "idle"`; it is in the
  memo's deps, so `OutboxViewer`/`MarkupView` re-render on edges only.
  `ProjectFiles` gets `markup` as `Omit<MarkupTarget, "projectId" | "place">`
  and Terminal builds that object by hand (`{ tabId, onSend }`) — add the new
  field there too.
- **Queued vs sent on the phone**: `submitDraft` holds exactly when
  `agentAtWork && !interrupt` and the text is not a `/command` — always the
  case for a markup prompt — so `sendMarkup` reads `agentAtWork` (via a ref)
  before calling it and returns `"queued" | "sent" | false`. `submitDraft`
  stays boolean (its other callers need nothing new). A held prompt is typed
  into the CLI's own queue at once by the desktop's scheduler
  (`lib/agents/phoneHolds.ts`, `AgentScheduleHost.queueDuePhoneHold`), so
  "queued" means "in the agent's queue", not "waiting for idle".
- **Desktop signal**: the tab's PTY id `${scopeId}:${tab.key}` in
  `useActivityStore`: `busyByTab` → working, `attentionByTab === "decision"`
  → question. Extract that part of `MobileBridgeHost.tsx::mobileAgentState`
  into an exported `agentTabState(ptyId)` in `src/stores/activity.ts` and use
  it from both.

### 2.3 Reload: new pages under the same layer

- **Phone, which file**: `MarkupView` gets `refresh?: () => Promise<OutboxFile | null>`
  from its host and keeps the shown file in its own state (`current`, seeded
  by the prop). The hosts must **not** swap their open file on Reload: both
  key the viewer by file (`Terminal`: `key={tab.id/name}`, `ProjectFiles`:
  `key={fileOpen.ref}`), so a swap would remount it and lose layer view,
  pill and zoom.
  - Files drawer: `ProjectFiles` re-lists the current folder
    (`listProjectFiles(projectId, here.token)`) and returns the entry with the
    same name — fresh token, size, modified. (Sealed tokens carry no expiry —
    `files::seal` is XChaCha20 with a random nonce under the host key, AAD =
    raw project id — so the old token still fetches; the re-list is for the
    fingerprint. The layer key is the folder trail + name, unchanged.)
  - Outbox: Terminal calls `listOutbox({ tab })` and returns the newest entry
    with `from_tab` and `original === sentName(current)` whose `modified` ≥
    `current.modified` (desktop clock against desktop clock — never the
    phone's); else the same leaf's fresh row, and the pill says "No new
    version sent yet". On a switch to a newer leaf, `store.ts`'s new
    `moveLayer(from, to, fingerprint)` runs *before* `current` changes.
- **Phone, re-render**: the sealed frame opens once (`pdfFrame/main.ts`:
  `open()` returns when a task exists), so Reload **remounts the iframe**
  (`key={generation}`), resets `frameReady`/`opened`/`inFlight`/`pageCount`/
  the render timer, closes and drops the bitmaps, clears `pageFailures`, and
  keeps the old `sizes` until the new `meta` arrives so the scroll position
  holds. Messages of the old frame are already refused (`acceptFrameMessage`
  checks `event.source`). No frame-protocol change.
- **Phone, layer effects**: the load effect today depends on `fingerprint`;
  after a Reload it would re-read the old record and raise "This file changed
  since you marked it". Load on `key` only (fingerprint through a ref); Reload
  saves the layer with the new fingerprint itself and clears `changed`.
- **Desktop**: Reload = the viewer's own same-path reload (`setDiskVersion`,
  which keeps zoom and scroll and the page ids via `keepPageIds`, through
  `lib/viewers/pdfLoad.ts` and the viewer's worker slot).
- **Both**: the layer is untouched: unsent marks stay at their page
  coordinates; sent marks stay shown, so the reader can check the agent's
  changes against them and erase each by hand (⋯ Show sent marks hides them
  only when the reader asks). Marks on pages that no longer exist stay in the
  record, are not drawn and not sent; Submit says how many were left out.
  A page whose size changed is fine: each `PageLayer` carries the size its
  marks were drawn in and the bake maps that onto the real page.
- **Did the file change?** No new polling. Phone: on reaching `finished`,
  call `refresh()` once — the pill says "PDF changed" (Reload primary) or "PDF
  unchanged" (Reload secondary). Desktop: the viewer's existing `file_mtime`
  poll (1.5 s, pane-visible gated) — in markup mode it raises the Reload offer
  instead of reloading (§2.6). Reload is always in ⋯ after a Submit.

### 2.4 Marking while the agent works

Nothing blocks drawing except Submit's own uploads (`sending`, a few seconds,
as today). Submit is enabled whenever `pages` has marks and the link is up.
Two quick Submits make two queued prompts, in order — acceptable.

### 2.5 Phone: what changes in the flow

- `MarkupView.submit`: as today up to `onSend`; then `markSent` + history
  reset + save + pill start; **no** `clearLayer`, **no** `onClose`. A failed
  `onSend` leaves the marks unsent (the inbox files of that try stay, as
  today).
- `Terminal.tsx::sendMarkup`: returns `"queued" | "sent" | false` and stops
  calling `setOutboxOpen(null)` / `setGallery(false)` / `setFilesOpen(false)`.
- `MarkupTarget.onSend` type: `(text) => "queued" | "sent" | false`.
- Reader mode (`reader`): Done switches markup off in place as today; the pill
  stays in the head while a round is in flight, so the user can read and still
  see "working" / Reload.

### 2.6 Desktop: markup mode in the PDF viewer

- **Where**: `PdfCanvas` (`src/components/embed/pdf/PdfViewer.tsx` ~1592) —
  which also serves the TeX workspace — gets a **Mark up** toolbar button
  beside "Black out text", same `file-viewer-zoom-btn` class and
  `aria-pressed` (copy that sibling). Shown only when: `useFileScope()` is a
  project (not root, not a box), `useFileSource() === "none"` (local project),
  not `isDetachedWindow()` (`stores/detachedContext.ts`; the scheduler hold of
  §Delivery is per window), and the file is ≤ 24 MB (`outbox::MAX_OUTBOX_FILE`,
  what `files::read` serves).
- **A third drag mode**, mutually exclusive with `redacting` and
  `copySelecting` (both own the plain drag), Escape leaves it like those
  (~3345). The markup layer renders inside `PdfPageCanvas` like
  `file-viewer-pdf-redact-layer` / `-copy-layer`: absolute, above links,
  highlights and the text layer, so those need no gating; `PdfNoteLayer`
  (rendered above everything) and `PdfSelectionBar` are made inert / hidden
  while marking. Wheel and Ctrl+wheel keep zooming; the canvas redraws from
  vectors on zoom.
- **Only on a pristine arrangement**: `isPristineExceptNotes(pages,
  doc.numPages)` and not `dirty` — then sheet *i* is file page *i* with no
  `PageRef.rot`, and the marks' units are the page's points after `/Rotate`
  (`cssSize` at scale 1), the same units as the phone. While marking, the
  rail's arrange/edit actions are disabled.
- **Input**: mouse = the current tool; pen adds pressure; touch draws. Tools
  as on the phone (ink, box, note, eraser, colours, Undo/Redo — Ctrl+Z /
  Ctrl+Shift+Z while the viewer has focus; the arrangement's own undo stack is
  empty on a pristine document — Clear page, ⋯). Shared menu/dialog scheme for
  ⋯ and the tab picker; portaled parts set an explicit `color`.
- **Code**: new files keep `PdfViewer.tsx` (4 780 lines) to thin wiring —
  `PdfMarkupLayer.tsx` (per-page canvas + gestures), `PdfMarkupBar.tsx`
  (tools, pill, target, Submit, Reload), `usePdfMarkup.ts` (layer, storage,
  submit, pill). The pure modules (`layer.ts`, `rasterize.ts`, `store.ts`,
  `submitState.ts`) are imported from `mobile-web/src/markup/`, as
  `TerminalReaderView.tsx` already imports `mobile-web/src/terminal/*`. No
  move: it would churn uncommitted phone files other sessions are editing; the
  desktop `tsc` (stricter: `noUnusedLocals`, ES2020 lib) already follows such
  imports, and these modules use no ES2022-only API. (If ever moved, the home
  for desktop+PWA code is the top-level `shared/`, not `src/lib`.)
- **Auto-reload**: three paths bump `diskVersion` today — the mtime poll
  (~3459), the compile `reloadNonce` (~2436) and SyncTeX `reveal.afterReload`
  (~2395, which has no dirty check). Route all three through one
  `diskChanged()`: `dirty` → `staleOnDisk` (as now); else markup on with marks
  or a round in flight → `markupStale` (pill "PDF changed — Reload"); else
  reload as today. Markup off = behaviour unchanged.
- **Same PDF twice**: a module-level claim per layer key — only one viewer
  per window marks a given file; the other's button says it is being marked up
  in another pane (otherwise two panes overwrite one IndexedDB record).
- **Layer storage**: `store.ts` as is (IndexedDB in the desktop webview — its
  first user there; it already degrades to the "not saved" note), key
  `layerKey(projectId, { files: <absolute path> })`. Never in the project
  folder, never in session state.
- **Target agent tab**: `useTabsStore.getState().tabsByScope[projectId]`,
  `kind === "agent" | "local_agent"` with a `scheduleTargetId` (as
  `MobileBridgeHost.tsx::scheduleTargetTab`). One → used silently, label shown
  ("→ Claude"). Several → picker, default the one with the latest
  `lastTabReadAt(ptyId)` (`stores/activity.ts`, "last deliberately opened");
  choice kept per viewer. None → drawing allowed, Submit disabled with "Open an
  agent tab in this project to send". The chosen tab closing → back to the
  default / disabled.
- **Delivery**: `queuePromptForTab(projectId, scheduleTargetId, prompt)`
  (`src/stores/agents/agentPrompts.ts:291`) **then `holdPhonePrompt(id)`** —
  exactly what `holdTabPrompt` does for the phone. The main window's
  `AgentScheduleHost` then types it at once, into the CLI's queue if the
  agent works. Without the hold a busy tab's rule waits for a stable idle
  point, stalls behind a background job, and after an hour turns `missed` —
  the trap the user already rejected for phone prompts (2026-09-30). The pill
  starts `queued` or `sent` from `agentTabState` at Submit. Failures shown,
  marks left unsent: `message_too_long` (scheduled messages cap at 16 KB,
  `shared/agentComposer.ts::MAX_AGENT_MESSAGE_BYTES`), the 32-schedule cap.
- **Backend**: `markup::submit(root, &ResolvedSource, &MarkupRequest, send_back)`
  is already AppHandle-free and root-based — no split needed. Only `validate`
  splits into `validate_body` (pages / picture / instruction bounds) and the
  source check, because the desktop has no sealed token. New
  `src-tauri/src/commands/pdf_markup.rs::pdf_markup_submit` taking
  `{ projectId, path (absolute), pages: [{ n, size, marks, layerPng: base64 }] }`:
  - refuse `services::remote::remote_target_for(projectId).is_some()`;
    root = `services::remote::project_directory(projectId)` (projects.json,
    never the in-folder `project.json`), canonicalized;
  - rel = `path` stripped of the root, `/`-joined; `.eldrun/outbox/<leaf>` →
    `ResolvedSource::Outbox(leaf)`, else `ResolvedSource::Files(rel)` —
    `files::read` re-proves every segment with no link on the way and refuses
    hidden names (a PDF in a dot-folder is refused with a clear code);
  - each `layerPng`: decoded, PNG magic + size checked, `inbox::store(root,
    "<stem>-p<n>-layer.png", …)`; build the `MarkupRequest` with those refs,
    `validate_body`, then `spawn_blocking(markup::submit(…, send_back: false))`
    (the bake's own allowance, `AllowanceGuard`, lives inside
    `markup_pdf::bake`); answer `{ prompt, marked }`, errors as
    `MarkupError::code()`;
  - not gated by the phone's `files_open` switch (that is the phone's door).
  Writing into `.eldrun/inbox/` is the phone's existing, user-initiated
  channel; `.eldrun/` is in `GITIGNORE_DEFAULT`.
- **Prompt size**: `markup::prompt` caps the typed-notes section so the
  prompt stays under ~12 KB (the notes are in the marked copy as FreeText
  anyway; it says "N more notes — read them in the marked copy"). The phone's
  held prompts pass the same 16 KB scheduler cap, so this helps both.
- **Instruction**: `DEFAULT_INSTRUCTION`; the phone's "Mark up prompt" is a
  phone setting. See §5 open question 1.

### 2.7 Untested tags, i18n, docs

- Untested register (`src/lib/untested.ts`): `mobile.markup.rounds` (phone
  rounds, pill, Reload); the desktop id is the Mark up button's i18n key
  (register convention: "the label's i18n key where the pill sits on one"),
  e.g. `pdfMarkup.toggle`. Update the `mobile.markup.send` row's text — "the
  layer clears" stops being true.
- Strings via `useT()`; English in `src/lib/i18n.ts` holds every key;
  `src/lib/i18nDicts/{de,es,fr,it}.ts` as the `mobile.markup.*` keys have them.
- Docs: `docs/filemap_frontend.md` (the MarkupView row: rounds/Reload; a row
  for `embed/pdf/PdfMarkup*` + `usePdfMarkup.ts`), `docs/filemap_backend.md`
  (the `mobile_control/` row's markup sentence: `validate_body`, prompt cap;
  a row for `commands/pdf_markup.rs`); `DOCUMENTATION.md` mobile paragraph
  and a desktop PDF viewer paragraph; QA under 31bt in
  `todo/group-h-crossplatform.md` (find it with `rg -n 31bt`) for the phone
  rounds, and a new desktop item with the four platform ✅/❌ pairs;
  `docs/help/mobile.md` sentence on rounds; mark this plan implemented.

### 2.8 Make these changes, and the desktop's own prompts (2026-10-02)

The user answered §5 item 1 with "yes" to both:

- **Make these changes**: with the default instruction the agent only lists
  the changes. Once a Submit's round is `finished` (or `unconfirmed`), the pill
  offers **Make these changes** (`submitState.canApply`); it sends a plain
  follow-up prompt the client words — phone through `onSend` like a typed
  prompt, desktop through `queuePromptForTab` + `holdPhonePrompt` — and starts
  a round with `applied: true`, which never offers the button again; when that
  turn finishes, Reload leads. No backend change: the follow-up is not a
  markup request.
- **Wording**: phone — a second field in Home → This phone → Mark up prompt
  (`markupInstruction.ts` `readMarkupApply`/`writeMarkupApply`, default
  `DEFAULT_MARKUP_APPLY`, ends with `eldrun-send`); desktop — Settings → Agents
  → **PDF markup** (`Settings.pdf_markup_instruction` / `pdf_markup_apply`,
  defaults `DEFAULT_PDF_MARKUP_INSTRUCTION` / `DEFAULT_PDF_MARKUP_APPLY` in
  `lib/viewers/pdfMarkup.ts`, no `eldrun-send` since the viewer reloads from
  disk). The desktop instruction goes to `pdf_markup_submit` as
  `instruction`, bounded like the phone's (`MAX_INSTRUCTION`, plain text).
- Untested ids `mobile.markup.apply`, `desktop.markup.apply`.

## 3. Phases (one implementing subagent each)

All work happens **in the shared working tree on `develop`** — the phone
markup code is uncommitted work of earlier sessions, so a worktree from HEAD
would not have it. No stash, no reset, no commit unless the user asks. Each
phase leaves the gates green and writes `docs/pdf_markup_rounds_handoff.md`
(done steps, design chosen, remaining steps, gotchas, gate status and test
counts). Phase B touches only Rust and can run before or after A; C needs both.

### Phase A — shared core + phone rounds (§2.1–2.5)

1. `layer.ts`: `sent`, `markSent`, `clearSent`, `isLayer` for `sent`. Tests:
   marks move, rounds count, `sent` cap keeps the newest round, eraser /
   `noteAt` / `clearPage` never touch sent marks.
2. `store.ts`: older record loads (no `sent`), `saveLayer` keeps a
   sent-only layer, `withinLimits` with `sent`, `moveLayer`. Tests.
3. `submitState.ts` (§2.2). Tests: sent→working→finished only after
   `SETTLE_MS`; queued; question in between; idle blip shorter than
   `SETTLE_MS` is not finished; unconfirmed after 20 s; working again after
   finished; new Submit restarts.
4. `MarkupView.tsx`: Submit per §2.5, sent rendering, pill, ⋯ entries,
   `refresh` + Reload (iframe remount, `moveLayer`, fingerprint), load effect
   on `key` only, out-of-range pages note.
5. `Terminal.tsx`: `sendMarkup` → `"queued" | "sent" | false`, stops
   closing; `MarkupTarget.agent` from `liveBusy`/`liveQuestion` (memo moved
   below `liveQuestion`); outbox `refresh`. `OutboxViewer.tsx` /
   `ProjectFiles.tsx` pass `agent` and `refresh` through (ProjectFiles
   supplies its own folder re-list).
6. i18n, untested id, CSS in `mobile-web/src/style.css`.
7. Tests: Submit keeps the view and the layer; the second Submit's body holds
   only the new marks and no extra keys; the pill follows `agent`; Reload
   remounts the frame, shows no "changed" note, and switches to a newer outbox
   copy; `sendMarkup` closes nothing and returns `queued` while the screen is
   busy.

### Phase B — desktop backend (§2.6 Backend, Prompt size)

1. `markup.rs`: `validate` → `validate_body` + source check (sidecar behaviour
   unchanged); notes cap in `prompt`.
2. `commands/pdf_markup.rs::pdf_markup_submit`, registered in `lib.rs`.
3. Rust tests: path outside the root / through a symlink / in a hidden folder
   refused; remote and unknown project refused; `.eldrun/outbox/<leaf>` read
   as an outbox source; non-PNG layer refused; marked copy lands in
   `.eldrun/inbox/`; source bytes and mtime unchanged; same prompt as the
   sidecar for the same marks; prompt stays under the cap with 300 noted
   pages. Existing sidecar markup tests stay green.

### Phase C — desktop markup mode UI (§2.6)

1. `agentTabState(ptyId)` extracted into `stores/activity.ts`;
   `MobileBridgeHost` uses it.
2. `PdfMarkupLayer.tsx`, `PdfMarkupBar.tsx`, `usePdfMarkup.ts`.
3. `PdfViewer.tsx`: button + visibility rules, third drag mode, inert remark
   layer, pristine gating, `diskChanged()` for the three reload paths,
   per-window claim, Reload.
4. Target picker, `queuePromptForTab` + `holdPhonePrompt`, pill from
   `agentTabState`.
5. i18n, untested id, docs of §2.7, QA entries.
6. Tests: overlay maps pointer → page units at two zoom levels; markup on
   makes the remark layer inert and turns redact/copy off; each of the three
   reload paths shows Reload instead of repainting while marking (and still
   repaints with markup off); arranged/dirty document → button disabled;
   button hidden for remote / root / popout; second pane can't claim the same
   file; Submit calls the command, then `queuePromptForTab` and
   `holdPhonePrompt` with the returned id; no agent tab → Submit disabled;
   `message_too_long` leaves the marks unsent.

## 4. Verification

Gates at zero warnings after every phase: `npm run build` (also runs
`mobile:build` = `tsc -p tsconfig.mobile.json` + `mobile:bundle`), `npm test`,
`cargo test --manifest-path src-tauri/Cargo.toml`, `npm run lint`,
`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D
warnings`; then `npm run backend:stale` after Phase B and report it. Not run
live from here.

Live checks (for the user):

1. Phone, agent tab on a LaTeX project → files drawer → the built PDF →
   Mark up → strike a word → Submit. The view stays open, the stroke dims, the
   pill says Sent → Agent is working… → Agent finished — PDF unchanged (the
   default instruction only lists changes).
2. While it works: circle another word, Submit → pill "Queued"; the chat (on
   leaving the view) shows the held prompt.
3. In the chat, tell the agent to make the changes and rebuild → back in the
   view the pill goes working → "Agent finished — PDF changed" + Reload →
   Reload: the rebuilt pages appear under the layer, sent marks stay dimmed
   on top to check against; erase each checked one with the eraser.
4. Same with a PDF the agent sent via `eldrun-send` → Reload picks the newer
   copy; closing and reopening that newer copy shows the layer.
5. Desktop: the project's PDF (or the TeX workspace PDF) → Mark up → draw
   with the mouse → Submit → the agent tab receives the prompt; while it
   works, add marks and Submit again (goes into its queue); the recompiled PDF
   does not repaint under the layer, the pill offers Reload, Reload brings it
   at the same zoom/scroll.
6. Desktop with two agent tabs: the picker lists both, defaults to the last
   one you looked at, the choice receives the prompt. No agent tab: Submit
   disabled with the hint. Restart Eldrun: the unsent marks are still there.

## 5. Review notes (2026-10-02)

What the review changed, checked against the code:

- **Rounds model**: sent marks live in `layer.sent`, not as `sent?` on each
  mark — `markup::Mark` is `deny_unknown_fields`, so a flag on a mark would
  fail every second Submit; and keeping `pages` = unsent leaves every existing
  layer function correct with no edits. Found that `saveLayer` deletes a
  record whose `pages` are empty — it would have dropped the sent marks.
- **Busy signal**: the phone's `agentAtWork` mixes in `tab.agent_status`, a
  snapshot from when the Terminal opened (never refreshed in `App.tsx`); the
  pill uses `liveBusy` + `liveQuestion` instead. (Side effect outside this
  plan: a tab opened mid-turn holds every composer prompt until reopened —
  worth a separate look.) Desktop: `useActivityStore` via an extracted
  `agentTabState`. `finished` needs 3 s of stable idle; the pill keeps
  following later turns, because the default instruction makes the agent
  list first and edit only when told.
- **Sent vs held**: `submitDraft` stays boolean; `sendMarkup` reads the busy
  state it holds on. Phone holds go into the CLI queue at once (scheduler +
  `phoneHolds.ts`), so the "held ─delivered─► working" edge of the old diagram
  does not exist; replaced by queued/sent → working.
- **Desktop delivery**: `queuePromptForTab` lives in
  `stores/agents/agentPrompts.ts`, not `MobileBridgeHost`, and on its own
  waits for a stable idle point (and goes `missed` after an hour); the plan
  now adds `holdPhonePrompt(id)` as `holdTabPrompt` does. 16 KB message cap →
  prompt notes cap in `markup::prompt`.
- **Reload, phone**: the sealed frame's `open` is one-shot → remount the
  iframe; sealed tokens don't expire; the load effect's `fingerprint`
  dependency would have raised the "file changed" note after every Reload;
  hosts key their viewer by file, so the swap must happen inside
  `MarkupView`; outbox "newer" compares desktop mtimes, not the phone clock.
  The 5 s fingerprint poll is cut (one check at `finished`; the desktop's mtime
  poll exists).
- **Desktop viewer**: markup is a third mode beside redact/copy (copy that
  sibling's layer and button), allowed only on a pristine arrangement (page
  edits, rotation and merges would break page numbering); three reload paths,
  not one, must defer; one viewer per file per window; remote / root / box /
  popout hidden in v1.
- **Backend**: `markup::submit` is already the AppHandle-free core — only
  `validate` splits; root from `remote::project_directory`, remoteness from
  `remote_target_for`; `AllowanceGuard` is internal to the bake.
- **Code home**: no move to `src/lib/markup/` — the desktop already imports
  `mobile-web/src/...` (`TerminalReaderView.tsx`), and a move would churn
  uncommitted files of concurrent sessions; old step A.5 dropped. i18n
  translations live in `src/lib/i18nDicts/`; `npm run build` already bundles
  the PWA.

Open questions only the user can decide:

1. **Instruction for the round loop.** `DEFAULT_INSTRUCTION` says "list the
   changes, edit no file until I tell you" (your choice of 2026-10-02), so
   after Submit the agent answers with a list and nothing is rebuilt until you
   reply in the chat. Keep it that way (the plan's default: the pill follows
   the follow-up turn), or add a one-tap **"Make these changes"** button in the
   markup view once the agent has finished listing? And should the desktop get
   its own "Mark up prompt" setting (v1 uses the default)? — **Decided
   2026-10-02: both, see §2.8.**
2. **Desktop prompts while the agent works** go straight into the CLI's queue
   (as the phone's do since 2026-09-30). If you would rather have desktop
   markup prompts wait until the agent is idle, say so — it costs the
   one-hour `missed` risk again.
3. **Sent marks after Reload** — decided by the user 2026-10-02: never
   deleted or hidden automatically; they stay shown so the changes can be
   checked by hand and then erased (eraser / Clear page reach shown sent
   marks). A page whose size changed scales its older sent marks; the sent
   side has its own looser storage bound (`SENT_LIMITS`, 4× the desktop's).
