import { invoke } from "@tauri-apps/api/core";

/**
 * A coding agent that can be pointed at the active local (Ollama) model —
 * OpenCode, Pi, Claude Code, Codex, Droid, OpenClaw, Cline. Mirrors the backend's
 * `LocalDriverInfo`.
 */
export interface LocalDriverInfo {
  id: string;
  label: string;
  /** The only field a menu needs: offer this entry, or don't. */
  available: boolean;
  /**
   * Set when the agent is installed and wireable and the *model* is what stops
   * it — it has no `tools` capability. Distinct from plain unavailability
   * because the two have different fixes ("install the agent" vs. "pick another
   * model"), and only this one is worth a sentence in the menu.
   */
  needs_tools_unsupported: boolean;
  /**
   * This agent wraps every turn in a large system prompt built for a frontier
   * model, so it may answer badly on a local one however well the model does on
   * its own. Renders as a caution beside the entry and **never** hides it:
   * `available` is the only field that withholds a row.
   *
   * It is a property of the agent, not of the model, and there is no probe for
   * it — which is the whole reason it is a caution rather than a gate. The
   * measurement behind it is in `list_local_drivers`' Rust doc: `qwen3-coder`
   * answers a bare prompt in 27 tokens through Ollama's own chat endpoint and
   * ran away past 4100 tokens behind Codex's 5128-token harness.
   */
  heavy_harness: boolean;
}

/**
 * The agents that can drive `model`, with the ones it can't drive marked
 * unavailable.
 *
 * Passing the model is what makes this a filter rather than a plain inventory.
 * Every agent here drives its model through **tool calls**, and a
 * completion-only Ollama model (`llama3` is one) cannot serve one at all: the
 * server answers the very first request with `does not support tools`, which
 * surfaces as a raw JSON error inside a terminal tab that then just sits there.
 * Not offering the combination is the fix; the backend refuses again at launch,
 * for the case where the menu was built before the active model changed.
 *
 * The filter is `tools` capability and nothing more, so a model can pass it and
 * still be a poor agent driver — `deepcoder` and `deepseek-r1` both report
 * `tools` and both make `ollama launch` put up its own "does not work well with
 * Claude Code … Launch anyway?" prompt in the tab. That prompt is deliberately
 * left to the user (it is a real PTY, and suppressing it means a blanket `-y`
 * that would also auto-accept an agent-CLI upgrade); see `list_local_drivers`
 * in `commands/ollama.rs` for why the list is not mirrored here.
 *
 * `model` may be null — the backend then skips the filter rather than guessing,
 * and so does a build whose Ollama is down or too old to report capabilities.
 */
export function listLocalDrivers(model: string | null | undefined): Promise<LocalDriverInfo[]> {
  return invoke<LocalDriverInfo[]>("list_local_drivers", { model: model ?? null });
}

/** What an update check found for one installed model (backend `OllamaModelUpdate`). */
export interface OllamaModelUpdate {
  model: string;
  local_digest: string;
  remote_digest: string;
  /**
   * True only when both digests are known and differ. A registry that could
   * not be reached reports `false` *and* an `error` — "couldn't tell" must
   * never render as an update badge, which is a promise the click can't keep.
   */
  update_available: boolean;
  /** Unix seconds the registry published the current manifest, when it says. */
  pushed_at: number | null;
  /** Why this model couldn't be checked, when it couldn't. */
  error: string | null;
}

/**
 * Ask the registry whether any of `models` has a newer published version (all
 * installed models when the list is empty).
 *
 * **On demand only.** This is the one part of the local-model feature that
 * reaches the network without a model being installed or run, so it belongs to
 * a button — never a hover, a timer, or a launch-time sweep. Ollama has no
 * "is there an update" API; the check is a digest comparison, one HEAD request
 * per model against the registry.
 */
export function checkOllamaUpdates(models: string[] = []): Promise<OllamaModelUpdate[]> {
  return invoke<OllamaModelUpdate[]>("ollama_check_updates", { models });
}

/** The installed and newest-published Ollama versions (backend `OllamaVersionStatus`). */
export interface OllamaVersionStatus {
  /** e.g. `"0.14.3"`; empty when Ollama isn't installed or didn't parse. */
  current: string;
  /** e.g. `"0.32.5"`; empty whenever the remote half didn't run or answer. */
  latest: string;
  /** True only when both versions parsed and `latest` is genuinely newer. */
  update_available: boolean;
  /** The one-click upgrade command — the install command, which upgrades in place. */
  install_cmd: string;
  shell_kind: string;
  error: string | null;
}

/**
 * The Ollama **server's** own version — a different thing from a model update
 * and worth its own line, because a server a few minor versions back is missing
 * whole features rather than weights. The case this was built for: `ollama
 * launch` is the only wiring that stands up an Anthropic-compatible endpoint for
 * Claude Code, it does not exist before v0.15, and on an older server that agent
 * is simply absent from the + menu with nothing saying why.
 *
 * `checkRemote: false` touches **no network** — it is a local `ollama
 * --version`, so the menu can show what's installed the moment it opens. `true`
 * is the "Check for updates" click and costs one unauthenticated request.
 */
export function ollamaVersionStatus(checkRemote: boolean): Promise<OllamaVersionStatus> {
  return invoke<OllamaVersionStatus>("ollama_version_status", { checkRemote });
}

/**
 * Which processor to load a model onto. Three values, not a boolean: `auto` is
 * *Ollama's* decision (it weighs the model against free VRAM and may split the
 * layers across both), while `gpu` and `cpu` are the user's. Deferring to a
 * scheduler and overriding it are not the same act, so they are not the same
 * value — and `auto` stays the default, which is what keeps every existing
 * call site (the autoload store, the settings list) meaning exactly what it did.
 */
export type LoadDevice = "auto" | "gpu" | "cpu";

/**
 * Warm a model into memory and keep it resident, on a chosen processor.
 *
 * `gpu` is a **request, not a guarantee**, and the limit is the whole reason
 * `ollamaGpuStatus` exists beside it: the option only distributes layers across
 * the devices Ollama registered when it *started*, so a server that dropped this
 * machine's GPU at discovery has nothing to offload to and the load still lands
 * on the CPU. No per-request option can undo that — only the server's
 * environment can.
 */
export function loadOllamaModel(model: string, device: LoadDevice = "auto"): Promise<void> {
  return invoke<void>("load_ollama_model", { model, device });
}

export interface OllamaGpuStatus {
  /** This machine has at least one readable GPU. The CPU/GPU choice is gated on
   *  it: with no GPU there is no choice to offer. */
  gpu_present: boolean;
  /** Every GPU here is integrated (maps its pool out of system RAM). Never a
   *  stand-in for `gpu_present` — it is false when there is no GPU at all. */
  integrated_only: boolean;
  /** A model is resident with none of it on the GPU. False when nothing is
   *  loaded: an empty server is not a CPU one. */
  model_on_cpu: boolean;
  /** The installed server still offers `OLLAMA_IGPU_ENABLE`. */
  igpu_flag_supported: boolean;
  /** All of the above line up — this is the integrated-GPU gate rather than an
   *  ordinary out-of-VRAM. The **only** field a notice may be raised on. */
  igpu_dropped: boolean;
  /** The server runs as a systemd unit, so the variable must reach that unit. */
  systemd_service: boolean;
  /** One-click fix for `runInstallInTab`; empty when there is nothing honest to
   *  offer, in which case the UI names the variable instead of running
   *  something that would not help. */
  fix_cmd: string;
  shell_kind: string;
}

/**
 * Whether Ollama is actually using the GPU — and, when it isn't, whether the
 * **integrated-GPU gate** explains it.
 *
 * Ollama ≥0.32 drops integrated GPUs by default and answers on the CPU instead,
 * which on a laptop whose only GPU is the APU silently moves every model off the
 * GPU it used the day before. The only trace in the API is a `size_vram` of 0,
 * which is *also* what a model too large to fit looks like — so the backend
 * requires four facts to line up before `igpu_dropped` is set, and this surface
 * must not second-guess it by raising a notice on any of the others.
 *
 * On demand (a menu opening), never a poll: it spawns processes.
 */
export function ollamaGpuStatus(): Promise<OllamaGpuStatus> {
  return invoke<OllamaGpuStatus>("ollama_gpu_status");
}
