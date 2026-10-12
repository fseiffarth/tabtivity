import { useCallback, useEffect, useMemo } from "react";
import { useT } from "../../lib/i18n";
import { useActivityStore } from "../../stores/activity";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { PromptChart } from "./PromptChart";
import { isPromptTargetTab } from "./promptTarget";

interface Props {
  /** The tab's scope: a project id, or `"root"`. The chart's columns are this
   *  scope's agent tabs, read from the store rather than handed in, so the
   *  pane renders the same in a popout. */
  scope: string;
  visible?: boolean;
}

const EMPTY_TABS: TabEntry[] = [];


/**
 * The Prompt chart tab (`PROMPTCHART_TAB_CMD`): `PromptChart` given a whole
 * pane. It used to be the last section of the side panel's Agents view, where a
 * chart with one column per agent tab had a side panel's width to lay them out
 * in; the Agents view keeps the tab list and composers and offers a button here.
 *
 * The strand header's state word comes from the activity store with the same
 * decision-over-working-over-done precedence the tab ring and the Agents view
 * read, translated here rather than in the chart, which only prints it.
 */
export function PromptChartTab({ scope, visible = true }: Props) {
  const t = useT();
  const tabs = useTabsStore((state) => state.tabsByScope[scope] ?? EMPTY_TABS);
  const agentTabs = useMemo(() => tabs.filter(isPromptTargetTab), [tabs]);
  const busyByTab = useActivityStore((state) => state.busyByTab);
  const attentionByTab = useActivityStore((state) => state.attentionByTab);
  const schedulesByTarget = useAgentSchedulesStore((state) => state.byTarget);
  const loadSchedules = useAgentSchedulesStore((state) => state.load);
  // The chart reads each column's schedules from the cache and loads none itself
  // (the Agents view used to fill it); standing alone, the tab fills it — once
  // it is shown: a hidden tab has no business reading every tab's schedules.
  useEffect(() => {
    if (!visible) return;
    for (const tab of agentTabs) if (tab.scheduleTargetId && !schedulesByTarget[scheduleCacheKey(scope, tab.scheduleTargetId)]) void loadSchedules(scope, tab.scheduleTargetId).catch(() => []);
  }, [agentTabs, loadSchedules, schedulesByTarget, scope, visible]);
  // Stable across renders the activity maps did not move, so the chart's
  // target list is not rebuilt on every unrelated re-render.
  const stateOf = useCallback((tab: TabEntry): string => {
    const ptyId = `${scope}:${tab.key}`;
    const state = attentionByTab[ptyId] === "decision" ? "decision" : busyByTab[ptyId] ? "working" : attentionByTab[ptyId] === "done" ? "done" : "idle";
    return t(`agentPrompts.state.${state}`);
  }, [attentionByTab, busyByTab, scope, t]);
  return (
    <div className="prompt-chart-tab" data-testid="prompt-chart-tab">
      <PromptChart scope={scope} active={visible} tabs={agentTabs} stateOf={stateOf} />
    </div>
  );
}
