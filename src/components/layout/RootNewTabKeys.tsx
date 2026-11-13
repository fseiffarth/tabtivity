import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import {
  NEW_TAB_SHORTCUT_EVENT,
  NEW_TAB_SLOTS_EVENT,
  ROOT_EMPTY_GROUP_ID,
  type NewTabRequest,
  type NewTabShortcutDetail,
  type NewTabSlotsDetail,
} from "../../lib/shortcuts/newTabChord";
import { SHELL_ITEMS, agentShortcutSlots, buildStaticTabSpec, onOwnLogin } from "../../lib/tabs/newTabItems";
import { ROOT_SCOPE, type TabEntry } from "../../stores/tabs";
import { MONITOR_TAB_CMD } from "../../stores/tabs/tabKinds";
import { useAddTabMenuData, type AddTabMenuSeed } from "../tabs/useAddTabMenuData";

const SHELL_ITEM = SHELL_ITEMS.find((i) => i.kind === "shell")!;

/**
 * The new-tab keys for subwindows no `TabBar` draws: Ctrl+Shift+N / M,
 * Ctrl+1-9, and steering's N / O / 1-9 / +. `newTabChord` addresses them to the
 * focused subwindow of the tabs steering walks (`steeringScope`), and this
 * answers for those subwindows the way `TabBar` answers for its own group: the
 * tab the + menu row would open, in that subwindow. Agents are the ones the
 * scope's + menu offers (`useAddTabMenuData`), on their own login; the Host
 * session is never a key, only its menu row.
 *
 * Renders nothing. `groupIds` are the subwindows it answers for; a request for
 * any other group passes by. `claimsEmpty`: also the `ROOT_EMPTY_GROUP_ID`
 * placeholder (an empty Root).
 *
 * Two hosts: Root's (`RootNewTabKeys`, mounted by `RootView`, so it listens
 * only while the view is up) and a popout window's (`DetachedCenterPanel`),
 * whose tabs are minted by the main window from the streamed `add` edit.
 */
export function NewTabKeys({
  scope,
  seed,
  groupIds,
  claimsEmpty = false,
  cwdFor,
  onAdd,
  onMenu,
}: {
  scope: string;
  /** A popout's one-time copy of its box and members (its stores are inert). */
  seed?: AddTabMenuSeed;
  groupIds: readonly string[];
  claimsEmpty?: boolean;
  /** Where a tab opened in `groupId` starts. */
  cwdFor: (groupId: string) => string;
  /** Add `spec` as a tab of the subwindow `groupId`; `besideActive`: right of
   *  its active tab (steering), not at the strip's end. */
  onAdd: (spec: Omit<TabEntry, "key">, groupId: string, besideActive: boolean) => void;
  /** Open (or close) the subwindow's + menu; false when its button is not drawn. */
  onMenu: (groupId: string, besideActive: boolean) => boolean;
}) {
  const t = useT();
  const { enabledAgents, installedCustom, customAgents, defaultAgentBin, agentOrder } = useAddTabMenuData(scope, { seed });
  const slots = () =>
    enabledAgents === null
      ? []
      : agentShortcutSlots({ installedBuiltins: enabledAgents, installedCmds: installedCustom, customAgents, defaultAgentBin, agentOrder });
  // Latest-render handlers behind one listener pair.
  const live = useRef({ groupIds, claimsEmpty, cwdFor, onAdd, onMenu, slots, t });
  live.current = { groupIds, claimsEmpty, cwdFor, onAdd, onMenu, slots, t };

  useEffect(() => {
    const mine = (groupId: string) =>
      (live.current.claimsEmpty && groupId === ROOT_EMPTY_GROUP_ID) || live.current.groupIds.includes(groupId);
    const open = (request: NewTabRequest, groupId: string, beside: boolean): boolean => {
      const { cwdFor: cwdOf, onAdd: add, onMenu: menu, slots: agentSlots, t: tr } = live.current;
      const cwd = cwdOf(groupId);
      switch (request.kind) {
        case "menu":
          return menu(groupId, beside);
        case "monitor":
          add({ label: tr("newTabMenu.itemSystemMonitor"), cmd: MONITOR_TAB_CMD, cwd, kind: "monitor" }, groupId, beside);
          return true;
        case "shell":
          add(buildStaticTabSpec(SHELL_ITEM, cwd, "", tr), groupId, beside);
          return true;
        case "agent": {
          const item = agentSlots()[request.slot]?.item;
          if (!item) return false;
          add(buildStaticTabSpec(onOwnLogin(item), cwd, "", tr), groupId, beside);
          return true;
        }
      }
    };
    const onRequest = (e: Event) => {
      const { request, groupId, besideActive } = (e as CustomEvent<NewTabShortcutDetail>).detail;
      if (mine(groupId) && open(request, groupId, !!besideActive)) e.preventDefault();
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

/**
 * The new-tab keys while the Root view is up: {@link NewTabKeys} for Root's
 * subwindows, with the root-allowed agents (`useAddTabMenuData(ROOT_SCOPE)`, as
 * the empty card's Start button reads them). Mounted by `RootView`, so it
 * listens only while the view is up.
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
  return (
    <NewTabKeys
      scope={ROOT_SCOPE}
      groupIds={groupIds}
      claimsEmpty
      cwdFor={() => rootDir}
      onAdd={(spec, groupId) => onAdd(spec, groupId)}
      onMenu={(groupId) => onMenu(groupId)}
    />
  );
}
