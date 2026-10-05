import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useOllamaAutoloadStore } from "./ollamaAutoload";
import type { OllamaModelUpdate, OllamaVersionStatus } from "../../lib/agents/localDrivers";

/**
 * The session's local-model facts that must outlive either surface showing
 * them — the header's hover dropdown (`layout/LocalModelMenu`) and the Models &
 * agents overlay (`models/ModelsOverlay`). Both render through the same
 * `useModelsHub`, and before this store each of them would have kept its own
 * copy: a download started from the dropdown then never showed in the overlay,
 * and — the one that mattered — an unload done in the overlay never reached the
 * dropdown's model list, so the "one model left → it gets every role" effect
 * (`LocalModelMenu`, which reads `models` from here) silently stopped.
 *
 * Only facts live here, never view state: which surface is open, a row's
 * "Unloading…" flag, the GPU gauges and the agent list stay with their hook.
 */

/** Subset of the backend `OllamaModelInfo` the menu needs (installed models). */
export interface LocalModelInfo {
  name: string;
  parameter_size: string | null;
  quantization: string | null;
  running: boolean;
  /** VRAM bytes in use; non-zero → running on GPU. */
  size_vram: number;
  /** Total size on disk. Roughly what loading it will cost in RAM (or VRAM),
      which is the question the Machine group's meters above are there for. */
  size: number;
  /**
   * Ollama's own capability list. **Empty means "couldn't ask"**, never "none"
   * — see the backend's `model_capabilities`. Hence `lacksTools` tests for a
   * non-empty list that omits `tools`, rather than for the absence of `tools`:
   * an empty list must not mark a model as unable to run agents.
   */
  capabilities?: string[];
}

/** The update check's own outcome — see `checkResult` below. */
export type OllamaCheckResult = { ok: true; updates: number } | { ok: false; reason: string } | null;

interface OllamaActivityState {
  /** Whether Ollama is installed. Written by `LocalModelMenu`'s poll (it is
   *  always mounted in the header); every other surface only reads it. */
  installed: boolean;
  /** Every installed model (from list_ollama_models_detailed). Resident ones are
      selectable as the active local model; the rest can be loaded into memory. */
  models: LocalModelInfo[];
  modelsLoading: boolean;
  /** Why the last list read failed. A code, not a sentence: the hub maps it
   *  through `t()` at render, so a language switch re-words it. */
  modelsError: "not_running" | "failed" | null;
  /** Live pull progress per model ref (from the global `ollama-pull-progress`
      events emitted by `pull_ollama_model`), so downloads started anywhere show
      here too. `pct` is null during the manifest/verify phases (no byte totals). */
  downloads: Record<string, { pct: number | null }>;
  /** Models whose download the user paused this session — each offers
   *  Resume/Delete. An array, not a Set: zustand compares by reference. */
  paused: string[];
  /** Models currently being loaded into memory, keyed by name (from the global
      `ollama-load-progress` events emitted by `load_ollama_model`, so a load
      started anywhere — here or the settings panel — shows here too). Ollama
      streams no load percentage, so this is an indeterminate state, not a pct. */
  loads: Record<string, "loading" | "error">;
  /** The last update check's verdict per model. Empty until the user clicks
      "Check for updates": that is the only thing in the menu that reaches a
      registry, so it never runs on hover, on a timer or at launch. */
  updates: Record<string, OllamaModelUpdate>;
  checkingUpdates: boolean;
  /** The Ollama *server's* version. The installed half is read on every open and
      costs nothing (a local `ollama --version`); `latest` stays empty until the
      same "Check for updates" click that checks the models fills it in. */
  version: OllamaVersionStatus | null;
  /** The update check's own outcome, deliberately NOT the hub's shared `error`:
      that one is rendered *instead of* the model list, so routing a failed
      update check through it replaced every model row with one error line.
      `null` = never checked, which is why "up to date" is a state of its own
      rather than the absence of updates. */
  checkResult: OllamaCheckResult;

  setInstalled: (installed: boolean) => void;
  /** Read the full installed-model list (resident + on-disk). */
  fetchModels: () => Promise<void>;
  markLoad: (model: string, state: "loading" | "error") => void;
  clearPaused: (model: string) => void;
  dropUpdate: (model: string) => void;
  setUpdates: (updates: Record<string, OllamaModelUpdate>) => void;
  setCheckingUpdates: (checking: boolean) => void;
  setCheckResult: (result: OllamaCheckResult) => void;
  setVersion: (version: OllamaVersionStatus) => void;
  /** Fold a fresh *installed-only* version read into the last full check. */
  mergeInstalledVersion: (v: OllamaVersionStatus) => void;
}

const initial = {
  installed: false,
  models: [] as LocalModelInfo[],
  modelsLoading: false,
  modelsError: null as OllamaActivityState["modelsError"],
  downloads: {} as Record<string, { pct: number | null }>,
  paused: [] as string[],
  loads: {} as Record<string, "loading" | "error">,
  updates: {} as Record<string, OllamaModelUpdate>,
  checkingUpdates: false,
  version: null as OllamaVersionStatus | null,
  checkResult: null as OllamaCheckResult,
};

export const useOllamaActivityStore = create<OllamaActivityState>((set, get) => ({
  ...initial,

  setInstalled: (installed) => {
    if (get().installed !== installed) set({ installed });
  },

  fetchModels: () => {
    set({ modelsLoading: true, modelsError: null });
    return invoke<LocalModelInfo[]>("list_ollama_models_detailed")
      .then((all) => {
        set({ models: all });
        // The same reading, handed to the autoload notice: this list is the
        // ground truth for "is it in memory", so a notice still naming a model
        // that is green-lamped two rows below it is fixed here rather than left
        // for the user to reconcile.
        useOllamaAutoloadStore.getState().noteResident(all.filter((m) => m.running).map((m) => m.name));
      })
      .catch((e: unknown) => {
        set({ models: [], modelsError: e === "not_running" ? "not_running" : "failed" });
      })
      .finally(() => set({ modelsLoading: false }));
  },

  markLoad: (model, state) => set((s) => ({ loads: { ...s.loads, [model]: state } })),

  clearPaused: (model) =>
    set((s) => (s.paused.includes(model) ? { paused: s.paused.filter((m) => m !== model) } : s)),

  dropUpdate: (model) =>
    set((s) => {
      if (!(model in s.updates)) return s;
      const n = { ...s.updates };
      delete n[model];
      return { updates: n };
    }),

  setUpdates: (updates) => set({ updates }),
  setCheckingUpdates: (checkingUpdates) => set({ checkingUpdates }),
  setCheckResult: (checkResult) => set({ checkResult }),
  setVersion: (version) => set({ version }),

  // Re-run on every open so an upgrade performed outside Tabtivity shows up,
  // instead of the version frozen at whenever it was first read. The earlier
  // check's `latest` is carried over, but its verdict is **dropped the moment
  // the installed version changes**: that is exactly the case where the user
  // just upgraded, and a notice still offering the upgrade they performed is
  // the one thing this must not do. A fresh click re-establishes it.
  mergeInstalledVersion: (v) =>
    set((s) => {
      const prev = s.version;
      if (!prev?.latest) return { version: v };
      const stale = prev.current !== v.current;
      return { version: { ...v, latest: prev.latest, update_available: !stale && prev.update_available } };
    }),
}));

let listenerRefs = 0;
let registered: Promise<UnlistenFn[]> | null = null;

/**
 * Subscribe the store to the two global progress events. Ref-counted: the first
 * caller registers both `listen()`s, later callers share them, and the disposer
 * that brings the count back to zero waits for the registrations and removes
 * both. Returns that disposer, so `useEffect(() => initLocalModelEvents(), [])`
 * is the whole call site (StrictMode's mount → unmount → mount included).
 */
export function initLocalModelEvents(): () => void {
  listenerRefs += 1;
  if (listenerRefs === 1) {
    registered = Promise.all([
      // Track in-flight downloads regardless of which surface started them.
      listen<{ model: string; status: string; completed: number; total: number }>(
        "ollama-pull-progress",
        (e) => {
          const { model, status, completed, total } = e.payload;
          if (status === "paused") {
            useOllamaActivityStore.setState((s) => {
              const { [model]: _drop, ...rest } = s.downloads;
              return {
                downloads: rest,
                paused: s.paused.includes(model) ? s.paused : [...s.paused, model],
              };
            });
            return;
          }
          useOllamaActivityStore.setState((s) => {
            if (status === "success") {
              const { [model]: _done, ...rest } = s.downloads;
              return { downloads: rest };
            }
            // One event per Ollama NDJSON line, many a second: hand back the same
            // state while the shown whole percent hasn't moved, so no subscriber
            // (the always-mounted header button among them) re-renders for it.
            const pct = total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : null;
            if (s.downloads[model]?.pct === pct) return s;
            return { downloads: { ...s.downloads, [model]: { pct } } };
          });
        },
      ),
      // Track in-flight loads-into-memory regardless of which surface started them.
      listen<{ model: string; status: string }>("ollama-load-progress", (e) => {
        const { model, status } = e.payload;
        useOllamaActivityStore.setState((s) => {
          if (status === "success") {
            const { [model]: _done, ...rest } = s.loads;
            return { loads: rest };
          }
          return { loads: { ...s.loads, [model]: status === "error" ? "error" : "loading" } };
        });
        // Once a model becomes resident, re-read the list so it moves into the
        // selectable (loaded) section.
        if (status === "success") void useOllamaActivityStore.getState().fetchModels();
      }),
    ]);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    listenerRefs -= 1;
    if (listenerRefs === 0 && registered) {
      const pending = registered;
      registered = null;
      void pending.then((fns) => fns.forEach((f) => f())).catch(() => {});
    }
  };
}

/** Reset the store and the listener count between tests. */
export function __resetOllamaActivityForTests(): void {
  listenerRefs = 0;
  registered = null;
  useOllamaActivityStore.setState({ ...initial });
}
