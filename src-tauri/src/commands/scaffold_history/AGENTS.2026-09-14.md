# Agents

Canonical instructions for every AI coding agent working in this project.
The agent-specific files are pointers to this one — write guidance **here**
so every agent reads the same thing.

## Project

_What this project is and what it is for._

## Running

_Build, run and test commands._

## Conventions

_Layout, style, and anything an agent must not do._

## Showing the user a file

To put a file in front of the user on their phone (Eldrun Mobile), run
`eldrun-send <file>` — any file up to 24 MiB; images, PDFs and text show
on the phone, anything else is offered as a download. Local and container
tabs. `command | eldrun-send -n tests.log` sends stdin; `eldrun-send --clear`
empties the outbox. Copying into `.eldrun/outbox/` by hand still works.

## Agent files

- [AGENTS.md](./AGENTS.md) — this file: the single source of truth
- [CLAUDE.md](./CLAUDE.md) — Claude Code; imports this file
- [GEMINI.md](./GEMINI.md) — Gemini CLI; imports this file

## Project docs

- [PROJECT.md](./PROJECT.md) — map of the scaffold: every file linked, with what it is for
- [README.md](./README.md) — overview
- [DOCUMENTATION.md](./DOCUMENTATION.md) — reference documentation
- [ROADMAP.md](./ROADMAP.md) — planned direction
- [TODO.md](./TODO.md) — open work items
- [REMARKS.md](./REMARKS.md) — project-wide remarks attached to files and lines
- [STATUS.md](./STATUS.md) — current state
