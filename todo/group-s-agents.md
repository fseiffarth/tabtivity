## Group S — Local Agents via Ollama Integrations (`ollama launch`)

- [ ] Live-check Codex resume after a deliberate backend restart (2026-09-15):
  tabs started together in one folder must retain distinct conversations.
  Old duplicate assignments now open Codex's session picker in the conflicting
  tab; choose its intended conversation. Verify close/reopen and trusted-hook
  tracking too. Automated regression covers duplicate binding within one poll
  and reservation of saved resume targets; no live Tabtivity restart performed.

*New feature. Generalizes the existing single "Local Model" tab (Mistral `vibe`)
into a family of local, Ollama-backed agent tabs — Claude Code, Hermes, OpenClaw,
OpenCode — that behave exactly like the vibe local-agent tab does today (per
active local model, `kind: "local_agent"`, same persistence/rehydrate path).*

**Status (reconciled 2026-07-28): #72, #73 and #75 are shipped** — the group was
built backend-first as `LOCAL_DRIVERS` in `commands/ollama.rs` and every box had
been left unticked. Genuinely open: **#78** (nothing surfaces this anywhere, so
the feature is invisible), **#77** (a real `RESUMABLE_AGENTS` collision, see
below), and the #74/#76 remainders.

*Files (as built): `src/components/tabs/TabBar.tsx`, `src/components/tabs/NewTabMenu.tsx`,
`src-tauri/src/commands/ollama.rs` (`LOCAL_DRIVERS`), `src/stores/tabs.ts` (`cmdToKind`,
`RESUMABLE_AGENTS`, `isRestorableTab`), `src/components/layout/CenterPanel.tsx`
(local_agent rehydrate), `src/components/layout/SettingsSubPanels.tsx` (Ollama
panel), backend `commands/ollama.rs`, `terminal/mod.rs`, `lib.rs`.*

**Key enabler — already on disk.** The installed `ollama` (≥0.30.x) ships
`ollama launch <integration> [--model <model>] [--config] [-- <extra>]`, which
**installs the agent if missing, configures it against the local Ollama endpoint,
then launches it**. `ollama launch --help` lists (among others): `claude`
(Claude Code), `hermes`, `openclaw`, `opencode`, plus `codex`, `copilot`, `cline`,
`qwen`, `droid`, `kimi`, `pi`. This removes the bespoke per-agent config the vibe
path needs (`prepare_local_agent` writing `VIBE_HOME/config.toml`): for these
agents Tabtivity just spawns `ollama launch <id> --model <model>` in a PTY. `vibe`
is **not** an `ollama launch` integration, so it keeps its current dedicated path
unchanged; the new agents are additive.

**Prerequisites & caveats (document in the Ollama panel + per item):**
- Every one of these needs Ollama to actually **load** a model. The dev machine's
  Ollama install is currently broken (missing `llama-server` runner) — none will
  work until that's reinstalled. Gate the UI on `ollama_status` ("loaded"/"idle")
  and surface the broken-runner message (`friendly_ollama_error`).
- These are **agentic** (file edit / bash / tool calls); they need a tool-calling
  model and a **≥64k context window**. `ollama launch` configures `num_ctx` for
  the chosen model; recommend `qwen2.5-coder`/`qwen3*` in the picker, warn on tiny
  models.
- Endpoint differences are handled by `ollama launch`, but note them: Claude Code
  uses Ollama's **Anthropic Messages API** compat (`ANTHROPIC_BASE_URL=
  http://localhost:11434`, `ANTHROPIC_AUTH_TOKEN=ollama`) — this **supersedes** the
  earlier "needs a LiteLLM proxy" note; Hermes/OpenCode use `/v1`; OpenClaw uses
  the **native** `/api/chat` (its `/v1` tool-calling is unreliable). OpenClaw is a
  messaging-gateway agent more than a pure coding agent — include it as requested
  but rank it lowest.

72. **Generalize `local_agent` into a multi-agent registry.** ✅ Implemented ·
    🧪 Awaiting live QA. Introduce a single
    source of truth, e.g. `LOCAL_AGENTS: { id, label, launch, endpointNote,
    resumable }[]` in `src/stores/tabs.ts` (exported), with rows for `claude`,
    `hermes`, `openclaw`, `opencode` (launch via `ollama launch <id>`), and the
    existing `vibe` flagged `special: true` so it keeps its `prepare_local_agent`
    path. Spawn shape for the new ones: `addTab({ cmd: "ollama",
    args: ["launch", id, "--model", model], kind: "local_agent",
    label: <model> })`. Keep `kind: "local_agent"` so all the existing tiling,
    activity-spinner, and persistence wiring applies untouched.
    - **Shipped as `LOCAL_DRIVERS` in the *backend*** (`commands/ollama.rs:2211`),
      not `LOCAL_AGENTS` in `tabs.ts` — the frontend reads it over IPC (#73).
      Roster drifted from the plan: `hermes` was **dropped**, `codex` and `droid`
      **added**; rows are claude, codex, opencode, droid, openclaw. `vibe` kept
      its separate path as specified.
    - [x] 🤖 Automated test — `commands/ollama.rs:2469-2490` covers the registry
      rows and argv construction.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

73. **Backend: `local_launch_argv` + ensure-running command.** ✅ Implemented ·
    🧪 Awaiting live QA. Add a pure helper
    in `commands/ollama.rs`, `local_launch_argv(integration, model) ->
    Result<Vec<String>, String>`, that (a) checks `integration` against an
    allowlist of supported `ollama launch` ids, (b) runs the existing
    `validate_model_name(model)` (reuse — guards the argv), and (c) returns
    `["launch", <id>, "--model", <model>]`. Expose a thin command
    `prepare_local_launch_agent` that calls `ensure_ollama_running` then returns
    the argv (mirrors `handleOllamaModel`'s `ensure_ollama_running` step).
    Register in `lib.rs`.
    - **Shipped under different names:** `prepare_local_launch`
      (`commands/ollama.rs:2324`) and `list_local_drivers` (`:2295`), plus
      `fallback_spec` (`:2273`) for drivers `ollama launch` doesn't cover.
      Registered at `lib.rs:1103-1104`. `validate_model_name` is reused as
      planned (`:2325`). **Deviation:** `ensure_ollama_running` is *not* folded
      into the command — the frontend calls it first (`TabBar.tsx:617`).
    - [x] 🤖 Automated test — `commands/ollama.rs:2469-2490` covers allowlist
      acceptance and rejection of unknown ids / injection-y model names.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

74. **`cmdToKind` + spawn path for `ollama launch` tabs.** Teach
    `cmdToKind` (tabs.ts) that `cmd === "ollama"` with a `launch` first-arg maps to
    `local_agent` (today it only knows `claude|codex|gemini|vibe`). Confirm the PTY
    spawn in `terminal/mod.rs` inherits a PATH that includes `~/.local/bin`
    (agents `ollama launch` installs land there — same concern as vibe); add it to
    the spawn env if missing. No `VIBE_HOME` injection for these (only `vibe`).
    - **PARTIAL.** PATH augmentation is done (`src-tauri/src/paths.rs:87`), and
      the spawn path works because these tabs carry `kind: "local_agent"`
      explicitly at creation (`TabBar.tsx:631`). Still missing: `cmdToKind`
      (`src/stores/tabs.ts:3965-3978`) takes **no args** and has no
      `ollama`→`local_agent` row, so the mapping only fails on *restore* —
      currently moot because these tabs aren't restorable (see #77).
    - [ ] 🤖 Automated test — `cmdToKind("ollama", ["launch","claude",…])` →
      `"local_agent"`; unchanged for plain `ollama`/`bash`.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

75. **Picker UI: choose which local agent runs the active model.** ✅ Implemented ·
    🧪 Awaiting live QA. Today the
    add-tab menu / `LocalModelMenu` launches exactly one runtime (vibe). With ≥5
    options, add a submenu: "Local Agent ▸ [Claude Code · Hermes · OpenClaw ·
    OpenCode · Mistral (vibe)]", each launching the **active** `settings.ollama_model`
    via the matching path. Reuse the existing reveal/close + status-lamp scaffold
    in `LocalModelMenu.tsx`; gray out entries when `ollama_status` isn't
    "loaded"/"idle". Optionally persist a `settings.default_local_agent`.
    - **Shipped in the +/new-tab menus** (`TabBar.tsx:223-228,614-636`,
      `NewTabMenu.tsx:95-103,190-212`), **not** in `LocalModelMenu.tsx`.
      Gating uses the backend's per-driver `available` flag rather than
      `ollama_status`. `settings.default_local_agent` was **not** built — that
      clause stays open.
    - [x] 🤖 Automated test — picker rows follow `list_local_drivers`; selection
      dispatches `prepare_local_launch` (argv) vs the vibe env path.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

76. **Per-agent wiring — Claude Code, Hermes, OpenClaw, OpenCode.** With #72–#75 in
    place each is one `LOCAL_AGENTS` row, but verify per agent: `claude` →
    `ollama launch claude --model <m>` (Anthropic-compat, no `/v1`); `hermes` →
    `ollama launch hermes --model <m>` (`/v1`, raises ctx); `opencode` →
    `ollama launch opencode --model <m>` (`/v1`, writes `~/.config/opencode/
    opencode.json`); `openclaw` → `ollama launch openclaw --model <m>` (native
    `/api/chat`). First launch may run an interactive `ollama launch` setup —
    decide per agent whether to pass `--config`/`--yes` (e.g. `droid --config`
    "does not auto-launch"). Tab label e.g. `Claude Code · <model>`.
    - **OpenClaw wired.** Added as a launch-only `LOCAL_DRIVERS` row in
      `commands/ollama.rs` (`ollama launch openclaw --model <m>`, no fallback —
      `ollama launch` installs+wires the gateway). Also registered as a standalone
      installable agent in `commands/agents.rs` (`npm install -g openclaw`, bin
      `openclaw`) and in `AGENT_ITEMS`/`AGENT_CMDS` so it appears in the regular
      agent add-menu. Resume parity deferred to #77 (dropped on relaunch like vibe).
    - **PARTIAL.** claude / codex / opencode / droid / openclaw are wired
      (`commands/ollama.rs:2212-2256`, `commands/agents.rs:122-128,168-174`).
      **`hermes` is absent everywhere** — decide whether to add it or drop it
      from this item. The `--config`/`--yes` decision is still unrecorded for
      every agent except the OpenClaw bullet below.
    - [ ] 🤖 Automated test — table test: each id → expected argv + endpoint note.
    - [ ] 🖐️ Manual test — each agent opens, sees the model, completes one edit.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

77. **Persistence / resume parity (follow-up).** Start at **vibe parity**: these
    `local_agent` tabs are **not** resumable (dropped on relaunch like vibe today),
    so `isRestorableTab` stays false for them — no change needed beyond confirming
    they aren't accidentally caught by `RESUMABLE_AGENTS`. Track real resume as a
    later step: `ollama launch codex --restore` exists, Claude Code has its own
    `--resume`; map these into `RESUMABLE_AGENTS`/backend `resolve_*_session` only
    after the live-session hook story (Group F #39d) is confirmed per agent.
    - **⚠️ Concrete collision, not hypothetical.** `RESUMABLE_AGENTS`
      (`src/stores/tabs.ts:4043-4057`) contains `opencode`, `codex`, `qwen`…,
      and `isResumableAgentTab` (`:4073`) matches on `kind === "local_agent"`.
      An `ollama launch` tab is safe (its `cmd` is `"ollama"`), but a
      **fallback** driver tab spawns with `cmd: "codex"` / `"opencode"` —
      exactly the ids in that list. This is the "confirm they aren't
      accidentally caught" case, and it currently **fails**. No test asserts the
      persist filter drops them.
    - [ ] 🤖 Automated test — a launched `local_agent` tab for each new id is
      filtered OUT by the persist filter (matches vibe), **including the
      fallback spawn shape**.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

78. **Discoverability in the Ollama panel.** In `SettingsSubPanels.tsx` (Ollama
    panel), add a short "Local agents" section listing the supported `ollama
    launch` integrations with one-line descriptions + the 64k-ctx / tool-calling
    caveat, and a note that they auto-install on first launch (so, unlike vibe,
    no separate "Install …" button is required). Link the picker to it.
    - [ ] 🤖 Automated test — n/a (static copy) or a render smoke test.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

200. **The GPU is not something to be assumed.** ✅ **Done** (2026-07-29).
    Ollama ≥0.32 **drops integrated GPUs by default** ("dropping integrated GPU;
    to enable, set `OLLAMA_IGPU_ENABLE=1`"), so an update silently moved every
    model on an APU machine onto the CPU with nothing in the API to say so but a
    `size_vram` of 0 — which is also exactly what a model too large to fit looks
    like. Three parts, all shipped:
    - `ensure_ollama_running` sets `OLLAMA_IGPU_ENABLE=1` on the server **Tabtivity
      itself** spawns (an explicit value in the environment is left alone — a
      user who set `0` meant it). A systemd-managed server is out of reach from
      app code and needs the drop-in the notice offers.
    - `load_ollama_model` takes a `device` (`auto`/`gpu`/`cpu` → `num_gpu`
      omitted/`999`/`0`); the 🧠 menu's "Load into memory" rows show **GPU** and
      **CPU** buttons whenever the machine has any GPU at all, and the single
      Load button only when it has none. Verified against the live server:
      `num_gpu: 0` → `size_vram: 0`, `num_gpu: 999` → full offload.
    - `ollama_gpu_status` diagnoses the gate and offers the systemd drop-in
      through `runInstallInTab`. It requires **four** facts to line up
      (`model_on_cpu` ∧ `gpu_present` ∧ `integrated_only` ∧ the installed server
      still offering the flag, read from its own `ollama serve --help`) before
      `igpu_dropped` is set, because blaming a setting for an ordinary
      out-of-VRAM would send the user to reconfigure a system service for
      nothing.
    - [ ] 🤖 Automated test — `LoadDevice::num_gpu` mapping, and that the
      diagnosis stays false when only some of the four facts hold.
    - [ ] 🖐️ Manual test — the notice itself has never rendered (the machine it
      was found on was fixed before the UI existed); the CPU/GPU buttons are
      verified at the protocol level only.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

201. **The runtime is not something to be assumed either.** Ollama is not a
    choice Tabtivity made; it is a fact wired into 33 `#[tauri::command]`s across
    `commands/ollama.rs` (4 350 lines), 18 `invoke` sites in `src/`, four
    `settings.json` keys, and a literal `TcpStream::connect("127.0.0.1:11434")`
    in `ollama_http` (`:54`). Surveyed 2026-07-29. **The verdict is not
    "switch"** — it is that the *assumption* is now more expensive than a seam
    would be, and that one alternative fixes a defect this repo has already
    documented.

    **Why Ollama stays the default.** `ollama launch` is the whole premise of
    #72–#78: it installs a coding agent, wires it against a local endpoint and
    runs it, and **nothing else in the field does this**. llama.cpp, LM Studio,
    Lemonade and Jan all *serve* models; none of them stands up an
    Anthropic-compatible endpoint and configures Claude Code, Codex, OpenCode
    and Droid against it. Replacing Ollama outright would delete this group.

    **Why a seam is worth having anyway.** Three separate pressures, only the
    third of which is speculative:
    - **The iGPU, i.e. #200.** That item exists because Ollama ≥0.32 drops
      integrated GPUs by default and the remedy is an environment variable plus
      a systemd drop-in the user has to be talked through. llama.cpp's **Vulkan**
      backend and AMD's **Lemonade** (open source, AMD-co-developed, llama.cpp
      via Vulkan/ROCm, and NPU offload through ONNX Runtime GenAI on Ryzen AI
      300-series) treat an APU as a first-class target rather than as something
      to be re-enabled. On the machine #200 was found on, this is not a
      preference — it is the difference between the GPU being used and not.
    - **Model management is no longer the differentiator.** `llama-server` now
      has **router mode**: several models in isolated child processes, on-demand
      load, LRU eviction, one OpenAI-compatible endpoint, auto-discovery of the
      `~/.cache/llama.cpp` tree. `llama-swap` does the same as a proxy in front
      of llama.cpp/vLLM/TabbyAPI. The thing Ollama was actually better at is
      upstream now.
    - **Direction of travel.** Reported through 2026: a closed-source desktop
      GUI (later relicensed), a pivot toward hosted proprietary models, a $65M
      Series B, and repeated CVEs including one in the GGUF loader rated 9.1.
      None of this breaks Tabtivity today, and none of it should be treated as
      settled fact without checking — but a hard dependency with no seam is how
      a vendor's roadmap becomes ours.

    **Explicitly out of scope:** vLLM (multi-user GPU serving — the wrong shape
    for a desktop app), MLX (Apple-only, and Ollama already uses it there), and
    LM Studio (proprietary, GUI-first; Tabtivity already owns the UI, so the `lms`
    CLI would buy only a second model manager).

    Four parts, in increasing size. **201a is independent and worth doing on its
    own** — do not let it wait on the rest.

    **201a — `ollama_host` is a setting that does nothing.** ✅ **Done**
    (2026-07-29). It was declared (`schema/settings.rs`) and read by **no code on
    either side**, while `ollama_http` connected to the literal
    `127.0.0.1:11434` — so anyone running Ollama on another port or in a
    container had a field in `settings.json` that was silently ignored. Now
    `resolve_ollama_addr` (pure, tested) is the single answer to "where is the
    server", read on every call (a settings write is not an event this module
    hears) and honoured by the transport, the pull streamer, the reachability
    probe, `ensure_ollama_running` and the `vibe` provider's `api_base`.
    Four decisions are the fix rather than incidental to it:
    - **`https://` is an error, never a downgrade.** This transport is a raw
      `TcpStream` speaking HTTP/1.0; connecting in the clear to an address the
      user wrote as TLS would put their prompts on the wire while the setting
      says otherwise. Refused with a sentence.
    - **A non-loopback host needs `ollama_allow_remote_host` (new, default
      false).** Two keys rather than one, because they are different decisions:
      another *port* is still local inference, another *host* means every prompt
      and every file an agent reads leaves this machine. Judged on the literal
      that was typed, never on what it resolves to.
    - **`ensure_ollama_running` only starts a server it could own.** A remote
      endpoint is refused with its address rather than answered by silently
      spawning a *local* server the caller was never pointed at; the systemd
      branch runs only for the default address (the unit binds what the unit
      says, so starting it to satisfy a request for 11500 reports success for
      the wrong server); and a spawned `ollama serve` gets `OLLAMA_HOST`, or a
      non-default port would bind 11434 and then time out being waited for.
    - **The connect is bounded (`OLLAMA_CONNECT_TIMEOUT`, 4 s).** Making a remote
      host reachable at all is what made this necessary: a bare
      `TcpStream::connect` at a host that is off or mistyped blocks on the
      kernel's TCP retries for over two minutes. Loopback refuses instantly and
      never reaches the bound, so the default configuration is untouched.

    Two things this turned up and one it deliberately does not do. `ollama
    --version` is **not** pointed at `ollama_host` — that was tried, and it costs
    the documented "`check_remote: false` touches no network" property *and*
    2 minutes per call against an unreachable host; the version wanted there is
    the installed binary's, and `parse_version` already scans past the
    server-unreachable warning. And with an unreachable **remote** host each
    local-model read costs up to 4 s per request (a `list_local_drivers` makes
    two), which is bounded and noticeable — one more reason that path is opt-in.
    Still **not** covered, and belonging to 201b/201d rather than here: the
    `ollama launch` argv handed to a PTY carries no `OLLAMA_HOST`, so a local
    agent tab still wires itself against the default endpoint; and there is no
    UI for either key — both are edited in `settings.json`.
    - [x] 🤖 Automated test — `commands::ollama::tests`, seven cases:
      unset/blank is byte-for-byte the old address, ports and `http://` and
      bare-`:port`/`11500` and `0.0.0.0`/IPv6 spellings, `https://` refused,
      remote refused without the opt-in and accepted with it, a header-injecting
      host refused, and `addr_is_loopback` for the ensure-running gate.
    - [ ] 🖐️ Manual test — verified live against a second `ollama serve` on
      11500 via `TABTIVITY_STATE_DIR` + `examples/ollama_probe.rs` (2026-07-29):
      the configured port returns that server's own model list (a different set
      from the systemd server's, which is the proof it did not fall back), a
      port with nothing listening reports `not_running` instead of quietly
      reaching 11434, and both refusals surface their sentence.
      - [x] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

    **201b — name the seam.** A `LocalRuntime` trait over the ~6 questions Tabtivity
    actually asks: is it up, list models, model capabilities, load/unload,
    what is resident, pull. Ollama becomes the first implementation, not the
    only shape. Deliberately **do not** abstract what is genuinely Ollama's —
    `ollama launch`, the registry manifest-digest update check, the systemd
    drop-in, `OLLAMA_IGPU_ENABLE`: a runtime that cannot do those must *say so*
    (the `LocalDriverInfo.available` pattern), never pretend. Note the honest
    cost up front so nobody underestimates it: the settings keys, the command
    names, `src/lib/agents/localDrivers.ts`, `stores/agents/ollamaAutoload.ts` and the 🧠 menu
    are all *named* `ollama`, so this is a rename as much as a refactor.
    Persisted keys stay as they are — new fields are additive, or every existing
    `settings.json` needs a migration for a feature nobody asked for yet.
    - [ ] 🤖 Automated test — the Ollama implementation reproduces today's
      behaviour command-for-command; a driver reporting no `launch` support
      empties the local-agent group with a reason rather than silently.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

    **201c — a second implementation, as the proof the seam is real.**
    **Lemonade first**, for two reasons that are not "it is newer": it answers
    #200's actual defect, and it exposes **Ollama-compatible** endpoints
    alongside OpenAI- and Anthropic-compatible ones, so it can be tested behind
    the existing transport before any of it is generalized. `llama-server`
    router mode second, as the no-vendor option. Verify the Linux install path
    and the Vulkan/iGPU claim on this machine before committing to either —
    both are third-party claims at this point, not measurements.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test — a model loads onto the 890M **without** the
      `OLLAMA_IGPU_ENABLE` drop-in, and `ollama_gpu_status`'s equivalent reads
      it as on-GPU.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

    **201d — the picker, and what it must admit.** A runtime selector in the
    Ollama settings panel (which #78 is already opening up), plus the sentence
    the local-agent group needs: with a non-Ollama runtime selected, the
    `ollama launch` agents are **not available**, and the menu has to say which
    of the two reasons emptied it — exactly the distinction
    `needs_tools_unsupported` already draws for a model that lacks `tools`.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

    **Priority: below #74/#76/#77/#78.** Those finish a feature that is
    currently invisible and carry a known `RESUMABLE_AGENTS` collision; this one
    buys optionality. 201a was the exception — a defect, small, and a
    prerequisite for the rest — and is done.

202. **A capable model is not a suitable one.** ✅ **Shipped** (2026-07-29),
    unverified in the UI. Reported: Codex and Claude Code on a local model
    answer a trivial prompt with nonsense, while Mistral/vibe on the same model
    is fine. Measured on `qwen3-coder:latest` (`tools`, no `thinking`): the
    plain Ollama chat endpoint answers `"test"` sensibly in 27 tokens / 3.0 s,
    while the exact launch line `prepare_local_launch` builds for Codex put
    **5128 tokens** of harness in front of the same model, which then ran away
    past **4100 tokens** without stopping. So the defect is not a missing
    capability — it is the *weight of the agent's own prompt*, which no
    `/api/show` field reports.
    - The proposed fix, gating these drivers on the `thinking` capability, was
      **rejected as measured**: on the reporting machine no installed model
      carried both `tools` and `thinking` (`qwen3-coder`/`llama4` have tools and
      no thinking; `deepseek-r1` has thinking and no tools, so the existing tool
      gate already withholds it). Gating on `thinking` would have removed Codex
      and Claude Code from the 🧠 menu for **every** model present rather than
      steering anyone to a better one. Claude Code is also the control that
      rules out the wire protocol: it has no fallback, so it *always* goes
      through `ollama launch` (`wire_api = "responses"`) while Codex on a
      non-thinking model is forced onto the direct `--oss` path — two
      transports, same complaint.
    - Shipped instead: `LocalDriver::heavy_harness` → `LocalDriverInfo` → a `⚠`
      with a sentence on the row in both the **+** menu and the tab-bar menu
      (`AddMenuEntry.caution`, which cautions without disabling — `available`
      stays the only field that withholds a row). True for all five
      `LOCAL_DRIVERS`, because all five are coding-agent CLIs written against
      hosted frontier models; a driver built for local models sets it `false`,
      which is what `vibe` would do if it were ever moved into that registry.
    - [ ] 🤖 Automated test — the flag survives `list_local_drivers` for an
      *unavailable* driver too (the menu must not be the thing that decides a
      hidden row's caution), and a `false` row renders no caution.
    - [ ] 🖐️ Manual test — the `⚠` renders and reads correctly in both menus and
      in all five languages; the tooltip is reachable (it is `title` + an
      `aria-label`, on a `<span>` inside a `<button>`).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - Left undone deliberately, both offered and declined: promoting vibe as the
      recommended local driver, and stripping the user's own MCP servers from a
      local Codex tab via `-c mcp_servers={}`. The second is a real lever — a
      local Codex tab inherits `~/.codex/config.toml`, so declared MCP tool
      schemas are inside that 5128-token prompt — and is worth its own item if
      the caution turns out not to be enough.

---

- [ ] Live-check fenced Codex without a sandbox-backend override (2026-09-15):
  the forced `features.use_legacy_landlock` (2026-09-14) is gone — Codex
  0.154.0 warns it is deprecated on every start, and its legacy backend panics
  on workspace-write unless `/tmp` is excluded from the writable roots. Nested
  bubblewrap stays impossible under the fence (AppArmor `unpriv_bwrap` denies
  the second user namespace), so expect Codex to report the failed sandbox and
  ask to run outside it; confirm "approve for session" makes that a one-time
  question, and that the fence still bounds writes to the project roots. If
  the per-command asking is unbearable, the honest options are a fence-off
  toggle for that project or a Codex-side exec rule, not another backend flag.
  2026-09-28: letting Codex's bwrap nest via AppArmor was rejected (it can't
  be limited to the fence; see `docs/context/agent_authority.md`). Next
  lever to live-check: Codex auto-review (`approvals_reviewer =
  "auto_review"`) answering the sandbox-failed retry requests.

203. **Manage CLIs is two lists, not one.** ✅ **Shipped** (2026-08-31). The
    panel rendered every CLI in the registry as a full install card, sorted
    installed-first, so the handful of entries anyone manages (enable, remove,
    reinstall, schedule) sat above a dozen cards nobody had asked for and the
    list only gets longer as agents are added. It is now two `SettingsSection`s
    over one card renderer — **Installed**, always listed, and **Available to
    install**, which shows *nothing* until a query is typed into its search box
    (matched on the label, the id and the binary name, since a CLI is looked for
    by whichever of the three the user happens to know). The empty states are
    stated rather than blank: a count + "type a name" with no query, a named
    miss for one that matches nothing, and "everything is installed" when the
    catalog is exhausted.
    - [ ] 🖐️ Manual test — both sections render, the search finds a CLI by
      label/id/bin, an install from a search result moves the card to
      **Installed** on the next refresh, and the three empty states read
      correctly in all five languages.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

204. **Agent fence — confine local agents to their project or box.** ✅
    **Implemented 2026-08-31; automated coverage added; live QA pending.**
    Default-on Linux `bubblewrap` boundary for agent/local-agent tabs, with a
    global toggle + read-only toolchain allowlist and per-project
    inherit/off/on override. The backend owns the decision, fails closed when
    bubblewrap cannot actually create a namespace, and computes project roots
    plus the union of every box membership. Container agents keep their
    container boundary; remote-host/macOS/Windows cases are named as not
    enforced. Filesystem only (network shared). See
    `docs/context/agent_authority.md` and `services/agent_fence.rs`.
    - [x] 🤖 Automated test — bwrap argv ordering/binds, decision matrix,
      override precedence, plain/multi-box/box-scope roots, agent-native
      add-dir flags + idempotence, multi-root transcript rw classification,
      frontend pill states/status reasons and settings-path round-trip.
    - [ ] 🖐️ Manual test after a deliberate backend restart:
      - [ ] Fenced Claude starts at all (fixed 2026-08-31: the fence now binds
        the binary's symlink-chain dirs, e.g. `~/.local/share/claude/versions`,
        instead of dying with `bwrap: execvp claude: No such file or directory`).
      - [ ] A Claude tab in a folder Claude has never been trusted in starts and
        waits for the user's answer (fixed 2026-09-04, found in a box: every tab
        carries an auto-typed `/rename <project>` submitted with a bare Enter,
        and in an untrusted folder Claude draws its trust dialog first — whose
        highlighted row is `No, exit`. The tab answered itself and died on
        launch with only `[process exited]`. Compounding it, the fence stages
        `~/.claude.json` as a copy rewritten from the host file at **every**
        spawn, so an acceptance made inside a tab was gone before the next one
        started and the dialog came back forever. Now: `claude_folder_trusted`
        is asked before the auto-type and the rename is skipped while the
        question is pending, and the answer is remembered in Tabtivity's own
        `<state_dir>/agent_trust.json` and re-applied to each staged copy for
        paths inside that tab's roots — the host file is still never written.)
      - [ ] The same folder asked about only ONCE: answer `Yes, I trust`, then
        open a second Claude tab there and confirm it goes straight in, and that
        a quit/relaunch in between does not bring the question back.
      - [ ] Claude's grey diff panel ("No changes this session") stays closed
        once closed (fixed 2026-09-09: the panel is Claude's own fullscreen-layout
        diff sidebar, which opens by itself once a session has changes and the
        tab is wide enough; closing it — `/diff` toggles it — writes
        `diffSidebarOpen: false` to `~/.claude.json`, which a fenced tab only
        ever sees as the stage copy rewritten at each spawn, so the panel came
        back in every new tab. Now `sandbox::CLAUDE_CARRIED_PREFS` names the
        `~/.claude.json` toggles harvested from the stage copy into
        `agent_trust.json` and re-applied to each later copy — the host file is
        still never written.) To test after a backend restart: close the panel
        in a fenced Claude tab, make an edit in a *new* fenced tab, confirm no
        panel; open it again with `/diff` in one tab and confirm the next tab
        keeps Claude's own auto-open behaviour.
      - [ ] Fenced Claude starts **logged in**, no per-tab login/onboarding
        (fixed 2026-08-31: `~/.claude.json` staged as a filtered per-project
        copy — login/onboarding kept, foreign projects' history/allowedTools
        stripped, writes die with the stage; containers get the same mount).
      - [ ] Plain local Claude: `~/.ssh` and another project are absent; edits
        inside its project work; `/rename`/SessionStart resume survives respawn.
      - [ ] Repeat the boundary/edit check in Codex and Gemini.
      - [ ] Member A's agent can list/edit member B and the box folder; a
        box-scoped agent can do the same; native add-dir flags are present.
      - [ ] Pill cycles default → off → on; off lets a newly respawned agent see
        the ordinary home while existing tabs remain unchanged.
      - [ ] Remote project says “not enforced: remote host” and still spawns.
      - [ ] Container project skips the fence and keeps the container boundary.
      - [ ] Missing bubblewrap gives the readable fail-closed error and the
        install row; after install/recheck the row disappears.
      - [ ] A shell tab in the same project remains unfenced.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

- [ ] **Shift+Tab reaches a Codex tab.** xterm.js has no kitty keyboard
  protocol and no `modifyOtherKeys`, so Shift+Tab left it as the legacy backtab
  `ESC [ Z` — which codex-cli 0.151.0 does not bind to anything, so the key was
  inert in every Tabtivity Codex tab while its own footer advertised "shift+tab to
  cycle". Fixed 2026-08-31: `terminalControl.shiftTabForAgent` re-encodes it as
  the CSI-u form `ESC [ 9 ; 2 u` for Codex panes only (Claude/Qwen read the
  backtab), on the desktop pane and on Tabtivity Mobile's mode walk alike. Verified
  in a bare PTY: `ESC [ Z` changed nothing, `ESC [ 9 ; 2 u` stepped the mode.
  QA:
      - [ ] Shift+Tab in a Codex tab steps to Plan mode and back.
      - [ ] Shift+Tab in a Claude tab still cycles its own modes.
      - [ ] Shift+Tab in a plain shell tab still sends a backtab (readline
        completion, `less`, an ncurses form).
      - [ ] The phone's mode chip lands on the mode it was asked for.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

- [~] **249 — Agents view + collected prompts** (2026-09-02; ✅ code-complete and
  automated tests passing, ⚠️ live QA pending). The file viewer's row grew a
  fourth entry, Files / Git / Apps / **Agents**: every agent tab of the scope
  that can carry schedules (live state, enabled count, next run, one click into
  the schedule dialog), plus the project's **collected prompts** — text kept
  without a tab in `agent_prompts.json`, sent to a chosen tab now or turned
  into a schedule with the dialog prefilled. *Send now* is a one-time schedule
  at the current minute, so it inherits the idle gate, claim, receipt and the
  one-hour window (a busy agent waits; after an hour it reads "missed"); a tab
  at its cap drops finished one-time entries first. Mirrored on the phone as
  31q. Locked by `AgentPromptSend.test.ts`, `AgentSchedulesView.test.tsx`,
  `services::agent_prompts` tests.
  - [ ] 🖐️ Manual desktop QA — open Agents in the side panel and in a Files
    tab; confirm every agent tab of the project is listed with a sensible
    state and count; collect a prompt, Send now to an idle agent and see it
    typed at the next idle point and the tab's ◷ status read Delivered; Send
    to a busy agent and see "Due now" until it settles; Schedule… opens the
    dialog with the text prefilled; edit/delete a prompt and see the phone's
    sheet follow.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
- [~] **Per-tab scheduled agent prompts** (2026-09-01; ✅ code-complete and
  automated tests passing, ⚠️ live QA pending). Multiple one-time/daily/weekday
  prompts are bound to a stable local-only tab target, claimed atomically, and
  delivered only after the live PTY has settled and is idle. Focus does not
  suppress delivery; the dialog explicitly warns that the current composer
  draft is replaced. Definitions/receipts stay in `agent_tasks.json` and never
  enter the project-tree session export.
  - 2026-09-02 fix (found via the phone's `tab_not_found`): `loadFromLayout`
    minted/kept `scheduleTargetId` on its `tabShape` helper but never on the
    restored entry, so every restored agent tab had no target — no ◷ on the
    desktop, the mobile bridge refusing the tab, and the startup orphan sweep
    emptying `agent_tasks.json` on each launch. The entry now carries the id,
    and every schedule write persists the scope so a freshly minted binding
    reaches disk before a quit. Locked by `TabScheduleTarget.test.ts`.
  - 2026-09-02 fix (restart audit): stopping a project (`deactivateProject` →
    `unloadScope`) dropped the whole in-memory scope, and the host's tab diff
    read that as every agent tab closed — deleting the project's schedules
    although its layout (and target ids) restore on the next activation. A
    binding is now deleted only while its scope still exists; a vanished scope
    keeps its schedules for the startup sweep to judge. App quit/relaunch was
    already intact: all active projects hydrate at launch with their ids.
    Locked by `AgentScheduleHostUnload.test.tsx`.
  - [ ] 🖐️ Manual desktop QA — add/edit/toggle/delete two schedules, verify the
    tab indicator/next/last status, a focused draft is replaced, a busy agent
    waits, an approval prompt blocks, a second due prompt waits for output plus
    idle, and a >60-minute occurrence records missed without backlog delivery.
  - [ ] 🖐️ Restart/DST QA — resumable Claude/Codex targets survive a deliberate
    restart; non-resumable schedules disappear; spring-gap time is skipped and
    an autumn repeated time fires once.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **Agent Schedule MCP** (2026-09-20; ✅ desktop v1 code-complete, ❌ never
  live-verified — `UntestedTag` id `scheduleMcp`): project agents propose rows
  in their own tab's schedule list over a separate `/mcp/schedule` path —
  self-target only, staged by default, no preface, no `/`·`!`·`#`·`$`·`@`
  messages, quotas. Runtime notes and
  the click-through: `docs/context/agent_schedule_mcp.md`.
  - [ ] 🖐️ Live QA — the six steps in `docs/context/agent_schedule_mcp.md`
    (needs a build with the new backend): propose → approve → idle delivery in
    Claude, Codex and a fenced tab; refusals; Apply level; revoke; restart.
  - [ ] Follow-ups: phone Approve / Dismiss; Gemini/Qwen/OpenCode flag
    recipes; remote/container reach; root-console scheduling tool.
  - [ ] ✅ Works on Linux (X11)
  - [ ] ❌ Doesn't work on Linux (X11)
  - [ ] ✅ Works on Linux (Wayland)
  - [ ] ❌ Doesn't work on Linux (Wayland)
  - [ ] ✅ Works on Windows
  - [ ] ❌ Doesn't work on Windows
  - [ ] ✅ Works on macOS
  - [ ] ❌ Doesn't work on macOS

- [~] **250 — Per-tab prompt composer + collected-prompt history** (2026-09-02;
  ✅ code-complete, ❌ never live-verified). The Agents view grew the field that
  makes it usable without a detour through the schedule dialog, and lost the one
  piece of shared state that made a send ambiguous.
  - **A composer under each agent tab**: prefix chips, the agent's own model
    pick, a message, and Send — aimed at the tab it is rendered under, so
    nothing has to be targeted first. The chips and the model are that CLI's own
    slash commands (`lib/agents/agentPrefaces`), submitted **one at a time, in order,
    ahead of the prompt** rather than as extra lines of it — `/clear` and
    `/model` take a whole line and would otherwise swallow the prompt appended
    to them. `ScheduledAgentPrompt.preface` carries them (Rust + TS), and
    `AgentScheduleHost` waits for the tab to go quiet between submissions
    (capped, since the occurrence is already claimed).
  - **Tabtivity still chooses nothing.** There is a model pick and deliberately no
    permission/plan mode: the composer types what the user picked into the
    agent's own CLI, which is the same line AGENTS.md draws around agent
    authority. No flag is injected at launch, here or anywhere.
  - **Both lists are editable** per agent under Settings → Agents
    (`agent_preface_commands`, `agent_models`), because slash commands and model
    names date faster than this app ships. An agent with no default gets an
    empty list rather than an invented command; "Use defaults" deletes the key
    rather than writing the defaults out, so a later change still reaches it.
  - **Restructure**: the tab's NAME leads and its working/needs-a-decision/idle
    state reads after it; the three section headers use the settings design
    system's own `.settings-section-title`.
  - **No view-wide target tab.** Which agent a collected prompt is for is asked
    in the row, at the moment of the send, instead of being a mode the whole
    list silently sat in.
  - **Sent prompts move to a history section** (`agent_prompts.json`'s new
    `history` map, capped at 200 per project) recording where each went: the tab
    label and the **agent session id**, which is the only thing that still names
    the conversation once the tab is closed. The phone's send retires a prompt
    the same way (`sendCollectedPrompt`), so one collected prompt cannot be sent
    twice from two surfaces.
  - 🤖 Automated: `AgentPrefaces.test.ts` (sanitize parity with the Rust
    validator, list resolution, model-last ordering), `ScheduledAgentInput`
    (one submission per prefix, one counted prompt), `AgentSchedulesView`
    (per-row target pick, archive-on-send, chips reaching the schedule), plus
    Rust unit tests for the preface rules and the history move/cap.
  - [ ] 🖐️ Manual desktop QA — send from a tab's composer with `/clear` +
    a model picked and watch the three submissions land in order; send a
    collected prompt, pick the tab in the row, see it leave the list and appear
    under Sent prompts with the right session id; "Collect again"; Clear.
  - [ ] 🖐️ Settings QA — add/reorder/remove a chip and a model for one agent,
    confirm the composer follows, then "Use defaults" and confirm it reverts.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **251 — Deliveries leave the schedule menu for Sent prompts** (2026-09-02;
  ✅ code-complete, ❌ never live-verified). A one-time rule that had run stayed
  in the tab's schedule menu forever, as a plan that says it already happened,
  while the side panel's Sent prompts knew only about prompts sent by hand.
  - **The menu is about the future.** `AgentScheduleHost` writes each run onto
    the project's history (`agent_prompt_record`) and then deletes a one-time
    rule; the dialog filters finished one-time entries as well, so one still on
    its way out is never listed. Recurring rules stay — they still fire — and
    contribute one history row per occurrence.
  - **The record is written first**, the rule dropped only once it lands: the
    prompt has already reached the agent by then, and a rule deleted after a
    failed write would take the only account of the delivery with it. A rule
    left finished by an older build or by a crash between the receipt and the
    retire is swept the same way on the next tick, so old state migrates itself.
  - **One prompt, one row.** `deliveryRecordId` records a one-time run under the
    collected prompt's own id — which is why `sendCollectedPrompt` now gives the
    queued rule that id — so the delivery turns that prompt's *Queued* row into
    a *Delivered* one instead of listing the same text twice; a recurring rule
    records under `id@occurrence`, which also makes a retry idempotent.
  - **What a sent prompt now says**: the outcome (Queued / Delivered / Missed /
    Failed), the prompt, the tab **and the agent** it went to, the session id,
    the occurrence it was due at, when it was collected and when it went.
    `SentAgentPrompt` gained `agent`, `result` and `scheduled_for`, all optional
    so a file written before this still loads.
  - **The schedule form gained the composer's two pickers** — prefix chips and
    the agent's own `/model` — because a prompt that needs `/clear` and a model
    at 9:00 needs them every 9:00. Still the agent's own slash commands, still
    no permission/plan mode. `splitPreface` reads a saved rule back into chips
    and a model, and a command the agent no longer offers stays a chip of its
    own rather than vanishing when the rule is edited.
  - 🤖 Automated: `AgentScheduleRetire` (record-then-delete, recurring rules
    kept, rule kept when the write fails), `AgentPromptSend` (record ids),
    `AgentPrefaces` (`splitPreface` round-trip), `AgentScheduleDialog` (finished
    rules hidden, preface saved), `AgentSchedulesView` (the row's outcome,
    agent, session and times), plus Rust unit tests for the same-id update and
    the never-collected row.
  - [ ] 🖐️ Manual desktop QA — schedule a one-time prompt a minute out, watch it
    deliver, and confirm it is **gone from the tab's ◷ Schedules menu** and
    present under Sent prompts with Delivered, the agent, the session id and
    both times; confirm a daily rule stays in the menu and adds one row per run.
  - [ ] 🖐️ Manual desktop QA — put `/clear` and a model on a daily rule, save,
    reopen it for editing and confirm both come back; watch the three
    submissions land in order at the next run.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

253. **Agents view: rename a tab where its name is read, and let the prompt text
    look like the prompt.** Two small things the Agents view was missing once it
    had rows in it.
    - **Rename.** Telling three agents apart in this list is entirely down to
      their names, and the only way to change one was a right-click on the tab
      itself — a tab that need not be in the group on screen. Each row's name
      now has a ✎ beside it that turns it into an input (Enter commits, Escape
      abandons, blur commits; an empty name leaves the tab named what it was),
      styled off the tab bar's own inline rename so the two read as one feature.
      The store gained `renameTabInScope`, because this view lists
      `tabsByScope[scope]` for **its** scope while `renameTab` writes to
      whichever scope is active; the same-scope case still goes through
      `renameTab`, keeping the detached-popout forwarding path intact.
    - **The prompt text.** In both the collected and the sent lists the prompt
      was a bare `<span>` among the metadata lines, so the one thing the user
      wrote read as one more line of Tabtivity's record of it. It is now quoted —
      an accent rule down the left, indented off it, on the panel ground rather
      than the row's control fill (`.agent-prompts-message`).
    Frontend: `components/agents/AgentSchedulesView.tsx`, `stores/tabs.ts`,
    `styles/projects-tabs.css`.
    Implemented 2026-09-02, **not live-tested**.
    - [x] 🤖 Automated test — `AgentTabRename` (the scoped store action, the
      empty-name guard, the inline edit, Escape)
    - [ ] 🖐️ Manual test — open **Agents** in the side panel with two agent
      tabs running, rename one from the row and confirm the tab bar shows the
      new name and keeps it across a relaunch; check the prompt text in Sent
      prompts is visibly set apart from the outcome/tab/time lines.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

254. **Agents view: copy a collected prompt, drag the list into order, and
    narrow the sent one.** Three things the two prompt lists were missing once
    they had more than a couple of rows in them.
    - **Copy.** A collected prompt is text written to be pasted somewhere — a
      terminal, an issue, another agent — and the only way to get it back was to
      select it in a 12px row. Each row (collected *and* sent) now has the same
      one-click ⧉ the session id already had, with the ✓ acknowledgement the
      clipboard does not give. The ack is keyed by *button*, not by text, so two
      rows holding the same sentence tick separately.
    - **Order.** The collected list is an ordered one — the prompt to send first
      belongs at the top — but the order was the file's insertion order and the
      only way to change it was delete-and-retype. Rows now drag by a grip
      through `hooks/useListReorder`, which is the to-do checklist's gesture
      *moved out* of `components/todo/useStepReorder.ts` and generalized to any
      `{ id }[]`: pointer events (WebKitGTK does not deliver HTML5 DnD), rects
      frozen at pointerdown, arrow keys on the focused grip. The drop persists
      through a new `agent_prompt_reorder` command that takes the whole new id
      order; ids it does not name keep their relative place at the end, so a
      prompt collected in another window between the read and the write is not
      dropped. `lib/listReorder` holds the shared arithmetic (`dropSlot`,
      `reorderedIds`); `lib/todoBoard`'s `stepDropSlot` is now an alias of it.
    - **Filter.** The sent list is a bounded record (200 per project) opened with
      narrow questions: what did I send Codex, what failed, what went out today,
      where did that one sentence go. Four composing facets answer them — text
      over prompt/tab/agent/session, the agent, the outcome (with *queued*, the
      absence of a result, as a filter of its own), and a time window where
      `Today` is the calendar day and the rest roll back from now. The filter is
      view state, not a setting: the next visit starts on the whole list. The
      foot says `Showing n of m`, and Clear (which still deletes *everything*)
      says so in its tooltip.
    Frontend: `components/agents/AgentSchedulesView.tsx`, `lib/listReorder.ts`,
    `lib/agents/prompt/filter.ts`, `hooks/useListReorder.ts` (moved),
    `stores/agents/agentPrompts.ts`, `styles/projects-tabs.css`.
    Backend: `services/agent_prompts.rs`, `commands/agent_prompts.rs` — so the
    reorder command needs a restart before the drag can persist.
    Implemented 2026-09-02, **not live-tested**.
    - [x] 🤖 Automated test — `AgentPromptFilter` (the four facets, their
      composition, `today` vs. rolling windows, an unreadable `sent_at` kept,
      `reorderedIds`/`dropSlot`), `AgentSchedulesView` (copy, the reorder
      commit and its optimistic paint, filtering by text/agent/window), plus a
      Rust unit test for the named-order-then-the-rest reorder.
    - [ ] 🖐️ Manual test — with several collected prompts, drag one to the top,
      relaunch and confirm it stayed; copy one and paste it elsewhere; in Sent
      prompts filter by an agent and by *Last 7 days* and confirm the count line
      and the empty state read correctly.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

255. **Agents view: tag the prompts, search the library, and blame a change on
    a prompt.** The collected list was a pile; the sent list knew *where* a
    prompt went but nothing about *what it did to the tree*.
    - **Tags.** A collected prompt carries short lowercase tokens
      (`refactor, tests, paper`) typed as one line beside the text, in the add
      form and in the row editor. Stored on the row (`ProjectAgentPrompt.tags`),
      normalized identically on both sides (`lib/agents/prompt/tags` ↔
      `services::agent_prompts::normalize_tag`: trimmed, `#` stripped,
      lowercase, inner whitespace folded to `-`), capped at 16 per prompt. The
      phone edits text only and its `tags: None` **keeps** a prompt's tags; an
      editor that names a list, empty included, replaces them. Tags travel into
      the history at send time and survive the delivery's re-record, and
      *Collect again* brings them back.
    - **Library search.** The collected section gains a search box (text over
      the prompt and its tags; `#tag` matches tags only) and one chip per tag in
      use with its count — a chip narrows the list, and a row's own tag chips do
      the same. Dragging is withheld while a filter is on: a drop index into a
      filtered view names the wrong slot in the file's order. The sent list's
      filter gains a **tag** facet and its text search reaches tags, the commit,
      the branch and the touched files.
    - **Prompt blame.** `git blame` says which commit put a line there; this
      says which prompt did. At send/record time the backend stamps the row
      with the local repo's HEAD (`commit`, `branch`; `services::prompt_blame`,
      **local projects only** — a remote repo's git is an SSH round trip that
      must not run inside a send, so a remote row simply carries none). Once
      `AgentScheduleHost` sees the tab idle again after a *delivered* send it
      calls `agent_prompt_blame`, which records the files that changed between
      the submission and now: working-tree entries (`git status -z`) whose mtime
      is after the submission, plus `git diff --name-only <commit> HEAD` when
      the repo has moved on; deletions are never attributed, an unreadable mtime
      is kept, the list is sorted and capped at 200. Git runs outside the file
      lock; `archive`/`record`/`blame` commands went `async` + off-thread for
      it. The row shows `branch @ abc1234` with a copy of the full hash, and the
      files fold behind a `N file(s) touched` summary where each file is a
      button that sets the text filter — "which prompts touched this file" in
      one click. A delivered row without files yet says so.
    Frontend: `components/agents/AgentSchedulesView.tsx`,
    `components/layout/AgentScheduleHost.tsx`, `lib/agents/prompt/tags.ts` (new),
    `lib/agents/prompt/filter.ts`, `stores/agents/agentPrompts.ts`,
    `styles/projects-tabs.css`, `lib/i18n.ts` + the four dictionaries.
    Backend: `services/prompt_blame.rs` (new), `services/agent_prompts.rs`,
    `schema/agent_prompts.rs`, `commands/agent_prompts.rs`, `lib.rs` — so tags
    persist and the blame lands only after a restart.
    Implemented 2026-09-02, **not live-tested**.
    - [x] 🤖 Automated test — `AgentPromptTags` (normalization, the comma /
      `#` split rule, caps, round-trip, counts, the library filter),
      `AgentPromptFilter` (tag facet, `#tag`, file/commit/branch text hits),
      `AgentSchedulesView` (tags saved from the add form and the row editor, the
      chip and `#` search narrowing, a sent row's commit + files and the
      file-click filter); Rust: tag validation, tags kept unless named, archive
      carries tags + head, a delivery keeps the send row's tags and takes the
      fresher head, blame lands and survives a re-record, `-z` status parsing
      (rename sources skipped, deletions marked), the mtime rule, ISO parsing of
      both writers' stamps.
    - [ ] 🖐️ Manual test — collect a prompt with `refactor, tests`, confirm the
      chips and that clicking one narrows the list; edit its tags and relaunch;
      send it to a Claude tab in a **local** git project, let the agent change a
      file and go idle, then confirm the sent row shows the branch and short
      hash, a `N file(s) touched` fold listing that file, and that clicking the
      file narrows the sent list to that prompt. Send one from a remote project
      and confirm the row shows no commit line and no error.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

256. **Agents view: one lifecycle — collected → scheduled → sent.** A prompt
    turned into a rule stayed in the collected list looking exactly like text
    nobody had done anything with yet, and it stayed there *after the rule had
    fired* too, next to a Sent row saying it had already gone — which is how the
    same prompt gets sent twice.
    - **A new Scheduled prompts section** between the library and Sent prompts.
      A prompt with a live rule leaves the library and reads here with what it
      is waiting for (which tabs carry it, when it next fires). The link is
      still `lib/agents/prompt/scheduled`'s key — the prompt's own text — so
      deleting the rule brings the prompt back to the library rather than
      needing anything kept in step.
    - **A one-time delivery retires the prompt.** `AgentScheduleHost`'s retire
      step already records the run and deletes the finished rule; it now also
      deletes the collected prompt carrying that text, so the prompt *moves* to
      Sent prompts the way a "Send now" one always did. It only deletes — the
      record has just been written, and archiving would file a second row for
      one delivery. A **recurring** rule keeps its prompt in Scheduled, because
      it is going to fire again.
    - **The row is two lines**, in all three lists: the prompt takes the full
      width of its own line and the buttons sit under it (`is-stacked`, plus a
      gripless variant for the two lists whose order is not the library's). A
      column of buttons beside the text squeezed the message into a gutter.
    - The library's search, tag chips, count line and drag now run over the
      *collected* prompts only; a reorder still writes the whole file order,
      leaving the scheduled prompts in their own slots.
    Frontend: `components/agents/AgentSchedulesView.tsx`,
    `components/layout/AgentScheduleHost.tsx`, `styles/projects-tabs.css`,
    `lib/i18n.ts` + the four dictionaries. No backend change.
    Implemented 2026-09-02, **not live-tested**.
    - [x] 🤖 Automated test — `AgentSchedulesView` (a scheduled prompt leaves
      the library for the Scheduled section, the library's empty state, the
      existing mark and unmarked cases).
    - [ ] 🖐️ Manual test — collect a prompt, *Schedule…* it a minute out on an
      agent tab, and confirm it moves to Scheduled prompts with its next run;
      let it fire and confirm it leaves that section for Sent prompts and is
      gone from the collected list. Repeat with a daily rule and confirm the
      prompt stays in Scheduled after the first delivery. Check the rows read as
      text-then-buttons in all three lists.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

257. **Agents view: a per-tab Continue switch that rides the rate-limit
    windows.** A limit is reached, work stops, and the only thing standing
    between the agent and the moment the limit lifts is somebody noticing. The
    Agents view now carries a ⟳ **Continue** chip on every agent tab row: while
    it is on, `components/layout/AgentContinueHost` reads that agent's own usage
    panel, works out when the soonest window rolls over, submits a single
    `continue` a minute later, then reads the panel again — which by then
    describes the fresh window — and arms the next one. Iterating over the next
    limit is the loop, not a special case.
    - **The reading is free and needs no tab.** `agent_usage` runs the CLI's own
      print-mode `/usage` (`services::agent_usage`); Claude's envelope comes back
      with `num_turns: 0` and zero tokens, so asking how much quota is left
      spends none. Cached 60 s, and a re-read after a send asks with `refresh`.
    - **Not a scheduler.** Nothing is written to `agent_tasks.json` — a rule the
      user never made has no business sitting in the ◷ menu beside the ones they
      did. The only persisted trace is `TabEntry.autoContinue`, one boolean that
      rides the ordinary layout persistence, so the switch survives a relaunch.
      The *armed time* is deliberately live-only: a stored one would fire against
      a window that had already turned over while Tabtivity was closed.
    - **It chooses nothing about the agent.** One word, submitted through
      `lib/agents/scheduledAgentInput` — the same path a scheduled prompt takes — so the
      permission mode stays the agent's own and the idle/decision/settle gate
      applies. The one deliberate loosening is in `deliverable`: a tab whose
      output the activity store has never seen (an ordinary restored agent tab)
      counts as quiet, because a missed rollover here is not retried in an hour
      but at the *next* reset hours later.
    - **It never guesses at a time.** `resolveResetAt` recognizes the shapes
      Claude Code prints (`6:20pm`, `Mon 9am`, `tomorrow 09:00`, `18:20`) and
      refuses everything else — a bare number in a date phrase is a day, not an
      hour. A panel it cannot place is reported as such in the row, along with
      an agent whose CLI publishes no panel at all: a switch that is on and
      quietly doing nothing is the one thing this must not look like.
    - **Every send leaves a record** on the project's Sent prompts, with the tab,
      the agent, the session and the rollover it was due at.
    - The usage parser moved `mobile-web/src/terminal/usageReport.ts` →
      `shared/usageReport.ts`, so the phone's bars and the desktop's countdown
      read one panel the same way.
    Frontend: `components/layout/AgentContinueHost.tsx`, `stores/agents/agentContinue.ts`,
    `lib/agents/agentUsage.ts`, `shared/usageReport.ts`, `stores/tabs.ts`
    (`autoContinue` + `setAutoContinueInScope`), `components/agents/AgentSchedulesView.tsx`,
    `lib/i18n.ts` + the four dictionaries. No backend change.
    Implemented 2026-09-02, **not live-tested**.
    - [x] 🤖 Automated test — `UsageReset` (every reset shape, and the refusals),
      `AgentContinueHost` (off reads nothing, the arm, both refusals, the send +
      its record, the busy and decision gates, and forgetting a switched-off tab).
    - [ ] 🖐️ Manual test — turn ⟳ Continue on for a Claude tab and confirm the row
      reads "continue in Nh · after Current session resets (…)" against what
      `/usage` says in that tab. Let a window actually roll over and confirm one
      `continue` lands about a minute later, that the tab was idle when it did,
      that a Sent-prompts row records it, and that the row re-arms on the next
      window rather than stopping. Turn it on for a Gemini tab and confirm it
      says the CLI publishes no usage panel. Restart Tabtivity and confirm the
      switch comes back on and re-arms.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

258. **Agents view: the ◷ Schedules menu reads as two panes, not one scroll.**
    The per-tab schedules dialog opened every time on the same three screens of
    boilerplate, and the add/edit form sat under however many rules the tab had
    — so making a rule meant scrolling past all of them, and editing one
    scrolled the rule you were editing out of sight. The dialog is now a
    two-pane menu: the saved rules take the wide column, the form takes a fixed
    300px column beside them and stays put while the list scrolls (under ~780px
    the panes stack again, rules first). The two paragraphs of delivery
    semantics fold behind a "How delivery works" summary — the same `<details>`
    treatment the other guides in the app use — while what is specific to *this*
    tab (a non-resumable one) stays out of the fold as a warning of its own. The
    status strip is one line instead of a card with a 20px numeral, section
    headers are the canonical `.settings-section-title`, a rule's buttons sit on
    the row's own last line rather than in a column squeezing the prompt text,
    and the form's fields put their label over the control so a 300px pane fits
    them. Frontend only: `components/agents/AgentScheduleDialog.tsx`,
    `styles/projects-tabs.css`, one new `agentSchedule.howItWorks` string.
    Implemented 2026-09-02, **not live-tested**.
    - [ ] 🖐️ Manual test — open ◷ Schedules on an agent tab with a few rules:
      the form sits beside the list and stays put while the rules scroll,
      Edit fills it without moving the list, the guide opens and closes, a
      non-resumable tab still shows its warning with the guide folded, and
      narrowing the window (or a small screen) stacks the two panes cleanly.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

259. **Agents view: a tab's row is the way to the tab, and it shows the
    finished state too.**
    The Agents view named every agent tab and said what it was waiting for, and
    then left you to find it: the row was a label, and getting to the agent
    meant switching to the tab bar and hunting for the one that was glowing. The
    tab's name is now a link to it, and a spelled-out `↗ Go to` sits with the
    row's other actions for when a hover is not discoverable enough. Both take
    the same jump the project pill's status bars take — `revealTabInScope`
    first, so the tab is already the visible one when the scope arrives —
    extracted from `PillStatusBars` into `lib/shortcuts/tabJump.ts` so the two surfaces
    cannot drift into two answers to the same question; the shared helper also
    covers a box scope and falls back to `setActive` in a popout, where the
    layout lives in another window.
    The state pill gained the state a tab border has always had and this view
    swallowed: **finished, unseen**. It also stopped painting agent state in the
    *schedule* palette — "needs a decision" was the error red while the tab it
    named wore amber, which read as a third state. All four now use the tab
    ring's own `--status-*` colours and its stroke style (working green-dotted,
    done green-solid, decision amber, idle neutral), so the pill and the border
    around the tab are one statement. Precedence matches `TabBar` and the pill
    bars: decision over working over done.
    Frontend only: `components/agents/AgentSchedulesView.tsx`,
    `components/projects/PillStatusBars.tsx`, new `lib/shortcuts/tabJump.ts`,
    `styles/projects-tabs.css`, three new strings in `lib/i18n.ts` + the four
    dictionaries. Implemented 2026-09-02, **not live-tested**.
    - [x] 🤖 Automated test — `AgentSchedulesView` (all four states and their
      precedence; the jump from both the name and the ↗ button leaves the tab
      active in its scope's own layout).
    - [ ] 🖐️ Manual test — in the side panel's Agents view, click an agent tab's
      name and confirm the tab comes up (and the project switches first when the
      view is showing another scope); same from `↗ Go to`. Let an agent finish
      without looking at its tab and confirm the row reads "Finished" in the
      same green the tab's border wears, that a permission prompt turns both
      amber, and that a working agent reads green-dotted in both places.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

260. **A state file must survive being read by a build that did not write it.**
    The Prompts view came up empty behind
    `read agent_prompts.json: unknown field commit`. Blame (#255) added
    `commit`/`branch`/`files` to the history rows, and `AgentPromptsFile` and
    both of its row structs carried `deny_unknown_fields`: any build older than
    that field — a packaged Tabtivity, a frozen `package:dev` snapshot, whatever
    started before the rebuild — refused the **whole** file rather than the one
    key it did not know, so the entire library and its history went dark on a
    machine where several builds legitimately read the same state.
    `deny_unknown_fields` now sits only on the `*Input` payloads, where a
    frontend built from this tree is the caller and a typo should be loud. The
    three persisted structs tolerate what they do not understand and drop it,
    which is the same rule every other schema in `schema/` already follows.
    An older build still *writes back* without the keys it dropped, so a
    downgrade loses blame data — losing three optional fields beats losing the
    library. Backend only: `schema/agent_prompts.rs`, plus two schema tests
    (an unknown key at every level loads; an input payload still refuses one).
    Fixed 2026-09-03, **not live-tested**.
    - [x] 🤖 Automated test — `schema::agent_prompts` (a file with unknown keys
      at the top level, on a collected prompt and on a history row loads with
      its known fields intact; `ProjectAgentPromptInput` still rejects one).
    - [ ] 🖐️ Manual test — with a Tabtivity restarted on this tree, open the side
      panel's Agents view and confirm the collected prompts and the Sent list
      come back with no error banner, and that a prompt's commit/branch still
      shows on its sent row.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

262. **Agents view: a prompt chart replaces the library, Scheduled and Sent
    sections.** Three lists hold the same prompt at three moments of its life,
    and every seam between them is a place #256 had to be written. One surface under the tabs section: cards on
    a vertical timeline (past ordinal with day separators, a now line, a
    proportional zoomable future band), one **strand** per agent tab plus a
    timeless Drafts shelf, queued cards stacked under the now line in delivery
    order. Cards carry stored tags and derived **auto tags** (agent, model,
    preface commands, blame files, result, state, fence languages — never
    stored), one search over every state that dims rather than hides. **+**
    collects a new draft in place; a draft dragged onto a strand sends now (at
    the now line) or schedules once (in the future band); a scheduled card
    drags up/down to retime, across to move tabs, back to the shelf to
    unschedule; every gesture has a keyboard route from the expanded card.
    **Links** between cards — `related` (a line) and `after` (an arrow: the
    target is queued when the source is delivered, on one tab or across tabs)
    — stored additively as `links[project]` in `agent_prompts.json`, chained
    from `AgentScheduleHost`'s retire step. A card gets a time only by landing
    on a tab: no second scheduling shape, no `planned_at`, no new rule type.
    Four phases (read-only chart → gestures → links → polish); the phone is
    untouched.
    - [x] 🤖 Automated test — `AgentPromptChart` (state derivation, id and
      text-key joins, band grouping, snapping, drop mapping, queue reorder),
      `AgentPromptAutoTags`, `AgentPromptLinks` (pruning, chain resolution,
      missed source fires nothing, closed target is not sent, recurring source
      fires once), `PromptChart` (five states render, filter dims, `+`
      collects, keyboard retime), `AgentScheduleRetire` (chain step), cargo
      link core.
    - [ ] 🖐️ Manual test — open the Agents view on a project with two agent
      tabs, a few collected prompts and some history: the chart shows the
      history above the now line in order, drafts on the shelf; `+` makes a
      draft and it lands in the file; drag it onto a tab at the now line and
      it is queued then delivered; drag another into the future band, confirm
      the rule's time in ◷ Schedules matches the drop, drag it up 10 minutes
      and confirm again; link two drafts with `after`, send the first, and
      confirm the second is queued on delivery and not when the first is
      missed. Check the side panel's compact single-column mode and the Files
      tab's columns.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - **Rework (2026-09-10): one horizontal timeline, real drag-and-drop, the
      agent on the card.** The per-tab columns gave every agent a column's
      width and time a column's width; the chart is now one proportional axis
      across the whole tab — Day / Week / Month with ◀ Today ▶, past left, a
      now line and a now band, future right, drafts on a strip above — with
      the calendar's week start and the view's own snap (5/15/60 min). The
      drag was broken (capture on the card, no `pointermove`, no threshold,
      `elementFromPoint` on release; a click on a scheduled card re-timed it)
      and now follows the board's gesture: a ghost, an indicator at the
      snapped minute, a badge saying what the drop does, and nothing written
      when the gesture ends over nothing. Links are pulled out of a card's
      bottom port onto another card; every draft/scheduled/queued/chained
      card carries an agent picker (a draft's choice persists as the new
      `target` field on the prompt row).
      Built 2026-09-10, **not live-tested**.
      - [x] 🤖 Automated test — `AgentPromptTimeline` (windows per view and
        week start, anchor stepping with the month clamp, x ↔ time and snap,
        tick counts, items incl. recurring expansion and the excluded states,
        lane packing, day clusters, the hit zones, the whole drop matrix),
        `AgentPromptChart` (draft `targetId` from `prompt.target`, stale
        target dropped, chained `chainLink`), `PromptChart` (day/week/month
        switch and Today; a press without movement is not a drop; draft →
        future schedules at the snapped minute; draft → now band and left of
        the now line send; rule → strip unschedules; sent → strip ~~collects~~ writes nothing (since
        2026-09-13, see follow-up below); a
        cancel or a release over nothing writes nothing; port drag links two
        cards; the agent picker on a draft / rule / chained card writes the
        three rows, upsert before delete), `AgentSchedulesView` (queued cards
        at the now line), cargo `upsert_keeps_target_unless_the_editor_names_it`.
      - [ ] 🖐️ Manual test — open the prompt chart on a project with two agent
        tabs. In Day view drag a draft to about 14:30: the ghost follows, the
        badge reads "Schedule · 14:30", and ◷ Schedules on the picked tab shows
        that minute. Drag it back to the strip (rule gone, draft back). Drop a
        draft on the now band (queued at the now line, then delivered). Switch
        to Week and retime a card — it snaps to 15 min. Pull a card's bottom
        port onto another: the dashed preview follows, the arrow lands; send
        the first and confirm the second queues on delivery. Change the agent
        on a draft (check `target` in `agent_prompts.json`), on a scheduled
        card (rule moved to the other tab's ◷), on a chained card (the link's
        target). Month view: a day's lamps open the day. ◀ shows yesterday's
        sent cards on the past side.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - **Follow-ups (2026-09-13/14), not live-tested.** (1) `c24ee4c`: a sent
      card is history — no drag starts on it and every drop zone refuses it
      (the strip's "collect again" drop is gone; the card's button stays); sent
      cards wear the past band's grey, queued cards a dashed border; the
      undefined `--radius-md` token (square corners) points at `--radius`; lane
      height fits a three-line card and the queue column never clips; ports sit
      on left/right edges and links bend horizontally. (2) `5e8b2c8`: the past
      band, grid, now line and drop band are drawn in layers beside the
      scrolling body so they span its full height, with a sticky NOW axis; lanes
      pack newest first; Day/Week fold one session's sent prompts into one
      `PromptSessionCard` with a tick per prompt; bare slash commands and
      `/rename`/`/model` are not adopted. (3) `fad5a09`: Ctrl + wheel steps
      month ⇄ week ⇄ day around the day under the pointer (non-passive
      listener, trackpad deltas accumulate); instants are written by
      `formatTimelineInstant` in the app's language and 12/24 h setting.
      - [x] 🤖 Automated test — `PromptChart`, `AgentPromptTimeline`
      - [ ] 🖐️ Manual test — try to drag a sent card: nothing moves. Scroll a
        busy Day view down: the now line and NOW label stay full-height and
        visible. A session with five sent prompts shows one card with five
        ticks. Ctrl + wheel over the timeline changes the view (the page does
        not zoom). Switch Settings to 12 h → card times follow.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - **Edge commands, Hour view, every typed prompt adopted (2026-09-15),
      not live-tested.** An `after` link carries the target agent's own
      commands (`PromptLink.preface`) — `/clear` between two chained prompts —
      typed as the queued prompt's preface when the chain fires; edited from a
      handle at the edge's midpoint or a card's link rows. A 5-minute Hour
      view below Day. Typed prompts are adopted from a timed read of the
      transcript (`agent_tab_recent_prompts`), so messages sent mid-turn and
      the first prompt after a launch reach the chart at their real time.
      Needs a backend restart.
      - [x] 🤖 Automated test — cargo `an_after_link_carries_commands_and_a_related_one_cannot`,
        `a_prompt_recorded_after_the_fact_keeps_its_time_and_place`,
        `recent_prompts_carry_their_times_and_take_in_mid_turn_messages`;
        `AgentPromptLinks`, `AgentScheduleRetire` (edge commands on the queued
        rule), `AgentPromptTimeline` (hour window, ticks, snap, stepping),
        `AgentPromptAdopt` (timed adoption + old-backend fallback),
        `PromptChart` (Hour button, edge handle → `/clear`, related drops it).
      - [ ] 🖐️ Manual test — after restarting: link two drafts `after`, click
        the dot on the arrow, switch on `/clear`; the arrow reads `/clear` and
        the chained card says so. Send the first: the agent tab receives the
        prompt, then `/clear`, then the second prompt. Click Hour: 5-minute
        grid, ◀ ▶ step an hour, a drop snaps to 5 min. In an agent tab type a
        prompt, then send another while it is still working: both appear on
        the chart at the times they were sent.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - **A `/clear` splits the session card and draws the edge (2026-09-15),
      not live-tested.** A history row's `session_id` is now the LIVE session
      the prompt reached — the backend resolves the tab's launch id through
      the hook's record at write time (`agent_prompts::resolve_live_session`)
      and keeps the launch id as the new `tab_id` — so the prompts after a
      `/clear` (or a `/resume`) fold into a second session card on the same
      strand instead of the first. The hook now also records how the session
      started (`<uid>.src`: startup / resume / clear / compact), and the
      first row under a rolled id gets an edge from the tab's previous row by
      itself: `after` carrying `/clear` when that is what happened, plain
      `related` for a resume (`link_session_roll`, id `roll:<row>`; deleting
      the row takes it). Closed strands are one per gone *tab* now, keyed by
      `tab_id`. Rows written before this carry the launch id and stay where
      they were. Needs a backend restart
      (frozen build: `npm run package:dev`, then relaunch).
      - [x] 🤖 Automated test — cargo
        `a_rolled_session_links_the_new_rows_to_the_tabs_previous_session`,
        `hook_script_lets_only_the_tabs_own_session_move_the_record` (the
        source record), `per_project_live_session_records_are_separate_and_the_newer_one_wins`
        (`read_live_source_in`); `AgentPromptChart` (rows on one strand across
        a `/clear`, closed strand per tab), `AgentPromptAdopt` (a rolled row is
        still the tab's).
      - [ ] 🖐️ Manual test — after restarting: in a Claude tab send a prompt
        from the chart, type `/clear` in the tab, send another. Day view: two
        session cards on the tab's strand, an arrow from the first to the
        second whose midpoint dot reads `/clear`. Send a third: it folds into
        the second card, no new arrow. Close the tab: one grey strand, both
        cards still on it. `/resume` to an older conversation then send: the
        new card is joined by a plain (arrowless) line.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS

    - **Free draft layout and completion-gated sequences (2026-09-15), not
      live-tested.** Free layout remembers each project's card positions;
      ports link drafts with the timeline hidden. Dragging any After member
      schedules only the start and brings its descendants onto the timeline.
      The next prompt waits for an explicit working→done hook pair, stable
      for three seconds; silence and timeouts cannot release it. Hook-free
      agents pause after their first input.
      - [x] 🤖 Automated tests — `AgentPromptDrafts`, `PromptChart`,
        `AgentScheduleQuietTab`, `AgentScheduleRetire`, `AgentTurnHooks`.
      - [ ] 🖐️ Manual test — enable Free layout, move and link three drafts,
        hide/show the timeline, and reopen the chart to check positions.
        Drag the middle card to a future time: all three appear on the chart.
        Use a slow tool and an approval wait on the source, with the next card
        aimed at another tab: it must stay paused until confirmed completion.
        Check `/clear` on the edge runs only after that completion.
    - **One independent rule per tab (2026-09-15):** a tab already holding a
      live rule is not offered to a draft — picker, timeline drop, Send and
      Schedule all point at linking After it instead; a rule keeps its own tab;
      the ◷ Schedules dialog only warns. `occupiedTargets` in
      `lib/agents/prompt/chart`; plan §12.
      - [ ] 🖐️ Manual test — with a rule on the Claude tab, a draft's picker
        must list only the other tabs; drop the draft on the timeline and it
        lands on a free tab; aim a draft at the Claude tab first (before the
        rule exists), add the rule, and the card must show the amber note,
        refuse the drop with the error line, and accept an After link.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - **Nothing is sent that nobody asked to send (2026-09-15), not
      live-tested.** A two-coder pass over the chart's review findings; see
      the #262 QA list. The **backend guards need a restart**
      (frozen build: `npm run package:dev`, then relaunch); the frontend half
      hot-reloads.
      - [x] 🤖 Automated tests — `PromptChart`, `PromptChartSelect`,
        `PromptChartLift`, `PromptCardKeyboard`, `PromptSessionCard`,
        `AgentPromptTimeline`, `AgentPromptTimelineGroup`,
        `AgentPromptTimelineDst`, `AgentPromptLinks`, `AgentPromptChart`,
        `AgentSchedulesStoreGuard`, cargo `agent_tasks` / `agent_prompts`.
      - [ ] 🖐️ Manual test — **selections and the past** (after restarting):
        Ctrl+click two future rules, drag them left of the now line but off
        the band: the badge reads "A selection is sent only from the now
        band", nothing is sent. Drop them on the band: both go. A single draft
        dropped left of the now line is still sent.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **the scheduler got there first** (after
        restarting): schedule a prompt one minute out, start dragging it and
        hold it past its minute until it is delivered, then drop it later on
        the axis: nothing is re-created and the line says "already delivered
        or removed". Press "+ 5 min" on a card rendered before its delivery
        landed: the same. No prompt arrives twice.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **Send on a daily rule**: expand a daily card and
        press Send: the prompt goes once, and the daily rule is still in the
        tab's ◷ Schedules afterwards.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **badge, − 5 min, queued picker, ↑/↓**: carry an
        unaimed draft over the axis with two tabs open: "Schedule on <first
        tab> · time". With no agent tab: the blocked "No agent tab open — use
        Send". A card due in 3 min has "− 5 min earlier" greyed out. A queued
        card's agent picker refuses another tab with a message. With three
        queued prompts on one tab (Agents view composer), ↑/↓ move a card one
        place in the order the queue column shows.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **links** (after restarting): with A → B (After),
        drag B's port onto A: refused, "That link would make a loop". Add a
        related edge C — B and switch it to After in its editor: "That prompt
        already follows another". Type `/clear` in a Claude tab between two
        sends: its edge is still drawn.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **errors and deletes**: trigger "already has a
        scheduled prompt", then retime any card: the line disappears; trigger
        it again and press Dismiss. Delete a scheduled card that has one link:
        a dialog names the prompt and "1 link"; Cancel keeps it, Delete removes
        it. A session row's Delete asks too; a draft's × does not.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **keyboard**: Tab onto a card (a focus ring),
        Enter opens it, its Link arms linking, Tab to another card's port and
        press Enter: the link is drawn. Arm a link with a selection present and
        press Escape: link mode ends, the selection stays; Escape again clears
        it. Escape inside a card editor cancels the edit and keeps the
        selection.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **drawing and performance**: before 08:00, a daily
        08:00 card in tomorrow's Day view reads tomorrow's date, and When
        "Today" dims it. A session running past midnight in Week view shows
        both dates. On a wide pane the Day axis labels every hour. Edit a
        scheduled card on the timeline: the Markdown toolbar fits (460 px) and
        the lanes do not move. Hide the chart tab while an agent works, show
        it again: its cards are current. Drag a card across the timeline with
        several links on screen: no stutter compared with a lift.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **drafts board and empty states**: in row layout
        the hint does not say "Move cards freely" and carrying a draft over the
        strip shows the blocked "Turn on Free layout…"; in Free layout it says
        "Move here" and moves. ＋ (tooltip "New draft") opens the board's own
        composer, Escape / Ctrl+Enter work. A project with no agent tabs and no
        history shows the empty-timeline hint. Type in the timeline search:
        "N of M" and Clear appear, Clear leaves the drafts search alone. Lift a
        card: "Reset positions" appears and puts it back.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **± 5 min and the wide editor**: in Week and in
        Month view, "+ 5 min later" on a card due in 8 min moves it (no "That
        minute has passed" line); "+ 5 min later" on a queued card moves it 5
        min past now. "− 5 min earlier" on a card due in 30 min is enabled the
        same in Day and Month view. Edit a scheduled card in the right part of
        the axis: the editor grows leftward and its whole Markdown toolbar is
        visible. Carry one draft left of the now line: the now band lights; a
        two-card selection there leaves it dark. Drop a selection on a future
        minute where its earlier card would land in the past: "A card in the
        selection would land in the past".
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **closed strands** (after restarting): send a
        prompt from a Claude tab, close that tab, open a new Claude tab and
        send another: the old rows sit on a greyed closed strand of their own,
        not on the new tab's strand. Relaunch Tabtivity with a resumed Claude tab
        and type `/clear` in it: its rows before and after stay on that tab's
        strand.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **snapping in a :30 zone**: start Tabtivity with
        `TZ=Asia/Kolkata`, drop a draft on the Month view (60-min snap): it is
        scheduled on a local whole hour (e.g. 14:00, not 14:30).
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] 🖐️ Manual test — **DST** (twice a year, Europe/Berlin): on the
        spring-forward and fall-back days, Hour view ◀/▶ step past 02:00 and
        the Day axis draws each hour once.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - Open questions: should yesterday's axis still be a send-now zone for
        a single card? Should a dropped unaimed draft get the new-tab
        `/model` preface? Offer compact Week cards after QA?
      - Follow-up (accessibility, spans the mail list too): a prompt card's
        `<article role="button">` holds real buttons and a dropdown, and ARIA
        makes a button's children presentational, so a screen reader flattens
        Send/Schedule/Link into the card's name. `mail/MailList.tsx` rows do
        the same with their star and actions. Move the role onto a toggle
        element (the card head, or a visually hidden button) on both surfaces
        together, so they do not drift; keyboard access already works.
      - Pending doc: update the `docs/filemap_frontend.md` prompt-chart and
        `PromptDraftBoard` rows once the other session's file-map WIP
        has landed (the rows still say bottom port → top port, and that
        cycles and joins are refused only at schedule time).

263. **Agent panes: double-click pastes, and a drag still selects while the TUI
    holds the mouse.** Two gestures the terminal owed an agent tab. A
    **double-click** at the agent's prompt inserts the clipboard — the press is
    taken away from xterm entirely rather than layered on top of its word-select,
    because copy-on-select would otherwise overwrite the very text being pasted.
    Both paste routes (the gesture and Ctrl+Shift+V) now go through `term.paste`
    instead of a raw PTY write, so a multi-line clipboard arrives inside the
    bracketed-paste markers every agent TUI asks for — one pasted block, not a
    burst of Enters that submits the first line and types the rest into whatever
    it opened. **Copy** stops depending on a chord nobody knows: a full-screen
    agent turns on mouse tracking, after which every press is reported to the
    program and a drag selects nothing, which is what "can't copy out of an agent
    tab" is. In an agent pane a plain drag now selects anyway (the press is handed
    to xterm wearing the force-selection modifier — Shift, Option on macOS), with
    Ctrl left as the escape hatch that still reaches a mouse-driven TUI; the copy
    also flushes on mouse-up instead of waiting out its 60 ms debounce, and holds
    the text it captured, so a repaint under the selection can no longer eat it.
    Agent panes only — a shell tab keeps xterm's word-select and its clicks.
    Frontend only: `lib/terminal/terminalControl.ts`, `components/terminal/TerminalView.tsx`.
    Built 2026-09-07, **not live-tested**.
    - [x] 🤖 Automated test — `TerminalControl` (the gesture decision: paste on a
      double-click, force-select only while the program holds the mouse, never on
      a modified or non-primary press), `AgentPaneMouse` (a double-click pastes
      the clipboard and never reaches the selection service; a plain press is
      forced only under mouse tracking; a shell tab keeps its word-select).
    - [ ] 🖐️ Manual test — in a Claude tab, copy a path elsewhere and double-click
      the pane: the clipboard lands at the prompt and nothing is submitted. Copy a
      multi-line block and double-click again — it arrives as one paste, not as
      several submitted lines. Then drag across some of the agent's output and
      paste it into an editor: it should be there. Repeat both in a Codex tab
      (whose TUI grabs the mouse) and confirm the drag still selects, and that
      Ctrl+wheel zoom, Shift+Tab and the TUI's own scrolling are unchanged.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

264. **Agents view: the last prompt beside each tab, typed in the terminal
    included — and adopted into the prompt chart.** The row under a tab's times
    now says `last prompt: …` whatever route the prompt took: the composer, a
    schedule, or the user's own typing into the terminal, which Tabtivity never
    sees as a prompt (keystrokes reach the PTY, the TUI's input box edits them,
    only the agent knows what was submitted). So it is read from the same
    transcript tail the model tag comes from (`agent_tab_last_prompt` →
    `agent_session_last_prompt`), stepping over everything both CLIs write as
    a user turn that is not one — tool results, meta notes, attached reminders,
    captured `/command` output, Codex's injected context — and reading a slash
    command as `/model opus` and a `!` line with its `!`. Re-read when a tab
    turns busy (a prompt was just submitted) and when it finishes. A prompt that
    *changed* at a turn's start was typed, and `lib/agents/prompt/adopt` records it
    on the prompt history as delivered to that tab — the row the chart draws a
    sent card from — unless the tab's newest history row already says it, so a
    composer or scheduled send is never recorded twice; the first read of a tab
    is a baseline, never a record. An agent whose transcript Tabtivity cannot read
    (Gemini, Qwen, Codex 0.153.4 whose thread store keeps no messages, a custom
    command) gets the prompt echoed on the pane's own screen instead
    (`lib/agents/prompt/echo` over `lib/terminal/terminalRegistry`, parsed by the phone's
    own `readableScreen`/`inputFrameStart`/`chatTurns`, so a draft still being
    typed is never taken for a prompt). Built 2026-09-07, **not live-tested**; the Rust side is uncompiled on
    the GNOME host (no toolchain) — CI compiles it.
    - [x] 🤖 Automated test — `agent_session::the_last_prompt_is_what_the_user_said_not_what_the_cli_told_itself`
      (Claude: plain, multi-line, tool result, meta, reminder, captured stdout,
      interrupt, `/model opus`, `! git status`, image paste; Codex: typed event,
      injected context, `AGENTS.md`; dialect mismatch; the one-line bound),
      `AgentSchedulesView` (the row shows the prompt the backend read),
      `AgentPromptAdopt` (dedupe against the newest row, cut prompts, label
      fallback; the busy edge records a changed prompt, not the first read, not
      one the composer sent), `AgentPromptEcho` (the last echo on a screen, not
      the draft in the input box, not a select dialog; the store falls back to
      it when the transcript has nothing).
    - [ ] 🖐️ Manual test — open the Agents view beside a Claude tab and type a
      prompt into the tab itself: within a moment the row reads `last prompt:
      <what you typed>` (hover for the whole text), and the prompt chart (⧗)
      shows a sent card for it under that tab. Send one from the composer: the
      row updates, the chart shows exactly one card for it. Type `/model` in the
      tab: the row reads `last prompt: /model`. Then a `!` line: `last prompt:
      ! …`. In a Codex tab on 0.153.4 and in a Gemini tab, type a prompt: the
      row shows it a moment after the agent starts answering (from the screen
      echo); while you are still typing, the row must NOT change.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

265. **Agent CLI version drift: what is installed vs. what Tabtivity was verified
    against.** Tabtivity reads other people's CLIs at a level of detail that only
    holds for the release someone sat down and checked — a `--resume` flag, a
    session-log key, the numbered rows of an approval menu, the two steps of a
    `/model` sheet. Those checks were recorded in prose
    (`docs/third_party_update_checklist.md`: "*verified against Claude Code
    2.1.251*"), which is exactly the form nothing can compare against. On the
    machine this was built on, `claude` was already at 2.1.263 — twelve patch
    releases past the note, unnoticed — and `codex` had **three** different
    baselines recorded across two files (0.151.0, 0.153.0, 0.153.4). Built
    2026-09-07, **not live-tested**; the Rust side is uncompiled here (no
    toolchain on the GNOME host) — CI compiles it.
    - **The notes now exist as data.** `services::agent_versions::VERIFIED` holds
      one row per *check*, not per agent: Codex's three surfaces keep their three
      releases, because the oldest of them is the weakest assumption Tabtivity
      rests on and collapsing them to one number would throw away the only part
      that says where to look. Re-verifying means bumping the row **and** the
      prose note in one commit.
    - **Only recipes run against a real binary are listed.** `VERSION_ARGV` has
      three entries (`claude`, `codex`, `copilot`), each carrying what it
      actually printed as its comment — the same refusal `WARMUPS` and
      `agent_usage::RECIPES` make. An agent with no recipe reports *unknown*
      rather than having `--version` guessed at it, because a wrong flag opens a
      TUI on a null stdin. Adding one is: run it, paste the output, add the line.
    - **Installed but unchecked is its own answer.** An agent with a recipe and
      no `VERIFIED` row reports *unverified* — "nobody has checked this one",
      which is true and useful, instead of a green tick that is neither.
    - **Reported, never enforced.** Nothing updates a CLI, nothing refuses to
      launch one. Drift is what explains an agent tab misreading an approval
      prompt or a mode line; it is a chip and an amber line in Manage Agents, and
      a dismissal is keyed by *version*, so the notice returns on the next
      release rather than never.
    - **Costs nothing to look at.** Only installed agents are probed, at most
      once a day (`PROBE_TTL`), concurrently, 5s timeout, stdin null, own process
      group, `kill_on_drop`; `<state_dir>/agent_versions.json` is a cache, and
      deleting it costs one re-probe.
    - **The headless half is the point.** `cargo run --example agent_versions
      --manifest-path src-tauri/Cargo.toml` prints installed-vs-verified and
      exits non-zero on drift, so the checklist's "did anything move?" is one
      command without a window.
    - [x] 🤖 Automated test — Rust: the three verified version-line shapes parse
      (including `copilot`'s trailing commit hash, which must not), a bare number
      and a changelog line are refused, `0.153.10 > 0.153.9` (the whole reason
      not to compare strings), drift names every stale check oldest-first, an
      *older* install is drift too, a note for an agent with no recipe is
      rejected outright, stdout/stderr/exit-code handling, ANSI + bound, and a
      dismissal that survives a re-probe but not a new version.
      `AgentVersionDrift.test.tsx`: opening the panel never forces a probe
      (re-check is the only caller allowed to), the notes render weakest-first,
      dismissal sends the version the user saw, a matching release says nothing,
      an unsupported CLI says so instead of offering a re-check.
    - [ ] 🖐️ Manual desktop QA — open Settings → Manage Agents: each installed
      CLI shows its version; Claude and Codex show the amber "not the one Tabtivity
      was verified against" line naming the stale sections, Copilot shows
      "no note yet records which release", an agent with no recipe says nobody
      has checked it. Click Dismiss on one and confirm the warning goes while the
      version stays; reopen the panel and confirm it stays dismissed. Click
      Re-check and confirm the version is re-read.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

266. **A copy out of a terminal says so.** Copy-on-select worked, and read as
    "select/copy is broken" (user, 2026-09-13): under an agent TUI the highlight
    a drag leaves is wiped by the program's next repaint within milliseconds,
    and no route — drag, Shift+drag, Ctrl+Shift+C — announced the copy. Every
    user-made copy now goes through one `copyToClipboard` in `TerminalView` that
    writes the clipboard and, once the write resolved, shows the same transient
    toast the OSC 52 path uses: "Copied 3 lines to the clipboard" / "Copied 42
    characters to the clipboard" (`terminal.copiedLines` / `terminal.copiedChars`).
    A refused write (no window focus) shows nothing. The selection highlight on
    the two dark grounds (`soft_dark`, `dark`) is one step brighter so it reads
    through the TUI's own tinted blocks. Frontend only, hot-reloads. Built
    2026-09-13, **not live-tested**.
    - [x] 🤖 Automated test — `AgentPaneMouse` (a drag's release copies the
      text and sets the toast with the line count, a one-line selection with
      the character count; a refused clipboard write sets no toast).
    - [ ] 🖐️ Manual test — in a Claude tab, drag across some output: the toast
      at the top says how many lines were copied and a paste elsewhere has
      them. Shift+drag and Ctrl+Shift+C (after a Shift+drag) do the same. In a
      shell tab the same three routes announce too. In soft_dark, the highlight
      is visible over Claude's dimmed blocks while it lasts.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

267. **`claude update` works from a fenced agent tab.** The fence bound the
    agent's own install read-only — `~/.local/bin` from the allowlist and
    `~/.local/share/claude/versions/` from the launcher's symlink chain — so
    `claude update` and Claude's background auto-update failed on `EROFS` in
    every agent tab (user, 2026-09-13: "must be doable from the agent tabs").
    `agent_fence::updatable_install_dirs` recognises the native-installer
    layout (a link in `~/.local/bin` into `~/.local/share/<tool>/`) and hands
    exactly `~/.local/bin` and `~/.local/share/<tool>` back read-write, on
    Linux as later bind mounts that shadow the allowlist's read-only one and on
    macOS as `writable` entries of the Seatbelt profile. An npm/nvm or
    package-managed install stays read-only. Deliberate widening, documented in
    `docs/context/agent_authority.md`. Backend only — needs a restart. Built
    2026-09-13, **not live-tested**.
    - [x] 🤖 Automated test — `agent_fence` (the native layout yields the
      launcher dir then the install root, never `versions/`; an nvm-style
      install and a `~/.local/bin` link pointing elsewhere yield nothing; a
      later read-write bind of `~/.local/bin` comes after the allowlist's
      read-only one in the bubblewrap argv).
    - [ ] 🖐️ Manual test — after a restart, in a Claude tab run
      `! touch ~/.local/share/claude/versions/.probe && rm ~/.local/share/claude/versions/.probe`
      (no "Read-only file system"), then `! claude update` when a newer
      release exists: it installs, `! readlink ~/.local/bin/claude` names the
      new version, and a tab opened afterwards runs it. Confirm a shell tab's
      view of `~/.local/bin` is unchanged and that `~/.nvm` (if present) is
      still read-only from the agent tab.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

837. **Meta's Muse Code joins the agent registry.** `muse` installs from Meta's
    own one-liner into `~/.local/bin` (verified against `dev.meta.ai/install.sh`);
    no Windows installer, so Windows gets the docs link. Launch-only like Kimi and
    Qoder: a Muse tab does not restore and cannot be scheduled — its resume
    (`muse resume --last`) and one-shot (`muse exec`) modes are documented only
    by third parties, and `WARMUPS` takes a documented recipe or nothing. Files:
    `commands/agents.rs`, `components/tabs/newTabItems.ts`, `lib/usageMetrics.ts`.
    Implemented 2026-09-14 (`b011bb6`), **not live-tested; backend change.**
    - [x] 🤖 Automated test — `CustomAgents`
    - [ ] 🖐️ Manual test — Agents panel: Muse Code shows an install card; the
      one-click install opens a tab and puts `muse` in `~/.local/bin`; the new-tab
      menu then offers Muse and it launches. Relaunch Tabtivity → the Muse tab is not
      resumed (expected).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

838. **Working / done marks come from the agent's own hooks.** The byte heuristic
    could not survive every agent TUI (Codex paints a spinner and its title on a
    timer whether it works, waits or idles, and while thinking changes one timer
    digit a second — so after the braille/empty-frame filters a working Codex
    never lit). The hook script now also serves `UserPromptSubmit`, `PostToolUse`,
    `Notification` (Claude) and `SessionEnd`, writes `live_sessions/<uid>.turn`,
    and `services::agent_turn` relays it as `agent-turn` by PTY id; the activity
    store takes that as authority (retired by an interrupt key, by input on a
    decision, by 20 s without paint, by respawn) and keeps a sharper byte fallback
    (paint vs. text, 1.5 s text gap, keystroke-echo suppression) for hookless
    agents. Files: `services/agent_turn.rs`, `services/agent_session.rs`,
    `commands/terminal.rs`, `stores/activity.ts`, `TerminalView.tsx`,
    `AppShell.tsx`. Implemented 2026-09-15, **not live-tested; backend change
    (restart needed; Codex needs `/hooks` re-trust for the four new hooks).**
    - [x] 🤖 Automated test — `AgentTurnHooks`, `PillRunningIndicator`,
      `agent_session::tests::hook_script_records_the_turn_state_for_the_tabs_own_session_only`
    - [ ] 🖐️ Manual test — after a restart: (1) in a Claude tab send a prompt,
      switch to another tab — its bar/ring shows working within a second, and
      finished when the answer lands; look at it → the finish clears. (2) Ask
      Claude for something that needs a permission → the decision lamp lights
      (also while the tab is on screen); answer → it clears and working resumes.
      (3) Same in a Codex tab (after trusting the hooks via `/hooks`): working
      while it thinks (only its timer moves), an approval menu → decision, and
      idle Codex with its dot field is neither. (4) Press Esc mid-turn → working
      clears within a second. (5) Type a long prompt slowly → no working glow.
      (6) A Gemini/Qwen tab (no hooks) still shows working/finished off its bytes.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - **Fix (2026-09-15): scheduled prompts to different tabs no longer wait on
      each other.** Two prompts due at 12:35 on two Claude tabs: the first went
      at 12:35:01, the second only at 12:37:12, after a hook event happened to
      land. Cause: `TerminalView` stamped **everything** xterm emits through
      `onData` as the user's input — including the focus in/out reports, mouse
      tracking and cursor-position / attribute replies the terminal sends by
      itself — and the delivery gate (new that morning) reads any input after a
      Stop as a turn in flight, waiting for a Stop that no submission was going
      to bring. So a tab that was merely clicked into could not receive a
      scheduled prompt until its next real turn ended. Now: `isTerminalAutoReply`
      keeps those out of the stamp (they still reach the PTY); a real keystroke
      holds delivery only for the 20 s a submission needs to be reported by the
      hook (`INPUT_SUBMIT_GRACE_MS`), after which an abandoned draft or an arrow
      key holds nothing; and a tab whose agent fires no hooks (Gemini, Qwen,
      custom) falls back to its bytes — after a keystroke's grace before a
      delivery, and after 30 s of quiet (`HOOKLESS_DONE_QUIET_MS`) after one —
      instead of never being deliverable again. Files: `lib/terminal/terminalControl.ts`,
      `TerminalView.tsx`, `stores/activity.ts`, `AgentScheduleHost.tsx`.
      Frontend only, hot-reloads; **not live-tested**.
      - [x] 🤖 Automated test — `AgentScheduleParallelTabs` (two tabs, a
        stale keystroke, a hook-free second delivery), `AgentTurnHooks` (the
        grace), `TerminalControl` (`isTerminalAutoReply`).
      - [ ] 🖐️ Manual test — two Claude tabs, both idle after a finished turn.
        Click into tab B, then back to A. From the prompt chart drop one draft
        on each tab at the now line: both prompts land within a tick (15 s),
        B's without waiting for A's turn to end. Then send a prompt to A, and
        while A works schedule one for B: B receives it at once. Type half a
        prompt into an idle tab and leave it: a prompt sent to that tab arrives
        after ~20 s, not never. In a Gemini tab send two prompts in a row from
        the chart: the second arrives ~30 s after the first answer goes quiet.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - **Feature (2026-09-16): a background job keeps the tab working.** A Claude
      turn that ends with a `run_in_background` shell still running (or a Codex
      exec left open) used to light "finished" while the job ran on.
      `services::agent_turn` now holds that `done` back as `working` while a tool
      shell carrying the tab's `TABTIVITY_TAB_UID` is alive (read from
      `/proc/<pid>/environ` — the agent sits under the tmux server, not the PTY),
      re-sends it every 8 s so the store's 20 s silence rule does not retire it,
      and sends `done` within ~2 s of the last one exiting. Scheduled prompts wait
      for it too. Linux only; container and remote agents keep the plain verdict.
      A job that never ends (a dev server) keeps the tab working for as long as it
      runs. File: `services/agent_turn.rs`. Backend change, **restart needed; not
      live-tested**.
      - [x] 🤖 Automated test — `agent_turn::tests` (`a_live_tool_shell_carrying_the_uid_holds_the_done`,
        `only_the_agents_own_tool_shells_count_as_background_jobs`, …)
      - [ ] 🖐️ Manual test — after a restart, in a Claude tab: "run `sleep 60` in
        the background and stop". The turn ends, yet the tab stays working
        (ring/bar) for the minute, then shows finished within a few seconds of
        the sleep ending. A normal turn with no background job still finishes at
        once. Kill the background shell from Claude early → finished follows.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS

    - **Feature (2026-09-18): six CLIs joined the registry, four rows were
      corrected, three were retired.** Added Droid (Factory), Auggie (Augment),
      Kilo Code, Continue.dev (`cn`), JetBrains Junie and CodeBuddy (Tencent);
      fixed the `grok` row (it installed the third-party `@vibe-kit/grok-cli`,
      not xAI's own Grok Build), Kiro's executable (`kiro-cli`), Kimi's
      installer path and Amp's npm package; retired Mentat, gpt-engineer and
      the OpenHands CLI, all archived or unmaintained upstream. Files:
      `commands/agents.rs`, `components/tabs/newTabItems.ts`,
      `stores/tabs.ts`, `services/sandbox.rs`,
      `services/mobile_control/discovery.rs`, `lib/usageMetrics.ts`. Backend
      change, **restart needed; nothing was run live** — every flag, package
      name and install path was read from the vendor's own installer, docs or
      changelog.
      - [x] 🤖 Automated test — `commands::agents::tests`
        (`expanded_agent_registry_keeps_official_commands_and_binaries`,
        `every_warmup_recipe_names_a_registry_agent_and_puts_the_message_last`),
        `src/__tests__/agents/CustomAgents.test.ts`
      - [ ] 🖐️ Manual test — Settings → Agents lists the six new cards and no
        longer lists Mentat/GPT Engineer/OpenHands; an installed Kiro finally
        reports as installed; installing Grok yields `grok --version` 1.0.x
        (xAI), not 0.0.34. Open a Droid tab, send a prompt, restart Tabtivity: the
        tab comes back on `droid --resume` with its conversation.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
      - [ ] **Open follow-ups.** The five launch-only newcomers have verified
        `--continue`/`--resume` flags but unmapped session stores — wiring one
        means finding its store, mounting it in
        `sandbox::CONTINUE_AGENT_SESSION_STORES` and only then adding it to
        `RESUMABLE_AGENTS`, or a restored tab exits on "no conversation to
        continue". None of the six is in `services::remote_agents::RECIPES`
        (no auto-install on a remote spawn) or in the phone's Focus parsers
        (`docs/mobile_focus_cli_survey.md`), and only Droid passes the mobile
        `discovery::resumable` gate.

2334. **Terminal copy survives a busy agent and rejoins wrapped lines.** "Copying
    from terminal is always a big mess" / "copying in agent tabs wasn't very
    stable" (user, 2026-09-25). Four causes, all fixed:
    - xterm clears the selection — and drops a drag in progress — on every
      "mouse tracking on" escape, even one that changes nothing; agents and tmux
      send these while they work. `installMouseModeGuard`
      (`lib/terminal/terminalSelection.ts`) drops no-op ones and holds a real
      change back until the button is up.
    - The copy ran on a 60 ms timer after the release, outside the click
      WebKit's clipboard API needs; it now runs inside the release.
    - Shell tabs sit in a `mouse on` tmux, so a plain drag went to tmux's
      copy-mode, not the clipboard; every pane now forces xterm's own
      selection (agent panes already did; a shell tab's double-click still
      selects a word, and Ctrl+click still reaches the program).
    - OSC 52 copies (tmux copy-mode, a CLI's copy command) arrive with PTY
      output, which the webview refuses — silently, yet the toast said
      "copied". They now go through the backend `copy_text_to_clipboard`
      (arboard), and the toast waits for it.
    The copied text rejoins wrapped rows (`copyableSelection`): a row filled to
    the last column joins as-is, a TUI word wrap with a space; blank rows, list
    items, `⏺`/`⎿` markers and box frames keep their breaks; an Alt-drag
    column selection is copied as drawn. Built 2026-09-25, **not live-tested**;
    the OSC 52 half needs a backend rebuild.
    - [x] 🤖 Automated test — `TerminalSelection` (row joins; the guard against a
      real xterm, including the repeated-mode bug itself), `TerminalControl`
      (shell panes force the selection), `commands::clipboard` (text size cap).
    - [ ] 🖐️ Manual test — in a Claude tab, drag across a long paragraph while
      the agent is still writing: the highlight does not vanish mid-drag, and a
      paste elsewhere is one line per paragraph. In a shell tab,
      `python3 -c "print('x'*300)"`, drag, paste: one line of 300 x's.
      `printf '\e]52;c;%s\a' "$(printf hello | base64)"` in a focused shell
      tab shows the toast and pastes `hello`.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
2335. **Agents live only in Tabtivity: Tabtivity-owned homes, one login per CLI,
    fence-only, and a Host session (implemented 2026-09-25, never run live).** "cursor cli needs
    login for every new tab … it is also the fence … same probably for mistral
    and antigravity (that makes the fence useless as everyone will turn it off)"
    (user, 2026-09-25). Cause: the fence mounts `--tmpfs $HOME` (`bwrap_args`,
    `services/agent_fence.rs:1317`) and restores only Claude/Codex/Gemini/
    OpenCode auth; Cursor's `$XDG_CONFIG_HOME/cursor/auth.json` and Vibe's
    `~/.vibe/.env` never arrive (`sandbox::CONTINUE_AGENT_SESSION_STORES` carries
    only their session dirs), and a login done *inside* a fenced tab lands in the
    tmpfs and dies with it. Target end state (user): all agents live only in
    Tabtivity. Decided with the user: fence is the only mode; login once per CLI,
    shared across projects; `~/.cache` throwaway; import copies credentials
    only; deleting a project deletes its agent home; a shell-typed agent is
    fenced too; unfenced work goes through an explicit Host session.
    - **Phase 1 — a persistent home per scope (Linux).** `<state_dir>/agent-homes/
      <project_key(scope)>/` (`storage::project_key`; `root` and `box:<id>` get
      their own), bound over `$HOME` in place of the tmpfs, `--tmpfs $HOME/.cache`
      on top. Per scope, not per CLI: a fenced agent in project A must not plant
      an MCP server/hook/skill that runs in project B or in root (which holds the
      root MCP token) — the threat-model gap 7 class. Every CLI in a scope shares
      the same roots, so one home per scope adds no authority. Precedents:
      `copilot_auth::prepare_home`, `sandbox::codex_state_dir` (not
      `sandbox-stage`, which is wiped at startup). Mount order otherwise
      unchanged (extra_ro, mounts, symlinks, roots, cargo masks,
      `guard_git_control`, `mask_private_state` last); the state dir sits under
      `$HOME`, so the mask's explicit re-mounts keep other scopes' homes
      unreachable. Gotchas: bwrap now creates mount points on disk inside the
      home; a `--symlink` target a CLI replaced by rename makes the next spawn
      fail EEXIST — clear every symlink destination before spawn, as
      `prepare_codex_state_in` does for `config.toml`. `forget_project` /
      `delete_archived_project` (`commands/projects.rs:988,1289`) delete the
      scope's home. Project containers get the same home as `-v <home>:<home>`
      (`sandbox.rs` create args ~318–356; fingerprint change recreates each once).
    - **Phase 2 — one login per CLI.** New `auth_paths` field on `AgentSpec`
      (`commands/agents.rs:15`), filled from the survey table below. Each path is
      bound from `<state_dir>/agent-auth/<cli-id>/` into every fenced scope home,
      so a login made anywhere (including inside a fenced tab) sticks everywhere.
      Rules: (1) only credential files that cannot name a command — never a
      config that can hold MCP/hooks (so Claude's `~/.claude.json` stays
      per-scope, seeded with the filtered `oauthAccount` like
      `staged_claude_json_mounts` does today; `.credentials.json` is shared);
      (2) directory binds where the dir holds only auth, else the stable-inode
      mirror of `sandbox::claude_credential_mounts` (CLIs rotate tokens by rename,
      which a file bind pins); (3) account-swap guard: record the account at
      first login where the file names one and block + warn on change (as the
      Copilot adoption rule does). A CLI without `auth_paths` still works, one
      login per scope. Fence env: set `TBH_CREDENTIAL_BACKEND=file` (Muse —
      keychain write fails, no fallback), `FACTORY_DISABLE_KEYRING=1` (Droid
      throws when a host `auth.v2.keyring` exists), `GOOSE_DISABLE_KEYRING=1`,
      `GEMINI_FORCE_FILE_STORAGE=true`, `QWEN_CODE_FORCE_FILE_STORAGE=true`,
      `QODER_FORCE_FILE_STORAGE=true`,
      `PYTHON_KEYRING_BACKEND=keyring.backends.fail.Keyring` (Vibe; not
      `null`, which drops writes silently); leave `DBUS_SESSION_BUS_ADDRESS`
      unset (agy waits ~5 s probing it); keep hostname/username stable (Gemini/
      Qwen encrypted stores key on them — bwrap does not unshare UTS today).
      Never set Amp's `nativeSecretsStorage` (keyring-only, deletes the file).
      Copilot persists a headless login only with `"storeTokenPlaintext": true`
      in `~/.copilot/config.json` — **open:** may Tabtivity seed that in its *own*
      scope home (arguably not "another app's config" any more), or does the
      user answer `y` once?
    - **Where each CLI keeps its login** (Linux; survey 2026-09-25, bundles
      grepped/run under scratch HOME). Plain files under `$HOME` for all 30:
      claude `~/.claude/.credentials.json` (+`~/.claude.json`); codex
      `~/.codex/auth.json`; agy `~/.gemini/antigravity-cli/antigravity-oauth-token`;
      gemini `~/.gemini/oauth_creds.json`; kiro `$XDG_DATA_HOME/kiro-cli/
      data.sqlite3`; cline `~/.cline/data/settings/providers.json`; cursor
      `$XDG_CONFIG_HOME/cursor/auth.json`; copilot `~/.copilot/config.json`;
      droid `~/.factory/` (`auth.v2.*`); grok `~/.grok/auth.json`; qwen
      `~/.qwen/oauth_creds.json`; openclaw `~/.openclaw/` (SQLite); auggie
      `~/.augment/session.json`; kilo `$XDG_DATA_HOME/kilo/kilo.db`; cn
      `~/.continue/config.yaml`; junie `~/.junie/secure_credentials.json`;
      codebuddy `~/.local/share/CodeBuddyExtension/Data/Public/auth/`; goose
      `~/.config/goose/secrets.yaml`; pi `~/.pi/agent/auth.json`; plandex
      `~/.plandex-home-v2/auth.json`; amp `~/.local/share/amp/secrets.json`;
      aider `~/.aider/oauth-keys.env` / `.env`; opencode `~/.local/share/
      opencode/auth.json`; vibe `~/.vibe/.env`; sweagent project `.env` only;
      mini `~/.config/mini-swe-agent/.env`; crush `~/.local/share/crush/
      crush.json`; kimi `~/.kimi-code/credentials/`; qodercli `~/.qoder/`
      (+`.auth`); muse `~/.config/muse/auth.json`. Several mix auth with config
      (cn `config.yaml`, qwen `settings.json` env block, crush, aider `.env`)
      and need rule (1) checked per entry before sharing.
    - **Phase 3 — Tabtivity-owned installs.** Run each `install_cmd` with
      `HOME=<state_dir>/agents/install`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`,
      `UV_TOOL_DIR`/`UV_TOOL_BIN_DIR` pointed there; verify per installer and
      add a per-entry override where one ignores them. Mount the tree read-only
      into every fence, run updates outside it (`DISABLE_AUTOUPDATER` where a CLI
      has one). Closes the "agent can replace its own CLI" residual; retires
      `updatable_install_dirs`, `native_launcher`, `private_launcher_dir`
      (#861). Keep detecting host installs until the user reinstalls.
    - **Phase 4 — import credentials only.** One click copies the host's files at
      each CLI's `auth_paths` into `agent-auth/<cli-id>/` (host → Tabtivity is the
      safe direction). Instructions, skills and MCP entries are not imported.
      Logins the host keeps in a keyring (agy ≤1.0.0, Junie, Goose, Vibe, Droid)
      cannot be imported — log in once in Tabtivity.
    - **Phase 5 — fence-only.** Drop the per-project/global "fence off"
      (`fence_effective`, the Settings toggle); `FenceDecision::NotApplicable
      { reason: "off" }` goes. **Shell tabs:** today never fenced
      (`docs/context/agent_authority.md:171`), so typing `cursor-agent` in a
      shell, or in a persistent agent tab's fallback login shell, runs it
      unfenced with the real home. Put one shim per registry CLI in
      `agent_bin::bin_dir()` (read-only in the fence) at the front of shell
      tabs' PATH; the shim asks Tabtivity for the fence argv over the channel
      `tabtivity-send` already uses and execs it in place — same scope home, same
      shared login as an agent tab. It only launches Tabtivity-installed CLIs and
      has no bypass flag; running the binary by absolute path stays possible
      (the user's own shell, real home, no Tabtivity logins — not an escape, fences
      cannot write the real home). **macOS:** Seatbelt cannot redirect, so set
      `HOME=<scope home>` with pass-throughs `GIT_CONFIG_GLOBAL`, `CARGO_HOME`,
      `RUSTUP_HOME`, `DOCKER_CONFIG` (ssh reads `~` from passwd). **Windows:**
      no fence; tabs use the same Tabtivity homes and shared logins via
      `HOME`/`USERPROFILE`.
    - **Phase 6 — Host session.** For work that is not a project's: repairing
      Firefox, the printer, the machine. A fence cannot do it (bubblewrap sets
      no-new-privs, so `sudo`/`pkexec` fail). An explicit, per-tab entry in the
      root console, warned ("unfenced — full access to this computer"), red
      badge, never a project default. Own home `<state_dir>/agent-homes/host/`,
      never mounted into a fence; fenced tabs cannot reach it (state-dir mask),
      so nothing fenced can plant config it runs. Never auto-resumes after a
      restart (a paused "Resume?" instead), cannot be started from the phone.
      Uses the shared logins (credential files only, rule (1)). The CLI's own
      permission prompts apply; Tabtivity injects no mode. Later, optional: a fenced
      tab with one extra path granted for that tab (e.g. `~/.mozilla`).
    - **What goes away** once the host home is out of the loop:
      `CLAUDE_UNMOUNTED`, `CODEX_UNMOUNTED`, `GEMINI_*`, `AGENT_READ_ONLY`,
      `staged_config_mounts`, `CONTINUE_AGENT_SESSION_STORES` (they protect the
      host's uncontained CLI); the AGENTS.md hook exception to "never edits
      another app's config" (hooks are registered in Tabtivity's own homes). **Stays:**
      read-only `state_dir/hooks` and `agent_bin`, per-scope `live_sessions`,
      local-model control files, and treating everything Tabtivity parses back from
      a home as attacker-controlled (transcripts, Codex SQLite, Copilot adoption).
    - **Gaps found in review (2026-09-25).**
      - *X11 blocks Phase 6.* Fenced tabs still reach the host's abstract X11
        socket with `DISPLAY` set (group O #2321, unaudited). With XTEST a
        fenced agent could type into the Host session's window (unfenced,
        `sudo` works) or any user shell, which bypasses the whole design. Close
        #2321 (no `DISPLAY`/X11 socket in the fence, or a nested/filtered
        display) before the Host session ships.
      - *Shared login = shared attack surface.* In Phase 2 every fenced scope
        can write the shared credential file. Swapping in a token for an
        attacker-owned account makes every scope, and the Host session if it
        shares logins, send its conversations there. The swap guard (rule 3)
        covers this only for CLIs whose auth file names an account; the rest
        stay open. Needed: a guard for those too (e.g. the host copy is written
        only from a Tabtivity-driven login, fenced writes stay per scope until
        confirmed), or those CLIs log in per scope.
      - *Hard links vs rename.* The Phase 1 draft (`services/agent_home.rs`,
        untracked) says logins are **hard-linked** in from `agent-auth/`. CLIs
        rotate tokens by rename, which breaks a hard link: the scope keeps the
        new token, the store keeps the old one, and sharing silently stops
        (the stale-token bug `sandbox::claude_credential_mounts` already fixed
        once). Follow rule (2): directory binds or the stable-inode mirror.
      - *Host session logins.* Given the swap risk above, the Host session
        should not bind the shared stores writable. Either it gets its own
        logins, or it only reads a shared login that the guard has confirmed.
      - *Token confidentiality is not a goal.* The network stays shared, so
        any fenced agent can read and send out the shared token of its CLI.
        Today that exposure is per CLI per machine too; state it in
        `docs/threat_model.md` rather than implying the homes fix it.
    - **Docs/tests to update:** AGENTS.md invariants (fence-only, shell shims,
      Host session, hook exception), `docs/context/agent_authority.md`,
      `docs/threat_model.md`, `docs/help/agent-clis.md`, filemap rows. Tests
      that assert the tmpfs home or the narrowed mounts:
      `bwrap_argv_orders_home_mounts_roots_and_command` and the other
      `bwrap_args` callers and the mask test (`agent_fence.rs`), container
      HOME/`-v` assertions, `staged_config_mounts_copies_and_shadows_host_originals`,
      the `GEMINI_STAGED` and `agent_home_mounts_*` tests (`sandbox.rs`). New:
      symlink-destination clearing, scope-home isolation, auth-store binding
      and swap guard, install env, shim routing, Host-session home isolation.
    - **Open:** Copilot `storeTokenPlaintext` seeding (above); the swap guard for
      CLIs whose auth file names no account; whether the Host session should
      share logins at all (see the review gaps above).
    - **Implemented 2026-09-25** (all six phases, Linux; macOS/Windows halves
      written but not compiled here): `services::agent_home` (scope homes,
      one-time seeding of the legacy `codex-state`/`copilot-home`, the scope's
      Claude transcripts and `.claude.json` identity; deleted with the
      project), `services::agent_auth` (per-CLI store, hard links, keeper,
      swap guard, import, sign-out, keyring-off env), `AgentSpec.auth_paths`
      for all 30 CLIs, `services::agent_install` (install HOME + prefixes,
      PATH, read-only in the fence, `DISABLE_AUTOUPDATER` for Claude, legacy
      mirror migration), `services::agent_shim` + shims in `agent_bin`
      (`tabtivity --agent-shim`, `TABTIVITY_SCOPE` on every tab), fence-only
      (`fence_effective`/`policy_*`/"off"/`set_project_agent_fence`, the
      Settings toggle and the pill toggle are gone), `PtyOptions.host_session`
      + the root console's "Host session — unfenced" group, HOST badge and
      paused Resume card; containers mount the scope home at `$HOME`. Gone
      with the host home: `CLAUDE_UNMOUNTED`, `CODEX_UNMOUNTED`, `GEMINI_*`,
      `AGENT_READ_ONLY`, `staged_config_mounts`, `staged_claude_json_mounts`,
      `claude_credential_mounts`, `CONTINUE_AGENT_SESSION_STORES`,
      `codex_state_dir`, the transcript stage/harvest, `agent_trust.json`,
      `services::agent_creds`, the AGENTS.md hook exception.
      **Still open:** the shim's PATH-strip relies on `paste`/`grep`
      (coreutils; fine on Linux/macOS); Copilot keeps its keyring route
      (`storeTokenPlaintext` is seeded in the scope home, so no `y`); the swap
      guard covers Codex and Claude only (other files name no account);
      per-installer verification of the install prefixes; a login the host
      keeps in a keyring cannot be imported (log in once in Tabtivity); the
      Claude transcript copy on a scope's first spawn can take seconds for a
      big project; a project container on a **Windows** host no longer gets
      the POSIX hook twin (the home's `settings.json` carries the PowerShell
      command), so live-session recording there is lost until a per-container
      registration exists.
    - [x] 🤖 Automated test — `agent_home`, `agent_auth`, `agent_install`,
      `agent_shim`, `agent_bin` shim, `bwrap_argv_orders_home_mounts_roots_and_command`,
      the decision matrix's Host session case, the sandbox transcript-belongs
      test; `AgentFence.test.ts` (2026-09-25, all green).
    - [ ] 🖐️ Manual test — log in to Cursor in a fenced tab of project A; open a
      new Cursor tab in project B: no login. Close all tabs, restart Tabtivity: still
      logged in. Type `cursor-agent` in a project shell: it is fenced (cannot
      write outside the project). Open a Host session: `sudo -v` works.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2336. **One global Tabtivity agent config instead of losing it per project
    (implemented 2026-09-25, never run live).** "instead of loosing it can you
    make it one global tabtivity instead of per project?" (user, 2026-09-25) —
    after #2335 fenced tabs no longer saw the global CLAUDE.md, the RTK hook
    or the Codex MCP config. Decided with the user: keep the per-scope homes
    (gap 7) and add a Tabtivity-wide layer that no agent can write.
    `services::agent_global`: `<state_dir>/agent-global/` (home-shaped) is
    copied into every home at every spawn and merged into
    `.claude/settings.json`, `.claude.json`, `.codex/config.toml`,
    `.gemini/settings.json` with exact take-back through a per-home manifest;
    Settings → Agent fence → Global agent config imports from `~/.claude`,
    `~/.codex`, `~/.gemini` (minus logins, state, folder trust, Tabtivity's own
    hooks) and opens the folder. Rationale: `docs/context/agent_authority.md`.
    **Still open:** a hook script named by an absolute `~/.claude/…` path
    works under the Linux fence (the home sits at the user's home path) but
    not on macOS/Windows, where `HOME` is the scope home's own path; an
    `env` block with API keys in the imported `settings.json` reaches every
    home — intended, but worth knowing.
    - [x] 🤖 Automated test — `agent_global` (merge/take-back for JSON and
      TOML, backup, removal, symlink containment, import filter).
    - [ ] 🖐️ Manual test — Settings → Agent fence → Global agent config →
      Import from this computer; open a new Claude tab in any project: your
      CLAUDE.md applies (ask it) and a Bash call is rewritten by the RTK hook.
      A new Codex tab lists your MCP servers (`/mcp`). Remove a skill in the
      opened folder, open a new tab: it is gone there.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2337. **Terminal copy is reliable, and has right-click and keyboard routes.**
    "Sometimes copy works sometimes not" / "best would be a visual nice mouse
    select or keyboard select of text then right click or auto copy" (user,
    2026-09-28). Three causes and two missing routes:
    - User copies went through the webview's `navigator.clipboard`, which WebKit
      honours only while it still counts the press as a gesture, and it dropped
      some mouse-up copies; a refusal showed nothing. Every user copy now goes
      through the backend `copy_text_to_clipboard` like OSC 52 (webview only as
      fallback) and a refused one says "Couldn't copy" (`terminal.copyFailed`).
    - While the program tracks all motion (tmux / an agent's hover, mode 1003),
      xterm reports every buttonless move to it as user input and clears the
      selection on user input — the highlight vanished as soon as the mouse
      moved. Such moves are held back from xterm while text is selected.
    - Right-click on selected text copies it and clears it (Windows Terminal /
      PuTTY); with nothing selected it still goes to the program.
    - **Ctrl+Shift+X — keyboard select** (`lib/terminal/keyboardSelect.ts`): a
      cursor over buffer + scrollback, Shift/`v` select, `V` lines, Enter/`y`/
      Ctrl+C copy (no selection → the cursor's row), Esc/`q` leave, a legend at
      the bottom of the pane (steering-legend look); starts from an existing
      mouse selection so it can be refined. No key reaches the program in it.
    Documented in `docs/help/keyboard.md` → In terminals. Frontend hot-reloads;
    the backend change is doc comments only. Built 2026-09-28, **not
    live-tested** (pill `terminal.keySelect.title`).
    - [x] 🤖 Automated test — `KeyboardSelect` (walk, word/line/buffer jumps,
      Shift anchors but not for G/$, v/V toggles, copied span, scroll),
      `AgentPaneMouse` (backend copy, webview fallback, failure toast,
      right-click copy + swallowed menu, right-click passthrough, hover guard,
      Ctrl+Shift+X walk/copy/Esc/mouse exit).
    - [ ] 🖐️ Manual test — in a Claude tab, drag across output ten times in a
      row while it works: every drag toasts and pastes. After a drag, move the
      mouse around the pane: the highlight stays. Right-click the highlight:
      toast, highlight gone, no paste into Claude; right-click again pastes.
      Ctrl+Shift+X: legend shows, arrows move a cell cursor, Shift+↑ selects,
      PageUp scrolls back into history, Enter copies and the legend goes; Esc
      leaves without copying; a click leaves too.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2338. **Interrupted marker on agent tabs.** An interrupted turn fires no Stop, so
    after Esc / Ctrl+C an agent tab used to look exactly like an idle one. Now an
    interrupt key that lands on a turn in flight (a `working` or `decision` hook
    verdict, or bytes reading as working for a hookless agent) marks the tab
    **interrupted**: a solid ring and a ■ mark in `--status-interrupted` (the
    theme's danger colour), a bar on the project pill, the hidden-pane chips and
    the popout strip. Like finished it is left off the viewed tab; unlike it,
    looking does not clear it — the agent's next turn does (a `working` or
    `decision` hook, working bytes on a hookless tab, or the session ending).
    Claude's idle notice a minute later (`done`) does not. An interrupt on an
    idle composer (clearing the line) marks nothing. Not rolled into the
    project-level attention glow, not counted in the usage recap. Phone-side
    interrupts are not seen (the phone types into its own tmux client).
    **Across a quit or crash:** a quit SIGKILLs agents, so the tab's
    `<uid>.turn` record keeps the `working`/`decision` its last hook wrote;
    `agent_turn::bind_tab` reads it before clearing it at the respawn and
    `pty_spawn` answers `interrupted: true`, so the restored tab starts out
    marked (`activity.noteTurnCutOff`). Backend part needs a restart. Files:
    `stores/activity.ts` (`interruptedByPty`, `attentionStateClass`),
    `stores/detached.ts`, `TabBar.tsx`, `RootOverlay.tsx`,
    `DetachedCenterPanel.tsx`, `TabLocalityBadges.tsx`, `TabStackChip.tsx`,
    `SidePanel.tsx`, `PillStatusBars.tsx`, `themes.css`, `projects-tabs.css`,
    `files-panel.css`, `services/agent_turn.rs`, `commands/terminal.rs`,
    `TerminalView.tsx`. Implemented 2026-09-28, **not live-tested**.
    - [x] 🤖 Automated test — `AgentTurnHooks` (interrupted cases), `PillRunningIndicator`,
      `agent_turn::tests::a_leftover_record_mid_turn_reads_as_cut_off`
    - [ ] 🖐️ Manual test — (1) In a Claude tab send a prompt, press Esc while it
      works, switch to another tab → the Claude tab's ring and mark show
      interrupted (■), and the project pill has an interrupted bar. (2) Wait
      past a minute → still interrupted (not finished). (3) Go back, type a new
      prompt and send it → the mark clears and working shows. (4) Ctrl+C on an
      idle Claude composer → no mark. (5) Esc on a permission prompt → marked
      interrupted. (6) Same with Codex (Esc mid-turn), and a Gemini tab (bytes
      only). (7) A popped-out agent tab and a tab in a hidden subwindow show the
      same mark. (8) With a Claude tab mid-turn, quit Tabtivity and start it
      again → that tab comes back marked interrupted; a tab that had finished
      comes back unmarked.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

- [~] **Agent conversation as a chat on the desktop** (2026-09-30; ✅ code-complete, ❌ never
  live-verified — `UntestedTag` id `terminal.reader`): the phone's Focus chat
  (its Reader) as an optional view of a desktop Claude / Codex / OpenCode tab — the prompt
  strip's **Chat** switch covers the terminal (still running underneath)
  with the stored conversation (`agent_tab_transcript`, polled while shown)
  and a composer that sends like the prompt box. Files:
  `components/terminal/TerminalReaderView.tsx`, `lib/agents/agentReader.ts`,
  `stores/agents/agentReader.ts`, `lib/agents/readerLive.ts` (live
  question buttons + working row / Stop), a lesson step in
  `lib/lessons.ts` (install-agent), `TerminalPromptStrip.tsx`,
  `TerminalView.tsx`, `subwindows.css`. Not done: opening a subagent's
  conversation, the phone's read-aloud, held prompts.
  - [x] 🤖 Automated test — `TerminalReaderView.test.tsx`
  - [ ] 🖐️ Manual test — (1) In a Claude tab with a few turns, click
    **Chat** on the prompt row → the chat shows prompts right, formatted
    answers left, `/model …` as a rule, day chip and times. (2) Type a prompt,
    Enter → it shows as Sending…, the agent answers, both appear as bubbles
    without the list jumping. (3) Send again while the agent works → queued
    by the CLI, recorded once it takes it. (4) Esc in the box → terminal back
    with keyboard focus; **Chat** again → chat back. (5) Open a new Claude
    tab → it opens as a chat; a Codex tab still opens on its terminal.
    (6) Show earlier turns on a long session keeps the view in place.
    (7) A Gemini tab shows no Chat switch. (7a) Ask Claude for a file
    edit without auto-accept → the permission prompt shows under the chat
    with the file and Yes / Yes-allow-all / No buttons; clicking one answers
    it and the buttons go. (7b) While it works → the working row with its
    timer; Stop interrupts the turn. (7c) Same with Codex's approval prompt. (8) `/clear` in the terminal →
    the Undo-clear card shows over the chat, and the chat follows the
    new conversation.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **Subagents in the chat: list only, and their own working row** (2026-10-01;
  ✅ code-complete, automated tests passing — `TerminalReaderView.test.tsx`,
  `MobileTerminalSubagents.test.tsx`, `agent_transcript` test; ❌ never
  live-verified — pills `terminal.reader.subagentWorking`,
  `mobile.subagent.working`). The desktop chat no longer draws the session's
  subagents as cards (the **Subagents (n)** list above it names them, with
  dots on the ones still at work); a subagent's own chat keeps its cards for
  nested ones. An open subagent still at work shows its own working row
  naming its model (`Haiku is working…`) on the desktop and the phone. The
  backend marks an `agent` entry `running` while Claude's spawn call has no
  result, and each read carries the `model` its records name. Limits: Claude
  only (Codex/OpenCode subagents never show running); a background agent
  (`run_in_background`) returns at once, so it reads as finished.
  - [x] 🤖 Automated test
  - [ ] 🖐️ Manual test — backend changed: `npm run backend:stale`, and the
    phone needs `npm run mobile:bundle` + a rebuilt binary. In a Claude tab
    on Chat, ask for two parallel Explore agents with a Haiku model. (1) No
    subagent cards in the chat; **Subagents (2)** list has working dots on
    both while they run. (2) Open one → `Haiku is working…` (not Opus)
    under its conversation, with Stop; gone once it reports back. (3) Same
    on the phone's Reader.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [~] **Token stats in the usage recap** (2026-10-01; ✅ code-complete,
  automated tests passing — `token_stats` cargo tests, `TokenStats.test.ts`;
  ❌ never live-verified — pill `stats.sectionTokens`). Plan:
  `docs/token_stats_plan.md`. The recap's **Tokens** section (under Agents)
  shows per CLI fresh in · cache write · cache read · output and the output
  share for the Day/Week/Month window, with a Per model toggle. Derived from
  Claude transcripts and Codex rollouts in the agent homes
  (`services::token_stats`, cache `token_stats.json`); other CLIs say "not
  reported". The first scan of a big history is budgeted, so the recap shows
  "still counting…" and asks again up to five times.
  - [x] 🤖 Automated test
  - [ ] 🖐️ Manual test — Token stats in the recap match `/usage` / `/status`.
    Backend changed: `npm run backend:stale`, then rebuild/restart the window.
    In a fresh Claude tab do a turn or two, then click the header clock (the
    usage recap) → Day: the Claude row's Per model numbers match what `/usage` (Claude)
    reports for that session; same for a Codex tab against `/status`. A
    Gemini/OpenCode tab used today shows "Not reported: …", never 0.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

- [ ] **Token stats for more CLIs** (2026-10-01; follow-up to the item above).
  `services::token_stats` reads only Claude and Codex; add a source per CLI
  (and its name to `SOURCES`) as their records allow, with fixtures:
  - [ ] OpenCode — per-message `tokens` in its storage.
  - [ ] Gemini CLI — `chats/session-*.json` `tokens`.
  - [ ] Copilot, Antigravity (`agy`) and others — check what their session
    records carry before promising a split.

- [ ] **Nested `claude --resume` guard for the Windows hook** (2026-10-03;
  follow-up to 9d949ec2). The POSIX hook refuses a foreign `clear`/`resume`
  start sent by a `claude` with another `claude` above it among the tab's
  processes (`/proc` environ walk, any `*_TAB_UID`); the PowerShell twin in
  `services::agent_session::hook_script_body` takes it, so a `claude -p
  --resume` run from a Windows tab's Bash tool moves the tab's record (Reader
  chat + Changes panel show that run) until the tab's next Stop heals it.
  Windows can't read another process's environment, so the bound has to be
  the process tree instead: one `Get-CimInstance Win32_Process` snapshot
  (Windows PowerShell 5.1 runs the hook — no `Get-Process .Parent`), walk
  `ParentProcessId` from `$PID`, count `claude.exe` ancestors, stop at the
  app's own executable (name baked into the script when it is written), refuse
  at two. Only on a foreign `clear`/`resume`, so the CIM cost stays off the
  common path. A wrong guard refuses the tab's own `/clear` — worse than the
  self-healing gap — so build it only with a Windows box to test on.
  - [ ] 🤖 Automated test — the walk over a canned process table.
  - [ ] 🖐️ Manual test — In a Windows Claude tab, ask the agent to run
    `claude -p "hi" --resume <another session id>` from its Bash tool: the
    Reader keeps showing the tab's own conversation. Then type `/clear` in the
    tab: the Reader follows the new conversation and "Undo clear" is offered.
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows

- [~] **API keys for agent CLIs** (2026-10-04; ✅ code-complete, automated
  tests passing — `agent_api_keys` / `tmux_local` / `launch_prep` cargo tests,
  `AgentApiKeys.test.tsx`, `MobileLaunchOptions`, `MobileSignInTab`; ❌ never
  live-verified — pills `settings.agentApiKeys`, `settings.agentApiKeys.claude`,
  `.gemini`, `.vibe`, `.opencode`, `mobile.signIn.apiKey`). Plan:
  `docs/api_chat_plan.md` Part A. Settings → Agent sandbox → API keys keeps one
  key per provider in the OS keyring and hands it, at spawn, to the CLIs
  switched on there (`services::agent_api_keys`). Backend changed: run
  `npm run backend:stale` and use a rebuilt binary; the phone also needs
  `npm run mobile:bundle`.
  - [x] 🤖 Automated test
  - [ ] 🖐️ Manual test — API key reaches a fenced Claude tab and the CLI runs
    on it. Save an Anthropic key (a spend-limited one), switch on Claude, open
    a NEW local Claude tab: Claude asks "Detected a custom API key" (default
    No) → pick Yes → `/status` shows API-key auth and no Remote Control
    failure notice. `ps -eo args | grep -c <first 12 chars of the key>` finds
    only the grep, and `<state_dir>/tmux-launch/` holds no key. Exit Claude in
    a tmux-persisted (phone-scope) tab: `env | grep -c API_KEY` in the shell
    left behind is 0. C1: `tmux show-options -g update-environment` lists
    the four `<APP>_AGENT_SECRET_*_API_KEY` carriers at 8636–8639 and no
    `ANTHROPIC_API_KEY`; in the Claude tab `env | grep -c AGENT_SECRET` (via
    `!`) is 0 and the key works — repeat in a root-console Host session and
    by typing `claude` into a shell tab (the shim). Switch Claude off → a new
    tab is back on the subscription. Restart: the key is still saved. Lock
    the keyring: Save refuses with the locked message, the rows say "keyring
    locked", Unlock works.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual test — Gemini on a key: save a Gemini key, switch on
    Gemini, open a new Gemini tab, pick "Use Gemini API key" in `/auth`: it
    answers without a Google login.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual test — Mistral Vibe on a key: save a Mistral key, switch
    on Mistral, open a new (cloud) Vibe tab with no `~/.vibe/.env` login: it
    answers. Note which wins when both exist. A local-model Vibe tab gets no
    key (`env` in it via `!env | grep -c MISTRAL` stays 0).
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
  - [ ] 🖐️ Manual test — OpenCode on a key: switch on OpenCode with an
    Anthropic and/or OpenAI key saved, open a new OpenCode tab: those
    providers' models work without `opencode auth login`. Note which wins
    against its own `auth.json`.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS
