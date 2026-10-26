import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CalendarTask } from "../../types";
import { calendarColor, useCalendarStore } from "../../stores/calendar/calendar";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import {
  type DueDelta,
  dueDelta,
  dueDeltaKey,
  priorityBucket,
  todosDueCount,
  todosOverdue,
  urgentTodos,
} from "../../lib/todoBoard";
import { formatTime, timePart } from "../../lib/calendar/calendarTime";
import { useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { headerMenuCloseDelay, useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { TodoGlyph } from "./HeaderGlyphs";

const MENU_ID = "todo";

/** How often the badge re-reads the clock. Cards fall due at midnight. */
const TICK_MS = 60_000;

/** How many rows a section shows before it says how many it is holding back. */
const SECTION_ROWS = 6;

/**
 * The header's ☑ button — `CalendarIndicator`'s twin, and badged the same way:
 * **derived, never acknowledged**.
 *
 * The number is what is *actionable today* — open cards, on a visible calendar,
 * due today or already overdue. Not "every open card": that is a figure in the
 * hundreds which never falls, and a badge that never falls is one the user learns
 * to ignore. Undated cards are excluded for the same reason — an undated card is
 * a someday, not something today demands.
 *
 * Because it is derived, it needs no dismissal: it drops as the day's cards are
 * ticked and rises again at midnight, which is also why the clock has to be
 * ticked separately (nothing in the store changes when a date rolls over).
 * Whether any of those cards is *overdue* is emphasis on the same badge, never a
 * second number to reconcile against the first.
 *
 * **Hovering reads the cards out** — the calendar button's hover shape, and
 * affordable for its reason: the tasks are already in memory behind one local
 * file, so a pointer crossing the header touches no network and starts no work.
 * Three sections, in the order the day asks about them: **Overdue**, **Today**,
 * **Tomorrow**. Overdue is separate because the badge's own emphasis has to be
 * explainable by something on screen, and tomorrow is separate because a date
 * that is not today, mixed into today's rows, reads as an ordering bug —
 * `CalendarIndicator`'s rule for the same list. Badge and list share ONE
 * selection (`urgentTodos`, which the badge's `todosDueCount` filters the same
 * way) and one `now`, since two `new Date()`s a few lines apart can straddle a
 * midnight, which is exactly the pairing where that would show.
 *
 * A row opens **its own card** (`openCard`), not just the board: a list that has
 * already named the card you want and then drops you at a board of forty is the
 * one place this could still cost a search.
 */
export function TodoIndicator() {
  const t = useT();
  const use24h = useUse24h();
  const enabled = useSettingsStore((s) => s.settings?.todo_board ?? true);
  const tasks = useCalendarStore((s) => s.tasks);
  const calendars = useCalendarStore((s) => s.calendars);
  const overlayOpen = useTodoStore((s) => s.overlayOpen);
  // Shared across every header hover-menu (stores/headerHoverMenu) so switching
  // straight from another one closes it instantly instead of racing its own
  // close-grace timer. `setMenuOpen` mirrors the old local-state setter's
  // boolean signature so the rest of this component reads unchanged.
  const menuOpen = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const setMenuOpen = useCallback(
    (v: boolean) => (v ? openMenu(MENU_ID) : closeMenu(MENU_ID)),
    [openMenu, closeMenu],
  );
  // The hover menu's grace period, so crossing the gap between the button and
  // the list below it does not shut the list you are reaching for.
  const closeTimer = useRef<number | undefined>(undefined);
  // Only ever bumped — the value exists to force the recompute, not to be read.
  const [tick, setTick] = useState(0);

  // One local file and an idempotent load, so unlike mail there is no
  // "don't reach out on mount" rule to respect: the badge needs the tasks before
  // the overlay has ever been opened.
  useEffect(() => {
    if (!enabled) return;
    void useCalendarStore.getState().load();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // Escape, for the list opened by keyboard focus, which has no mouse-leave
  // coming to close it. Capture + `stopPropagation` because the board overlay's
  // own Escape handler is window-level too, and while this list is up, closing
  // it is what the key meant.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen, setMenuOpen]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // The setting switched off with the list open would otherwise leave it painted
  // over a button that is gone.
  useEffect(() => {
    if (!enabled) setMenuOpen(false);
  }, [enabled, setMenuOpen]);

  // One `now` for the badge and the list, re-taken on the same tick.
  const now = useMemo(() => new Date(), [tick]);
  const urgent = useMemo(
    () =>
      enabled
        ? urgentTodos(tasks, calendars, now)
        : { overdue: [], today: [], tomorrow: [] },
    [enabled, tasks, calendars, now],
  );

  if (!enabled) return null;

  const count = todosDueCount(tasks, calendars, now);
  const overdue = todosOverdue(tasks, calendars, now);
  const label =
    count > 0
      ? `${t("todo.indicatorDue", { count })}${overdue ? ` — ${t("todo.indicatorOverdue")}` : ""}`
      : t("todo.indicator");

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    setMenuOpen(true);
  };
  const scheduleClose = (e?: { clientY: number }) => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), headerMenuCloseDelay(e));
  };

  /**
   * A deadline's distance as a phrase — the "3d late" / "in 2h" chip.
   *
   * Days only where the deadline really is a day or more off (`dueDelta`'s
   * rule); inside a day it is read in hours, and inside an hour in minutes.
   * That is the whole point of the chip: to somebody deciding what to do in the
   * next twenty minutes, a card due at some point today and one that has been
   * late since this morning are not the same card, and the day-granular figure
   * called both of them "0".
   */
  const deltaLabel = (d: DueDelta): string =>
    t(dueDeltaKey(d), { count: d.count, hours: d.hours ?? 0 });

  const section = (
    key: "todo.menuOverdue" | "todo.menuToday" | "todo.menuTomorrow",
    rows: CalendarTask[],
    late: boolean,
  ) => (
    <div className="todo-menu-section">
      {/* A section label inside the scroll region rather than pinned — the menu's
          rule: only the *first* group label is the header. Today and tomorrow
          render even when empty, because "nothing due tomorrow" is an answer and
          a section that disappears reads as a list that failed to load; Overdue
          is the one exception (below), since an absent overdue heading says
          exactly what an empty one would, without the alarm word. */}
      <div className="tab-new-menu-group-label">{t(key)}</div>
      {rows.length === 0 ? (
        <div className="tab-new-menu-hint">{t("todo.menuNothingDue")}</div>
      ) : (
        <>
          {rows.slice(0, SECTION_ROWS).map((task) => {
            const bucket = priorityBucket(task.priority);
            // How far off the deadline is, in the largest unit that is still
            // true: days for a card that has been rotting, hours or minutes for
            // one whose **hour** deadline passed earlier today — which the
            // day-granular figure could only call "0", leaving the row to print
            // a bare clock time that read as a due time rather than as lateness.
            const delta = dueDelta(task, now);
            const lateLabel = late && delta ? deltaLabel(delta) : "";
            // Not late yet and inside a day: the countdown is what separates two
            // cards due today, which two clock times do only by arithmetic. A
            // whole-day deadline has no hour to count and gets none (`dueDelta`).
            const soonLabel =
              !late && delta && delta.unit !== "d" ? deltaLabel(delta) : "";
            // A card that is not late yet but *has* an hour shows it: in a list
            // of things due today, "17:00" is the only thing that separates them.
            const dueHour = late ? "" : formatTime(timePart(task.due ?? ""), use24h);
            return (
              <button
                key={task.id}
                type="button"
                role="menuitem"
                className={"tab-new-menu-item todo-menu-row" + (late ? " late" : "")}
                title={task.notes || undefined}
                onClick={() => {
                  setMenuOpen(false);
                  window.clearTimeout(closeTimer.current);
                  useTodoStore.getState().openCard(task.id);
                }}
              >
                {/* The card's calendar colour, so a row is recognisable as the
                    same to-do the board and the calendar's Tasks view paint. */}
                <span
                  className="todo-menu-dot"
                  aria-hidden="true"
                  style={{ background: calendarColor(calendars, task.calendar_id) }}
                />
                <span className="todo-menu-title">
                  {task.title || t("calendar.untitled")}
                </span>
                {/* How late — the one thing a heading reading "Overdue" cannot
                    say, and the difference between three hours ago and a card
                    that has been rotting for three weeks. */}
                {lateLabel && <span className="todo-menu-late">{lateLabel}</span>}
                {/* And how long is left, beside the hour rather than instead of
                    it: "in 2h" is what the row is asking about, "17:00" is where
                    it sits among the others. */}
                {soonLabel && <span className="todo-menu-time">{soonLabel}</span>}
                {dueHour && <span className="todo-menu-time">{dueHour}</span>}
                {bucket === "high" && (
                  <span className="todo-menu-prio" title={t("tasksView.priorityHigh")}>
                    !
                  </span>
                )}
              </button>
            );
          })}
          {rows.length > SECTION_ROWS && (
            <div className="tab-new-menu-hint">
              {t("todo.menuMore", { count: rows.length - SECTION_ROWS })}
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    /* The wrapper the brain, mail and calendar buttons share: `.header-center`
       stretches its children to the full header height, so a bare 32px button
       would sit at the top of the frame instead of centered. The hover handlers
       are the WRAPPER's, not the button's — the list is a child of this element,
       so `mouseleave` holds off while the pointer is anywhere inside it, which is
       what makes a menu hanging below the button walkable into at all. */
    <div
      className="global-apps-menu todo-indicator no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn todo-indicator-btn"
        title={label}
        aria-label={label}
        aria-pressed={overlayOpen}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          // The button keeps its one job — open (or close) the board. The list
          // goes with the click rather than staying up over the overlay it just
          // raised.
          setMenuOpen(false);
          window.clearTimeout(closeTimer.current);
          const store = useTodoStore.getState();
          if (store.overlayOpen) store.closeOverlay();
          else store.openOverlay();
        }}
        // Keyboard reach: tabbing to the button is the one way in no pointer will
        // ever open, and Escape is its way back out.
        onFocus={reveal}
      >
        <TodoGlyph className="todo-indicator-icon" />
        {count > 0 && (
          <span
            className={"todo-indicator-badge" + (overdue ? " overdue" : "")}
            aria-hidden="true"
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {menuOpen && (
        <div
          className="tab-new-menu todo-indicator-menu"
          role="menu"
          aria-label={t("todo.menuUrgent")}
        >
          {/* Pinned title + scrolling region: the unified menu shape (the accent
              rail and the wash live on this element, so it must not be the thing
              that scrolls). */}
          <div className="tab-new-menu-group-label">
            {t("todo.menuUrgent")}
          </div>
          <div className="menu-scroll-region">
            {/* Only when there is one: a standing "Overdue — nothing due" is the
                word "overdue" in the header every time the pointer passes, for a
                state that is the normal one. */}
            {urgent.overdue.length > 0 && section("todo.menuOverdue", urgent.overdue, true)}
            {section("todo.menuToday", urgent.today, false)}
            {section("todo.menuTomorrow", urgent.tomorrow, false)}
          </div>
        </div>
      )}
    </div>
  );
}
