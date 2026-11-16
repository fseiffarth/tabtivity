import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { ollamaVersionStatus } from "../../lib/agents/localDrivers";
import { loadModelsSequentially } from "./ollamaAutoload";

/**
 * **Finish an Ollama upgrade: restart a server it left behind, and put the
 * models back.**
 *
 * Upgrading Ollama replaces the binary, but whether the *server* restarts is
 * up to the installer: the Linux script restarts its systemd unit, while
 * Windows' silent winget upgrade can leave the old `ollama serve` running —
 * the new version is on disk and nothing runs it. And a restart, either way,
 * drops every resident model on the floor, invisible until the next request
 * pays a full load. So the upgrade click starts a watcher that restarts a stale
 * server and warms exactly the snapshot of resident models back up.
 *
 * Four things decide the shape of this:
 *
 * - **The upgrade is a terminal tab, not a command we await.** It needs an
 *   interactive sudo/UAC answer (`runInstallInTab`), so there is no completion
 *   callback to hang this on. The signal is therefore *observed*: poll the
 *   local `ollama --version` — no network, see `ollamaVersionStatus(false)` —
 *   and treat a **changed** installed version as "the upgrade landed". A
 *   version that cannot be read at all (the binary is mid-replacement) is not
 *   an answer; the poll simply continues.
 * - **A stale server is restarted only once it stays stale.** The same read
 *   says which version the running server answers with. One reading of the old
 *   one may be an installer still about to restart it, so it takes two polls in
 *   a row before `restart_ollama_server` runs — otherwise the two would race
 *   for the port. The upgrade click is the consent: upgrading means running the
 *   new server, and the installer on Linux restarts it just the same. A
 *   restart that fails is reported with a retry, never swallowed.
 * - **The wait is bounded, and running out is reported** when there is
 *   something to retry. The user may never answer the sudo prompt, may close
 *   the tab, or may reinstall the same version — the version then never
 *   changes. With models in the snapshot that ends in `timeout` with a "Load
 *   back now" button; with none it simply stops watching.
 * - **It restores, it does not decide.** The models reloaded are the ones the
 *   user had loaded moments earlier, so Energy Saver is deliberately *not*
 *   consulted: this returns the machine to the state it was in. It will not
 *   invent models — an empty snapshot restarts the server and loads nothing.
 *
 * Session-scoped on purpose. The snapshot lives in memory, so quitting Tabtivity
 * mid-upgrade forgets it; persisting it would mean a launch that restarts or
 * loads because of something that happened before the last shutdown.
 */

export type UpgradeRestorePhase =
  | "idle"
  /** The upgrade is running somewhere; we are watching for the new version. */
  | "waiting"
  /** The new version is installed and the old server is being restarted. */
  | "restarting"
  /** The restart failed; `restartError` says why, and it can be retried. */
  | "restart_failed"
  | "reloading"
  | "done"
  /** At least one model would not load back. */
  | "error"
  /** No new version was ever observed within the window. */
  | "timeout";

/** How often to ask the local binary its version, and for how long. Five
 *  seconds is cheap (a local `ollama --version`) and the upgrade itself takes
 *  minutes: a download, an interactive sudo answer, then a service restart. */
const POLL_MS = 5_000;
const WAIT_TIMEOUT_MS = 15 * 60_000;
/** Polls in a row the server must answer with the old version before it is
 *  restarted — room for an installer that restarts it itself. */
const STALE_POLLS = 2;

let pollTimer: number | null = null;
let deadline = 0;
let stalePolls = 0;

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

interface OllamaUpgradeStore {
  phase: UpgradeRestorePhase;
  /** What was resident when the upgrade started — loaded back afterwards. */
  models: string[];
  /** The version we are waiting to see *change*. */
  from: string;
  /** The version the upgrade installed, once seen. */
  to: string;
  /** Why the restart failed: a backend code (`ollama_remote`,
   *  `ollama_still_running`) or its message. */
  restartError: string;
  loaded: string[];
  failed: Record<string, string>;
  dismissed: boolean;
  /**
   * Called by the upgrade click, with the version being replaced and the models
   * resident at that moment. Watches even with no models: the server may still
   * need restarting. Nothing installed to compare against is a no-op.
   */
  begin: (from: string, models: string[]) => void;
  /** Restart the server (again), then load the snapshot back. */
  restartNow: () => Promise<void>;
  /** Reload the snapshot now, without waiting for (or having seen) a restart. */
  reloadNow: () => Promise<void>;
  /** Stop watching and forget the snapshot. */
  cancel: () => void;
  dismiss: () => void;
}

export const useOllamaUpgradeStore = create<OllamaUpgradeStore>((set, get) => {
  // The upgrade has landed and nothing needs restarting: load the snapshot
  // back, or — with nothing to load and nothing restarted — say nothing.
  const finish = async (restarted: boolean) => {
    if (get().models.length > 0) await get().reloadNow();
    else set({ phase: restarted ? "done" : "idle" });
  };

  return {
    phase: "idle",
    models: [],
    from: "",
    to: "",
    restartError: "",
    loaded: [],
    failed: {},
    dismissed: false,

    begin: (from, models) => {
      stopPoll();
      stalePolls = 0;
      const base = { from, to: "", restartError: "", loaded: [], failed: {}, dismissed: false };
      if (!from) {
        set({ phase: "idle", models: [], ...base });
        return;
      }
      set({ phase: "waiting", models, ...base });
      deadline = performance.now() + WAIT_TIMEOUT_MS;
      pollTimer = window.setInterval(() => {
        if (get().phase !== "waiting") {
          stopPoll();
          return;
        }
        if (performance.now() > deadline) {
          stopPoll();
          // Only a snapshot has something to retry; an empty one just stops.
          set({ phase: get().models.length > 0 ? "timeout" : "idle" });
          return;
        }
        void ollamaVersionStatus(false)
          .then((v) => {
            // A blank reading is the binary being replaced under us, not an
            // answer — keep waiting. Only a *different*, readable version means
            // the upgrade landed.
            if (!v.current || v.current === get().from) return;
            if (get().phase !== "waiting") return;
            set({ to: v.current });
            const stale = !!v.server && v.server !== v.current;
            if (stale && ++stalePolls < STALE_POLLS) return;
            stopPoll();
            void (stale ? get().restartNow() : finish(false));
          })
          .catch(() => {});
      }, POLL_MS);
    },

    restartNow: async () => {
      stopPoll();
      set({ phase: "restarting", restartError: "", dismissed: false });
      try {
        await invoke("restart_ollama_server");
      } catch (e) {
        set({ phase: "restart_failed", restartError: typeof e === "string" ? e : String(e) });
        return;
      }
      await finish(true);
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
      set({ phase: "idle", models: [], restartError: "", loaded: [], failed: {}, dismissed: false });
    },

    dismiss: () => set({ dismissed: true }),
  };
});

/** Reset the module between tests. */
export function resetOllamaUpgrade(): void {
  stopPoll();
  stalePolls = 0;
  useOllamaUpgradeStore.setState({
    phase: "idle",
    models: [],
    from: "",
    to: "",
    restartError: "",
    loaded: [],
    failed: {},
    dismissed: false,
  });
}
