---
id: codex
title: Codex in Tabtivity
keywords: [codex, openai, chatgpt, install, login, sign in, resume, hooks, sandbox]
---

Codex is OpenAI's coding agent CLI (command `codex`). Tabtivity runs it in agent
tabs and resumes its conversation after a restart.

## Install

No Node.js needed; Codex uses its own installer.

1. Open **Settings → Agents → Manage CLIs**.
2. On the Codex row click **Install Codex** (or **Run in terminal**). The
   command Tabtivity runs:
   - Linux / macOS: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`
   - Windows (PowerShell): `irm https://chatgpt.com/codex/install.ps1 | iex`
3. If the row still says not installed, click **Re-check** (Tabtivity also looks
   in `~/.local/bin/codex`).

## Sign in

1. Open a project, click `+` on its tab bar → **Agents & CLIs** → **Codex**.
2. Choose **Sign in with ChatGPT** and approve in the browser, or use an
   OpenAI API key. If no browser opens, copy the printed link into your
   browser.
3. Codex stores the login itself; every Codex tab shares it.

## Enable exact resume (one time)

Tabtivity records which conversation belongs to which Codex tab through a
session hook, `tabtivity_session_start`. Codex runs user-level hooks only after
you approve them once:

1. In a Codex tab type `/hooks`.
2. Under "When a new session starts", find the row whose command is
   `tabtivity_session_start`.
3. Use the review/trust key named in the footer, and make sure the row ends
   up switched on (if it is already trusted but off, press the toggle key).

Until then Tabtivity works out the conversation from Codex's own logs, which can
mix up two Codex tabs open in the same folder. Manage CLIs shows a "Session
hook" notice on the Codex row while the hook is not active, and a hint with an
"Enable in Codex" button appears when a Codex tab is open.

## First use

- The tab starts in the project folder; Codex reads the project's `AGENTS.md`.
- Sandbox and approval policy are Codex's own settings. Tabtivity passes no mode
  flag.

## Troubleshooting

- **Codex asks to run a command outside its sandbox** (Linux, sandboxed tab):
  Codex's own bubblewrap sandbox cannot start inside Tabtivity's sandbox on
  systems whose AppArmor blocks nested user namespaces. Codex then asks per
  command or per session; approving runs the command outside Codex's
  sandbox but still inside Tabtivity's sandbox.
- **Codex tab reopens the wrong conversation**: enable the session hook
  (above).
- **Not in the `+` menu**: install it, **Re-check**, and for the root console
  turn on its **Root** chip in the Models & agents menu.
