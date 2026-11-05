import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import {
  NEW_TAB_SHORTCUT_EVENT,
  NEW_TAB_SLOTS_EVENT,
  type NewTabRequest,
  type NewTabShortcutDetail,
  type NewTabSlotsDetail,
} from "../../lib/shortcuts/newTabChord";
import { SHELL_ITEMS, agentShortcutSlots, buildStaticTabSpec, onOwnLogin } from "../../lib/tabs/newTabItems";
import { EMPTY_GROUP_ID, ROOT_SCOPE, type TabEntry } from "../../stores/tabs";
import { MONITOR_TAB_CMD } from "../../stores/tabs/tabKinds";
import { useAddTabMenuData } from "../tabs/useAddTabMenuData";

const SHELL_ITEM = SHELL_ITEMS.find((i) => i.kind === "shell")!;

/**
 * The new-tab keys while the Root view is up: Ctrl+Shift+N / M, Ctrl+1-9, and
 * steering's N / O / 1-9 / +. `newTabChord` addresses them to Root's focused
 * subwindow (the workspace's panes are behind the window), and this answers for
 * it the way `TabBar` answers for its own group: the tab the console's + menu
 * row would open, in that subwindow. Agents are the root-allowed ones only
 * (`useAddTabMenuData(ROOT_SCOPE)`, as the empty card's Start button reads them),
 * on their own login; the Host session is never a key, only its menu row.
 *
 * Renders nothing. Mounted by `RootView`, so it listens only while the view is
 * up. `groupIds` are Root's subwindows; a request for any other group is the
 * workspace's and passes by.
 */
export function RootNewTabKeys({
  groupIds,
  rootDir,
  onAdd,
  onMenu,
}: {
  groupIds: readonly string[];
  rootDir: string;
  /** Add `spec` as a tab of the subwindow `groupId`. */
  onAdd: (spec: Omit<TabEntry, "key">, groupId: string) => void;
  /** Open (or close) the subwindow's + menu; false when its button is not drawn. */
  onMenu: (groupId: string) => boolean;
}) {
  const t = useT();
  const { enabledAgents, installedCustom, customAgents, defaultAgentBin, agentOrder } = useAddTabMenuData(ROOT_SCOPE);
  const slots = () =>
    enabledAgents === null
      ? []
      : agentShortcutSlots({ installedBuiltins: enabledAgents, installedCmds: installedCustom, customAgents, defaultAgentBin, agentOrder });
  // Latest-render handlers behind one listener pair.
  const live = useRef({ groupIds, rootDir, onAdd, onMenu, slots, t });
  live.current = { groupIds, rootDir, onAdd, onMenu, slots, t };

  useEffect(() => {
    const mine = (groupId: string) => groupId === EMPTY_GROUP_ID || live.current.groupIds.includes(groupId);
    const open = (request: NewTabRequest, groupId: string): boolean => {
      const { rootDir: cwd, onAdd: add, onMenu: menu, slots: agentSlots, t: tr } = live.current;
      switch (request.kind) {
        case "menu":
          return menu(groupId);
        case "monitor":
          add({ label: tr("newTabMenu.itemSystemMonitor"), cmd: MONITOR_TAB_CMD, cwd, kind: "monitor" }, groupId);
          return true;
        case "shell":
          add(buildStaticTabSpec(SHELL_ITEM, cwd, "", tr), groupId);
          return true;
        case "agent": {
          const item = agentSlots()[request.slot]?.item;
          if (!item) return false;
          add(buildStaticTabSpec(onOwnLogin(item), cwd, "", tr), groupId);
          return true;
        }
      }
    };
    const onRequest = (e: Event) => {
      const { request, groupId } = (e as CustomEvent<NewTabShortcutDetail>).detail;
      if (mine(groupId) && open(request, groupId)) e.preventDefault();
    };
    // Steering's legend names the agents behind 1-9.
    const onSlots = (e: Event) => {
      const detail = (e as CustomEvent<NewTabSlotsDetail>).detail;
      if (!mine(detail.groupId)) return;
      detail.labels = live.current.slots().map((slot) => slot?.item.label ?? null);
    };
    window.addEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest);
    window.addEventListener(NEW_TAB_SLOTS_EVENT, onSlots);
    return () => {
      window.removeEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest);
      window.removeEventListener(NEW_TAB_SLOTS_EVENT, onSlots);
    };
  }, []);

  return null;
}
