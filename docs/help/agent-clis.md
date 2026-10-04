---
id: agent-clis
title: AI agent CLIs — install, sign in, open
keywords: [agent, cli, install, claude, codex, gemini, npm, node, manage clis, sign in, login, api key, resume, custom agent, skills]
---

Tabtivity runs AI coding agents as terminal tabs. It does not bundle them: each
agent is its vendor's own command-line tool (CLI), installed once per machine.
Tabtivity detects installed CLIs, offers them in every `+` menu, and resumes
their conversations after a restart where the CLI allows it.

## Install an agent CLI

1. Click the **Models & agents** button in the header (chip icon) and pick
   the **Agents & CLIs** tile — or hover it and pick **Manage CLIs…**. The
   same list is also in **Settings → Agents → Manage CLIs**.
2. Find the agent. Installed ones are listed first; use the search box for
   the rest.
3. Click **Install <name>**. Tabtivity runs the vendor's official installer and
   streams its output right there. Alternatively click **Run in terminal** to
   run the same command in a visible terminal tab (in the root console), where
   you can answer prompts such as a sudo password.
4. When it finishes, the agent shows as installed. If not, click
   **Re-check**; a fresh terminal may be needed so the install folder is on
   PATH.
5. Open a project, click `+` on its tab bar and pick the agent.

For npm-based agents, a **Run with sudo** button is offered too. Use it only
when Node.js was installed system-wide (not with nvm) and npm fails with a
permission error (EACCES).

On a remote project, the same panel can install an agent onto a chosen remote
machine instead of this one.

## Prerequisite: Node.js for npm-based agents

Claude, Codex, Antigravity, Mistral, Kiro, Cursor, OpenCode (Linux/macOS),
Droid and several others install with their own script and need no Node.js.
Gemini, Copilot, Qwen, Cline, Auggie, Continue, CodeBuddy, Crush, Amp and
Pi install with `npm install -g` and need Node.js 24 or newer.

When npm is missing or Node is too old, Manage CLIs shows a Node.js helper:

- Linux/macOS: installs nvm and the current Node LTS for your user (no
  administrator rights): `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`, then `nvm install --lts`.
- Windows: `winget install OpenJS.NodeJS.LTS`.

Click **Run in terminal**, wait for it to finish, then **Re-check**.

## The main agents

| Agent | Command | Linux / macOS install | Windows install |
|---|---|---|---|
| Claude (Claude Code) | `claude` | `curl -fsSL https://claude.ai/install.sh \| bash` | `irm https://claude.ai/install.ps1 \| iex` (PowerShell) |
| Codex | `codex` | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `irm https://chatgpt.com/codex/install.ps1 \| iex` |
| Google Gemini | `gemini` | `npm install -g @google/gemini-cli` | same |
| Google Antigravity | `agy` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `irm https://antigravity.google/cli/install.ps1 \| iex` |
| Mistral (Vibe) | `vibe` | `curl -LsSf https://mistral.ai/vibe/install.sh \| bash` | Install Vibe in the Ollama Models panel (installs uv, then `uv tool install mistral-vibe`) |
| OpenCode | `opencode` | `curl -fsSL https://opencode.ai/install \| bash` | `npm install -g opencode-ai` |
| Copilot | `copilot` | `npm install -g @github/copilot` | same |
| Aider | `aider` | `curl -LsSf https://aider.chat/install.sh \| sh` | `irm https://aider.chat/install.ps1 \| iex` |

Manage CLIs lists about thirty more (Kiro, Cline, Cursor, Droid, Grok, Qwen,
OpenClaw, Auggie, Kilo Code, Continue, Junie, CodeBuddy, Goose, Pi, Plandex,
SWE-agent, mini-SWE-agent, Crush, Amp, Kimi Code, Qoder, Meta Muse Code), each
with its official installer. Where no one-line Windows installer exists the
panel links the vendor's install docs. Detailed guides: `claude-code`,
`codex`, `gemini-cli`.

## Sign in

Open the agent's tab; on first start the CLI asks you to sign in (usually a
browser approval). If no browser opens, copy the sign-in link the CLI prints
into your browser. You sign in **once per CLI**: agents run in Tabtivity's own
per-project homes, and Tabtivity shares each CLI's login file across all of
them, so every other project's tab of that CLI is signed in too. If this
computer already holds a login for the CLI, Settings → Agent sandbox → **Agent
logins** → *Import from this computer* copies just that file into Tabtivity
(never config, skills or MCP entries). The first start of this version does
that for you, once, for every CLI Tabtivity has no login for yet. **Sign out** there forgets it
everywhere. A CLI that keeps its login in the system keyring or a database
(Kiro, Kilo, OpenClaw, Copilot) signs in once per project instead — Copilot's
case is described under the sandbox below.

**API keys instead of a subscription.** If you pay per token, Settings → Agent
sandbox → **API keys** keeps one key per provider (Anthropic, OpenAI, Google
Gemini, Mistral) in your system keyring, and a switch per CLI (Claude, Gemini,
Mistral, OpenCode) hands it to that CLI's new local tabs. Nothing is switched on
by default — Claude prefers a key over your subscription once you approve it.
Claude asks once per project whether to use the key and its default answer is
**No**: pick Yes (change it later in `/config` → Use custom API key). Gemini
uses the key only after you pick "Use Gemini API key" in its `/auth`, once per
project. Claude tabs on a key run without Remote Control. Remote, container and
local-model tabs never get a key, and a key you exported yourself wins. Changes
reach new tabs only. An agent can read its own key, and a project's own CLI
config can send it to another server, so use a spend-limited key. If a tab
reports an invalid key, fix or remove it there — signing in again does not help
while the key is in use. Codex is not offered: use `codex login --with-api-key`
in a Codex tab instead (its login file is shared like any other).

## Open an agent tab

- In a project: `+` on the tab bar → **Agents & CLIs** → the agent. The tab
  starts in the project folder.
- The compact list shows Claude, Codex and Gemini by default; change it with
  the "+ tab" chips in the Models & agents menu. **More agents & CLIs…** lists
  every installed agent.
- The **Default** chip picks the agent Tabtivity uses when it must choose one
  itself (e.g. filling scaffold files).
- Root console: agents are off there until you turn on their **Root** chip.

## Talk to an agent as a chat

Claude, Codex and OpenCode tabs can be used as a chat instead of the
terminal — the same chat view the phone's Focus uses. Click **Chat** at the
right end of the prompt row above the terminal:
your prompts show on the right, the agent's answers on the left as
formatted text, and slash commands as thin rules. Type into the box at the
bottom and press Enter to send (Shift+Enter for a new line); a prompt sent
while the agent works waits in its queue as a typed one would. When the
agent asks something — a permission prompt ("Do you want to make this
edit?") or a question with choices — the choices show as buttons under the
chat; click one to answer. While the agent works, a **working** row shows
how long it has been busy, and its **Stop** button interrupts it. Press Esc in
that box, or click **Terminal**, to go back. The terminal keeps running
underneath, so nothing is lost by switching. The chat is optional: tabs
open on their terminal until you pick Chat. The choice is kept per agent
and remembered: picking Chat (or Terminal) in a Claude tab switches every
open Claude tab, and new Claude tabs open the same way, while Codex and
OpenCode tabs keep their own choice. Agents without a chat view keep their
terminal.

## Resume after a restart

Claude, Codex and Mistral tabs reopen their exact conversation. Gemini, Qwen,
Grok, Cursor, Copilot, OpenCode and Antigravity continue the project's most
recent conversation. Others start fresh.

## Permission modes

Plan mode, auto-accept, sandbox or approval policies are set inside each
agent's own CLI. Tabtivity adds no mode flag and has no mode toggle.

## The agent sandbox and agent homes

Every local agent tab runs inside a filesystem sandbox (bubblewrap on Linux,
Seatbelt on macOS): the project is writable, your own home folder (SSH keys,
other credentials, other projects) is hidden, and the agent's `$HOME` is a
home Tabtivity keeps for that project, box or the root console under its state
directory. Each of those homes holds the agent's own config, transcripts and
session stores. Deleting a project deletes its agent home.

What you want in every project — your `CLAUDE.md`, `AGENTS.md` or
`GEMINI.md`, skills, slash commands, hook scripts (an RTK hook, a status
line), MCP servers — goes in the **global agent config**: Settings → Agent
sandbox → Global agent config. *Import from this computer* copies it from your
own `~/.claude`, `~/.codex` and `~/.gemini` (never logins, history or folder
trust) — done once for you at the first start, if the global config is still
empty; *Open folder* lets you edit it. Every agent tab gets a fresh copy
when it starts, merged into the settings files the CLI writes itself, so a
model you picked in one project stays picked there. Agents cannot change
the global config; what an agent changes in its own project's home stays in
that project and is reset where it overlaps the global config. There is no off switch; if `bwrap` is missing the agent does
not start, and Tabtivity offers `sudo apt install bubblewrap` in a terminal tab.

Typing a CLI's name (`claude`, `cursor-agent`, …) into a shell tab runs it in
the same sandbox as an agent tab of that project. Running the binary by its
absolute path is your own shell, your real home, and none of Tabtivity's logins.

For work that is not a project's — repairing the browser, the printer, this
machine — the root console's `+` menu has a **Host session** group: the agent
runs outside the sandbox, with your full rights (`sudo` works), in Tabtivity's own `host`
home, sharing the logins. Its tab carries a red HOST badge, it is never
started from the phone, and after a restart it comes back paused until you
press *Resume without sandbox*.

Windows has no agent sandbox: an agent there runs with your full rights — other
projects, saved passwords, SSH keys, your browser profile. Tabtivity says so
before the first agent tab starts and asks you to accept that once; declining
starts nothing. For a real boundary on Windows, open the project in a
container.

The sandbox hides the system keyring, so Copilot can't store its login there.
Tabtivity does it instead: run `/login` once in any sandboxed Copilot tab, and
every sandboxed Copilot tab started after that is signed in. Tabtivity keeps the
sign-in in its own keyring entry, never as plain text. Settings → Agent
sandbox shows the account and has **Sign out**, which you need before
switching to a different account. The same rule holds for every shared
login: a tab that signs in as a different account than the one Tabtivity holds
is not adopted until you sign out first.

## Custom agents and skills

- `+` → **Add agent…** registers any command as a custom agent.
- **Skills library…** (the Models & agents window's **Skills** tile, or the
  `+` menu) installs reusable
  Agent Skills into one project (`.claude/skills/`) or for every project on
  this machine (`~/.claude/skills/`).
