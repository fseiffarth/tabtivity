/**
 * The todo board's pure logic — bucketing, ordering, filtering, drag geometry,
 * the header badge and the two rails' data selection.
 *
 * Everything here is a pure function over already-loaded state, for the reason
 * the calendar's own math lives in `lib/calendar/{calendarTime,recurrence}.ts`: it is the
 * half worth unit-testing, and a board that computes nothing in its components
 * can be re-rendered as often as a drag needs without a second thought.
 *
 * Two rules run through the whole file and are worth reading once:
 *
 * **Completion wins over placement.** A card's column is Tabtivity's own field; its
 * `percent`/`completed` are the ICS-round-trippable truth that the calendar's
 * Tasks view and `serializeIcs` both read. So wherever the two could disagree —
 * a task ticked in the Tasks view, which knows nothing about columns — the
 * completion is believed and the card is *shown* in the done column. The backend
 * writes that reconciliation to disk on the next save (`CalendarData::normalize`);
 * this is what makes the board show the truth in the meantime.
 *
 * **Nothing here migrates anything.** No render path writes `column` or `rank`
 * onto a task: a card that has never been placed is simply *shown* in the intake
 * column, and acquires a real placement the first time it is moved. Writing
 * placement at read time would rewrite `calendar.json` once per launch, for
 * someone who may only ever use the calendar.
 *
 * The second rule is what makes the third one possible. **Three columns are
 * decided by the deadline, not by the user**: Overdue, Today and the intake
 * column route between themselves from `due` at render time (`dateColumn`), so a
 * backlog card due today shows up in Today and a card whose date passed
 * overnight is in Overdue the next morning — with nothing written, and nothing
 * to undo when the deadline moves again. Every other column is a decision
 * someone made by dragging, and no date overrules one.
 */

import type {
  Calendar,
  CalendarEvent,
  CalendarTask,
  Occurrence,
  Subtask,
  TaskColumn,
} from "../types";
import type { MailHeader } from "../types/mail";
import {
  MINUTES_PER_DAY,
  addDays,
  datePart,
  daysBetween,
  minutesBetween,
  timePart,
  todayStr,
  toStamp,
} from "./calendar/calendarTime";
import { dayAgenda, visibleCalendarIds } from "../stores/calendar/calendar";
import type { TranslationKey } from "./i18n";
import { dropSlot } from "./listReorder";
import type { ProjectRemark } from "./projects/projectRemarks";

/** Gap between adjacent ranks. Mirrors the backend's `RANK_GAP`. */
export const RANK_STEP = 1024;

/**
 * The board the frontend draws when `calendar.json` carries no `task_columns`.
 *
 * The backend deliberately does not seed columns on read — that would grow board
 * state in the file of someone who only uses the calendar — so until the first
 * drag or column edit there is nothing on disk to render from. These ids match
 * the backend's `TaskColumn::default_set`, so the moment it *does* seed, every
 * card stays exactly where it was being shown.
 */
export const DEFAULT_COLUMNS: TaskColumn[] = [
  {
    id: "overdue",
    name: "Overdue",
    position: 0,
    done: false,
    overdue: true,
    color: "#d9534f",
  },
  {
    id: "today",
    name: "Today",
    position: 1,
    done: false,
    due_today: true,
    color: "#4aa3df",
  },
  { id: "doing", name: "Doing", position: 2, done: false, color: "#e8a33d" },
  {
    id: "backlog",
    name: "Backlog",
    position: 3,
    done: false,
    intake: true,
    color: "#8a93a5",
  },
  { id: "done", name: "Done", position: 4, done: true, color: "#5cb85c" },
  {
    id: "archived",
    name: "Archived",
    position: 5,
    done: false,
    archived: true,
    color: "#7d8590",
  },
];

/** Translation keys for the seeded columns, so a default board is localized. */
const DEFAULT_COLUMN_LABELS: Record<string, TranslationKey> = {
  overdue: "todoBoard.columnOverdue",
  backlog: "todoBoard.columnBacklog",
  today: "todoBoard.columnToday",
  doing: "todoBoard.columnDoing",
  done: "todoBoard.columnDone",
  archived: "todoBoard.columnArchived",
};

/** The columns to render: the store's, or the defaults while it has none. */
export function boardColumns(stored: TaskColumn[] | undefined | null): TaskColumn[] {
  const columns = stored && stored.length > 0 ? stored : DEFAULT_COLUMNS;
  return [...columns].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
}

/**
 * A column's label. A seeded column is translated from its id; a user-named one
 * is shown verbatim — a name someone typed is not ours to reinterpret, and a
 * rename must survive a language switch.
 */
export function columnTitle(
  column: TaskColumn,
  t: (key: TranslationKey) => string,
  stored: TaskColumn[] | undefined | null,
): string {
  const untouched = !stored || stored.length === 0;
  const key = DEFAULT_COLUMN_LABELS[column.id];
  const isSeededName =
    DEFAULT_COLUMNS.find((c) => c.id === column.id)?.name === column.name;
  return key && (untouched || isSeededName) ? t(key) : column.name;
}

/** The done column's id, or null when the board has none (coupling off). */
export function doneColumnId(columns: TaskColumn[]): string | null {
  return columns.find((c) => c.done)?.id ?? null;
}

/** The ids of the archive columns — resting places exempt from the completion
 *  coupling. Usually one (the seeded "archived"), but a user may add more. */
export function archivedColumnIds(columns: TaskColumn[]): Set<string> {
  return new Set(columns.filter((c) => c.archived).map((c) => c.id));
}

/** The overdue column's id, or null when the board has none. */
export function overdueColumnId(columns: TaskColumn[]): string | null {
  return columns.find((c) => c.overdue)?.id ?? null;
}

/** The today column's id, or null when the board has none. */
export function todayColumnId(columns: TaskColumn[]): string | null {
  return columns.find((c) => c.due_today)?.id ?? null;
}

/**
 * The column an unplaced card is shown in, and the one every conversion files
 * into: the column flagged `intake`, and failing that the leftmost that is
 * neither Done, nor an archive, nor date-governed. Mirrors the backend's
 * `col_fallback` exactly, including the order of its two rules.
 *
 * The flag is what carries this now. The old *leftmost open column* rule read
 * the intent off the layout, and the layout changed: with Overdue and Today
 * leading the board and Backlog behind Doing, "leftmost open" is **Doing**, and
 * every unplaced card would have been filed as work in progress. Neither date
 * column can be the fallback either — landing there is a statement about a
 * deadline, and a card with no home has made no such statement.
 */
export function fallbackColumnId(columns: TaskColumn[]): string {
  const dateGoverned = (c: TaskColumn) => !!c.overdue || !!c.due_today;
  return (
    columns.find((c) => c.intake) ??
    columns.find((c) => !c.done && !c.archived && !dateGoverned(c)) ??
    columns.find((c) => !c.done && !c.archived) ??
    columns[0]
  ).id;
}

// ── Bucketing and ordering ──────────────────────────────────────────────────

/**
 * Which column a card is *shown* in, applying the rules in order:
 * an archive it names wins first (a resting place outranks completion, so a
 * finished card can leave Done), then completion wins, then an absent/unknown
 * column falls to the intake column, then the column the card names — and
 * finally the deadline, for the three columns a deadline governs (`dateColumn`).
 */
export function columnOf(
  task: CalendarTask,
  columns: TaskColumn[],
  today: string = todayStr(),
): string {
  const named = task.column;
  // A card filed in an archive stays there whatever its percent — that is the
  // whole point of archiving a *done* card, and mirrors `normalize_tasks`.
  if (named && columns.some((c) => c.id === named && c.archived)) return named;
  const done = doneColumnId(columns);
  if (task.percent >= 100 && done) return done;
  let column: string;
  if (!named || !columns.some((c) => c.id === named)) {
    // A completed card with no done column has nowhere better to go than the
    // fallback — which is exactly what the backend does with the coupling off.
    column = fallbackColumnId(columns);
  } else if (done && named === done && task.percent < 100) {
    // A card that is *not* complete cannot sit in Done, however it was filed:
    // otherwise unticking it in the calendar's Tasks view would leave it under a
    // heading that says it is finished.
    column = fallbackColumnId(columns);
  } else {
    column = named;
  }
  return dateColumn(task, column, columns, today);
}

/**
 * The deadline's say in where a card is shown — the Overdue/Today/intake trio,
 * and nothing else.
 *
 * **Three columns, one rule.** Between the intake column, Today and Overdue, a
 * card's position is not an opinion anyone holds: it is what its `due` says
 * today. So a backlog card due today is *shown* in Today, one whose deadline has
 * passed is shown in Overdue, and a card sitting in Overdue that is no longer
 * late leaves it — a column named Overdue that holds something else is simply
 * lying. Doing, Done, an archive and every column the user added are untouched:
 * putting a card *there* is a decision, and a date does not get to overrule it.
 *
 * **Display only, and that is the whole design.** Nothing here writes `column`.
 * The backend's `normalize` runs on every read and therefore must not consult a
 * clock (`normalize_tasks` step 5 says why at length: the same file would
 * migrate differently depending on the hour, and every board would reshuffle
 * itself at midnight). Routing at *render* time has neither problem — the board
 * simply redraws — and it leaves the card's own filing intact, so a deadline that
 * moves, or passes, takes the card with it in both directions instead of
 * one-way-stamping a column onto the record.
 *
 * A card keeps its place when the board has no column to route it into, so a
 * user who deleted Overdue gets late cards left where they are rather than
 * vanished.
 */
function dateColumn(
  task: CalendarTask,
  column: string,
  columns: TaskColumn[],
  today: string,
): string {
  // A finished card is Done's business (or its archive's), never a deadline's.
  if (task.percent >= 100) return column;
  const fallback = fallbackColumnId(columns);
  const overdueCol = overdueColumnId(columns);
  const todayCol = todayColumnId(columns);
  const governed =
    column === fallback || column === overdueCol || column === todayCol;
  if (!governed) return column;
  // Day granularity deliberately: `isOverdue` given a bare date compares days,
  // so an hour deadline does not move a card into Overdue halfway through the
  // afternoon it is due. Columns are a day-sized readout; the "3d late" chip is
  // where the hour is allowed to matter.
  if (isOverdue(task, today)) return overdueCol ?? column;
  if (task.due && datePart(task.due) === today) return todayCol ?? column;
  // Not late and not due today: an undated or future card that someone dragged
  // into Today stays there — a deliberate "I am doing this today" is exactly the
  // decision this function does not overrule — but it cannot stay in Overdue.
  return column === overdueCol ? fallback : column;
}

/**
 * Whether dropping `task` into `columnId` would actually keep it there.
 *
 * Asked of the routing itself rather than re-deriving it, so the answer cannot
 * drift from what the board then draws. It is false only for the deadline-driven
 * cases — a card due today dropped into the backlog, a late one dropped into
 * Today, anything not late dropped into Overdue — where the write would land and
 * be undone by the next render, i.e. a drag that visibly snaps back. The board
 * refuses those drops instead, and says so on the drag ghost; the way to move a
 * card between those three columns is to change its deadline.
 */
export function dropAccepted(
  task: CalendarTask,
  columnId: string,
  columns: TaskColumn[],
  today: string = todayStr(),
): boolean {
  return columnOf({ ...task, column: columnId }, columns, today) === columnId;
}

/** Group cards by the column they are shown in, each column already ordered. */
export function bucketByColumn(
  tasks: CalendarTask[],
  columns: TaskColumn[],
  today: string = todayStr(),
): Map<string, CalendarTask[]> {
  const buckets = new Map<string, CalendarTask[]>();
  for (const column of columns) buckets.set(column.id, []);
  for (const task of tasks) {
    const id = columnOf(task, columns, today);
    (buckets.get(id) ?? buckets.set(id, []).get(id)!).push(task);
  }
  for (const [id, list] of buckets) buckets.set(id, orderedColumn(list, today));
  return buckets;
}

/**
 * One column's cards, top to bottom.
 *
 * Ranked cards first, ascending. Unranked ones — everything created by the
 * calendar's Tasks view or an ICS import, which never place anything — sort
 * after them by the Tasks view's own comparator (overdue, then due date with
 * undated last, then priority), so a task arriving from another surface lands
 * somewhere sensible without anyone having had to write a rank for it. `id`
 * breaks every remaining tie, so the order never depends on array position
 * (which changes whenever a card is deleted).
 */
export function orderedColumn(
  tasks: CalendarTask[],
  today: string = todayStr(),
): CalendarTask[] {
  return [...tasks].sort((a, b) => {
    const ar = a.rank ?? null;
    const br = b.rank ?? null;
    if (ar !== null && br !== null) return ar - br || a.id.localeCompare(b.id);
    if (ar !== null) return -1;
    if (br !== null) return 1;

    const ao = isOverdue(a, today) ? 0 : 1;
    const bo = isOverdue(b, today) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ad = a.due ? datePart(a.due) : "9999";
    const bd = b.due ? datePart(b.due) : "9999";
    if (ad !== bd) return ad.localeCompare(bd);
    const ap = a.priority || 10;
    const bp = b.priority || 10;
    return ap - bp || a.id.localeCompare(b.id);
  });
}

/**
 * A provisional rank for the optimistic overlay, so a dropped card lands in its
 * new slot in the same frame as the pointerup.
 *
 * **Display only.** The authoritative rank is the backend's — the frontend sends
 * an index and `todo_move_tasks` does the algebra, which is what keeps a replayed
 * placement a no-op and a collapsed column reindexed. This exists purely so the
 * board has a number to sort by for the ~1 frame before the write returns.
 */
export function provisionalRank(
  before: number | null,
  after: number | null,
): number {
  if (before === null && after === null) return RANK_STEP;
  if (after === null) return (before as number) + RANK_STEP;
  if (before === null) return after - RANK_STEP;
  return (before + after) / 2;
}

/** Apply the pending optimistic placements over the store's tasks. */
export function applyPending(
  tasks: CalendarTask[],
  pending: Record<string, { column: string; rank: number }>,
): CalendarTask[] {
  if (Object.keys(pending).length === 0) return tasks;
  return tasks.map((task) => {
    const staged = pending[task.id];
    return staged ? { ...task, column: staged.column, rank: staged.rank } : task;
  });
}

// ── Filtering ───────────────────────────────────────────────────────────────

export interface BoardFilter {
  search: string;
  /** A project id, `"none"` for cards with no project, or null for any. */
  project: string | null | "none";
  tag: string | null;
  hideDone: boolean;
  visibleCalendars: Set<string>;
  /** Ids of the archive columns, so "hide done" hides a card resting there too
   *  — a finished card whose `percent` is 100 is caught by that check anyway,
   *  but an *abandoned* archived card (percent < 100) needs this one. Optional
   *  so a caller with no board (and every existing test) can omit it. */
  archived?: Set<string>;
}

export function filterTasks(
  tasks: CalendarTask[],
  filter: BoardFilter,
): CalendarTask[] {
  const q = filter.search.trim().toLowerCase();
  return tasks.filter((task) => {
    if (!filter.visibleCalendars.has(task.calendar_id)) return false;
    if (filter.hideDone && task.percent >= 100) return false;
    if (filter.hideDone && task.column && filter.archived?.has(task.column)) {
      return false;
    }
    if (filter.project === "none" && task.project_id) return false;
    if (
      filter.project &&
      filter.project !== "none" &&
      task.project_id !== filter.project
    ) {
      return false;
    }
    if (filter.tag && !(task.tags ?? []).includes(filter.tag)) return false;
    if (q) {
      const hay = `${task.title} ${task.notes ?? ""} ${(task.tags ?? []).join(" ")}`;
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

/** Every tag in use, deduped and sorted — the filter menu's options. */
export function allTags(tasks: CalendarTask[]): string[] {
  const seen = new Set<string>();
  for (const task of tasks) for (const tag of task.tags ?? []) seen.add(tag);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// ── Card readouts ───────────────────────────────────────────────────────────

/**
 * iCalendar priority buckets. Deliberately the same thresholds as the calendar's
 * `TasksView` — that component is left untouched, so this is one copy of four
 * numbers rather than a shared import that would mean editing it; a test pins
 * the two together.
 */
export function priorityBucket(p: number): "high" | "normal" | "low" | "none" {
  if (!p) return "none";
  if (p <= 4) return "high";
  if (p === 5) return "normal";
  return "low";
}

/**
 * Overdue: the deadline is behind us, and the card is not complete.
 *
 * `now` may be a bare date (`"2026-07-31"`) or a full stamp
 * (`"2026-07-31T14:00"`), and which one is passed decides how much this can
 * know. A card carrying an **hour** deadline (`due` with a `T…`) is late the
 * minute that hour passes — but only a caller holding a clock can say so, so a
 * date-only `now` falls back to comparing days, which is the same answer the
 * day-granular version always gave. The two never disagree in the direction that
 * matters: a coarser clock is late in reporting, never early.
 */
export function isOverdue(task: CalendarTask, now: string = toStamp(new Date())): boolean {
  if (!task.due || task.percent >= 100) return false;
  const day = datePart(task.due);
  const today = datePart(now);
  if (day !== today) return day < today;
  // Same day: only an hour deadline read against a clock can be late.
  const deadline = timePart(task.due);
  const clock = timePart(now);
  // Strictly past, so the deadline's own minute still reads as due-now rather
  // than as missed — `severityFor`'s boundary, and the same one on both sides.
  return !!deadline && !!clock && deadline < clock;
}

export function subtaskProgress(
  task: CalendarTask,
): { done: number; total: number } | null {
  const subs = task.subtasks ?? [];
  if (subs.length === 0) return null;
  return { done: subs.filter((s) => s.done).length, total: subs.length };
}

// ── The checklist ───────────────────────────────────────────────────────────

/**
 * The checklist's four edits, as pure functions over a card.
 *
 * They live here rather than in either component because the checklist is now
 * edited from **two** surfaces — inline on the board card, and in the full card
 * dialog — and those two write the same field to the same file. One set of ops
 * is what keeps them from disagreeing about what an add or a delete does; the
 * difference between the surfaces is only what they do with the result (the card
 * saves it, the dialog stages it in its draft).
 *
 * None of them drives `percent`. That is `TodoCardDialog`'s documented rule and
 * it matters more from a card: 100% moves a card to Done, so a derived percent
 * would make ticking the last step silently relocate the card out from under
 * the pointer that ticked it.
 */

/**
 * An id no step of this task already carries.
 *
 * Deliberately not `${task.id}-${subtasks.length}`, which is the obvious
 * spelling and is wrong: delete the last step and add another and the new one is
 * handed the id the deleted one had — which for a React key is survivable, but
 * for `setSubtask`/`removeSubtask`, which address a step *by id*, means two rows
 * that tick and delete each other. The suffix is scanned rather than counted, so
 * the only guarantee needed is that it is free.
 */
export function mintSubtaskId(task: CalendarTask): string {
  const subs = task.subtasks ?? [];
  const taken = new Set(subs.map((s) => s.id));
  for (let n = subs.length; ; n++) {
    const id = `${task.id}-s${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Append a step. An empty (or blank) title is a no-op, never a nameless row. */
export function addSubtask(task: CalendarTask, title: string): CalendarTask {
  const value = title.trim();
  if (!value) return task;
  return {
    ...task,
    subtasks: [
      ...(task.subtasks ?? []),
      { id: mintSubtaskId(task), title: value, done: false },
    ],
  };
}

/** Edit one step, addressed by id. An unknown id changes nothing. */
export function setSubtask(
  task: CalendarTask,
  id: string,
  changes: Partial<Subtask>,
): CalendarTask {
  return {
    ...task,
    subtasks: (task.subtasks ?? []).map((s) => (s.id === id ? { ...s, ...changes } : s)),
  };
}

/** Tick or untick one step. */
export function toggleSubtask(task: CalendarTask, id: string): CalendarTask {
  const step = (task.subtasks ?? []).find((s) => s.id === id);
  return step ? setSubtask(task, id, { done: !step.done }) : task;
}

/** Drop one step. */
export function removeSubtask(task: CalendarTask, id: string): CalendarTask {
  return { ...task, subtasks: (task.subtasks ?? []).filter((s) => s.id !== id) };
}

/**
 * Move one step to `to` — **an index into the list without it**.
 *
 * That is the one thing worth stating, because it is the convention the drag's
 * drop-slot arithmetic already produces (`stepDropSlot` counts the *other* rows
 * the pointer has passed, exactly as `MachinesIndicator`'s row reorder does): a
 * step pulled out of the list and spliced back in cannot be addressed in the
 * coordinates of the list it is still in, and mixing the two is how a downward
 * drag lands one row short.
 *
 * The index is clamped rather than refused — a pointer that left the list at the
 * bottom means "last", not "nothing happened". An unknown id, and a move that
 * changes nothing, both return the task unchanged so a stray drop is not a write.
 */
export function moveSubtask(task: CalendarTask, id: string, to: number): CalendarTask {
  const subs = task.subtasks ?? [];
  const from = subs.findIndex((s) => s.id === id);
  if (from < 0) return task;
  const rest = subs.filter((_, i) => i !== from);
  const at = Math.max(0, Math.min(Math.trunc(to), rest.length));
  if (at === from) return task;
  rest.splice(at, 0, subs[from]);
  return { ...task, subtasks: rest };
}

/**
 * Where a dragged step would land — `lib/listReorder`'s `dropSlot` under the
 * name the checklist code and its tests know it by. Every list with the
 * gesture shares that arithmetic; the alias keeps the checklist's own vocabulary
 * without a second copy of it.
 */
export function stepDropSlot(
  rects: { id: string; top: number; height: number }[],
  id: string,
  clientY: number,
): number {
  return dropSlot(rects, id, clientY);
}

/**
 * Tick or untick a card: completion **and** placement in one edit.
 *
 * Both halves, because they are one fact seen from two surfaces — writing only
 * `percent` would leave the card under a heading that contradicts its checkbox
 * until the next reconcile. Mirrors `TasksView.toggleDone`, which sets the same
 * two completion fields for the same reason.
 */
export function toggleTaskDone(
  task: CalendarTask,
  columns: TaskColumn[],
  now: Date = new Date(),
): CalendarTask {
  const done = task.percent >= 100;
  // A card resting in an archive stays there when ticked or unticked — the
  // archive outranks the coupling, so relocating it would defeat archiving.
  const current = columnOf(task, columns);
  const inArchive = columns.some((c) => c.id === current && c.archived);
  const target = inArchive
    ? current
    : done
      ? fallbackColumnId(columns)
      : doneColumnId(columns);
  return {
    ...task,
    percent: done ? 0 : 100,
    completed: done ? null : toStamp(now),
    column: target ?? task.column,
    // Cleared so the backend files it at the end of its new column rather than
    // wherever its old neighbours happened to sit.
    rank: null,
  };
}

// ── The header badge ────────────────────────────────────────────────────────

/**
 * What the header button counts: cards that are **actionable today** — not done,
 * on a visible calendar, due today or overdue.
 *
 * Derived and recomputed, never acknowledged, for `eventsLeftToday`'s reason:
 * opening the board does not finish anything, so there is nothing a "seen" flag
 * could honestly mean. It falls to zero on its own as the day's cards are ticked
 * and rises again at midnight.
 *
 * **Undated cards are excluded on purpose.** An undated card is a someday, and
 * counting it would pin the badge at a number in the hundreds that never falls —
 * the one failure mode that teaches a user to ignore a badge.
 */
export function todosDueCount(
  tasks: CalendarTask[],
  calendars: Calendar[],
  now: Date = new Date(),
): number {
  const today = todayStr(now);
  const visible = visibleCalendarIds(calendars);
  return tasks.filter(
    (t) =>
      t.percent < 100 &&
      visible.has(t.calendar_id) &&
      !!t.due &&
      datePart(t.due) <= today,
  ).length;
}

/** Whether any counted card is actually *overdue* — emphasis, not a second number. */
export function todosOverdue(
  tasks: CalendarTask[],
  calendars: Calendar[],
  now: Date = new Date(),
): boolean {
  // The full stamp, not just the day: an hour deadline that passed at lunchtime
  // is overdue, and the badge's emphasis has to say so before midnight.
  const stamp = toStamp(now);
  const visible = visibleCalendarIds(calendars);
  return tasks.some((t) => visible.has(t.calendar_id) && isOverdue(t, stamp));
}

/**
 * The badge's **explanation**: the cards behind the number, in three sections.
 *
 * The badge can only ever say *how many* — and "4" is exactly the figure that
 * sends someone opening the whole board to find out whether one of them was due
 * last week. So the header's hover list reads them out, and it is computed here
 * rather than in the component for `eventsLeftToday`'s reason: the count and the
 * list are read against each other, and one of them being right is not enough.
 *
 * The same three filters as `todosDueCount` — open, on a visible calendar, dated
 * — so no row can appear that the badge did not count, plus tomorrow's, which
 * the badge deliberately does not count and which by late afternoon is the only
 * question left. Tomorrow is its own section for the calendar menu's reason: a
 * date that is not today, mixed into today's list, reads as an ordering bug.
 *
 * Overdue is split out rather than folded into today, because "due today" and
 * "was due and still isn't done" are two different demands, and the badge's
 * overdue emphasis has to be explainable by *something* on screen.
 */
export interface UrgentTodos {
  overdue: CalendarTask[];
  today: CalendarTask[];
  tomorrow: CalendarTask[];
}

/**
 * Soonest first, then priority, then title — `id` breaking the last tie.
 *
 * The whole stamp, not its date half: two cards due today at 09:00 and at 17:00
 * are not equally soon, and `"2026-07-31"` sorts before `"2026-07-31T09:00"`,
 * which puts the whole-day card ahead of both — the right answer, since a
 * deadline with no hour is owed from the start of the day.
 */
function byUrgency(a: CalendarTask, b: CalendarTask): number {
  const ad = a.due ?? "9999";
  const bd = b.due ?? "9999";
  if (ad !== bd) return ad.localeCompare(bd);
  // `|| 10` is `orderedColumn`'s rule: priority 0 means *unset*, which sorts
  // after an explicit low (9) rather than ahead of a high (1).
  const ap = a.priority || 10;
  const bp = b.priority || 10;
  return ap - bp || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export function urgentTodos(
  tasks: CalendarTask[],
  calendars: Calendar[],
  now: Date = new Date(),
): UrgentTodos {
  const stamp = toStamp(now);
  const today = todayStr(now);
  const tomorrow = addDays(today, 1);
  const visible = visibleCalendarIds(calendars);
  const open = tasks.filter(
    (t) => t.percent < 100 && visible.has(t.calendar_id) && !!t.due,
  );
  // Overdue is `isOverdue`'s call and not a second date comparison, which is
  // what keeps this list and the badge's overdue emphasis from disagreeing about
  // a card whose hour deadline passed earlier today — it is in Overdue here, so
  // "Due today" is what is *left* of today rather than all of it.
  const late = new Set(open.filter((t) => isOverdue(t, stamp)).map((t) => t.id));
  const on = (cmp: (date: string) => boolean) =>
    open.filter((t) => !late.has(t.id) && cmp(datePart(t.due!))).sort(byUrgency);
  return {
    overdue: open.filter((t) => late.has(t.id)).sort(byUrgency),
    today: on((d) => d === today),
    tomorrow: on((d) => d === tomorrow),
  };
}

/**
 * How many days late a card is — the "3d late" chip on an overdue row.
 *
 * Whole days between the two *dates*, so an hour deadline missed earlier the
 * same day is `0` and the caller renders no chip: "0 d late" is a worse thing to
 * print than nothing, and the row is already under an "Overdue" heading.
 */
export function daysLate(task: CalendarTask, now: Date = new Date()): number {
  if (!task.due) return 0;
  return Math.max(0, daysBetween(datePart(task.due), todayStr(now)));
}

/**
 * How far a card's deadline is from now, as a **unit and a count** — the thing
 * every "3 d late" / "in 2 h" chip is drawn from, in one place so the header
 * list and the board card cannot say different things about one card.
 *
 * What decides the unit is **what the deadline actually says**, and the two
 * kinds of `due` say different amounts:
 *
 * A **whole-day** deadline (`due` with no `T…`) is read in whole calendar days
 * at every distance, counted between the two *dates* and never as minutes ÷
 * 1440 — a card due Friday is "2d" from Wednesday whatever the hour, whereas
 * dividing the minutes mixes the time of day into a figure that names a day and
 * makes one deadline read as 2 in the evening and 3 in the small hours. It gets
 * no hours at all: "in 9h" for a card due "tomorrow" is a precision it does not
 * have, and 00:00 is not what its author meant.
 *
 * A **fixed-hour** deadline is a moment, so the whole distance to it is known
 * and it is given in full: days **and** hours together past a day (`2d 5h`),
 * hours inside a day, minutes inside an hour. Rolling that to a bare "2d" would
 * throw away the half of the answer that decides whether the card is this
 * afternoon's problem.
 *
 * `null` means there is nothing worth printing: no deadline, a whole-day one due
 * today (the row is already under a heading saying so), or an hour deadline that
 * is passing this very minute.
 */
export interface DueDelta {
  /** The deadline is behind us — `isOverdue`'s side, on the same boundary. */
  late: boolean;
  unit: "d" | "dh" | "h" | "min";
  /** Days for `d`/`dh`, hours for `h`, minutes for `min`. */
  count: number;
  /** The hours on top of the whole days — `dh` only. */
  hours?: number;
}

/**
 * The measurement itself, over a **distance** rather than a task — so a surface
 * that already knows how far off something is (the file viewer's Alerts strip,
 * whose rows are mail and appointments as well as cards) reads it in exactly the
 * units a board card does, instead of a second rounding that disagrees with it.
 *
 * Both arguments are **future-positive**, the sense `lib/alerts` measures in:
 * `minutesAway`/`daysAway` are negative once the moment is behind us.
 */
export function awayDelta(
  minutesAway: number,
  daysAway: number,
  allDay: boolean,
): DueDelta | null {
  if (allDay) {
    return daysAway === 0
      ? null
      : { late: daysAway < 0, unit: "d", count: Math.abs(daysAway) };
  }
  const abs = Math.abs(minutesAway);
  // Strictly past is late, so the deadline's own minute reads as due-now rather
  // than as missed — `isOverdue`'s boundary, and the same one on both sides.
  if (abs < 1) return null;
  const late = minutesAway < 0;
  if (abs < 60) return { late, unit: "min", count: Math.round(abs) };
  if (abs < MINUTES_PER_DAY) return { late, unit: "h", count: Math.round(abs / 60) };
  // Past a day, and the moment names an hour, so both halves are real: whole
  // days from the elapsed minutes (not the calendar dates — the two halves must
  // come from one measurement or "2d 23h" can land beside a 4-day gap), then the
  // remaining hours. Rounding those can reach 24, which is one more whole day.
  let wholeDays = Math.floor(abs / MINUTES_PER_DAY);
  let hours = Math.round((abs % MINUTES_PER_DAY) / 60);
  if (hours >= 24) {
    wholeDays += 1;
    hours = 0;
  }
  // "2d 0h" is a worse way to say "2d", so the hours are dropped when there are
  // none — which is also the whole-day deadline's shape, and prints alike.
  return hours === 0
    ? { late, unit: "d", count: wholeDays }
    : { late, unit: "dh", count: wholeDays, hours };
}

export function dueDelta(task: CalendarTask, now: Date = new Date()): DueDelta | null {
  if (!task.due) return null;
  const stamp = toStamp(now);
  if (!timePart(task.due)) {
    return awayDelta(0, daysBetween(datePart(stamp), datePart(task.due)), true);
  }
  return awayDelta(minutesBetween(stamp, task.due), 0, false);
}

/**
 * The phrase a `DueDelta` is printed as — the key, so the wording itself stays
 * in `i18n` and the *choice* of wording stays here, said once for every chip
 * that shows one (the header's hover list, the board card).
 */
export function dueDeltaKey(d: DueDelta): TranslationKey {
  if (d.late) {
    if (d.unit === "d") return "todo.menuLate";
    if (d.unit === "dh") return "todo.menuLateDaysHours";
    return d.unit === "h" ? "todo.menuLateHours" : "todo.menuLateMinutes";
  }
  if (d.unit === "d") return "todo.menuDueInDays";
  if (d.unit === "dh") return "todo.menuDueInDaysHours";
  return d.unit === "h" ? "todo.menuDueInHours" : "todo.menuDueInMinutes";
}

// ── The rails ───────────────────────────────────────────────────────────────

export interface AgendaWindow {
  todayDate: string;
  tomorrowDate: string;
  today: Occurrence[];
  tomorrow: Occurrence[];
}

/**
 * Today's and tomorrow's appointments — this rail's shape over `dayAgenda`,
 * which is where the expansion itself lives.
 *
 * It delegates rather than expanding its own two days because the header's 🗓
 * hover list shows the same two days and its badge counts the first of them: the
 * rail and the button are read against each other, so one implementation is what
 * keeps them from disagreeing about what today held (a multi-day event lands
 * under both days there, and past occurrences survive to be dimmed here).
 */
export function agendaWindow(
  events: CalendarEvent[],
  calendars: Calendar[],
  now: Date = new Date(),
): AgendaWindow {
  const [today, tomorrow] = dayAgenda(events, calendars, now, 2);
  return {
    todayDate: today.date,
    tomorrowDate: tomorrow.date,
    today: today.occurrences,
    tomorrow: tomorrow.occurrences,
  };
}

/** An occurrence that has already ended — dimmed in the rail, never hidden. */
export function occurrencePast(occ: Occurrence, now: Date = new Date()): boolean {
  if (occ.allDay) return false;
  return occ.end <= toStamp(now);
}

/**
 * Which urgent mail the rail shows: the Urgent page first (the backend already
 * sorted it newest-first, and re-sorting here would reorder a *page*), then
 * Important — minus anything already linked to a card that is still open.
 *
 * That subtraction is what makes "make todo" feel like it did something: the row
 * leaves the rail in the same gesture. A message linked only to a *completed*
 * card comes back, because a finished todo is no longer a reason not to be told
 * about the mail again.
 */
export function selectUrgentMail(
  urgent: MailHeader[],
  important: MailHeader[],
  tasks: CalendarTask[],
  limit = 8,
): MailHeader[] {
  const converted = new Set(
    tasks
      .filter((t) => t.percent < 100 && t.mail?.message_id)
      .map((t) => t.mail!.message_id),
  );
  const seen = new Set<string>();
  const out: MailHeader[] = [];
  for (const header of [...urgent, ...important]) {
    if (converted.has(header.id) || seen.has(header.id)) continue;
    seen.add(header.id);
    out.push(header);
    if (out.length >= limit) break;
  }
  return out;
}

// ── Converting something else into a card ───────────────────────────────────

/**
 * **One card shape for every conversion.**
 *
 * The two rails both turn something that is not a card into one — a marked mail,
 * an appointment — and the temptation is to let each build the record it happens
 * to need. That is what produces two kinds of card on one board: one that lands
 * in the backlog and one that lands wherever, one that records where it came
 * from and one that says so only in its title. So both go through
 * `convertedCard`, and the fixed part is fixed here:
 *
 * - **the backlog** (the board's intake column) — a converted card is an intake,
 *   not a decision about when it will be done, and the drag onto Today is the
 *   user's to make. Never a date column, for the same reason: a card lands in
 *   Today or Overdue by having a deadline, not by how it was created;
 * - **open**, `percent: 0`, unranked (the first move ranks it);
 * - **`created`** stamped from the caller's clock, as everything else that mints
 *   a card does — this module has no business reading the clock for a write;
 * - **a source line in `notes`**, and a **link** (`mail` / `event`) recording the
 *   object it came from, so "why does this card exist" survives the mail being
 *   deleted or the calendar being unsubscribed.
 *
 * The source line is built from **glyph + the object's own data, never a word**,
 * which is what keeps these builders pure and out of `i18n`: a card is a stored
 * record, and a note written in the UI language of the day it was created would
 * be a fossil of that setting sitting in `calendar.json` forever.
 */
export interface CardConversion {
  /** Calendar to file the card under — the board's default. */
  calendarId: string;
  /** The board's intake column (`fallbackColumnId`). Named rather than assumed,
   *  because a user can rename or reorder the columns and "backlog" is then just
   *  a word. */
  columnId: string;
  /** The clock, injected: the frontend owns local wall-clock stamps. */
  now?: Date;
}

function convertedCard(
  conv: CardConversion,
  fields: {
    title: string;
    notes: string;
    priority: number;
    due?: string | null;
    start?: string | null;
    mail?: CalendarTask["mail"];
    event?: CalendarTask["event"];
    file?: CalendarTask["file"];
    project_id?: string;
  },
): Omit<CalendarTask, "id"> {
  return {
    calendar_id: conv.calendarId,
    title: fields.title,
    notes: fields.notes,
    due: fields.due ?? null,
    start: fields.start ?? null,
    priority: fields.priority,
    percent: 0,
    column: conv.columnId,
    created: toStamp(conv.now ?? new Date()),
    ...(fields.mail ? { mail: fields.mail } : {}),
    ...(fields.event ? { event: fields.event } : {}),
    ...(fields.file ? { file: fields.file } : {}),
    ...(fields.project_id ? { project_id: fields.project_id } : {}),
  };
}

/** Convert one file remark into an ordinary intake card. */
export function taskFromRemark(
  remark: ProjectRemark,
  projectId: string,
  conv: CardConversion,
): Omit<CalendarTask, "id"> {
  const first = remark.text.split("\n").find((line) => line.trim())?.trim() || remark.file;
  const source = `${remark.file}${remark.line != null ? `:${remark.line}` : ""}`;
  return convertedCard(conv, {
    title: first,
    notes: source,
    priority: 5,
    project_id: projectId,
    file: { project_id: projectId, path: remark.file, line: remark.line, text: remark.text },
  });
}

/**
 * A marked mail as a card.
 *
 * `fallbackTitle` is the caller's, because "(no subject)" is the one string here
 * that a user reads as *text* rather than as data — the mail client already
 * translates it, and this builder must not own a second spelling of it.
 *
 * The mark becomes the card's priority (urgent → high, important → normal) and is
 * *also* frozen into the link as `priority_at_convert`: the mark can be cleared
 * on the message afterwards, and the card's own priority can be edited, so
 * neither one is a record of why the card was made.
 */
export function taskFromMail(
  header: MailHeader,
  conv: CardConversion,
  fallbackTitle: string,
): Omit<CalendarTask, "id"> {
  const from = header.from?.name || header.from?.address || "";
  const address = header.from?.address ?? "";
  // Both halves when the display name is not the address — an attacker-chosen
  // name must never stand in for the identity, `MailList`'s rule.
  const sender = from && address && from !== address ? `${from} <${address}>` : from || address;
  return convertedCard(conv, {
    title: header.subject || fallbackTitle,
    notes: sender ?? "",
    priority: header.priority === "urgent" ? 1 : 5,
    due: null,
    mail: {
      message_id: header.id,
      account_id: header.account_id,
      folder_id: header.folder_id,
      subject: header.subject,
      from: address,
      priority_at_convert: header.priority ?? "",
    },
  });
}

/**
 * An appointment as a card — `taskFromMail`'s twin, through the same builder.
 *
 * Two decisions are the appointment's own. It is **due when it happens** — a
 * timed appointment carries its hour onto the card (`due` is the full
 * `occ.start`, so the card goes overdue at the meeting's start rather than at the
 * end of its day), while an all-day one has only a day to be due on
 * (`datePart`). Either way that is what puts the card in the header badge's count
 * and turns it red once the moment has passed — a meeting you have not prepared
 * for is late in exactly the way an overdue card is. And it is **one card per
 * occurrence**: `start` is this instance's, not the series', so next week's
 * stand-up is a card of its own rather than a duplicate the board would have to
 * reconcile.
 */
export function taskFromOccurrence(
  occ: Occurrence,
  conv: CardConversion,
  fallbackTitle: string,
): Omit<CalendarTask, "id"> {
  const when = occ.allDay
    ? datePart(occ.start)
    : `${datePart(occ.start)} ${timePart(occ.start)}–${timePart(occ.end)}`;
  return convertedCard(conv, {
    title: occ.title || fallbackTitle,
    notes: occ.location ? `${when} · ${occ.location}` : when,
    priority: 5,
    due: occ.allDay ? datePart(occ.start) : occ.start,
    start: occ.start,
    event: {
      event_id: occ.eventId,
      occurrence_start: occ.occurrenceStart,
      calendar_id: occ.calendarId,
      title: occ.title,
      location: occ.location,
    },
  });
}

/**
 * Does an **open** card already stand for this occurrence?
 *
 * The agenda rail asks this per row and, unlike the mail rail, does *not* drop
 * the row when the answer is yes — the mail rail is a list of things demanding an
 * answer, so a converted message leaving it is the point, while this rail is
 * *the day*: hiding the 10:00 meeting because it has a card would make the rail
 * disagree with the calendar and with the header badge about what today holds.
 * The row simply stops offering a second card.
 *
 * Matched on the event **and the occurrence**, so a weekly series carded once is
 * not reported as carded for every future week. A completed card does not count,
 * for `selectUrgentMail`'s reason: a finished todo is no reason not to make
 * another one.
 */
export function occurrenceCardOf(
  occ: Occurrence,
  tasks: CalendarTask[],
): CalendarTask | null {
  return (
    tasks.find(
      (t) =>
        t.percent < 100 &&
        t.event?.event_id === occ.eventId &&
        (t.event.occurrence_start ?? "") === occ.occurrenceStart,
    ) ?? null
  );
}

/**
 * A tab as a card — the tab menu's "Create to-do card". Titled after the tab;
 * an Urgent tab makes a high-priority card. Filed under the tab's project when
 * the tab lives in one (the root console and boxes have none).
 *
 * The link back is the tab's (`TabEntry.todoId`), not the card's: a tab's key
 * is re-minted on every restore, so only the tab can carry a link that
 * survives a relaunch. `linkedTabOf` resolves it from the card's side.
 */
export function taskFromTab(
  tab: { label: string; mark?: string },
  projectId: string | null,
  conv: CardConversion,
): Omit<CalendarTask, "id"> {
  return convertedCard(conv, {
    title: tab.label,
    notes: "",
    priority: tab.mark === "urgent" ? 1 : 5,
    ...(projectId ? { project_id: projectId } : {}),
  });
}

/** The open tab linked to a card, searched across every loaded scope. */
export function linkedTabOf(
  tabsByScope: Record<string, readonly { key: string; label: string; todoId?: string }[]>,
  taskId: string,
): { scope: string; key: string; label: string } | null {
  for (const [scope, tabs] of Object.entries(tabsByScope)) {
    const tab = tabs.find((t) => t.todoId === taskId);
    if (tab) return { scope, key: tab.key, label: tab.label };
  }
  return null;
}

// ── Drag geometry ───────────────────────────────────────────────────────────

/**
 * Where a card dropped at `y` should be inserted, given the on-screen rects of
 * the column's other cards.
 *
 * The vertical twin of `CenterPanel`'s inline `computeReorderIndex`, extracted
 * rather than copied inline so it can be tested without a DOM — which matters
 * more here, since the drag gesture itself cannot be tested at all under jsdom.
 */
export function insertionIndex(
  rects: Array<{ top: number; height: number }>,
  y: number,
): number {
  for (let i = 0; i < rects.length; i++) {
    const { top, height } = rects[i];
    if (y < top + height / 2) return i;
  }
  return rects.length;
}

/**
 * The slot a card **already occupies** in its own column, in the same
 * exclusive-of-itself index space `insertionIndex` and the backend's
 * `TaskPlacement.index` are counted in.
 *
 * It is simply the card's position in the ordered column — removing a card at
 * position `p` and re-inserting it at index `p` puts it back where it was — and
 * that identity is the whole reason this is a named function rather than a
 * `findIndex` at the call site. Two things depend on it and would be wrong in
 * opposite directions if they disagreed: the drag opens with the placeholder in
 * this slot (so nothing jumps at pickup and the preview is truthful from the
 * first frame), and a drop that lands back on it is skipped instead of written
 * (`move_tasks_at`'s own `settled` check computes the same number).
 *
 * A card that is not in the list at all — it was filtered out, or deleted under
 * the drag — appends.
 */
export function currentSlot(ordered: CalendarTask[], taskId: string): number {
  const at = ordered.findIndex((t) => t.id === taskId);
  return at < 0 ? ordered.length : at;
}

/**
 * How far to scroll when the pointer nears an edge of a scrollable region.
 * Zero in the middle, growing towards the edge and clamped at `max` — so a drag
 * to the far right of the board keeps moving at a readable speed rather than
 * jumping a column per frame.
 */
export function autoscrollDelta(
  near: number,
  far: number,
  pos: number,
  edge = 48,
  max = 18,
): number {
  if (pos < near + edge) {
    const depth = Math.min(edge, near + edge - pos);
    return -Math.ceil((depth / edge) * max);
  }
  if (pos > far - edge) {
    const depth = Math.min(edge, pos - (far - edge));
    return Math.ceil((depth / edge) * max);
  }
  return 0;
}
