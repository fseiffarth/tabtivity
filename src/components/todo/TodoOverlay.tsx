import { useEffect, useRef } from "react";

import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { useFloatingFrame } from "../common/useFloatingFrame";
import { TodoGlyph } from "../header/HeaderGlyphs";
import { OverlayApprovals } from "../layout/OverlayApprovals";
import { OverlayAgentColumn, OverlayAgentToggle } from "../layout/OverlayAgentColumn";
import { useOverlayAgent, useOverlayAgentMaxWidth } from "../layout/useOverlayAgent";
import { TodoPane } from "./TodoPane";
import { storageKey } from "../../lib/brand";

/**
 * The header ☑ button's overlay — the todo board's only surface, and the third
 * member of the `MailOverlay` / `CalendarOverlay` family, built the same way for
 * the same reason: a *tab* belongs to a scope, and your to-do list is not a
 * property of whichever project you happen to be looking at.
 *
 * There is deliberately no todo **tab**. The store is the calendar's — one
 * `calendar.json` across every scope — so a scoped tab could only ever show the
 * same board while still being left behind by a project switch, which is exactly
 * the redundancy that retired the mail tab.
 *
 * One gate, `todo_board`, off by default and with no experimental flag above it:
 * the board's cards *are* the calendar's tasks, so it reads one shipped local
 * file and reaches nothing. Switching the gate off takes the surface away rather
 * than leaving it on screen over a button that is no longer there — the same
 * withdrawal rule both sibling overlays follow.
 *
 * It wears mail's chrome — the root console's floating subwindow
 * (`.root-overlay.subwindow`), whose title bar is mark, tab strip, controls —
 * so the header overlays share one top frame. The strip holds a single fixed,
 * never-closing "Board" tab (mail's Inbox without the rest): the pane's filters
 * (search, project, tag) are open-ended narrowing, not a handful of views, so
 * they stay in the pane's own toolbar rather than becoming tabs. The backdrop
 * keeps `.modal-backdrop`'s z-index, which the shell's mount order (after mail
 * and the calendar) tie-breaks so the most recently opened surface is on top.
 *
 * **Not mounted in a popout.** `DetachedApp` has no header, so there would be no
 * way to open it, and `useTodoStore` is per-window zustand: a second board would
 * hold its own stale filters and its own in-flight drag.
 */
export function TodoOverlayHost() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.todo_board ?? false);
  const open = useTodoStore((s) => s.overlayOpen);

  const live = enabled && open;
  // Moves, resizes and fills like the root console; remembered per overlay.
  const { frameRef, frameStyle, frameClass, barProps, grips, fillButton } =
    useFloatingFrame(storageKey("todoOverlayFrame"));
  // The docked root agent beside the board (Ctrl+1–9 here, or the bar's
  // button), capped to leave the board room (`overlayAgentMaxWidth`).
  const agent = useOverlayAgent("todo", live);
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
        useTodoStore.getState().closeOverlay();
      }
    };
    // Every text input inside the pane stops its own Escape — it has to, because
    // `stopPropagation` does not stop sibling listeners on `window`, so an
    // unguarded Escape while renaming a card would reach this and tear the board
    // down mid-edit. What arrives here is only an Escape nothing else claimed.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);

  if (!live) return null;

  // `barProps.title` is the move hint; on the whole bar it would hover over the
  // tab, so it goes on the mark alone (the root console's placement).
  const { title: moveHint, ...barRest } = barProps;

  return (
    <div
      className="modal-backdrop root-overlay-backdrop app-overlay-backdrop"
      onMouseDown={(e) => {
        // Backdrop only: a card drag that starts on the board and ends out here
        // must not be read as "dismiss".
        if (e.target === e.currentTarget) useTodoStore.getState().closeOverlay();
      }}
    >
      <div
        ref={frameRef}
        className={`root-overlay subwindow focused todo-overlay ${frameClass}`}
        style={frameStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t("todo.overlayTitle")}
      >
        {grips}
        {/* The root console's bar: mark, tab strip, controls. The bar is the
            move handle; the tab and buttons keep their own press. */}
        <div {...barRest} className={`tab-bar root-overlay-bar ${barRest.className}`}>
          <div className="root-overlay-mark app-overlay-mark" title={moveHint}>
            <TodoGlyph className="todo-overlay-glyph" />
            <span className="app-overlay-label">{t("todo.overlayLabel")}</span>
            <UntestedTag id="todo.overlayTitle" />
          </div>
          <div className="tab-strip" role="tablist">
            {/* The board: the window's one tab, always active, never closes. */}
            <div role="tab" tabIndex={0} aria-selected="true" className="tab todo-overlay-tab active">
              <span className="tab-label">{t("todo.tabBoard")}</span>
            </div>
          </div>
          <div className="tab-controls root-overlay-controls">
            <OverlayAgentToggle handle={agent} />
            <OverlayApprovals domain="todo" />
            {fillButton}
            <button
              type="button"
              className="subwindow-hide"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={() => useTodoStore.getState().closeOverlay()}
            >
              ×
            </button>
          </div>
        </div>
        <div ref={bodyRef} className="subwindow-body todo-overlay-body app-overlay-body-row">
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
      </div>
    </div>
  );
}
