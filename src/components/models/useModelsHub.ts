import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useDialogs } from "../common/PromptDialogs";
import { envName } from "../../lib/brand";
import { useSettingsStore } from "../../stores/settings";
import { useQuiesce, saverInterval } from "../../stores/power";
import { useOllamaAutoloadStore } from "../../stores/agents/ollamaAutoload";
import { useOllamaActivityStore } from "../../stores/agents/ollamaActivity";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useOllamaStatus } from "../../lib/ollamaStatus";
import {
  loadOllamaModel,
  ollamaGpuStatus,
  ollamaVersionStatus,
  type LoadDevice,
  type OllamaGpuStatus,
} from "../../lib/agents/localDrivers";
import { runOllamaUpdateCheck, upgradeOllamaInTab } from "../../lib/agents/ollamaUpdateActions";
import type { GpuSample } from "../../lib/gpu";
import { useT } from "../../lib/i18n";

/** What `clear_local_model_conversations` answers while a tab of the model runs. */
const LOCAL_MODEL_TAB_OPEN = "local_model_tab_open";
/** …when a tab of the model started while the conversations were being
 *  deleted: they are gone, the read-mail mark stays. */
const LOCAL_MODEL_TAB_STARTED = "local_model_tab_started";

/**
 * The open tabs (every scope) of a local model's Mistral Vibe home: a `vibe`
 * tab naming `model` raw, or its alias — the backend's `sanitize_alias`, the
 * home's folder name, which models sharing it share.
 */
export function localModelTabLabels(
  model: string,
  s: { tabs: TabEntry[]; tabsByScope: Record<string, TabEntry[]> } = useTabsStore.getState(),
): string[] {
  const alias = model.replace(/:/g, "-");
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const tab of [...s.tabs, ...Object.values(s.tabsByScope).flat()]) {
    if (seen.has(tab.key) || tab.cmd !== "vibe") continue;
    const env = tab.env ?? {};
    if (env[envName("LOCAL_MODEL")] === model || env.VIBE_ACTIVE_MODEL === alias) {
      seen.add(tab.key);
      labels.push(tab.label);
    }
  }
  return labels;
}

/** The header hover-menu id `LocalModelMenu` registers under. */
export const LOCAL_MODEL_MENU_ID = "local-model";

/**
 * The machine's CPU + memory load (backend `MachineLoadSample`). The GPU half of
 * the same question comes from `gpu_memory_snapshot`; these two are separate
 * commands because the GPU read is cached and instant while this one spans a
 * 300 ms sampling window (a CPU percentage is a ratio of two readings).
 */
export interface MachineLoad {
  supported: boolean;
  cpu_percent: number;
  num_cores: number;
  load_avg: [number, number, number];
  mem_total_bytes: number;
  mem_used_bytes: number;
  swap_total_bytes: number;
  swap_used_bytes: number;
  cpu_temp_c: number | null;
  /** Hottest DIMM, where the board wires an on-module sensor (`jc42`/`spd5118`).
      `null` — the usual answer — is "no sensor", never a cold reading. */
  mem_temp_c?: number | null;
}

/** Machine readings shared by the hover menu and overlay; only poll while visible. */
export function useMachineMeters(active: boolean) {
  const quiesce = useQuiesce();
  /** The machine's GPUs; empty when none can be read, and then no headroom line. */
  const [gpus, setGpus] = useState<GpuSample[]>([]);
  /** The machine's CPU + RAM; null until the first sample, and on a platform
      with no aggregate backend (`supported: false`) the block stays hidden. */
  const [machine, setMachine] = useState<MachineLoad | null>(null);

  // The GPU's own memory AND the machine's CPU/RAM, polled only while the surface
  // is on screen: the question it raises is "will the next model fit, and is
  // there anything left to run it with?" — which each model's `size_vram` (its
  // own share) cannot answer; only the device's free headroom and the machine
  // load can. Both are machine-wide (Ollama is a separate process, so Tabtivity's
  // own figures say nothing about it) and both carry no process table, so a tick
  // is a handful of small reads. They share ONE interval — same cadence, same
  // gating — rather than two timers firing a frame apart for no benefit.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const check = () => {
      void invoke<GpuSample[]>("gpu_memory_snapshot")
        .then((g) => {
          if (!cancelled) setGpus(g);
        })
        .catch(() => {});
      void invoke<MachineLoad>("machine_load_snapshot")
        .then((m) => {
          if (!cancelled) setMachine(m);
        })
        .catch(() => {});
    };
    check();
    const id = window.setInterval(check, saverInterval(2000, quiesce));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, quiesce]);

  return { gpus, machine };
}

/** Subset of the backend `AgentInfo` the menu lists (installed agent CLIs). */
export interface HubAgentInfo {
  id: string;
  label: string;
  bin: string;
  installed: boolean;
}

/**
 * Everything the Models & agents surfaces do, minus their markup — lifted out
 * of `LocalModelMenu` so the hover dropdown and the overlay's Local models tab
 * are two renderings of one set of actions rather than two copies of them.
 *
 * `active` is "this surface is on screen": the dropdown passes its hover-open
 * state, the overlay `open && tab === "models"`. It gates the two costs that
 * used to key off the menu's `open` — the 2 s GPU/machine poll and the
 * once-per-activation GPU-status read (process spawns). The model list, the
 * downloads, loads, update verdicts and the server version live in
 * `stores/agents/ollamaActivity`, so both surfaces show the same facts.
 *
 * `refresh()` is what the dropdown's hover did on every reveal (agents, the
 * model list and the installed Ollama version). The dropdown still calls it
 * from `reveal`; the overlay's Local models tab calls only `refreshModels()`
 * (list + version) when it becomes visible — it shows no agents.
 */
export function useModelsHub(active: boolean) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const quiesce = useQuiesce();
  const installed = useOllamaActivityStore((s) => s.installed);
  const models = useOllamaActivityStore((s) => s.models);
  const modelsLoading = useOllamaActivityStore((s) => s.modelsLoading);
  const modelsError = useOllamaActivityStore((s) => s.modelsError);
  const downloads = useOllamaActivityStore((s) => s.downloads);
  const paused = useOllamaActivityStore((s) => s.paused);
  const loads = useOllamaActivityStore((s) => s.loads);
  const updates = useOllamaActivityStore((s) => s.updates);
  const checkingUpdates = useOllamaActivityStore((s) => s.checkingUpdates);
  const version = useOllamaActivityStore((s) => s.version);
  const checkResult = useOllamaActivityStore((s) => s.checkResult);
  // For the "server stopped" hint under an empty list. The app-wide shared poll
  // (`lib/ollamaStatus`), so a second subscriber costs nothing.
  const status = useOllamaStatus(installed, saverInterval(5000, quiesce));
  const { gpus, machine } = useMachineMeters(active);
  // Installed agent CLIs (from list_agents), shown in the Agents section so the
  // ones already available are visible without opening "Manage agents".
  const [agents, setAgents] = useState<HubAgentInfo[]>([]);
  // The agent CLIs the root MCP server is actually named to at launch
  // (`root_mcp_status`); null until read — and on a backend that predates the
  // field, which then shows no MCP chips rather than guessing.
  const [wiredClis, setWiredClis] = useState<string[] | null>(null);
  // A load / unload / update that failed. Rendered *instead of* the model
  // list, like the list read's own failure (`modelsError`), which it outranks.
  const [error, setError] = useState<string | null>(null);
  // Resident models being unloaded from memory (stop_ollama_model in flight), so
  // the row can show "Unloading…" and disable the control until it settles.
  const [unloading, setUnloading] = useState<Set<string>>(new Set());
  // Whether Ollama can actually use this machine's GPU. Two independent jobs, so
  // it is read once per open rather than polled beside the memory gauges: it
  // gates the per-load CPU/GPU choice (`gpu_present` — with no GPU there is no
  // choice to offer), and it carries the integrated-GPU diagnosis, which costs
  // process spawns and is therefore not something to pay every two seconds.
  const [gpuStatus, setGpuStatus] = useState<OllamaGpuStatus | null>(null);

  // A fresh list read clears the last action's failure — the one shared `error`
  // the menu used to reset at the top of every read.
  useEffect(() => {
    if (modelsLoading) setError(null);
  }, [modelsLoading]);

  // Whether Ollama is using that GPU at all — read **once per activation**, not
  // on the poll above, because it spawns processes (`systemctl`, `ollama serve
  // --help`) to reach its verdict. The two questions look alike and are not:
  // the poll above asks how full the device is, this asks whether the device is
  // being used, and only the second can be answered wrongly by a setting.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    ollamaGpuStatus()
      .then((g) => {
        if (!cancelled) setGpuStatus(g);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active]);

  const fetchModels = () => useOllamaActivityStore.getState().fetchModels();

  // Probe the installed agent CLIs (cheap PATH lookups in the backend) so the
  // Agents section can list the ones already available.
  const fetchAgents = () => {
    invoke<HubAgentInfo[]>("list_agents")
      .then((all) => setAgents(all.filter((a) => a.installed)))
      .catch(() => {});
    invoke<{ wired_clis?: string[] }>("root_mcp_status")
      .then((status) => setWiredClis(status.wired_clis ?? null))
      .catch(() => setWiredClis(null));
  };

  // The model list and the installed Ollama version — all the overlay's Local
  // models tab shows, so it calls this alone (the agents it doesn't render).
  const refreshModels = () => {
    if (!useOllamaActivityStore.getState().installed) return; // nothing to list yet — only the install entry shows
    void fetchModels();
    // Local read, no network — safe on a hover, unlike the `latest` half. The
    // merge (`mergeInstalledVersion`) drops a verdict the upgrade made stale.
    ollamaVersionStatus(false)
      .then((v) => useOllamaActivityStore.getState().mergeInstalledVersion(v))
      .catch(() => {});
  };

  // The dropdown's reveal: its Agents section as well as the models.
  const refresh = () => {
    fetchAgents();
    refreshModels();
  };

  const closeHoverMenu = () => useHeaderHoverMenuStore.getState().close(LOCAL_MODEL_MENU_ID);

  // Warm a model into memory and keep it resident. The button reflects progress
  // via the `loads` map (driven by `ollama-load-progress`); we also optimistically
  // mark it loading immediately so the bar shows without waiting for the event.
  //
  // `device` is the row's CPU/GPU choice, offered whenever this machine has a
  // GPU at all. The GPU status is re-read afterwards and not before: a load is
  // the one moment the answer can change, and asking a GPU request to land on
  // the CPU is exactly the case the notice below has to be able to explain.
  const loadIntoMemory = (model: string, device: LoadDevice = "auto") => {
    const store = useOllamaActivityStore.getState();
    store.markLoad(model, "loading");
    setError(null);
    loadOllamaModel(model, device)
      .then(() => {
        void fetchModels();
        ollamaGpuStatus().then(setGpuStatus).catch(() => {});
      })
      .catch((e: string) => {
        useOllamaActivityStore.getState().markLoad(model, "error");
        setError(typeof e === "string" && e === "not_running" ? t("localModel.notRunning") : t("localModel.failedToLoadModel"));
      });
  };

  // "Clear conversations": the model's stored Vibe conversations and its
  // read-mail mark, together (gap 33 follow-up (c)). Refused while a tab of the
  // model is open — its context may hold mail — naming those tabs; the
  // backend refuses on its own while one still runs.
  const { confirmAction, showMessage, dialogs } = useDialogs();
  const clearConversations = async (model: string) => {
    const open = localModelTabLabels(model);
    const busyTitle = t("localModel.clearBusyTitle", { name: model });
    if (open.length > 0) {
      await showMessage({ title: busyTitle, body: t("localModel.clearBusyBody", { tabs: open.join(", ") }) });
      return;
    }
    const ok = await confirmAction({
      title: t("localModel.clearTitle", { name: model }),
      body: t("localModel.clearBody"),
      confirmLabel: t("localModel.clearConfirm"),
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke("clear_local_model_conversations", { model });
      await showMessage({
        title: t("localModel.clearDoneTitle", { name: model }),
        body: t("localModel.clearDoneBody"),
      });
    } catch (e) {
      await showMessage(
        e === LOCAL_MODEL_TAB_OPEN
          ? { title: busyTitle, body: t("localModel.clearBusyRunning") }
          : e === LOCAL_MODEL_TAB_STARTED
            ? {
                title: t("localModel.clearMarkKeptTitle", { name: model }),
                body: t("localModel.clearMarkKeptBody"),
              }
            : { title: t("localModel.clearFailedTitle", { name: model }), body: String(e), error: true },
      );
    }
  };

  // Evict a resident model from memory (keep_alive=0) without deleting it from
  // disk. Re-reads the model list afterwards so the row drops out of the resident
  // section; the auto-assign effect then re-points tasks if a single model is left.
  const unloadFromMemory = (model: string) => {
    setUnloading((s) => new Set(s).add(model));
    setError(null);
    invoke("stop_ollama_model", { model })
      .then(() => fetchModels())
      .catch((e: string) =>
        setError(typeof e === "string" && e === "not_running" ? t("localModel.notRunning") : t("localModel.failedToUnloadModel")),
      )
      .finally(() =>
        setUnloading((s) => {
          const n = new Set(s);
          n.delete(model);
          return n;
        }),
      );
  };

  // One click, both questions — the models *and* the server they run on
  // (`lib/agents/ollamaUpdateActions`, shared with the Ollama panel).
  const checkUpdates = () => runOllamaUpdateCheck(t);

  // Upgrade Ollama itself, in a visible terminal tab.
  const upgradeOllama = () => {
    if (!version?.install_cmd) return;
    closeHoverMenu();
    upgradeOllamaInTab(
      t,
      version,
      models.filter((m) => m.running).map((m) => m.name),
    );
  };

  // Re-pull a model whose tag now points at a newer manifest. This is an
  // ordinary `pull_ollama_model`, so it rides the existing progress events and
  // the existing pause/resume row — an "update" is a pull, and giving it a
  // second download path would be a second set of bugs. The verdict is dropped
  // as the pull starts: it named the digest we are replacing, so keeping it
  // would leave the row offering an update it is in the middle of applying.
  const updateModel = (model: string) => {
    useOllamaActivityStore.getState().dropUpdate(model);
    invoke("pull_ollama_model", { model })
      .then(() => fetchModels())
      .catch(() => setError(t("localModel.updateFailed")));
  };

  // Pause an in-flight download; the backend keeps the partial blobs and emits a
  // "paused" event that flips the row to Resume / Delete.
  // A refused pause leaves the download running: say so rather than let the
  // rejection go unhandled with the row still showing Pause.
  const pausePull = (model: string) => {
    invoke("pause_ollama_pull", { model }).catch(() => setError(t("localModel.pauseFailed")));
  };

  // Resume a paused download — Ollama continues from the partial blobs.
  const resumePull = (model: string) => {
    useOllamaActivityStore.getState().clearPaused(model);
    invoke("pull_ollama_model", { model }).catch(() => {});
  };

  // Delete a paused download's partial data.
  const deletePausedPull = (model: string) => {
    useOllamaActivityStore.getState().clearPaused(model);
    void invoke("delete_ollama_pull", { model }).catch(() => {});
  };

  const select = (model: string | undefined) => {
    void updateSettings({ ollama_model: model });
    closeHoverMenu();
  };

  // "Load on Tabtivity start": which models are warmed into memory at launch
  // (`settings.ollama_autoload_models`, honoured by `stores/agents/ollamaAutoload`).
  // A chip per model rather than one global switch, because the whole point is
  // that different jobs want different models resident.
  const autoload = settings?.ollama_autoload_models ?? [];
  const toggleAutoload = (model: string) => {
    const next = autoload.includes(model)
      ? autoload.filter((m) => m !== model)
      : [...autoload, model];
    void updateSettings({ ollama_autoload_models: next });
  };

  // Per-task model tags. Each task maps to exactly one model; tagging a model for
  // a task it already owns clears the tag (toggle). Kept open so several tags can
  // be assigned in one pass. Unassigned tasks fall back to the default model.
  const roles = settings?.ollama_roles ?? {};
  const toggleRole = (role: string, model: string) => {
    const next = { ...roles };
    if (next[role] === model) delete next[role];
    else next[role] = model;
    void updateSettings({ ollama_roles: next });
  };
  // Local models are in the root console by default (the opposite of agents:
  // a local model reaches nothing beyond this machine), so what is stored is
  // the models switched OFF there.
  const rootOffModels = settings?.root_excluded_models ?? [];
  // Tools for a local model are opt-in, per model: without the chip a Vibe tab
  // runs with tools off, which is what lets a completion-only model answer at
  // all. With it, a root-console tab gets the root MCP tools (and only those) —
  // wired at spawn by the backend, so it applies to tabs opened afterwards.
  const mcpModels = settings?.ollama_mcp_models ?? [];
  const toggleRootModel = (model: string) => {
    if (rootOffModels.includes(model)) {
      void updateSettings({ root_excluded_models: rootOffModels.filter((m) => m !== model) });
      return;
    }
    // Off in root means off with the tools too (MCP implies Root).
    void updateSettings({
      root_excluded_models: [...rootOffModels, model],
      ollama_mcp_models: mcpModels.filter((m) => m !== model),
    });
  };
  // Lit only with Root on too: a model switched off in root runs nowhere the
  // tools reach.
  const modelMcpOn = (model: string) => mcpModels.includes(model) && !rootOffModels.includes(model);
  const toggleMcpModel = (model: string, on: boolean) => {
    if (on) {
      void updateSettings({ ollama_mcp_models: mcpModels.filter((m) => m !== model) });
      return;
    }
    void updateSettings({
      ollama_mcp_models: [...mcpModels.filter((m) => m !== model), model],
      root_excluded_models: rootOffModels.filter((m) => m !== model),
    });
  };

  const errorText =
    error ??
    (modelsError === "not_running"
      ? t("localModel.notRunning")
      : modelsError === "failed"
        ? t("localModel.failedToLoadModels")
        : null);

  return {
    activeModel: settings?.ollama_model,
    installed,
    status,
    models,
    loading: modelsLoading,
    error: errorText,
    downloads,
    paused,
    loads,
    updates,
    checkingUpdates,
    version,
    checkResult,
    unloading,
    gpuStatus,
    gpus,
    machine,
    agents,
    wiredClis,
    autoload,
    roles,
    rootOffModels,
    refresh,
    refreshModels,
    select,
    loadIntoMemory,
    unloadFromMemory,
    clearConversations,
    /** The clear-conversations dialogs: render where the surface stays
     *  mounted (the hover dropdown closes under a portaled dialog). */
    dialogs,
    checkUpdates,
    upgradeOllama,
    updateModel,
    pausePull,
    resumePull,
    deletePausedPull,
    toggleAutoload,
    toggleRole,
    toggleRootModel,
    modelMcpOn,
    toggleMcpModel,
  };
}

export type ModelsHub = ReturnType<typeof useModelsHub>;

/**
 * The launch-time autoload's one report to the user. The Energy Saver skip is
 * the case this exists for: the models the user armed are deliberately absent,
 * and without a line saying so that is indistinguishable from a broken switch.
 * A failed load is reported for the same reason — nobody is watching at launch.
 *
 * A hook of its own because two places say it: the notice in the model list,
 * and the header button's tooltip and `!` (readable without opening anything).
 */
export function useAutoloadNotice() {
  const t = useT();
  const autoPhase = useOllamaAutoloadStore((s) => s.phase);
  const autoDismissed = useOllamaAutoloadStore((s) => s.dismissed);
  const autoModels = useOllamaAutoloadStore((s) => s.models);
  // What is *outstanding*, which is not the same as what was armed: a model the
  // machine-wide server already holds resident was never missing, and a notice
  // that named it anyway sat directly above that model's own green "loaded" row.
  const autoPending = useOllamaAutoloadStore((s) => s.pending);
  const autoFailed = useOllamaAutoloadStore((s) => s.failed);
  // A phase with nothing left outstanding has nothing to say — silence is the
  // honest report there, not a sentence contradicted by the list under it.
  const show =
    !autoDismissed &&
    ((autoPhase === "skipped" && autoPending.length > 0) ||
      autoPhase === "loading" ||
      (autoPhase === "error" && Object.keys(autoFailed).length > 0));
  const sentence = !show
    ? ""
    : autoPhase === "skipped"
      ? t("localModel.autostartSkipped", { names: autoPending.join(", ") })
      : autoPhase === "loading"
        ? t("localModel.autostartLoading", { names: autoModels.join(", ") })
        : t("localModel.autostartFailed", { error: Object.values(autoFailed)[0] ?? "" });
  return { show, phase: autoPhase, pending: autoPending, sentence };
}
