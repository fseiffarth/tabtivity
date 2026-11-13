import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePaneRects } from "./usePaneRects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useProjectsStore } from "../../stores/projects";
import { attentionStateClass, busyStateClass, useActivityStore } from "../../stores/activity";
import { useSettingsStore } from "../../stores/settings";
import {
  DEFAULT_MIN_SUBWINDOW_PX,
  EMPTY_GROUP_ID,
  ROOT_SCOPE,
  allGroups,
  findGroupOfTab,
  isPtyTabKind,
  useTabsStore,
  type DropEdge,
  type LayoutNode,
  type TabEntry,
} from "../../stores/tabs";
import { dividerFraction } from "../../stores/tabs/layoutTree";
import { canDuplicateTab, isSingletonTabKind } from "../../stores/tabs/tabKinds";
import { reopenClosedAgentTab, useClosedAgentTabs } from "../../stores/agents/closedAgentTabs";
import { closeTabInScope } from "../../lib/remote/closeRemoteTab";
import { noteTabClose } from "../../lib/tabs/closedTabSlot";
import { registerHostBoundTab } from "../../lib/remote/hostBound";
import { TAB_ACCENT } from "../../lib/tabs/newTabItems";
import { tabColorCss } from "../../lib/theme/tabColors";
import {
  clampFilesWidth,
  DEFAULT_GROUP_FILES_WIDTH,
  SubwindowFilesSidebar,
} from "../files/SubwindowFilesSidebar";
import { bindDragRelease, dragPlatform } from "../../lib/window/dragPlatform";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { CustomAgentDialog } from "../tabs/CustomAgentDialog";
import { NewTabMenu } from "../tabs/NewTabMenu";
import { ScrollingTabStrip } from "../tabs/ScrollingTabStrip";
import { TabScopeContext } from "../../lib/tabs/tabScopeContext";
import { TabPane } from "../tabs/TabPane";
import { TabAgentModeMarks, TabContinueButton, TabStatusMark, statusMarkSlots } from "../tabs/TabLocalityBadges";
import { pickEdge, previewInset } from "../tabs/dragGeometry";
import { dragPreviewLayout } from "../tabs/dragPreview";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { MenuShortcut } from "../common/MenuShortcut";
import { useDialogs } from "../common/PromptDialogs";
import { TabColorPicker } from "../tabs/TabColorPicker";
import { TabMarkBadge } from "../tabs/TabMarkBadge";
import { TabMarkMenuItems } from "../tabs/TabMarkMenuItems";
import { RootRightsBadge, type RootMcpRights } from "./RootRightsBadge";
import { RootStartAgent } from "./RootStartAgent";
import { RootRail } from "../cockpit/RootRail";
import { RootNewTabKeys } from "./RootNewTabKeys";
import { ROOT_EMPTY_GROUP_ID } from "../../lib/shortcuts/newTabChord";
import { CloseIcon, PencilIcon } from "../common/icons/Icon";


/** A rect relative to the overlay's pane region. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A tab drag inside the console. Local state rather than `stores/drag/drag`: that
 * store's `drag !== null` puts `CenterPanel` into drag mode, and the panel
 * under this modal is not what the tab is being dropped on.
 */
interface OverlayDrag {
  key: string;
  fromGroup: string;
  label: string;
  x: number;
  y: number;
  /** A strip slot: move into that group at `reorderIndex`. */
  reorderGroup: string | null;
  reorderIndex: number | null;
  /** Client x of the insertion marker for a strip slot. */
  markerX: number | null;
  /** A body: split off at `edge` (center = move into the group). */
  overGroup: string | null;
  edge: DropEdge | null;
}

/** Pixels a press must travel before it is a drag rather than a click. */
const DRAG_THRESHOLD_PX = 5;

const NO_TABS: TabEntry[] = [];

/** A group node's docked-file-viewer fields (`GroupNode`'s own three). */
type GroupFiles = Pick<
  Extract<LayoutNode, { type: "group" }>,
  "filesOpen" | "filesWidth" | "filesFolder"
>;

/**
 * The width a tab bar's control cluster reserves for the column docked under it,
 * so the ◫/× sit above the viewer and the scrolling strip stops at the pane's
 * edge — `TabBar`'s `filesReserveWidth`, applied to the console's own bars.
 */
function filesReserveStyle(files: GroupFiles | undefined): React.CSSProperties | undefined {
  if (!files?.filesOpen) return undefined;
  return { width: clampFilesWidth(files.filesWidth ?? DEFAULT_GROUP_FILES_WIDTH) };
}

/**
 * The shell's title bar, handed to the view: three slot elements the view
 * portals into (so the bar looks as it always did while its parts keep living
 * in the view's state), the bar's move / fill gestures for the strip, and a
 * setter for the control cluster's reserved width. The sub-bar (a row
 * under the title bar) hands the same shape.
 */
export interface RootBarSlots {
  /** After the star mark: the sole subwindow's tab strip and its +. */
  strip: HTMLElement | null;
  /** Before the ⚿ badge: the "Needs you N" chip of a narrow window (under 820 px). */
  chip: HTMLElement | null;
  /** In the control cluster: the ⚿ tools badge. */
  rights: HTMLElement | null;
  /** Before ⤢: the sole subwindow's ◫ file toggle. */
  files: HTMLElement | null;
  onBarPointerDown: (e: React.PointerEvent) => void;
  onBarDoubleClick: (e: React.MouseEvent) => void;
  /** The control cluster's style (the docked file column's reserved width). */
  setControlsStyle: (style: React.CSSProperties | undefined) => void;
}

/**
 * The root console's view. The root scope's layout is rendered as it is stored —
 * split into subwindows when it is split — and a tab dragged onto another
 * subwindow's strip moves there, onto a body's edge splits it off, exactly as
 * in a project's center panel. All of it writes the ROOT scope through the
 * store's `…InScope` actions, never the project on screen.
 *
 * Panes are a flat layer positioned over each group body's measured rect (the
 * `CenterPanel` arrangement), so a tab moving between subwindows repositions
 * its view instead of remounting it. They are attach-only views: the PTYs
 * belong to `CenterPanel`'s keep-alive layer, so closing the console ends
 * nothing.
 *
 * With a single subwindow its strip sits in the console's own title bar (the
 * shell's slot); once the layout is split every subwindow carries its own bar.
 *
 * Three things a floating window needs and this one lacked. Every subwindow
 * docks the **file viewer** on its right edge through the same ◫ a project's
 * subwindows carry (`SubwindowFilesSidebar` → `ProjectFilesTab`, so no fourth
 * copy of the viewer), rooted at `~/tabtivity/root` — the folder that belongs to no
 * project and until now could only be read with `ls` from inside the console.
 * The state is the group node's own (`filesOpen`/`filesWidth`/`filesFolder`),
 * written through the `…InScope` actions because root is not the active scope.
 * The window around it (frame, title bar, ✓ Approvals, Escape) is the shell's:
 * `RootOverlay`.
 */
export function RootView({
  rights,
  slots,
  busyRef,
}: {
  /** The ⚿ reading, fetched once by the shell (the ✓ pill's advisory needs it too). */
  rights: RootMcpRights;
  slots: RootBarSlots;
  /** Set while a menu, dialog or tab drag of the view is up — the shell's Escape defers. */
  busyRef: { current: boolean };
}) {
  const t = useT();
  const tabs = useTabsStore((s) => s.tabsByScope[ROOT_SCOPE] ?? NO_TABS);
  const layout = useTabsStore((s) => s.layoutByScope[ROOT_SCOPE] ?? null);
  const storedFocus = useTabsStore((s) => s.focusedGroupByScope[ROOT_SCOPE] ?? null);
  const rootDir = useProjectsStore((s) => s.rootDir) ?? "";
  const [addMenu, setAddMenu] = useState<{ x: number; y: number; groupId: string | null } | null>(
    null,
  );
  const [manageAgents, setManageAgents] = useState(false);
  const [drag, setDrag] = useState<OverlayDrag | null>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const bodyRefs = useRef(new Map<string, HTMLDivElement>());
  const stripRefs = useRef(new Map<string, HTMLDivElement>());

  const split = allGroups(layout).length > 1;
  // While a subwindow's lone tab is dragged, its subwindow is pruned from the
  // RENDERED tree so the siblings reflow at once (render-only, like CenterPanel).
  const dragKey = drag?.key ?? null;
  const dragFrom = drag?.fromGroup ?? null;
  const dragging = drag != null;
  const renderLayout = useMemo(
    () => dragPreviewLayout(layout, dragKey ? "tab" : null, dragKey, dragFrom, false),
    [layout, dragKey, dragFrom],
  );
  const groups = useMemo(() => allGroups(renderLayout), [renderLayout]);
  const focusedGroup =
    (storedFocus && groups.some((g) => g.id === storedFocus) ? storedFocus : null) ??
    groups[0]?.id ??
    null;
  // The single-subwindow strip in the title bar stands for the one group.
  const soleGroupId = split ? null : (allGroups(layout)[0]?.id ?? EMPTY_GROUP_ID);

  // What the shell's Escape must defer to (it cannot see this state).
  const busy = addMenu != null || manageAgents || dragging;
  useLayoutEffect(() => {
    busyRef.current = busy;
    return () => {
      busyRef.current = false;
    };
  }, [busy, busyRef]);

  // ── Measurement ─────────────────────────────────────────────────────────
  const { groupRects, measure } = usePaneRects(regionRef, bodyRefs, renderLayout);

  const registerBody = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) bodyRefs.current.set(id, el);
      else bodyRefs.current.delete(id);
    },
    [],
  );
  const registerStrip = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) stripRefs.current.set(id, el);
      else stripRefs.current.delete(id);
    },
    [],
  );

  // ── Tab drag ────────────────────────────────────────────────────────────
  /** What a release at client (x, y) would do. Measured rects, never
   *  `elementFromPoint` — the panes are opaque and WebKitGTK's is unreliable. */
  const resolveTarget = useCallback(
    (x: number, y: number) => {
      for (const [gid, strip] of stripRefs.current) {
        if (!strip.isConnected) continue;
        const r = strip.getBoundingClientRect();
        // The whole bar height counts, so a drop just under the tabs still lands.
        const bar = strip.closest(".tab-bar")?.getBoundingClientRect() ?? r;
        if (x < r.left || x > r.right || y < bar.top || y > bar.bottom) continue;
        const tabEls = Array.from(strip.querySelectorAll<HTMLElement>(".tab"));
        let slot = tabEls.length;
        let markerX = tabEls.length ? tabEls[tabEls.length - 1].getBoundingClientRect().right : r.left;
        for (let i = 0; i < tabEls.length; i++) {
          const tr = tabEls[i].getBoundingClientRect();
          if (x < tr.left + tr.width / 2) {
            slot = i;
            markerX = tr.left;
            break;
          }
        }
        return {
          reorderGroup: gid,
          reorderIndex: slot,
          markerX,
          overGroup: null,
          edge: null,
        };
      }
      const region = regionRef.current;
      if (region) {
        const base = region.getBoundingClientRect();
        const px = x - base.left;
        const py = y - base.top;
        for (const [gid, r] of Object.entries(groupRects)) {
          if (px >= r.left && px <= r.left + r.width && py >= r.top && py <= r.top + r.height) {
            return {
              reorderGroup: null,
              reorderIndex: null,
              markerX: null,
              overGroup: gid,
              edge: pickEdge(r, px, py),
            };
          }
        }
      }
      return { reorderGroup: null, reorderIndex: null, markerX: null, overGroup: null, edge: null };
    },
    [groupRects],
  );
  const resolveRef = useRef(resolveTarget);
  resolveRef.current = resolveTarget;

  const startTabDrag = useCallback((e: React.PointerEvent, tab: TabEntry, groupId: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".tab-close")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    let latest: OverlayDrag | null = null;
    const captureEl = document.documentElement;
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
        active = true;
      }
      latest = {
        key: tab.key,
        fromGroup: groupId,
        label: tab.label,
        x: ev.clientX,
        y: ev.clientY,
        ...resolveRef.current(ev.clientX, ev.clientY),
      };
      setDrag(latest);
    };
    const teardown = () => {
      window.removeEventListener("pointermove", onMove);
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.releasePointerCapture(e.pointerId);
        } catch {
          /* capture already gone */
        }
      }
      setDrag(null);
    };
    // Bound synchronously inside pointerdown: WebKitGTK only delivers the
    // terminal event to listeners that existed before the gesture began.
    bindDragRelease({
      onCommit: () => {
        teardown();
        if (active && latest) commitOverlayDrop(latest);
      },
      onAbort: teardown,
    });
    window.addEventListener("pointermove", onMove);
    if (dragPlatform.needsPointerCapture) {
      try {
        captureEl.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is not active any more */
      }
    }
  }, []);

  const openAddMenu = (anchor: DOMRect, groupId: string | null) =>
    setAddMenu((cur) => (cur ? null : { x: anchor.left, y: anchor.bottom + 4, groupId }));

  const addTab = useCallback(
    (spec: Omit<TabEntry, "key">) => {
      const store = useTabsStore.getState();
      // A tab added from a subwindow's own "+" lands in that subwindow.
      if (addMenu?.groupId && addMenu.groupId !== EMPTY_GROUP_ID) {
        store.focusGroupInScope(ROOT_SCOPE, addMenu.groupId);
      }
      // `TabBar`'s ensure bargain, addressed to root: a kind whose second tab
      // would show exactly what the first shows (the system monitor, the print
      // queues, the skills catalog, the prompt chart) focuses the one that
      // exists rather than stacking a copy. `NewTabMenu` hands over a resolved
      // payload and no hint of which handler built it, so the rule is read off
      // the kind (`isSingletonTabKind`).
      //
      // `revealTabInScope` rather than `setActive`: root is not the active scope
      // while the console floats, and it answers whether it actually landed. A
      // false means that tab sits somewhere this console cannot show it — a
      // parked subwindow, a detached one — and then a "+" that focused nothing
      // would read as a broken button, so the console opens its own.
      if (isSingletonTabKind(spec.kind)) {
        const existing = store.tabsByScope[ROOT_SCOPE]?.find((t) => t.kind === spec.kind);
        if (existing && store.revealTabInScope(ROOT_SCOPE, existing.key)) return;
      }
      store.addTabToScope(ROOT_SCOPE, spec);
    },
    [addMenu],
  );

  /** The new-tab keys (`RootNewTabKeys`): open the + menu of one subwindow from
   *  its button's place, or add a tab to it. */
  const openMenuFor = (requested: string) => {
    // An empty Root's strip is registered under the placeholder id.
    const groupId = requested === ROOT_EMPTY_GROUP_ID ? EMPTY_GROUP_ID : requested;
    const button = stripRefs.current
      .get(groupId)
      ?.closest(".tab-bar")
      ?.querySelector<HTMLElement>(".tab-new-btn");
    if (!button) return false;
    openAddMenu(button.getBoundingClientRect(), groupId);
    return true;
  };
  const addTabTo = (spec: Omit<TabEntry, "key">, groupId: string) => {
    if (groupId !== ROOT_EMPTY_GROUP_ID) useTabsStore.getState().focusGroupInScope(ROOT_SCOPE, groupId);
    addTab(spec);
  };

  const groupOfKey = useMemo(() => {
    const map = new Map<string, { groupId: string; active: boolean }>();
    for (const g of groups) {
      for (const k of g.tabKeys) map.set(k, { groupId: g.id, active: g.activeKey === k });
    }
    return map;
  }, [groups]);
  const tabByKey = useMemo(() => new Map(tabs.map((tab) => [tab.key, tab])), [tabs]);

  /** The ◫ toggle of one subwindow's docked file viewer, addressed to ROOT. */
  const filesToggle = (groupId: string, open: boolean) => (
    <button
      className={`subwindow-files-toggle${open ? " open" : ""}`}
      title={open ? t("tabBar.filesToggleOpenTitle") : t("tabBar.filesToggleClosedTitle")}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        useTabsStore.getState().setGroupFilesInScope(ROOT_SCOPE, groupId, !open);
      }}
    >
      ◫
    </button>
  );

  const stripFor = (
    groupId: string,
    tabKeys: string[],
    activeKey: string | null,
    files?: GroupFiles,
  ) => (
    <>
        <GroupStrip
          groupId={groupId}
          tabs={tabKeys.map((k) => tabByKey.get(k)).filter((tab): tab is TabEntry => !!tab)}
          activeKey={activeKey}
          draggingKey={drag?.key ?? null}
          stripRef={registerStrip(groupId)}
          onTabPointerDown={startTabDrag}
        />
        <div className="tab-new-wrap">
          <button
            className="tab-new-btn"
            title={t("detachedTabs.newTab")}
            onClick={(e) => openAddMenu(e.currentTarget.getBoundingClientRect(), groupId)}
          >
            +
          </button>
        </div>
        {/* Split, every subwindow carries its own bar and therefore its own ◫;
            unsplit, the toggle sits in the console's title bar beside the ×. */}
        {split && groupId !== EMPTY_GROUP_ID && (
          <div className="tab-controls" style={filesReserveStyle(files)}>
            {filesToggle(groupId, !!files?.filesOpen)}
          </div>
        )}
    </>
  );

  /** The docked file column of one subwindow — the SAME component the center
   *  panel's subwindows dock (`ProjectFilesTab` under it), rooted at
   *  `~/tabtivity/root`: the folder that belongs to no project. */
  const filesColumn = (group: GroupFiles & { id: string }) => (
    <SubwindowFilesSidebar
      scope={ROOT_SCOPE}
      cwd={rootDir}
      viewerId={`group:${group.id}`}
      width={group.filesWidth}
      onWidthChange={(w) =>
        useTabsStore.getState().setGroupFilesWidthInScope(ROOT_SCOPE, group.id, w)
      }
      folder={group.filesFolder}
      onFolderChange={(f) =>
        useTabsStore.getState().setGroupFilesFolderInScope(ROOT_SCOPE, group.id, f)
      }
      onHide={() => useTabsStore.getState().setGroupFilesInScope(ROOT_SCOPE, group.id, false)}
      canOpenTabs
    />
  );

  const sole = soleGroupId ? (allGroups(layout)[0] ?? null) : null;
  const soleFiles = !split && !!sole?.filesOpen;
  // The unsplit strip's docked file column widens the title bar's control
  // cluster by the same amount, so the ◫/× sit above the viewer.
  const { setControlsStyle } = slots;
  const reserveWidth = soleFiles ? filesReserveStyle(sole ?? undefined)?.width : undefined;
  useLayoutEffect(() => {
    setControlsStyle(reserveWidth == null ? undefined : { width: reserveWidth });
    return () => setControlsStyle(undefined);
  }, [reserveWidth, setControlsStyle]);
  const previewRect =
    drag?.overGroup && drag.edge ? groupRects[drag.overGroup] : undefined;

  // Everything inside opens its tabs in ROOT: the file column's double-clicks,
  // a Files tab's "Open in a new tab", a viewer's links and compiled PDFs. Root
  // is not the active scope while the console floats, and the plain `addTab`
  // those paths default to would file them onto the project underneath.
  //
  // The strip, the ⚿ badge and the ◫ toggle belong to the window's title bar,
  // which the shell owns: they are portaled into its slots, so this view's
  // state (tab drag, the + menu) stays here. A portal bubbles React events
  // through the view, not the bar, so the strip's slot forwards the bar's
  // press-to-move and double-click-to-fill itself.
  return (
    <TabScopeContext.Provider value={ROOT_SCOPE}>
      {slots.strip &&
        soleGroupId &&
        createPortal(
          <div
            className="root-overlay-slot"
            onPointerDown={slots.onBarPointerDown}
            onDoubleClick={slots.onBarDoubleClick}
          >
            {stripFor(soleGroupId, sole?.tabKeys ?? [], sole?.activeKey ?? null)}
          </div>,
          slots.strip,
        )}
      {slots.rights && createPortal(<RootRightsBadge rights={rights} />, slots.rights)}
      {slots.files &&
        !split &&
        soleGroupId &&
        soleGroupId !== EMPTY_GROUP_ID &&
        createPortal(filesToggle(soleGroupId, !!sole?.filesOpen), slots.files)}
      <div className="subwindow-body">
        <RootRail chipSlot={slots.chip} />
        <div
            className={`subwindow-pane-region root-overlay-region${dragging ? " dragging" : ""}`}
            ref={regionRef}
          >
          {tabs.length === 0 || !renderLayout ? (
            <div className="center-placeholder" style={{ height: "100%" }}>
              <div className="center-placeholder-card">
                <div className="center-placeholder-title">{t("rootConsole.emptyTitle")}</div>
                <div className="center-placeholder-hint">{t("rootConsole.emptyHint")}</div>
                <RootStartAgent rootDir={rootDir} onStart={addTab} />
              </div>
            </div>
          ) : (
            <>
              <div className="root-overlay-layout">
                <OverlayTree
                  node={renderLayout}
                  split={split}
                  focusedGroup={focusedGroup}
                  registerBody={registerBody}
                  onResized={measure}
                  stripFor={stripFor}
                  filesColumn={filesColumn}
                />
              </div>
              <div className="pane-layer">
                {tabs.map((tab) => {
                  const place = groupOfKey.get(tab.key);
                  const visible = !!place?.active;
                  const rect = place ? groupRects[place.groupId] : undefined;
                  const style: React.CSSProperties = !visible
                    ? { display: "none" }
                    : rect
                      ? { display: "flex", left: rect.left, top: rect.top, width: rect.width, height: rect.height }
                      : { display: "flex", left: 0, top: 0, right: 0, bottom: 0 };
                  return (
                    <div
                      key={tab.key}
                      className="center-pane"
                      data-tab-key={tab.key}
                      style={style}
                      onMouseDownCapture={() => {
                        if (place && place.groupId !== focusedGroup) {
                          useTabsStore.getState().focusGroupInScope(ROOT_SCOPE, place.groupId);
                        }
                      }}
                    >
                      {/* Attach-only, like a popout's panes: the PTY belongs to
                          the root tab's own pane in CenterPanel's keep-alive
                          layer, so closing the overlay ends nothing. */}
                      <TabPane
                        tab={tab}
                        scope={ROOT_SCOPE}
                        visible={visible}
                        focused={visible && place?.groupId === focusedGroup && !addMenu && !drag}
                        attachOnly
                        filesProjectDir={tab.cwd || rootDir}
                        terminalCwd={tab.cwd || rootDir}
                      />
                    </div>
                  );
                })}
              </div>
              {previewRect && drag?.edge && <SplitPreview rect={previewRect} edge={drag.edge} />}
            </>
          )}
        </div>
        {/* Unsplit, the sole subwindow's docked file column sits here, BESIDE
            the measured pane region (the `Subwindow` arrangement) — so the
            region shrinks and the flat pane layer, sized to its rect, never
            paints over the viewer. Split, each subwindow docks its own. */}
        {soleFiles && sole && filesColumn(sole)}
      </div>
    {drag &&
      createPortal(
        <>
          <div className="tab-drag-ghost" style={{ left: drag.x, top: drag.y }}>
            <div className="tab-drag-ghost-label">{drag.label}</div>
          </div>
          {drag.markerX != null && drag.reorderGroup && (
            <StripMarker x={drag.markerX} strip={stripRefs.current.get(drag.reorderGroup)} />
          )}
        </>,
        document.body,
      )}
    <RootNewTabKeys groupIds={groups.map((g) => g.id)} rootDir={rootDir} onAdd={addTabTo} onMenu={openMenuFor} />
    {addMenu && (
      <NewTabMenu
        scope={ROOT_SCOPE}
        projectCwd={rootDir}
        projectName=""
        anchor={addMenu}
        onPick={addTab}
        onClose={() => setAddMenu(null)}
        onManageAgents={() => setManageAgents(true)}
      />
    )}
    {manageAgents && <CustomAgentDialog onClose={() => setManageAgents(false)} />}
    </TabScopeContext.Provider>
  );
}

/**
 * Apply a finished console drag to the ROOT scope — `tabs/commitDrop`'s rules,
 * addressed to a named scope: a strip slot reorders (same subwindow) or moves
 * the tab over; a body edge splits it off; a body's centre moves it in.
 */
function commitOverlayDrop(d: Pick<OverlayDrag, "key" | "fromGroup" | "reorderGroup" | "reorderIndex" | "overGroup" | "edge">) {
  const store = useTabsStore.getState();
  if (d.reorderGroup && d.reorderIndex != null) {
    const found = findGroupOfTab(store.layoutByScope[ROOT_SCOPE] ?? null, d.key);
    if (!found) return;
    if (found.group.id === d.reorderGroup) {
      // The slot counts the dragged tab still in place; the move is addressed
      // without it.
      const to = found.index < d.reorderIndex ? d.reorderIndex - 1 : d.reorderIndex;
      if (to !== found.index && to >= 0) store.moveTabInScope(ROOT_SCOPE, d.key, d.reorderGroup, to);
    } else {
      store.moveTabInScope(ROOT_SCOPE, d.key, d.reorderGroup, d.reorderIndex);
    }
    return;
  }
  if (!d.overGroup || !d.edge) return;
  if (d.edge === "center") {
    if (d.overGroup !== d.fromGroup) store.moveTabInScope(ROOT_SCOPE, d.key, d.overGroup);
    return;
  }
  store.splitWithTabInScope(ROOT_SCOPE, d.key, d.overGroup, d.edge);
}

function GroupStrip({
  groupId,
  tabs,
  activeKey,
  draggingKey,
  stripRef,
  onTabPointerDown,
}: {
  groupId: string;
  tabs: TabEntry[];
  activeKey: string | null;
  draggingKey: string | null;
  stripRef: (el: HTMLDivElement | null) => void;
  onTabPointerDown: (e: React.PointerEvent, tab: TabEntry, groupId: string) => void;
}) {
  const t = useT();
  const busyByTab = useActivityStore((s) => s.busyByTab);
  const busyKindByTab = useActivityStore((s) => s.busyKindByTab);
  const attentionByTab = useActivityStore((s) => s.attentionByTab);
  const clearAttention = useActivityStore((s) => s.clearAttention);
  // Tabs a one-click install opened pulse until clicked, so the user can tell
  // which of the console's tabs is running what they just asked for.
  const installTabs = useRootOverlayStore((s) => s.installTabs);
  const clearInstallTab = useRootOverlayStore((s) => s.clearInstallTab);
  const closedAgentTabs = useClosedAgentTabs(ROOT_SCOPE);
  const { promptText, dialogs } = useDialogs();
  const [tabMenu, setTabMenu] = useState<{ key: string; index: number; x: number; y: number } | null>(null);
  const menuTab = tabMenu ? tabs.find((tb) => tb.key === tabMenu.key) : undefined;

  // The explicit close the main window's × and menu make (`closeTabInScope`):
  // a resumable agent tab is kept for "Reopen closed tab", a minted local tmux
  // session ends with it.
  function closeTab(key: string) {
    clearInstallTab(key);
    closeTabInScope(ROOT_SCOPE, key);
  }
  // `TabBar`'s menu, minus what the console has no home for: tab groups (this
  // strip draws no group chips) and Schedule prompt (root-console scheduling is
  // outside v1, `docs/context/agent_schedule_mcp.md`). The strip has no inline
  // label editor, so Rename asks through a dialog like the popout's.
  async function renameTab(key: string) {
    setTabMenu(null);
    const tab = tabs.find((tb) => tb.key === key);
    if (!tab) return;
    const label = await promptText({
      title: t("common.rename"),
      label: t("tabBar.renameAriaLabel"),
      initial: tab.label,
      unchanged: tab.label,
    });
    if (label) useTabsStore.getState().renameTabInScope(ROOT_SCOPE, key, label);
  }
  async function duplicateTab(key: string) {
    setTabMenu(null);
    const source = tabs.find((tb) => tb.key === key);
    if (!source) return;
    const overrides = source.hostBoundUid
      ? { hostBoundUid: await registerHostBoundTab(ROOT_SCOPE) }
      : undefined;
    useTabsStore.getState().duplicateTab(key, overrides);
  }

  // The shared strip, so an overflowing console bar scrolls with the same
  // chevrons as every other tab bar.
  return (
    <>
    <ScrollingTabStrip
      revision={tabs.map((tab) => tab.key).join(",")}
      activeKey={activeKey ?? undefined}
      stripRef={stripRef}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.key === activeKey;
        const ptyId = `${ROOT_SCOPE}:${tab.key}`;
        const isAgent = tab.kind === "agent" || tab.kind === "local_agent";
        // The strip's own status rules (TabBar / the popout strip).
        const working = isPtyTabKind(tab.kind) && !!busyByTab[ptyId];
        const rawAttn = isAgent ? (attentionByTab[ptyId] ?? null) : null;
        const attn = !isActive || rawAttn === "decision" ? rawAttn : null;
        const stateClass = working
          ? busyStateClass(busyKindByTab[ptyId], tab.kind)
          : attentionStateClass(attn);
        const install = !!installTabs[tab.key];
        // A user-set colour replaces the kind colour, as on `TabBar`'s tabs.
        const userColor = tabColorCss(tab.color);
        const style = { "--tab-accent": userColor ?? TAB_ACCENT[tab.kind] } as React.CSSProperties;
        return (
          <div
            key={tab.key}
            className={`tab ${isActive ? "active" : ""}${stateClass}${userColor ? " has-tab-color" : ""}${
              install ? " install-pending" : ""
            }${draggingKey === tab.key ? " dragging" : ""}`}
            style={style}
            title={install ? t("rootConsole.installTabTitle") : undefined}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setTabMenu({ key: tab.key, index, x: e.clientX, y: e.clientY });
            }}
            onPointerDown={(e) => onTabPointerDown(e, tab, groupId)}
            onMouseDown={() => {
              if (isActive) clearAttention(ptyId);
              if (install) clearInstallTab(tab.key);
              if (groupId === EMPTY_GROUP_ID) return;
              useTabsStore.getState().setGroupActiveInScope(ROOT_SCOPE, groupId, tab.key);
            }}
          >
            <TabStatusMark stateClass={stateClass} slots={statusMarkSlots(tab.kind)} />
            <span className="tab-label">{tab.label}</span>
            <TabMarkBadge tab={tab} />
            <TabAgentModeMarks scope={ROOT_SCOPE} tab={tab} isActive={isActive} />
            <TabContinueButton tab={tab} stateClass={stateClass} />
            {install && <UntestedTag id="rootConsole.installTabTitle" />}
            <button
              className="tab-close"
              title={t("detachedTabs.closeTab")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                noteTabClose(e.currentTarget);
                closeTab(tab.key);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </ScrollingTabStrip>
    {tabMenu && menuTab && (
      <ContextMenuPortal
        x={tabMenu.x}
        y={tabMenu.y}
        onClose={() => setTabMenu(null)}
        className="tab-new-menu"
      >
        <button className="tab-new-menu-item" onClick={() => void renameTab(menuTab.key)}>
          <span className="tab-new-menu-dot tab-new-menu-dot--accent"><PencilIcon /></span>
          {t("common.rename")}
          <UntestedTag id="rootConsole.tabMenu" />
        </button>
        <TabColorPicker
          current={menuTab.color}
          onPick={(color) => useTabsStore.getState().setTabColorInScope(ROOT_SCOPE, menuTab.key, color)}
        />
        <TabMarkMenuItems tab={menuTab} scope={ROOT_SCOPE} onDone={() => setTabMenu(null)} />
        {canDuplicateTab(menuTab) && (
          <button className="tab-new-menu-item" onClick={() => void duplicateTab(menuTab.key)}>
            <span className="tab-new-menu-dot tab-new-menu-dot--accent">⧉</span>
            {t("tabBar.duplicate")}
            <UntestedTag id="tabBar.1" />
          </button>
        )}
        <button
          className="tab-new-menu-item"
          onClick={() => {
            setTabMenu(null);
            closeTab(menuTab.key);
          }}
        >
          <span className="tab-new-menu-dot tab-new-menu-dot--danger"><CloseIcon /></span>
          {t("common.close")}
          <MenuShortcut chord="closeTab" />
        </button>
        <button
          className="tab-new-menu-item"
          disabled={tabs.length <= 1}
          onClick={() => {
            setTabMenu(null);
            tabs.filter((tb) => tb.key !== menuTab.key).forEach((tb) => closeTab(tb.key));
          }}
        >
          <span className="tab-new-menu-dot tab-new-menu-dot--danger"><CloseIcon /></span>
          {t("tabBar.closeOthers")}
        </button>
        <button
          className="tab-new-menu-item"
          disabled={tabMenu.index === 0}
          onClick={() => {
            setTabMenu(null);
            tabs.slice(0, tabMenu.index).forEach((tb) => closeTab(tb.key));
          }}
        >
          <span className="tab-new-menu-dot tab-new-menu-dot--danger"><CloseIcon /></span>
          {t("tabBar.closeToLeft")}
        </button>
        <button
          className="tab-new-menu-item"
          disabled={tabMenu.index === tabs.length - 1}
          onClick={() => {
            setTabMenu(null);
            tabs.slice(tabMenu.index + 1).forEach((tb) => closeTab(tb.key));
          }}
        >
          <span className="tab-new-menu-dot tab-new-menu-dot--danger"><CloseIcon /></span>
          {t("tabBar.closeToRight")}
        </button>
        {closedAgentTabs.length > 0 && (
          <button
            className="tab-new-menu-item"
            title={t("tabBar.reopenClosedTitle", { label: closedAgentTabs[0].tab.label })}
            onClick={() => {
              setTabMenu(null);
              reopenClosedAgentTab(ROOT_SCOPE);
            }}
          >
            <span className="tab-new-menu-dot tab-new-menu-dot--accent">↺</span>
            {t("tabBar.reopenClosed")}
            <UntestedTag id="tabBar.reopenClosed" />
            <MenuShortcut chord="reopenClosedTab" />
          </button>
        )}
      </ContextMenuPortal>
    )}
    {dialogs}
    </>
  );
}

interface TreeProps {
  node: LayoutNode;
  split: boolean;
  focusedGroup: string | null;
  registerBody: (id: string) => (el: HTMLDivElement | null) => void;
  onResized: () => void;
  stripFor: (
    groupId: string,
    tabKeys: string[],
    activeKey: string | null,
    files?: GroupFiles,
  ) => React.ReactNode;
  filesColumn: (group: GroupFiles & { id: string }) => React.ReactNode;
}

function OverlayTree(props: TreeProps) {
  const { node } = props;
  if (node.type === "split") return <OverlaySplit {...props} node={node} />;
  // Unsplit, the strip lives in the console's title bar; the group is its body.
  if (!props.split) {
    return <div className="subwindow-pane-slot" ref={props.registerBody(node.id)} />;
  }
  return (
    <div
      className={`subwindow root-overlay-group${props.focusedGroup === node.id ? " focused" : ""}`}
      onMouseDownCapture={() => {
        if (props.focusedGroup !== node.id) useTabsStore.getState().focusGroupInScope(ROOT_SCOPE, node.id);
      }}
    >
      <div className="tab-bar">{props.stripFor(node.id, node.tabKeys, node.activeKey, node)}</div>
      <div className="subwindow-body">
        <div className="subwindow-pane-region">
          <div className="subwindow-pane-slot" ref={props.registerBody(node.id)} />
        </div>
        {node.filesOpen && props.filesColumn(node)}
      </div>
    </div>
  );
}

/** A split of the root layout: `CenterPanel`'s SplitView, addressed to root. */
function OverlaySplit(props: TreeProps & { node: Extract<LayoutNode, { type: "split" }> }) {
  const { node } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const childRefs = useRef(new Map<number, HTMLDivElement>());
  const minWidth = useSettingsStore((s) => s.settings?.min_subwindow_width) ?? DEFAULT_MIN_SUBWINDOW_PX;
  const minHeight = useSettingsStore((s) => s.settings?.min_subwindow_height) ?? DEFAULT_MIN_SUBWINDOW_PX;

  const startDivider = (dividerIndex: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const isRow = node.dir === "row";
    let fraction: number | null = null;
    let raf: number | null = null;
    const onMove = (ev: PointerEvent) => {
      const total = isRow ? rect.width : rect.height;
      if (total <= 0) return;
      const pos = isRow ? ev.clientX - rect.left : ev.clientY - rect.top;
      fraction = dividerFraction(node, dividerIndex, pos, total, isRow ? minWidth : minHeight);
      const pair = node.sizes[dividerIndex] + node.sizes[dividerIndex + 1];
      const a = childRefs.current.get(dividerIndex);
      const b = childRefs.current.get(dividerIndex + 1);
      if (a) a.style.flex = `${fraction} 1 0`;
      if (b) b.style.flex = `${pair - fraction} 1 0`;
      if (raf == null) {
        raf = requestAnimationFrame(() => {
          raf = null;
          props.onResized();
        });
      }
    };
    const teardown = () => {
      window.removeEventListener("pointermove", onMove);
      if (raf != null) cancelAnimationFrame(raf);
    };
    bindDragRelease({
      onCommit: () => {
        teardown();
        if (fraction != null) {
          useTabsStore.getState().resizeSplitInScope(ROOT_SCOPE, node.id, dividerIndex, fraction);
        }
        props.onResized();
      },
      onAbort: () => {
        teardown();
        for (const [i, el] of childRefs.current) {
          if (node.sizes[i] != null) el.style.flex = `${node.sizes[i]} 1 0`;
        }
        props.onResized();
      },
    });
    window.addEventListener("pointermove", onMove);
  };

  return (
    <div
      ref={containerRef}
      className={`split split-${node.dir}`}
      style={{ flexDirection: node.dir === "row" ? "row" : "column" }}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <div
            className="split-child"
            ref={(el) => {
              if (el) childRefs.current.set(i, el);
              else childRefs.current.delete(i);
            }}
            style={{ flex: `${node.sizes[i] ?? 1} 1 0` }}
          >
            <OverlayTree {...props} node={child} />
          </div>
          {i < node.children.length - 1 && (
            <div
              className={`split-divider split-divider-${node.dir}`}
              onPointerDown={startDivider(i)}
              onDoubleClick={() => {
                const a = node.children[i];
                const b = node.children[i + 1];
                if (a.type === "group" && b.type === "group") {
                  useTabsStore.getState().mergeGroupsInScope(ROOT_SCOPE, a.id, b.id);
                }
              }}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function SplitPreview({ rect, edge }: { rect: Rect; edge: DropEdge }) {
  const ins = previewInset(edge);
  return (
    <div
      className="split-preview"
      style={{
        left: rect.left + ins.left * rect.width,
        top: rect.top + ins.top * rect.height,
        width: rect.width * (1 - ins.left - ins.right),
        height: rect.height * (1 - ins.top - ins.bottom),
      }}
    />
  );
}

/** Where a strip drop lands: a thin accent line at the slot. */
function StripMarker({ x, strip }: { x: number; strip: HTMLDivElement | undefined }) {
  const r = strip?.getBoundingClientRect();
  if (!r) return null;
  return <div className="root-overlay-strip-marker" style={{ left: x - 1, top: r.top + 2, height: r.height - 4 }} />;
}
