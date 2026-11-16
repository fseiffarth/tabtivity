import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { subscribeTauri } from "../hooks/useTauriListener";
import { usePaneVisible } from "../lib/files/fileAccess";
import { TABS_MCP_CHANGED, tabMessages, type TabMessage } from "../lib/window/tabsMcp";

/**
 * The messages agent tabs left each other (`services::tabs_mcp`), per scope,
 * for the cockpit's Messages fold and the tab hover card's unread line. A
 * scope is listed only while a visible surface watches it ({@link
 * useTabMessages}): `watch` fetches at once (the catch-up on show) and every
 * `tabs-mcp-changed` refetches the watched scopes. Nothing is listed while
 * the pane is hidden.
 */
interface TabMessagesState {
  byScope: Record<string, TabMessage[]>;
  refresh: (scope: string) => Promise<void>;
  /** Keep `scope` current until the returned release. */
  watch: (scope: string) => () => void;
}

const watchers = new Map<string, number>();
let stop: (() => void) | null = null;
/** Bumped per refresh of a scope, so a slow answer never overwrites a newer one. */
const generation = new Map<string, number>();

export const useTabMessagesStore = create<TabMessagesState>((set, get) => ({
  byScope: {},
  refresh: async (scope) => {
    const run = (generation.get(scope) ?? 0) + 1;
    generation.set(scope, run);
    const messages = await tabMessages(scope);
    if (generation.get(scope) !== run) return;
    set((s) => ({ byScope: { ...s.byScope, [scope]: messages } }));
  },
  watch: (scope) => {
    watchers.set(scope, (watchers.get(scope) ?? 0) + 1);
    if (!stop) {
      stop = subscribeTauri(() =>
        listen(TABS_MCP_CHANGED, () => {
          for (const watched of watchers.keys()) void get().refresh(watched);
        }),
      );
    }
    void get().refresh(scope);
    return () => {
      const left = (watchers.get(scope) ?? 1) - 1;
      if (left > 0) watchers.set(scope, left);
      else watchers.delete(scope);
      if (watchers.size === 0) {
        stop?.();
        stop = null;
      }
    };
  },
}));

const NONE: readonly TabMessage[] = [];

/** `scope`'s messages, kept current while the surrounding pane is visible and
 *  `enabled` holds; `[]` until the first answer. */
export function useTabMessages(scope: string | undefined, enabled = true): readonly TabMessage[] {
  const visible = usePaneVisible();
  const active = !!scope && enabled && visible;
  useEffect(() => {
    if (!active || !scope) return;
    return useTabMessagesStore.getState().watch(scope);
  }, [active, scope]);
  return useTabMessagesStore((s) => (scope ? s.byScope[scope] : undefined)) ?? NONE;
}

/** How many of `messages` `tabId` has not acked. */
export function unreadFor(messages: readonly TabMessage[], tabId: string | undefined): number {
  if (!tabId) return 0;
  return messages.filter((m) => m.toTab === tabId && !m.read).length;
}
