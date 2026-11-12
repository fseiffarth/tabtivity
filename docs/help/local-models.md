---
id: local-models
title: Local models with Ollama
keywords: [ollama, local model, model, gpu, vram, pull, download, offline, vibe, mistral, autocomplete, qwen, llama, gemma]
related: [agent-clis, files-and-viewers, root-console, mail-calendar]
---

Tabtivity runs open-weight models on your own machine through Ollama. Nothing
leaves the machine. Local models power Local Model agent tabs, editor
autocomplete and the mail assistant.

## 1. Install Ollama

1. Click the **Models & agents** button in the header (chip icon) and pick
   the **Ollama** tile (hovering it and picking **Install Ollama…** lands on
   the same section) — or open **Settings → Agents → Ollama Models**.
2. Click **Run in terminal** to run the installer in a visible terminal tab:
   - Linux / macOS: `curl -fsSL https://ollama.com/install.sh | sh`
   - Windows: `winget install --id Ollama.Ollama -e --silent --accept-source-agreements --accept-package-agreements`
   - Or download it from `https://ollama.com/download`.
3. Linux/macOS: enter your password when the script asks for sudo (it
   registers a system service). Windows: approve the UAC prompt if asked.
4. Back in the panel click **Re-check**. Tabtivity then starts the server.

The panel's automatic **Install** button runs the same command without a
terminal; on Linux it only succeeds without prompting if your account has
passwordless sudo, so prefer **Run in terminal**.

## 2. Check the server

- The Ollama panel's header says **Server running** or **Server not
  running** with a **Start** button. Tabtivity prefers the system service
  (`systemctl start ollama`) and falls back to `ollama serve`; a server Tabtivity
  started itself is stopped again when Tabtivity quits.
- The Models & agents menu shows "Ollama running" / "Ollama stopped".
- From a terminal: `ollama --version` and `ollama list`. The default address is
  `127.0.0.1:11434`.

## 3. Download (pull) a model

1. In **Settings → Agents → Ollama Models**, go to **Browse the Ollama
   registry**.
2. Type an exact name into the pull field (for example `qwen2.5-coder:7b`) and
   click **Pull**, or search, sort and filter the catalog and click **pull**
   on a size.
3. A progress bar tracks the download; you can pause and resume it, and an
   interrupted download can be continued.
4. **Model download location** changes where models are stored (useful when
   the home disk is small). For a systemd-managed server, **Apply to the
   service…** runs the one-time service change in a terminal tab.

### Models from Hugging Face

Ollama also pulls GGUF models straight from Hugging Face. In **Browse the
Ollama registry**, switch **Source** to **Hugging Face**: the list shows GGUF
repos, and each card's picker lists the repo's quantizations (`Q4_K_M` first
when there is one). **Pull** downloads `hf.co/<user>/<repo>:<quant>`. You can
also type such a name into the pull field, for example
`hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M`.

- Only GGUF files work; a repo with only safetensors is not listed. A
  quantization split into several files (`-00001-of-00003`) is not offered:
  Hugging Face does not serve it to Ollama.
- A **gated** repo needs its terms accepted on Hugging Face and Ollama's public
  key added to your account (Settings → SSH keys): `~/.ollama/id_ed25519.pub`,
  or `/usr/share/ollama/.ollama/id_ed25519.pub` for the system service.
- Once downloaded, a Hugging Face model works like any other: load it, open a
  Local Model tab with it, check it for updates.

Delete a model from **Downloaded Models** with **Delete**; **Update**
re-pulls it.

## Which model to start with

Pick by the memory the model must fit into: GPU memory (VRAM) if you have a
dedicated GPU, otherwise system RAM. Sizes are approximate download sizes.

| Your machine | Suggested model | Size |
|---|---|---|
| Under 8 GB RAM, no GPU | `qwen2.5-coder:1.5b` or `llama3.2:1b` | about 1 GB |
| 8–16 GB RAM, no GPU | `qwen2.5-coder:3b` or `llama3.2:3b` | about 2 GB |
| 16 GB+ RAM, or a GPU with 8 GB | `qwen2.5-coder:7b` | about 4.7 GB |
| GPU with 16 GB or more | `qwen2.5-coder:14b` or `gemma3:12b` | about 8–9 GB |

For autocomplete, a small model (1.5b–3b) answers fastest even on a big
machine. For agent tabs other than Mistral, the model must support tool
calling; the Models & agents menu tags models without it "no tools".

## 4. Load a model onto the GPU

1. Open the **Models & agents** menu. Models are grouped as "Running models"
   and "Models on disk".
2. On a model, click **GPU** (every layer offloaded) or **CPU**. The model
   stays loaded until you unload it.
3. Click a loaded model's name to make it the **default** local model.
4. Optional role chips assign a loaded model to a task: **Autocomplete**,
   **Prose autocomplete**, **Tabs** (the model Local Model tabs use) and
   **Mail**. An Ollama cloud model (a `-cloud` tag) runs on ollama.com, so
   its **Mail** chip is greyed out, and a single loaded cloud model is never
   given the roles on its own.
5. **Clear** on a model deletes its stored Mistral Vibe conversations, after
   you confirm, so no tab can continue one. Once any tab of a model has read
   mail, every tab of that model has its calendar and board changes held for
   your approval; clearing its conversations ends that for new tabs. Close
   the model's tabs first: the menu names any that are still open. Settings
   and logins are kept.
6. Optional: under **Load on Tabtivity start** in the Ollama panel, tick models to
   load automatically at launch (not in Energy Saver mode unless you allow it).
7. From a paired phone, Home → **Local models** loads and unloads installed
   models too (help topic `mobile`, "Local models from the phone").

## 5. Open a Local Model tab

1. Install a runner. **OpenCode** is the first choice when installed; the
   Ollama panel also offers **Install Vibe** for **Mistral Vibe** (no
   administrator rights needed; Linux/macOS
   `curl -LsSf https://mistral.ai/vibe/install.sh | bash`).
2. Click `+` on a tab bar. The **Local Model · <model>** group lists the
   agents that can drive your Tabs/default model: **OpenCode** and **Pi**
   first, then **Mistral**, then any installed Claude Code, Codex, Droid,
   OpenClaw or Cline (through `ollama launch`) — every one but Mistral only when the model
   supports tool calling. A ⚠ marks the agents built around hosted frontier
   models, which a local model may answer badly.
3. If the model is not on the GPU yet, the group offers **Load onto GPU to
   start an agent** first.
4. Pick an entry; the tab runs fully on your machine.

## 6. Autocomplete in the editor

1. Reveal the file panel, open its **Project settings**, and in the **Native
   Viewers** table tick **Autocomplete** for the file types you want. It is
   off by default and local-only.
   The editor toolbar's **Autocomplete** button turns it on for that one tab;
   beside it pick **Local** or **Copilot** (with the experimental Copilot
   feature on) and **Auto** or **On request**. Copilot defaults to On request,
   so it spends no completions until you ask; Auto asks only after a pause
   with the caret at the end of a line. A short note says why nothing comes
   (no local model loaded, Copilot not allowed for this project).
2. In the editor, pause typing (Auto) or press **Ctrl+Space**. **Tab** accepts,
   **Alt+→** takes one word, **Shift+Tab** cycles the length (sentence → block
   → scope), **Esc** dismisses.

## Troubleshooting

- **"unable to spawn vibe"** in a Local Model tab: install Vibe (step 5).
- **The Local Model group has only Mistral**: the model has no tool calling,
  or no other agent CLI is installed. Pick a tool-capable model (for example
  `qwen2.5-coder`).
- **"Running on CPU — load onto GPU"**: click it; if the model still lands on
  the CPU, it may not fit into VRAM — choose a smaller size.
- **Integrated GPU ignored**: some Ollama versions need `OLLAMA_IGPU_ENABLE=1`
  in the server's environment; the Models & agents menu offers the fix.
- **Server won't start**: run `ollama serve` in a terminal to see its error.
- **Ollama on another machine**: `ollama_host` in `settings.json` points
  Tabtivity at another address; a non-local host also needs
  `ollama_allow_remote_host`. There is no UI for this yet.

## Local models only projects

A project can be set to **Local models only** (the project pill's menu →
**Local models only…**; a lock then shows on the pill). Then no cloud model
reads it: only agent tabs on an installed local Ollama model start in it, the
**+** menu offers only the local-model rows, other projects' and boxes'
agents see an empty folder where it is, and a file of the project cannot be
dropped onto an agent that is not on a local model. Turning it on closes the
project's running cloud agent tabs.

OpenCode cannot be kept on the local model while the project keeps its network
(it re-reads a config file the agent writes while it runs, so the agent could add
a cloud provider): its local row is not offered there and an OpenCode tab is
refused with a message naming the local agents that can run. It starts again when
**Cut network** is on (below). With the network on, the other local agents run
(Pi, Claude Code on Linux, Codex, Droid, OpenClaw, Cline, Mistral).

It does not stop what a local agent does with its own network (a fetch tool, a
`curl`, a `git push`, switching to an Ollama cloud model mid-session), and
shell tabs, the root console's Host session and Windows have no sandbox that
hides the folder.

**Cut network** (Linux; the switch under Local models only in the same dialog)
takes the network away from the project's local tabs. Their sandbox has no
network at all; the only way out is a relay inside Tabtivity to the local Ollama.
It carries chat, generate, embeddings, the model list and show; it refuses
installing, copying, creating, pushing or deleting a model, and it checks that
every request names a model that runs on this machine, so a `/model` switch to
an Ollama cloud model fails. The model lists the agent sees show local models
only. The cockpit, help and markup tools and sending a file to your phone keep
working; the web tool, git push and release, the schedule and the mail tools do
not. Only **OpenCode, Claude Code and Codex** have been run with the network
cut: Pi, Droid, Cline, OpenClaw and Mistral are refused in such a project,
naming themselves. The sandbox is built when a tab starts, so changing the
switch asks whether to restart the project's running local tabs and never does
it by itself. On macOS and Windows the switch cannot be turned on.

It is refused for remote, VM and container projects, a folder with another
project or a box folder inside it, and an Ollama that is not on this machine.
