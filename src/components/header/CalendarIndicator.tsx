import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  calendarColor,
  dayAgenda,
  eventsLeftToday,
  occurrenceEnded,
  occurrenceStale,
  useCalendarStore,
} from "../../stores/calendar/calendar";
import { useSettingsStore } from "../../stores/settings";
import { formatTime, timePart } from "../../lib/calendar/calendarTime";
import { useUse24h } from "../../lib/timeFormat";
import { conferenceLink } from "../../lib/calendar/conference";
import { joinConference } from "../../lib/linkTarget";
import { useT } from "../../lib/i18n";
import { headerMenuCloseDelay, useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { CalendarGlyph } from "./HeaderGlyphs";
import { mutedCalendarIds } from "../../lib/calendar/alarms";
import { VideoIcon } from "../common/icons/Icon";

const MENU_ID = "calendar";

/** How often the badge re-reads the clock. Events tick past on the minute, and a
 *  count that only moved when the store changed would sit on yesterday's number
 *  through a window left open overnight. */
const TICK_MS = 60_000;

/**
 * The header's calendar button — the twin of `MailIndicator`, and built the same
 * way for the same reason: a calendar tab belongs to a scope and is left behind
 * by a project switch, while your calendar is not a property of the project you
 * happen to be looking at. One button in the header, always in the same place,
 * opening the same `CalendarPane` as an overlay (`CalendarOverlayHost`).
 *
 * On by default (`calendar_global_app`), with **no experimental gate above it**
 * — unlike mail, the calendar is shipped and its store reads one local file, so
 * there is nothing to withdraw and nothing to keep off the network.
 *
 * **The badge is derived, not acknowledged**, which is the one real difference
 * from the mail badge and is `eventsLeftToday`'s doc in one line: mail counts
 * arrivals and clears when you open it, because a delivery has then been seen;
 * an appointment does not stop being at 3 p.m. because you looked at it. So this
 * number is recomputed — from the store on every edit, and from the clock every
 * minute — and reaches zero on its own at the end of the day.
 *
 * **Hovering the button reads out today and tomorrow**, the hover shape its
 * header siblings already have (`MailIndicator`, `LocalModelMenu`,
 * `VpnIndicator`): the badge can only ever say *how many* are left, and "2" is
 * precisely the number that sends someone opening the whole calendar to find out
 * whether one of them is in five minutes. Tomorrow is there because by late
 * afternoon that is the question — and as its own **section below** today, never
 * merged into one list, where a 09:00 under a 16:00 reads as an ordering bug.
 * Affordable on hover for `MailIndicator`'s reason — the store is already in
 * memory and one local file behind it, so a pointer crossing the header touches
 * no network and starts no work. A past occurrence is **dimmed for an hour and
 * then dropped** (`occurrenceStale`): dimming is the agenda rail's rule and the
 * hour is what it is worth here — the meeting you have just come out of is still
 * part of the answer, this morning's four are not, and by the evening they were
 * pushing what is still coming off the bottom of a list whose whole job is to
 * show it.
 */
export function CalendarIndicator() {
  const t = useT();
  const use24h = useUse24h();
  const enabled = useSettingsStore((s) => s.settings?.calendar_global_app ?? true);
  const events = useCalendarStore((s) => s.events);
  const calendars = useCalendarStore((s) => s.calendars);
  const overlayOpen = useCalendarStore((s) => s.overlayOpen);
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
  // The clock half of the count. Nothing in the store changes when 15:00 simply
  // passes, so the counter exists only to force the re-render that recomputes it
  // — hence the value is never read, only bumped.
  const [tick, setTick] = useState(0);

  // The calendar is one local file, so unlike mail there is no "don't reach out
  // on mount" rule to respect — the badge needs the events before the overlay is
  // ever opened, and `load` is idempotent.
  useEffect(() => {
    if (!enabled) return;
    void useCalendarStore.getState().load();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // Escape, for the menu that was opened by keyboard focus and therefore has no
  // mouse-leave coming to close it. Capture + `stopPropagation` because the
  // calendar overlay's own Escape handler is window-level as well, and while this
  // list is up, closing it is what the key meant.
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

  // The setting switched off with the menu open would otherwise leave it painted
  // over a button that is gone.
  useEffect(() => {
    if (!enabled) setMenuOpen(false);
  }, [enabled, setMenuOpen]);

  // One `now` for the badge and the list, re-taken on the same tick: two `new
  // Date()`s a few lines apart can straddle a minute, and this is exactly the
  // pairing where that shows — a count of 2 over a list with three undimmed rows.
  const now = useMemo(() => new Date(), [tick]);
  // Two days, because the question the badge cannot answer is rarely only about
  // today: at 17:00 "what is left" is nearly empty and "what is first tomorrow"
  // is the thing worth knowing. Tomorrow is a *section below* today, never mixed
  // into one list — a row reading 09:00 under a row reading 16:00 would be read
  // as an ordering bug, not as the next day.
  // Today's finished occurrences are dropped an hour after they end
  // (`occurrenceStale`) — long enough that the meeting you have just come out of
  // is still on the list, short enough that the evening's list is not mostly
  // this morning. Only day 0 can hold one: a row belonging to a day that has not
  // started is never past, and `occurrenceStale` compares against *now* whatever
  // day it is handed. The filter is here rather than inside `dayAgenda` because
  // the expansion is shared with the badge and the board's agenda rail, and this
  // is a rule about *this* list.
  // A calendar whose alerts are off (`Calendar.alerts_off`) is left off this
  // list too, not merely marked: the header is an alert surface, and a muted
  // calendar's events still filling it would not be off. The calendar itself
  // still shows them.
  const days = useMemo(() => {
    if (!enabled) return [];
    const muted = mutedCalendarIds(calendars);
    return dayAgenda(events, calendars, now, 2).map((day, i) => ({
      ...day,
      occurrences: day.occurrences.filter(
        (occ) => !muted.has(occ.calendarId) && !(i === 0 && occurrenceStale(occ, now)),
      ),
    }));
  }, [enabled, events, calendars, now]);

  if (!enabled) return null;

  const count = eventsLeftToday(events, calendars, now);
  const label = count > 0 ? t("calendar.indicatorLeft", { count }) : t("calendar.indicator");

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    setMenuOpen(true);
  };
  const scheduleClose = (e?: { clientY: number }) => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), headerMenuCloseDelay(e));
  };

  return (
    /* Same wrapper the brain and mail buttons use: `.header-center` stretches
       its children to the full header height, so a bare 32px button would sit at
       the top of the frame instead of centered. The hover handlers are the
       WRAPPER's, not the button's — the list is a child of this element, so
       `mouseleave` holds off while the pointer is anywhere inside it, which is
       what makes a menu hanging below the button walkable into at all. */
    <div
      className="global-apps-menu calendar-indicator no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn calendar-indicator-btn"
        title={label}
        aria-label={label}
        aria-pressed={overlayOpen}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          // The button keeps its one job — open (or close) the calendar. The
          // list goes with the click rather than staying up over the overlay it
          // just raised.
          setMenuOpen(false);
          window.clearTimeout(closeTimer.current);
          const store = useCalendarStore.getState();
          if (store.overlayOpen) store.closeOverlay();
          else store.openOverlay();
        }}
        // Keyboard reach: tabbing to the button is the one way in that no
        // pointer will ever open, and Escape is its way back out.
        onFocus={reveal}
      >
        <CalendarGlyph className="calendar-indicator-icon" />
        {count > 0 && (
          <span className="calendar-indicator-badge" aria-hidden="true">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {menuOpen && (
        <div
          className="tab-new-menu calendar-indicator-menu"
          role="menu"
          aria-label={t("calendar.menuAgenda")}
        >
          {/* Pinned title + scrolling region: the unified menu shape (the accent
              rail and the wash live on this element, so it must not be the thing
              that scrolls). */}
          <div className="tab-new-menu-group-label">
            {t("calendar.menuAgenda")}
          </div>
          <div className="menu-scroll-region">
            {days.map((day, i) => (
              <div key={day.date} className="cal-menu-day" role="none">
                {/* A day label inside the scroll region rather than pinned — the
                    menu's own rule: only the *first* group label is the header,
                    a section's own scrolls with its section. Tomorrow is always
                    labelled and always rendered, even when empty: "nothing
                    tomorrow" is an answer, and a section that disappears when it
                    is empty reads as a list that failed to load. */}
                <div className="tab-new-menu-group-label">
                  {t(i === 0 ? "calendar.today" : "calendar.tomorrow")}
                </div>
                {day.occurrences.length === 0 ? (
                  <div className="tab-new-menu-hint">{t("calendar.nothingScheduled")}</div>
                ) : (
                  day.occurrences.map((occ) => {
                    const call = conferenceLink(occ);
                    return (
                      /* The row and its Join are SIBLINGS, not nested: a button
                         inside a button is invalid markup, and the two do
                         genuinely different things — one opens the calendar, the
                         other leaves the app entirely. */
                      <div
                        key={`${occ.eventId}-${occ.occurrenceStart}`}
                        className="cal-menu-entry"
                        role="none"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className={
                            "tab-new-menu-item cal-menu-row" +
                            // Only today's can be over — dimming a row for a day
                            // that has not started would be nonsense, and
                            // `occurrenceEnded` compares against *now* whatever
                            // day it is handed.
                            (i === 0 && occurrenceEnded(occ, now) ? " past" : "")
                          }
                          title={occ.location || undefined}
                          onClick={() => {
                            setMenuOpen(false);
                            useCalendarStore.getState().openOverlay();
                          }}
                        >
                          {/* The calendar's own colour, so a row is recognisable
                              as the same event the grid paints — the one thing a
                              flat list of titles cannot say. */}
                          <span
                            className="cal-menu-dot"
                            aria-hidden="true"
                            style={{ background: calendarColor(calendars, occ.calendarId) }}
                          />
                          <span className="cal-menu-time">
                            {occ.allDay ? t("calendar.allDay") : formatTime(timePart(occ.start), use24h)}
                          </span>
                          <span className="cal-menu-title">
                            {occ.title || t("calendar.untitled")}
                          </span>
                        </button>
                        {/* Direct connection: this is the whole reason to read
                            the day from the header rather than opening the
                            calendar — two minutes before the hour, the thing you
                            want is the door, not the grid. It **names the
                            service** in its tooltip rather than saying "join",
                            because the link may have been derived from the
                            event's location or notes (`lib/calendar/conference.ts`), and
                            where a click is about to send you is exactly the
                            fact a one-word button hides. */}
                        {call && (
                          <button
                            type="button"
                            role="menuitem"
                            className="cal-menu-join"
                            title={t("calendar.joinTitle", { provider: call.provider })}
                            aria-label={t("calendar.joinTitle", { provider: call.provider })}
                            onClick={() => {
                              setMenuOpen(false);
                              joinConference(call.url);
                            }}
                          >
                            <VideoIcon />
                            <span className="cal-menu-join-text">{t("calendar.join")}</span>
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
