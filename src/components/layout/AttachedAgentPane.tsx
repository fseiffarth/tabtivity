import { useEffect } from "react";
import { ROOT_SCOPE, type TabEntry } from "../../stores/tabs";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useProjectsStore } from "../../stores/projects";
import { TabScopeContext } from "../tabs/tabScopeContext";
import { TabPane } from "../tabs/TabPane";

interface Props {
  /** The scope `tab` belongs to: the root scope or the Tabby scope. */
  scope: string;
  tab: TabEntry;
  /** The pane has the keyboard. */
  focused: boolean;
  /** Draw the tab's Reader always, with no on/off toggle (Tabby's chats). */
  readerAlways?: boolean;
}

/**
 * One tab of a scope the window does not show, drawn **attach-only**: the
 * view the root console's panes, the mail / calendar / to-do overlays' docked
 * agent column (`OverlayAgentColumn`) and the Tabby overlay share. The PTY
 * belongs to the tab's own pane in `CenterPanel`'s keep-alive layer; this view
 * only attaches to it, so unmounting it ends nothing.
 *
 * Mount it ONLY while it is drawn: while mounted, the tab's key is in the
 * overlay-agent store's shown set (per scope), which makes `CenterPanel`'s
 * copy stand down — one visible view per PTY, two would take turns resizing
 * it. Two of these for one tab are the same mistake; the caller keeps one.
 */
export function AttachedAgentPane({ scope, tab, focused, readerAlways = false }: Props) {
  const rootDir = useProjectsStore((s) => s.rootDir) ?? "";
  const tabKey = tab.key;
  useEffect(() => {
    const { markShown, unmarkShown } = useOverlayAgentStore.getState();
    markShown(tabKey, scope);
    return () => unmarkShown(tabKey, scope);
  }, [scope, tabKey]);
  // A root tab with no cwd of its own falls back to the root folder; the
  // Tabby scope has none (its chats carry the chat folder).
  const cwd = tab.cwd || (scope === ROOT_SCOPE ? rootDir : "");
  return (
    <TabScopeContext.Provider value={scope}>
      <TabPane
        tab={tab}
        scope={scope}
        visible
        focused={focused}
        attachOnly
        readerAlways={readerAlways}
        filesProjectDir={cwd}
        terminalCwd={cwd}
      />
    </TabScopeContext.Provider>
  );
}
