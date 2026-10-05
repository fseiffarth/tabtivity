---
id: troubleshooting
title: Troubleshooting and FAQ
keywords: [problem, error, fix, faq, not working, missing, crash, slow, freeze, not found, path, permission, eacces, bubblewrap]
---

## An agent is missing from the + menu

1. Is it installed? Settings → Agents → Manage CLIs; click **Re-check** on its
   row. A CLI installed from an outside terminal may need a fresh terminal (or
   Tabtivity's re-check) before it is on PATH; Tabtivity also checks common user
   folders such as `~/.local/bin`.
2. Is it hidden? Only a few agents show before you search; use **More agents
   & CLIs…** or type its name in the menu's search box.
3. In the root console, agents are opt-in: turn on the agent's **Root** chip
   in the Models & agents menu.
4. Did you turn it off in Manage CLIs? Turned-off agents stay installed but
   leave the menus.

## An install fails

- **npm: command not found / Node too old**: use the Node.js helper at the
  top of Manage CLIs, then Re-check. See `agent-clis`.
- **EACCES / permission denied with npm**: Node was installed system-wide.
  Use **Run with sudo**, or install Node with nvm (per user).
- **Ollama install stops at sudo**: use **Run in terminal** and enter your
  password there. See `local-models`.
- **Windows: no installer shown**: the agent has no one-line Windows
  installer; follow the linked vendor docs.

## An agent tab closes or refuses to start (Linux)

- **Mentions bubblewrap / bwrap**: the agent sandbox needs bubblewrap. Run the
  offered `sudo apt install bubblewrap` tab; the next agent tab starts without
  restarting Tabtivity.
- **`execvp …: No such file or directory`**: reinstall the CLI from Manage
  CLIs.
- **Claude asks whether you trust the folder**: answer it; Tabtivity does not.
- **"Login expired · Please run /login"**: run `/login` in that tab or reopen
  it.

## An agent tab came back as a fresh conversation

Only some CLIs can resume (see `agent-clis`). For Codex, enable Tabtivity's
session hook once in Codex's `/hooks` list (see `codex`).

## Local model problems

- **"unable to spawn vibe"**: install Vibe from Settings → Agents → Ollama
  Models.
- **Local Model group offers only Mistral**: the model has no tool calling;
  pick a tool-capable one such as `qwen2.5-coder`.
- **Model runs on the CPU**: use **Load onto GPU**; if it still lands on the
  CPU it does not fit into VRAM.
- **Autocomplete does nothing**: tick Autocomplete for that file type in the
  file panel's Project settings → Native Viewers, and make sure a model is
  loaded.

## Remote project problems

- **A saved file is not on the host**: it is git-tracked and Git sync is on —
  commit it. See `sync`.
- **The file tree is stale or grey**: the project is disconnected; click the
  pill's connection lamp. Tabtivity pauses remote probes while disconnected so
  the window never hangs.
- **Auto-connect does nothing**: auto-connect never prompts. It only runs when
  the connection can succeed silently (SSH key/agent, or a saved password).
- **VPN won't come up**: `openvpn` and polkit must be installed; the tunnel is
  controlled from the header's OpenVPN button.

## The panels disappeared

Press **Super** (Linux, when the desktop leaves it to the window) or **F9** to
toggle them; on macOS push the cursor to a screen edge. **Esc** leaves a
pane's fullscreen.

## Tabtivity feels slow

- **Settings → System → Power & performance → Fast mode** turns off costly display
  aids (folder sizes, git dots on pills, hover cards, the CPU/RAM/GPU readout,
  animations) without losing any data.
- **Energy saver** (same page) widens background timers on battery.
- Hidden panes pause their work and catch up when shown.

## Where Tabtivity keeps things

- Projects: `~/tabtivity/projects/<name>/` by default; remote mirrors under
  `~/tabtivity/projects-ssh/`; boxes under `~/tabtivity/boxes/`.
- The root console's folder: `~/tabtivity/root/`.
- Settings, the project index and tab layouts: Tabtivity's state directory
  (`~/.local/share/tabtivity/` on Linux, `%APPDATA%\tabtivity\` on
  Windows, `~/Library/Application Support/tabtivity/` on macOS).
- Passwords are never stored unless you opt in; then they go to the OS
  keychain.

### After the rename from Eldrun

Tabtivity was called Eldrun until release A. An install made under the old
name is carried over on the first start of a Tabtivity build:

- The state directory moves to its `tabtivity` name; a link stays at the old
  path, so nothing that still points there breaks.
- Your projects stay where they are: an existing `~/eldrun/` tree keeps being
  used as it is (only a fresh install gets `~/tabtivity/`). Read every
  `~/tabtivity/…` path on these pages as `~/eldrun/…` then.
- A project keeps an `eldrun-screenshots/` or `eldrun-emails/` folder it
  already has; its `.eldrun/` folder becomes `.tabtivity/` when the project is
  next opened.
- `eldrun-send` keeps working as an alias of `tabtivity-send` for one release.
- Agents may ask once more for permission to use Tabtivity's tools (their
  names changed), and Codex asks once more to trust the session hook.
- **Settings → Updates → Names from before the rename** lists what was still
  found under the old name.

## Still stuck

Ask your agent — it can search this help (see `ask-tabtivity`) — or open the
Lessons from the Settings menu for a narrated walkthrough of the task.
