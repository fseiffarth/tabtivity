import { useMemo } from "react";
import type { PromptChartCard, PromptChartStrand } from "../../lib/agents/prompt/chart";
import { livePromptStates, type PromptLiveState } from "../../lib/agents/prompt/outcome";
import { useActivityStore } from "../../stores/activity";

/**
 * Which sent cards are running or waiting for an answer right now: the newest
 * delivered row of each live tab, read off the tab's activity verdict. Nothing
 * here is stored — the chart stays a pure join of its persisted sources — and a
 * hidden chart does not re-read it (`enabled`).
 */
export function usePromptLiveState(
  scope: string,
  cards: readonly PromptChartCard[],
  strands: readonly PromptChartStrand[],
  enabled: boolean,
): ReadonlyMap<string, PromptLiveState> {
  const tabs = useActivityStore((state) => state.statusTabsByScope[scope]);
  return useMemo(() => {
    if (!enabled || !tabs?.length) return new Map<string, PromptLiveState>();
    const byKey = new Map(tabs.filter((tab) => !tab.shell).map((tab) => [tab.key, tab.state]));
    const tabKeyOf = new Map(strands.filter((strand) => strand.tabKey).map((strand) => [strand.id, strand.tabKey!]));
    return livePromptStates(cards, (strandId) => {
      const key = tabKeyOf.get(strandId);
      return key ? byKey.get(key) : undefined;
    });
  }, [cards, enabled, strands, tabs]);
}
