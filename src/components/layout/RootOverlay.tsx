import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  clampRootOverlayFrame,
  filledRootOverlayFrame,
  rootOverlayFrameDrag,
  useRootOverlayStore,
  type RootOverlayDragMode,
  type RootOverlayFrame,
} from "../../stores/rootOverlay";
import { useProjectsStore } from "../../stores/projects";
import { attentionStateClass, busyStateClass, useActivityStore } from "../../stores/activity";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useSettingsStore } from "../../stores/settings";
import {
  DEFAULT_MIN_SUBWINDOW_PX,
  EMPTY_GROUP_ID,
  ROOT_SCOPE,
  allGroups,
  dividerFraction,
  findGroupOfTab,
  isPtyTabKind,
  isSingletonTabKind,
  useTabsStore,
  type DropEdge,
  type LayoutNode,
  type TabEntry,
} from "../../stores/tabs";
import {
  clampFilesWidth,
  DEFAULT_GROUP_FILES_WIDTH,
  SubwindowFilesSidebar,
} from "../files/SubwindowFilesSidebar";
import { notifyCalendarWrite } from "../../lib/calendar/calendarWriteHook";
import { bindDragRelease, dragPlatform } from "../../lib/window/dragPlatform";
import type { Calendar, CalendarEvent, CalendarTask } from "../../types";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { CustomAgentDialog } from "../tabs/CustomAgentDialog";
import { NewTabMenu } from "../tabs/NewTabMenu";
import { TabScopeContext } from "../tabs/tabScopeContext";
import { TabPane } from "../tabs/TabPane";
import { TabAgentModeMarks, TabStatusMark } from "../tabs/TabLocalityBadges";
import { pickEdge, previewInset } from "../tabs/dragGeometry";
import { dragPreviewLayout } from "../tabs/dragPreview";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { StarIcon } from "./StarIcon";
import { RootReviewStrip } from "./RootReviewStrip";
import { useRootReviewStore } from "../../stores/rootReview";
import { useMailStore } from "../../stores/mail";
import { MailIcon, WarningIcon } from "../common/icons/Icon";

/** What the backend's `root-mcp-changed` event carries (`services::root_mcp::Change`). */
type RootMcpChange = (
  | { kind: "event"; op: "upsert" | "delete"; row: CalendarEvent }
  | { kind: "task"; op: "upsert" | "delete"; row: CalendarTask }
  | { kind: "calendar"; op: "upsert" | "delete"; row: Calendar }
  /** A mail draft an agent wrote: the id and origin only, never the text. */
  | { kind: "draft"; op: "upsert" | "delete"; row: { id: string } }
) & {
  /** Board-only fields changed (a move's column/rank): merge, push nothing. */
  local?: boolean;
};

interface RootMcpStatus {
  running: boolean;
  tools: string[];
  /** At least one mail account is open to a contained reader agent. */
  mail_open?: boolean;
  /** With `mail_open`: the widest per-account scope — a few marked messages,
   *  or a whole account. */
  mail_scope?: "marked" | "all";
  /** Root agents run fenced, so the staged-write review cannot be bypassed. */
  review_enforced?: boolean;
  /** A root agent started now could read the projects (the fence switch is
   *  on, or it runs unfenced) — what a mail draft's `attach` needs. */
  projects_readable?: boolean;
}

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

/** The eight resize grips, in the order they are drawn (edges, then corners). */
const FRAME_GRIPS: RootOverlayDragMode[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/**
 * A press on the title bar that must NOT start a window move: the controls have
 * their own jobs, and a tab's own press is the tab drag.
 */
const BAR_NO_DRAG = ".tab, button, .root-overlay-rights, .untested-tag";

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
 * The **root console** (see `stores/rootOverlay` for why it is an overlay): one
 * floating subwindow over whatever project is open, holding the root scope's
 * tabs. Its chrome is a subwindow's own — `.subwindow` / `.tab-bar` /
 * `.tab-strip` / `.tab` — so it reads as the thing it replaced, lifted off the
 * page.
 *
 * Two jobs live in the always-mounted host rather than the dialog, because both
 * must run while it is closed: the **persist** of the root scope (`CenterPanel`
 * saves the *active* scope only, and root no longer becomes active), and the
 * **`root-mcp-changed`** listener — a root agent that adds a calendar entry
 * through Tabtivity's MCP tools wrote `calendar.json` behind the window's back, so
 * the row is merged into the store here and announced through the same hook a
 * dialog edit uses, which is what carries it to CalDAV.
 */
export function RootOverlayHost() {
  const open = useRootOverlayStore((s) => s.open);
  useEffect(() => {
    const refresh = () => { void useRootReviewStore.getState().refresh(); };
    const unlisten = listen<number>("root-mcp-review-changed", refresh);
    void unlisten.then(refresh);
    return () => { void unlisten.then((stop) => stop()); };
  }, []);
  const rootTabs = useTabsStore((s) => s.tabsByScope[ROOT_SCOPE]);
  useEffect(() => {
    void useRootReviewStore.getState().refresh();
  }, [rootTabs, open]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => { void useRootReviewStore.getState().refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [open]);
  const rootLayout = useTabsStore((s) => s.layoutByScope[ROOT_SCOPE]);
  const activeScope = useTabsStore((s) => s.scope);

  useEffect(() => {
    // Absent key = never hydrated: a save now would erase the layout on disk.
    // While root IS the active scope, CenterPanel's own save covers it.
    if (rootTabs === undefined || activeScope === ROOT_SCOPE) return;
    const timer = window.setTimeout(() => {
      useTabsStore.getState().persistScope(ROOT_SCOPE, "").catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [rootTabs, rootLayout, activeScope]);

  useEffect(() => {
    const unlisten = listen<RootMcpChange>("root-mcp-changed", ({ payload }) => {
      const upsert = <T extends { id: string }>(rows: T[], row: T) =>
        rows.some((r) => r.id === row.id)
          ? rows.map((r) => (r.id === row.id ? row : r))
          : [...rows, row];
      // A mail draft lives in the mail store, not the calendar: re-read the
      // list. It opens nothing and steals no focus; the row shows its mark.
      if (payload.kind === "draft") {
        void useMailStore.getState().loadAgentDrafts();
        return;
      }
      // A new calendar is Tabtivity's own: merged, never pushed anywhere.
      if (payload.kind === "calendar") {
        const row = payload.row;
        useCalendarStore.setState((s) => ({ calendars: payload.op === "delete" ? s.calendars.filter((c) => c.id !== row.id) : upsert(s.calendars, row) }));
        return;
      }
      useCalendarStore.setState((s) => {
        if (payload.kind === "event") {
          return payload.op === "delete"
            ? { events: s.events.filter((e) => e.id !== payload.row.id) }
            : { events: upsert(s.events, payload.row) };
        }
        return payload.op === "delete"
          ? { tasks: s.tasks.filter((task) => task.id !== payload.row.id) }
          : { tasks: upsert(s.tasks, payload.row) };
      });
      // A root agent's first board move is what seeds the columns (a read
      // never does), so a card naming a column the store has not seen means the
      // board just came into existence — re-read, as `moveTasks` does.
      if (payload.kind === "task" && payload.op === "upsert" && payload.row.column) {
        const { taskColumns, reload } = useCalendarStore.getState();
        if (!taskColumns.some((c) => c.id === payload.row.column)) void reload().catch(() => {});
      }
      if (payload.local) return;
      void notifyCalendarWrite(payload).catch(() => {});
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  return open ? <RootOverlay /> : null;
}

/**
 * The console itself. The root scope's layout is rendered as it is stored —
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
 * With a single subwindow its strip sits in the console's own title bar; once
 * the layout is split every subwindow carries its own bar.
 *
 * Three things a floating window needs and this one lacked. Every subwindow
 * docks the **file viewer** on its right edge through the same ◫ a project's
 * subwindows carry (`SubwindowFilesSidebar` → `ProjectFilesTab`, so no fourth
 * copy of the viewer), rooted at `~/tabtivity/root` — the folder that belongs to no
 * project and until now could only be read with `ls` from inside the console.
 * The state is the group node's own (`filesOpen`/`filesWidth`/`filesFolder`),
 * written through the `…InScope` actions because root is not the active scope.
 * The console also **moves** (drag the title bar) and **resizes** (eight grips),
 * with the frame remembered per machine in `stores/rootOverlay`; ⤢ fills the
 * window and ⤡ comes back. The frame is re-clamped against the window it opens
 * in, so a console sized on an external display is still reachable without one.
 */
function RootOverlay() {
  // Agent drafts awaiting approval and staged `.ics` imports wait for the user
  // exactly as proposals do, so the badge counts all three.
  const reviewCount =
    useRootReviewStore((s) => s.count) + useRootReviewStore((s) => s.imports.length)
    + useMailStore((s) => s.pendingAgentDrafts.length);
  // The proposals panel the ✓ Approvals button drops. Open/closed is the review
  // store's, so a flow that floats the console can also open it at the rows;
  // the console clears it on the way out (below).
  const reviewPanel = useRootReviewStore((s) => s.panel);
  const setReviewPanel = useRootReviewStore((s) => s.setPanel);
  const approvalsRef = useRef<HTMLButtonElement | null>(null);
  const [reviewAnchor, setReviewAnchor] = useState<{ x: number; y: number } | null>(null);
  const t = useT();
  const tabs = useTabsStore((s) => s.tabsByScope[ROOT_SCOPE] ?? NO_TABS);
  const layout = useTabsStore((s) => s.layoutByScope[ROOT_SCOPE] ?? null);
  const storedFocus = useTabsStore((s) => s.focusedGroupByScope[ROOT_SCOPE] ?? null);
  const close = useRootOverlayStore((s) => s.close);
  const storedFrame = useRootOverlayStore((s) => s.frame);
  const filled = useRootOverlayStore((s) => s.filled);
  const toggleFilled = useRootOverlayStore((s) => s.toggleFilled);
  const rootDir = useProjectsStore((s) => s.rootDir) ?? "";
  const [addMenu, setAddMenu] = useState<{ x: number; y: number; groupId: string | null } | null>(
    null,
  );
  const [manageAgents, setManageAgents] = useState(false);
  const [status, setStatus] = useState<RootMcpStatus | null>(null);
  const [drag, setDrag] = useState<OverlayDrag | null>(null);
  const [groupRects, setGroupRects] = useState<Record<string, Rect>>({});
  // The frame while a move/resize drag is in flight — local, so a gesture costs
  // no store write per pointer move (the docked file column's own bargain).
  const [liveFrame, setLiveFrame] = useState<RootOverlayFrame | null>(null);
  const [framing, setFraming] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === "undefined" ? 0 : window.innerWidth,
    h: typeof window === "undefined" ? 0 : window.innerHeight,
  }));
  const regionRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    invoke<RootMcpStatus>("root_mcp_status").then(setStatus).catch(() => setStatus(null));
    void useMailStore.getState().loadAgentDrafts();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape inside a pane is the pane's (an agent TUI's cancel key); the
      // toggle chord closes from there. A menu or a drag of ours goes first.
      if (regionRef.current && e.target instanceof Node && regionRef.current.contains(e.target)) return;
      // The proposals panel takes Escape first (the portal's own handler, on the
      // document, marks it handled) — closing the console under an open panel
      // would take the pending decision with it.
      if (addMenu || manageAgents || dragging || framing || reviewPanel || e.defaultPrevented) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, addMenu, manageAgents, dragging, framing, reviewPanel]);

  // ── The console's own frame ─────────────────────────────────────────────
  // A remembered frame is re-clamped against the window it actually opens in,
  // so a console sized on an external display is still reachable on the laptop.
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Memoised because the proposals panel's anchor effect below depends on it:
  // both helpers build a NEW frame object, so an inline expression would make
  // the effect run on every render, set a new anchor, and render again — the
  // update loop React aborts the whole tree over (#185, a white window).
  const frame = useMemo(
    () =>
      liveFrame ??
      (filled
        ? filledRootOverlayFrame(viewport.w, viewport.h)
        : storedFrame
          ? clampRootOverlayFrame(storedFrame, viewport.w, viewport.h)
          : null),
    [liveFrame, filled, storedFrame, viewport.w, viewport.h],
  );

  // The panel hangs from the badge, so its point is re-read whenever the badge
  // moves: a console dragged, resized or filled with the panel open would
  // otherwise leave it behind. The portal clamps it into the viewport.
  useLayoutEffect(() => {
    if (!reviewPanel) {
      setReviewAnchor(null);
      return;
    }
    const rect = approvalsRef.current?.getBoundingClientRect();
    const next = rect ? { x: rect.left, y: rect.bottom + 4 } : null;
    // Same point, same object: a fresh {x,y} every run would re-render, re-run
    // this effect and loop, whatever its dependencies happen to be.
    setReviewAnchor((prev) =>
      prev && next && prev.x === next.x && prev.y === next.y ? prev : next,
    );
  }, [reviewPanel, frame, filled, viewport.w, viewport.h]);

  // A closed console has no badge for the panel to hang from.
  useEffect(() => () => useRootReviewStore.getState().setPanel(false), []);

  /**
   * Move or resize the console. The release is bound synchronously inside
   * pointerdown (WebKitGTK delivers the terminal event only to listeners that
   * existed before the gesture began — the tab drag's rule), and the start rect
   * is the element's OWN, so a drag on a console still wearing the stylesheet's
   * default size takes over from it seamlessly.
   */
  const beginFrameDrag = useCallback((e: React.PointerEvent, mode: RootOverlayDragMode) => {
    if (e.button !== 0) return;
    const el = frameRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    const start: RootOverlayFrame = { x: r.left, y: r.top, width: r.width, height: r.height };
    const sx = e.clientX;
    const sy = e.clientY;
    let latest = start;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      // A press on the bar is usually a click on the bar; only a travelled one
      // is a move. A grip has no other meaning, so it takes the first pixel.
      if (!moved && mode === "move" && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX) return;
      moved = true;
      latest = rootOverlayFrameDrag(
        start,
        mode,
        ev.clientX - sx,
        ev.clientY - sy,
        window.innerWidth,
        window.innerHeight,
      );
      setLiveFrame(latest);
    };
    const teardown = () => {
      window.removeEventListener("pointermove", onMove);
      setLiveFrame(null);
      setFraming(false);
    };
    setFraming(true);
    bindDragRelease({
      onCommit: () => {
        const committed = moved ? latest : null;
        teardown();
        if (committed) useRootOverlayStore.getState().setFrame(committed);
      },
      onAbort: teardown,
    });
    window.addEventListener("pointermove", onMove);
  }, []);

  const onBarPointerDown = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest(BAR_NO_DRAG)) return;
    beginFrameDrag(e, "move");
  };

  // ── Measurement ─────────────────────────────────────────────────────────
  const measure = useCallback(() => {
    const region = regionRef.current;
    if (!region) return;
    const base = region.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    for (const [id, el] of bodyRefs.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      next[id] = { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
    }
    setGroupRects((prev) => {
      const keys = Object.keys(next);
      const same =
        keys.length === Object.keys(prev).length &&
        keys.every((k) => {
          const a = next[k];
          const b = prev[k];
          return !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
        });
      return same ? prev : next;
    });
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, renderLayout]);

  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(region);
    for (const el of bodyRefs.current.values()) ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, renderLayout]);

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

  // The global switch is the settings store's, so the badge follows a flip made
  // in Settings at once; `running` is the listener's and only a restart moves it.
  const toolsEnabled = useSettingsStore((s) => s.settings?.root_mcp ?? true);
  const localOnly = useSettingsStore((s) => s.settings?.root_mcp_local_only ?? false);
  const toolsOn = toolsEnabled && !!status?.running;
  // `=== false`: a backend that predates the field says nothing, which is not
  // a claim that the gate is off.
  const reviewAdvisory = toolsOn && status?.review_enforced === false;
  const agentsWithTools = !toolsEnabled
    ? t("rootConsole.rightsDisabled")
    : status?.running
      ? t(localOnly ? "rootConsole.rightsLocalOnly" : "rootConsole.rightsOn")
      : t("rootConsole.rightsOff");
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
  const previewRect =
    drag?.overGroup && drag.edge ? groupRects[drag.overGroup] : undefined;
  const frameStyle: React.CSSProperties | undefined = frame
    ? { position: "fixed", left: frame.x, top: frame.y, width: frame.width, height: frame.height, margin: 0 }
    : undefined;

  // Everything inside opens its tabs in ROOT: the file column's double-clicks,
  // a Files tab's "Open in a new tab", a viewer's links and compiled PDFs. Root
  // is not the active scope while the console floats, and the plain `addTab`
  // those paths default to would file them onto the project underneath.
  return (
    <TabScopeContext.Provider value={ROOT_SCOPE}>
    <div
      className="modal-backdrop root-overlay-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={frameRef}
        className={`root-overlay subwindow focused${drag ? " dragging" : ""}${
          split ? " split-layout" : ""
        }${framing ? " framing" : ""}`}
        style={frameStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t("rootConsole.title")}
      >
        {/* Resize grips, one per edge and corner. Withheld while the console
            fills the window — there is nothing to drag them into. */}
        {!filled &&
          FRAME_GRIPS.map((mode) => (
            <div
              key={mode}
              className={`root-overlay-grip grip-${mode}`}
              title={t("rootConsole.resizeHint")}
              onPointerDown={(e) => beginFrameDrag(e, mode)}
            />
          ))}
        {/* The title bar is also the move handle (and double-click fills the
            window): a floating subwindow you cannot put somewhere else is a
            dialog, and this one holds terminals. A press on a tab or a control
            keeps its own meaning — see BAR_NO_DRAG. */}
        <div
          className="tab-bar root-overlay-bar"
          onPointerDown={onBarPointerDown}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement | null)?.closest(BAR_NO_DRAG)) return;
            toggleFilled();
          }}
        >
          <div className="root-overlay-mark" title={t("rootConsole.moveHint")}>
            <StarIcon />
          </div>
          {soleGroupId &&
            stripFor(soleGroupId, sole?.tabKeys ?? [], sole?.activeKey ?? null)}
          <div
            className="tab-controls root-overlay-controls"
            style={soleFiles ? filesReserveStyle(sole ?? undefined) : undefined}
          >
            {/* The badge only REPORTS what the tools are — which of them a root
                tab gets, whether mail is open, whether the review gate is
                enforced. It used to double as the door to the proposals, so one
                control answered two questions and the count read as part of the
                tools' own state; the ✓ button beside it is that door now, and
                the panel hangs from the button that counts it. Switching the
                tools on and off stays in Settings, where it always was. */}
            <span
              className={`root-overlay-rights status${toolsOn ? " on" : ""}${toolsEnabled ? "" : " off"}`}
              title={`${agentsWithTools}${
                toolsOn ? `\n${status?.tools.join(", ")}` : ""
              }\n${t("rootConsole.rightsInSettings")}\n${t("rootConsole.noPhone")}${
                status?.mail_open
                  ? `\n${t(status.mail_scope === "all" ? "rootConsole.mailOpenAll" : "rootConsole.mailOpen")}`
                  : ""
              }${reviewAdvisory ? `\n${t("rootConsole.reviewAdvisory")}` : ""}`}
            >
              {t("rootConsole.rightsBadge")}{reviewAdvisory && <> <WarningIcon /></>}
              {status?.mail_open && <> <MailIcon />{status.mail_scope === "all" && <MailIcon />}</>}
            </span>
            <button
              type="button"
              ref={approvalsRef}
              className={`root-overlay-rights root-overlay-approvals${reviewCount > 0 ? " on" : ""}`}
              aria-expanded={reviewPanel}
              title={t("rootReview.badgeHint")}
              onClick={() => setReviewPanel(!reviewPanel)}
            >
              {t("rootReview.badge")}{reviewCount > 0 ? ` ${reviewCount}` : ""} ▾
            </button>
            <UntestedTag id="rootOverlay.1" />
            <UntestedTag id="rootOverlay.viewers" />
            {!split && soleGroupId && soleGroupId !== EMPTY_GROUP_ID && (
              filesToggle(soleGroupId, !!sole?.filesOpen)
            )}
            <button
              className="subwindow-hide"
              title={filled ? t("rootConsole.restore") : t("rootConsole.fill")}
              onClick={toggleFilled}
            >
              {filled ? "⤡" : "⤢"}
            </button>
            <button className="subwindow-hide" title={t("common.close")} onClick={close}>
              ×
            </button>
          </div>
        </div>
        <div className="subwindow-body">
          <div className="subwindow-pane-region root-overlay-region" ref={regionRef}>
            {tabs.length === 0 || !renderLayout ? (
              <div className="center-placeholder" style={{ height: "100%" }}>
                <div className="center-placeholder-card">
                  <div className="center-placeholder-title">{t("rootConsole.emptyTitle")}</div>
                  <div className="center-placeholder-hint">{t("rootConsole.emptyHint")}</div>
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
      </div>
      {/* The proposals, dropped from the badge (`common/ContextMenuPortal`, the
          one popover: click-away, Escape, viewport clamp, no z-index here).
          `keepBelow` keeps it under the badge and caps it to the room beneath,
          so a long queue scrolls inside the panel instead of sliding up over
          the bar it came from. */}
      {reviewPanel && reviewAnchor && (
        <ContextMenuPortal
          x={reviewAnchor.x}
          y={reviewAnchor.y}
          keepBelow
          className="context-menu root-review-panel"
          onClose={() => setReviewPanel(false)}
        >
          <RootReviewStrip advisory={reviewAdvisory} />
        </ContextMenuPortal>
      )}
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
    </div>
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
  return (
    <div className="tab-strip" ref={stripRef}>
      {tabs.map((tab) => {
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
        return (
          <div
            key={tab.key}
            className={`tab ${isActive ? "active" : ""}${stateClass}${install ? " install-pending" : ""}${
              draggingKey === tab.key ? " dragging" : ""
            }`}
            title={install ? t("rootConsole.installTabTitle") : undefined}
            onPointerDown={(e) => onTabPointerDown(e, tab, groupId)}
            onMouseDown={() => {
              if (isActive) clearAttention(ptyId);
              if (install) clearInstallTab(tab.key);
              if (groupId === EMPTY_GROUP_ID) return;
              useTabsStore.getState().setGroupActiveInScope(ROOT_SCOPE, groupId, tab.key);
            }}
          >
            <TabStatusMark stateClass={stateClass} />
            <span className="tab-label">{tab.label}</span>
            <TabAgentModeMarks scope={ROOT_SCOPE} tab={tab} isActive={isActive} />
            {install && <UntestedTag id="rootConsole.installTabTitle" />}
            <button
              className="tab-close"
              title={t("detachedTabs.closeTab")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                clearInstallTab(tab.key);
                useTabsStore.getState().removeTabInScope(ROOT_SCOPE, tab.key);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
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
