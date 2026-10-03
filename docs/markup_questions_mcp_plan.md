# Markup questions MCP — plan

Status: plan only (2026-10-03). Nothing built.

## Why

A PDF markup round today goes one way: the reader marks, Submit sends a
prompt, the agent lists what the marks ask for and ends its turn
(`DEFAULT_INSTRUCTION`), then **Make these changes** goes out
(`docs/pdf_markup_rounds_plan.md` §2.8). When a mark is ambiguous ("does this
arrow move the paragraph or the figure?") the agent can only ask in prose.
The reader then leaves the PDF, reads the chat, and types an answer that
names the mark again in words.

The fix is a small MCP server the agent calls to ask: `markup_ask`. Its
questions show up **inside the markup view** of that tab — the phone's
`MarkupView` and the desktop's `PdfMarkupBar` — as choosable options, each
pinned to the place on the page it is about. A tap delivers the answer into
the tab as the next prompt.

Why not read the CLI's own question dialog off the screen (Claude's
AskUserQuestion, which the phone's Focus already turns into rows,
`QuestionList` in `mobile-web/src/screens/Terminal.tsx`)? That works only for
CLIs and dialogs the phone can parse. It cannot say *where* on the page a
question points, and it doesn't reach the desktop viewer. The MCP is
structured, works with any CLI that takes MCP servers, and carries an anchor.
(Showing on-screen dialogs in the markup view too is a separate, cheap
follow-up. It is not part of this plan.)

## Decisions

1. **Non-blocking ask; the answer comes back as a prompt.** A person needs
   minutes, the listener's sockets live 30 s, and the CLIs time out MCP calls.
   So `markup_ask` returns at once (`shown`, with an id) and tells the agent to
   end its turn. The answer comes back as a user prompt typed into the tab.
   That's honest — it *is* the user's input — and it reuses the delivery the
   desktop markup Submit already has (`queuePromptForTab` + `holdPhonePrompt`,
   straight into the CLI's queue). No polling tool. (The git push lane refuses
   to turn outcomes into prompts. An answer is not an outcome.)
2. **The desktop delivers, for both phone and desktop.** Answering is one
   desktop operation: validate, mark answered, build the prompt, queue it. The
   phone gets the same result whether its terminal socket is up or not, and
   the card disappears everywhere at once. The phone never builds the prompt.
3. **One open ask per tab.** A new `markup_ask` replaces the previous
   unanswered one (it is gone from the views, and its late answer is refused
   with `superseded`). An ask also ends when it is answered, when the agent
   calls `markup_withdraw`, when the user dismisses it, after 24 h, and when
   the tab closes or its session is revoked. State is in memory only, like the
   push proposals: nothing survives a restart.
4. **Keyed by the stable schedule target** (`scheduleTargetId`), which both the
   desktop markup (`usePdfMarkup.ts` `MarkupTarget`) and the phone's bridge
   (`scheduleTargetTab`) already resolve to. The token binds project + target
   at spawn, as the schedule lane does.
5. **Anchors are per question: `page` and `quote`.** `page` is 1-based.
   `quote` is up to 200 characters of the page's own words that the question
   is about. Agents quote text well and are bad at coordinates (the layer PNGs
   are scaled, `LAYER_WIDTH`). The viewers find `quote` in the page's text
   (pdf.js text content: the phone's sealed frame, the desktop's text layer)
   and pin a numbered badge there. Not found or no quote: the pin sits in the
   page's top margin. No page: the question is in the card only. Marks get no
   ids in v1 (they would cost the 12 KB prompt budget). A typed note's own
   text already works as a `quote` when it lies over page text.
6. **Bound to a file, optionally.** `file` is the source path exactly as the
   markup prompt wrote it (`` `…` `` in its first line, `markup::Prompt.source`).
   The host resolves it at ask time under the project root, the way
   `pdf_markup.rs` re-proves a path (`files::read`), and keeps the
   project-relative path. It never comes from the in-folder `project.json`. A
   view shows an ask only when the ask has no `file`, or its file is the one
   shown. Outbox files match by leaf.
7. **On by default, local tabs only, like help.** `Settings::markup_mcp`
   (absent = on), switch in Settings → Manage CLIs. The tool can do nothing
   but put a card in front of the user, and only the user's tap writes into
   the tab. Remote, worker, VM and container tabs are not wired (help's
   reasons, `docs/context/help_mcp.md`). With no window there is no listener:
   the phone's request answers `desktop_unavailable` and the card is hidden.
8. **The phone never sees paths or raw ids.** The card carries the ask's
   random id, the question text, the options and the file's *name*. The
   phone's markup view sends its own source (files token or outbox leaf), and
   the sidecar resolves it to a project-relative path before asking the
   desktop. That resolution is already done in `markup::validate_source`.

## The tools (`services::markup_mcp`, server `<slug>-markup`, route `/mcp/markup`)

```
markup_ask {
  file?: string,                 // as the markup prompt named it
  questions: [                   // 1–4
    { question: string,          // ≤ 400 chars
      header?: string,           // ≤ 24 chars, chip label
      options: [ { label: string /* ≤ 80 */, description?: string /* ≤ 200 */ } ],  // 2–6
      multiSelect?: boolean,     // default false
      page?: integer,            // 1-based
      quote?: string }           // ≤ 200 chars, words on that page
  ]
} → { id, status: "shown", replaced?: id,
      message: "Shown beside the PDF in the user's markup view. Their answer arrives as your next prompt — end your turn now." }

markup_withdraw { id } → { status: "withdrawn" | "not_open" }
```

Every question also offers **Other…** (a typed answer, ≤ 500 chars) and the
card offers **Answer in chat instead** (dismiss), so a question that missed
can't trap the user. Refusals are normal results with a fixed `category`
(`invalid`, `file_not_found`, `budget`, `off`) and one `message`, as in
`git_push_mcp`. Text is cleaned with `root_mcp_mail::strip_invisible`,
whitespace collapsed, and empty strings refused. Budget: 20 asks per tab per
rolling hour, taken in `admit` before any work. Audit: session, tool and
category, never the text (the push lane's rule).

**The answer prompt** (English, deterministic, built in `markup_mcp`):

```
My answers to your markup questions on `docs/paper/draft.pdf`:
1. Does the arrow on p. 3 move the paragraph or the figure? → The figure
2. Which spelling? → Other: "colour", British throughout
```

It is capped at the 12 KB markup budget (`MAX_PROMPT_BYTES`). It never starts
with `/`, `!`, `#`, `$` or `@`: the fixed first line makes sure of that. Typed
text gets the same control-character cleaning as the phone's instruction.

## Steps

### P1 — backend service and lane

- `src-tauri/src/services/markup_mcp.rs` (`AppHandle`-free): `Ask` store keyed
  by `(project, schedule_target)`, `admit` + rate, `ask` / `withdraw` /
  `list(target, path?)` / `answer(target, ask_id, answers) → prompt` /
  `dismiss`, 24 h expiry pruned on every call, a change hook like
  `git_push_mcp`'s. Unit tests: validation bounds, supersede, answer index
  checks (`superseded`, `answered`, `gone`, out-of-range option, multiSelect
  shape), prompt text golden, cleaning.
- `root_mcp.rs`: `Caller::Marker`, lane, `apply_markup_to_spawn{,_with}`
  after the help wiring in `launch_prep.rs` (Claude `--mcp-config`, Codex
  `-c mcp_servers.<slug>-markup…`, tool-tagged Vibe env, other CLIs the inert
  `…_MARKUP_MCP_TOKEN` / `_URL` pair). **Gotcha:** `commands/root_mcp.rs`'s
  `path_serves` maps `/mcp` with a *negative* list. `Marker` must be added
  there or the root registry would serve it. Add the route next to
  `/mcp/help`. The tools go into `root_mcp_security` as served to `Marker`
  alone, with a test like help's. `SpawnTokenGuard`, the PTY exit path,
  `tmux_local::SECRET_ENV` and `sandbox::is_secret_exec_env` learn the new
  variable.
- Tauri commands (`commands/markup_mcp.rs`, camelCase payloads):
  `markup_mcp_list({ projectId, scheduleTargetId, path? })`,
  `markup_mcp_answer({ projectId, scheduleTargetId, askId, answers })` →
  `{ prompt }`, `markup_mcp_dismiss(...)`. Event `markup-mcp-changed`.
  `Settings::markup_mcp`. Session rows hidden from MCP session access, like
  help.
- Gates + `npm run backend:stale`.

### P2 — desktop viewer

- `src/components/embed/pdf/PdfMarkupQuestions.tsx`: the card under
  `PdfMarkupBar` (the shared menu/dialog scheme, explicit `color`). Rows
  with label + description, the `(Recommended)` tag the phone's
  `QuestionList` shows, multiSelect checkboxes + Send, Other…, Answer in chat
  instead. A pin layer over each page (badge `?1`…) placed by finding `quote`
  in the page's text layer. Tapping a pin scrolls the card to its question,
  tapping a question scrolls the page to its pin.
- `usePdfMarkup.ts`: listen to `markup-mcp-changed`, list for the target
  and path, gated on `PaneVisibleContext` with a catch-up on show. Answer →
  `markup_mcp_answer` → `queuePromptForTab` + `holdPhonePrompt`. This is the
  same delivery the markup Submit uses, so queuing mid-turn works the same.
  The round pill (`submitState.ts`) gets no new phase: an open ask reads as
  `question`.
- Manage CLIs switch; i18n keys (English holds all); untested ids
  `desktop.markup.questions`, `markupMcp`.

### P3 — phone

- `protocol.rs`: `DesktopRequest::MarkupQuestions { project_id,
  tmux_session, path? }` (read, 3 s / 2 s timeouts like `GitStates`) and
  `MarkupAnswer { …, ask_id, answers }` (mutation, the `HoldPrompt`
  wrapper's project-eligibility check). Responses carry no path: `file` →
  leaf name.
- Sidecar routes: `GET /api/v1/tabs/{id}/markup/questions?source=…` and
  `POST /api/v1/tabs/{id}/markup/answer` (small body cap). The source is
  resolved through `markup::validate_source` into the project-relative path.
  Headless: `desktop_unavailable`.
- `MobileBridgeHost.tsx`: `markup_questions` / `markup_answer` cases via
  `mobileScope` + `scheduleTargetTab`, then the P1 commands and the same
  queue + hold as `holdTabPrompt`.
- `mobile-web/src/components/MarkupView.tsx`: a docked, collapsible card
  above the palette ("The agent asks · 2"), open when a new ask id arrives.
  The row UI is shared with `QuestionList`: lift its row rendering into
  `components/QuestionRows.tsx` so the Focus list and the markup card look the
  same (copy-the-sibling rule). Pins come from a new `frameProtocol.ts`
  message `findText { page, quote } → { rects }` that the sealed frame answers
  from pdf.js `getTextContent`, validated like every other frame message.
  Poll every 3 s while the view is shown and on each agent edge (`agent`
  prop), never while the page is hidden.
- `Terminal.tsx` Focus: while an ask is open, show a one-line banner above
  the composer, "The agent asks about <file> — Open". It opens the markup view
  on that file. It is a banner, not a chat bubble, so the "bubbles never
  change" rule (`feedback_chat_bubbles_immutable`) is untouched.
- `npm run mobile:bundle`; untested id `mobile.markup.questions`.

### P4 — prompt, docs, QA

- One added sentence in `DEFAULT_INSTRUCTION` (`markup.rs`) and its phone
  copy (`markupInstruction.ts`; the Rust test keeps them equal): *"If a mark
  leaves you a choice, ask me with the `markup_ask` tool if you have it —
  give the page and the words the mark is on — rather than in prose."* A
  phone with its own instruction keeps it. The added sentence changes the
  golden prompt test.
- `docs/context/markup_mcp.md` (why the ask doesn't block, delivery, limits),
  added to AGENTS.md's context list; filemap rows; a `docs/help/` section so
  `<slug>-help` knows the tool; QA items under group-h 31bt with the platform
  ✅/❌ pairs.

## Verification

Unit tests per phase as listed, all six gates. Live QA (user-run, after
loading a build with the backend):

1. Mark up a PDF in a Claude tab, draw an ambiguous arrow, Submit. The agent
   calls `markup_ask`, and the card appears in the open markup view with a
   pin at the quoted words.
2. Tap an option. The answer arrives as the next prompt (mid-turn: queued),
   and the card disappears on the desktop and the phone.
3. Ask twice: the first card is replaced. Answer from a stale card:
   `superseded`, nothing typed.
4. Other… with typed text; multiSelect; Answer in chat instead.
5. Phone with the window closed: no card, no error. Codex tab: same flow.
6. Settings → Manage CLIs off: a new tab has no `markup_ask`.

## Out of scope

On-screen CLI dialogs inside the markup view; mark ids in the prompt; asks
from remote/VM/container tabs; push notifications for a new ask (the turn
end's existing push covers it); asks about pictures (anchored to the page
only — they work, but without pins).
