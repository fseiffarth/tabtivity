---
id: server-sharing
title: Sharing projects, calendars and to-do lists on a server
keywords: [share, sharing, shared project, member, viewer, editor, push, fetch, merge, shared with you, add to my projects, review, agent instructions, shared calendar, shared to-do, open to user, revoke, stop sharing, collaborate, team]
related: [server, git, mail-calendar]
---

On a Tabtivity server you can share a git project, a calendar or a to-do list
with other users of the same server. Everything is in **Settings → Mobile →
Server**. (On a desktop install without a server there is nothing to share
with; see `server`.)

## Sharing a project

Under **Shared projects**, choose one of your git projects and press
**Share**. It needs a first commit; remote, VM and container projects cannot be
shared.

- Your project stays where it is. The server keeps a shared copy of its git
  history that only the people you add can read. Tabtivity's own session
  files are never shared.
- **Add member** with a user name and a role: a **viewer** may read it; an
  **editor** may also push branches under their own name
  (`<name>/<branch>`). Only you move your own branches.
- **Push** sends your checked-out branch. **Stop sharing** removes the shared
  copy (members keep theirs; you can share again later).

## A project shared with you

It appears under **Shared with you**.

- **Add to my projects** clones it into your projects folder; from then on it
  is your project, with your own tabs and agents.
- **Fetch** shows each shared branch against yours (new there / only here);
  **Merge** takes a branch in. Conflicts are never resolved for you: the merge
  is undone and you resolve it in a terminal.
- The card shows who has the project open right now. If you are taken off a
  share or the owner stops sharing, the card turns grey — your copy is never
  deleted.

## Agent instructions from others are reviewed first

Files an agent reads as instructions — `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
`.mcp.json`, `.envrc`, `.cursorrules`, anything in `.claude/`, `.codex/`,
`.gemini/` and similar folders — that another member changed are shown to you
before a **Merge** goes through. After you add a shared project, or merge in a
terminal, no agent starts in it until you press **Review** and **I have
reviewed these**. In a shared project git hooks never run on Commit or Push,
and a merged `latexmkrc` or prettier configuration asks for your approval
again. Worktrees of a shared project count as part of it. An agent in one
shared project cannot read the shared copy of any other.

## Sharing a calendar or a to-do list

Under **Shared calendars and to-do lists**, choose a calendar and press
**Share** — it moves from your own calendar to the server's calendar service
(you are asked first; **Stop sharing** moves it back).

- **Open to user** gives someone its **events**, its **to-dos** or both, as
  viewer or editor. Shared calendars appear in the calendar and on the board
  like your own; an editor's change shows on the others' open pages within
  moments.
- A task's mail and file links, the appointment it came from and its project
  never reach anyone else, and reminders stay each person's own.
- Revoking stops their next read; what they copied before stays theirs.
- The default calendar, CalDAV calendars and subscriptions cannot be shared.

The administrator can switch sharing off for the whole server. Then nothing new
is shared; existing shared projects keep working, shared calendars opened to
you are hidden, and nothing is deleted.
