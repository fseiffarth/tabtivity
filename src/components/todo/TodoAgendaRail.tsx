import { useEffect, useMemo, useState } from "react";

import type { CalendarTask, Occurrence } from "../../types";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import { formatTime, timePart } from "../../lib/calendar/calendarTime";
import {
  agendaWindow,
  occurrenceCardOf,
  occurrencePast,
  taskFromOccurrence,
} from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { CheckboxIcon } from "../common/icons/Icon";

/** The clock half of the rail. Nothing in the store changes when 15:00 passes. */
const TICK_MS = 60_000;

interface Props {
  /** The board's cards — read only to tell which appointments already have one. */
  tasks: CalendarTask[];
  defaultCalendarId: string;
  /** The board's first column: where every conversion lands. */
  intakeColumnId: string;
}

/**
 * Today's and tomorrow's appointments.
 *
 * **Past occurrences are dimmed, not hidden.** Hiding them would make this rail
 * disagree with the header's calendar badge, which counts what has not yet
 * *ended* — and "what did I already do today" is half of what a morning glance
 * at a board is for.
 *
 * Every row also **makes a card**, the mail rail's `＋` and deliberately the same
 * one: the shape of the card is `lib/todoBoard`'s `taskFromOccurrence`, twin of
 * the mail rail's `taskFromMail`, so a board never grows two kinds of converted
 * card. It lands in the **first column** — an appointment you want to prepare for
 * is intake, not a decision about when the preparation happens.
 *
 * Where the two rails differ is what happens to the row afterwards, and the
 * asymmetry is deliberate. A converted mail *leaves* the mail rail (that list is
 * things demanding an answer, so the row disappearing is the feedback). An
 * appointment stays: this rail is *the day*, and a 10:00 meeting that vanished
 * because it has a card would put the rail at odds with the calendar and with the
 * header badge. The row keeps its slot and stops offering a second card.
 */
export function TodoAgendaRail({ tasks, defaultCalendarId, intakeColumnId }: Props) {
  const t = useT();
  const use24h = useUse24h();
  const events = useCalendarStore((s) => s.events);
  const calendars = useCalendarStore((s) => s.calendars);
  const calendarApp = useSettingsStore((s) => s.settings?.calendar_global_app ?? true);
  const overlayOpen = useTodoStore((s) => s.overlayOpen);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!overlayOpen) return;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [overlayOpen]);

  const now = useMemo(() => new Date(), [tick]);
  const window_ = useMemo(
    () => agendaWindow(events, calendars, now),
    [events, calendars, now],
  );

  const makeCard = async (occ: Occurrence) => {
    await useCalendarStore
      .getState()
      .createTask(
        taskFromOccurrence(
          occ,
          {
            calendarId: defaultCalendarId,
            columnId: intakeColumnId,
            now: new Date(),
          },
          t("calendar.untitled"),
        ),
      )
      .catch((err) => useTodoStore.getState().setError(String(err)));
  };

  const row = (occ: Occurrence) => {
    const carded = occurrenceCardOf(occ, tasks);
    return (
      <li
        key={`${occ.eventId}-${occ.occurrenceStart}`}
        className={"todo-agenda-row" + (occurrencePast(occ, now) ? " todo-agenda-past" : "")}
      >
        <span className="todo-agenda-time">
          {occ.allDay ? t("todoAgenda.allDay") : formatTime(timePart(occ.start), use24h)}
        </span>
        <span className="todo-agenda-title">{occ.title || t("calendar.untitled")}</span>
        {carded ? (
          // Not a button: the card exists, and the honest thing to show is that
          // it does. Opening it from here would need the board's focus request,
          // which the rail has no business raising over its own overlay.
          <span className="todo-agenda-carded" title={t("todoAgenda.alreadyCard")} aria-hidden>
            <CheckboxIcon />
          </span>
        ) : (
          <button
            type="button"
            className="cal-link-btn todo-agenda-make"
            onClick={() => void makeCard(occ)}
            title={t("todoAgenda.makeTodo")}
            aria-label={t("todoAgenda.makeTodoAria", { title: occ.title || t("calendar.untitled") })}
          >
            ＋
          </button>
        )}
      </li>
    );
  };

  const section = (label: string, occurrences: Occurrence[]) => (
    <>
      <h4 className="todo-agenda-day">{label}</h4>
      {occurrences.length === 0 ? (
        <p className="todo-rail-muted">{t("calendar.nothingScheduled")}</p>
      ) : (
        <ul className="todo-rail-list">{occurrences.map(row)}</ul>
      )}
    </>
  );

  return (
    <section className="todo-rail">
      <h3 className="todo-rail-title">{t("todoAgenda.title")}</h3>
      {section(t("todoAgenda.today"), window_.today)}
      {section(t("todoAgenda.tomorrow"), window_.tomorrow)}

      {/* Only when the calendar overlay can actually open — `CalendarOverlayHost`
          computes `live = enabled && open`, so without the setting this button
          would be one that visibly does nothing. */}
      {calendarApp && (
        <button
          type="button"
          className="cal-link-btn todo-agenda-open"
          onClick={() => {
            useTodoStore.getState().closeOverlay();
            useCalendarStore.getState().openOverlay();
          }}
        >
          {t("todoAgenda.openCalendar")}
        </button>
      )}
    </section>
  );
}
