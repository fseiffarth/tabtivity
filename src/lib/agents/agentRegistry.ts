import { useSettingsStore } from "../../stores/settings";
import { DEFAULT_COMPACT_AGENT_IDS, type BuiltInAgentStatus } from "../tabs/newTabItems";

/**
 * Broadcast when the locally available built-in agent CLIs change. The Manage
 * Agents panel owns install/remove actions, while tab menus may remain mounted
 * behind it and otherwise keep their initial `list_agents` result indefinitely.
 */
export const AGENT_REGISTRY_CHANGED_EVENT = "app:agent-registry-changed";

export function notifyAgentRegistryChanged() {
  window.dispatchEvent(new Event(AGENT_REGISTRY_CHANGED_EVENT));
}

/** Every CLI this window has seen installed. It only grows, so a Reinstall (gone
 *  for a moment) or a Remove + Install leaves the user's "+ tab" chip alone. */
let seenInstalled: Set<string> | null = null;

/**
 * Takes each `list_agents` answer: a CLI that turns up installed while the app
 * runs — one-click, in a terminal tab, found by Recheck — gets its "+ tab" chip,
 * so it sits in the compact + menu rather than behind "More". The first answer
 * is only the baseline: a CLI already there keeps the chip the user left it with.
 */
export function noteInstalledAgents(agents: readonly (BuiltInAgentStatus & { id: string })[]) {
  // The registry always has rows, so an empty answer is a failed read.
  if (!agents?.length) return;
  const installed = agents.filter((agent) => agent.installed);
  const seen = seenInstalled;
  if (!seen) {
    seenInstalled = new Set(installed.map((agent) => agent.id));
    return;
  }
  const fresh = installed.filter((agent) => !seen.has(agent.id));
  if (fresh.length === 0) return;
  for (const agent of fresh) seen.add(agent.id);
  const { settings, updateSettings } = useSettingsStore.getState();
  if (settings) {
    const ids = settings.compact_tab_agents ?? DEFAULT_COMPACT_AGENT_IDS;
    const added = fresh
      .filter((agent) => !ids.includes(agent.id) && !ids.includes(agent.bin))
      .map((agent) => agent.id);
    if (added.length > 0) {
      void updateSettings({ compact_tab_agents: [...ids, ...added] }).catch(() => {});
    }
  }
  notifyAgentRegistryChanged();
}
