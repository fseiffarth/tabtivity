import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  snapshotFrame,
  physToClient,
  clientToPhys,
  desktopCursor,
  type PhysPoint,
  type WindowFrame,
} from "../../lib/window/coords";
import { bindDragRelease, dragPlatform, PLATFORM } from "../../lib/window/dragPlatform";
import {
  DETACHED_DROP_CLAIM,
  DETACHED_DROP_PROBE,
  awaitPointerClaim,
  installPointerTracker,
  newDropToken,
  type DetachedDropClaim,
  type DetachedDropProbe,
} from "../../lib/window/dropClaim";
import {
  DETACHED_DRAG_END,
  DETACHED_DRAG_MOVE,
  DETACHED_DRAG_START,
  DETACHED_PANES,
  DETACHED_PANES_REQUEST,
  decideTitlebarPress,
  detachedDropPreviewEvent,
  type DetachedDragEnd,
  type DetachedDragMove,
  type DetachedDragStart,
  type DetachedDropPreview,
  type DetachedPanes,
  type DetachedPanesRequest,
  type PaneRect,
  type TitlebarPress,
} from "../../stores/detached";
import { clearStrayFullscreen, windowFillsScreen } from "../../lib/window/strayFullscreen";
import { toggleWindowFullscreen, useFullscreenMode } from "../../lib/window/fullscreenMode";
import { FileDropContext, type FileDropController } from "../files/fileDropContext";
import { fileDropPayloads } from "../tabs/commitFileDrop";
import { TabPane } from "../tabs/TabPane";
import {
  clampFilesWidth,
  DEFAULT_GROUP_FILES_WIDTH,
  SubwindowFilesSidebar,
} from "../files/SubwindowFilesSidebar";
import { useWindowFocused } from "../../hooks/useWindowFocused";
import { TabHoverCard } from "../tabs/TabHoverCard";
import { useFastMode } from "../../lib/agents/fastMode";
import { WindowControls } from "../header/WindowControls";
import { DragGhost, SplitPreviewOverlay } from "./CenterPanel";
import { TabDropPlaceholder } from "../tabs/TabDropPlaceholder";
import { NewTabMenu } from "../tabs/NewTabMenu";
import { CustomAgentDialog } from "../tabs/CustomAgentDialog";
import { TabColorPicker } from "../tabs/TabColorPicker";
import { TabMarkBadge } from "../tabs/TabMarkBadge";
import { TabMarkMenuItems } from "../tabs/TabMarkMenuItems";
import { TabStackChip } from "../tabs/TabStackChip";
import { stackNames, stripItems } from "../../lib/tabStacks";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { tabColorCss, type TabColor } from "../../lib/theme/tabColors";
import { pickEdge } from "../tabs/dragGeometry";
import {
  chordMatches,
  resolveChord,
  type ShortcutAction,
  type ShortcutMap,
} from "../../lib/shortcuts/shortcuts";
import {
  editorMayTakeChord,
  isEditableTarget,
  isMacCommandChord,
} from "../../hooks/useKeyboard";
import { isPaneTerminalTarget, terminalMayTakeChord } from "../../lib/shortcuts/terminalTabChord";
import { useDragStore } from "../../stores/drag/drag";
import { useTabLandStore } from "../../stores/drag/tabLand";
import { useSettingsStore } from "../../stores/settings";
import {
  DEFAULT_MIN_SUBWINDOW_PX,
  allGroups,
  dividerFraction,
  findGroup,
  findGroupOfTab,
  isPtyTabKind,
  type DetachedDockTarget,
  type DropEdge,
  type GroupNode,
  type LayoutNode,
  type SplitNode,
  type TabEntry,
  type TabLocation,
} from "../../stores/tabs";
import { attentionStateClass, busyStateClass, useActivityStore } from "../../stores/activity";
import { detachedNewTabCwd, type DetachedRemoteInfo } from "../../stores/detached";
import {
  TabAgentModeMarks,
  TabSourceBadge,
  TabStatusMark,
  TabTexLinkBadge,
  TabLocalityBadge,
  LocalityMenu,
  tabLocation,
  type LocalityMenuState,
} from "../tabs/TabLocalityBadges";
import { texPdfPartner } from "../../lib/viewers/tex/texPdfLink";
import { useT } from "../../lib/i18n";
import { StarIcon } from "./StarIcon";
import { AgentScheduleDialog } from "../agents/AgentScheduleDialog";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { UntestedTag } from "../common/UntestedTag";
import { ScrollingTabStrip } from "../tabs/ScrollingTabStrip";
import { nextScheduleOccurrence } from "../../lib/agents/agentSchedule";

/** Pixel coordinates of a group body, relative to the detached center panel. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Props {
  scope: string;
  /** The detached popout's identity (the main store's detached record id). Used
   *  for the cross-window drag protocol — NOT the inner group ids. */
  popoutId: string;
  /** The popout's content layout. A single group, or a split tree once the user
   *  splits panes inside the popout (multi-pane popouts). */
  tree: LayoutNode;
  /** All of the popout's tab payloads (across every group in the tree). */
  tabs: TabEntry[];
  /** The owning project's remoteness (machines + primary host name), streamed in
   *  the seed. Drives the per-tab locality badge/menu; undefined = local project
   *  (no locality axis, no badge — parity with a local main-window strip). */
  remoteInfo?: DetachedRemoteInfo;
  /** Whether this OS window is on screen at all (#239). A parked or minimised
   *  popout must stop streaming its terminals and polling its file views — panes
   *  compose their own visibility with this. */
  windowVisible?: boolean;
  /** Report which pane is current, so the window's store seam can land a new tab
   *  (a Ctrl+clicked link, an install) in the pane the user is working in. */
  onFocusedGroup?: (groupId: string | null) => void;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** Dock the WHOLE popout back into the main window's tiled layout (#237) —
   *  the ⤓ in the title bar. Closes this OS window; the tabs return live, PTYs
   *  intact. Undefined ⇒ no dock affordance. */
  onDockWindow?: () => void;
  /** Hide the WHOLE popout into the main window's side-panel "Hidden subwindows"
   *  list (the detached twin of a main-window subwindow's "–" hide). Closes this
   *  OS window; the group is parked with its tabs mounted and restored from there.
   *  Undefined ⇒ no hide affordance. */
  onHideWindow?: () => void;
  /** Multi-host: change where a locatable tab runs (streamed to the main window,
   *  which owns the PTY and respawns the pane on the chosen host). */
  onSetLocation: (key: string, location: TabLocation) => void;
  /** Reorder a bar's tabs (a tab dragged + dropped back onto its own bar). The
   *  main store resolves WHICH group from the key set. */
  onReorder: (tabKeys: string[]) => void;
  /** Rename a tab (right-click on the strip) — the `rename` edit, which existed
   *  from the start with nothing emitting it (#239). */
  onRename?: (key: string, label: string) => void;
  /** Paint a tab with a palette colour, or clear it (#264) — the `setColor`
   *  edit. Streamed like the rename above rather than applied here: the colour
   *  lives on the tab payload the MAIN window owns and persists. */
  onSetColor?: (key: string, color: TabColor | undefined) => void;
  /** Put a tab into a tab group of its bar, or take it out — the `setStack`
   *  edit, streamed like the colour above. */
  onSetStack?: (key: string, stack: string | undefined) => void;
  /** Split `key` into a new pane at `edge` of `targetGroupId`, inside the popout
   *  (a tab dragged onto a group BODY's edge). */
  onSplit: (key: string, targetGroupId: string, edge: DropEdge) => void;
  /** Resize the divider between children `dividerIndex`/`dividerIndex+1` of
   *  `splitId` inside the popout (a split divider drag). */
  onResize: (splitId: string, dividerIndex: number, fraction: number) => void;
  /** Merge `key` into `targetGroupId` (at `index`, else append) — a tab dragged
   *  onto ANOTHER group's bar (or body center) inside a split popout. */
  onMove: (key: string, targetGroupId: string, index?: number) => void;
  /** Create a new tab in `targetGroupId` — the popout's own "+" menu, or a file
   *  dropped onto a pane inside the popout. The detached window can't mint the
   *  key/own the PTY, so it streams the resolved payload to the main window, which
   *  creates the tab and re-seeds. A side `edge` carves a NEW pane at that edge (a
   *  file dropped on a body edge); omitted/"center" appends to the group. */
  onAddTab: (tab: Omit<TabEntry, "key">, targetGroupId: string, edge?: DropEdge) => void;
  /** Toggle/resize a group's docked file-viewer column (the per-subwindow right
   *  file viewer): applied optimistically popout-side and streamed to the main
   *  window so the flag persists (and survives a dock-back). */
  onFiles: (groupId: string, patch: { open?: boolean; width?: number; folder?: string }) => void;
}

/**
 * #42 / multi-pane: the detached window's center surface. A stripped CenterPanel
 * that renders the popout's layout TREE — each group as a tab bar + pane layer,
 * splits as flex rows/columns — with no project switcher, side panel, or
 * project-switch effects. Terminals run ATTACH-ONLY (the PTY is owned by the main
 * window's pane), so they never spawn or kill a PTY. Each group keeps every tab
 * mounted; only the active one shows.
 */
export function DetachedCenterPanel({
  scope,
  popoutId,
  tree,
  tabs,
  remoteInfo,
  windowVisible = true,
  onFocusedGroup,
  onActivate,
  onClose,
  onDockWindow,
  onHideWindow,
  onSetLocation,
  onReorder,
  onRename,
  onSetColor,
  onSetStack,
  onSplit,
  onResize,
  onMove,
  onAddTab,
  onFiles,
}: Props) {
  // The popout's "+" add-tab menu: which group opened it + where to anchor it.
  const t = useT();
  const [addMenu, setAddMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [scheduleDialogKey, setScheduleDialogKey] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  // Right-click on a tab-group chip: rename / ungroup.
  const [stackMenu, setStackMenu] = useState<{ x: number; y: number; name: string; groupId: string } | null>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  // Dismiss this strip's tab context menu on an outside click or Escape, the way
  // the main window's `TabBar` does. It used to close only when one of its rows
  // fired, which was survivable while every row was a one-shot action; the
  // colour picker (#264) deliberately stays open after a pick, so a menu opened
  // and left alone needs a way out that is not "pick something".
  useEffect(() => {
    if (!tabMenu) return;
    const onDown = (event: MouseEvent) => {
      if (tabMenuRef.current?.contains(event.target as Node)) return;
      setTabMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTabMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [tabMenu]);

  const schedulesByTarget = useAgentSchedulesStore((state) => state.byTarget);
  // Tab hover card anchor (the hovered tab's bottom-centre), mirroring the main
  // window's TabBar — the popout has its own tab strip, so it renders its own.
  // Fast mode drops the hover card: it carries its own ticking clock and
  // store subscriptions per hover, for detail the tab strip and the pane
  // itself already show.
  const fastMode = useFastMode();
  const [hoverTab, setHoverTab] = useState<{ key: string; x: number; y: number } | null>(null);
  // Multi-host locality menu (shared with TabBar). Machine names + the primary
  // host come from the streamed `remoteInfo`. Remoteness is the project's own
  // `remote` config, as the main window's `isRemoteScope` reads it — NOT the
  // seed's presence: since #232 every project scope (and a box) ships one, so
  // `!!remoteInfo` put the Local/Remote badge on every local project's tabs.
  const [localityMenu, setLocalityMenu] = useState<LocalityMenuState | null>(null);
  const isRemote = !!remoteInfo?.project?.remote;
  const primaryHost = remoteInfo?.primaryHost;
  const computeHosts = remoteInfo?.computeHosts;
  // One bar element per group, so a per-tab drag can hit-test the bar it's over.
  const barRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // One body element per group, for resolving an edge-split drop target.
  const bodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // The panel element, the coordinate origin for the split-preview overlay.
  const panelRef = useRef<HTMLDivElement>(null);
  // Measured group-body rects (panel-relative px) feeding the split-preview
  // overlay, which must paint ABOVE the per-group panes (opaque terminals) — so,
  // like the main window, it lives at the panel level rather than in a body.
  const [groupRects, setGroupRects] = useState<Record<string, Rect>>({});
  // Whole-subwindow rects (tab bar + pane region, sidebar excluded), used by the
  // focus frame so it wraps the current subwindow's tab header too — mirrors the
  // main window's `groupFrameRects`.
  const [groupFrameRects, setGroupFrameRects] = useState<Record<string, Rect>>({});
  // Minimum subwindow size (px) a divider drag may shrink a pane to, per axis.
  const minWidth = useSettingsStore((s) => s.settings?.min_subwindow_width) ?? DEFAULT_MIN_SUBWINDOW_PX;
  const minHeight = useSettingsStore((s) => s.settings?.min_subwindow_height) ?? DEFAULT_MIN_SUBWINDOW_PX;
  // #42 (main → detached): true while a tab dragged out of the MAIN window hovers
  // over THIS popout, so we paint a drop-target highlight. The main window streams
  // the toggle on our label-namespaced channel and commits the dock itself (it
  // owns the layout); we only render the cue. See `detachedDropPreviewEvent`.
  const [dropActive, setDropActive] = useState(false);
  // #42 (Windows): true while the popout is being moved by a NATIVE title-bar drag.
  // It swaps the heavy pane content (terminal canvases) for a cheap placeholder so
  // WebView2 has a trivial surface to composite during the OS modal move loop and
  // can keep up with the frame — the panes would otherwise visibly lag/swim behind
  // the moving frame. Set on the first `onMoved`, cleared on release (or when the
  // window stops moving), so a plain title-bar click never flashes the placeholder.
  const [windowDragging, setWindowDragging] = useState(false);
  // Within-bar reorder visuals, driven by THIS popout's own drag store (a
  // separate JS heap from the main window). While a tab is dragged, the dragged
  // tab collapses and a gap slides open at the live drop slot.
  const dragKey = useDragStore((s) => (s.drag ? s.drag.key : null));
  const reorderGroupId = useDragStore((s) => (s.drag ? s.drag.reorderGroup : null));
  const reorderIndex = useDragStore((s) => (s.drag ? s.drag.reorderIndex : null));
  // Label of the dragged tab, shown in the drop placeholder so the target bar
  // previews WHICH tab will land there — mirrors the main-window `TabBar`.
  const dragLabel = useDragStore((s) => (s.drag ? s.drag.label : ""));
  // One-shot "landing" flourish, driven by THIS popout's own tabLand store (a
  // separate JS heap from the main window). A tab merged/split/moved into a bar
  // inside the popout plays the same drop-in as the main window. `markLanded` is
  // fired from `handleLocalTabRelease` on the same cross-group rules `commitDrop`
  // uses (never on a same-group reorder).
  const landedKey = useTabLandStore((s) => s.landed?.key ?? null);

  useEffect(() => {
    for (const tab of tabs) {
      if ((tab.kind === "agent" || tab.kind === "local_agent") && tab.scheduleTargetId) {
        void useAgentSchedulesStore.getState().load(scope, tab.scheduleTargetId).catch(() => []);
      }
    }
    let stop: (() => void) | undefined;
    void listen("agent-schedules-changed", () => {
      void useAgentSchedulesStore.getState().refreshLoaded();
    }).then((unlisten) => { stop = unlisten; });
    return () => stop?.();
  }, [scope, tabs]);
  const landedNonce = useTabLandStore((s) => s.landed?.nonce ?? 0);
  const clearLanded = useTabLandStore((s) => s.clear);
  const byKey = new Map(tabs.map((t) => [t.key, t] as const));
  // Which group inside this popout is "current". A split popout otherwise
  // rendered every pane as `.focused` with no active-pane marker; mirror the main
  // window, where `focusedGroupId` drives the `.focus-frame` accent outline. The
  // detached window is inert to the main tabs store (separate JS heap, layout
  // streamed via props), so focus is tracked locally here.
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  // Only paint this popout's active subwindow while the popout itself owns OS
  // focus, so it and the main window never both highlight one at once (#42).
  const windowFocused = useWindowFocused();
  // Keep focus on a group that still exists as the tree changes (split added /
  // removed / docked back); default to the first group.
  useEffect(() => {
    const ids = allGroups(tree).map((g) => g.id);
    setFocusedGroupId((cur) => (cur && ids.includes(cur) ? cur : (ids[0] ?? null)));
  }, [tree]);
  // Publish it to the window's store seam (#231), so a link opened from a pane
  // lands in the pane it was opened from rather than always in the first one.
  useEffect(() => {
    onFocusedGroup?.(focusedGroupId);
  }, [focusedGroupId, onFocusedGroup]);

  // Per-tab lamps (#234), mirrored from the main window's classifier — the same
  // two maps `TabBar` reads, keyed by the composed PTY id.
  const busyByTab = useActivityStore((s) => s.busyByTab);
  const busyKindByTab = useActivityStore((s) => s.busyKindByTab);
  const attentionByTab = useActivityStore((s) => s.attentionByTab);
  const clearAttention = useActivityStore((s) => s.clearAttention);

  // ── Keyboard shortcuts (parity with the main window) ──────────────────────
  // The popout is a separate JS heap, inert to the tabs store, so the main
  // window's `useKeyboard` (which drives `useTabsStore`) can't run here. Instead
  // we handle the WINDOW-LOCAL chords against THIS popout's own layout + edit
  // protocol, resolving each chord through the SAME `shortcuts.ts` map (incl. the
  // user's overrides) so a rebound key behaves identically in both windows.
  //
  // Only the actions with a popout equivalent are wired: close tab, prev/next/
  // cycle tab, cycle subwindow focus, and F11 window fullscreen. The rest are
  // deliberately absent because the popout has no matching concept:
  // app-internal fullscreen, hide/close-subwindow (no such edit),
  // cycle-project / cycleProjectBack (a popout owns no project switcher), and
  // keyboard steering + shortcutHelp (main-window mode/overlays) — their
  // chords are simply never checked here, so pressing one in a popout falls
  // through as a clean no-op rather than entering a half-mode. Live values are read
  // through a ref so the window listener binds once and never churns on the
  // per-render identity of the edit callbacks.
  const kbRef = useRef({ tree, focusedGroupId, onActivate, onClose, onFiles });
  kbRef.current = { tree, focusedGroupId, onActivate, onClose, onFiles };
  useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      const overrides = useSettingsStore.getState().settings
        ?.keyboard_shortcuts as ShortcutMap | undefined;
      // F11 (as bound) — this popout's fullscreen mode, the same toggle as the
      // button in its `WindowControls`. Handled before the editable-target
      // guard so it works from a terminal too. A fullscreen popout cannot be
      // dragged (the WM takes MOVE off it); `lib/window/fullscreenMode` records
      // that the user asked for it, so `DetachedApp`'s stray-fullscreen guard
      // lets it stand.
      if (chordMatches(resolveChord("osFullscreen", overrides), e)) {
        e.preventDefault();
        void toggleWindowFullscreen();
        return;
      }
      // Never steal keys from a focused text field / xterm textarea (same rule
      // the main window applies) — otherwise typing in a terminal would trip the
      // nav chords. The one exception is the macOS ⌘W family
      // (`editorMayTakeChord`), so ⌘W closes a tab from a focused terminal here
      // too, while ⌃W / Ctrl+W still reach it — and Ctrl+Shift+←/→, which a pane
      // terminal hands over (`terminalMayTakeChord`).
      const editable = isEditableTarget(e.target);
      if (editable && !isMacCommandChord(e) && !isPaneTerminalTarget(e.target)) return;
      const is = (action: ShortcutAction) =>
        (!editable || editorMayTakeChord(action, e) || terminalMayTakeChord(action, e)) &&
        chordMatches(resolveChord(action, overrides), e);
      const {
        tree: t,
        focusedGroupId: fid,
        onActivate: activate,
        onClose: close,
        onFiles: files,
      } = kbRef.current;
      const focused = (fid && findGroup(t, fid)) || allGroups(t)[0] || null;

      // Toggle the focused subwindow's docked file viewer (streams a files edit
      // back to the main window, same as the ◫ button / resize-edge double-click).
      if (is("toggleSubwindowFiles")) {
        if (focused) {
          e.preventDefault();
          files(focused.id, { open: !focused.filesOpen });
        }
        return;
      }

      // Close the active tab of the focused subwindow. DetachedApp's handleClose
      // closes the whole window when it was the last tab.
      if (is("closeTab")) {
        if (focused?.activeKey) {
          e.preventDefault();
          close(focused.activeKey);
        }
        return;
      }

      // Previous / next / cycle tab within the focused subwindow.
      const prev = is("prevTab");
      if (prev || is("nextTab") || is("cycleTabs")) {
        if (focused && focused.tabKeys.length > 1) {
          e.preventDefault();
          const len = focused.tabKeys.length;
          const cur = focused.activeKey ? focused.tabKeys.indexOf(focused.activeKey) : 0;
          const next = focused.tabKeys[(cur + (prev ? -1 : 1) + len) % len];
          activate(next);
        }
        return;
      }

      // Cycle which subwindow is focused (only meaningful once the popout is
      // split into several panes). A direct move — the popout has a focus frame
      // but not the main window's numbered Shift-preview nav.
      const down = is("subwindowDown");
      if (down || is("subwindowUp")) {
        const ids = allGroups(t).map((g) => g.id);
        if (ids.length >= 2) {
          e.preventDefault();
          const from = fid ? ids.indexOf(fid) : -1;
          const base = from >= 0 ? from : 0;
          setFocusedGroupId(ids[(base + (down ? 1 : -1) + ids.length) % ids.length]);
        }
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // Bind once: live state is read via kbRef; the resolver reads settings live.
  }, []);

  // ── Pane-region measurement (for the split-preview overlay) ───────────────
  // Recompute every group body's rect (relative to the panel) so the overlay can
  // paint the half/whole a split drop would carve out. Mirrors CenterPanel.measure.
  const measure = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const base = panel.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    const frames: Record<string, Rect> = {};
    for (const [id, el] of bodyRefs.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      next[id] = { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
      // The enclosing subwindow box spans the tab header bar + body; clamp the
      // right edge to the pane region's right (`r`, the measured element here)
      // so a docked files sidebar in the same body is excluded from the frame.
      const sub = el.closest(".subwindow");
      if (sub) {
        const sr = sub.getBoundingClientRect();
        frames[id] = {
          left: sr.left - base.left,
          top: sr.top - base.top,
          width: r.right - sr.left,
          height: sr.height,
        };
      }
    }
    const sameRects = (
      a: Record<string, Rect>,
      b: Record<string, Rect>,
    ): boolean => {
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (const k of keys) {
        const x = a[k];
        const y = b[k];
        if (!y || x.left !== y.left || x.top !== y.top || x.width !== y.width || x.height !== y.height) {
          return false;
        }
      }
      return true;
    };
    setGroupRects((prev) => (sameRects(next, prev) ? prev : next));
    setGroupFrameRects((prev) => (sameRects(frames, prev) ? prev : frames));
  }, []);

  // Re-measure when the popout's tree changes (split added/removed/resized).
  useLayoutEffect(() => {
    measure();
  }, [measure, tree]);

  // Re-measure on panel/body resize and OS-window resize (WebKitGTK sometimes
  // misses the latter via ResizeObserver — DetachedApp bridges it to 'resize').
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(panel);
    for (const el of bodyRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure, tree]);
  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  // A split divider drag inside the popout. Mirrors CenterPanel's SplitView: the
  // new fraction is the pointer position within the split container, clamped so
  // neither side of the dragged pair shrinks below the min subwindow size. The
  // resize streams back to the main window via `onResize` (a "resize" edit), so
  // the host's `detachedGroupsByScope` record stays the source of truth.
  // A mid-flight divider drag's teardown, so unmounting mid-gesture (the popout
  // closing/docking) unbinds the window listeners instead of leaking them.
  const dividerDragTeardown = useRef<(() => void) | null>(null);
  useEffect(() => () => dividerDragTeardown.current?.(), []);
  const onDividerPointerDown =
    (node: SplitNode, dividerIndex: number) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const container = (e.currentTarget as HTMLElement).parentElement;
      if (!container) return;
      const captureEl = e.target as HTMLElement;
      captureEl.setPointerCapture?.(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        const rect = container.getBoundingClientRect();
        const isRow = node.dir === "row";
        const total = isRow ? rect.width : rect.height;
        if (total <= 0) return;
        const pos = isRow ? ev.clientX - rect.left : ev.clientY - rect.top;
        // Same pure math as the main window's SplitView (dividerFraction).
        onResize(
          node.id,
          dividerIndex,
          dividerFraction(node, dividerIndex, pos, total, isRow ? minWidth : minHeight),
        );
      };
      const teardown = () => {
        dividerDragTeardown.current = null;
        unbindRelease();
        window.removeEventListener("pointermove", onMove);
        captureEl.releasePointerCapture?.(e.pointerId);
      };
      // Every move already streamed its resize to the main window, so commit and
      // abort tear down the same way; what matters is that the gesture ENDS on
      // WebKitGTK's `pointercancel`-instead-of-`pointerup` too — the bare
      // `pointerup` listener this replaces left the divider glued to the cursor
      // there (the exact split `CenterPanel` documents / dragPlatform encodes).
      const unbindRelease = bindDragRelease({ onCommit: teardown, onAbort: teardown });
      window.addEventListener("pointermove", onMove);
      dividerDragTeardown.current = teardown;
    };

  // #42: a tab/file dragged out of the MAIN window over this popout. We (1) answer
  // the host's panes request with our per-pane client geometry, so the host
  // hit-tests the cursor SYNCHRONOUSLY (no release race), and (2) render the
  // per-pane split/merge preview for the target the host streams back — via a
  // synthetic local drag so the SAME SplitPreviewOverlay + ghost light up as an
  // in-popout drag. The dock itself is the host's store mutation + re-seed.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const win = getCurrentWindow();
    const label = win.label;
    let active = false;
    // Our window frame (physical px), used to map the streamed physical cursor into
    // our own client px for the ghost position; snapshotted lazily on the first
    // hover (the popout doesn't move/rescale mid-gesture).
    let frame: WindowFrame | null = null;
    const refreshFrame = async () => {
      try {
        frame = await snapshotFrame(win);
      } catch {
        frame = null;
      }
    };
    const reg = (p: Promise<() => void>) =>
      p.then((fn) => (cancelled ? fn() : unlisteners.push(fn))).catch(() => {});

    // Render the host-resolved target as our split-preview, and follow the ghost.
    const apply = (p: DetachedDropPreview) => {
      if (p.cursorPhysX != null && p.cursorPhysY != null && frame) {
        // physical desktop px → our own client px (via innerPhys/scale, the only
        // DPI-correct conversion); valid even though the cursor is outside us.
        const c = physToClient(frame, { x: p.cursorPhysX, y: p.cursorPhysY });
        useDragStore.getState().move(c.x, c.y);
      }
      const t = p.target;
      useDragStore.getState().setTarget(
        t
          ? { overGroup: t.groupId, edge: t.edge, reorderGroup: null, reorderIndex: null }
          : { overGroup: null, edge: null, reorderGroup: null, reorderIndex: null },
      );
    };

    // (1) Report our pane geometry (client px) when the host asks at drag start.
    reg(
      listen<DetachedPanesRequest>(DETACHED_PANES_REQUEST, (ev) => {
        if (ev.payload.label !== label) return;
        const panes: PaneRect[] = [];
        for (const [gid, bar] of barRefs.current) {
          const body = bodyRefs.current.get(gid);
          if (!body) continue;
          const br = bar.getBoundingClientRect();
          const bo = body.getBoundingClientRect();
          panes.push({
            groupId: gid,
            bar: { left: br.left, top: br.top, right: br.right, bottom: br.bottom },
            body: { left: bo.left, top: bo.top, right: bo.right, bottom: bo.bottom },
          });
        }
        void emit(DETACHED_PANES, { label, panes } satisfies DetachedPanes);
      }),
    );

    // (2) Render the preview for the streamed target.
    reg(
      listen<DetachedDropPreview>(detachedDropPreviewEvent(label), (ev) => {
        const p = ev.payload;
        if (!p.active) {
          if (active) {
            active = false;
            useDragStore.getState().end();
          }
          setDropActive(false);
          return;
        }
        setDropActive(true);
        if (!active) {
          active = true;
          useDragStore.getState().start({
            key: "",
            fromGroup: "",
            label: p.label ?? "",
            pointerX: 0,
            pointerY: 0,
            previewNode: null,
            previewW: 0,
            previewH: 0,
          });
          void refreshFrame().then(() => apply(p));
          return;
        }
        apply(p);
      }),
    );

    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
      if (active) useDragStore.getState().end();
    };
    // Mount once: the listeners key off our (stable) window label.
  }, []);

  // Resolve the within-popout drop target under a popout-client point and write
  // it to this popout's drag store: a tab BAR → within-bar reorder slot; a group
  // BODY → edge split of that group. Mirrors CenterPanel.resolveTarget, but scans
  // this popout's own per-group bar/body refs (it may have several once split).
  //
  // The pure hit-test (`hitTestLocal`) is split from the store write so the
  // Wayland drop claim below can answer "which pane is under this point" without
  // an in-flight drag in this popout's store.
  const hitTestLocal = useCallback(
    (
      clientX: number,
      clientY: number,
    ):
      | { kind: "bar"; groupId: string; slot: number }
      | { kind: "body"; groupId: string; edge: DropEdge }
      | null => {
      const inside = (r: DOMRect) =>
        clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
      for (const [gid, bar] of barRefs.current) {
        const br = bar.getBoundingClientRect();
        if (!inside(br)) continue;
        // By `data-tab-index`, not DOM position: a tab-group chip stands for
        // several tabs (same rule as the main window's CenterPanel).
        const tabEls = Array.from(bar.querySelectorAll<HTMLElement>(".tab[data-tab-index]"));
        const count = Number(bar.dataset.tabCount);
        let slot = Number.isFinite(count) ? count : tabEls.length;
        for (const el of tabEls) {
          const r = el.getBoundingClientRect();
          if (clientX < r.left + r.width / 2) {
            slot = Number(el.dataset.tabIndex);
            break;
          }
        }
        return { kind: "bar", groupId: gid, slot };
      }
      for (const [gid, body] of bodyRefs.current) {
        const r = body.getBoundingClientRect();
        if (!inside(r)) continue;
        const edge = pickEdge(
          { left: r.left, top: r.top, width: r.width, height: r.height },
          clientX,
          clientY,
        );
        return { kind: "body", groupId: gid, edge };
      }
      return null;
    },
    [],
  );
  const resolveLocalTarget = useCallback(
    (clientX: number, clientY: number) => {
      const setTarget = useDragStore.getState().setTarget;
      const hit = hitTestLocal(clientX, clientY);
      if (hit?.kind === "bar") {
        setTarget({ overGroup: null, edge: null, reorderGroup: hit.groupId, reorderIndex: hit.slot });
      } else if (hit?.kind === "body") {
        setTarget({ overGroup: hit.groupId, edge: hit.edge, reorderGroup: null, reorderIndex: null });
      } else {
        setTarget({ overGroup: null, edge: null, reorderGroup: null, reorderIndex: null });
      }
    },
    [hitTestLocal],
  );

  // #42 on native Wayland: CLAIM a tab that another window let go over us. With
  // no desktop coordinates the source cannot tell which window it released over
  // (see `lib/window/dropClaim`), so it broadcasts a probe and the window that
  // receives the pointer next answers with the pane under it. Only a sibling of
  // the SAME scope may answer — the host's dock moves the tab within one scope's
  // records — and never the source itself (it committed a self-drop locally).
  useEffect(() => {
    installPointerTracker();
    const label = getCurrentWindow().label;
    let cancelClaim: (() => void) | null = null;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<DetachedDropProbe>(DETACHED_DROP_PROBE, (ev) => {
      const probe = ev.payload;
      if (probe.sourceLabel === label || probe.scope !== scope) return;
      cancelClaim?.();
      cancelClaim = awaitPointerClaim(
        (clientX, clientY) => {
          const hit = hitTestLocal(clientX, clientY);
          const target: DetachedDockTarget | null =
            hit?.kind === "bar"
              ? { groupId: hit.groupId, index: hit.slot }
              : hit?.kind === "body"
                ? { groupId: hit.groupId, edge: hit.edge }
                : null;
          void emit(DETACHED_DROP_CLAIM, {
            token: probe.token,
            windowLabel: label,
            groupId: popoutId,
            clientX,
            clientY,
            target,
          } satisfies DetachedDropClaim);
        },
        () => {},
        { since: probe.releasedAt },
      );
    })
      .then((fn) => (disposed ? fn() : (unlisten = fn)))
      .catch(() => {});
    return () => {
      disposed = true;
      cancelClaim?.();
      unlisten?.();
    };
  }, [scope, popoutId, hitTestLocal]);

  // #42: a FILE dragged out of the file tree (a Files (Project) tab) onto a pane
  // inside THIS popout. The main window's `commitFileDrop` can't run here (the
  // popout doesn't own the tab store), so commit the resolved target as a
  // detached `add` edit: a bar / pane-centre → append; a body side edge → carve a
  // new pane. Provided to the tree via `FileDropContext`, with `resolveLocalTarget`
  // as its per-move target resolver so the split/merge preview lights up.
  const fileDrop = useMemo<FileDropController>(
    () => ({
      resolveTarget: resolveLocalTarget,
      commit: (d, projectCwd) => {
        const drag = useDragStore.getState().drag;
        if (!drag) return;
        const payloads = fileDropPayloads(d, projectCwd);
        if (payloads.length === 0) return;
        // Body side edge → the first file carves a new pane at that edge; any
        // further files (a multi-selection) append to the target group, since the
        // popout can't reference the pane the main window is about to mint.
        if (drag.overGroup && drag.edge && drag.edge !== "center") {
          onAddTab(payloads[0], drag.overGroup, drag.edge);
          for (const p of payloads.slice(1)) onAddTab(p, drag.overGroup);
          return;
        }
        // A pane centre/body, or a tab bar → append to that group. No pane under
        // the cursor (released over empty space) → nothing (never leak a file out).
        const target = drag.overGroup ?? drag.reorderGroup;
        if (!target) return;
        for (const p of payloads) onAddTab(p, target);
      },
      // No drag involved (a button click): drop the tab into the popout's focused
      // group, else its first group, streamed to the main window via onAddTab.
      openTab: (tab) => {
        const target = focusedGroupId ?? allGroups(tree)[0]?.id;
        if (target) onAddTab(tab, target);
      },
    }),
    [resolveLocalTarget, onAddTab, focusedGroupId, tree],
  );

  // A per-tab drag released over THIS popout: commit the LAST resolved target
  // (set by resolveLocalTarget during the drag) — a bar slot reorders, a body
  // edge splits. Returns true if the release was over this popout at all (so the
  // host must NOT also dock it into the main window).
  const handleLocalTabRelease = (
    tabKey: string,
    clientX: number,
    clientY: number,
  ): boolean => {
    const overPopout =
      clientX >= 0 &&
      clientY >= 0 &&
      clientX <= window.innerWidth &&
      clientY <= window.innerHeight;
    if (!overPopout) return false;
    const drag = useDragStore.getState().drag;
    if (!drag) return true;
    // Body edge → split this group inside the popout. A non-center edge splits
    // off a new pane; "center" over a DIFFERENT group merges into it (over the
    // source group it's a no-op, matching the main window's commitDrop). Both
    // land the tab in a new bar, so play the drop-in landing (as commitDrop does).
    if (drag.overGroup && drag.edge) {
      if (drag.edge !== "center") {
        onSplit(tabKey, drag.overGroup, drag.edge);
        useTabLandStore.getState().markLanded(tabKey);
      } else if (drag.overGroup !== drag.fromGroup) {
        onMove(tabKey, drag.overGroup);
        useTabLandStore.getState().markLanded(tabKey);
      }
      return true;
    }
    // Bar slot → reorder within the same group, or merge into another group's bar.
    if (drag.reorderGroup && drag.reorderIndex != null) {
      if (drag.reorderGroup === drag.fromGroup) {
        const group = findGroup(tree, drag.reorderGroup);
        if (group) {
          const cur = group.tabKeys;
          const from = cur.indexOf(tabKey);
          if (from >= 0) {
            let to = drag.reorderIndex;
            if (from < to) to -= 1; // account for the source's own removal.
            if (to !== from) {
              const next = [...cur];
              next.splice(from, 1);
              next.splice(to, 0, tabKey);
              onReorder(next);
            }
          }
        }
      } else {
        // Dropped onto another group's bar → move the tab there at the slot.
        // The slot indexes the target's tabs (which don't contain the key), so
        // it needs no source-removal adjustment. A cross-group move lands the
        // tab in a new bar → play the drop-in landing (as commitDrop does).
        onMove(tabKey, drag.reorderGroup, drag.reorderIndex);
        useTabLandStore.getState().markLanded(tabKey);
      }
    }
    return true;
  };

  // #42: drag-to-dock. We stream the gesture's OS-LEVEL CURSOR position (PHYSICAL
  // desktop px — the canonical cross-window space, see lib/window/coords) to the main
  // window, which maps it into its own client space and renders the dock preview /
  // docks on release. We do NOT rely on DOM pointer events crossing into the main
  // window: on WebKitGTK (esp. Wayland) DOM pointermove/up don't cross the OS
  // window boundary, and DOM `screenX/Y` units diverge across engines under DPI
  // scaling. Instead we POLL `cursorPosition()` (already physical, cross-engine):
  // (a) emit it verbatim for the main window, and (b) on Linux only — see
  // `followWindowOnDockDrag` — use it to move our OWN window so it follows the
  // cursor (on Win/mac `setPosition` under a held button can drop pointer capture).
  // Release is centralized through `bindDragRelease`, which applies the
  // engine-correct cancel-vs-commit policy; END carries the last polled cursor.
  const beginDockDrag = (args: {
    pointerId: number;
    clientX?: number;
    clientY?: number;
    captureEl: HTMLElement | null;
    label: string;
    moveWindow: boolean;
    // The source group of a per-tab drag (for local ghost/reorder visuals).
    sourceGroup?: GroupNode;
    tabKey?: string;
    // ONE pane (inner group) of a multi-pane popout dragged by its bar grip: the
    // host docks just this group (attachDetachedPane) — never the whole popout.
    paneGroupId?: string;
  }) => {
    const { pointerId, captureEl, label: dragLabel, moveWindow, tabKey, sourceGroup, paneGroupId } =
      args;
    // Per-tab drags pass `captureEl: null` (no stable element under the pointer);
    // on engines that need capture to deliver the terminal event, fall back to a
    // stable element (the panel root, else document.body). Without this, dragging a
    // SINGLE tab out of a popout never receives its release on Win/mac and never
    // docks. WebKitGTK keeps the implicit grab, so it needs no capture at all.
    const capEl =
      captureEl ??
      (dragPlatform.needsPointerCapture ? (panelRef.current ?? document.body) : null);
    // Capture whenever a real element is present (preserves the old unconditional
    // Linux capture for whole-window/group/titlebar drags); the `capEl` fallback
    // ADDS capture only on engines that need it (Win/mac) for the per-tab case.
    if (capEl) {
      try {
        capEl.setPointerCapture(pointerId);
      } catch {
        /* capture is best-effort; the OS-cursor poll does not depend on it */
      }
    }

    const win = getCurrentWindow();
    // `last` tracks the physical desktop cursor (the canonical cross-window space).
    let last: PhysPoint = { x: 0, y: 0 };
    let done = false;
    let grab: { x: number; y: number } | null = null;
    let moving = false;
    // Our own window frame (physical px), for mapping the physical cursor back into
    // our client px for the local per-tab hit-test. Snapshotted up front.
    let popoutFrame: WindowFrame | null = null;
    let pollId: number | null = null;
    let streamStarted = false;
    let lastClient = { x: args.clientX ?? 0, y: args.clientY ?? 0 };
    // Local previews and drops use DOM coordinates, even if the compositor
    // cannot expose a desktop cursor/window origin (native Wayland).
    const onLocalMove = (ev: PointerEvent) => {
      lastClient = { x: ev.clientX, y: ev.clientY };
      if (tabKey == null) return;
      useDragStore.getState().move(lastClient.x, lastClient.y);
      resolveLocalTarget(lastClient.x, lastClient.y);
    };

    // Per-tab drags show a local ghost immediately (no frame needed): clone the
    // dragged pane and seed the popout's own drag store synchronously on press.
    if (tabKey != null) {
      const pane =
        Array.from(
          document.querySelectorAll<HTMLElement>(
            `.center-pane[data-tab-key="${CSS.escape(tabKey)}"]`,
          ),
        ).find((el) => el.getBoundingClientRect().width > 0) ?? null;
      let previewNode: HTMLElement | null = null;
      let previewW = 0;
      let previewH = 0;
      if (pane) {
        const r = pane.getBoundingClientRect();
        previewW = r.width;
        previewH = r.height;
        previewNode = pane.cloneNode(true) as HTMLElement;
        previewNode.style.position = "static";
        previewNode.style.left = "";
        previewNode.style.top = "";
        previewNode.style.display = "flex";
        previewNode.style.width = `${previewW}px`;
        previewNode.style.height = `${previewH}px`;
      }
      useDragStore.getState().start({
        key: tabKey,
        fromGroup: sourceGroup?.id ?? popoutId,
        label: dragLabel,
        pointerX: args.clientX ?? 0,
        pointerY: args.clientY ?? 0,
        previewNode,
        previewW,
        previewH,
      });
      resolveLocalTarget(lastClient.x, lastClient.y);
      window.addEventListener("pointermove", onLocalMove);
    }

    const startPoll = () => {
      pollId = window.setInterval(() => {
        void cursorPosition()
          .then((p) => {
            if (done) return;
            last = { x: p.x, y: p.y };
            void emit(DETACHED_DRAG_MOVE, {
              cursorPhysX: p.x,
              cursorPhysY: p.y,
            } satisfies DetachedDragMove);
            // Linux-only cosmetic window-follow (Win/mac: the main window already
            // paints the preview + ghost; setPosition would fight the OS).
            if (moveWindow && dragPlatform.followWindowOnDockDrag && grab && !moving) {
              moving = true;
              void win
                .setPosition(
                  new PhysicalPosition(
                    Math.round(p.x - grab.x),
                    Math.round(p.y - grab.y),
                  ),
                )
                .catch(() => {})
                .finally(() => {
                  moving = false;
                });
            }
            if (tabKey != null && sourceGroup && popoutFrame) {
              // physical desktop px → our own client px (innerPhys/scale), the only
              // DPI-correct conversion — never outerPosition.
              const c = physToClient(popoutFrame, { x: p.x, y: p.y });
              const overPopout =
                c.x >= 0 && c.y >= 0 && c.x <= window.innerWidth && c.y <= window.innerHeight;
              if (overPopout) {
                useDragStore.getState().move(c.x, c.y);
                resolveLocalTarget(c.x, c.y);
              } else if (
                useDragStore.getState().drag?.reorderGroup ||
                useDragStore.getState().drag?.overGroup
              ) {
                useDragStore.getState().setTarget({
                  overGroup: null,
                  edge: null,
                  reorderGroup: null,
                  reorderIndex: null,
                });
              }
            }
          })
          .catch(() => {});
      }, 16);
    };

    // Snapshot our frame, seed the gesture's initial physical cursor, emit START,
    // THEN start the poll — so a MOVE never reaches the main window before START
    // (the main's MOVE/END handlers guard on the in-flight detached drag).
    void snapshotFrame(win)
      .then(async (f) => {
        if (done) return;
        popoutFrame = f;
        // Seed: for a per-tab drag, derive from the press's client coords (exact
        // origin of the gesture); otherwise read the OS cursor (physical).
        const seed: PhysPoint =
          tabKey != null && args.clientX != null && args.clientY != null
            ? clientToPhys(f, { x: args.clientX, y: args.clientY })
            : await desktopCursor().catch(() => ({ x: f.innerPhys.x, y: f.innerPhys.y }));
        if (done) return;
        last = seed;
        if (moveWindow) {
          // Grab offset = cursor − window origin, both physical, so the window
          // tracks the cursor without jumping. Computed for BOTH window-follow
          // modes: on Linux the poll uses it per-tick to follow the cursor; on
          // Win/mac (`!followWindowOnDockDrag`) the poll skips the follow, but
          // `finish` uses this same offset for ONE final `setPosition` so a
          // free-space release lands the popout where it was dropped instead of
          // leaving it frozen at its start position (the Windows regression).
          try {
            const cur = await cursorPosition();
            grab = { x: cur.x - f.outerPhys.x, y: cur.y - f.outerPhys.y };
          } catch {
            grab = null;
          }
        }
        streamStarted = true;
        void emit(DETACHED_DRAG_START, {
          scope,
          // Cross-window protocol identifies the popout RECORD, not the inner group.
          groupId: popoutId,
          label: dragLabel,
          cursorPhysX: seed.x,
          cursorPhysY: seed.y,
          tabKey,
          paneId: paneGroupId,
        } satisfies DetachedDragStart);
        startPoll();
      })
      .catch(() => {});

    const finish = (cancelled: boolean, shift = false) => {
      if (done) return;
      done = true;
      if (pollId != null) window.clearInterval(pollId);
      window.removeEventListener("pointermove", onLocalMove);
      try {
        capEl?.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      if (tabKey != null) useDragStore.getState().end();
      // Win/mac whole-window free-space release: the per-tick window-follow is
      // disabled there (`!followWindowOnDockDrag`), so the popout never moved
      // during the gesture and the main window's END no-ops on a free-space
      // (inMain=false) drop — leaving the popout frozen at its origin. Move it
      // ONCE here to where it was dropped, using the same grab offset the Linux
      // follow uses. Skipped on cancel (Escape leaves it put). Harmless vs a
      // dock-back: if released over the main window, attach_subwindow destroys
      // this window an instant later, so a stray setPosition has no effect.
      if (!cancelled && moveWindow && !dragPlatform.followWindowOnDockDrag && grab) {
        void win
          .setPosition(
            new PhysicalPosition(
              Math.round(last.x - grab.x),
              Math.round(last.y - grab.y),
            ),
          )
          .catch(() => {});
      }
      const end = {
        cancelled,
        cursorPhysX: last.x,
        cursorPhysY: last.y,
        shift,
      } satisfies DetachedDragEnd;
      if (streamStarted) {
        void emit(DETACHED_DRAG_END, end);
      } else if (!cancelled && !shift && tabKey != null) {
        // No desktop geometry (native Wayland — or a release that beat the frame
        // snapshot) and the release was NOT over this popout: ask the window under
        // the cursor to claim the tab (`lib/window/dropClaim`). The main window
        // hosts the answer; none within the timeout leaves the tab where it is.
        void emit(DETACHED_DROP_PROBE, {
          token: newDropToken(win.label),
          scope,
          sourceLabel: win.label,
          groupId: popoutId,
          tabKey,
          label: dragLabel,
          releasedAt: Date.now(),
        } satisfies DetachedDropProbe);
      } else if (!cancelled && shift && tabKey != null) {
        // Shift is an explicit new-window request, even without desktop geometry.
        // Send the host that request only on release; never stream fake positions
        // during a local Wayland drag. The compositor chooses the new placement.
        void emit(DETACHED_DRAG_START, {
          scope, groupId: popoutId, label: dragLabel, tabKey,
          cursorPhysX: 0, cursorPhysY: 0,
        } satisfies DetachedDragStart).then(() => emit(DETACHED_DRAG_END, end));
      }
    };
    const release = (shift = false) => {
      // Shift ALWAYS means "pop into its own window" (unified with the main-window
      // tab rule), so DON'T commit a within-popout drop under Shift — hand the
      // gesture to the main host UNcancelled and let its unified ladder run the
      // new-window branch (`decideDetachedTabDrop` → `detachTabToNewWindow`). For a
      // lone-tab popout the host refuses (it's already its own window) → a clean
      // no-op, never the previous local-split + Shift-bail hang. Without Shift, a
      // release over THIS popout is still committed locally (reorder/split).
      if (!shift && tabKey != null && sourceGroup) {
        const c = popoutFrame ? physToClient(popoutFrame, last) : lastClient;
        const handledLocally = handleLocalTabRelease(tabKey, c.x, c.y);
        finish(handledLocally, shift);
        return;
      }
      // A PANE drag released over its own popout stays put: the window doesn't
      // follow the cursor (moveWindow=false), and the popout usually floats
      // ABOVE the main window — the host's inMain test alone would read a
      // release-in-place as "dock into main". Cancel so the host no-ops.
      if (!shift && paneGroupId != null && popoutFrame) {
        const c = physToClient(popoutFrame, last);
        const overSelf =
          c.x >= 0 && c.y >= 0 && c.x <= window.innerWidth && c.y <= window.innerHeight;
        if (overSelf) {
          finish(true, shift);
          return;
        }
      }
      finish(false, shift);
    };
    // The caller binds release at pointerdown, before WebKitGTK's implicit grab.
    return { release, abort: () => finish(true) };
  };

  // Grab a group's bar grip → MOVE the whole popout window natively (option B:
  // move-only). This replaces the old streamed move+dock gesture (`beginDockDrag`)
  // whose cross-window protocol is what painted a dock/split preview in the main
  // window while you were merely repositioning a popout. A popout no longer docks
  // back — nor separates a pane — by dragging; those are part of a re-docking
  // redesign still to come. Only the explicit `.tab-drag-grip` starts the move;
  // grabbing empty bar space does not.
  const onGroupBarPointerDown = (e: React.PointerEvent, _group: GroupNode) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.closest(".tab-drag-grip")) return;
    e.preventDefault();
    beginNativeWindowMove();
  };

  // #42 (Windows): show the cheap move placeholder for the duration of a NATIVE
  // title-bar drag (`startDragging`), so WebView2 isn't repainting the terminal
  // canvases during the OS modal move loop (which it can't do fast enough → the
  // content lags the frame). End detection is deliberately belt-and-suspenders
  // because the native move loop can swallow the terminal `pointerup`:
  //   • show on the FIRST `onMoved` (so a non-drag click never flashes it),
  //   • hide on `pointerup`/`pointercancel` (the normal release, cursor over us),
  //   • hide once the window has stopped moving for a beat (release over ANOTHER
  //     monitor, where our webview never sees the pointerup), and
  //   • a hard timeout so the placeholder can never get stuck on.
  const beginWindowMove = () => {
    const win = getCurrentWindow();
    let idle: ReturnType<typeof setTimeout> | undefined;
    let unMoved: (() => void) | undefined;
    let shown = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (idle) clearTimeout(idle);
      clearTimeout(hardStop);
      unMoved?.();
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (shown) setWindowDragging(false);
    };
    const onMoved = () => {
      if (!shown) {
        shown = true;
        setWindowDragging(true);
      }
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, 250);
    };
    const hardStop = setTimeout(finish, 10000);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    win
      .onMoved(onMoved)
      .then((fn) => (done ? fn() : (unMoved = fn)))
      .catch(() => {});
  };

  // Move-only, most-native window reposition. Hands the drag straight to the OS
  // (`startDragging`) instead of the streamed poll+setPosition dock gesture
  // (`beginDockDrag`) — so it emits NO cross-window dock protocol and therefore
  // no other window ever paints a dock/split preview for it. This is the whole-
  // subwindow behaviour: a popout's grip and titlebar only REPOSITION the window;
  // re-docking back into another window by dragging is deliberately gone (a
  // separate re-docking design is planned). On Windows the move placeholder keeps
  // the frame aligned during the OS modal move loop (WebView2 can't repaint the
  // terminals fast enough); other engines don't need it.
  const beginNativeWindowMove = () => {
    // In the user's fullscreen mode the WM refuses the move anyway; starting one
    // would only arm the Windows move placeholder over a window that never moves.
    if (useFullscreenMode.getState().on) return;
    if (PLATFORM === "windows") beginWindowMove();
    const win = getCurrentWindow();
    // A window the WM holds in fullscreen has no `_NET_WM_ACTION_MOVE`, so it
    // refuses `_NET_WM_MOVERESIZE` and this drag is a silent no-op — the popout
    // that "stopped moving when you drag the top frame" (observed live under
    // Muffin: `_NET_WM_STATE_FULLSCREEN` set, MOVE and RESIZE both gone from
    // `_NET_WM_ALLOWED_ACTIONS`). `DetachedApp`'s guard clears that state on
    // resize and focus-regain, but a window already stuck AND already focused
    // produces neither event, so the press that runs into the problem is also
    // the one that has to get it out.
    //
    // Fired and NOT awaited, which is the whole shape of it. Waiting would put a
    // round trip in front of every drag of a window that merely fills its screen
    // — a maximized popout, which Muffin moves
    // perfectly well — to buy nothing in the case that is not stuck. Unawaited,
    // the ordinary drag is exactly as immediate as it was, the two requests reach
    // the WM in the order they were sent, and the worst case left is a stuck
    // window that takes a second press: by then the fullscreen is gone for good.
    // `windowFillsScreen()` is free and synchronous, so a normally-sized popout
    // does not even pay the IPC (see `lib/window/strayFullscreen` for why the state
    // cannot simply be read back and tested instead).
    if (windowFillsScreen()) void clearStrayFullscreen();
    void win.startDragging().catch(() => {});
  };

  // #240: double-click the title bar → fit this popout onto the screen it is on
  // (backend `snap_detached_window`, which clamps it to that monitor and slides
  // it fully inside). The rescue gesture for the window that survived an
  // undock: a popout sized on a 2560x1440 external keeps that size when the
  // display goes away, so on the laptop panel its bottom-right corner — and,
  // borderless, every resize edge with it — is off-screen.
  //
  // Detected by HAND rather than with React's `onDoubleClick`, because the first
  // press already handed the pointer to the WM: `startDragging` opens a
  // `_NET_WM_MOVERESIZE` grab (and its Windows equivalent), and the click that
  // ends it is consumed by the WM's move loop, so the webview never sees the
  // `dblclick` DOM event that would follow. Pointer events, by contrast, arrive
  // normally — the grab ends on release — so the second press is ours to read.
  // `detail` is not usable either: the pointer-events spec pins it to 0.
  //
  // What the press pair alone cannot tell apart — and the reason the decision is
  // the pure `decideTitlebarPress` — is a DOUBLE-CLICK from a RE-GRAB: a title-bar
  // drag carries the window under the cursor, so the grab point holds the same
  // client coordinates no matter how far the window went. Dragging the popout,
  // releasing, and grabbing again to carry on therefore looks exactly like a
  // double-click, and since the snap branch consumes the press instead of moving,
  // the popout stopped answering the drag under way. `lastWindowMoveAt` is the
  // tiebreaker: a press that follows an OS move of this window is a re-grab.
  const lastTitlebarPress = useRef<TitlebarPress>({ t: 0, x: 0, y: 0 });

  // When the OS last reported this window moved. Cheap and event-driven (the same
  // `onMoved` the popout already persists its geometry from, in `DetachedApp`).
  const lastWindowMoveAt = useRef(0);
  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onMoved(() => {
        lastWindowMoveAt.current = Date.now();
      })
      .then((fn) => (disposed ? fn() : (un = fn)))
      .catch(() => {});
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // #42: grab the popout's outer title bar to move/dock the WHOLE window. Mirrors
  // the group-bar handle, but anchored to the always-full-width title strip so it
  // works the same whether or not the content is split. The window controls carry
  // `no-drag`, so a click on min/max/close never starts a drag.
  const onTitlebarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".detached-titlebar-controls, .detached-titlebar-actions, button, .no-drag"))
      return;
    e.preventDefault();
    // Fullscreen by the user's own choice: neither a move nor a snap-to-screen
    // resize means anything until they leave it (F11 / the fullscreen button).
    if (useFullscreenMode.getState().on) return;
    const prev = lastTitlebarPress.current;
    const press: TitlebarPress = { t: Date.now(), x: e.clientX, y: e.clientY };
    lastTitlebarPress.current = press;
    if (decideTitlebarPress({ prev, now: press, lastMoveAt: lastWindowMoveAt.current }) === "snap") {
      // Second press of a double-click: snap instead of starting another move,
      // and disarm so a third press starts a fresh count rather than snapping
      // again on every press of a rapid burst.
      lastTitlebarPress.current = { t: 0, x: 0, y: 0 };
      // A press must never do NOTHING: if the snap can't happen — the backend has
      // no `snap_detached_window` (a window whose Rust side predates #240; backend
      // edits don't hot-reload), or the fit found no monitor to land on — fall
      // back to the ordinary move so the title bar still answers. Only while the
      // button is still down: `_NET_WM_MOVERESIZE` sent after the release glues
      // the window to a cursor with no button held.
      let released = false;
      const onUp = () => { released = true; };
      window.addEventListener("pointerup", onUp, { once: true });
      const settle = (snapped: boolean) => {
        window.removeEventListener("pointerup", onUp);
        if (!snapped && !released) beginNativeWindowMove();
      };
      void invoke<boolean>("snap_detached_window", { label: getCurrentWindow().label })
        .then((ok) => settle(ok !== false))
        .catch(() => settle(false));
      return;
    }
    // Move the whole popout window natively on every platform (see
    // `beginNativeWindowMove`) — no streamed dock gesture, so dragging the
    // titlebar never makes another window flash a dock/split preview.
    beginNativeWindowMove();
  };

  // #42: dragging a SINGLE tab out of `group`. Activate on press, then once the
  // pointer crosses a threshold start a per-tab dock drag. The threshold uses DOM
  // `clientX/Y` (reliable in-window CSS px on every engine); cross-window position
  // is poll-driven inside beginDockDrag. The press's client coords seed the gesture.
  const onTabPointerDown = (e: React.PointerEvent, group: GroupNode, tab: TabEntry) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onActivate(tab.key);
    const startX = e.clientX;
    const startY = e.clientY;
    let gesture: ReturnType<typeof beginDockDrag> | undefined;
    const onMove = (ev: PointerEvent) => {
      if (gesture) return;
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      window.removeEventListener("pointermove", onMove);
      gesture = beginDockDrag({
        pointerId: ev.pointerId,
        clientX: ev.clientX,
        clientY: ev.clientY,
        captureEl: null,
        sourceGroup: group,
        tabKey: tab.key,
        label: tab.label,
        moveWindow: false,
      });
    };
    window.addEventListener("pointermove", onMove);
    bindDragRelease({
      onCommit: (shift) => {
        window.removeEventListener("pointermove", onMove);
        gesture?.release(shift);
      },
      onAbort: () => {
        window.removeEventListener("pointermove", onMove);
        gesture?.abort();
      },
    });
  };

  // Render one group: its tab bar + a pane layer holding every tab (active shown).
  // For a single-group popout this is the whole content; inside a split each group
  // renders into its flex cell. The min/max/close window controls live in the
  // popout's dedicated outer title bar (not here), so they stay pinned top-right
  // regardless of how the content is split.
  const renderGroup = (group: GroupNode) => {
    const orderedTabs = group.tabKeys
      .map((k) => byKey.get(k))
      .filter((t): t is TabEntry => t != null);
    // This bar is the live drop target of an in-flight drag: light up the whole
    // bar and render a placeholder slot at the insertion point — identical to the
    // main-window `TabBar` (shared `.drop-target` wash + `TabDropPlaceholder`),
    // replacing the old fixed-margin gap so the merge/reorder preview matches.
    const localReorder = reorderGroupId === group.id ? reorderIndex : null;
    const isDropTarget = localReorder != null;
    const dropPlaceholder = <TabDropPlaceholder label={dragLabel} />;
    const isFocused = windowFocused && group.id === focusedGroupId;
    return (
      <div
        className={`subwindow${isFocused ? " focused" : ""}`}
        // Clicking anywhere in the group (bar or body) makes it the current one.
        // Capture-phase so it wins before a tab/divider pointerdown stops
        // propagation — mirrors the main window's `Subwindow`.
        onMouseDownCapture={() => {
          if (!isFocused) setFocusedGroupId(group.id);
        }}
      >
        <div
          ref={(el) => {
            if (el) barRefs.current.set(group.id, el);
            else barRefs.current.delete(group.id);
          }}
          className={`tab-bar detached-drag-handle${isDropTarget ? " drop-target" : ""}`}
          data-group-id={group.id}
          data-tab-count={orderedTabs.length}
          onPointerDown={(e) => onGroupBarPointerDown(e, group)}
        >
          {/* Move grip — the sole tab-bar handle for moving/docking this popout
              (the titlebar still moves it too). Always pinned at the far left so
              it stays grabbable however many tabs fill the bar. A plain
              (non-button) element, so its pointerdown bubbles to
              `onGroupBarPointerDown`, which now fires only when the grip is the
              target. */}
          <div
            className="tab-drag-grip"
            title={t("detachedTabs.dragToMove")}
            aria-hidden="true"
          >
            ⠿
          </div>
          {/* The tabs live in their own horizontally-scrolling strip; chevrons
              flank it and appear only on overflow — the same behaviour as the
              main-window `TabBar`. `revision` re-checks overflow when the tab set
              (or its drop placeholder) changes. */}
          <ScrollingTabStrip
            revision={`${orderedTabs.map((t) => t.key).join(",")}|${isDropTarget}|${localReorder}`}
          >
          {/* Empty bar that's a drop target: the placeholder is the only slot. */}
          {isDropTarget && orderedTabs.length === 0 && (
            <Fragment key="drop-marker">{dropPlaceholder}</Fragment>
          )}
          {stripItems(orderedTabs).map((item) => {
            // The placeholder slot previewing where the dragged tab will land —
            // shown immediately before the tab (or group chip) at the resolved
            // insertion index.
            const showMarkerBefore = isDropTarget && localReorder === item.index;
            // The same status ring the main-window strip draws, from the same
            // two maps and by the same rules (#234) — working wins; working and
            // finished are about unread output so they never show on the tab you
            // are looking at; a pending decision does, because the agent stays
            // blocked whether or not anyone is watching. The maps here are what
            // the main window mirrored over (`applyDetachedStatus`); before this
            // group the popout's strip rendered no state at all, so a popped-out
            // agent finishing its turn said nothing in either window.
            const stateOf = (tab: TabEntry) => {
              const ptyId = `${scope}:${tab.key}`;
              const isActive = tab.key === group.activeKey;
              const working = isPtyTabKind(tab.kind) && !!busyByTab[ptyId];
              const rawAttn =
                tab.kind === "agent" || tab.kind === "local_agent"
                  ? attentionByTab[ptyId] ?? null
                  : null;
              const attn = !isActive || rawAttn === "decision" ? rawAttn : null;
              return working
                ? busyStateClass(busyKindByTab[ptyId], tab.kind)
                : attentionStateClass(attn);
            };
            if (item.type === "stack") {
              return (
                <Fragment key={`stack:${item.name}`}>
                  {showMarkerBefore && dropPlaceholder}
                  <TabStackChip
                    name={item.name}
                    index={item.index}
                    members={item.members.map((m) => ({ ...m, stateClass: stateOf(m.tab) }))}
                    activeKey={group.activeKey}
                    suppressed={dragKey !== null || !!addMenu || !!tabMenu || !!stackMenu}
                    onActivate={onActivate}
                    onCloseTab={onClose}
                    onTabContextMenu={(e, key) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setHoverTab(null);
                      setTabMenu({ key, x: e.clientX, y: e.clientY });
                    }}
                    onStackContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setHoverTab(null);
                      setTabMenu(null);
                      if (onSetStack) {
                        setStackMenu({ x: e.clientX, y: e.clientY, name: item.name, groupId: group.id });
                      }
                    }}
                  />
                </Fragment>
              );
            }
            const { tab, index } = item;
            const isActive = tab.key === group.activeKey;
            const isDragging = dragKey === tab.key;
            // A tab freshly dropped into this bar plays the drop-in landing once.
            const landing = !isDragging && landedKey === tab.key;
            const ptyId = `${scope}:${tab.key}`;
            const stateClass = stateOf(tab);
            return (
              <Fragment key={tab.key}>
                {showMarkerBefore && dropPlaceholder}
                <div
                  className={`tab ${isActive ? "active" : ""}${stateClass}${tabColorCss(tab.color) ? " has-tab-color" : ""}${isDragging ? " dragging" : ""}${landing ? " landing" : ""}`}
                  data-tab-index={index}
                  // A user colour (#264) fills the same `--tab-accent` slot the
                  // main window's strip uses, so one CSS rule colours the tab
                  // in either window. This strip sets no kind colour of its own,
                  // so an uncoloured tab is left on the variable's fallback.
                  style={tabColorCss(tab.color)
                    ? ({ "--tab-accent": tabColorCss(tab.color) } as React.CSSProperties)
                    : undefined}
                  onPointerDown={(e) => onTabPointerDown(e, group, tab)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setHoverTab(null);
                    setTabMenu({ key: tab.key, x: e.clientX, y: e.clientY });
                  }}
                  // Styled hover card (same one the main window's TabBar shows —
                  // this strip is bespoke, so it anchors the shared card itself).
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setHoverTab({ key: tab.key, x: r.left + r.width / 2, y: r.bottom });
                  }}
                  // Looking at a tab marks its output read, exactly as the main
                  // window's strip does — the popout forwards it, so the main
                  // window's classifier (and the project pill) agree (#234).
                  onMouseDown={() => {
                    if (isActive) clearAttention(ptyId);
                  }}
                  onMouseLeave={() =>
                    setHoverTab((h) => (h?.key === tab.key ? null : h))
                  }
                  // Clear the landing once it finishes so the class doesn't linger
                  // (guard on currentTarget so a child's animationend never clears
                  // it early). Mirrors the main-window `TabBar`.
                  onAnimationEnd={
                    landing
                      ? (e) => {
                          if (e.target === e.currentTarget) clearLanded(landedNonce);
                        }
                      : undefined
                  }
                >
                  <TabStatusMark stateClass={stateClass} />
                  <span className="tab-label">{tab.label}</span>
                  <TabMarkBadge tab={tab} inPopout />
                  <TabAgentModeMarks scope={scope} tab={tab} isActive={isActive} />
                  {(tab.kind === "agent" || tab.kind === "local_agent") && tab.scheduleTargetId && (() => {
                    const enabled = (schedulesByTarget[scheduleCacheKey(scope, tab.scheduleTargetId)] ?? [])
                      .filter((schedule) => schedule.enabled);
                    const next = enabled
                      .map((schedule) => nextScheduleOccurrence(schedule, new Date())?.at)
                      .filter((at): at is Date => !!at)
                      .sort((a, b) => a.getTime() - b.getTime())[0];
                    return enabled.length > 0 ? (
                      <span
                        className="tab-schedule-indicator"
                        title={next
                          ? t("agentSchedule.indicatorNext", { count: enabled.length, value: next.toLocaleString() })
                          : t("agentSchedule.indicator", { count: enabled.length })}
                      >◷</span>
                    ) : null;
                  })()}
                  {/* Local/remote badges — parity with the main-window TabBar,
                      via the shared TabLocalityBadges. The source badge reads THIS
                      window's fileSources store; the locality badge/menu use the
                      streamed host list and route changes through onSetLocation. */}
                  <TabSourceBadge tabKey={tab.key} />
                  {/* TeX ⇄ PDF coupling mark — parity with the main-window
                      TabBar. Searched over THIS window's tabs: a partner left
                      behind in the main window isn't reachable from here, and a
                      mark whose click does nothing would be worse than none. */}
                  <TabTexLinkBadge
                    partner={texPdfPartner(tabs, tab)}
                    onFocus={onActivate}
                  />
                  {isRemote && (
                    <TabLocalityBadge
                      tab={tab}
                      primaryHost={primaryHost}
                      computeHosts={computeHosts}
                      onOpen={(r, startOnMachines) =>
                        setLocalityMenu({
                          key: tab.key,
                          x: r.left,
                          y: r.bottom + 2,
                          view: startOnMachines ? "machines" : "root",
                        })
                      }
                    />
                  )}
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.key);
                    }}
                    title={t("detachedTabs.closeTab")}
                  >
                    ×
                  </button>
                </div>
              </Fragment>
            );
          })}
          {/* Insertion at the end of the bar (slot === tab count). */}
          {isDropTarget && localReorder === orderedTabs.length && orderedTabs.length > 0 && (
            <Fragment key="drop-marker-end">{dropPlaceholder}</Fragment>
          )}
          </ScrollingTabStrip>
          {/* #42: the popout's own "+" — the detached window had no way to add
              tabs. Streams an "add" edit to the main window (which owns tab
              creation + the PTY) via onAddTab. Rendered OUTSIDE
              `ScrollingTabStrip` (i.e. outside the scrolling `.tab-strip`) for
              the main window's reason: the one control that adds a tab must not
              scroll away with the tabs when the bar overflows. */}
          <div className="tab-new-wrap">
            <button
              className="tab-new-btn"
              title={t("detachedTabs.newTab")}
              // The bar's pointerdown starts a window-move/dock drag; keep the
              // button's press out of it (it also excludes buttons, but be explicit).
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setAddMenu((cur) =>
                  cur && cur.groupId === group.id
                    ? null
                    : { groupId: group.id, x: r.left, y: r.bottom + 4 },
                );
              }}
            >
              +
            </button>
          </div>
          {/* Per-subwindow right file viewer, same ◫ toggle as the main window's
              TabBar. Applied optimistically + streamed to the main window. When
              the viewer is docked below, the control reserves its width (like
              the main window's `.tab-controls`) so it stays pinned above the
              viewer and the strip stops at the pane edge. */}
          <div
            className="tab-controls"
            style={
              group.filesOpen
                ? { width: clampFilesWidth(group.filesWidth ?? DEFAULT_GROUP_FILES_WIDTH) }
                : undefined
            }
          >
            <button
              className={`subwindow-files-toggle${group.filesOpen ? " open" : ""}`}
              title={
                group.filesOpen
                  ? "Close this subwindow's file viewer"
                  : "Open a file viewer in this subwindow"
              }
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onFiles(group.id, { open: !group.filesOpen });
              }}
            >
              ◫
            </button>
            {/* Hide the WHOLE popout into the main window's side-panel Hidden
                list — the detached twin of the main-window bar's "–". Rendered
                per bar (like ◫); for a multi-pane popout every bar's "–" hides
                the whole window as one hidden entry. stopPropagation keeps the
                press off the bar's window-move/dock drag. */}
            {onHideWindow && (
              <button
                className="subwindow-hide"
                title={t("detachedTabs.hideWindow")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onHideWindow();
                }}
              >
                –
              </button>
            )}
          </div>
        </div>
        <div className="subwindow-body">
          {/* The measured/drop-target body is the PANE REGION, not the whole
              flex row — so edge-split drops and the split preview never target
              the file-viewer column. */}
          <div
            className="subwindow-pane-region"
            ref={(el) => {
              if (el) bodyRefs.current.set(group.id, el);
              else bodyRefs.current.delete(group.id);
            }}
          >
          <div className="pane-layer">
            {orderedTabs.map((tab) => {
              // #239: a parked or minimised popout is not showing anything, so
              // its panes must report themselves hidden — otherwise every one of
              // its terminals streams over IPC and every file view keeps polling
              // for a window that is off screen. The pane still MOUNTS (the tab
              // must come back instantly, and an attach-only terminal owns no
              // PTY to lose); it just stops being fed.
              const visible = tab.key === group.activeKey && windowVisible;
              const style: React.CSSProperties = visible
                ? { display: "flex", left: 0, top: 0, right: 0, bottom: 0 }
                : { display: "none" };
              return (
                <div key={tab.key} className="center-pane" data-tab-key={tab.key} style={style}>
                  {/* The shared per-tab render switch (`components/tabs/TabPane`),
                      the SAME one the main window uses. A popout is attach-only (the
                      main window owns the PTY), so it passes no `onConnect`/mirror
                      props — the cwd is just the tab's, since the projects store the
                      mirror-swap needs isn't here. Tab-state writes DO happen here
                      and are forwarded by the store seam (#231). See TabPane. */}
                  <TabPane
                    tab={tab}
                    scope={scope}
                    visible={visible}
                    focused={visible && isFocused}
                    attachOnly
                    filesProjectDir={tab.cwd}
                    terminalCwd={tab.cwd}
                  />
                </div>
              );
            })}
          </div>
          </div>
          {/* Per-subwindow right file viewer. The popout has no projects store,
              so the viewer resolves its root from the group's tab cwd (same
              fallback a Files (Project) tab uses here) UNLESS the seed streamed the
              owning project (`remoteInfo.project`), which restores the Local/Remote
              source switch + run-host picker for a remote project. No
              open-in-new-tab (a popout can't own tabs). Width edits stream back
              like the toggle. */}
          {group.filesOpen && (
            <SubwindowFilesSidebar
              scope={scope}
              // The popout is inert to the projects store, so hand the docked
              // viewer the owning project (streamed in the seed) — otherwise it
              // resolves no project and its Local/Remote switch + run-host picker
              // (gated on `project.remote`) never render (see ProjectFilesTab).
              project={remoteInfo?.project}
              cwd={
                byKey.get(group.activeKey ?? group.tabKeys[0] ?? "")?.cwd ??
                group.tabKeys.map((k) => byKey.get(k)?.cwd).find(Boolean) ??
                ""
              }
              width={group.filesWidth}
              onWidthChange={(w) => onFiles(group.id, { width: w })}
              folder={group.filesFolder}
              onFolderChange={(f) => onFiles(group.id, { folder: f })}
              onHide={() => onFiles(group.id, { open: false })}
            />
          )}
        </div>
      </div>
    );
  };

  // Recursively render the popout's layout tree. Splits become flex rows/columns
  // sized by their fractions; groups render their bar + panes.
  const renderNode = (node: LayoutNode): React.ReactNode => {
    if (node.type === "group") {
      return renderGroup(node);
    }
    return (
      <div
        className={`split split-${node.dir}`}
        style={{
          display: "flex",
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          flexDirection: node.dir === "row" ? "row" : "column",
        }}
      >
        {node.children.map((child, i) => (
          <Fragment key={child.id}>
            <div
              className="split-child"
              style={{
                flex: `${node.sizes[i] ?? 1 / node.children.length} 1 0`,
                display: "flex",
                minWidth: 0,
                minHeight: 0,
              }}
            >
              {renderNode(child)}
            </div>
            {i < node.children.length - 1 && (
              <div
                className={`split-divider split-divider-${node.dir}`}
                onPointerDown={onDividerPointerDown(node, i)}
                // Double-click merges the two adjacent subwindows (both must be
                // leaf groups). No `merge` edit exists, so replay it as one
                // `move` per source tab into the left/top survivor — the main
                // window applies each via moveKeyInTree (which collapses the
                // emptied source) and streams the result back.
                onDoubleClick={() => {
                  const a = node.children[i];
                  const b = node.children[i + 1];
                  if (a.type === "group" && b.type === "group") {
                    for (const key of b.tabKeys) onMove(key, a.id);
                  }
                }}
              />
            )}
          </Fragment>
        ))}
      </div>
    );
  };

  // Label shown on the move placeholder: the first group's active tab, else a
  // generic fallback. Cheap to compute; only painted while `windowDragging`.
  const firstGroup = allGroups(tree)[0];
  const moveLabel =
    (firstGroup ? tabs.find((t) => t.key === firstGroup.activeKey)?.label : undefined) ??
    "Subwindow";

  return (
    <FileDropContext.Provider value={fileDrop}>
    <div className={`detached-center center-panel${windowDragging ? " moving" : ""}`}>
      {/* #42: the popout's own title bar — a full-width strip ABOVE the tab layout
          that always hosts the min/max/close controls top-right. They used to live
          in the root group's tab bar, which slid left (with the root group) once
          the popout was split; an outer frame keeps them pinned. The empty strip
          is a drag handle for moving / docking the whole window. */}
      <div className="detached-titlebar detached-drag-handle" onPointerDown={onTitlebarPointerDown}>
        {/* The star marks the window frame — it lives HERE and nowhere else,
            which is why it was taken back off every subwindow's tab bar. */}
        <span
          className="detached-titlebar-logo"
          aria-hidden="true"
          title={t("detachedTabs.snapToScreen")}
        >
          <StarIcon />
        </span>
        {/* Explicit move grip, mirroring the subwindow tab bars' own `⠿`. The whole strip is already a handle — every
            pixel that isn't the window controls starts the drag — but an
            undecorated popout shows nothing that says so, and a title bar filled
            edge-to-edge by the controls leaves nothing obvious to aim at: the
            region is grabbable either way, the grip is the always-present
            affordance. (The main header dropped its own grip; its logo chip
            stands at the left edge instead.) A
            plain (non-button) element that matches none of the no-drag selectors,
            so its pointerdown bubbles to `onTitlebarPointerDown` and drives the
            same native move — including the double-click-to-snap it decides. */}
        <span
          className="tab-drag-grip"
          title={t("detachedTabs.dragToMove")}
          aria-hidden="true"
        >
          ⠿
        </span>
        {/* #237: dock the whole window back into the main layout. The gesture
            that used to do this (drag the popout onto the main window) went with
            the 2026-07-19 move-only rework — titlebar and grip drags are native
            OS moves now, which is what the user asked for — and nothing replaced
            it, so the only way back was dragging tabs out one at a time and the
            WM ✕ threw them away. A button restores the escape hatch without
            taking back native snapping. Sits with the window controls (right,
            before them) because that is where window-level actions live; it is
            `no-drag` so the press never starts a window move. */}
        {onDockWindow && (
          <div className="detached-titlebar-actions no-drag">
            <button
              className="detached-dock-btn"
              title={t("detachedTabs.dockWindow")}
              aria-label={t("detachedTabs.dockWindow")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onDockWindow();
              }}
            >
              ⤓
            </button>
          </div>
        )}
        {PLATFORM !== "macos" && (
          <div className="detached-titlebar-controls no-drag">
            <WindowControls />
          </div>
        )}
      </div>
      {/* The layout tree (below the title bar) is the positioning context for the
          absolutely-inset split/subwindow nodes and the split-preview overlay. */}
      <div ref={panelRef} className="detached-body">
        {renderNode(tree)}
        {/* Split preview: the translucent half/whole a split drop would carve out,
            drawn above the per-group panes (mirrors the main window). */}
        <SplitPreviewOverlay groupRects={groupRects} />
        {/* Focus frame: the accent outline around the current subwindow (tab bar
            + pane region, sidebar excluded), drawn here (above the opaque panes)
            for the same reason as the split preview — an in-body frame would be
            hidden. Mirrors the main window's `FocusFrameOverlay` (minus
            Ctrl+Shift+↑/↓ nav, which isn't wired here). Falls back to the pane rect if the
            whole-subwindow box wasn't measured. */}
        {windowFocused &&
          focusedGroupId &&
          (groupFrameRects[focusedGroupId] ?? groupRects[focusedGroupId]) && (
            <div
              className="focus-frame"
              style={
                groupFrameRects[focusedGroupId] ?? groupRects[focusedGroupId]
              }
            />
          )}
        {/* #42 (Windows): the move placeholder. While shown, `.detached-center.moving`
            hides the heavy pane content so this trivial surface is all WebView2 has to
            composite during the native drag — keeping the content aligned with the
            frame instead of lagging behind it. */}
        {windowDragging && (
          <div className="detached-move-overlay">
            <span>{moveLabel}</span>
          </div>
        )}
      </div>
      {dropActive && <div className="detached-drop-target" />}
      {/* #42: the "+" add-tab menu for the group that opened it. cwd is the
          main window's own new-tab folder (`detachedNewTabCwd`), not the active
          tab's — a viewer tab's cwd is its file's folder. */}
      {addMenu &&
        (() => {
          const g = findGroup(tree, addMenu.groupId);
          if (!g) return null;
          const cwd = detachedNewTabCwd(scope, remoteInfo, [
            byKey.get(g.activeKey ?? g.tabKeys[0] ?? "")?.cwd,
            ...g.tabKeys.map((k) => byKey.get(k)?.cwd),
          ]);
          return (
            <NewTabMenu
              scope={scope}
              projectCwd={cwd}
              // The detached window is inert to the projects store, so there's no
              // project name to auto-name an agent session with — skip it.
              projectName=""
              anchor={{ x: addMenu.x, y: addMenu.y }}
              onPick={(tab) => onAddTab(tab, addMenu.groupId)}
              onClose={() => setAddMenu(null)}
              onManageAgents={() => setAgentDialogOpen(true)}
            />
          );
        })()}
      {agentDialogOpen && (
        <CustomAgentDialog onClose={() => setAgentDialogOpen(false)} />
      )}
      {tabMenu && createPortal(
        <div className="tab-new-menu" ref={tabMenuRef} style={{ position: "fixed", left: tabMenu.x, top: tabMenu.y }}>
          <button className="tab-new-menu-item" onClick={() => {
            const tab = byKey.get(tabMenu.key);
            setTabMenu(null);
            if (!tab) return;
            const next = window.prompt(t("detachedTabs.renamePrompt"), tab.label);
            if (next != null && next.trim() && next !== tab.label) onRename?.(tab.key, next.trim());
          }}>
            <span className="tab-new-menu-dot tab-new-menu-dot--accent">✎</span>
            {t("common.rename")}
          </button>
          {onSetColor && (
            <TabColorPicker
              current={byKey.get(tabMenu.key)?.color}
              onPick={(color) => onSetColor(tabMenu.key, color)}
            />
          )}
          {byKey.get(tabMenu.key) && (
            <TabMarkMenuItems
              tab={byKey.get(tabMenu.key)!}
              scope={scope}
              inPopout
              onDone={() => setTabMenu(null)}
            />
          )}
          {onSetStack && (() => {
            // Tab groups are per bar: offer the groups of the bar this tab is in.
            const home = findGroupOfTab(tree, tabMenu.key)?.group;
            const own = byKey.get(tabMenu.key)?.stack;
            const barTabs = (home?.tabKeys ?? [])
              .map((k) => byKey.get(k))
              .filter((tb): tb is TabEntry => tb != null);
            return (
              <>
                {stackNames(barTabs)
                  .filter((name) => name !== own)
                  .map((name) => (
                    <button
                      key={`stack:${name}`}
                      className="tab-new-menu-item"
                      onClick={() => {
                        onSetStack(tabMenu.key, name);
                        setTabMenu(null);
                      }}
                    >
                      <span className="tab-new-menu-dot tab-new-menu-dot--accent">▤</span>
                      {t("tabStack.addTo", { name })}
                    </button>
                  ))}
                <button
                  className="tab-new-menu-item"
                  onClick={() => {
                    const key = tabMenu.key;
                    setTabMenu(null);
                    const name = window.prompt(t("tabStack.nameLabel"), "");
                    if (name?.trim()) onSetStack(key, name.trim());
                  }}
                >
                  <span className="tab-new-menu-dot tab-new-menu-dot--accent">▤</span>
                  {t("tabStack.newGroup")}
                  <UntestedTag id="tabStack.newGroup" />
                </button>
                {own && (
                  <button
                    className="tab-new-menu-item"
                    onClick={() => {
                      onSetStack(tabMenu.key, undefined);
                      setTabMenu(null);
                    }}
                  >
                    <span className="tab-new-menu-dot tab-new-menu-dot--accent">▭</span>
                    {t("tabStack.remove")}
                  </button>
                )}
              </>
            );
          })()}
          {(() => {
            const tab = byKey.get(tabMenu.key);
            return tab && (tab.kind === "agent" || tab.kind === "local_agent") ? (
              <button className="tab-new-menu-item" onClick={() => { setScheduleDialogKey(tab.key); setTabMenu(null); }}>
                <span className="tab-new-menu-dot tab-new-menu-dot--accent">◷</span>
                {t("agentSchedule.menu")} <UntestedTag id="agentSchedule.menu" />
              </button>
            ) : null;
          })()}
        </div>,
        document.body,
      )}
      {stackMenu && onSetStack && (() => {
        const home = findGroup(tree, stackMenu.groupId);
        const members = (home?.tabKeys ?? []).filter((k) => byKey.get(k)?.stack === stackMenu.name);
        return (
          <ContextMenuPortal
            x={stackMenu.x}
            y={stackMenu.y}
            onClose={() => setStackMenu(null)}
            className="tab-new-menu"
          >
            <button
              className="tab-new-menu-item"
              onClick={() => {
                setStackMenu(null);
                const next = window.prompt(t("tabStack.nameLabel"), stackMenu.name);
                if (next?.trim() && next.trim() !== stackMenu.name) {
                  for (const key of members) onSetStack(key, next.trim());
                }
              }}
            >
              <span className="tab-new-menu-dot tab-new-menu-dot--accent">✎</span>
              {t("tabStack.rename")}
            </button>
            <button
              className="tab-new-menu-item"
              onClick={() => {
                setStackMenu(null);
                for (const key of members) onSetStack(key, undefined);
              }}
            >
              <span className="tab-new-menu-dot tab-new-menu-dot--accent">▭</span>
              {t("tabStack.ungroup")}
            </button>
          </ContextMenuPortal>
        );
      })()}
      {scheduleDialogKey && (() => {
        const tab = byKey.get(scheduleDialogKey);
        return tab ? <AgentScheduleDialog scope={scope} tab={tab} onClose={() => setScheduleDialogKey(null)} /> : null;
      })()}
      {/* Multi-host locality menu — parity with the main-window TabBar, routed
          through onSetLocation (the main window owns the PTY + respawns it). */}
      {localityMenu && (
        <LocalityMenu
          menu={localityMenu}
          current={tabLocation(byKey.get(localityMenu.key))}
          primaryHost={primaryHost}
          computeHosts={computeHosts}
          onClose={() => setLocalityMenu(null)}
          onChangeView={(view) => setLocalityMenu((m) => (m ? { ...m, view } : m))}
          onChoose={(key, loc) => onSetLocation(key, loc)}
        />
      )}
      {/* Styled tab hover card — parity with the main window's TabBar.
          Suppressed mid-drag (local or streamed-in: both set the drag store)
          and while the "+" menu is open so it never overlaps them. The card
          reads THIS window's stores; the machine names come from the streamed
          `remoteInfo` (the projects store is absent here). */}
      {hoverTab && !fastMode && dragKey === null && !addMenu && (() => {
        const tab = byKey.get(hoverTab.key);
        if (!tab) return null;
        return (
          <TabHoverCard
            tab={tab}
            scope={scope}
            isRemote={isRemote}
            primaryHost={primaryHost}
            computeHosts={computeHosts}
            anchorX={hoverTab.x}
            anchorY={hoverTab.y}
          />
        );
      })()}
      <DragGhost />
    </div>
    </FileDropContext.Provider>
  );
}
