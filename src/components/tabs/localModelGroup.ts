import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadOllamaModel, ollamaGpuStatus, type LocalDriverInfo } from "../../lib/agents/localDrivers";
import type { TranslationKey } from "../../lib/i18n";
import type { AddMenuEntry, AddMenuGroup } from "./AddTabMenuList";
import { TAB_ACCENT } from "./newTabItems";

/**
 * Where the "tabs" local model sits right now, as far as the "+" menu cares:
 * - `probing` — not asked yet (the menu just opened);
 * - `ready` — resident with layers on the GPU, or resident on a machine that
 *   has no GPU at all (there is nothing better to wait for there);
 * - `cpu` — resident, but none of it on a GPU this machine does have;
 * - `unloaded` — not resident, or Ollama isn't answering.
 *
 * Only `ready` offers the agent rows. An agent on a CPU-resident (or cold)
 * model spends its first minutes loading or crawling through a turn inside a
 * terminal tab that looks hung, so the menu offers the load instead.
 */
export type LocalModelPlacement = "probing" | "ready" | "cpu" | "unloaded";

interface ResidentModel {
  name: string;
  running: boolean;
  size_vram: number;
}

/** `/api/tags` names carry an explicit tag; a setting may omit `:latest`. */
function sameModel(listed: string, wanted: string): boolean {
  return listed === wanted || (!wanted.includes(":") && listed === `${wanted}:latest`);
}

export async function probeLocalModelPlacement(model: string): Promise<LocalModelPlacement> {
  let models: ResidentModel[];
  try {
    models = await invoke<ResidentModel[]>("list_ollama_models_detailed");
  } catch {
    return "unloaded";
  }
  const hit = models.find((m) => sameModel(m.name, model));
  if (!hit?.running) return "unloaded";
  if (hit.size_vram > 0) return "ready";
  // Resident with no GPU bytes. Only now is the (process-spawning) GPU probe
  // worth its cost: without a GPU, CPU is the best this machine can do.
  try {
    return (await ollamaGpuStatus()).gpu_present ? "cpu" : "ready";
  } catch {
    return "cpu";
  }
}

export interface LocalModelPlacementState {
  placement: LocalModelPlacement;
  loading: boolean;
  /** The last load this menu started failed. Cleared by the next attempt. */
  failed: boolean;
  /** Start Ollama if needed and load `model` onto the GPU, kept resident. */
  load: () => void;
}

/**
 * The GPU gate behind the "+" menu's local-model group. Probes only while
 * `active` (the menu is open) — TabBar mounts its menu data for the life of
 * the bar, and residency is only worth a round trip at the moment someone is
 * about to pick. Follows `ollama-load-progress`, so a load started from the
 * 🧠 menu or Settings flips the rows here too.
 */
export function useLocalModelPlacement(
  model: string | undefined,
  active: boolean,
): LocalModelPlacementState {
  const [placement, setPlacement] = useState<LocalModelPlacement>("probing");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const reprobe = useCallback(() => {
    if (!model) return;
    void probeLocalModelPlacement(model).then(setPlacement);
  }, [model]);

  useEffect(() => {
    if (!active || !model) return;
    setPlacement("probing");
    reprobe();
    const un = listen<{ model: string; status: string }>("ollama-load-progress", (e) => {
      if (!sameModel(e.payload.model, model)) return;
      if (e.payload.status === "loading") {
        setLoading(true);
        return;
      }
      setLoading(false);
      reprobe();
    });
    return () => {
      void un.then((f) => f()).catch(() => {});
    };
  }, [active, model, reprobe]);

  const load = useCallback(() => {
    if (!model) return;
    setLoading(true);
    setFailed(false);
    void invoke("ensure_ollama_running")
      .then(() => loadOllamaModel(model, "gpu"))
      .catch(() => setFailed(true))
      .finally(() => {
        setLoading(false);
        reprobe();
      });
  }, [model, reprobe]);

  return { placement, loading, failed, load };
}

/**
 * The "+" menu's local-model group — ONE builder for the main window's
 * `TabBar` and the popout's `NewTabMenu`, which used to carry this block
 * verbatim each.
 *
 * Agent rows appear only once the model is on the GPU (`ready`). Before
 * that, and only when there is some agent it could drive, the group holds a
 * single "load onto GPU" row that stays in the open menu and gives way to the
 * agents when the load lands.
 */
/** The drivers not yet started live, each id spelled out for the untested register. */
const DRIVER_UNTESTED: Record<string, Pick<AddMenuEntry, "untested">> = {
  pi: { untested: "localDriver.pi" },
  cline: { untested: "localDriver.cline" },
};

export function localModelMenuGroup(opts: {
  localModel: string | undefined;
  localModelOffInRoot: string | undefined;
  localDrivers: LocalDriverInfo[];
  vibeForLocalModel: boolean;
  gpu: LocalModelPlacementState;
  onVibe: (model: string) => void;
  onLaunch: (agentId: string, label: string, model: string) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}): AddMenuGroup {
  const { localModel, localModelOffInRoot, localDrivers, vibeForLocalModel, gpu, t } = opts;
  // `heavy_harness` cautions, it never withholds — see
  // lib/agents/localDrivers.ts. The row stays pickable because which local
  // models cope is not something the backend can probe.
  const driverRow = (d: LocalDriverInfo, model: string): AddMenuEntry => ({
    key: d.id,
    label: d.label,
    ...DRIVER_UNTESTED[d.id],
    color: TAB_ACCENT["local_agent"],
    caution: d.heavy_harness
      ? t("newTabMenu.localDriverHeavyHarness", { agent: d.label })
      : undefined,
    onPick: () => opts.onLaunch(d.id, d.label, model),
  });
  const drivers = (heavy: boolean, model: string) =>
    localDrivers.filter((d) => d.available && d.heavy_harness === heavy).map((d) => driverRow(d, model));
  const agents: AddMenuEntry[] = localModel
    ? [
        // Light-harness drivers (OpenCode, Pi) lead, ahead of Mistral.
        ...drivers(false, localModel),
        // Mistral/vibe keeps its bespoke per-model VIBE_HOME path.
        ...(vibeForLocalModel
          ? [{
              key: "vibe",
              label: "Mistral",
              color: TAB_ACCENT["local_agent"],
              onPick: () => opts.onVibe(localModel),
            }]
          : []),
        ...drivers(true, localModel),
      ]
    : [];

  let entries = agents;
  if (agents.length > 0 && gpu.placement !== "ready") {
    entries =
      gpu.placement === "probing"
        ? []
        : [{
            key: "__load_local_model__",
            label: gpu.loading
              ? t("newTabMenu.loadingLocalModelGpu")
              : gpu.failed
                ? t("newTabMenu.loadLocalModelGpuFailed")
                : gpu.placement === "cpu"
                  ? t("newTabMenu.reloadLocalModelGpu")
                  : t("newTabMenu.loadLocalModelGpu"),
            dot: "⏻",
            color: TAB_ACCENT["local_agent"],
            disabled: gpu.loading,
            onPick: gpu.load,
          }];
  }

  return {
    label: localModel
      ? t("newTabMenu.groupLocalModelWithName", { model: localModel })
      : t("newTabMenu.groupLocalModel"),
    entries,
    // An empty list has several causes and they need different sentences: no
    // agent is installed, or the model can't drive the ones that are. Without
    // the second, withholding the entries would read as a bug — the agent is
    // right there in the Agents group above.
    hint: localModelOffInRoot
      ? t("newTabMenu.localModelOffInRootHint", { model: localModelOffInRoot })
      : !localModel
        ? t("newTabMenu.noLocalModelHint")
        : agents.length > 0
          ? t("newTabMenu.checkingLocalModelGpu", { model: localModel })
          : localDrivers.some((d) => d.needs_tools_unsupported)
            ? t("newTabMenu.localModelNoToolsHint", { model: localModel })
            : t("newTabMenu.noLocalAgentHint"),
  };
}
