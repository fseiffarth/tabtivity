import { useEffect, useMemo, useRef, useState } from "react";
import type { Calendar, Occurrence } from "../../types";
import {
  MINUTES_PER_DAY,
  addMinutes,
  datePart,
  daySlice,
  formatTime,
  layoutOverlaps,
  minutesBetween,
  minutesIntoDay,
  todayStr,
  toStamp,
} from "../../lib/calendar/calendarTime";
import { eventColor } from "../../lib/calendar/calendarCategories";
import { calendarColor } from "../../stores/calendar/calendar";
import { useT } from "../../lib/i18n";
import type { CalendarMenuTarget } from "./CalendarContextMenu";
import { useArrivedMarks } from "../../stores/calendar/arrivals";

/** Pixel height of one hour row. The whole grid's geometry derives from this. */
const HOUR_PX = 44;
/** Everything drag-related snaps to this many minutes. */
const SNAP_MIN = 15;
/** Below this many minutes a block is too short to show its time legibly. */
const COMPACT_MIN = 45;
/** A press on a block that travels less than this many pixels is a click (open
 *  the event), not a move-drag. */
const CLICK_SLOP_PX = 4;

export interface TimeGridPrefs {
  use24h: boolean;
  /** Hour the grid scrolls to on open. */
  dayStartHour: number;
}

interface Props {
  /** The day columns to draw — 1 for the day view, 7 for the week view. */
  dates: string[];
  occurrences: Occurrence[];
  calendars: Calendar[];
  prefs: TimeGridPrefs;
  onOpen: (occurrence: Occurrence) => void;
  /** Drag on empty space finished — create an event over this range. */
  onCreate: (start: string, end: string) => void;
  /** A block was dragged to a new start (its duration is preserved). */
  onMove: (occurrence: Occurrence, newStart: string) => void;
  /** A block's bottom edge was dragged — same start, new end. */
  onResize: (occurrence: Occurrence, newEnd: string) => void;
  /** Right-click: on a block, on empty grid, or (on a block) both at once —
   *  the cursor is always at a minute of a day, so a paste has a target even
   *  where every pixel of the column is covered by an event. */
  onMenu: (target: CalendarMenuTarget) => void;
}

/** Snap a minute offset to the grid, clamped into the day. */
function snap(minutes: number): number {
  const s = Math.round(minutes / SNAP_MIN) * SNAP_MIN;
  return Math.max(0, Math.min(MINUTES_PER_DAY, s));
}

/** A live drag. `create` draws a ghost; `move`/`resize` preview on the block. */
type Drag =
  | { kind: "create"; date: string; fromMin: number; toMin: number }
  | {
      kind: "move";
      occ: Occurrence;
      date: string;
      startMin: number;
      durationMin: number;
      /** Minutes between the block's top and where it was grabbed, so a block
       *  picked up by its middle moves with the pointer instead of snapping its
       *  START to it (which shifted the event by half its length). */
      grabOffsetMin: number;
      /** Where the press landed, to tell a click from a drag on release. */
      originX: number;
      originY: number;
    }
  | { kind: "resize"; occ: Occurrence; date: string; endMin: number };

/**
 * The hour-row grid behind the day and week views.
 *
 * One column per date; timed occurrences are positioned by their minute offsets
 * and overlapping ones are split into columns (`layoutOverlaps`). All-day
 * occurrences are not drawn here — they belong to the all-day bar the parent view
 * renders above the grid.
 *
 * Dragging is pointer-based, not HTML5 drag-and-drop: WebKitGTK does not deliver
 * a usable HTML5 drag here (the same reason the tab strip is pointer-based).
 * Pointer capture on the scroll container means a drag that leaves the column —
 * or the window — still resolves.
 */
export function TimeGrid({
  dates,
  occurrences,
  calendars,
  prefs,
  onOpen,
  onCreate,
  onMove,
  onResize,
  onMenu,
}: Props) {
  const t = useT();
  const arrived = useArrivedMarks();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [nowMin, setNowMin] = useState(() => minutesIntoDay(toStamp(new Date())));

  const today = todayStr();

  // Scroll the working day into view on open, so 09:00 is not below the fold.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = prefs.dayStartHour * HOUR_PX;
  }, [prefs.dayStartHour]);

  // Creep the now-line down. A minute's resolution is all the line shows.
  useEffect(() => {
    const id = setInterval(() => setNowMin(minutesIntoDay(toStamp(new Date()))), 60_000);
    return () => clearInterval(id);
  }, []);

  /** Pointer Y → minutes into the day, snapped. */
  function minutesAt(clientY: number): number {
    const body = bodyRef.current;
    if (!body) return 0;
    const rect = body.getBoundingClientRect();
    const ratio = (clientY - rect.top) / rect.height;
    return snap(ratio * MINUTES_PER_DAY);
  }

  /** Timed blocks per column, with their overlap placement resolved. */
  const columns = useMemo(() => {
    return dates.map((date) => {
      const items = occurrences
        .filter((o) => !o.allDay)
        .map((o) => {
          const slice = daySlice({ start: o.start, end: o.end, allDay: false }, date);
          return slice ? { occ: o, ...slice } : null;
        })
        .filter((x): x is { occ: Occurrence; startMin: number; endMin: number } => x !== null);

      const placements = layoutOverlaps(items);
      return items.map((item, i) => ({ ...item, place: placements[i] }));
    });
  }, [dates, occurrences]);

  // ── Drag lifecycle ────────────────────────────────────────────────────────

  function beginCreate(e: React.PointerEvent, date: string) {
    // Only a plain left-press on the empty column starts a create-drag.
    if (e.button !== 0) return;
    const at = minutesAt(e.clientY);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: "create", date, fromMin: at, toMin: at + SNAP_MIN });
  }

  function beginMove(e: React.PointerEvent, occ: Occurrence, date: string) {
    if (e.button !== 0) return;
    e.stopPropagation(); // don't also start a create-drag underneath
    const slice = daySlice({ start: occ.start, end: occ.end, allDay: false }, date);
    if (!slice) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({
      kind: "move",
      occ,
      date,
      startMin: slice.startMin,
      // The true duration, which may exceed the day slice for an overnight event.
      durationMin: Math.max(SNAP_MIN, minutesBetween(occ.start, occ.end)),
      grabOffsetMin: minutesAt(e.clientY) - slice.startMin,
      originX: e.clientX,
      originY: e.clientY,
    });
  }

  function beginResize(e: React.PointerEvent, occ: Occurrence, date: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const slice = daySlice({ start: occ.start, end: occ.end, allDay: false }, date);
    if (!slice) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: "resize", occ, date, endMin: slice.endMin });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const at = minutesAt(e.clientY);
    if (drag.kind === "create") {
      setDrag({ ...drag, toMin: at });
    } else if (drag.kind === "move") {
      // Both terms are already multiples of SNAP_MIN, so the difference is too.
      setDrag({ ...drag, startMin: Math.max(0, at - drag.grabOffsetMin) });
    } else {
      // Never let the bottom edge cross the top.
      const startMin =
        daySlice({ start: drag.occ.start, end: drag.occ.end, allDay: false }, drag.date)
          ?.startMin ?? 0;
      setDrag({ ...drag, endMin: Math.max(startMin + SNAP_MIN, at) });
    }
  }

  function onPointerUp(e: React.PointerEvent, cancelled = false) {
    if (!drag) return;
    const d = drag;
    setDrag(null);

    if (d.kind === "create") {
      const from = Math.min(d.fromMin, d.toMin);
      const to = Math.max(d.fromMin, d.toMin);
      // A click (no movement) means "new event here", given a default length.
      const end = to - from < SNAP_MIN ? from + 60 : to;
      onCreate(stampAt(d.date, from), stampAt(d.date, end));
      return;
    }

    if (d.kind === "move") {
      // A press that never travelled is a click: open the event.
      if (!cancelled && Math.hypot(e.clientX - d.originX, e.clientY - d.originY) < CLICK_SLOP_PX) {
        onOpen(d.occ);
        return;
      }
      const newStart = stampAt(d.date, d.startMin);
      if (newStart !== d.occ.start) onMove(d.occ, newStart);
      return;
    }

    const newEnd = stampAt(d.date, d.endMin);
    if (newEnd !== d.occ.end) onResize(d.occ, newEnd);
  }

  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <div className="cal-timegrid" ref={scrollRef}>
      <div className="cal-timegrid-inner" style={{ height: 24 * HOUR_PX }}>
        <div className="cal-timegrid-gutter">
          {hours.map((h) => (
            <div key={h} className="cal-timegrid-hour-label" style={{ height: HOUR_PX }}>
              {h === 0 ? "" : formatTime(`${String(h).padStart(2, "0")}:00`, prefs.use24h)}
            </div>
          ))}
        </div>

        <div
          className="cal-timegrid-body"
          ref={bodyRef}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => onPointerUp(e)}
          onPointerCancel={(e) => onPointerUp(e, true)}
        >
          {hours.map((h) => (
            <div key={h} className="cal-timegrid-line" style={{ top: h * HOUR_PX }} />
          ))}

          {dates.map((date, ci) => {
            const isToday = date === today;
            return (
              <div
                key={date}
                className={`cal-timegrid-col${isToday ? " cal-timegrid-col-today" : ""}`}
                style={{ left: `${(ci / dates.length) * 100}%`, width: `${100 / dates.length}%` }}
                onPointerDown={(e) => beginCreate(e, date)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onMenu({
                    x: e.clientX,
                    y: e.clientY,
                    occ: null,
                    slot: { date, start: stampAt(date, minutesAt(e.clientY)) },
                  });
                }}
              >
                {isToday ? (
                  <div
                    className="cal-now-line"
                    style={{ top: (nowMin / MINUTES_PER_DAY) * (24 * HOUR_PX) }}
                  />
                ) : null}

                {columns[ci].map(({ occ, startMin, endMin, place }) => {
                  const dragging =
                    drag && drag.kind !== "create" && drag.occ.eventId === occ.eventId &&
                    drag.occ.occurrenceStart === occ.occurrenceStart && drag.date === date;

                  let top = startMin;
                  let bottom = endMin;
                  if (dragging && drag.kind === "move") {
                    top = drag.startMin;
                    bottom = Math.min(MINUTES_PER_DAY, drag.startMin + drag.durationMin);
                  } else if (dragging && drag.kind === "resize") {
                    bottom = drag.endMin;
                  }

                  const height = Math.max(SNAP_MIN, bottom - top);
                  const color = eventColor(occ.category, calendarColor(calendars, occ.calendarId));
                  const compact = height < COMPACT_MIN;

                  return (
                    <div
                      key={`${occ.eventId}:${occ.occurrenceStart}`}
                      className={
                        "cal-block" +
                        (occ.status === "cancelled" ? " cal-block-cancelled" : "") +
                        (occ.status === "tentative" ? " cal-block-tentative" : "") +
                        (dragging ? " cal-block-dragging" : "") +
                        (compact ? " cal-block-compact" : "") +
                        (arrived[occ.eventId] ? " arrived" : "")
                      }
                      style={{
                        top: (top / MINUTES_PER_DAY) * (24 * HOUR_PX),
                        height: (height / MINUTES_PER_DAY) * (24 * HOUR_PX),
                        left: `calc(${place.left * 100}% + 2px)`,
                        width: `calc(${place.width * 100}% - 4px)`,
                        // The accent tints the border/background via currentColor.
                        color,
                      }}
                      onPointerDown={(e) => beginMove(e, occ, date)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        // Not the column's menu underneath: that one would
                        // offer Paste without naming the event clicked on.
                        e.stopPropagation();
                        onMenu({
                          x: e.clientX,
                          y: e.clientY,
                          occ,
                          slot: { date, start: stampAt(date, minutesAt(e.clientY)) },
                        });
                      }}
                      title={`${occ.title}${occ.location ? ` — ${occ.location}` : ""}`}
                    >
                      <div className="cal-block-title">{occ.title || t("calendar.untitled")}</div>
                      {!compact ? (
                        <div className="cal-block-time">
                          {formatTime(timeOf(occ.start), prefs.use24h)}
                          {occ.location ? ` · ${occ.location}` : ""}
                        </div>
                      ) : null}
                      <div
                        className="cal-block-resize"
                        onPointerDown={(e) => beginResize(e, occ, date)}
                      />
                    </div>
                  );
                })}

                {drag?.kind === "create" && drag.date === date ? (
                  <div
                    className="cal-block cal-block-ghost"
                    style={{
                      top: (Math.min(drag.fromMin, drag.toMin) / MINUTES_PER_DAY) * (24 * HOUR_PX),
                      height:
                        (Math.max(SNAP_MIN, Math.abs(drag.toMin - drag.fromMin)) / MINUTES_PER_DAY) *
                        (24 * HOUR_PX),
                      left: 2,
                      right: 2,
                    }}
                  >
                    <div className="cal-block-time">
                      {formatTime(hhmm(Math.min(drag.fromMin, drag.toMin)), prefs.use24h)}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Minutes into a day → `"HH:MM"`. */
function hhmm(min: number): string {
  const m = Math.max(0, Math.min(MINUTES_PER_DAY - 1, min));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * A date plus minutes into it → a stamp. Minute 1440 (a drag to the very bottom)
 * is midnight of the *next* day, which `addMinutes` rolls over correctly.
 */
function stampAt(date: string, minutes: number): string {
  return addMinutes(`${datePart(date)}T00:00`, minutes);
}

/** The clock part of a stamp. */
function timeOf(stamp: string): string {
  return stamp.split("T")[1] ?? "00:00";
}
