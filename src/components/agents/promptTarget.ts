import type { TabEntry } from "../../stores/tabs";

/** The agent tabs a prompt can be aimed at — the same predicate the Agents view
 *  lists by, shared so the two surfaces agree on which tabs are columns. Its own
 *  module so the Agents view (startup chunk) need not import the lazily split
 *  `PromptChartTab` for it. */
export function isPromptTargetTab(tab: TabEntry): boolean {
  return (tab.kind === "agent" || tab.kind === "local_agent") && !!tab.scheduleTargetId;
}
