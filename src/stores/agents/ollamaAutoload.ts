import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useSettingsStore } from "../settings";
import { energySaverActive, usePowerStore } from "../power";

/**
 * **Load a local (Ollama) model into memory when Tabtivity starts.**
 *
 * A model that is merely *installed* is not usable — the first request pays the
 * whole load, which for a 7B model is tens of seconds. Anything that wants a
 * local model to answer *promptly and unattended* (mail-importance scoring,
 * autocomplete) therefore needs one already resident, and until now the
 * only way to get there was the 🧠 menu's per-model "Load" button, by hand, every
 * launch. `settings.ollama_autoload_models` is that click made persistent.
 *
 * Two rules carry it:
 *
 * - **Energy Saver suppresses it.** A resident model pins GPU/CPU memory and
 *   Ollama keeps it warm, which is the precise kind of standing cost Energy
 *   Saver exists to remove. So the launch run is skipped while it is active —
 *   and the skip is *announced* (the 🧠 menu's notice + "Load now"), because a
 *   silent skip is indistinguishable from the feature being broken. The opt-out
 *   is `settings.ollama_autoload_in_energy_saver`.
 * - **A skip is only announced for what is actually missing.** Not starting a
 *   loader and having no model in memory are two different facts: Ollama is a
 *   separate, machine-wide server, so an armed model can already be resident —
 *   left warm by an earlier session, loaded by hand, or by something that is not
 *   Tabtivity at all. Announcing the skip over the whole armed list then put "Not
 *   loaded at start (deepcoder)" directly above a green-lamped `deepcoder` row
 *   in the same menu, which reads as the UI contradicting itself. So the
 *   decision asks what is resident (`pending`), reports only that remainder, and
 *   says nothing when there is none — and `noteResident` keeps it that way
 *   afterwards, since the notice outlives the launch it describes.
 * - **A skip stays skipped until a click.** Unplugging later does not
 *   retroactively start the models: the run is a launch-time decision the user
 *   was told about, and a load that begins minutes afterwards, unasked, is the
 *   surprise the announcement was meant to avoid.
 *
 * The run is **sequential**: two models loading at once contend for the same
 * VRAM and can push each other back out to CPU, so the second only starts once
 * the first is resident.
 */

/** Where the launch-time decision landed. `skipped` is the Energy Saver case. */
export type AutoloadPhase = "idle" | "loading" | "done" | "skipped" | "error";

/** How long to keep retrying a `not_running` failure, and how often. Starting
 *  Ollama's server and having it accept requests are not the same instant, and
 *  at launch we are usually the first caller after a cold boot. */
const RETRY_ATTEMPTS = 4;
const RETRY_DELAY_MS = 2500;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * Which installed models are resident in Ollama's memory *right now*.
 *
 * A read, never a start: `list_ollama_models_detailed` is `/api/tags` +
 * `/api/ps` over loopback and does not bring the server up, so asking it on the
 * Energy Saver path costs nothing the mode objects to. A server that isn't there
 * answers "nothing is resident", which is exactly true.
 */
async function residentModels(): Promise<string[]> {
  try {
    const all = await invoke<Array<{ name: string; running: boolean }>>(
      "list_ollama_models_detailed",
    );
    return Array.isArray(all) ? all.filter((m) => m?.running).map((m) => m.name) : [];
  } catch {
    return [];
  }
}

/**
 * Warm a given list of models into memory, **one at a time**, reporting after
 * each. Shared by the launch-time autoload and the post-upgrade restore
 * (`stores/agents/ollamaUpgrade`) so the two cannot disagree about what loading a set
 * of models means: same sequencing (two models at once contend for the same
 * VRAM and can push each other back out to CPU), same `not_running` retry (a
 * server that has just been started, or just been *replaced*, accepts requests
 * some seconds after it exists), and same rule that any other error is final.
 *
 * `ensure_ollama_running` first, and a failure there is deliberately not fatal:
 * the server may be reachable but unmanageable (no systemd, a hand-run `ollama
 * serve`), and the loads below produce the real, actionable error if it truly
 * is down.
 */
export async function loadModelsSequentially(
  models: string[],
  onProgress: (loaded: string[], failed: Record<string, string>) => void,
): Promise<{ loaded: string[]; failed: Record<string, string> }> {
  try {
    await invoke("ensure_ollama_running");
  } catch {
    /* fall through to the load, which produces the actionable error */
  }
  const loaded: string[] = [];
  const failed: Record<string, string> = {};
  for (const model of models) {
    let error: string | null = null;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        await invoke("load_ollama_model", { model });
        error = null;
        break;
      } catch (e) {
        error = typeof e === "string" ? e : String(e);
        // Only "the server isn't there yet" is worth waiting out; a model that
        // doesn't exist, or an install missing its runner, fails identically
        // on every retry.
        if (error !== "not_running") break;
        await sleep(RETRY_DELAY_MS);
      }
    }
    if (error === null) loaded.push(model);
    else failed[model] = error;
    onProgress([...loaded], { ...failed });
  }
  return { loaded, failed };
}

interface OllamaAutoloadStore {
  phase: AutoloadPhase;
  /** The models this run is (or was) for — the configured list at the time. */
  models: string[];
  /**
   * What the notice is actually *about*: the armed models that are neither
   * resident already nor loaded by this run. Empty means there is nothing to
   * report, whatever `phase` says — a skip whose models turned out to be in
   * memory anyway is not news, it is a menu arguing with its own model list.
   */
  pending: string[];
  /** Models now resident because of this run. */
  loaded: string[];
  /** Per-model failure text for the ones that did not make it. */
  failed: Record<string, string>;
  /** Set once the launch decision has been taken, so it is taken exactly once. */
  ran: boolean;
  /** The user acknowledged the Energy Saver notice; stop showing it. */
  dismissed: boolean;
  /** Take the launch-time decision: load, or skip and say so. */
  autorun: () => Promise<void>;
  /** Load the configured models now, whatever Energy Saver says. The "Load now"
   *  button behind the skip notice, and the only way out of `skipped`. */
  loadNow: () => Promise<void>;
  /**
   * "These models are in memory now" — from whichever surface just observed it
   * (the 🧠 menu's model list, a load-progress event). Drops them from the
   * outstanding set and from `failed`, so a notice about a model the user has
   * since loaded by hand narrows and then goes away by itself. A no-op when
   * nothing changes, so it can be called on every poll without re-rendering.
   *
   * Deliberately one-way — it only ever *shrinks* the outstanding set. A model
   * Ollama later evicts on its own (keep_alive expiring) does not re-raise a
   * launch-time notice minutes after the fact: same reason a skip stays skipped
   * until a click.
   */
  noteResident: (names: string[]) => void;
  dismiss: () => void;
}

export const useOllamaAutoloadStore = create<OllamaAutoloadStore>((set, get) => ({
  phase: "idle",
  models: [],
  pending: [],
  loaded: [],
  failed: {},
  ran: false,
  dismissed: false,

  autorun: async () => {
    if (get().ran) return;
    set({ ran: true });
    const settings = useSettingsStore.getState().settings;
    const models = settings?.ollama_autoload_models ?? [];
    if (models.length === 0) return; // nothing armed — stay `idle`
    if (energySaverActive() && settings?.ollama_autoload_in_energy_saver !== true) {
      // The skip stands either way — this only decides what there is to say
      // about it. An armed model already warm in the machine-wide server is not
      // something the user is missing, and claiming otherwise beside the row
      // showing it loaded is the contradiction this exists to prevent.
      const resident = await residentModels();
      const pending = models.filter((m) => !resident.includes(m));
      set({ phase: "skipped", models, pending, dismissed: false });
      return;
    }
    await get().loadNow();
  },

  loadNow: async () => {
    const models = useSettingsStore.getState().settings?.ollama_autoload_models ?? [];
    if (models.length === 0) {
      set({ phase: "idle", models: [], pending: [] });
      return;
    }
    set({ phase: "loading", models, pending: models, loaded: [], failed: {}, dismissed: false });

    const { failed } = await loadModelsSequentially(models, (loaded, failedSoFar) =>
      set({ loaded, failed: failedSoFar }),
    );
    // What is left outstanding is exactly what failed: everything else is now
    // in memory, and a notice must not keep naming it.
    set({ phase: Object.keys(failed).length > 0 ? "error" : "done", pending: Object.keys(failed) });
  },

  noteResident: (names) => {
    if (names.length === 0) return;
    const s = get();
    const pending = s.pending.filter((m) => !names.includes(m));
    const failed = { ...s.failed };
    for (const n of names) delete failed[n];
    const failedShrank = Object.keys(failed).length !== Object.keys(s.failed).length;
    if (pending.length === s.pending.length && !failedShrank) return; // nothing moved
    set({
      pending,
      failed,
      // A run whose every failure has since been resolved by hand is done, not
      // failing — the amber `!` on the button has nothing left to point at.
      phase: s.phase === "error" && Object.keys(failed).length === 0 ? "done" : s.phase,
    });
  },

  dismiss: () => set({ dismissed: true }),
}));

/**
 * Take the launch decision once, in the main window only.
 *
 * It waits for two things, and both matter: `settings` (the list lives there)
 * and the power store's first reading (`ready`) — asking "is Energy Saver on?"
 * before any battery state has been read would answer "no" for a laptop on
 * battery and load the models the mode exists to prevent.
 */
export function useOllamaAutoloadOnLaunch(): void {
  const settingsLoaded = useSettingsStore((s) => s.settings !== null);
  const powerReady = usePowerStore((s) => s.ready);
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || !settingsLoaded || !powerReady) return;
    fired.current = true;
    void useOllamaAutoloadStore.getState().autorun();
  }, [settingsLoaded, powerReady]);
}

/** Reset the module between tests. */
export function resetOllamaAutoload(): void {
  useOllamaAutoloadStore.setState({
    phase: "idle",
    models: [],
    pending: [],
    loaded: [],
    failed: {},
    ran: false,
    dismissed: false,
  });
}
