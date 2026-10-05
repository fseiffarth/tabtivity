---
id: claude-code
title: Claude Code in Tabtivity
keywords: [claude, claude code, anthropic, install, login, sign in, resume, update, trust, mcp]
---

Claude Code is Anthropic's coding agent CLI (command `claude`). Tabtivity runs it
in agent tabs, resumes its exact conversation after a restart, and hands it
Tabtivity's help and root tools over MCP.

## Install

No Node.js needed; Claude uses its own native installer.

1. Open **Settings → Agents → Manage CLIs**.
2. On the Claude row click **Install Claude** (or **Run in terminal** to watch
   it in a terminal tab). The command Tabtivity runs:
   - Linux / macOS: `curl -fsSL https://claude.ai/install.sh | bash`
   - Windows (PowerShell): `irm https://claude.ai/install.ps1 | iex`
3. The binary lands in `~/.local/bin/claude`. Tabtivity checks that folder even
   when it is not on PATH. If the row still says not installed, click
   **Re-check**.

## Sign in

1. Open a project, click `+` on its tab bar → **Agents & CLIs** → **Claude**.
2. On first start Claude Code asks how to log in: your Claude subscription or
   an Anthropic Console (API) account. Approve in the browser that opens; if
   none opens, copy the printed link into your browser.
3. The login is stored by Claude itself and used by every Claude tab.
   To switch accounts later type `/login` in a Claude tab.

## First use

- The tab starts in the project folder. Claude reads the project's
  `CLAUDE.md`, which imports the shared `AGENTS.md` that Tabtivity scaffolds.
- The first time Claude opens in a folder it asks whether you trust it.
  Answer it yourself; Tabtivity never answers that question for you.
- Permission modes (plan, accept edits, …) are Claude's own: switch them with
  Shift+Tab inside the tab. Tabtivity re-applies the mode Claude last recorded
  when it resumes the conversation.
- In a box scope, Claude gets `--add-dir` for every member folder.

## Resume

Claude tabs come back on their exact prior conversation after a Tabtivity
restart. Tabtivity records each tab's session through Claude's session hooks — the
one place Tabtivity writes into another app's configuration.

## Updating

Run `claude update` in any terminal, or let Claude's background auto-update
run; both work from a sandboxed tab too. Manage CLIs shows a notice when the
installed version differs from the one Tabtivity was verified against. Nothing is
blocked; it is the first thing to check if a tab misreads a prompt.

## Troubleshooting

- **Not in the `+` menu**: install it, then **Re-check** in Manage CLIs. Check
  the Claude row is not turned off there, and in the root console turn on its
  **Root** chip in the Models & agents menu.
- **Tab exits right away with `execvp claude` or "command not found"** (Linux):
  reinstall with the native installer; Tabtivity follows the
  `~/.local/bin/claude` link into `~/.local/share/claude/` automatically.
- **Agent tab refuses to start and mentions bubblewrap** (Linux): install it
  with the offered `sudo apt install bubblewrap` terminal tab; the next tab
  starts without restarting Tabtivity.
- **"Login expired · Please run /login"**: run `/login` in that tab, or close
  and reopen it; new tabs read the current credentials.
- **Claude's own sandbox is unavailable inside Tabtivity's sandbox**: on some Linux
  systems a nested bubblewrap is blocked by AppArmor, so Claude's internal
  sandbox falls back to running unsandboxed inside Tabtivity's outer sandbox.
