import { useEffect } from "react";
import { useTabsStore } from "../../stores/tabs";
import { ASSISTANT_SCOPE } from "../../lib/assistant";

/**
 * Persists the Tabby scope (`stores/assistantScope`). `CenterPanel` saves only
 * the ACTIVE scope, and the assistant scope never is, so its chats (opened,
 * closed, reordered, labelled) would otherwise never reach
 * `sessions/assistant/`. The root console's host does the same for root.
 *
 * `localFile` is always `""`: the scope has no project tree to export into.
 * An absent key means "never hydrated" (a save now would erase the saved
 * chats), so nothing is written until the overlay or the phone restored the
 * scope. Renders nothing; mounted once, at the shell.
 */
export function AssistantScopeHost() {
  const chats = useTabsStore((s) => s.tabsByScope[ASSISTANT_SCOPE]);
  const layout = useTabsStore((s) => s.layoutByScope[ASSISTANT_SCOPE]);
  useEffect(() => {
    if (chats === undefined) return;
    const timer = window.setTimeout(() => {
      useTabsStore.getState().persistScope(ASSISTANT_SCOPE, "").catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [chats, layout]);
  return null;
}
