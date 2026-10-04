import { useMemo, useState } from "react";
import type { Calendar, CalendarTask } from "../../types";
import { datePart, formatLongDate, formatTime, timePart, toStamp } from "../../lib/calendar/calendarTime";
import { calendarColor } from "../../stores/calendar/calendar";
import { useI18nStore, useT, type TranslationKey } from "../../lib/i18n";
import { useArrivedMarks } from "../../stores/calendar/arrivals";

interface Props {
  tasks: CalendarTask[];
  calendars: Calendar[];
  /** Only tasks on these calendars are listed. */
  visibleCalendars: Set<string>;
  search: string;
  onCreate: (task: Omit<CalendarTask, "id">) => Promise<unknown>;
  onUpdate: (task: CalendarTask) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  /** The calendar a new task is filed under. */
  defaultCalendarId: string;
  /** App-wide clock (`lib/timeFormat`), passed down like the grid views' — the
   *  hour on a task with a timed deadline is printed in it. */
  use24h: boolean;
}

type Filter = "open" | "all" | "done";

/** iCalendar priority: 1-4 high, 5 normal, 6-9 low, 0 unset. */
function priorityLabel(p: number, t: (key: TranslationKey) => string): string {
  if (p === 0) return "";
  if (p <= 4) return t("tasksView.priorityHigh");
  if (p === 5) return t("tasksView.priorityNormal");
  return t("tasksView.priorityLow");
}

function priorityClass(p: number): string {
  if (p === 0) return "";
  if (p <= 4) return " cal-task-prio-high";
  if (p === 5) return " cal-task-prio-normal";
  return " cal-task-prio-low";
}

/**
 * A task is overdue when its deadline is behind us and it is not complete.
 *
 * `now` is a full stamp, because a `due` may carry an **hour** (the board's card
 * dialog can set one): such a card is late when that hour passes, not at
 * midnight. Mirrors `lib/todoBoard`'s `isOverdue` — the same rule the board and
 * the header badge apply, so one list cannot call a card late while another
 * still calls it due.
 */
function isOverdue(task: CalendarTask, now: string): boolean {
  if (!task.due || task.percent >= 100) return false;
  const day = datePart(task.due);
  const today = datePart(now);
  if (day !== today) return day < today;
  const deadline = timePart(task.due);
  const clock = timePart(now);
  return !!deadline && !!clock && deadline < clock;
}

/**
 * The to-do list — Thunderbird's Tasks tab.
 *
 * Tasks are VTODOs: a title, an optional due date, a priority and a completion
 * percentage. Ticking the checkbox sets `percent` to 100 and stamps `completed`,
 * which is what makes a task "done" (the completion stamp, not a separate flag,
 * so it survives an ICS round-trip).
 */
export function TasksView({
  tasks,
  calendars,
  visibleCalendars,
  search,
  onCreate,
  onUpdate,
  onDelete,
  defaultCalendarId,
  use24h,
}: Props) {
  const t = useT();
  const arrived = useArrivedMarks();
  const lang = useI18nStore((s) => s.lang);
  const [filter, setFilter] = useState<Filter>("open");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  // Minute-granular rather than the bare day this used to hold, so an hour
  // deadline passing re-sorts the list on the next render instead of waiting for
  // midnight.
  const now = toStamp(new Date());

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks
      .filter((t) => visibleCalendars.has(t.calendar_id))
      .filter((t) => {
        const done = t.percent >= 100;
        if (filter === "open") return !done;
        if (filter === "done") return done;
        return true;
      })
      .filter((t) =>
        q ? `${t.title} ${t.notes ?? ""}`.toLowerCase().includes(q) : true,
      )
      .sort((a, b) => {
        // Overdue first, then by due date (undated last), then by priority.
        const ao = isOverdue(a, now) ? 0 : 1;
        const bo = isOverdue(b, now) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        const ad = a.due ?? "9999";
        const bd = b.due ?? "9999";
        if (ad !== bd) return ad.localeCompare(bd);
        const ap = a.priority || 10;
        const bp = b.priority || 10;
        return ap - bp;
      });
  }, [tasks, visibleCalendars, filter, search, now]);

  async function addTask() {
    const t = title.trim();
    if (!t) return;
    await onCreate({
      calendar_id: defaultCalendarId,
      title: t,
      due: due || null,
      priority: 0,
      percent: 0,
    });
    setTitle("");
    setDue("");
  }

  /** Tick/untick: completion is the `completed` stamp plus percent 100. */
  async function toggleDone(task: CalendarTask) {
    const done = task.percent >= 100;
    await onUpdate({
      ...task,
      percent: done ? 0 : 100,
      completed: done ? null : toStamp(new Date()),
    });
  }

  return (
    <div className="cal-tasks">
      <div className="cal-tasks-add">
        <input
          className="cal-input cal-tasks-add-title"
          type="text"
          placeholder={t("tasksView.addTaskPlaceholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addTask();
          }}
        />
        <input
          className="cal-input cal-tasks-add-due"
          type="date"
          title={t("tasksView.dueDateTitle")}
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
        <button className="cal-btn cal-btn-primary" disabled={!title.trim()} onClick={() => void addTask()}>
          {t("common.add")}
        </button>
      </div>

      <div className="cal-tasks-filters">
        {(["open", "all", "done"] as Filter[]).map((f) => (
          <button
            key={f}
            className={`cal-chip${filter === f ? " cal-chip-on" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "open" ? t("tasksView.filterOpen") : f === "all" ? t("tasksView.filterAll") : t("tasksView.filterCompleted")}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="cal-empty">
          {filter === "done" ? t("tasksView.emptyCompleted") : t("tasksView.emptyNone")}
        </div>
      ) : (
        <div className="cal-tasks-list">
          {shown.map((task) => {
            const done = task.percent >= 100;
            const overdue = isOverdue(task, now);
            return (
              <div
                key={task.id}
                className={
                  "cal-task-row" +
                  (done ? " cal-task-done" : "") +
                  (overdue ? " cal-task-overdue" : "") +
                  (arrived[task.id] ? " arrived" : "")
                }
              >
                <input
                  type="checkbox"
                  className="cal-task-check"
                  checked={done}
                  onChange={() => void toggleDone(task)}
                  title={done ? t("tasksView.markNotDoneTitle") : t("tasksView.markDoneTitle")}
                />

                <span
                  className="cal-task-swatch"
                  style={{ color: calendarColor(calendars, task.calendar_id) }}
                >
                  ●
                </span>

                <span className="cal-task-title">{task.title}</span>

                {task.priority ? (
                  <span className={`cal-task-prio${priorityClass(task.priority)}`}>
                    {priorityLabel(task.priority, t)}
                  </span>
                ) : null}

                {!done && task.percent > 0 ? (
                  <span className="cal-task-percent" title={t("tasksView.percentCompleteTitle", { percent: task.percent })}>
                    <span className="cal-task-percent-fill" style={{ width: `${task.percent}%` }} />
                  </span>
                ) : null}

                {task.due ? (
                  <span className="cal-task-due" title={formatLongDate(datePart(task.due), lang)}>
                    {overdue ? t("tasksView.overduePrefix") : ""}
                    {datePart(task.due)}
                    {/* Printed only when the card actually carries one, so a
                        whole-day due is never dressed up as a 00:00 deadline. */}
                    {timePart(task.due) ? ` ${formatTime(timePart(task.due), use24h)}` : ""}
                  </span>
                ) : null}

                <select
                  className="cal-task-prio-select"
                  value={task.priority}
                  title={t("tasksView.priorityTitle")}
                  onChange={(e) => void onUpdate({ ...task, priority: Number(e.target.value) })}
                >
                  <option value={0}>—</option>
                  <option value={1}>{t("tasksView.priorityHigh")}</option>
                  <option value={5}>{t("tasksView.priorityNormal")}</option>
                  <option value={9}>{t("tasksView.priorityLow")}</option>
                </select>

                <button
                  className="cal-link-btn cal-link-danger"
                  onClick={() => void onDelete(task.id)}
                >
                  {t("common.delete")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
