---
id: gemini-cli
title: Gemini CLI in Tabtivity
keywords: [gemini, google, gemini cli, npm, node, install, login, sign in, antigravity, agy]
---

Gemini CLI is Google's coding agent CLI (command `gemini`). It installs from
npm, so it needs Node.js first.

## Install

1. Open **Settings → Agents → Manage CLIs**.
2. If the panel shows the Node.js helper (npm missing, or Node older than
   24), click **Run in terminal** there, let it finish, then **Re-check**:
   - Linux / macOS: installs nvm and the current Node LTS for your user.
   - Windows: `winget install OpenJS.NodeJS.LTS`.
3. On the Google Gemini row click **Install Google Gemini** (or **Run in
   terminal**). The command is `npm install -g @google/gemini-cli` on every
   OS.
4. If npm fails with a permission error (EACCES), Node was installed
   system-wide: use **Run with sudo**, or install Node with nvm instead.
5. Click **Re-check** if the row still says not installed; a fresh terminal
   may be needed so npm's global bin folder is on PATH.

## Sign in

1. Open a project, click `+` on its tab bar → **Agents & CLIs** → **Gemini**.
2. Choose **Login with Google** and approve in the browser, or use a Gemini
   API key. If no browser opens, copy the printed link into your browser.

## First use

- The tab starts in the project folder. Gemini reads `GEMINI.md`, which
  imports the project's shared `AGENTS.md`.
- In a box scope, Gemini gets `--include-directories` for every member folder.
- After a restart a Gemini tab continues the project's most recent
  conversation (not necessarily the one that tab had).

## Google Antigravity

Antigravity (command `agy`) is a separate Google agent CLI with its own
installer — no Node.js needed:

- Linux / macOS: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- Windows: `irm https://antigravity.google/cli/install.ps1 | iex`

Install it from the Google Antigravity row in Manage CLIs.

## Troubleshooting

- **`npm: command not found`**: install Node.js with the helper above.
- **`EBADENGINE` warnings or a crash at start**: Node is too old; install the
  current LTS and reinstall.
- **Not in the `+` menu**: **Re-check**, then check the row is not turned off
  in Manage CLIs; in the root console turn on its **Root** chip.
