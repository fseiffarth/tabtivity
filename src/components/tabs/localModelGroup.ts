import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadOllamaModel, ollamaGpuStatus, type LocalDriverInfo } from "../../lib/agents/localDrivers";
import type { TranslationKey } from "../../lib/i18n";
import { initLocalModelEvents, useOllamaActivityStore } from "../../stores/agents/ollamaActivity";
import type { AddMenuEntry, AddMenuGroup } from "./AddTabMenuList";
import { TAB_ACCENT } from "../../lib/tabs/newTabItems";
import { CUT_ONLY_DRIVERS, offeredLocalAgents } from "../../lib/projects/localModelsOnly";

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

/** One installed model as the "+" menu reads it (`list_ollama_models_detailed`). */
export interface InstalledLocalModel {
  name: string;
  running: boolean;
  size_vram: number;
  /** Ollama's capability list; empty means unknown, never "none". */
  capabilities?: string[];
}

/** `/api/tags` names carry an explicit tag; a setting may omit `:latest`. */
function sameModel(listed: string, wanted: string): boolean {
  return listed === wanted || (!wanted.includes(":") && listed === `${wanted}:latest`);
}

/** The installed models, or `null` when Ollama isn't answering. */
async function readInstalledModels(): Promise<InstalledLocalModel[] | null> {
  try {
    return await invoke<InstalledLocalModel[]>("list_ollama_models_detailed");
  } catch {
    return null;
  }
}

async function placementIn(models: InstalledLocalModel[] | null, model: string): Promise<LocalModelPlacement> {
  const hit = models?.find((m) => sameModel(m.name, model));
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

export async function probeLocalModelPlacement(model: string): Promise<LocalModelPlacement> {
  return placementIn(await readInstalledModels(), model);
}

export interface LocalModelPlacementState {
  placement: LocalModelPlacement;
  loading: boolean;
  /** The last load this menu started failed. Cleared by the next attempt. */
  failed: boolean;
  /** Start Ollama if needed and load `model` onto the GPU, kept resident. */
  load: () => void;
  /** The installed models, read by the same probe (empty until it answers or
   *  while Ollama isn't): what the group's model fly-out lists. */
  installed: InstalledLocalModel[];
}

/**
 * The GPU gate behind the "+" menu's local-model group. Probes only while
 * `active` (the menu is open) — TabBar mounts its menu data for the life of
 * the bar, and residency is only worth a round trip at the moment someone is
 * about to pick. Follows the shared activity store's loads (fed by
 * `ollama-load-progress`), so a load started from the 🧠 menu or Settings
 * flips the rows here too.
 */
export function useLocalModelPlacement(
  model: string | undefined,
  active: boolean,
): LocalModelPlacementState {
  const [placement, setPlacement] = useState<LocalModelPlacement>("probing");
  // A load this menu started (`load` below); the store's `loads` covers one
  // started anywhere else.
  const [ownLoading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [installed, setInstalled] = useState<InstalledLocalModel[]>([]);
  const loads = useOllamaActivityStore((s) => s.loads);
  const loadKey = model ? Object.keys(loads).find((k) => sameModel(k, model)) : undefined;
  const storeLoading = loadKey !== undefined && loads[loadKey] === "loading";
  const loading = ownLoading || storeLoading;

  // The model changes under an open menu now (its fly-out picks one): only the
  // newest probe may answer, or a slow read for the old model would land last.
  const probeSeq = useRef(0);
  const reprobe = useCallback(() => {
    const seq = ++probeSeq.current;
    void readInstalledModels().then(async (models) => {
      if (seq !== probeSeq.current) return;
      // An empty answer keeps the empty list it replaces: no re-render for nothing.
      setInstalled((prev) => (!models?.length && prev.length === 0 ? prev : models ?? []));
      if (!model) return;
      const next = await placementIn(models, model);
      if (seq === probeSeq.current) setPlacement(next);
    });
  }, [model]);

  useEffect(() => {
    if (!active) return;
    setPlacement("probing");
    reprobe();
    // The store's listeners are ref-counted; a popout has no header menu to
    // have registered them.
    return initLocalModelEvents();
  }, [active, model, reprobe]);

  // A load that ended (success or error) moved the model: probe again.
  const wasStoreLoading = useRef(false);
  useEffect(() => {
    const ended = wasStoreLoading.current && !storeLoading;
    wasStoreLoading.current = storeLoading;
    if (ended && active) reprobe();
  }, [storeLoading, active, reprobe]);

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

  return { placement, loading, failed, load, installed };
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

/** Ollama says this model only embeds: it cannot run an agent at all. */
const embedsOnly = (m: InstalledLocalModel) =>
  !!m.capabilities?.includes("embedding") && !m.capabilities.includes("completion");

/**
 * The group's "Model: <name>" row: a fly-out of the installed models, and a
 * pick makes that model the Tabs model (`ollama_roles.tabs`, the setting the
 * group already follows), so the rows beneath re-read for it — drivers, GPU
 * gate and all. `undefined` when there is nothing else to pick.
 */
function modelPickRow(
  current: string | undefined,
  installed: InstalledLocalModel[],
  offHere: string[],
  onChoose: (model: string) => void,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): AddMenuEntry | undefined {
  const isCurrent = (m: InstalledLocalModel) => !!current && sameModel(m.name, current);
  const choices = installed.filter(
    (m) => !embedsOnly(m) && !offHere.some((off) => sameModel(m.name, off)),
  );
  if (!choices.some((m) => !isCurrent(m))) return undefined;
  return {
    key: "__local_model_pick__",
    label: current ? t("newTabMenu.localModelPick", { model: current }) : t("newTabMenu.localModelPickNone"),
    untested: "newTabMenu.localModelPick",
    dot: "◇",
    color: TAB_ACCENT["local_agent"],
    moreTitle: t("newTabMenu.localModelPickTitle"),
    moreEntries: choices.map((m): AddMenuEntry => ({
      key: m.name,
      label: m.name,
      ...(isCurrent(m) ? { dot: "✓" } : {}),
      color: TAB_ACCENT["local_agent"],
      // Known to lack tools: no local agent here can run on it.
      caution:
        m.capabilities?.length && !m.capabilities.includes("tools")
          ? t("newTabMenu.localModelPickNoTools", { model: m.name })
          : undefined,
      keepsMenu: true,
      onPick: () => {
        if (!isCurrent(m)) onChoose(m.name);
      },
    })),
    onPick: () => {},
  };
}

export function localModelMenuGroup(opts: {
  localModel: string | undefined;
  localModelOffInRoot: string | undefined;
  localDrivers: LocalDriverInfo[];
  /** The scope is a Local models only project: the drivers the backend gate
   *  refuses there (`driversForLockedProject`) are not offered, and a cut-only one
   *  (OpenCode) says it runs without network. */
  lockedProject?: boolean;
  /** The locked project has Cut network on: only the drivers verified with the
   *  network cut are offered, and Mistral is not. */
  cutNetwork?: boolean;
  vibeForLocalModel: boolean;
  gpu: LocalModelPlacementState;
  onVibe: (model: string) => void;
  onLaunch: (agentId: string, label: string, model: string) => void;
  /** Offer the "Model: …" row; a pick makes that model the Tabs model. Absent:
   *  no row (the group follows the setting as before). */
  onChooseModel?: (model: string) => void;
  /** Models the scope may not use (the root console's switched-off ones): left
   *  out of the model fly-out. */
  modelsOffHere?: string[];
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}): AddMenuGroup {
  const { localModel, localModelOffInRoot, vibeForLocalModel, gpu, t } = opts;
  const offered = offeredLocalAgents(opts.localDrivers, Boolean(opts.lockedProject), Boolean(opts.cutNetwork));
  const localDrivers = offered.drivers;
  const offerVibe = vibeForLocalModel && offered.vibe;
  // `heavy_harness` cautions, it never withholds — see
  // lib/agents/localDrivers.ts. The row stays pickable because which local
  // models cope is not something the backend can probe.
  // In a locked project that keeps its network a cut-only driver still runs, in a
  // sandbox of its own with no network (`agent_privacy::CUT_ONLY_DRIVERS`).
  const cutAlone = (d: LocalDriverInfo) => Boolean(opts.lockedProject) && !opts.cutNetwork && CUT_ONLY_DRIVERS.includes(d.id);
  const driverRow = (d: LocalDriverInfo, model: string): AddMenuEntry => ({
    key: d.id,
    label: d.label,
    ...DRIVER_UNTESTED[d.id],
    ...(cutAlone(d) ? { untested: "localModelsOnly.cutOnlyDriver" } : {}),
    color: TAB_ACCENT["local_agent"],
    caution: d.heavy_harness
      ? t("newTabMenu.localDriverHeavyHarness", { agent: d.label })
      : cutAlone(d)
        ? t("newTabMenu.localDriverCutAlone", { agent: d.label })
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
        ...(offerVibe
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

  const pick = opts.onChooseModel
    ? modelPickRow(localModel ?? localModelOffInRoot, gpu.installed, opts.modelsOffHere ?? [], opts.onChooseModel, t)
    : undefined;

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
    entries: pick ? [pick, ...entries] : entries,
    // The hint explains an empty list; beside the model row it still does.
    ...(pick && entries.length === 0 ? { hintBeside: true } : {}),
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
