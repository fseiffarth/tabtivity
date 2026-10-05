import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settings";
import { useOllamaActivityStore } from "../stores/agents/ollamaActivity";
import { MOBILE_HOST_KEY } from "./brand";

/**
 * The desktop half of "local models from the phone"
 * (`docs/mobile_local_model_control_plan.md`): the sidecar's
 * `DesktopRequest::LocalModels` / `LocalModelMutate`, answered from the Tauri
 * Ollama commands so a load the phone starts shows on every desktop surface
 * (`ollama-load-progress`).
 *
 * The phone may list, load, unload and start — nothing else. This module never
 * names a pull, delete, pause or `load_ollama_model` command; a load goes
 * through `load_installed_ollama_model`, which refuses any name `/api/tags`
 * does not list (the real no-download guarantee). Only error **codes** leave
 * here, never an error's text.
 */

export type LocalServerState = "running" | "starting" | "stopped" | "unreachable" | "not_installed";
export type LocalModelState = "idle" | "loading" | "loaded" | "failed";

export interface MobileLocalModel {
  name: string;
  size: number;
  parameter_size: string | null;
  quantization: string | null;
  state: LocalModelState;
  /** Bytes held while resident; only when `loaded`. */
  loaded_size?: number;
  /** Of those, the bytes on the GPU; only when `loaded`. */
  vram?: number;
  /** Kept resident with no expiry (`keep_alive: -1`); only when `loaded`. */
  pinned?: boolean;
  /** Whole seconds until Ollama unloads it; only when `loaded`. */
  expires_in?: number | null;
  /** The model the phone's ＋ "Local model" group drives. */
  for_tabs: boolean;
  /** An Ollama cloud model: listed, never loaded or unloaded. */
  remote: boolean;
}

export interface MobileLocalModelList {
  server: LocalServerState;
  can_start: boolean;
  start_failed: boolean;
  models: MobileLocalModel[];
}

export type LocalModelAction = { type: "load" | "unload"; model: string } | { type: "start" };

export type LocalModelsResponse =
  | ({ status: "local_models" } & MobileLocalModelList)
  | { status: "error"; code: string; message: string };

/** The fields of the backend's `OllamaModelInfo` read here (snake_case, as the
 *  command serializes them). */
interface OllamaRow {
  name: string;
  size: number;
  parameter_size?: string | null;
  quantization?: string | null;
  running: boolean;
  size_vram: number;
  loaded_size?: number;
  pinned?: boolean;
  expires_in_secs?: number | null;
  remote?: boolean;
}

/** The phone lists at most this many models (the sidecar caps it again). */
const MAX_ROWS = 64;

/** Codes the backend's phone commands refuse with; anything else they fail
 *  with is prose and crosses as `unreachable`. */
const BACKEND_CODES = new Set(["ollama_not_running", "model_not_installed", "model_not_local"]);

/** Fixed English for each refusal. The sidecar forwards only the code; the
 *  message is for the desktop's own logs and never carries an error's text. */
const MESSAGES: Record<string, string> = {
  local_models_disabled: "Local models from the phone are switched off on the desktop",
  ollama_not_running: "Ollama is not running",
  model_not_installed: "That model is not installed",
  model_not_local: "That model runs in the cloud",
  model_loading: "That model is still loading",
  start_unavailable: "Ollama cannot be started from the phone",
  unreachable: "Ollama did not answer",
};

function refusal(code: string): LocalModelsResponse {
  return { status: "error", code, message: MESSAGES[code] ?? MESSAGES.unreachable };
}

/** The host-wide switch. Unset is ON (like `mail_read`); only an explicit
 *  `false` closes it. The sidecar reads the same key per request; this repeats
 *  it so a window is never the way around it. */
export function localModelsAllowed(): boolean {
  return useSettingsStore.getState().settings?.[MOBILE_HOST_KEY]?.local_models !== false;
}

/**
 * Whether `listed` (an `/api/tags` name, always tagged) is the model `wanted`
 * names: exact, or `wanted:latest` for an untagged ref. The backend's
 * `installed_match`, repeated: "untagged" means no `:` in the last path
 * segment, so a registry port (`reg:5000/ns/m`) is not mistaken for a tag —
 * which `introData.sameModel` would. Never a prefix (`qwen3` ≠ `qwen3.5:9b`).
 */
export function isListedModel(listed: string, wanted: string): boolean {
  if (listed === wanted) return true;
  const leaf = wanted.slice(wanted.lastIndexOf("/") + 1);
  return !leaf.includes(":") && listed === `${wanted}:latest`;
}

/** The desktop's load state for a listed model: an entry under its own name
 *  first, then one under any name that means it (a desktop load of `llama3`
 *  reports as `llama3`, not `llama3:latest`). */
function loadStateOf(listed: string, loads: Record<string, "loading" | "error">): "loading" | "error" | undefined {
  if (loads[listed]) return loads[listed];
  const states = Object.entries(loads).filter(([key]) => isListedModel(listed, key)).map(([, state]) => state);
  return states.includes("loading") ? "loading" : states[0];
}

// A Start the phone asked for runs past its answer (it can take 16 s or more);
// these two say how it is going. A window reload loses them — accepted.
let startPending: Promise<void> | null = null;
let startFailed = false;

type Snapshot = { ok: true; rows: OllamaRow[] } | { ok: false; server: LocalServerState };

/** One list read, classified. Every failure becomes a server state — never
 *  text: `not_running` at a local address is stopped (or not installed), and
 *  a remote address, a bad `ollama_host` or a local server answering with an
 *  error is unreachable, which nothing on the phone can fix. */
async function snapshot(): Promise<Snapshot> {
  try {
    const rows = await invoke<OllamaRow[]>("list_ollama_models_detailed");
    return { ok: true, rows: Array.isArray(rows) ? rows : [] };
  } catch (error) {
    const kind = await invoke<string>("ollama_server_kind").catch(() => null);
    if (kind !== "local" || error !== "not_running") return { ok: false, server: "unreachable" };
    const installed = await invoke<boolean>("ollama_is_installed").catch(() => false);
    return { ok: false, server: installed === true ? "stopped" : "not_installed" };
  }
}

function listFrom(snap: Snapshot): MobileLocalModelList {
  if (!snap.ok) {
    const server = startPending ? "starting" : snap.server;
    return {
      server,
      can_start: server === "stopped",
      start_failed: startFailed && server !== "starting",
      models: [],
    };
  }
  startFailed = false;
  const settings = useSettingsStore.getState().settings;
  const tabsModel = settings?.ollama_roles?.tabs ?? settings?.ollama_model;
  const { loads } = useOllamaActivityStore.getState();
  const models = snap.rows
    .filter((row) => typeof row?.name === "string" && row.name !== "")
    .slice(0, MAX_ROWS)
    .map((row): MobileLocalModel => {
      const base = {
        name: row.name,
        size: Number(row.size) || 0,
        parameter_size: row.parameter_size ?? null,
        quantization: row.quantization ?? null,
        for_tabs: !!tabsModel && isListedModel(row.name, tabsModel),
        remote: row.remote === true,
      };
      // Resident wins over the load map, which can be stale.
      if (row.running) {
        return {
          ...base,
          state: "loaded",
          loaded_size: Number(row.loaded_size) || 0,
          vram: Number(row.size_vram) || 0,
          pinned: row.pinned === true,
          expires_in: row.pinned === true ? null : row.expires_in_secs ?? null,
        };
      }
      const load = loadStateOf(row.name, loads);
      return { ...base, state: load === "loading" ? "loading" : load === "error" ? "failed" : "idle" };
    });
  return { server: "running", can_start: false, start_failed: false, models };
}

async function answer(): Promise<LocalModelsResponse> {
  return { status: "local_models", ...listFrom(await snapshot()) };
}

/** `DesktopRequest::LocalModels`. */
export async function localModelsList(): Promise<LocalModelsResponse> {
  if (!localModelsAllowed()) return refusal("local_models_disabled");
  return answer();
}

/** A backend refusal as a code the phone may see. */
function codeOf(error: unknown): string {
  return typeof error === "string" && BACKEND_CODES.has(error) ? error : "unreachable";
}

/**
 * `DesktopRequest::LocalModelMutate`. Load and Start answer at once and run
 * on; the phone follows them by polling the list. Every success answers with
 * a fresh list.
 */
export async function localModelMutate(action: LocalModelAction): Promise<LocalModelsResponse> {
  if (!localModelsAllowed()) return refusal("local_models_disabled");
  const snap = await snapshot();
  if (action.type === "start") {
    // Already running or already starting: nothing to do.
    if (startPending || snap.ok) return { status: "local_models", ...listFrom(snap) };
    if (snap.server !== "stopped") return refusal("start_unavailable");
    startFailed = false;
    startPending = invoke("ensure_ollama_running_unattended")
      .then(() => { startFailed = false; }, () => { startFailed = true; })
      .finally(() => {
        startPending = null;
        void useOllamaActivityStore.getState().fetchModels();
      });
    return { status: "local_models", ...listFrom(snap) };
  }
  if (!snap.ok) return refusal("ollama_not_running");
  const row = snap.rows.find((r) => r.name === action.model) ?? snap.rows.find((r) => isListedModel(r.name, action.model));
  if (!row) return refusal("model_not_installed");
  if (row.remote === true) return refusal("model_not_local");
  const activity = useOllamaActivityStore.getState();
  if (action.type === "load") {
    // The load's own progress events (keyed by the listed name, which `row.name`
    // is) can beat this answer: a model Ollama refuses at once fails in
    // milliseconds. Marking after one has landed would overwrite its "error",
    // or re-add a "loading" its "success" already cleared — and nothing would
    // ever clear that one. So watch the entry while the command runs.
    let heard = false;
    const stopWatching = useOllamaActivityStore.subscribe((state, prev) => {
      if (state.loads[row.name] !== prev.loads[row.name]) heard = true;
    });
    let listed: string;
    try {
      listed = await invoke<string>("load_installed_ollama_model", { model: row.name });
    } catch (error) {
      return refusal(codeOf(error));
    } finally {
      stopWatching();
    }
    // A resident model is only re-pinned, which ends in milliseconds — marking
    // it could land after its own "success" and stick. A real load shows its
    // own events within moments; this covers the gap until the first one.
    if (!row.running && !heard) activity.markLoad(typeof listed === "string" && listed ? listed : row.name, "loading");
    return answer();
  }
  // A load in flight is not cut short — unless the model is already resident,
  // where a "loading" entry is a re-pin or stale. An idle model has nothing to
  // unload.
  if (!row.running) {
    return loadStateOf(row.name, activity.loads) === "loading" ? refusal("model_loading") : answer();
  }
  try {
    await invoke("stop_ollama_model", { model: row.name });
  } catch (error) {
    return refusal(error === "not_running" ? "ollama_not_running" : "unreachable");
  }
  void activity.fetchModels();
  return answer();
}

/** Forget a pending Start between tests. */
export function __resetMobileLocalModelsForTests(): void {
  startPending = null;
  startFailed = false;
}
