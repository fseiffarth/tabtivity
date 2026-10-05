/**
 * Broadcast when the locally available built-in agent CLIs change. The Manage
 * Agents panel owns install/remove actions, while tab menus may remain mounted
 * behind it and otherwise keep their initial `list_agents` result indefinitely.
 */
export const AGENT_REGISTRY_CHANGED_EVENT = "app:agent-registry-changed";

export function notifyAgentRegistryChanged() {
  window.dispatchEvent(new Event(AGENT_REGISTRY_CHANGED_EVENT));
}
