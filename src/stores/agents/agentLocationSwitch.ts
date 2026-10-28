import { invoke } from "@tauri-apps/api/core";
import type { ProjectEntry } from "../../types";
import { useProjectsStore } from "../projects";
import { useTabsStore, type TabEntry, type TabLocation } from "../tabs";
import { hostTabId } from "../tabs/tabLocation";
import { resumeArgsOf } from "./closedAgentTabs";
import { stopAgentTab } from "./agentWorktreeSwitch";

/**
 * Switching where a remote project's agent tab runs — this machine (the
 * mirror) or one of the project's hosts, from the tab's locality badge — with
 * its conversation along. The tab's CLI is stopped (its local tmux session
 * ended when it leaves this machine), the backend ends its tmux session on a
 * host it leaves and copies the conversation to where the CLI looks for it on
 * the other side (`agent_tab_move_host`, `services::agent_host_move`), and the
 * pane respawns there on the args a restore would give it.
 *
 * Only Claude carries its conversation; other agents keep the plain switch
 * (`setTabLocation`), which starts them anew on the other side. A move that
 * fails respawns the tab where it was.
 */

/** The CLIs whose conversation a locality switch takes along. Mirrors the
 * backend's `services::agent_host_move`. */
const CARRIES_ACROSS_HOSTS = new Set(["claude"]);

/** Whether moving `tab` of `project` to `location` takes its conversation
 * along: a Claude tab with a session of a remote (not VM) project, changing
 * the machine it runs on. */
export function carriesAcrossHosts(tab: TabEntry, project: ProjectEntry | undefined, location: TabLocation): boolean {
  if (tab.kind !== "agent" || !tab.sessionId || !CARRIES_ACROSS_HOSTS.has(tab.cmd ?? "")) return false;
  if (!project?.remote || project.vm?.enabled) return false;
  return hostTabId(tab, project) !== hostTabId({ ...tab, location }, project);
}

/** `carried`: the conversation goes on there. `fresh`: the CLI started a new
 * one there. `failed`: the tab came back where it was. */
export type LocationSwitchResult = "carried" | "fresh" | "failed";

/** Move `tab` of `scope` to `location`: with its conversation where
 * {@link carriesAcrossHosts} says so, else the plain switch. `failed` when the
 * tab stayed where it was. */
export async function switchTabLocation(scope: string, tab: TabEntry, location: TabLocation): Promise<LocationSwitchResult> {
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  if (!carriesAcrossHosts(tab, project, location)) {
    useTabsStore.getState().setTabLocation(tab.key, location);
    return "fresh";
  }
  const from = hostTabId(tab, project);
  const to = hostTabId({ ...tab, location }, project);
  let moved: LocationSwitchResult = "failed";
  if (await stopAgentTab(scope, tab, from === null)) {
    try {
      moved = await invoke<"carried" | "fresh">("agent_tab_move_host", {
        agent: tab.cmd,
        projectId: scope,
        sessionId: tab.sessionId ?? "",
        from,
        to,
        // The session a host tab runs in (PaneSlot's `shouldPersistTab`);
        // never one it only attached to.
        tmuxSession: tab.tmuxAttach ? null : (tab.tmuxSession ?? null),
      });
    } catch {
      moved = "failed";
    }
  }
  useTabsStore.getState().relaunchTabInScope(
    scope,
    tab.key,
    resumeArgsOf(tab),
    moved === "failed" ? undefined : { location },
  );
  return moved;
}
