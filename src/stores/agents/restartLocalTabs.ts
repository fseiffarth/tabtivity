import { useTabsStore } from "../tabs";
import { resumeArgsOf } from "../tabs/tabKinds";
import { stopAgentTab } from "./agentWorktreeSwitch";

/**
 * Restart the verified local tabs a Cut network change left on the other setting
 * (`set_project_agent_privacy`'s `restart_tabs`, PTY ids `<scope>:<tab key>`): each
 * is stopped (its own tmux session too) and relaunched in place with the args a
 * restore would give it, so the backend gate verifies it again and builds its
 * sandbox under the new setting. Only on the user's say-so, never silently.
 * Returns how many were restarted.
 */
export async function restartLocalTabs(ptyIds: readonly string[]): Promise<number> {
  let restarted = 0;
  for (const id of ptyIds) {
    const state = useTabsStore.getState();
    const found = Object.entries(state.tabsByScope).flatMap(([scope, list]) =>
      list.filter((tab) => `${scope}:${tab.key}` === id).map((tab) => ({ scope, tab })),
    )[0];
    if (!found) continue;
    if (!(await stopAgentTab(found.scope, found.tab, true))) continue;
    useTabsStore.getState().relaunchTabInScope(found.scope, found.tab.key, resumeArgsOf(found.tab));
    restarted += 1;
  }
  return restarted;
}
