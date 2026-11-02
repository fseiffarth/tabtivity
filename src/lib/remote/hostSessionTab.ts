/**
 * Bringing a host tmux session back from the Sessions view as the agent tab it
 * was. Closing a remote agent tab only detaches (`closeRemoteTab`), so its session
 * goes on running with no tab; a shell attached to it would show the CLI's screen
 * but be no agent tab: no Chat view, and no conversation to resume once the
 * session ends.
 *
 * The tab is back whole while this window remembers it
 * (`stores/agents/closedAgentTabs`). Past a restart only the host knows: its tmux
 * session recorded which CLI and launch id it started on
 * (`remote_tmux_agent`), and the tab is rebuilt from those the way a restart
 * restores a saved one. It owns the session under its minted name, so
 * `new-session -A` reattaches the live CLI, and resumes if the session has ended.
 */

import { invoke } from "@tauri-apps/api/core";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useClosedAgentTabsStore, reopenClosedAgentTab } from "../../stores/agents/closedAgentTabs";
import { RESUMABLE_AGENTS } from "../agents/agentClis";
import { envName } from "../brand";
import type { TranslationKey } from "../i18n";
import { AGENT_ITEMS, buildStaticTabSpec } from "../tabs/newTabItems";
import { sessionKindFromName, sessionMintedFor } from "../terminal/tmuxSession";
import { persistentSessionOf } from "./closeRemoteTab";

/** `ssh_exec::HostSessionAgent`. */
interface HostSessionAgent {
  cmd: string;
  sessionId: string;
}

/** Reopen the closed agent tab whose session `name` runs on `hostId`, if this
 *  window kept one. False when it did not, or its conversation is open again. */
export function reopenClosedHostSession(scope: string, hostId: string, name: string): boolean {
  const closed = useClosedAgentTabsStore.getState().byScope[scope]?.find((entry) => {
    const owned = persistentSessionOf(scope, entry.tab);
    return owned?.session === name && owned.hostId === hostId;
  });
  return !!closed && !!reopenClosedAgentTab(scope, closed.id);
}

/**
 * The agent tab for `scope`'s session `name` on `hostId`, as the host recorded
 * it, or `null` when a shell attach is all there is to offer: a session that is
 * not this scope's agent, a host that does not answer, a CLI with no resume
 * path (the host's word names only a built-in here, never a command to run), or a
 * conversation already open in another tab.
 */
export async function hostAgentTabSpec(
  scope: string,
  hostId: string,
  name: string,
  place: Pick<TabEntry, "cwd" | "location">,
  t: (key: TranslationKey) => string,
): Promise<Omit<TabEntry, "key"> | null> {
  if (sessionKindFromName(name) !== "agent" || !sessionMintedFor(name, scope)) return null;
  const agent = await invoke<HostSessionAgent | null>("remote_tmux_agent", {
    projectId: scope,
    hostId,
    session: name,
  }).catch(() => null);
  if (!agent) return null;
  const item = AGENT_ITEMS.find((row) => row.cmd === agent.cmd);
  if (!item || !(agent.cmd in RESUMABLE_AGENTS)) return null;
  const open = useTabsStore.getState().tabsByScope[scope] ?? [];
  if (open.some((tab) => tab.sessionId === agent.sessionId && tab.cmd === agent.cmd)) return null;
  const spec = buildStaticTabSpec(item, place.cwd ?? "", "", t);
  return {
    ...spec,
    ...place,
    sessionId: agent.sessionId,
    args: RESUMABLE_AGENTS[agent.cmd](agent.sessionId),
    env: { ...spec.env, [envName("TAB_UID")]: agent.sessionId },
    tmuxSession: name,
  };
}
