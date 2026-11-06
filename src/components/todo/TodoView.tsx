import { useRef } from "react";
import { UntestedTag } from "../common/UntestedTag";
import { OverlayAgentColumn, OverlayAgentToggle } from "../layout/OverlayAgentColumn";
import { ViewBarAgentSlot } from "../layout/viewBarSlots";
import { useOverlayAgent, useOverlayAgentMaxWidth } from "../layout/useOverlayAgent";
import { TodoPane } from "./TodoPane";

/**
 * The **To-do view** of the console window — the todo board's only surface, and
 * the third member of the `MailView` / `CalendarView` family, built the same way
 * for the same reason: a *tab* belongs to a scope, and your to-do list is not a
 * property of whichever project you happen to be looking at.
 *
 * There is deliberately no todo **tab**. The store is the calendar's — one
 * `calendar.json` across every scope — so a scoped tab could only ever show the
 * same board while still being left behind by a project switch, which is exactly
 * the redundancy that retired the mail tab.
 *
 * One gate, `todo_board`, on by default and with no experimental flag above it:
 * the board's cards *are* the calendar's tasks, so it reads one shipped local
 * file and reaches nothing. Switching the gate off takes the view away (the
 * window falls back to Now) rather than leaving it on screen over a button that
 * is no longer there.
 *
 * The window's title bar and ✓ Approvals pill are the view's chrome; this adds
 * the docked root agent beside the board (Ctrl+1–9 here, or the bar's ✦ button,
 * capped to leave the board room, `overlayAgentMaxWidth`). The pane's filters
 * (search, project, tag) are open-ended narrowing, not a handful of views, so
 * they stay in the pane's own toolbar.
 *
 * **Not mounted in a popout.** `DetachedApp` has no header, so there would be no
 * way to open it, and `useTodoStore` is per-window zustand: a second board would
 * hold its own stale filters and its own in-flight drag.
 */
export function TodoView() {
  const agent = useOverlayAgent("todo", true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const agentMaxWidth = useOverlayAgentMaxWidth(bodyRef, true);

  return (
    <div
      ref={bodyRef}
      className="app-view app-view-todo todo-overlay-body app-overlay-body-row"
    >
      <ViewBarAgentSlot>
        <OverlayAgentToggle handle={agent} />
        <UntestedTag id="todo.overlayTitle" />
      </ViewBarAgentSlot>
      <TodoPane />
      {agent.showColumn && (
        <OverlayAgentColumn
          app="todo"
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
