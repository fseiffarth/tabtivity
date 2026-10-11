import { createContext, useContext } from "react";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

/**
 * The tab a pane renders, as `TabPane` was handed it.
 *
 * A detached popout's `useTabsStore` holds no tabs (they arrive as streamed
 * props, see `stores/detachedContext`), so a pane part that looked its own tab
 * up in the store found nothing there: a popped-out agent tab had no prompt
 * trail, no Chat and no Diffs. `TabPane` provides the entry it renders, and
 * {@link usePaneTab} falls back to it whenever the store has no such tab.
 */
export const PaneTabContext = createContext<{ scope: string; tab: TabEntry } | null>(null);

/** `scope`'s tab `key`: the store's entry, else the one the pane was handed. */
export function usePaneTab(scope: string | undefined, key: string | undefined): TabEntry | undefined {
  const pane = useContext(PaneTabContext);
  const stored = useTabsStore((state) => scope && key
    ? state.tabsByScope[scope]?.find((entry) => entry.key === key)
    : undefined);
  if (stored) return stored;
  return pane && pane.scope === scope && pane.tab.key === key ? pane.tab : undefined;
}
