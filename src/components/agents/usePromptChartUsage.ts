import { useCallback, useMemo, useState } from "react";
import { parseUsageReport, type UsageReport } from "../../../shared/usageReport";
import { readAgentUsage } from "../../lib/agents/agentUsage";
import { usageResetMarks, type UsageResetMark } from "../../lib/agents/agentUsageResets";
import { usePoll, type PollRun } from "../../lib/usePoll";

/** How often the chart re-reads a panel while it is on screen. The backend
 *  reuses a read for a minute and the run spends no quota, but a reset moves
 *  at most once per window, so there is nothing to gain from asking often. */
const USAGE_POLL_MS = 5 * 60_000;

/**
 * The rate-limit resets of the scope's agents, as marks for the timeline.
 * Reads each distinct agent once (an agent without a usage recipe — anything
 * but Claude today — answers unsupported and draws nothing), only while the
 * timeline is visible, and filters by the timeline's agent facet so a filtered
 * axis does not keep another agent's lines.
 */
export function usePromptChartUsage(agents: string[], enabled: boolean, now: Date, from: Date, to: Date, agentFilter: string): UsageResetMark[] {
  const [reports, setReports] = useState<Record<string, UsageReport>>({});
  const agentsKey = [...new Set(agents)].sort().join("\n");

  const read = useCallback((poll: PollRun) => {
    for (const agent of agentsKey.split("\n")) {
      void readAgentUsage(agent).then((report) => {
        if (poll.stopped) return;
        setReports((current) => {
          const next = { ...current };
          if (report?.supported && report.raw) next[agent] = parseUsageReport(report.raw);
          else delete next[agent];
          return next;
        });
      });
    }
  }, [agentsKey]);
  // While the timeline shows, with the window in front (`usePoll`).
  usePoll(read, USAGE_POLL_MS, { enabled: enabled && !!agentsKey });

  return useMemo(() => {
    if (!enabled) return [];
    const live = new Set(agentsKey.split("\n"));
    return Object.entries(reports)
      .filter(([agent]) => live.has(agent) && (!agentFilter || agent === agentFilter))
      .flatMap(([agent, report]) => usageResetMarks(agent, report, now, from, to))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  }, [agentFilter, agentsKey, enabled, from, now, reports, to]);
}
