---
id: local-models
title: Local models with Ollama
keywords: [ollama, local model, model, gpu, vram, pull, download, offline, vibe, mistral, autocomplete, qwen, llama, gemma]
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
   **Mail**.
5. Optional: under **Load on Tabtivity start** in the Ollama panel, tick models to
   load automatically at launch (not in Energy Saver mode unless you allow it).
6. From a paired phone, Home → **Local models** loads and unloads installed
   models too (help topic `mobile`, "Local models from the phone").

## 5. Open a Local Model tab

1. Install **Mistral Vibe**, the default local-model runner: the Ollama panel
   offers **Install Vibe** (no administrator rights needed; Linux/macOS
   `curl -LsSf https://mistral.ai/vibe/install.sh | bash`).
2. Click `+` on a tab bar. The **Local Model · <model>** group lists the
   agents that can drive your Tabs/default model: **Mistral**, plus any
   installed Claude Code, Codex, OpenCode, Droid or OpenClaw (through
   `ollama launch`) when the model supports tool calling.
3. If the model is not on the GPU yet, the group offers **Load onto GPU to
   start an agent** first.
4. Pick an entry; the tab runs fully on your machine.

## 6. Autocomplete in the editor

1. Reveal the file panel, open its **Project settings**, and in the **Native
   Viewers** table tick **Autocomplete** for the file types you want. It is
   off by default and local-only.
2. In the editor, pause typing or press **Ctrl+Space**. **Tab** accepts,
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
