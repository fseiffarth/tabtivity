---
id: root-console
title: The root console and Tabtivity's tools for agents (MCP)
keywords: [root console, root, ctrl+shift+r, host session, no sandbox, mcp, tools, calendar tools, board tools, mail tools, projects_list, todo_add, calendar_add_event, mail_draft_create, approvals, review, proposals, mcp session access, revoke, audit, root chip, mcp chip]
related: [mail-calendar, tabs-and-panels, agent-clis, local-models, scheduled-prompts]
---

The root console is Tabtivity's own place for work that belongs to no single
project. Agents you open there can be given Tabtivity's tools: your calendar,
to-do board, project overview and (if you allow it) mail drafts.

## Open it

**Ctrl+Shift+R** (Cmd+Shift+R on macOS), or the ✦ entry, opens the root
console as a floating window over whatever is open. Its tabs live in
Tabtivity's root folder (`~/tabtivity/root/`), independent of any project.
Closing the window ends nothing; one-click installs open their terminal tab
here.

Agents are opt-in here: in the **Models & agents** menu, turn on an agent's
**Root** chip to offer it in the root console, and its **MCP** chip to give it
Tabtivity's tools.

## The Host session

Every local agent tab runs sandboxed and can write only its project (see
`agent-clis`). The one exception is the root console's **Host session — no
sandbox** in its `+` menu: an agent with full access to this computer, for
repairing or setting things up outside Tabtivity's projects. It still runs in
Tabtivity's own agent home, not your personal CLI config. Use it on purpose.

## What the tools can do

With the **MCP** chip on, a root-console agent (a cloud CLI, or a local Ollama
model behind a tool-capable CLI) can, when you ask it:

- **Calendar**: list calendars and events, find free time, add, edit, move and
  delete events, create a calendar, import an `.ics` file. A CalDAV calendar
  is pushed to its server as a dialog edit would be.
- **To-do board**: list, add, edit, complete, reopen, move and delete cards.
- **Projects**: list projects and boxes, which projects have uncommitted
  work, what is out of sync with its host, recent activity.
- **Time and usage**: time per project and the daily recap's figures.
- **Mail** (only with its own switch, below): list accounts and folders,
  search and read the mail you shared, and write drafts. An agent never sends
  mail.

Examples: "add an entry on Friday at 14:00, one hour", "move every event of
that calendar into the other one", "put a card on the board for project X",
"what did I finish this week?".

Project agents never get these tools. Remote, VM and container tabs don't
either.

## Settings → Agents → Root console and MCPs

- **Tabtivity's tools (MCP) for root-console agents** — on by default; off
  takes them away at once, also from agents already running.
- **Only local models get these tools** — Claude, Codex and other cloud
  agents get none, so your calendar and board never reach a hosted model.
- **Agents get Tabtivity's mail tools** — off by default. On: root agents can
  write mail drafts (never send). **Only local models get the mail tools** and
  **Local models may read the mails you share** narrow it further.
- **Review root-agent writes** — **All writes** (the default: every change
  waits for you), **Destructive writes** (other writes apply at once with
  Undo), or **Off**. Changes to a CalDAV-synced calendar always wait for you.

## Approving what an agent proposes

Waiting changes appear in the **✓ Approvals** pill of the mail, calendar or
board window (each lists its own), grouped as Mail, Calendar, To-do board.
**Approve**, **Reject**, or **Approve all**; an applied change can be undone.
A change proposed by an agent that has read outside mail is marked so. Review
guards writes only — an agent can still tell its provider what it read.

## Docking an agent beside mail, the calendar or the board

In those windows **Ctrl+1** (or ✦ in the title bar) docks your default
root-console agent in a column on the right, **Ctrl+2 … Ctrl+9** the others,
so you can watch its changes land. Details in `mail-calendar`.

## MCP session access

**Settings → Agents → Root console and MCPs → MCP session access** lists every
tab that holds Tabtivity's tools right now (root agents, mail readers, and
project agents' push, schedule and markup sessions):

- Narrow what a session sees — which calendars, which projects and board
  cards, which mail accounts — and whether it may change the calendar, board
  and drafts. Grants apply to that session only.
- **Revoke access** takes the tools from a tab for good; only reopening the
  tab hands out a new token.
- **Recent MCP activity** shows the latest tool calls — time, session, tool,
  outcome — without arguments, message bodies or credentials. A record belongs
  to the tab, so a script running in it counts as the tab too.

Calls to the read-only help (`ask-tabtivity`) are not listed there.

## Which CLIs get the tools

Claude gets them on its command line (`--mcp-config`), Codex through a `-c
mcp_servers.…` override, tool-capable Local Model tabs through Vibe's
environment. Other CLIs receive only the address and token in their
environment. Tabtivity never edits a CLI's own config file to do this. Each
run has its own token, kept in memory only. Whether the agent asks you
before each tool call is the CLI's own setting.
