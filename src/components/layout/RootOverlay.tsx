import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { subscribeTauri, useTauriListener } from "../../hooks/useTauriListener";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useFloatingFrame } from "../common/useFloatingFrame";
import { storageKey } from "../../lib/brand";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { ARRIVAL_MS, useArrivalsStore } from "../../stores/calendar/arrivals";
import { ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { notifyCalendarWrite } from "../../lib/calendar/calendarWriteHook";
import type { Calendar, CalendarEvent, CalendarTask } from "../../types";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { StarIcon } from "./StarIcon";
import { OverlayApprovals } from "./OverlayApprovals";
import { useRootReviewStore } from "../../stores/rootReview";
import { useMailStore } from "../../stores/mail";
import { useRootMcpRights } from "./RootRightsBadge";
import { usePoll } from "../../lib/usePoll";
import { CloseIcon } from "../common/icons/Icon";
import { RootView, type RootBarSlots } from "./RootView";

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
  useTauriListener(() => {
    const refresh = () => { void useRootReviewStore.getState().refresh(); };
    return listen<number>("root-mcp-review-changed", refresh).then((stop) => {
      refresh();
      return stop;
    });
  }, []);
  const rootTabs = useTabsStore((s) => s.tabsByScope[ROOT_SCOPE]);
  useEffect(() => {
    void useRootReviewStore.getState().refresh();
  }, [rootTabs, open]);
  // The effect above reads on open; then every 5 s while the window is in front.
  const refreshReview = useCallback(() => useRootReviewStore.getState().refresh(), []);
  usePoll(refreshReview, 5000, { enabled: open, immediate: false });
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
    // Ids an agent deleted moments ago: a move to another calendar arrives as
    // a delete and an upsert of the same id, and that is an update, not an
    // arrival. Pruned on every event, so it holds a few ids at most.
    const justDeleted = new Map<string, number>();
    return subscribeTauri(() => listen<RootMcpChange>("root-mcp-changed", ({ payload }) => {
      const upsert = <T extends { id: string }>(rows: T[], row: T) =>
        rows.some((r) => r.id === row.id)
          ? rows.map((r) => (r.id === row.id ? row : r))
          : [...rows, row];
      const now = Date.now();
      for (const [id, at] of justDeleted) if (now - at > ARRIVAL_MS) justDeleted.delete(id);
      // A mail draft lives in the mail store, not the calendar: re-read the
      // list. It opens nothing and steals no focus; the row shows its mark.
      // No arrival here: an agent draft always lands unfiled, in the approvals
      // list, and reaches "Drafted by agents" only through the user's ✓.
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
      // Read before the merge: only an id the store has never held flies in.
      // An update, a board-only move (`local`) or a delete plays nothing. A
      // store that has not loaded yet holds no rows to compare against, so
      // it marks nothing: every update would look new.
      if (payload.op === "delete") {
        justDeleted.set(payload.row.id, now);
      } else if (!payload.local && !justDeleted.delete(payload.row.id)) {
        const before = useCalendarStore.getState();
        const rows: { id: string }[] = payload.kind === "event" ? before.events : before.tasks;
        if (before.loaded && !rows.some((r) => r.id === payload.row.id)) useArrivalsStore.getState().markArrived([payload.row.id]);
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
    }));
  }, []);

  return open ? <RootOverlay /> : null;
}

/**
 * The console's window: backdrop, the shared floating frame (move, eight grips,
 * fill), the title bar with its slots, the ✓ Approvals pill, and the one Escape
 * rule. What is inside — the root scope's layout, panes, drag, the + menu, the
 * file column — is `RootView`, which portals the strip, the ⚿ badge and the ◫
 * toggle into the bar's slots.
 */
function RootOverlay() {
  const t = useT();
  const close = useRootOverlayStore((s) => s.close);
  // The window's frame — the one hook the header overlays use: moved by the
  // title bar, eight grips, double-click / ⤢ fills. Remembered per machine
  // (`rootConsoleFrame`, localStorage) and re-clamped against the window it
  // opens in, so a console sized on an external display is reachable without one.
  const { frameRef, frameStyle, frameClass, framing, barProps, grips, fillButton } =
    useFloatingFrame(storageKey("rootConsoleFrame"));
  // The ⚿ badge's reading (`root_mcp_status`, once per mount) — also what
  // tells the ✓ Approvals panel whether the review gate is only advisory.
  const rights = useRootMcpRights();
  const busyRef = useRef(false);
  // Callback refs into state: the view portals into these once they exist.
  const [stripEl, setStripEl] = useState<HTMLElement | null>(null);
  const [rightsEl, setRightsEl] = useState<HTMLElement | null>(null);
  const [filesEl, setFilesEl] = useState<HTMLElement | null>(null);
  const [controlsStyle, setControlsStyle] = useState<React.CSSProperties | undefined>(undefined);

  useEffect(() => {
    void useMailStore.getState().loadAgentDrafts();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape inside a pane is the pane's (an agent TUI's cancel key); the
      // toggle chord closes from there.
      if (e.target instanceof Element && e.target.closest(".root-overlay-region")) return;
      // A menu, dialog or drag of the view goes first, then a gesture of ours,
      // then the proposals panel (the portal's own handler, on the document,
      // marks it handled) — closing the console under an open panel would take
      // the pending decision with it.
      if (busyRef.current || framing || e.defaultPrevented) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, framing]);

  const { title: moveHint, ...barRest } = barProps;
  const slots: RootBarSlots = {
    strip: stripEl,
    rights: rightsEl,
    files: filesEl,
    onBarPointerDown: barProps.onPointerDown,
    onBarDoubleClick: barProps.onDoubleClick,
    setControlsStyle,
  };

  return (
    <div
      className="modal-backdrop root-overlay-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={frameRef}
        className={`root-overlay subwindow focused ${frameClass}`}
        style={frameStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t("rootConsole.title")}
      >
        {/* Resize grips, one per edge and corner (withheld while the console
            fills the window — there is nothing to drag them into). */}
        {grips}
        {/* The title bar is also the move handle (and double-click fills the
            window): a floating subwindow you cannot put somewhere else is a
            dialog, and this one holds terminals. A press on a tab or a control
            keeps its own meaning — see `useFloatingFrame`'s BAR_NO_DRAG. */}
        <div {...barRest} className={`tab-bar root-overlay-bar ${barRest.className}`}>
          <div className="root-overlay-mark" title={moveHint}>
            <StarIcon />
          </div>
          <div className="root-overlay-slot" ref={setStripEl} />
          <div className="tab-controls root-overlay-controls" style={controlsStyle}>
            {/* The badge only REPORTS what the tools are — which of them a root
                tab gets, whether mail is open, whether the review gate is
                enforced. It used to double as the door to the proposals, so one
                control answered two questions and the count read as part of the
                tools' own state; the ✓ button beside it is that door now, and
                the panel hangs from the button that counts it
                (`OverlayApprovals`, the same pill the header overlays carry).
                Switching the tools on and off stays in Settings, where it
                always was. */}
            <span className="root-overlay-slot" ref={setRightsEl} />
            <UntestedTag id="rootOverlay.1" />
            <OverlayApprovals advisory={rights.reviewAdvisory} />
            <UntestedTag id="rootOverlay.viewers" />
            <span className="root-overlay-slot" ref={setFilesEl} />
            {fillButton}
            <button className="subwindow-hide" title={t("common.close")} onClick={close}>
              <CloseIcon />
            </button>
          </div>
        </div>
        <RootView rights={rights} slots={slots} busyRef={busyRef} />
      </div>
    </div>
  );
}
