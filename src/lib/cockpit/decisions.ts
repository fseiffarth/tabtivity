import type { AttentionKind } from "../../stores/activity";
import type { TabEntry } from "../../stores/tabs";
import type { ScheduledAgentPrompt } from "../agents/agentSchedule";
import { isAgentProposal } from "../agents/agentSchedule";
import { ASSISTANT_SCOPE } from "../assistant";
import { isRosterAgentKind } from "../agents/agentRoster";

/** What the header's cockpit badge counts, each part on its own. */
export interface CockpitBadgeInput {
  tabsByScope: Record<string, readonly TabEntry[]>;
  busyByTab: Record<string, boolean>;
  attentionByTab: Record<string, AttentionKind>;
  /** Loaded schedules, by `scheduleCacheKey` (whatever surfaces loaded). */
  schedulesByTarget: Record<string, readonly ScheduledAgentPrompt[]>;
  /** Root approvals waiting (`useDomainReview().waiting`). */
  approvals: number;
  /** Pending push / release requests, where known. */
  pushRequests?: number;
}

export interface CockpitBadge {
  asking: number;
  interrupted: number;
  proposals: number;
  approvals: number;
  total: number;
}

/**
 * The header button's badge: Asking + Interrupted + proposals + approvals,
 * **derived, never acknowledged** (the `TodoIndicator` rule) — it falls as each
 * is answered and has no dismissal of its own.
 *
 * Every agent tab of every hydrated scope but the assistant's counts, with the
 * desktop's own lamps (`deriveAgentRosterState`'s first answers: a decision
 * only while not working). Schedule proposals are counted from the schedules
 * the window has loaded; push requests only when a caller knows them (the
 * backend read behind them runs git, so nothing reads it while the cockpit
 * is shut).
 */
export function cockpitBadge(input: CockpitBadgeInput): CockpitBadge {
  let asking = 0;
  let interrupted = 0;
  for (const [scope, tabs] of Object.entries(input.tabsByScope)) {
    if (scope === ASSISTANT_SCOPE) continue;
    for (const tab of tabs) {
      if (!isRosterAgentKind(tab.kind)) continue;
      const pty = `${scope}:${tab.key}`;
      if (input.busyByTab[pty]) continue;
      const attention = input.attentionByTab[pty];
      if (attention === "decision") asking += 1;
      else if (attention === "interrupted") interrupted += 1;
    }
  }
  let proposals = input.pushRequests ?? 0;
  for (const rows of Object.values(input.schedulesByTarget)) {
    for (const row of rows) if (isAgentProposal(row)) proposals += 1;
  }
  const approvals = input.approvals;
  return { asking, interrupted, proposals, approvals, total: asking + interrupted + proposals + approvals };
}
