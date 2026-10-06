import { useMemo } from "react";
import type { Calendar, Occurrence } from "../../types";
import {
  addDays,
  datePart,
  formatTime,
  spanCoversDate,
  todayStr,
  weekdayLabel,
} from "../../lib/calendar/calendarTime";
import { eventColor } from "../../lib/calendar/calendarCategories";
import { calendarColor } from "../../stores/calendar/calendar";
import { useI18nStore, useT } from "../../lib/i18n";
import type { CalendarMenuTarget } from "./CalendarContextMenu";
import { useArrivedMarks } from "../../stores/calendar/arrivals";

/** Rows of chips a cell shows before collapsing the rest into "+N more". */
const MAX_ROWS = 4;

interface Props {
  /** The weeks to draw, as rows of 7 dates (`monthGrid`). */
  weeks: string[][];
  /** The month the grid is "about" (1-12); days outside it are dimmed. Null in
   *  the multiweek view, where no month is privileged. */
  month: number | null;
  occurrences: Occurrence[];
  calendars: Calendar[];
  use24h: boolean;
  selected: string;
  onSelect: (date: string) => void;
  /** Double-click a day → create an all-day event on it. */
  onCreateOn: (date: string) => void;
  onOpen: (occurrence: Occurrence) => void;
  /** Right-click, on a day cell or on a bar. A bar reports the day under the
   *  cursor, not the event's first day: a week-long bar is right-clicked
   *  somewhere, and that somewhere is where a paste belongs. */
  onMenu: (target: CalendarMenuTarget) => void;
  weekStart: 0 | 1;
}

/**
 * One laid-out chip in a week row. A multi-day event occupies a single bar
 * spanning its columns, rather than one chip per day — which is what makes a
 * conference read as one block instead of five unrelated entries.
 */
interface Bar {
  occ: Occurrence;
  /** Column index within the week row, 0-6. */
  col: number;
  /** How many columns it spans in THIS row. */
  span: number;
  /** Row (lane) within the cell stack. */
  lane: number;
  /** True when the event began before this week row (draw a left "continues" edge). */
  clippedStart: boolean;
  /** True when it continues past this row. */
  clippedEnd: boolean;
}

/**
 * Pack a week's occurrences into lanes.
 *
 * Multi-day and all-day events are laid out first, as bars, because they must
 * keep a stable lane across the days they cover — otherwise the bar would jog up
 * and down mid-span. Single-day timed events then fill the lanes left free on
 * their own day.
 */
function layoutWeek(week: string[], occurrences: Occurrence[]): Bar[] {
  const bars: Bar[] = [];
  // lanes[lane][col] — is that cell of the lane already taken?
  const lanes: boolean[][] = [];

  const takeLane = (col: number, span: number): number => {
    for (let lane = 0; ; lane++) {
      if (!lanes[lane]) lanes[lane] = new Array(7).fill(false);
      let free = true;
      for (let c = col; c < col + span; c++) {
        if (lanes[lane][c]) {
          free = false;
          break;
        }
      }
      if (free) {
        for (let c = col; c < col + span; c++) lanes[lane][c] = true;
        return lane;
      }
    }
  };

  const spanning = occurrences.filter(
    (o) => o.allDay || datePart(o.start) !== datePart(o.end),
  );
  const single = occurrences.filter(
    (o) => !o.allDay && datePart(o.start) === datePart(o.end),
  );

  // Longest-first, so the big bars claim the top lanes and read as the backdrop.
  const ordered = [...spanning].sort((a, b) => {
    const len = (o: Occurrence) => week.filter((d) => covers(o, d)).length;
    const d = len(b) - len(a);
    return d !== 0 ? d : a.start.localeCompare(b.start);
  });

  for (const occ of ordered) {
    const cols = week.map((d, i) => (covers(occ, d) ? i : -1)).filter((i) => i >= 0);
    if (cols.length === 0) continue;
    const col = cols[0];
    const span = cols[cols.length - 1] - col + 1;
    bars.push({
      occ,
      col,
      span,
      lane: takeLane(col, span),
      // It began before this row / runs past it → draw a "continues" edge.
      clippedStart: covers(occ, addDays(week[0], -1)),
      clippedEnd: covers(occ, addDays(week[6], 1)),
    });
  }

  for (const occ of single) {
    const col = week.findIndex((d) => covers(occ, d));
    if (col < 0) continue;
    bars.push({
      occ,
      col,
      span: 1,
      lane: takeLane(col, 1),
      clippedStart: false,
      clippedEnd: false,
    });
  }

  return bars;
}

function covers(occ: Occurrence, date: string): boolean {
  return spanCoversDate({ start: occ.start, end: occ.end, allDay: occ.allDay }, date);
}

/**
 * The month grid — and, with a different week count, the multiweek view.
 *
 * Days outside `month` are dimmed but still live: clicking one selects it and
 * double-clicking creates there, so the leading/trailing week is not dead space.
 */
export function MonthView({
  weeks,
  month,
  occurrences,
  calendars,
  use24h,
  selected,
  onSelect,
  onCreateOn,
  onOpen,
  onMenu,
  weekStart,
}: Props) {
  const t = useT();
  const arrived = useArrivedMarks();
  const lang = useI18nStore((s) => s.lang);
  const today = todayStr();

  const labels = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => weekdayLabel(lang, i, "short"));
    return [...days.slice(weekStart), ...days.slice(0, weekStart)];
  }, [weekStart, lang]);

  const laidOut = useMemo(
    () => weeks.map((week) => layoutWeek(week, occurrences)),
    [weeks, occurrences],
  );

  return (
    <div className="cal-month">
      <div className="cal-month-weekdays">
        {labels.map((w) => (
          <div key={w} className="cal-month-weekday">{w}</div>
        ))}
      </div>

      <div className="cal-month-weeks">
        {weeks.map((week, wi) => {
          const bars = laidOut[wi];
          const overflow = new Map<number, number>(); // col → hidden count
          for (const bar of bars) {
            if (bar.lane >= MAX_ROWS) {
              for (let c = bar.col; c < bar.col + bar.span; c++) {
                overflow.set(c, (overflow.get(c) ?? 0) + 1);
              }
            }
          }

          return (
            <div key={wi} className="cal-month-week">
              {/* The day cells: background, number, click targets. */}
              {week.map((date, ci) => {
                const inMonth = month === null || Number(date.slice(5, 7)) === month;
                const classes = ["cal-month-day"];
                if (!inMonth) classes.push("cal-month-day-out");
                if (date === today) classes.push("cal-month-day-today");
                if (date === selected) classes.push("cal-month-day-selected");
                return (
                  <div
                    key={date}
                    className={classes.join(" ")}
                    style={{ left: `${(ci / 7) * 100}%`, width: `${100 / 7}%` }}
                    onClick={() => onSelect(date)}
                    onDoubleClick={() => onCreateOn(date)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onMenu({ x: e.clientX, y: e.clientY, occ: null, slot: { date } });
                    }}
                  >
                    <span className="cal-month-daynum">{Number(date.slice(8, 10))}</span>
                    {overflow.has(ci) ? (
                      <span
                        className="cal-month-more"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(date);
                        }}
                      >
                        {t("monthView.moreCount", { n: overflow.get(ci) ?? 0 })}
                      </span>
                    ) : null}
                  </div>
                );
              })}

              {/* The event bars, above the cells so a span can cross day borders. */}
              {bars
                .filter((b) => b.lane < MAX_ROWS)
                .map((bar) => {
                  const { occ } = bar;
                  const color = eventColor(
                    occ.category,
                    calendarColor(calendars, occ.calendarId),
                  );
                  const spanning = occ.allDay || bar.span > 1;
                  return (
                    <div
                      key={`${occ.eventId}:${occ.occurrenceStart}:${bar.col}`}
                      className={
                        "cal-month-bar" +
                        (spanning ? " cal-month-bar-solid" : "") +
                        (bar.clippedStart ? " cal-month-bar-clip-start" : "") +
                        (bar.clippedEnd ? " cal-month-bar-clip-end" : "") +
                        (occ.status === "cancelled" ? " cal-block-cancelled" : "") +
                        (arrived[occ.eventId] ? " arrived" : "")
                      }
                      style={{
                        left: `calc(${(bar.col / 7) * 100}% + 3px)`,
                        width: `calc(${(bar.span / 7) * 100}% - 6px)`,
                        top: `calc(var(--cal-daynum-h) + ${bar.lane} * var(--cal-bar-h))`,
                        color,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(datePart(occ.start));
                        onOpen(occ);
                      }}
                      // Keep a habitual double-click off the cell underneath,
                      // which would open a *new* event on this day.
                      onDoubleClick={(e) => e.stopPropagation()}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        // Bars float above the cells, so the day has to come
                        // from the cursor's column in the week row.
                        const row = (e.currentTarget as HTMLElement).parentElement;
                        const rect = row?.getBoundingClientRect();
                        const ci = rect
                          ? Math.min(6, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * 7)))
                          : bar.col;
                        onMenu({
                          x: e.clientX,
                          y: e.clientY,
                          occ,
                          slot: { date: week[ci] ?? week[bar.col] },
                        });
                      }}
                      title={`${occ.title}${occ.location ? ` — ${occ.location}` : ""}`}
                    >
                      {!spanning ? <span className="cal-month-bar-dot">●</span> : null}
                      {!occ.allDay ? (
                        <span className="cal-month-bar-time">
                          {formatTime(occ.start.split("T")[1] ?? "", use24h)}
                        </span>
                      ) : null}
                      <span className="cal-month-bar-title">{occ.title || t("calendar.untitled")}</span>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
