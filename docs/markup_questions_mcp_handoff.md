# Markup questions MCP — handoff

Plan: `docs/markup_questions_mcp_plan.md`. Branch `markup-mcp` (worktree
`.claude/worktrees/markup-mcp`), base `34c4b5cb`. Nothing here was run live.

## P1

Done, on `markup-mcp`:

- `8e3fae17` Add the markup questions MCP lane: markup_ask and markup_withdraw
- `1d8c7e8e` Add the window's markup question commands and change event

### What was built

**Service** `src-tauri/src/services/markup_mcp.rs` (`AppHandle`-free).

- Server name `markup_mcp::SERVER_NAME` = `<slug>-markup` (`tabtivity-markup`),
  built with `concat!(app_slug!(), "-markup")`. Route `POST /mcp/markup`.
- Tools `markup_ask` and `markup_withdraw` (`markup_mcp::TOOLS`). They are in
  `root_mcp_security::tool` as family `"markup"`, write, served to
  `Caller::Marker` only (`ToolPolicy::marker`).
- Asks are kept in memory and keyed by `(project, schedule target)`. There is
  one open ask per key: a new one supersedes the open one, and the result
  carries `replaced`. Records live 24 h (`RETENTION`). A record is dropped when
  its `Session::id` is no longer alive, which covers tab close, respawn and
  revoke. The store holds at most 1000 records.
- Budget: 20 `markup_ask` calls per **tab** per rolling hour
  (`ASKS_PER_HOUR`). The counter lives in the service, keyed by tab id. It is
  taken after argument validation and before the file is resolved, so an
  invalid call costs nothing.
- Bounds (characters after cleaning): 1–4 questions; question ≤ 400; header
  ≤ 24; 2–6 options with label ≤ 80 and description ≤ 200; quote ≤ 200;
  page 1..=100000; file ≤ 1024 bytes; Other… ≤ 500. Unknown fields are
  refused (`deny_unknown_fields`). Two options with the same label are
  refused.
- Cleaning (`markup_mcp::clean`): `root_mcp_mail::strip_invisible`, then
  whitespace collapsed to one line. A required text that is empty after
  cleaning is refused; an optional text that is blank counts as absent.
- `file` may be project-relative (an optional leading `./` is allowed) or
  absolute below the project. It is resolved by `resolve_file(root, file,
  prove)`, which runs `markup::resolve_local_source` (plain names only; hidden
  names refused, except the outbox). Then `files::exists` or `outbox::exists`
  proves it is a regular file with no link on the way. Both of those are new
  and open the file without reading it. Backslashes, backticks and control
  characters are refused. The root is `projects.json`'s
  (`markup_mcp::project_root`: remote → `None`). The file is stored
  project-relative; an outbox source is stored as `.tabtivity/outbox/<leaf>`.
- Refusals are a normal tool result:
  `{ status: "refused", category, message }` with category `invalid`,
  `file_not_found`, `budget` (+ `retryAfterSecs: 3600`) or `off`.
  `refusal_reason` maps a reply to that fixed category for the audit.
- `markup_ask` → `{ id: "ask-<16 hex>", status: "shown", replaced?: id,
  message: "Shown beside the PDF in the user's markup view. Their answer
  arrives as your next prompt — end your turn now." }`.
- `markup_withdraw { id }` → `{ status: "withdrawn" | "not_open" }`. Only the
  ask's own (project, target) can withdraw it.
- Answer prompt (`answer_prompt`): English and deterministic.

  ```
  My answers to your markup questions on `docs/paper/draft.pdf`:
  1. <question> → <label>
  2. <question> → <label>; <label>; Other: <typed text>
  ```

  The first line has no `on `…`` part when the ask names no file. A
  multiSelect question lists the picked labels in option order, joined with
  `; `, with `Other: …` last. The prompt is capped at
  `markup::MAX_PROMPT_BYTES` (12 KB). When it would be longer, the question
  texts are cut to 120 characters first, then the answers are cut evenly with
  `…`.
- Public API for P2/P3:
  - `list(project, target, Shown) -> Vec<AskView>`, where `Shown` is `All`,
    `File(rel)` or `Elsewhere`.
  - `answer(project, target, ask_id, &[Answer]) -> Result<String,
    AnswerError>`.
  - `dismiss(project, target, ask_id) -> Result<(), AnswerError>`. It is
    idempotent.
  - `same_file(asked, shown)`: equal paths, or, when either path is in the
    outbox, the same leaf after `outbox::sent_name`.
  - `resolve_file`, `project_root`, `sweep()`, `set_change_hook`,
    `CHANGED_EVENT`.

**Answer checks.** There must be one `Answer` per question, in order. A
single-select question needs exactly one of: one option index, or `other`. A
multiSelect question needs at least one, with unique indices. Indices must be
in range. `other` is cleaned; blank or over 500 characters is refused. Errors
(`AnswerError::code()`):

- `superseded`: a newer ask replaced it.
- `answered`: already answered.
- `gone`: withdrawn, dismissed, expired, session gone, unknown, or another
  target's ask.
- `invalid_answer`: the answers do not fit the questions.

A refused answer changes nothing. A successful one marks the ask answered
**before** returning the prompt.

**Lane** (`services/root_mcp.rs`)

- `Caller::Marker` (serde `"marker"`) is lane 4. It is hidden from
  `sessions()` (MCP session access), refused by `set_access`, and left out of
  `tab_active` and `mark_tab_projects_readable`, like help.
- Env pair: `root_mcp::MARKUP_TOKEN_ENV` = `TABTIVITY_MARKUP_MCP_TOKEN` and
  `root_mcp::MARKUP_URL_ENV` = `TABTIVITY_MARKUP_MCP_URL`.
- `apply_markup_to_spawn_with(opts, runtime, token, tool_models)`:
  - needs `project_id` and a non-empty `schedule_target_id`; not a container
    tab;
  - Claude/Codex are named the server via `wire_named_cli_args`;
  - a tool-tagged Vibe gets it merged into `VIBE_MCP_SERVERS` /
    `VIBE_ENABLED_TOOLS`; an untagged local model gets nothing;
  - other CLIs get the env pair.
- `apply_markup_to_spawn(opts)` for real spawns. It requires an agent, a
  local project (not remote/worker, container or VM project, the same checks
  as git push), a target that passes `agent_tasks::validate_id`, the listener
  up and `Settings::markup_mcp()`. It registers `Identity { caller: Marker,
  project, schedule_target: ScheduleBinding { target, agent } }`.
- `launch_prep.rs` calls it after help, for `agent_spawn && !root_agent &&
  reader_project.is_none()`.
- The token is treated as a secret in several places:
  - `SpawnTokenGuard` holds the markup token too.
  - On PTY exit the token is revoked, then `markup_mcp::sweep()` runs, which
    rings the change hook.
  - `tmux_local::SECRET_ENV` has the key appended last, so existing
    `update-environment` slots don't move.
  - `sandbox::is_secret_exec_env` and the git push preflight's env strip know
    the key.
- `root_mcp_mail::origin_of` maps Marker to `"marker"`.
- `#[cfg(test)] root_mcp::test_session_bound(caller, tab, project, target)`
  is a test helper for bound sessions.

**Listener** (`commands/root_mcp.rs`)

- `.route("/mcp/markup", …)`.
- `path_serves`: `"/mcp"`'s negative list now names `Marker`, and
  `"/mcp/markup" => caller == Marker`.
- The `Marker` branch in `handle`:
  - a revoked session gets 401;
  - otherwise `markup_mcp::handle_message` runs in `spawn_blocking`;
  - the audit row gets session, tool and the fixed category, never text.
- `root_mcp_session_revoke` also calls `markup_mcp::sweep()`.
- `start()` installs the change hook (`commands::markup_mcp::install_change_hook`).

**Tauri commands** (`commands/markup_mcp.rs`, registered in `lib.rs`). JS keys
are camelCase:

- `markup_mcp_list({ projectId, scheduleTargetId, path? })` →
  `AskView[]`. `path` may be the desktop's absolute path or a
  project-relative one; a path that does not resolve lists only the asks
  without a file. Each `AskView` is:

  ```
  { id, file: string|null, fileName: string|null, createdAt: rfc3339,
    questions: [{ question, header?, options: [{ label, description? }],
                  multiSelect, page?, quote? }] }
  ```

- `markup_mcp_answer({ projectId, scheduleTargetId, askId, answers: [{
  options?: number[], other?: string }] })` → `{ prompt }`. The answers are
  strictly shaped: unknown keys and negative indices fail deserialisation.
- `markup_mcp_dismiss({ projectId, scheduleTargetId, askId })` → `null`.
- Errors are strings: `superseded`, `answered`, `gone`, `invalid_answer`,
  `invalid_target` (empty/control-char ids), `markup_failed`.
- Event `markup-mcp-changed`, with no payload. It rings whenever an ask opens,
  closes or expires, or a session sweep drops one. Re-list on it.

**Settings**: `Settings::markup_mcp: Option<bool>` (absent = on) with
accessor `markup_mcp()`. TS: `Settings.markup_mcp?: boolean`. When it is off,
new tabs are not wired, and running tabs' `markup_ask` answers category `off`
(initialize and tools/list still answer).

**TS touched (minimal)**: the `RootMcpSecurity.tsx` `Caller` union gained
`"marker"`; i18n `mcpSecurity.marker` (en/de/fr/it/es), because marker calls
are audited and the audit table labels the class.

### Deviations from the plan, and why

- **Wiring scope**: `apply_markup_to_spawn` uses git push's local checks,
  not `help_reaches`. Help also wires a `local_only` tab of a remote project.
  For such a tab, the project folder a `file` resolves under is remote, and
  the desktop markup refuses remote projects anyway.
- **Budget per tab, in the service** (not a `Session` field like push's).
  This way a respawn does not reset it, and `root_mcp::register_token` stays
  untouched.
- **`off` is a tool result, not a 403.** The plan lists `off` as a refusal
  category, and this way the agent can tell the user where to switch it on.
- **Every question must be answered** (single-select exactly one). The card
  has "Answer in chat instead" for anything else.
- **`files::exists` / `outbox::exists`** prove the path without reading up to
  24 MB. The plan said "the way `pdf_markup.rs` re-proves a path
  (`files::read`)". These are the same checks, minus the read.
- **Server name not in `brand.rs`'s name pairs.** A pair needs a legacy form,
  and `eldrun-markup` never existed.
- **Post-commit dev build skipped** (`TABTIVITY_NO_AUTO_DEV_BUILD=1`). These
  are feature-branch commits in a worktree; the hook would have queued a
  rebuild of the main checkout.
- `npm run backend:stale` not run (it concerns the main checkout's running
  window; as instructed).

### Gotchas for P2/P3

- `markup_mcp_answer` closes the ask before the caller queues the prompt. If
  `queuePromptForTab` / `holdPhonePrompt` then fails, the card is gone. Show
  the error and the prompt text rather than retrying the answer, because a
  retry will say `answered`.
- The event exists only while the root MCP listener runs (`start()` installs
  the hook). Headless there is no listener, so there are no asks (P3:
  `desktop_unavailable`).
- `list` prunes: an expired or orphaned ask can disappear on a list call, and
  the event rings then too.
- Matching a file is `same_file` against the project-relative form. P3 should
  pass the sidecar's resolved project-relative path as `path`. An outbox
  source's rel is `<OUTBOX_DIR>/<leaf>`.
- The phone must get `fileName`, never `file` (decision 8).
- Untested-tag ids are not added yet. P2 adds `desktop.markup.questions` and
  `markupMcp`; P3 adds `mobile.markup.questions`.
- No `DEFAULT_INSTRUCTION` change, no `docs/context/markup_mcp.md`, no help
  doc yet (P4).

### Gates (at `1d8c7e8e`)

- `cargo test`: lib 3257 passed, 2 ignored; all other test binaries green.
  16 new tests: 12 in `services::markup_mcp`, 2 in `services::root_mcp`, 1 in
  `commands::root_mcp`, 1 in `commands::markup_mcp`, and help's tests extended.
- `cargo clippy --all-targets -- -D warnings`: clean (rustc 1.97.1).
- `npm run build`: OK.
- `npm test`: 694 files, 7070 tests passed.
- `npm run lint`: 0 errors. There are 31 warnings, all pre-existing in files
  this phase did not touch (`no-explicit-any` etc.).
- `scripts/brand-check.sh`: OK. `scripts/privacy-check.sh`: OK (also run by
  the pre-commit hook). `git diff --check`: clean.

## P2

Done, on `markup-mcp` (nothing run live):

- `180e14d1` Reopen a markup question whose answer could not be delivered
- `9373a5a4` Show the agent's markup questions beside the PDF in the desktop markup view
- `1a5a141f` Add the markup questions MCP switch to Manage CLIs

### The reopen fix (P1 gap)

`markup_mcp_answer` still closes the ask before the window queues the
prompt, but it now answers `{ prompt, receipt }`. When queueing fails, the
caller calls **`markup_mcp_reopen({ projectId, scheduleTargetId, askId,
receipt })`** (service: `markup_mcp::reopen`). It opens the ask again only
for the answer that receipt names. It refuses, and leaves the ask closed,
when:

- another view answered it (`answered`, the receipt does not match);
- a newer ask of the same (project, target) came in after it
  (`superseded`; an answered ask is not marked superseded by the newer one,
  so this checks for any later record of the key);
- it was withdrawn, dismissed or expired, or its session is gone (`gone`).

Reopening an ask that is already open is `Ok` (idempotent). A spent receipt
(the ask was reopened and then answered again) is `answered`. The answer
mints a fresh receipt every time. Test:
`reopen_undoes_only_the_answer_whose_prompt_was_not_delivered`.

P3 must do the same in `MobileBridgeHost`'s `markup_answer`: answer, queue +
hold, and on a queue failure reopen with the receipt before reporting the
error to the phone. The receipt never goes to the phone.

### What was built

- **`src/lib/viewers/markupQuestions.ts`** (no React; P3's bridge can reuse
  it): types `MarkupAsk` / `MarkupQuestion` / `MarkupAnswer`,
  `MARKUP_MCP_CHANGED`, the four typed calls (`listMarkupQuestions` (null →
  `[]`), `answerMarkupQuestions`, `reopenMarkupQuestions`,
  `dismissMarkupQuestions`), `questionReasonKey(code)` (the ask's codes, then
  the Submit's `markupReasonKey` for queue refusals), `splitRecommended`, the
  card's pick model (`QuestionPick`, `NO_PICK`, `toggleOption`,
  `toggleOther`, `answersOf` → one `MarkupAnswer` per question, or `null`
  while incomplete or Other… is blank), and pin placement (`quoteRects`:
  the whole quote via `pdfPageMatches`, else its first six words;
  `pagePins` → `QuestionPin { askId, index, rects, slot }`, with margin slots
  for a quote that is missing or not found).
- **`usePdfMarkup.ts`** returns `questions: MarkupQuestions` (`asks`,
  `answering`, `failure { text, prompt? }`, `answer`, `dismiss`, `focus`,
  `show`).
  - Listing runs only while markup mode is on with a target. It re-lists on
    `markup-mcp-changed` and only while the pane is visible; a change heard
    while hidden is caught up on show (the effect re-runs on `visible`).
    Listing pauses while an answer is in flight, so the card does not flicker
    away between answer and reopen.
  - Answer: `markup_mcp_answer`, then `queuePromptForTab` + `holdPhonePrompt`.
    On success the ask is removed locally and a new round starts
    (`startRound(queued, now, previous.applied)`). On a queue failure it
    reopens and shows "The questions are still open — try again". If the
    reopen is refused too, it shows the prompt text to paste.
  - Round pill: an open ask while the tab is idle is fed to the round
    machine as `question`. The bar then says "The agent asks about your
    marks — answer below" (`pdfMarkup.round.asks`), and `canApply` is false
    while an ask is open.
- **`src/components/embed/pdf/PdfMarkupQuestions.tsx`**:
  - `PdfMarkupQuestions`: the card under `PdfMarkupBar`, rendered by
    `PdfViewer` only while marking.
  - `AskCard`: the reader's question card classes
    (`terminal-reader-question` / `-option` / `-recommended`). This is the
    desktop sibling of the phone's `QuestionList`, so no new row treatment.
    A single question that is single-select answers on the click. Otherwise
    the rows toggle (☐/☑ for multiSelect) and **Send answers** sends.
    Other… opens a text field (max 500). **Answer in chat instead**
    dismisses.
  - `useQuestionPins(doc, asks)`: reads `pageTextItemBoxes` only for the
    pages the questions name, once per document.
  - `PdfQuestionPins`: the `?n` badges, rendered inside `PdfPageCanvas` (new
    `questionPins` prop) above the markup layer (z 8). The badge copies the
    remark marker's pin shape in the accent colour. When the card asks for a
    question, its quoted words light up with the current-search-hit class.
  - Pin click → `show(…, "card")` → the card scrolls to that question and
    flashes it. Chip click → `show(…, "page")` → `scrollIntoPdfBox` on the
    pin.
- **`src/components/agents/MarkupMcpSettings.tsx`**: the switch in Manage
  CLIs → Advanced, after `GitPushMcpSettings` (`markup_mcp ?? true`).
- CSS: `viewers.css`, after `.file-viewer-pdf-markup-round`.
- i18n: `pdfMarkup.round.asks`, `pdfMarkup.questions.*` (21 keys),
  `markupMcp.title` / `.help`, all five languages.
- Untested rows: `desktop.markup.questions` (card head pill) and `markupMcp`
  (switch label).
- Filemap rows for the new files; the backend row of
  `commands/markup_mcp.rs` names reopen.

### Components P3 can mirror

- The card's behaviour: `AskCard` (direct-pick rule, multiSelect + Send,
  Other…, dismiss, keep the card on failure).
- The pick model and answer shape: `answersOf` / `toggleOption` /
  `toggleOther` in `lib/viewers/markupQuestions.ts`. These are pure, and
  `mobile-web` can import them as the desktop imports the phone's markup
  core.
- Pins: `quoteRects` / `pagePins`, which take the same `TextItemBox` runs.
  The phone's sealed frame would answer `findText` with rects computed this
  way.

### Deviations, and why

- **The card shows only while markup mode is on.** The target tab is chosen
  only then (`chosen` is fixed when markup comes on), and the plan puts the
  questions in the markup view. Nothing on the Mark up toolbar button tells
  you an ask is waiting while the mode is off.
- **The rows are the reader's question card, not a new list.** It is the
  existing desktop look for the same thing (`LiveQuestion` /
  `AskedQuestions`). A picked row reuses the answered card's `chosen` look.
- **The answer starts a round.** The pill follows the agent's turn on the
  answer, as it does after Submit, and keeps the previous round's `applied`
  flag.
- **The quote fallback tries the first six words** before falling back to
  the margin. Agents' quotes may run across a line break the PDF set
  differently.

### Gates (at `1a5a141f`)

- `cargo test`: lib 3258 passed, 2 ignored; every other test binary green.
  New: 1 service test; the command test was extended.
- `cargo clippy --all-targets -- -D warnings`: clean (rustc 1.97.1).
- `npm run build`: OK.
- `npm test`: 695 files, 7084 tests passed. New file
  `src/__tests__/pdf/PdfMarkupQuestions.test.tsx` has 14 tests: render,
  click-to-answer delivery, multiSelect + Send, Other…, dismiss, delivery
  failure → reopen → retry, failure without reopen shows the prompt, refused
  answer, pane-visibility gating with catch-up, pill + Make these changes,
  pin placement, pin click and focus, and the pick model.
- `npm run lint`: 0 errors, 31 warnings, all in files this phase did not
  change (the same count as P1). The one warning in `PdfViewer.tsx`
  (`viewPos.initial`) is in an effect P2 did not touch.
- `scripts/brand-check.sh`, `scripts/privacy-check.sh`, `git diff --check`:
  OK.
- `npm run backend:stale` not run (it concerns the main checkout's window).
  Commits were made with `TABTIVITY_NO_AUTO_DEV_BUILD=1`. The first commit
  went without it, but the hook declined the build anyway ("inside an agent
  fence").

### Open for P3/P4

- Phone side (P3); `DEFAULT_INSTRUCTION` sentence, `docs/context`, help doc
  and QA items (P4).
- Live QA of the desktop card is owed. Check in particular:
  - pin placement on real PDFs: rotated pages are excluded by the markup
    gate, and pins are read at rot 0;
  - the card's own scroll box at small window heights;
  - focus behaviour of the Other… field (`autoFocus`).

## P3

Done, on `markup-mcp` (nothing run live):

- `fcbc763f` Serve the agent's markup questions to the phone through the sidecar and the window's bridge
- `f32ff191` Let the sealed PDF frame find a quote's boxes on its page
- `77637730` Show the agent's markup questions on the phone, pinned to the page
- `b30700d6` Show the agent's own Recommended word in the shared question rows

### What was built

**Protocol** (`services/mobile_control/protocol.rs`)

- `DesktopRequest::MarkupQuestions { project_id, tmux_session, path? }`.
  It is a read, with 3 s / 2 s deadlines like `GitStates`.
- `DesktopRequest::MarkupAnswer { …, ask_id, answers: [MobileMarkupAnswer] }`
  and `DesktopRequest::MarkupDismiss { …, ask_id }`. Both are mutations. The
  dismiss is its own variant rather than a flag on the answer.
- `MobileMarkupAnswer { options: u32[], other? }` is `deny_unknown_fields`.
- `DesktopResponse::MarkupQuestions { asks: [MobileMarkupAsk] }`. Each ask
  is `{ id, file_name?, questions: [{ question, header?, options:
  [{ label, description? }], multi_select, page?, quote? }] }`. The struct
  has no `file` field, so a path the desktop sends is dropped when the
  sidecar re-encodes the answer.
- A delivered answer or a dismissal is acknowledged with `Seen`.
- New desktop error codes: `delivery_failed` (the prompt could not be queued
  and the ask is open again) and `not_delivered` (it could not be queued, and
  the reopen was refused). The ask codes `superseded`, `answered`, `gone` and
  `invalid_answer` pass through unchanged.

**Sidecar routes** (`services/mobile_control/host.rs`)

- `GET /api/v1/tabs/{id}/markup/questions[?source=files:<token>|outbox:<leaf>]`.
  - The tab must be an agent tab.
  - The source is checked with `markup::validate_source`. A files token goes
    through the file browser's gates (`files_off`, `files_unavailable`, then
    unseal); an empty token or the root token is `invalid_source`. An outbox
    leaf becomes `<OUTBOX_DIR>/<leaf>`.
  - Only that project-relative path goes to the desktop. With no source,
    every open ask of the tab is listed (the Focus banner).
  - Answers `{ asks }`. Each ask's `file_name` is cut to its bare leaf and
    passed through `outbox::sent_name`. An ask whose id is not `ask-<hex>` is
    dropped.
- `POST /api/v1/tabs/{id}/markup/answer` with body `{ ask_id, answers }`.
  - Body cap 16 KiB; the exact origin is required.
  - It is shaped before the desktop is asked: 1–4 answers, each with at most
    6 indices, every index < 6, and Other… ≤ 500 characters with no control
    characters. A bad shape is `400 invalid_answer`; a bad body or ask id is
    `400 invalid_request`.
  - The ask's own refusals and the two delivery codes answer `409`.
- `POST /api/v1/tabs/{id}/markup/dismiss` with body `{ ask_id }`. Body cap
  1 KiB.
- With no window (headless), all three routes answer
  `503 desktop_unavailable`, which the phone reads as "no card". There is no
  headless fallback: the asks live in the window's process. Each route checks
  `desktop_down` explicitly in `markup_call`. `headless.rs` has no request
  dispatcher, so there is nothing to add there.
- Test: `markup_questions_cross_as_leaf_names_and_answers_as_indices`. The
  questions route was added to `AUTHENTICATED_GETS`.

**Bridge** (`src/components/mobile/MobileBridgeHost.tsx`)

- `markup_questions`, `markup_answer` and `markup_dismiss` go through
  `mobileScope` and `scheduleTargetTab` (`markupTarget`). A box or the root
  console scope lists no asks.
- `markup_questions` calls `listMarkupQuestions(project, target, path)` and
  maps each `AskView` to the phone's snake_case shape. It sends `fileName`
  only, never `file`.
- `markup_answer`:
  1. `answerMarkupQuestions`.
  2. `queuePromptForTab` + `holdPhonePrompt`, the same delivery as
     `holdTabPrompt`.
  3. If queueing fails, `reopenMarkupQuestions(…, receipt)`, which yields
     `delivery_failed`; if that reopen is refused, `not_delivered`. The
     receipt never leaves the window.
- `mutationDomain`: answer and dismiss are in `"schedules"`.
- Tests: `src/__tests__/mobile/MobileMarkupQuestions.test.tsx` (6).

**Shared pick model.** `src/lib/viewers/markupQuestionPicks.ts` holds the
types, `splitRecommended`, `NO_PICK`, `toggleOption`, `toggleOther`,
`answersOf` and the new `answersOnTap`. It has no imports.
`markupQuestions.ts` re-exports it. The split was needed because
`markupQuestions.ts` imports `invoke` and `tex.ts`, which must not enter the
phone bundle. `listMarkupQuestions`'s `path` is now optional.

**Frame** (`mobile-web/src/markup/frameProtocol.ts`, `pdfFrame/main.ts`,
`markup/findText.ts`)

- The PWA sends `findText { id, page, quote }` and the frame answers
  `found { id, page, rects }`.
- Request bounds: the quote is 1–400 code units and not blank; `id` is an
  integer in 0..1e9; `page` is in range.
- Answer checks: the page must be within the announced count; at most 32
  rects (`MAX_FOUND_RECTS`); every number finite; `w` and `h` ≥ 0.
- The frame reads the page's text through pdf.js `getTextContent` in its own
  viewport at scale 1, the same units as `meta`. It boxes the runs as
  `pageText.ts` does. Only boxes leave the frame.
- `findQuote` ignores whitespace altogether, folds case with NFKC (so
  ligatures match), drops a hyphen that ends a line, and falls back to the
  first six words.

**Phone UI**

- `components/QuestionRows.tsx` holds the row list lifted out of
  `QuestionList`. The Focus behaviour is unchanged: same classes, the
  current row, the pending label, the free-text field, and the agent's own
  `Recommended` word.
- `components/MarkupQuestionsCard.tsx` is docked at the top of
  `.markup-palette`. The palette now also renders while reading, when there
  is a card.
  - The head reads "The agent asks · n" and folds the card. A new ask id
    opens it again.
  - Each question shows `?n`, its header, the question text, a
    "Pick any that apply." hint, rows plus Other…, and a "Show on page N"
    chip on PDFs.
  - A single single-select question answers on the tap. Otherwise the rows
    are picked (☐/☑ for multiSelect) and **Send answers** sends; the Other…
    field's button then reads OK.
  - **Answer in chat instead** dismisses.
  - Refusals show in the card. `superseded`, `answered` and `gone` re-list.
  - While an answer is in flight the card pauses the poll.
- `markup/questions.ts` `useMarkupAsks(tabId, source, active, edge, paused)`
  polls every 3 s and on the `agent` edge. It never polls while the page is
  hidden. `desktop_unavailable` and refusals clear the asks; offline and
  timeout keep them.
- `MarkupView`:
  - The card shows only for an agent tab's view (`tabId` and `onSend`), not
    for a new-tab Submit.
  - It asks the frame for every question's quote once per document, and
    asks again after Reload.
  - Pins: an `?n` badge at the first box, or in the top margin while the
    frame has not answered or found nothing. Tapping a pin opens the card
    and flashes that question. The chip scrolls the page and lights the
    quote's boxes for 1.6 s.
  - An answer starts a round, so the pill follows the turn. **Make these
    changes** is hidden while an ask is open.
  - Pictures get no pins.
- `screens/Terminal.tsx` Focus shows a one-line `sign-in-notice` banner over
  the session facts while an ask is open, worded one of three ways:
  - "The agent asks about <file>" with **Open**, when the tab's outbox has a
    file whose `sentName` equals `file_name`. Open opens that file in the
    outbox viewer, which for a PDF is the markup view in reader mode.
  - "… about <file> in its markup view", when the outbox does not have it.
  - "… about your marks in the markup view", when the ask has no file.
- The banner's poll runs only while Focus is the view and no viewer,
  gallery or file browser covers it.
- i18n: `mobile.markup.questions.*` (23 keys) in all five languages.
- Untested row `mobile.markup.questions`. The pill shows on the card head
  and on the banner.
- CSS: `style.css`, after the note editor. Colours are the phone's own. The
  flash is a static fill; no shadow is animated.
- Filemap rows: the `MarkupView` row (frontend), the `MobileBridgeHost` row,
  the `PdfMarkupQuestions` row (the pick module), and the `mobile_control/`
  row (backend).
- Tests: `src/__tests__/mobile/MobileMarkupQuestionsCard.test.tsx` (13):
  - `findQuote` and the frame protocol bounds;
  - one-tap answer: picks only, no prompt text; the round starts;
  - multiSelect + Other… + Send answers;
  - `delivery_failed` keeps the card, then dismiss;
  - fold, and reopen on a new ask;
  - no poll while hidden or in a new-tab view;
  - PDF pin from the frame's `found`, pin → card, chip → highlight;
  - the Focus banner, with and without the outbox file.

### Deviations, and why

- **`?source=files:<token>` / `outbox:<leaf>`** carries the plan's one
  `source` parameter as a prefixed string, because a query string cannot
  carry `MarkupSource`'s JSON shape.
- **Dismiss is a third request and route**, not a flag on the answer. Its
  body and its refusals differ.
- **`file_name` is passed through `sent_name`.** The phone shows and matches
  the name a file was sent as. An outbox copy and its project file then
  match, as `same_file` does on the desktop.
- **The banner opens only outbox files.** The phone gets a leaf name, never a
  path. The project file browser is folder-by-folder with sealed tokens, so
  a leaf alone cannot find a project file. In that case the banner names the
  file and has no Open button.
- **The card also shows while reading**, not only while marking. The PDF
  reader is the same view, and the banner opens it in reader mode.
- **`MobileTerminalInbox.test.tsx`** routes the new poll out of its counted
  fetches, as it already did for the outbox, transcript and status polls.
- `fcbc763f` left two literal `.tabtivity/outbox` paths in the bridge test.
  `77637730` changed them to `NAMES.outboxDir`, so brand-check is green at
  HEAD but not at `fcbc763f`.
- `npm run backend:stale` was not run, because it concerns the main
  checkout's window. Commits were made with `TABTIVITY_NO_AUTO_DEV_BUILD=1`.

### Gates (at `b30700d6`)

- `cargo test`: lib 3260 passed, 2 ignored; every other test binary green.
  2 new tests: `protocol::markup_questions_cross_by_tab_pair_and_answers_stay_strict`
  and the host route test above.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `npm run build`: OK. `npm run mobile:bundle`: OK. `mobile-dist/` is
  untracked, so there was nothing to commit.
- `npm test`: 697 files, 7103 tests passed (was 7084; 19 new).
- `npm run lint`: 0 errors, 31 warnings, the same pre-existing set, none in
  touched files.
- `scripts/brand-check.sh`: OK.
- `scripts/privacy-check.sh b8d34709..HEAD`: OK.
- `git diff --check`: clean.

### Open for P4 / live QA

- P4 is untouched: the `DEFAULT_INSTRUCTION` sentence, `docs/context`, the
  help doc and the QA items.
- Live checks owed:
  - pin placement on real PDFs: pdf.js text-run widths on the phone's legacy
    build, rotated pages, and the badge offset at high zoom;
  - the card's height over the palette on a small phone with the keyboard
    up (the Other… field);
  - the 3 s poll's cost on a phone left in Focus;
  - the banner's Open on an outbox PDF.
- Not covered:
  - a multiSelect Other… cannot be unticked once typed; the reader can
    retype it, or answer in chat;
  - a picture opened from the banner needs a tap on Mark up before the card
    shows, because the outbox viewer opens pictures read-only.

## P4

Done, on `markup-mcp` (nothing run live):

- `92cc7eff` Point the default markup instruction at the markup_ask tool
- `ede5fca7` Document the markup questions MCP and add its QA items

### What was built

- **Instruction.** `markup::DEFAULT_INSTRUCTION` and its phone copy
  `DEFAULT_MARKUP_INSTRUCTION` (`mobile-web/src/markupInstruction.ts`) end with
  "If a mark leaves you a choice, ask me with the `markup_ask` tool if you
  have it — give the page and the words the mark is on — rather than in
  prose." The desktop's default (`pdfMarkup.ts`) and the Settings → Agents →
  PDF markup starting text re-export the phone constant, so they follow. The
  golden `the_prompt_is_deterministic_and_ordered` was updated;
  `the_phone_shows_the_same_default` holds the copies equal. The prompt
  budget subtracts the tail's actual length, so the 300-page budget test
  still means what it says (and passes). A stored own instruction (phone or
  desktop) is untouched. `docs/mobile_pdf_markup_plan.md` keeps the old text
  (history).
- **`docs/context/markup_mcp.md`**: rationale (non-blocking ask, the window
  delivers, the reopen receipt, one ask per tab, keyed by schedule target,
  page + quote anchors, the file binding, git push's locality check, budget
  and refusals, what the phone sees, headless `desktop_unavailable`), known
  limits, and a nine-step user-run live QA list. AGENTS.md's context list
  names `markup_mcp`; the backend filemap row of `services/markup_mcp.rs`
  points at it.
- **Help**: `docs/help/mobile.md` gains "The agent's questions about your
  marks" (where the card shows on each side, pins, answering, Other…, Answer
  in chat instead, supersede, desktop must run, the Manage CLIs switch), a
  pointer from the Mark up bullet, and the keywords `markup_ask` / `questions
  about marks`. `real_corpus_parses` is green.
- **QA** (`todo/group-h-crossplatform.md`, 31bt): five 🖐️ items with the
  platform pairs — desktop card + pins, phone card + pins, Focus banner,
  delivery failure → reopen, the switch.
- **Open issues as TODOs**: 31bv (phone: a typed Other… cannot be unticked),
  31bw (phone: the banner's Open only for outbox files; a picture needs a tap
  on Mark up) in group-h; #2341 (desktop: no hint on the Mark up button while
  marking is off) in `todo/group-m-viewers.md`.
- **DOCUMENTATION.md**: one paragraph after the phone's markup loop.

### Deviations

- The help section went into the Mobile topic, which already holds the PDF
  markup text for phone and desktop; there is no desktop viewer topic.
- No `untested.ts` rows: P2/P3 added `desktop.markup.questions`, `markupMcp`
  and `mobile.markup.questions`, which the QA items name.

### Gates (at `ede5fca7`)

- `cargo test`: lib 3260 passed, 2 ignored; every other test binary green.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `npm run build`: OK.
- `npm test`: 697 files, 7103 tests passed (unchanged; no TS tests touched).
- `npm run lint`: 0 errors, 31 warnings (the same pre-existing set).
- `scripts/brand-check.sh`, `scripts/privacy-check.sh`, `git diff --check`:
  OK.
- `npm run backend:stale` and `npm run mobile:bundle` not run for the main
  checkout (worktree branch). The phone's default instruction is in the PWA
  bundle, the desktop's in the binary: both need the rebuild that merging
  brings. Commits used `TABTIVITY_NO_AUTO_DEV_BUILD=1`.

## Review 1

General review of `8dba5c4c..7adc6570` (plan, P1–P4) on `markup-mcp`,
2026-10-03. Nothing run live; the app was not started.

### Checked and sound

- **Token lane.** `path_serves` names `Marker` in the `/mcp` negative list and
  `/mcp/markup` serves only `Marker`. The registry serves the two tools to
  `Marker` alone, and `Policy::serves` refuses `Marker` the root tools.
  `handle_with` re-checks the class, `check()` and the project + target
  binding. `MARKUP_TOKEN_ENV` is in every secret list: `SpawnTokenGuard`, the
  PTY exit path (revoke + `sweep`), `tmux_local::SECRET_ENV` (appended),
  `sandbox::is_secret_exec_env` and the push preflight's strip. The lane is
  hidden from `sessions()`, `set_access`, `tab_active` and
  `mark_tab_projects_readable`. The audit keeps the tool name only for
  registered tools.
- **`file`.** `\`, backticks and control characters are refused. Resolution
  is lexical: no `..`, only absolute paths below the `projects.json` root,
  hidden names refused except the outbox. `files::exists` / `outbox::exists`
  prove a regular file with no link on the way. The path is stored
  project-relative.
- **Text and prompt.** Every field is cleaned (`strip_invisible`, whitespace
  collapsed). The answer prompt has a fixed first line and stays within
  12 KiB at every bound: the third render clips each answer to its share of
  the budget, and the golden test covers the worst case.
- **Phone.** The ask id and the leaf name cross; the path and raw ids do not.
  The source is a sealed token or an outbox leaf. The body caps are 16 KiB
  and 1 KiB, and answers are shaped before the window is asked. `findText` is
  bounded in both directions, and only boxes leave the frame.
- **Receipt.** It is bound to project, target, id and the answer it was
  minted for. It is spent on reopen and never leaves the window.
- **Races.** Supersede, answer, dismiss, withdraw, expiry and session death
  hold under one lock. A second view gets `answered`. A newer ask makes a
  reopen `superseded`.
- **Polling.** Desktop polling is gated on `PaneVisibleContext` with a
  catch-up on show. The phone polls only while the page is visible, pauses
  while an answer is in flight, and stops on unmount. Timers and listeners
  are cleaned up.
- **Conventions.** i18n keys are the same set in all five dictionaries. No
  blurred shadow is animated (the pins and card use static shadows).

### Findings

| # | Severity | Where | What | Status |
|---|---|---|---|---|
| 1 | Medium (open item 31bv) | `mobile-web/src/components/QuestionRows.tsx:72`, `MarkupQuestionsCard.tsx` `onPick` | On a multiSelect question, a typed **Other…** could not be unticked: every tap on the free-text row opened its field. | Fixed in `5cbfacc6`. A ticked free-text row's tap goes to `onPick`, and the card clears Other… there; the next tap opens the field. The Focus `QuestionList` never sets `checked`, so it is unchanged. Test: "unticks a typed Other…". TODO 31bv is `[~]` with automated ticked. |
| 2 | Low (open item #2341) | `src/components/embed/pdf/usePdfMarkup.ts`, `PdfViewer.tsx` Mark up button | With marking off, nothing told the reader that an agent tab was waiting on an answer. | Fixed in `f7503932`. While marking is off and the pane is on screen, `usePdfMarkup` lists every agent tab of the project for the file (again on `markup-mcp-changed`) and exposes `askWaiting`. The button gets `is-armed` and the tooltip `pdfMarkup.toggleAsks` (all five languages), and Mark up opens the strip on the asking tab. Tests: "an ask waiting while marking is off" (2). The untested row `desktop.markup.questions`, the context doc, the help doc, DOCUMENTATION.md and the filemap row are updated, and TODO #2341 is ticked as automated. |
| 3 | Low | `usePdfMarkup.ts` list effect | The open-mode listing depended on the `target` object, so it re-listed whenever the project's tab list changed. | Fixed in `f7503932`: it now depends on `scheduleTargetId`. |
| 4 | — (open item 31bw) | Focus banner | **Open** works only for outbox files. | Not fixed. A project file would need the sidecar to mint a files token for the ask's path, but the protocol deliberately carries no path to the phone side (`MobileMarkupAsk` has no `file`). That is a protocol change, not a small fix. |

### Report only

- Like the push lane, the markup lane writes an audit row for every
  JSON-RPC message, so `initialize`, `tools/list` and `ping` appear as
  "protocol". That is about three rows per spawned tab in the 500-row ring.
  The help lane skips auditing for exactly this reason. This copies the
  sibling, so it was left alone.
- Pins on a rotated page: both viewers box the text runs with pdf.js
  `item.width`, as the desktop search highlight does. A run on a turned page
  may be boxed as if it ran across. This is already on the live-QA list.
- The sidecar's `markup_call` reads any transport error, including a window
  slower than the 2 s deadline, as `desktop_unavailable`. A wedged window
  therefore hides the phone's card rather than keeping it, which matches the
  protocol comment's intent.

### Gates (at the commit that adds this section)

- `cargo test`: lib 3260 passed, 2 ignored; every other binary green.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `npm run build`: OK.
- `npm run mobile:bundle`: OK.
- `npm test`: 697 files, 7106 tests passed (was 7103; 3 new).
- `npm run lint`: 0 errors, 31 warnings, the same pre-existing set.
- `scripts/brand-check.sh`: OK.
- `scripts/privacy-check.sh 7adc6570..HEAD`: OK.
- `git diff --check`: clean.
- Commits used `TABTIVITY_NO_AUTO_DEV_BUILD=1`.
- `npm run backend:stale` is not applicable: this is a worktree branch, and
  the review changed no backend code.

## Review 2

Second, independent general review of `8dba5c4c..a3f3726e` (plan, P1–P4 and
review 1's fixes) on `markup-mcp`, 2026-10-03. Nothing run live; the app was
not started.

### Checked and sound

- **Lane and secrets.** `/mcp/markup` serves only `Marker`, `/mcp`'s negative
  list names it, the registry serves the two tools to `Marker` alone, and
  `handle_with` re-checks class, revocation and the project + target binding.
  `MARKUP_TOKEN_ENV` is in `SpawnTokenGuard`, the PTY exit path (revoke, then
  `sweep` outside the token lock — no lock-order inversion with `prune`'s
  `session_alive`), `tmux_local::SECRET_ENV`, `sandbox::is_secret_exec_env` and
  the push preflight's strip. Wiring is local project tabs only.
- **Text.** Every agent string is cleaned (`strip_invisible` drops control
  characters, ESC included) and rendered as React text on both views; no raw
  HTML. The answer prompt's fixed first line keeps it off `/ ! # $ @`, `file`
  can hold no backtick or control character, and the 12 KiB cap holds.
- **Phone.** No path or raw id crosses (bridge sends `file_name` only, the
  sidecar re-strips to a bare leaf). The phone bundle has no `invoke`: the
  card imports only `markupQuestionPicks.ts`; no `React.lazy`. `findText` is
  bounded both ways (quote ≤ 400, ≤ 32 finite boxes, page within the
  document); a frame answer that fails validation is dropped and the pin
  falls back to the margin.
- **Lifecycle.** Answer, reopen (receipt bound to the answer, spent once,
  refused after a newer ask), dismiss, withdraw, expiry and session death all
  run under the store lock; the change hook rings after the lock is dropped.
  Delivery failure → reopen works the same from the desktop card and the
  phone bridge. multiSelect and Other… agree end to end (pick model, sidecar
  shape check, `answer_text`), including review 1's untick.
- **Hooks.** Listeners, timers and in-flight reads are cleaned up; the
  desktop list and the phone poll are gated on visibility and paused while an
  answer is in flight. i18n: the 49 new keys and their placeholders are the
  same in all five dictionaries. Untested rows exist for all three ids.

### Findings

| # | Severity | Where | What | Status |
|---|---|---|---|---|
| 1 | Low (review 1's report-only item) | `src-tauri/src/commands/root_mcp.rs:211`, `services/markup_mcp.rs` `audited` | The lane wrote an audit row for every message, so each new tab's `initialize` / `tools/list` (and `ping`) took ~3 rows of the 500-row ring. | Fixed in `99ee76d1`: only tool calls and refusals (any JSON-RPC error, a refused tool result, a revoked session) are audited; admission failures were and are recorded before the lane. Test `the_audit_keeps_tool_calls_and_refusals_but_not_the_handshake`. Context doc updated. |
| 2 | Low (cost) | `src/components/embed/pdf/usePdfMarkup.ts:345` | Review 1's marking-off probe (`askWaiting`) depended on `idleIds`, a memo over the `targets` object, so every change of the project's tab list (a relabel, any other tab's update) re-listed every agent tab over IPC — the same pattern review 1 fixed for the open-mode listing. | Fixed in `49bc8a21`: keyed by the joined target ids. Test "is not read again when the project's tabs change but its agent tabs stay" (failed first: 4 reads instead of 2). |
| 3 | Low (docs) | `docs/help/mobile.md:130` | The help said switching the setting off "applies to newly opened tabs"; running tabs are refused as `off` too. | Fixed in `b367e05a`. |

### Report only

- `useQuestionPins` (`PdfMarkupQuestions.tsx:246`) rebuilds the pins —
  `pdfPageMatches` over each named page's text runs — on every `PdfCanvas`
  render while marking with an open ask, and hands each pinned page a new
  props object. At most four questions; a perf nicety, not a bug.
- A `markup_withdraw` that lands between an answer and its delivery answers
  `not_open`; if that delivery then fails, `reopen` brings the ask back. The
  window is one IPC round trip; left alone.
- While marking is on with tab A chosen, an ask from tab B about the same
  file shows nothing (the `askWaiting` hint runs only with marking off). By
  design (the card is per target), but not said in the context doc.
- The agent's question text is echoed into the answer prompt, which arrives
  as the user's own message. Any process in the tab holds the token
  (documented), so after one tap its words reach the agent as "user" input.
  The user reads that text in the card first; noted for the threat model.
- 31bw (Focus banner opens only outbox files) left open, as review 1 did.

### Gates (at the commit that adds this section)

- `cargo test -q`: lib 3261 passed, 2 ignored (was 3260; 1 new); every other
  binary green.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `npm run build`: OK.
- `npm run mobile:bundle`: OK; the phone bundle carries no `__TAURI_INTERNALS__`
  or `markup_mcp_*` command.
- `npm test`: 697 files, 7107 tests passed (was 7106; 1 new).
- `npm run lint`: 0 errors, 31 warnings — the same pre-existing set.
- `scripts/brand-check.sh`: OK.
- `scripts/privacy-check.sh` (tree and `a3f3726e..HEAD`): OK.
- `git diff --check`: clean.
- Commits used `TABTIVITY_NO_AUTO_DEV_BUILD=1`. `npm run backend:stale` is not
  applicable: a worktree branch, not the running window's tree.
