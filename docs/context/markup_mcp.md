# Markup questions MCP

An MCP server, `tabtivity-markup` (`services::markup_mcp`, route
`/mcp/markup`, `Caller::Marker`), that lets a local agent tab ask the reader
about their PDF marks and tick off the ones it has handled. Three tools:
`markup_ask` (1–4 questions, 2–6 options each, an optional `file`, and per
question an optional `page` + `quote`), `markup_withdraw { id }` and
`markup_done { file, round, marks: [{ page, mark }] }` (see **Ticks** below;
plan `docs/markup_tick_approve_plan.md`). The questions show as a card in that tab's markup
view — the desktop's `PdfMarkupQuestions` under `PdfMarkupBar`, the phone's
`MarkupQuestionsCard` in `MarkupView` — with a numbered pin at the quoted
words. A tap answers. On by default (`Settings::markup_mcp`, absent = on;
switch in Manage CLIs → Advanced). Plan and phase notes:
`docs/markup_questions_mcp_plan.md`, `docs/markup_questions_mcp_handoff.md`.

How often the agent may ask is the reader's dial, not the instruction:
`markup::ASK_LINES` words five stops (ask about every mark … never ask,
default `DEFAULT_ASK` = only unreadable marks and real choices), and the
prompt puts the chosen line after the instruction — the phone's own
(`markupInstruction.ts`, sent as `ask`) or the desktop's
(`Settings::pdf_markup_ask`). Every stop but "never" points at the tool, "if
you have it" — a remote tab or a switched-off setting has no tool, and the
sentence then costs nothing. It used to be one fixed sentence in
`DEFAULT_INSTRUCTION` ("if a mark leaves you a choice, ask"), and agents read
it as a question per mark; the dial exists so a long markup is not a quiz.

That "if you have it" wording is for a round sent from an agent tab's chat,
where the reader also sees a question asked in prose. A round started
elsewhere (`markup::Origin::Viewer`: every desktop viewer Submit, and the
phone's `MarkupView` with no `onSend`, sent as `origin: "viewer"`) gets
`VIEWER_ASK_LINES` + `VIEWER_ASK_ONLY` instead: ask only with `markup_ask`,
never in the reply or the CLI's own picker (AskUserQuestion), and without
the tool say so and list the questions in the reply. Agents told "if you have
it" often asked in their chat, which the reader at the PDF never saw. An
older phone bundle sends no `origin`: the chat wording.

## Why it is shaped this way

- **The ask does not block; the answer is a prompt.** A person needs
  minutes, the listener's sockets live 30 s, and the CLIs time out MCP calls.
  `markup_ask` returns at once (`shown`, an `ask-<hex>` id) and tells the
  agent to end its turn. The answer comes back as a user prompt typed into the
  tab through the markup Submit's own delivery (`queuePromptForTab` +
  `holdPhonePrompt`, straight into the CLI's queue mid-turn). It *is* the
  user's input, so this is honest. The git push lane refuses to turn outcomes
  into prompts; an answer is not an outcome. There is no polling tool.
- **The window delivers, for both views.** Answering is one desktop
  operation: validate, mark answered, build the prompt (`answer_prompt`,
  English, deterministic, capped at `markup::MAX_PROMPT_BYTES`, fixed first
  line so it never starts with `/`, `!`, `#`, `$` or `@`), queue it. The phone
  only sends option indices and Other… text; it never builds the prompt.
- **The reopen receipt.** The ask is closed *before* the prompt is queued, so
  two views cannot both deliver. If queueing then fails, the caller hands back
  the receipt the answer minted (`markup_mcp_reopen`) and the ask opens again
  — only for that answer, and not when another view answered, a newer ask came
  in, or it was withdrawn, dismissed or expired — a `markup_withdraw` that
  finds the ask already answered spends its receipt, so a delivery that then
  fails does not bring back a question the agent took back. A refused reopen shows the
  prompt text to paste (desktop) or `not_delivered` (phone). The receipt never
  leaves the window.
- **One open ask per tab.** A new ask supersedes the open one (`replaced` in
  the result; its late answer is `superseded`). An ask also ends when
  answered, withdrawn, dismissed (**Answer in chat instead**), after 24 h, or
  when its session dies (tab close, respawn, revoke — `markup_mcp::sweep()`
  on PTY exit and on revoke). Memory only, like the push proposals: nothing
  survives a restart.
- **Keyed by the schedule target.** Asks live under `(project,
  scheduleTargetId)`, the stable id both the desktop markup (`MarkupTarget`)
  and the phone's bridge (`scheduleTargetTab`) already resolve to. The token
  binds project + target at spawn, like the schedule lane.
- **Anchors are page + quote, not coordinates.** Agents quote text well and
  place coordinates badly (the layer PNGs are scaled). `quote` is ≤ 200
  characters of the page's own words. The desktop finds it in pdf.js text
  runs (`quoteRects`: the whole quote, else its first six words); the phone
  asks its sealed PDF frame (`frameProtocol.ts` `findText { page, quote }` →
  `found { rects }`, bounded and validated like every frame message; only
  boxes leave the frame). Not found or no quote: the pin sits in the page's
  top margin. No page: card only. Marks carry no ids (they would cost the
  prompt budget); a typed note's text works as a quote when it lies over page
  text.
- **Bound to a file, optionally.** `file` is resolved on the host at ask time
  under the `projects.json` root (`resolve_file`: plain names, no hidden
  parts except the outbox, `files::exists` / `outbox::exists` prove a regular
  file with no link on the way) and stored project-relative. Never from the
  in-folder `project.json`. A view shows an ask that names no file, or names
  the shown one (`same_file`; outbox copies match by sent name).
- **Local only, with git push's locality check.** Wired by
  `apply_markup_to_spawn` for local project agents only — not remote or
  worker tabs, VM or container projects, container tabs — not by
  `help_reaches`. Help also wires a `local_only` tab of a remote project, but
  there the folder a `file` resolves under is remote, and the desktop markup
  refuses remote projects anyway. Wiring is help's: Claude `--mcp-config`,
  Codex `-c mcp_servers.…`, tool-tagged Vibe merged into `VIBE_MCP_SERVERS`,
  other CLIs the inert `TABTIVITY_MARKUP_MCP_TOKEN` / `_URL` pair.
  `SpawnTokenGuard`, the PTY exit path, `tmux_local::SECRET_ENV`,
  `sandbox::is_secret_exec_env` and the push preflight's env strip know the
  variable. `path_serves` maps `/mcp` with a negative list; `Marker` is in it.
- **Budget and refusals.** 20 asks per tab per rolling hour, counted in the
  service by tab id (a respawn does not reset it), taken after argument
  validation and before the file is resolved. Refusals are normal results
  `{ status: "refused", category, message }`: `invalid`, `file_not_found`,
  `budget` (+ `retryAfterSecs`), `off`. Switched off, running tabs still
  answer `initialize` and `tools/list` and `markup_ask` says `off`, so the
  agent can name the setting. Text is cleaned (`strip_invisible`, whitespace
  collapsed). Tool calls and refusals get an audit row — session, tool and
  category, never text; the handshake (`initialize`, `tools/list`, `ping`)
  gets none, as help writes none (`audited`), so new tabs don't fill the ring.
- **What the phone sees.** The ask's random id, the questions and the file's
  *leaf* (`fileName`, through `outbox::sent_name`) — never a path or a raw
  project id. For the Focus banner (no source) the window also hands the
  sidecar the ask's project-relative `path`; the sidecar always takes it out
  and, while the file browser is switched on, gives the phone the file as
  the drawer would row it instead (`file_row`: sealed token, its folder's
  token, the folder trail of names — `files::entry`, no link on the way). Its markup view sends its own source (`?source=files:<token>`
  or `outbox:<leaf>`), which the sidecar resolves through
  `markup::validate_source` (the file browser's gates, then unseal) before
  asking the window. An outbox *copy* of a project file reaches the view as
  that file: `tabtivity-send` records where it copied from (`.<leaf>.src`,
  `outbox.rs`), the outbox listing turns that into the same sealed `file_row`
  (`host.rs` `file_row`, same gates), and `OutboxViewer` opens the project
  file in its place — one phone-side layer per project file (`files:` key),
  wherever it is opened from, so its asks use `files:<token>` too. Answers are shaped in the sidecar before the window is
  asked (16 KiB body, ≤ 6 indices each < 6, Other… ≤ 500, no control
  characters).
- **Headless: `desktop_unavailable`.** The asks live in the window's
  process; with no window there is no listener and no ask. The three phone
  routes answer `503 desktop_unavailable`, which the phone reads as "no card".

## Ticks (`markup_done`)

The reader wants to see which marks the agent has dealt with and clear them
with one tap. A Submit that carries a round id (`markup::valid_round`, minted
by the view) gets a prompt that names every listed mark `p<page> m<mark>`
(`mark` = index into that page's submitted marks + 1; a picture's marks
`m<mark>` alone, which the line tells the agent are page 1) and a line
pointing at `markup_done` "if you have it". Marks the prompt does not list
(a stroke nothing is known about) get no reference and so no tick. The agent calls `markup_done { file, round,
marks }` after making a mark's change; the views show a ✓ on each ticked mark
and the reader's tap approves it, which removes the mark. Nothing is removed
without that tap — the rounds plan's "never delete or hide markers
automatically" rule stands.

- **Mapped client-side, by round id + page + mark index.** The host stores
  only `(round, page, mark)` per file — it never sees a mark's shape (the
  layer lives in the phone's IndexedDB or the desktop's layer store) and marks
  carry no ids (they would cost the prompt budget). Each view keeps a log of
  what each round sent, page by page in submitted order, and maps a tick to
  the mark equal to `log[round].pages[page][mark - 1]` in its sent layer. A
  tick that matches nothing (erased, approved, an undone round, older than the
  log) is dropped by the view; a tick can never reach an unsent mark. The
  round id is what makes `m3` stable: the same page's `m3` in another round is
  another mark.
- **Bound to a file, always.** `file` is required and resolved exactly as
  `markup_ask`'s (`resolve_file`, proven to exist); reads match with
  `same_file`, so the outbox copy and the project file share their ticks. A
  view of a file outside the project (`Shown::Elsewhere`) gets none.
- **Memory only, like the asks.** Records `{ session, project, target, file,
  round, page, mark, created }` under `(project, scheduleTargetId)`; pruned at
  24 h, when the ticking session dies (`sweep()`, as asks), and past 5 000
  (the oldest of the tab holding the most go first, so one tab ticking in
  bulk cannot push another's out). A tick already there (same target, round, page, mark,
  `same_file`) is a no-op; `{ status: "ticked", count }` counts the new ones
  and `markup-mcp-changed` rings only when some landed (or some were pruned).
- **Bounds and budget.** 1–200 marks per call, duplicates collapse, page
  1..=`MAX_PAGE`, mark 1..=`MAX_MARK` (`markup::MAX_MARKS`, no page holds
  more). Its own 60 calls per tab per rolling hour, apart from the asks'
  20. Refusals as `markup_ask`'s: `invalid`, `file_not_found`, `budget`,
  `off` (the switch covers all three tools).
- **Read side.** `markup_mcp::ticks(project, target, Shown) → [{ round, page,
  mark }]` (no session, project, file or path). Desktop:
  `markup_mcp_ticks({ projectId, scheduleTargetId, path? })` (TS
  `listMarkupTicks`, `lib/viewers/markupQuestions.ts`). Phone: `GET
  /markup/questions` answers `ticks` beside `asks`; the window's bridge
  (`MobileBridgeHost` `markupQuestionsFor`) fills them, a window without the
  command answers none, and the sidecar drops any tick outside the bounds
  (`host.rs` `valid_tick`). Headless: `desktop_unavailable`, as for the asks.
- **The log and the mapping** live in the shared core
  (`mobile-web/src/markup/layer.ts`): `mintRound`, `markSent(.., roundId)`
  (logs each moved page's `marks` — the same array the Submit body sent —
  as `SentLayer.log`, newest `MAX_LOGGED_ROUNDS` = 6, trimmed further so the
  log never passes `SENT_LIMITS`), `tickedMarks` (the logged mark by
  reference on the sent side; by equality only when none of that round's
  marks on the page is still the same object — a record rebuilt from a copy
  — and never onto a mark another logged round holds, so an approved mark's
  identical twin never inherits its ✓),
  `approveMark(s)`, `forgetRound`; `clearSent` / Clear all marks drop the
  log. A page rescaled by a later round (rebuilt PDF, new size) rescales the
  log's marks with it (same objects), so ticks still match. IndexedDB's
  structured clone keeps the log's marks shared with the sent side, and
  `withinLimits` does not count the log; a record whose log is unreadable
  loads without it (marks kept). Records from before ticks have no log.
- **Desktop** (`usePdfMarkup.ts`, `PdfMarkupTicks.tsx`): Submit mints the
  round and passes it to `pdf_markup_submit`; ticks are read with the asks'
  triggers (`markup-mcp-changed`, pane visible, Mark up on) from **every**
  agent tab of the project — the round id already ties a tick to one
  Submit's marks, so a tick still shows after the reader picks another tab;
  a rejecting command (stale backend) counts as no ticks. A ✓ (the question
  pin in the success colour) sits at each ticked sent mark's top-right
  corner while sent marks are shown; its click is an ordinary undoable edit
  that removes only the very mark object the badge was drawn for (badges are
  keyed by mark identity and a double click's second click is ignored, so
  neither focus + Enter nor a click on a badge sliding into place takes
  another mark); the strip's status line shows **n done · Approve all**. A
  successful Undo of an `apply` round forgets that round from the log in the
  whole edit history — its ticks then show nothing, the marks stay.
- **Phone** (`MarkupView.tsx`, `api.ts` `readMarkupQuestions`,
  `markup/questions.ts`): Submit sends `round` in the `/markup` body and logs
  the marks only when every sent page's `marks` array is still the one the
  body carried (as the desktop). The ticks ride the questions poll (3 s while
  the view is up, never hidden, on agent edges) for the view's own tab and
  file; the Focus banner's request (no `source`) keeps none, an older
  sidecar's missing `ticks` reads as none, malformed rows are dropped. The ✓
  is the question pin (`markup-pin is-tick`) centred on `markBox`'s top-right
  corner, kept on the page, PDFs and pictures alike, while sent marks show.
  A tap approves exactly the badge's mark object (identity in the updater,
  then still ticked), never while a stroke is under way or a Submit goes
  out, never within `ARRIVAL_GUARD_MS` of that badge appearing (a pen
  mid-stroke), never as a double tap's second click or within 350 ms of the
  last approve; **Approve all** waits out the newest badge's guard.
  **n done · Approve all** is its own `markup-round` row under the pill.
  Unlike the desktop it reads only the view's own tab — the Focus chat's,
  or the tab this view's new-tab Submit opened; a PDF reopened from the
  file browser has no tab yet and shows no ✓ (the asks have the same reach).

## Known limits

- **The token is inherited** by every process in the tab, as with the
  schedule, push and help lanes. Anything in the tab can put a card in front
  of the user — and nothing more: only the user's tap writes into the tab.
- **Every question must be answered** (single-select: exactly one). Partial
  answers go through **Answer in chat instead**.
- The desktop card shows only while markup mode is on (the target tab is
  chosen when it comes on). `usePdfMarkup` also lists the project's other
  agent tabs for the file (on screen only, keyed by their ids): with the mode
  off every one (`askWaiting` — the Mark up button is underlined and opens
  the strip on the asking tab), while marking every one but the chosen
  (`askElsewhere` — the strip names it with **Show its questions**, which
  switches the target).
- The phone's Focus banner opens an outbox file, or a project file only while
  the file browser is switched on (`file_row`); otherwise it names the file.
- Pictures get no pins. A picture opened from the banner needs a tap on Mark
  up before the card shows.
- Out of v1: mark ids, remote/VM/container tabs, a push notification for a
  new ask.
- **A dialog of the CLI's own is never answered from the markup view** — a
  permission prompt (Allow / Deny), the CLI's question picker. Approving a
  command needs the whole dialog and what it was drawn onto, which only the
  tab shows, and the screen parse that would carry it is a guess per CLI
  version. While a round waits on one, the pill shows its question line
  read-only (`submitState` `dialogLine`) and a leading way there: desktop
  **Answer in tab** (`showTarget`; the line comes from
  `lib/agents/tabDialog.ts`, which redraws the hidden tab's retained output —
  `pty_scrollback` — offscreen, since a hidden pane's xterm is not fed),
  phone **Answer in chat** (`toChat`; the Focus screen's own `liveQuestion`)
  or, for a round sent to a new tab, its **Open tab**.

## User-run live QA

Only after choosing to load a build with the backend; agents never restart
the app. QA group-h 31bt.

1. Desktop: open a PDF of a local project in the viewer, **Mark up**, draw an
   ambiguous arrow, Submit to a Claude tab. The agent calls `markup_ask`; the
   card appears under the bar with `?n` pins at the quoted words. Pin → card
   scrolls to and flashes its question; **Show on page N** → the page
   scrolls to the pin and lights the quote.
2. Pick an option and **Send answers**: the answer arrives as the next prompt (mid-turn: queued),
   the card disappears on the desktop and the phone, the round pill follows
   the turn.
3. Ask twice: the first card is replaced. Answer from a stale card (phone
   left open): `superseded`, nothing typed.
4. Other… with typed text; a multiSelect question with **Send answers**;
   **Answer in chat instead** closes the card everywhere.
5. Phone: the same PDF from the tab's outbox in `MarkupView` — the card on
   top of the palette ("The agent asks · n"), pins from the sealed frame,
   a tap only picks and **Send answers** sends (never one tap, even for one
   single-select question; the fresh card ignores taps for 1.2 s — it opens
   under a pen mid-stroke), folding and reopening on a new ask. Several
   questions show one at a time, paged with ‹ n / m ›; a pin turns the card
   to its question and picks survive paging. In reader mode too. The
   desktop card follows the same rules.
6. Phone Focus: the banner "The agent asks about <file>" with **Open** for an
   outbox file, and for a project file while the file browser is on (opens
   it in the files viewer, Mark up shows the card); without Open otherwise.
   Desktop: mark up for one agent tab while another asks about the same PDF —
   the strip names it, **Show its questions** switches to it.
7. Delivery failure: make queueing fail (e.g. the tab's schedule cap) — the
   card stays with "still open, try again" (desktop) / `delivery_failed`
   (phone), and a retry delivers.
8. Window closed (headless host): the phone shows no card and no error.
   Codex tab: the same flow.
9. Manage CLIs → Advanced switch off: a new tab has no `markup_ask`; a tab
   opened before answers `off`.
