import { addDays, addMonths, formatTime, monthName, startOfWeek, toDateStr, weekdayLabel } from "../../calendar/calendarTime";
import {
  latestScheduleOccurrence,
  localOccurrenceKey,
  nextScheduleOccurrence,
} from "../agentSchedule";
import { queueOrderTimes, snapPromptTime, type PromptChartCard } from "./chart";

/**
 * The prompt chart's time axis: one proportional, horizontal scale that a Day,
 * a Week or a Month fits into edge to edge, the way a calendar's views do.
 *
 * Everything here is pure geometry and pure decision — pixels to instants,
 * instants to pixels, cards to lanes, a pointer to a drop zone, a zone to the
 * write it means — so the component that draws the chart owns only the DOM
 * and the tests need none of it. The one rule the whole file leans on: a card
 * that lands at or before the now line is a **send now**, never a schedule in
 * the past, because nothing can be scheduled for a minute that has gone — and
 * a selection is sent only from the now band itself, never by being dropped
 * somewhere left of it.
 */
export type TimelineView = "hour" | "day" | "week" | "month";

/** What a drop snaps to, per view: a finer grid is meaningless at a coarser
 *  scale, and 5 minutes is the finest any view offers. */
export const TIMELINE_SNAP_MIN: Record<TimelineView, number> = { hour: 5, day: 5, week: 15, month: 60 };
/** The Hour view's grid: one line per snap step, a label on each quarter. */
export const HOUR_TICK_MIN = 5;
/** A card's fixed width on the axis, in px; it marks an instant, not a span. */
export const TIMELINE_CARD_WIDTH = 168;
/** One lane's height (card plus gap), in px: a three-line message with its
 *  agent row, tags and fact line, so a full card never overlaps the lane below. */
export const TIMELINE_LANE_HEIGHT = 140;
/** Room past a session card's last tick, so that tick is not cut by the edge. */
export const SESSION_TICK_ROOM = 6;
/** Lanes the body always shows, so an empty window has somewhere to drop. */
export const TIMELINE_MIN_LANES = 2;

/** A stretch of the window drawn narrower than its time: the Day view's quiet
 *  night, folded into one block of `px` pixels while nothing lies in it. The
 *  rest of the window shares the remaining width in proportion. */
export interface TimelineFold {
  start: Date;
  end: Date;
  px: number;
}

/** The width of the folded night, in px. */
export const TIMELINE_FOLD_PX = 40;
/** The folded stretch ends at this wall-clock hour (it starts at midnight). */
export const TIMELINE_FOLD_END_HOUR = 6;

export interface TimelineWindow {
  view: TimelineView;
  /** `YYYY-MM-DD`; the day, or any day of the week or month shown. The Hour
   *  view's is `YYYY-MM-DDTHH`: it names the hour too. */
  anchor: string;
  /** Inclusive, local midnight. */
  start: Date;
  /** Exclusive. */
  end: Date;
  snapMinutes: number;
  /** Set by the chart when the night is folded (`dayFold`): `timelineX` and
   *  `timelineTimeAt` are then piecewise, and everything that draws or
   *  hit-tests the axis reads the same two functions. */
  fold?: TimelineFold;
}

function localMidnight(stamp: string): Date {
  const [y, m, d] = stamp.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** The Hour view's anchor for the hour `at` falls in. */
export function hourAnchor(at: Date): string {
  return `${toDateStr(at)}T${String(at.getHours()).padStart(2, "0")}`;
}

/** The hour an anchor names; a date-only anchor (every other view's) names
 *  none, and reads as `fallback`. */
export function anchorHour(anchor: string, fallback = 0): number {
  const hour = /T(\d{2})/.exec(anchor)?.[1];
  return hour === undefined ? fallback : Math.min(23, Number(hour));
}

export function timelineWindow(view: TimelineView, anchor: string, weekStart: 0 | 1): TimelineWindow {
  const day = anchor.slice(0, 10);
  if (view === "hour") {
    const start = localMidnight(day);
    start.setHours(anchorHour(anchor));
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours() + 1);
    return { view, anchor: hourAnchor(start), start, end, snapMinutes: TIMELINE_SNAP_MIN.hour };
  }
  let first = day;
  let after: string;
  if (view === "day") {
    after = addDays(day, 1);
  } else if (view === "week") {
    first = startOfWeek(day, weekStart);
    after = addDays(first, 7);
  } else {
    first = `${day.slice(0, 7)}-01`;
    after = addMonths(first, 1);
  }
  return {
    view,
    anchor: day,
    start: localMidnight(first),
    end: localMidnight(after),
    snapMinutes: TIMELINE_SNAP_MIN[view],
  };
}

/** Ctrl + wheel: one step finer (a month to its week, a week to its day, a
 *  day to an hour) or coarser; `null` at either end, so a spin past Hour or
 *  Month is a no-op. */
export function zoomTimelineView(view: TimelineView, direction: "in" | "out"): TimelineView | null {
  const order: TimelineView[] = ["month", "week", "day", "hour"];
  const next = order[order.indexOf(view) + (direction === "in" ? 1 : -1)];
  return next ?? null;
}

/** Wheel notches per zoom step: a mouse notch is ~100 px (or one line), a
 *  trackpad streams small deltas that add up to one. */
export const TIMELINE_ZOOM_NOTCH = 50;

/**
 * An instant as the chart writes it everywhere — a card's fact line, a
 * session row, the drop badge — in the app's language and its 12/24-hour
 * clock, never the browser locale's `toLocaleString()` (which showed
 * "9/14/2026, 10:02:52 PM" beside a 24-hour axis). `withDate` prefixes the
 * short weekday and date; a day view's cards leave it off.
 */
export function formatTimelineInstant(at: Date, lang: string, use24h: boolean, withDate = true): string {
  if (!Number.isFinite(at.getTime())) return "";
  const time = formatTime(`${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`, use24h);
  if (!withDate) return time;
  return `${weekdayLabel(lang, at.getDay(), "short")} ${at.getDate()} ${monthName(lang, at.getMonth() + 1).slice(0, 3)} · ${time}`;
}

/**
 * ◀ ▶: an hour, a day, a week, or a calendar month (the day of month is clamped).
 * An hour steps real time, not the wall clock: on a spring-forward day the
 * hour before 03:00 is 01:00, and `new Date(y, m, d, 2)` normalises back to
 * 03:00, which kept ◀ where it was. On a fall-back day the repeated hour has
 * one anchor, so a step that lands on the same anchor steps once more.
 */
export function shiftAnchor(view: TimelineView, anchor: string, step: -1 | 1): string {
  const day = anchor.slice(0, 10);
  if (view === "hour") {
    const start = timelineWindow("hour", anchor, 1).start.getTime();
    const from = hourAnchor(new Date(start));
    const next = hourAnchor(new Date(start + step * 3_600_000));
    return next !== from ? next : hourAnchor(new Date(start + 2 * step * 3_600_000));
  }
  if (view === "day") return addDays(day, step);
  if (view === "week") return addDays(day, 7 * step);
  return addMonths(day, step);
}

/** The fold's geometry: px per ms outside it, and the pieces' bounds in ms. */
function foldScale(win: TimelineWindow, width: number) {
  const fold = win.fold!;
  const start = win.start.getTime();
  const foldStart = fold.start.getTime();
  const foldEnd = fold.end.getTime();
  const rest = win.end.getTime() - start - (foldEnd - foldStart);
  return { start, foldStart, foldEnd, px: fold.px, k: rest > 0 ? Math.max(0, width - fold.px) / rest : 0 };
}

export function timelineX(at: Date, win: TimelineWindow, width: number): number {
  if (win.fold) {
    const { start, foldStart, foldEnd, px, k } = foldScale(win, width);
    const t = at.getTime();
    const before = (foldStart - start) * k;
    if (t <= foldStart) return (t - start) * k;
    if (t < foldEnd) return before + ((t - foldStart) / (foldEnd - foldStart)) * px;
    return before + px + (t - foldEnd) * k;
  }
  const span = win.end.getTime() - win.start.getTime();
  return ((at.getTime() - win.start.getTime()) / span) * width;
}

export function timelineTimeAt(x: number, win: TimelineWindow, width: number): Date {
  const clamped = Math.max(0, Math.min(width, x));
  if (win.fold) {
    const { start, foldStart, foldEnd, px, k } = foldScale(win, width);
    const before = (foldStart - start) * k;
    if (k === 0) return new Date(start);
    if (clamped <= before) return new Date(start + clamped / k);
    if (clamped < before + px) return new Date(foldStart + ((clamped - before) / px) * (foldEnd - foldStart));
    return new Date(Math.min(win.end.getTime(), foldEnd + (clamped - before - px) / k));
  }
  const ratio = Math.max(0, Math.min(1, x / Math.max(1, width)));
  return new Date(win.start.getTime() + ratio * (win.end.getTime() - win.start.getTime()));
}

/**
 * The Day view's quiet night: the leading 00:00–06:00 stretch folded to one
 * narrow block, but only while nothing lies in it — no item (or its end), no
 * queued card, no reset mark, and not `now`. `instants` is everything the
 * caller draws on the axis; Hour, Week and Month never fold. Returns the fold
 * for the chart to put on the window, or undefined.
 */
export function dayFold(win: TimelineWindow, instants: readonly Date[]): TimelineFold | undefined {
  if (win.view !== "day") return undefined;
  const start = win.start;
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), TIMELINE_FOLD_END_HOUR);
  const inside = instants.some((at) => Number.isFinite(at.getTime()) && at.getTime() >= start.getTime() && at.getTime() < end.getTime());
  return inside ? undefined : { start, end, px: TIMELINE_FOLD_PX };
}

export function snapTimelineTime(at: Date, win: TimelineWindow): Date {
  return snapPromptTime(at, win.snapMinutes);
}

export interface TimelineTick {
  x: number;
  at: Date;
  major: boolean;
  label: "hour" | "day";
  /** Whether the axis writes this tick's time: every 5-minute tick of an
   *  hour, every hour of a day wide enough to hold them, the majors elsewhere. */
  labelled: boolean;
}

/** The narrowest hour a Day view still labels every hour at, in px. */
export const DAY_HOUR_LABEL_MIN_PX = 36;

/**
 * Axis marks: 5-minute steps across an hour (every quarter major), hours
 * across a day (every sixth major), days across a week with quarter-day
 * minors, days across a month (Mondays major). A day's hours step real time
 * from its midnight, so a spring-forward day has 23 ticks and a fall-back day
 * 25, and no two share an instant (the wall-clock `new Date(y, m, d, 2)` of a
 * spring-forward day IS 03:00, which drew one hour twice under one key).
 */
export function timelineTicks(win: TimelineWindow, width: number): TimelineTick[] {
  const ticks: TimelineTick[] = [];
  if (win.view === "hour") {
    for (let minute = 0; minute < 60; minute += HOUR_TICK_MIN) {
      const at = new Date(win.start.getTime() + minute * 60_000);
      ticks.push({ x: timelineX(at, win, width), at, major: minute % 15 === 0, label: "hour", labelled: true });
    }
    return ticks;
  }
  if (win.view === "day") {
    // A folded night has no hour ticks: its block is one mark, the first hour
    // after it is the first tick.
    const hours = win.fold ? 24 - (win.fold.end.getTime() - win.fold.start.getTime()) / 3_600_000 : 24;
    const everyHour = (win.fold ? Math.max(0, width - win.fold.px) : width) / hours >= DAY_HOUR_LABEL_MIN_PX;
    for (let t = win.start.getTime(); t < win.end.getTime(); t += 3_600_000) {
      const at = new Date(t);
      if (win.fold && t >= win.fold.start.getTime() && t < win.fold.end.getTime()) continue;
      const major = at.getHours() % 6 === 0;
      ticks.push({ x: timelineX(at, win, width), at, major, label: "hour", labelled: everyHour || major });
    }
    return ticks;
  }
  for (let day = new Date(win.start); day < win.end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const major = win.view === "week" || day.getDay() === 1;
    ticks.push({ x: timelineX(day, win, width), at: day, major, label: "day", labelled: major });
    if (win.view === "week") {
      for (const hour of [6, 12, 18]) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
        ticks.push({ x: timelineX(at, win, width), at, major: false, label: "hour", labelled: false });
      }
    }
  }
  return ticks;
}

export interface TimelineItem {
  /** Unique on the axis: the card's key, plus the occurrence for a recurring rule. */
  key: string;
  card: PromptChartCard;
  at: Date;
  /** Set on every expanded occurrence of a recurring rule but its first. */
  occurrence?: string;
  /** A session's sent prompts drawn as one card (`sessionItems`), oldest
   *  first. `at` is then the first of them and `card` the newest. */
  members?: TimelineItem[];
}

/** What a session card is handed to draw: its prompts oldest first, and each
 *  one's distance in px from the card's left edge, where its tick goes. */
export interface SessionSpan {
  cards: PromptChartCard[];
  offsets: number[];
}

const MAX_OCCURRENCES = 64;

/**
 * Every card with a place on the axis inside the window: sent cards at their
 * `sent_at`, one-time rules at their minute, recurring rules at each future
 * occurrence in the window (their past ones are the history's rows already).
 * Queued cards sit at the now line, and drafts and chained cards on the board
 * — none of those has an instant of its own. A chained card in particular is
 * never drawn at its source's minute: it goes when the source's turn has
 * finished, whenever that is, and a place on the axis would read as a time.
 */
export function timelineItems(cards: PromptChartCard[], win: TimelineWindow, now: Date): TimelineItem[] {
  const items: TimelineItem[] = [];
  const inside = (at: Date | null): at is Date =>
    !!at && Number.isFinite(at.getTime()) && at >= win.start && at < win.end;
  for (const card of cards) {
    if (card.state === "sent") {
      if (inside(card.at)) items.push({ key: card.key, card, at: card.at });
      continue;
    }
    if (card.state !== "scheduled" || !card.schedule) continue;
    if (!card.recurring) {
      if (inside(card.at)) items.push({ key: card.key, card, at: card.at });
      continue;
    }
    let from = new Date(Math.max(win.start.getTime(), now.getTime()));
    let first = true;
    for (let n = 0; n < MAX_OCCURRENCES; n += 1) {
      const occurrence = nextScheduleOccurrence(card.schedule, from);
      if (!occurrence || occurrence.at >= win.end) break;
      items.push({
        key: first ? card.key : `${card.key}@${occurrence.key}`,
        card,
        at: occurrence.at,
        occurrence: first ? undefined : occurrence.key,
      });
      first = false;
      from = new Date(occurrence.at.getTime() + 60_000);
    }
  }
  return items.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Which session a sent card belongs to: its session id, or its strand (the
 *  tab) for a row written before the tab had one. Only sent cards group. */
export function sessionGroupKey(card: PromptChartCard): string | null {
  if (card.state !== "sent") return null;
  return card.history?.session_id ? `session:${card.history.session_id}` : `session:${card.strandId}`;
}

/**
 * One card per session instead of one per prompt: the sent items of a session
 * become one item that starts at its first prompt and carries the rest as
 * `members`. A session with a single prompt in the window stays a plain card,
 * and scheduled and queued cards are never folded in — they are the ones a
 * user still drags. Day and week views only; a month's lamps stay per prompt.
 */
export function sessionItems(items: TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  const groups = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const key = sessionGroupKey(item.card);
    if (!key) {
      out.push(item);
      continue;
    }
    const rows = groups.get(key);
    if (rows) rows.push(item);
    else groups.set(key, [item]);
  }
  for (const [key, rows] of groups) {
    if (rows.length === 1) {
      out.push(rows[0]);
      continue;
    }
    const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
    out.push({ key, card: sorted[sorted.length - 1].card, at: sorted[0].at, members: sorted });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Queued cards in the order the scheduler will take them. */
export function queuedStack(cards: PromptChartCard[], now: Date): PromptChartCard[] {
  const due = (card: PromptChartCard) =>
    (card.schedule && latestScheduleOccurrence(card.schedule, now)?.at.getTime())
    ?? card.at?.getTime()
    ?? Number.MAX_SAFE_INTEGER;
  return cards.filter((card) => card.state === "queued").sort((a, b) => due(a) - due(b) || a.id.localeCompare(b.id));
}

/**
 * The writes ↑ or ↓ on a queued card means: its own tab's queue in the order
 * the queue column shows it (`queuedStack`, by due minute — never the rules'
 * stored order, which the first reorder has already made different), with the
 * card swapped one place and the whole queue rewritten as consecutive minutes
 * (`queueOrderTimes`). Each write names a schedule id and its new minute;
 * `[]` when the card is already at that end, is not queued, or has no tab.
 */
export function queueReorderWrites(
  cards: PromptChartCard[],
  card: PromptChartCard,
  step: -1 | 1,
  now: Date,
): { id: string; at: string }[] {
  if (!card.targetId) return [];
  const queue = queuedStack(cards, now).filter((item) => item.targetId === card.targetId && item.schedule);
  const from = queue.findIndex((item) => item.key === card.key);
  const to = from + step;
  if (from < 0 || to < 0 || to >= queue.length) return [];
  const ordered = [...queue];
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  const ids = ordered.map((item) => item.schedule!.id);
  const times = queueOrderTimes(ids, now);
  return ids.map((id) => ({ id, at: times[id] }));
}

/** When a sent card's turn was over: the moment the schedule host saw the tab
 *  idle again (`apply_blame` stamps `files_at`, in a repository or not). A row
 *  never blamed (typed in the terminal and adopted) has none. */
export function promptEndedAt(card: PromptChartCard): Date | null {
  const raw = card.state === "sent" ? card.history?.files_at : undefined;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isFinite(at.getTime()) && (!card.at || at.getTime() >= card.at.getTime()) ? at : null;
}

/** The instant an item's newest part is over: a session's last prompt, a
 *  sent card's end, a rule's minute. */
function itemEnd(item: TimelineItem, running: ReadonlySet<string>, now: Date): Date {
  const last = item.members?.[item.members.length - 1] ?? item;
  // A turn still going has no end: it reaches the now line and grows with it.
  if (running.has(last.card.id)) return now;
  return promptEndedAt(last.card) ?? last.at;
}

/** The narrowest duration bar a card wears, in px: it also marks the corner a
 *  card is anchored at when nothing says how long the turn took. */
export const TIMELINE_BAR_MIN = 4;

export interface LaneItem extends TimelineItem {
  /** The card's left edge. */
  x: number;
  lane: number;
  /** The card's width: the fixed one, or a session's span when that is wider. */
  width: number;
  /** The corner the card is pinned to: a past card ends at its right edge and
   *  hangs left, a future one starts at its left edge and hangs right. */
  anchor: "left" | "right";
  /** The duration bar on the anchored corner of the card's top edge, in px. */
  barWidth: number;
}

/**
 * Greedy interval packing, newest first: from the latest card back (a session
 * card counts from its newest prompt's end), each takes the lowest lane where
 * its interval is clear of the cards already there (less a gap) — so the
 * newest prompt is always on the top lane and older overlapping ones step
 * down beneath it. Items come back in time order.
 *
 * Nothing crosses the now line. An item whose newest instant is at or before
 * `now` is past: its right edge sits at the x of its end (the newest member's
 * `files_at`, else its `at`) and it hangs left, clamped to `x >= 0`. A future
 * item starts at its left edge and hangs right, clamped so the card stays
 * inside the body; neither is drawn over the folded night. A session card is
 * as wide as its first-to-last span (and never narrower than a card), so its
 * last tick sits on its last prompt's minute; the bar on its top edge runs from
 * the first prompt to the last end.
 */
export function packLanes(
  items: TimelineItem[],
  win: TimelineWindow,
  width: number,
  now: Date,
  cardWidth = TIMELINE_CARD_WIDTH,
  gap = 6,
  /** Ids of the sent cards whose turn is running right now. */
  running: ReadonlySet<string> = new Set(),
): { lanes: number; items: LaneItem[] } {
  const lanes: [number, number][][] = [];
  const nowX = timelineX(now, win, width);
  // The folded night is the first `fold.px` of the body (`timelineX`): a card
  // that hangs left of its end would be drawn over that block, so it stops at
  // the block's edge instead. Nothing lies in the night while it is folded
  // (`dayFold`), so no card starts there.
  const floor = win.fold ? win.fold.px : 0;
  const placed = [...items]
    .sort((a, b) => itemEnd(b, running, now).getTime() - itemEnd(a, running, now).getTime())
    .map((item): LaneItem => {
      const end = itemEnd(item, running, now);
      const startX = timelineX(item.at, win, width);
      const endX = timelineX(end, win, width);
      const last = item.members?.[item.members.length - 1];
      const span = last ? endX - startX + SESSION_TICK_ROOM : 0;
      const itemWidth = Math.max(cardWidth, span);
      const past = end.getTime() <= now.getTime();
      const x = past
        ? Math.max(floor, Math.min(endX, nowX) - itemWidth)
        : Math.max(floor, Math.min(startX, width - itemWidth));
      const barWidth = past ? Math.min(itemWidth, Math.max(TIMELINE_BAR_MIN, endX - startX)) : TIMELINE_BAR_MIN;
      let lane = lanes.findIndex((spans) => spans.every(([left, right]) => x + itemWidth + gap <= left || right + gap <= x));
      if (lane < 0) {
        lane = lanes.length;
        lanes.push([]);
      }
      lanes[lane].push([x, x + itemWidth]);
      return { ...item, x, lane, width: itemWidth, anchor: past ? "right" : "left", barWidth };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  return { lanes: lanes.length, items: placed };
}

export interface DayCluster {
  date: string;
  x: number;
  width: number;
  items: TimelineItem[];
}

/** One cluster per calendar day of the window, empty days included. */
export function dayClusters(items: TimelineItem[], win: TimelineWindow, width: number): DayCluster[] {
  const clusters: DayCluster[] = [];
  const days = Math.round((win.end.getTime() - win.start.getTime()) / 86_400_000);
  for (let index = 0; index < days; index += 1) {
    const day = new Date(win.start.getFullYear(), win.start.getMonth(), win.start.getDate() + index);
    const date = toDateStr(day);
    clusters.push({
      date,
      x: (index / days) * width,
      width: width / days,
      items: items.filter((item) => toDateStr(item.at) === date),
    });
  }
  return clusters;
}

/** `now` is the now band itself; `past` is the body at or before the now line
 *  outside that band — a send for one card, but never for a selection. */
export type TimelineZone =
  | { kind: "none" }
  | { kind: "strip" }
  | { kind: "now" }
  | { kind: "past" }
  | { kind: "time"; at: Date };

export interface TimelineRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TimelineRects {
  strip: TimelineRect | null;
  /** The scrolling body; a point inside it maps to a time by content x. */
  body: TimelineRect | null;
  nowBand: TimelineRect | null;
}

function contains(rect: TimelineRect | null, point: { x: number; y: number }): rect is TimelineRect {
  return !!rect
    && point.x >= rect.left && point.x <= rect.left + rect.width
    && point.y >= rect.top && point.y <= rect.top + rect.height;
}

/**
 * Where a pointer is, in the chart's terms. The now band is `now`; the rest of
 * the body at or left of the now line is `past` — a send for one card, which
 * `timelineGroupDrop` refuses for a selection — and the future maps to a
 * snapped minute.
 */
export function timelineHitZone(
  point: { x: number; y: number },
  rects: TimelineRects,
  win: TimelineWindow,
  width: number,
  scrollLeft: number,
  now: Date,
): TimelineZone {
  if (contains(rects.strip, point)) return { kind: "strip" };
  if (contains(rects.nowBand, point)) return { kind: "now" };
  if (!contains(rects.body, point)) return { kind: "none" };
  const at = snapTimelineTime(timelineTimeAt(point.x - rects.body.left + scrollLeft, win, width), win);
  return at.getTime() <= now.getTime() ? { kind: "past" } : { kind: "time", at };
}

/** Why a drop writes nothing, when there is a reason worth saying: `occupied`,
 *  the only tab it could reach already holds a rule; `no-target`, there is no
 *  agent tab at all; `past`, a selection would be sent or land at or before now. */
export type PromptTimelineDropRefusal = "occupied" | "no-target" | "past";

export type PromptTimelineDrop =
  | { type: "send"; targetId: string }
  | { type: "schedule"; targetId: string; at: string }
  | { type: "retime"; targetId: string; fromTargetId?: string; at: string }
  | { type: "unschedule"; fromTargetId?: string }
  | { type: "none"; reason?: PromptTimelineDropRefusal };

/**
 * A drop is a write, decided here and nowhere else. `targets` are the live
 * agent tabs' schedule target ids, first one the default: a card aimed at a
 * tab that is gone falls back to it, and with no tab at all nothing moves
 * (`no-target`). The band and the past body are both a send for one card.
 */
export function timelineDropAction(
  card: PromptChartCard,
  zone: TimelineZone,
  targets: readonly string[],
  occupied: ReadonlySet<string> = new Set(),
): PromptTimelineDrop {
  // A sent card is history: it stays where it went. "Collect again" is a
  // button on its face, never a drop.
  if (zone.kind === "none" || card.recurring || card.state === "sent") return { type: "none" };
  if (zone.kind === "strip") {
    if (card.schedule) return { type: "unschedule", fromTargetId: card.targetId };
    return { type: "none" };
  }
  // A rule keeps its own tab; a draft goes to the tab it is aimed at, else
  // the first tab — but never onto a tab already holding another rule
  // (`occupiedTargets`): there the draft has to be linked after that rule.
  const free = card.schedule ? targets : targets.filter((id) => !occupied.has(id));
  if (card.targetId && targets.includes(card.targetId) && !free.includes(card.targetId)) return { type: "none", reason: "occupied" };
  const targetId = card.targetId && free.includes(card.targetId) ? card.targetId : free[0];
  if (!targetId) return { type: "none", reason: targets.length > 0 ? "occupied" : "no-target" };
  if (zone.kind === "now" || zone.kind === "past") {
    return card.state === "queued" ? { type: "none" } : { type: "send", targetId };
  }
  const at = localOccurrenceKey(zone.at);
  return card.schedule
    ? { type: "retime", targetId, fromTargetId: card.targetId, at }
    : { type: "schedule", targetId, at };
}

/** A card a selection carries along on a drop: a one-time rule with a minute
 *  of its own. Recurring rules, queued, chained and sent cards stay put. */
export function timelineGroupMovable(card: PromptChartCard): boolean {
  return card.state === "scheduled" && !!card.schedule && !card.recurring && !!card.at;
}

/**
 * The writes one drop means for a whole selection, decided before any of
 * them runs so a selection moves whole or not at all. A time drop moves every
 * member by the distance the carried card moved, each snapped to the view's
 * grid, so their spacing survives; if any member would land at or before the
 * now line the whole drop is refused (every entry `none`, reason `past`)
 * rather than sending part of the selection by accident. The past body is
 * refused the same way — only the now band sends a selection — and so is a
 * drop where a member whose tab is gone would fall back onto another tab that
 * already holds a rule (`occupied`): moving the members before it and then
 * failing on it would leave half the selection moved. The now band and the
 * strip otherwise mean the same for each member as for one card, and members
 * that drop means nothing for are simply left out.
 */
export function timelineGroupDrop(
  carried: PromptChartCard,
  members: PromptChartCard[],
  zone: TimelineZone,
  targets: readonly string[],
  win: TimelineWindow,
  now: Date,
  occupied: ReadonlySet<string> = new Set(),
): { card: PromptChartCard; drop: PromptTimelineDrop }[] {
  const refuse = (reason?: PromptTimelineDropRefusal) =>
    members.map((card) => ({ card, drop: { type: "none" as const, ...(reason ? { reason } : {}) } }));
  if (zone.kind === "past") return refuse("past");
  let moves: { card: PromptChartCard; drop: PromptTimelineDrop }[];
  if (zone.kind === "time") {
    const delta = carried.at ? zone.at.getTime() - carried.at.getTime() : 0;
    const landings = members.map((card) =>
      card === carried || !card.at ? zone.at : snapTimelineTime(new Date(card.at.getTime() + delta), win));
    if (landings.some((at) => at.getTime() <= now.getTime())) return refuse("past");
    moves = members.map((card, index) => ({
      card,
      drop: timelineDropAction(card, { kind: "time", at: landings[index] }, targets, occupied),
    }));
  } else {
    moves = members.map((card) => ({ card, drop: timelineDropAction(card, zone, targets, occupied) }));
  }
  const fallsOntoOccupied = moves.some(({ card, drop }) =>
    "targetId" in drop && drop.targetId !== card.targetId && occupied.has(drop.targetId));
  if (fallsOntoOccupied) return refuse("occupied");
  if (zone.kind !== "time") return moves.filter((entry) => entry.drop.type !== "none");
  const refused = moves.find((entry) => entry.drop.type === "none");
  return refused?.drop.type === "none" ? refuse(refused.drop.reason) : moves;
}

const TARGET_COLORS = [
  "var(--accent)",
  "var(--status-working)",
  "var(--status-decision)",
  "var(--success)",
  "var(--warning)",
];

/** The stripe colour of the n-th agent tab; a closed session is grey. */
export function promptTargetColor(index: number): string {
  return index < 0 ? "var(--text-muted)" : TARGET_COLORS[index % TARGET_COLORS.length];
}
