import { create } from "zustand";
import { ollamaVersionStatus } from "../../lib/agents/localDrivers";
import { loadModelsSequentially } from "./ollamaAutoload";

/**
 * **Put the models back after an Ollama upgrade.**
 *
 * Upgrading Ollama replaces the binary and restarts the server, which drops
 * every resident model on the floor. That is invisible until the next request
 * pays a full load — tens of seconds for a 7B model, in whatever tab happened
 * to ask first — and the user's only clue is that the 🧠 menu, which said
 * "loaded" beside two models a minute ago, now says nothing. So the upgrade
 * takes a snapshot of what was in memory and warms exactly that back up once
 * the new server is running.
 *
 * Three things decide the shape of this:
 *
 * - **The upgrade is a terminal tab, not a command we await.** It needs an
 *   interactive sudo/UAC answer (`runInstallInTab`), so there is no completion
 *   callback to hang this on. The signal is therefore *observed*: poll the
 *   local `ollama --version` — no network, see `ollamaVersionStatus(false)` —
 *   and treat a **changed** version string as "the new server is up". A version
 *   that cannot be read at all (the binary is mid-replacement) is not an
 *   answer; the poll simply continues.
 * - **The wait is bounded, and running out is reported.** The user may never
 *   answer the sudo prompt, may close the tab, or may reinstall the same
 *   version — in which case the version never changes and no restart is ever
 *   observed. That ends in `timeout` with a "Reload now" button, never in a
 *   silent give-up and never in a load minutes later that nobody asked for.
 * - **It restores, it does not decide.** The models being reloaded are the
 *   ones the user had loaded thirty seconds earlier, so Energy Saver is
 *   deliberately *not* consulted here: this returns the machine to the state
 *   it was in, and that mode's rule is about the standing cost a *launch*
 *   creates unasked. What it will not do is invent models — an upgrade with
 *   nothing resident starts no watcher at all.
 *
 * Session-scoped on purpose. The snapshot lives in memory, so quitting Tabtivity
 * mid-upgrade forgets it; persisting it would mean a launch that loads models
 * because of something that happened before the last shutdown, which is the
 * surprise this is trying to avoid in the first place.
 */

export type UpgradeRestorePhase =
  | "idle"
  /** The upgrade is running somewhere; we are watching for the new server. */
  | "waiting"
  | "reloading"
  | "done"
  /** At least one model would not load back. */
  | "error"
  /** No restart was ever observed within the window. */
  | "timeout";

/** How often to ask the local binary its version, and for how long. Five
 *  seconds is cheap (a local `ollama --version`) and the upgrade itself takes
 *  minutes: a download, an interactive sudo answer, then a service restart. */
const POLL_MS = 5_000;
const WAIT_TIMEOUT_MS = 15 * 60_000;

let pollTimer: number | null = null;
let deadline = 0;

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

interface OllamaUpgradeStore {
  phase: UpgradeRestorePhase;
  /** What was resident when the upgrade started — the whole point of the store. */
  models: string[];
  /** The version we are waiting to see *change*. */
  from: string;
  loaded: string[];
  failed: Record<string, string>;
  dismissed: boolean;
  /**
   * Called by the upgrade click, with the version being replaced and the models
   * resident at that moment. A snapshot of nothing is a no-op: there is nothing
   * to put back, so nothing watches and nothing is announced.
   */
  begin: (from: string, models: string[]) => void;
  /** Reload the snapshot now, without waiting for (or having seen) a restart. */
  reloadNow: () => Promise<void>;
  /** Stop watching and forget the snapshot. */
  cancel: () => void;
  dismiss: () => void;
}

export const useOllamaUpgradeStore = create<OllamaUpgradeStore>((set, get) => ({
  phase: "idle",
  models: [],
  from: "",
  loaded: [],
  failed: {},
  dismissed: false,

  begin: (from, models) => {
    stopPoll();
    if (models.length === 0) {
      set({ phase: "idle", models: [], from, loaded: [], failed: {}, dismissed: false });
      return;
    }
    set({ phase: "waiting", models, from, loaded: [], failed: {}, dismissed: false });
    deadline = performance.now() + WAIT_TIMEOUT_MS;
    pollTimer = window.setInterval(() => {
      if (get().phase !== "waiting") {
        stopPoll();
        return;
      }
      if (performance.now() > deadline) {
        stopPoll();
        set({ phase: "timeout" });
        return;
      }
      void ollamaVersionStatus(false)
        .then((v) => {
          // A blank reading is the binary being replaced under us, not an
          // answer — keep waiting. Only a *different*, readable version means
          // the thing now on disk is a new server.
          if (!v.current || v.current === get().from) return;
          if (get().phase !== "waiting") return;
          stopPoll();
          void get().reloadNow();
        })
        .catch(() => {});
    }, POLL_MS);
  },

  reloadNow: async () => {
    stopPoll();
    const models = get().models;
    if (models.length === 0) return;
    set({ phase: "reloading", loaded: [], failed: {}, dismissed: false });
    const { failed } = await loadModelsSequentially(models, (loaded, failedSoFar) =>
      set({ loaded, failed: failedSoFar }),
    );
    set({ phase: Object.keys(failed).length > 0 ? "error" : "done" });
  },

  cancel: () => {
    stopPoll();
    set({ phase: "idle", models: [], loaded: [], failed: {}, dismissed: false });
  },

  dismiss: () => set({ dismissed: true }),
}));

/** Reset the module between tests. */
export function resetOllamaUpgrade(): void {
  stopPoll();
  useOllamaUpgradeStore.setState({
    phase: "idle",
    models: [],
    from: "",
    loaded: [],
    failed: {},
    dismissed: false,
  });
}
