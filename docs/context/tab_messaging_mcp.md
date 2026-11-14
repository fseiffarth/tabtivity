# Tab messaging MCP

Agent tabs of one local project leave each other short plain-text messages
through a mailbox Tabtivity routes outside their fences. Plan and the user's
decisions: `docs/tab_messaging_mcp_plan.md`; build notes:
`docs/tab_messaging_mcp_handoff.md`.

Tools on `/mcp/tabs` (`Caller::Tabs`, server `<slug>-tabs`,
`services::tabs_mcp`; `tabtivity-mcp call tabs …` for CLIs without a wired
form):

- `tabs_list {}` → `{status:"ok", self:{handle,label}, tabs:[{handle,label,cli}]}`.
- `tabs_send {to, text, replyTo?}` → `{status:"queued", id}`. One recipient.
- `tabs_inbox {ack?}` → drops the acked ids, then `{status:"ok", notice,
  messages:[…≤10], unread}`. Reading does not consume; only `ack` does.

Refusals are normal results with a `category`: `invalid`, `too_large`,
`not_found`, `self`, `inbox_full`, `budget` (+ `retryAfterSecs`), `off`,
`unavailable`. Budget per saved tab per hour: 30 sends, 120 list + inbox
calls.

## Why it exists

Each agent tab runs in its own fence (private `/run`, `/tmp`, PID namespace,
abstract sockets), so a CLI's own peer messaging cannot reach a sibling, and
Claude's is Claude-only anyway. The lane adds **no data path the shared
project folder does not already give** same-project tabs; the security work
is keeping it exactly that narrow.

## Rules that hold it narrow

- **Identity is bound at spawn**: the cockpit lane's binding (state dir,
  scope, saved workspace tab id) plus a class. No tool takes a scope, project
  or tab id. Handles are an HMAC under a per-process key: stable for a saved
  tab while the app runs, meaningless after a restart. The window never shows
  or stores them; it works in saved tab ids.
- **`may_exchange`**: same state dir, same scope, same class. Classes are
  `locked:<project>` (the Local-models-only gate's stamp), `local` (the spawn
  got the `<scope>.local` home) and `cloud`; they never mix, in locked and
  unlocked projects alike. Another project's, another class's and an unknown
  handle answer the same `not_found`, byte for byte.
- **Out of the lane**: root console tabs and the Host session (cross-project
  authority, unfenced), Tabby (pinned tool set), box tabs (a box's view moves
  with its membership), cut-network tabs (the relay refuses `/mcp/tabs`),
  remote, worker, VM and container tabs (another host or folder). The Mobile
  host and a server daemon grant nothing (`Runtime::serves_tabs` is the
  window), so every message is one the window can show.
- **Local models only** is checked four times (`local_models_only.md`):
  class at grant, the registry re-read on every call, the sender's class
  stored and filtered at read, and `purge_scope` when the switch flips.

## Peer text is never the user's

Message text reaches a recipient only as a tool result marked as written by
another agent tab. Tabtivity never types message text, a sender's label or
anything else an agent chose into a prompt. What may reach a prompt is
`tabs_mcp::NOTICE`, one fixed host-built sentence asking the tab to read its
inbox:

- **Hook hint** (Claude only until another CLI's hook output is verified):
  `tabs_send` leaves an empty `<live_dir>/<uid>.mail` marker; the hook prints
  the notice beside the next `UserPromptSubmit` and removes the marker. A
  forged or deleted marker costs a spurious or missed hint, nothing more.
- **Deliver** (the cockpit's Messages fold): the user's click asks
  `tabs_mcp_deliver` for the notice and the tab's schedule target, and the
  window queues it through `queuePromptForTab` — the scheduler's idle gate,
  never `whileBusy`.
- **Idle wake** (per project, off by default, `tab_messages_wake` in
  `projects.json`, never mirrored into the tree): `TabMessagesHost` asks
  `tabs_mcp_wake_claim` on every `tabs-mcp-changed` and queues the notice for
  each target it returns. The claim lives on the host: it re-reads the opt-in
  and the switch, covers one unread batch once, allows six wakes per tab per
  hour, and skips tabs no longer listed (a notice for a closed tab would wait
  for a tab that may not return).

## The user reads everything

The cockpit detail pane's Messages fold lists every message the shown tab
sent or received (sender or recipient, time, read state, full text) as plain
React text under "written by agent tabs, not by you"; no links, no markdown.
The tab hover card shows only the unread count. Both list through
`stores/tabMessages`, which watches a scope only while a visible pane asks
(`PaneVisibleContext`) and refetches on `tabs-mcp-changed`. All window
commands are `client`; nothing crosses `mobile_control`, and the phone has no
view of the lane.

## State

In memory in the window process: members, messages and budgets die with it
(24 h life, 20 unread per recipient, 200 per scope, 2,000 per process). A
respawn or `--resume` of a saved tab keeps its handle and inbox; a closed tab
stops being listed at its PTY exit. Acked messages stay, marked read, until
they expire, so the user can still read them; they make room first when a
cap is hit.

## Cross-OS

Loopback HTTP plus the env pair, so the Linux fence, macOS Seatbelt and
Windows behave alike; the hook hint has its PowerShell twin. On Windows
isolation is the token alone (every process a tab starts holds its tokens).
Cut network, and so the cut-tab exclusion, exists on Linux only.
