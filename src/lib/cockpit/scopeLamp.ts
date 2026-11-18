import type { AttentionKind } from "../../stores/activity";
import { isPtyTabKind, type TabEntry } from "../../stores/tabs";
import { isRosterAgentKind } from "../agents/agentRoster";

/** What one scope's tabs are doing, rolled up for a single lamp. */
export interface ScopeLamp {
  /** Agent tabs waiting on a decision (not while they work, as the badge counts). */
  asking: number;
  /** Terminal tabs producing output / working a turn. */
  working: number;
  /** An agent works (the dotted ring is the agent's), else only commands do. */
  agentWorking: boolean;
}

/**
 * The Root tab's lamp: the live activity readings of ONE scope's tabs, nothing
 * more (no roster, no clock, no backend read). Asking follows the header
 * badge's rule (`cockpitBadge`: a decision counts only while the tab is not
 * working), working the tab strip's (a PTY tab with output).
 */
export function scopeLamp(
  scope: string,
  tabs: readonly TabEntry[],
  busyByTab: Record<string, boolean>,
  attentionByTab: Record<string, AttentionKind>,
): ScopeLamp {
  const lamp: ScopeLamp = { asking: 0, working: 0, agentWorking: false };
  for (const tab of tabs) {
    if (!isPtyTabKind(tab.kind)) continue;
    const pty = `${scope}:${tab.key}`;
    if (busyByTab[pty]) {
      lamp.working += 1;
      if (isRosterAgentKind(tab.kind)) lamp.agentWorking = true;
    } else if (isRosterAgentKind(tab.kind) && attentionByTab[pty] === "decision") {
      lamp.asking += 1;
    }
  }
  return lamp;
}
