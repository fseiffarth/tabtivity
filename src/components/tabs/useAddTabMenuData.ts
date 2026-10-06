import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CustomAgent } from "../../types";
import { useSettingsStore } from "../../stores/settings";
import { boxMembersOfScope, useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import {
  DEFAULT_COMPACT_AGENT_IDS,
  EMPTY_CUSTOM_AGENTS,
  enabledInstalledAgentBins,
  rootAllowedAgentBins,
  type BuiltInAgentStatus,
} from "./newTabItems";
import { listLocalDrivers, type LocalDriverInfo } from "../../lib/agents/localDrivers";
import { AGENT_REGISTRY_CHANGED_EVENT } from "../../lib/agents/agentRegistry";
import { ROOT_SCOPE } from "../../stores/tabs";

/** The data behind an add-tab ("+") menu — see {@link useAddTabMenuData}. */
export interface AddTabMenuData {
  /** The local (Ollama) model a "Local Model" tab launches: the model tagged
   *  for the "tabs" task in the 🧠 menu, falling back to the default
   *  `ollama_model`. The menu offers ONE "Local Model" entry that launches it,
   *  rather than listing every installed model. */
  localModel: string | undefined;
  /** Root scope only: the "tabs" model the user switched off for the root
   *  console (its 🧠 "Root" chip). `localModel` is then `undefined`, and the
   *  menus say why instead of "no local model set". */
  localModelOffInRoot: string | undefined;
  /** Coding agents that can drive the active local model besides Mistral/vibe
   *  (Claude Code, Codex, OpenCode, Droid via `ollama launch` or a direct
   *  fallback). Re-probed whenever the active model changes: these are all
   *  tool-calling agents, so a completion-only model (llama3 is one) can't
   *  drive any of them and they're withheld rather than offered as a tab that
   *  dies on its first request. Passing the gate isn't a promise the model is
   *  *good* at it — `ollama launch` has its own opinion and may greet the tab
   *  with a "Launch anyway?" prompt (see lib/agents/localDrivers.ts). */
  localDrivers: LocalDriverInfo[];
  /** Installed agent CLIs (id == cmd) minus the built-ins the user turned off
   *  in "Manage Agents" — the set the Agents group should use. `null` until
   *  the probe resolves, so the Agents list renders nothing (not a flash of
   *  the full list) until we know. Re-probed after Manage Agents changes the registry.
   *  In the root scope, further narrowed to the agents whose 🧠 "Root" chip is
   *  on (`rootAllowedAgentBins`). */
  enabledAgents: Set<string> | null;
  /** The default agent's (`default_agent_cmd`, "claude" when unset) binary —
   *  the setting holds a registry id, which is not always the command
   *  (`antigravity` launches `agy`). What Ctrl+1 opens (`agentShortcutSlots`). */
  defaultAgentBin: string;
  /** Mistral/vibe is installed and not turned off in "Manage Agents" — the
   *  gate for the local-model group's Mistral row. Deliberately NOT narrowed
   *  by the root "Root" agent chips: local models are opt-out in the root
   *  console (`localModelOffInRoot`), agents opt-in, and the Mistral local
   *  row is a local model, not the Mistral agent. */
  vibeForLocalModel: boolean;
  /** Installed agent bins the user marked "compact" (icon-only row). */
  compactAgentBins: Set<string>;
  /** User-defined custom agents (Settings.custom_agents). */
  customAgents: CustomAgent[];
  /** Settings.agent_order: the Agents rows' order and Ctrl+1–9 numbers. */
  agentOrder: string[] | undefined;
  /** Installed *custom*-agent commands, probed separately (they aren't in the
   *  built-in registry). `null` until resolved — custom agents render enabled
   *  until a probe proves one missing. */
  installedCustom: Set<string> | null;
  /** Box scope (#41 Phase 5): the active box's members with resolved roots for
   *  the per-member rows. Empty outside a box scope — and in a popout, whose
   *  projects/boxes stores may be empty (that window is inert to them), the
   *  list is simply empty and no group renders. */
  boxMembers: { id: string; name: string; dir: string }[];
}

/**
 * The data plumbing behind an add-tab ("+") menu: agent-registry probe +
 * change listener, enabled/compact/custom agents, `probe_binaries` for custom
 * commands, local-model drivers, and box-member rows.
 *
 * ONE implementation for the two "+" menus — the main window's `TabBar` and the
 * detached popout's `NewTabMenu` are separate React roots (an entry or a probe
 * fixed in one used to be silently missing or stale in the other; this ~80-line
 * block was maintained verbatim in both).
 *
 * `active: false` holds every probe back (and the registry listeners off) —
 * for a host that stays mounted while it is hidden, like the mail overlay's
 * docked-agent hook. The data then keeps its last answer (`null` before any).
 */
export function useAddTabMenuData(
  scope: string,
  { active = true }: { active?: boolean } = {},
): AddTabMenuData {
  const isRoot = scope === ROOT_SCOPE;
  const tabsModel = useSettingsStore(
    (s) => s.settings?.ollama_roles?.tabs ?? s.settings?.ollama_model,
  );
  // Local models are in the root console unless switched off there — the
  // opposite default to agents, since a local model reaches nothing beyond
  // this machine.
  const rootOffModels = useSettingsStore((s) => s.settings?.root_excluded_models);
  const localModelOffInRoot =
    isRoot && tabsModel && rootOffModels?.includes(tabsModel) ? tabsModel : undefined;
  const localModel = localModelOffInRoot ? undefined : tabsModel;
  const [localDrivers, setLocalDrivers] = useState<LocalDriverInfo[]>([]);
  const refreshLocalDrivers = useCallback(() => {
    void listLocalDrivers(localModel)
      .then(setLocalDrivers)
      .catch(() => {});
  }, [localModel]);
  useEffect(() => {
    if (!active) return;
    refreshLocalDrivers();
    window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, refreshLocalDrivers);
    return () => window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, refreshLocalDrivers);
  }, [refreshLocalDrivers, active]);

  const [agentStatuses, setAgentStatuses] = useState<
    (BuiltInAgentStatus & { id: string })[] | null
  >(null);
  const refreshInstalledAgents = useCallback(() => {
    void invoke<(BuiltInAgentStatus & { id: string })[]>("list_agents")
      .then(setAgentStatuses)
      .catch(() => setAgentStatuses([]));
  }, []);
  useEffect(() => {
    if (!active) return;
    refreshInstalledAgents();
    window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, refreshInstalledAgents);
    return () => window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, refreshInstalledAgents);
  }, [refreshInstalledAgents, active]);

  // Built-in agents the user turned off in "Manage Agents" (Settings) despite
  // being installed — hidden from the menu without uninstalling the CLI.
  const disabledAgents = useSettingsStore((s) => s.settings?.disabled_agents);
  const compactAgentIds = useSettingsStore(
    (s) => s.settings?.compact_tab_agents ?? DEFAULT_COMPACT_AGENT_IDS,
  );
  const rootAgentIds = useSettingsStore((s) => s.settings?.root_agents);
  const installedEnabled = useMemo(
    () => (agentStatuses ? enabledInstalledAgentBins(agentStatuses, disabledAgents) : null),
    [agentStatuses, disabledAgents],
  );
  const enabledAgents = useMemo(() => {
    if (!installedEnabled || !agentStatuses) return installedEnabled;
    return isRoot
      ? rootAllowedAgentBins(installedEnabled, agentStatuses, rootAgentIds)
      : installedEnabled;
  }, [installedEnabled, agentStatuses, isRoot, rootAgentIds]);
  const vibeForLocalModel = installedEnabled?.has("vibe") ?? false;
  const defaultAgentCmd = useSettingsStore((s) => s.settings?.default_agent_cmd || "claude");
  const defaultAgentBin =
    (agentStatuses ? agentStatuses.find((a) => a.id === defaultAgentCmd)?.bin : undefined) ??
    defaultAgentCmd;
  const compactAgentBins = useMemo(() => {
    if (!agentStatuses) return new Set<string>();
    const compactIds = new Set(compactAgentIds);
    return new Set(
      agentStatuses
        .filter((agent) => compactIds.has(agent.id) || compactIds.has(agent.bin))
        .map((agent) => agent.bin),
    );
  }, [agentStatuses, compactAgentIds]);

  const customAgents = useSettingsStore(
    (s) => s.settings?.custom_agents ?? EMPTY_CUSTOM_AGENTS,
  );
  const agentOrder = useSettingsStore((s) => s.settings?.agent_order);
  const [installedCustom, setInstalledCustom] = useState<Set<string> | null>(null);
  // Re-probe custom commands whenever the set changes (adding one in the dialog).
  useEffect(() => {
    if (!active) return;
    const cmds = customAgents.map((a) => a.cmd);
    if (cmds.length === 0) {
      setInstalledCustom(new Set());
      return;
    }
    invoke<string[]>("probe_binaries", { bins: cmds })
      .then((found) => setInstalledCustom(new Set(found)))
      .catch(() => setInstalledCustom(new Set()));
  }, [customAgents, active]);

  const boxes = useBoxesStore((st) => st.boxes);
  const projects = useProjectsStore((st) => st.projects);
  const boxMembers = useMemo(
    () => boxMembersOfScope(scope, boxes, projects),
    [scope, boxes, projects],
  );

  return {
    localModel,
    localModelOffInRoot,
    localDrivers,
    enabledAgents,
    defaultAgentBin,
    vibeForLocalModel,
    compactAgentBins,
    customAgents,
    agentOrder,
    installedCustom,
    boxMembers,
  };
}
