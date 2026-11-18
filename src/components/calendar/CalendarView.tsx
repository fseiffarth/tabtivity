import { lazy, Suspense, useRef } from "react";
import { UntestedTag } from "../common/UntestedTag";
import { OverlayAgentColumn, OverlayAgentToggle } from "../layout/OverlayAgentColumn";
import { ViewBarAgentSlot } from "../layout/viewBarSlots";
import { useOverlayAgent, useOverlayAgentMaxWidth } from "../layout/useOverlayAgent";

// The pane is the same lazily split chunk a calendar tab loads (`TabPane`).
const CalendarPane = lazy(() => import("./CalendarPane").then((m) => ({ default: m.CalendarPane })));

/**
 * The **Calendar view** of the console window — a view of the one window like
 * Mail and To-do, and the same bargain `MailView` makes: it renders the *same*
 * `CalendarPane` a calendar tab renders, not a second calendar UI. The store is
 * already global (one `calendar.json` across every scope), so the view and any
 * open tab are two views of one set of events and cannot drift.
 *
 * The window's title bar and ✓ Approvals pill are the view's chrome; all this
 * adds is the docked root agent beside the pane (Ctrl+1–9 here, or the bar's ✦
 * button, capped to leave the calendar room, `overlayAgentMaxWidth`). The pane's
 * view switcher (day / week / month / agenda / tasks) is the pane's own local
 * state, driven by its toolbar chips and its digit keys exactly as in a
 * calendar tab, so it stays in the pane rather than being lifted into the bar.
 *
 * One gate, `calendar_global_app` (on by default, with no experimental flag
 * above it): switching it off takes the view away (the window falls back to
 * Now, `layout/RootOverlay`) rather than leaving it on screen over a button
 * that is no longer there.
 */
export function CalendarView() {
  const agent = useOverlayAgent("calendar", true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const agentMaxWidth = useOverlayAgentMaxWidth(bodyRef, true);

  return (
    <div
      ref={bodyRef}
      className="app-view app-view-calendar calendar-overlay-body app-overlay-body-row"
    >
      <ViewBarAgentSlot>
        <OverlayAgentToggle handle={agent} />
        <UntestedTag id="calendar.overlayTitle" />
      </ViewBarAgentSlot>
      <Suspense fallback={<div className="pane-loading" aria-busy="true" />}>
        <CalendarPane visible />
      </Suspense>
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
  );
}
