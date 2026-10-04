import { useEffect, useRef } from "react";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { useFloatingFrame } from "../common/useFloatingFrame";
import { CalendarGlyph } from "../header/HeaderGlyphs";
import { OverlayApprovals } from "../layout/OverlayApprovals";
import { OverlayAgentColumn, OverlayAgentToggle } from "../layout/OverlayAgentColumn";
import { useOverlayAgent, useOverlayAgentMaxWidth } from "../layout/useOverlayAgent";
import { CalendarPane } from "./CalendarPane";
import { storageKey } from "../../lib/brand";

/**
 * The header calendar button's overlay — the twin of `MailOverlayHost`, and the
 * same bargain: it renders the *same* `CalendarPane` a calendar tab renders, not
 * a second calendar UI. The store is already global (one `calendar.json` across
 * every scope), so the overlay and any open tab are two views of one set of
 * events and cannot drift; all this adds is a size and a way to close it.
 *
 * It wears mail's chrome — the root console's, not a dialog's: one floating
 * subwindow (`.root-overlay.subwindow`) whose title bar holds the calendar
 * glyph and name, a tab strip, then the approvals, fill and × controls. The
 * strip has a single fixed tab, the calendar's counterpart of mail's Inbox: the
 * pane's view switcher (day / week / month / agenda / tasks) is the pane's own
 * local state, driven by its toolbar chips and its digit keys exactly as in a
 * calendar tab, so it stays in the pane rather than being lifted into the bar.
 */
export function CalendarOverlayHost() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.calendar_global_app ?? false);
  const open = useCalendarStore((s) => s.overlayOpen);

  // Turning the setting off takes the surface away rather than leaving it on
  // screen over a button that is no longer there — the same withdrawal rule the
  // mail overlay follows for its gate.
  const live = enabled && open;
  // Moves, resizes and fills like the root console; remembered per overlay.
  const { frameRef, frameStyle, frameClass, barProps, grips, fillButton } =
    useFloatingFrame(storageKey("calendarOverlayFrame"));
  // `barProps.title` is the move hint; on the whole bar it would hover over the
  // tab too, so it goes on the mark alone (the root console's placement).
  const { title: moveHint, ...barRest } = barProps;
  // The docked root agent beside the calendar (Ctrl+1–9 here, or the bar's
  // button), capped to leave the calendar room (`overlayAgentMaxWidth`).
  const agent = useOverlayAgent("calendar", live);
  const bodyRef = useRef<HTMLDivElement>(null);
  const agentMaxWidth = useOverlayAgentMaxWidth(bodyRef, live);

  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape typed into the docked agent is its cancel key, not "close" —
      // the root console's `regionRef` rule.
      if ((e.target as Element | null)?.closest?.(".overlay-agent-column")) return;
      // An Escape the approvals panel (or anything else) already took is not ours.
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        useCalendarStore.getState().closeOverlay();
      }
    };
    // The pane hosts the event dialog and a search field, both of which stop
    // their own Escape — so this window-level listener only ever sees one
    // nothing else claimed.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);

  if (!live) return null;

  return (
    <div
      className="modal-backdrop root-overlay-backdrop app-overlay-backdrop calendar-overlay-backdrop"
      onMouseDown={(e) => {
        // Backdrop only — a drag that starts on the grid and ends out here
        // (creating or resizing an event) must not be read as "dismiss".
        if (e.target === e.currentTarget) useCalendarStore.getState().closeOverlay();
      }}
    >
      <div
        ref={frameRef}
        className={`root-overlay subwindow focused calendar-overlay ${frameClass}`}
        style={frameStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t("calendar.overlayTitle")}
      >
        {grips}
        {/* The root console's bar: mark, tab strip, controls. The bar is the
            move handle; buttons keep their own press. */}
        <div {...barRest} className={`tab-bar root-overlay-bar ${barRest.className}`}>
          <div className="root-overlay-mark app-overlay-mark calendar-overlay-mark" title={moveHint}>
            <CalendarGlyph className="calendar-overlay-glyph" />
            <span className="app-overlay-label">{t("calendar.overlayTitle")}</span>
            <UntestedTag id="calendar.overlayTitle" />
          </div>
          <div className="tab-strip calendar-tab-strip" role="tablist">
            {/* One fixed tab, mail's Inbox without the siblings: the calendar
                has no documents to open beside it, but the bar keeps the same
                anatomy as every other overlay in this chrome. */}
            <div role="tab" tabIndex={0} aria-selected="true" className="tab calendar-tab active">
              <span className="tab-label">{t("calendar.overlayTab")}</span>
            </div>
          </div>
          <div className="tab-controls root-overlay-controls">
            <OverlayAgentToggle handle={agent} />
            <OverlayApprovals domain="calendar" />
            {fillButton}
            <button
              type="button"
              className="subwindow-hide"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={() => useCalendarStore.getState().closeOverlay()}
            >
              ×
            </button>
          </div>
        </div>
        <div ref={bodyRef} className="subwindow-body calendar-overlay-body app-overlay-body-row" role="tabpanel">
          <CalendarPane visible />
          {agent.showColumn && (
            <OverlayAgentColumn
              app="calendar"
              tab={agent.tab}
              hint={agent.hint}
              maxWidth={agentMaxWidth}
              focusRequest={agent.focusRequest}
              onDismissHint={agent.dismissHint}
            />
          )}
        </div>
      </div>
    </div>
  );
}
