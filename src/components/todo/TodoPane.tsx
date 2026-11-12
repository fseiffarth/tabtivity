import { useEffect, useMemo, useState } from "react";

import type { CalendarTask } from "../../types";
import { useCalendarStore, visibleCalendarIds } from "../../stores/calendar/calendar";
import { useMailStore } from "../../stores/mail";
import { useProjectsStore } from "../../stores/projects";
import { useTodoStore } from "../../stores/todo";
import { useExperimental } from "../../lib/experimental";
import {
  allTags,
  applyPending,
  archivedColumnIds,
  boardColumns,
  doneColumnId,
  fallbackColumnId,
  filterTasks,
} from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";
import { TodoAgendaRail } from "./TodoAgendaRail";
import { TodoBoard } from "./TodoBoard";
import { TodoCardDialog } from "./TodoCardDialog";
import { TodoMailRail } from "./TodoMailRail";

/**
 * The board's contents: a filter bar, the board, and the two rails.
 *
 * It renders `applyPending(tasks, pendingOrder)` rather than the store's tasks —
 * the optimistic overlay a drag stages, so a dropped card is in its new slot on
 * the next paint and the write-through never shows as a snap-back.
 */
export function TodoPane() {
  const t = useT();
  const mailClient = useExperimental("mail_client");

  const tasks = useCalendarStore((s) => s.tasks);
  const calendars = useCalendarStore((s) => s.calendars);
  const storedColumns = useCalendarStore((s) => s.taskColumns);
  const projects = useProjectsStore((s) => s.projects);

  const search = useTodoStore((s) => s.search);
  const projectFilter = useTodoStore((s) => s.projectFilter);
  const tagFilter = useTodoStore((s) => s.tagFilter);
  const hideDone = useTodoStore((s) => s.hideDone);
  const pendingOrder = useTodoStore((s) => s.pendingOrder);
  const focusTaskId = useTodoStore((s) => s.focusTaskId);
  const error = useTodoStore((s) => s.error);

  const [editing, setEditing] = useState<CalendarTask | null>(null);

  // One local file; `load` is idempotent, and the board needs the tasks before
  // anything else here can render.
  useEffect(() => {
    void useCalendarStore.getState().load();
  }, []);

  // The dialog edits a snapshot; when the store's copy changes underneath (a
  // write-through, or a reconcile that moved the card) follow it rather than
  // saving a stale record back over it. A card being *added* has no copy to
  // follow — an empty id means the row does not exist yet, and reading that as
  // "deleted underneath me" would close the dialog on the frame it opened.
  useEffect(() => {
    if (!editing || !editing.id) return;
    const fresh = tasks.find((task) => task.id === editing.id);
    if (!fresh) setEditing(null);
  }, [tasks, editing]);

  // The header's urgent list asked for a card by id. Consumed once and cleared,
  // so the request cannot re-raise the dialog the next time the board is opened;
  // a card that has since been deleted simply clears without opening anything.
  useEffect(() => {
    // `tasks.length === 0` is the not-loaded-yet case, not "no such card": the
    // effect re-runs when the load lands, and a store that really holds nothing
    // has no card to open either way.
    if (!focusTaskId || tasks.length === 0) return;
    const target = tasks.find((task) => task.id === focusTaskId);
    if (target) setEditing(target);
    useTodoStore.getState().clearFocusTask();
  }, [focusTaskId, tasks]);

  const columns = useMemo(() => boardColumns(storedColumns), [storedColumns]);
  const archived = useMemo(() => archivedColumnIds(columns), [columns]);
  const withPending = useMemo(
    () => applyPending(tasks, pendingOrder),
    [tasks, pendingOrder],
  );
  const visible = useMemo(() => visibleCalendarIds(calendars), [calendars]);
  // Keep the column badges useful when completed cards are hidden.  The board
  // gets this matching set for its counts, while `shown` below remains the
  // smaller set it actually renders.
  const counted = useMemo(
    () =>
      filterTasks(withPending, {
        search,
        project: projectFilter,
        tag: tagFilter,
        hideDone: false,
        visibleCalendars: visible,
        archived,
      }),
    [withPending, search, projectFilter, tagFilter, visible, archived],
  );
  const shown = useMemo(
    () =>
      filterTasks(withPending, {
        search,
        project: projectFilter,
        tag: tagFilter,
        hideDone,
        visibleCalendars: visible,
        archived,
      }),
    [withPending, search, projectFilter, tagFilter, hideDone, visible, archived],
  );
  const tags = useMemo(() => allTags(tasks), [tasks]);

  const filtered =
    !!search.trim() || projectFilter !== null || tagFilter !== null || hideDone;
  const defaultCalendarId = calendars[0]?.id ?? "default";

  const openMail = async (task: CalendarTask) => {
    if (!task.mail || !mailClient) return;
    // The board stays up until the Mail view replaces it (`openInbox`).
    const mail = useMailStore.getState();
    if (task.mail.folder_id) await mail.openFolder(task.mail.folder_id).catch(() => {});
    mail.openInbox();
    mail.openMessage(task.mail.message_id);
  };

  return (
    <div className="todo-pane">
      <div className="todo-toolbar">
        <input
          className="cal-input todo-search"
          type="search"
          value={search}
          placeholder={t("todoBoard.searchPlaceholder")}
          onChange={(e) => useTodoStore.getState().setSearch(e.target.value)}
          onKeyDown={(e) => {
            // The overlay host's Escape listener would otherwise close the whole
            // board when all the user meant was to clear the box.
            if (e.key === "Escape") e.stopPropagation();
          }}
        />

        <select
          className="cal-input todo-filter"
          value={projectFilter ?? ""}
          title={t("todoBoard.filterProject")}
          onChange={(e) =>
            useTodoStore
              .getState()
              .setProjectFilter(e.target.value === "" ? null : (e.target.value as string))
          }
        >
          <option value="">{t("todoBoard.filterAnyProject")}</option>
          <option value="none">{t("todoBoard.filterNoProject")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <select
          className="cal-input todo-filter"
          value={tagFilter ?? ""}
          title={t("todoBoard.filterTag")}
          onChange={(e) =>
            useTodoStore.getState().setTagFilter(e.target.value || null)
          }
        >
          <option value="">{t("todoBoard.filterAnyTag")}</option>
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              #{tag}
            </option>
          ))}
        </select>

        {/* "Hide done" lives in the Done column's head; only a board with no
            done column (coupling off) keeps it up here. */}
        {doneColumnId(columns) === null && (
          <label className="todo-toggle">
            <input
              type="checkbox"
              checked={hideDone}
              onChange={(e) => useTodoStore.getState().setHideDone(e.target.checked)}
            />
            {t("todoBoard.hideDone")}
          </label>
        )}

        {filtered && (
          <button
            type="button"
            className="cal-link-btn"
            onClick={() => useTodoStore.getState().clearFilters()}
          >
            {t("todoBoard.clearFilters")}
          </button>
        )}
      </div>

      {error && (
        <div className="todo-error-strip">
          {t("todoBoard.writeFailed", { error })}
          <button
            type="button"
            className="cal-link-btn"
            onClick={() => useTodoStore.getState().setError(null)}
          >
            {t("common.close")}
          </button>
        </div>
      )}

      <div className="todo-body">
        {tasks.length === 0 ? (
          <div className="todo-empty">
            <p className="todo-empty-title">{t("todoBoard.emptyBoard")}</p>
            <p className="todo-empty-hint">{t("todoBoard.emptyBoardHint")}</p>
          </div>
        ) : shown.length === 0 && filtered ? (
          <div className="todo-empty">
            <p className="todo-empty-title">{t("todoBoard.noMatches")}</p>
          </div>
        ) : null}

        <TodoBoard
          columns={columns}
          tasks={shown}
          countTasks={counted}
          defaultCalendarId={defaultCalendarId}
          inheritProjectId={
            projectFilter && projectFilter !== "none" ? projectFilter : null
          }
          onEditCard={setEditing}
          onOpenMail={(task) => void openMail(task)}
        />

        <aside className="todo-rails">
          {/* Both rails convert into the SAME column — the board's intake one —
              and they are handed it rather than assuming "backlog", which a
              renamed or reordered board turns into just a word. A conversion is
              an intake, so it must not land in a date column either: what a card
              is due is not decided by the rail that created it. */}
          <TodoAgendaRail
            tasks={tasks}
            defaultCalendarId={defaultCalendarId}
            intakeColumnId={fallbackColumnId(columns)}
          />
          <TodoMailRail
            tasks={tasks}
            defaultCalendarId={defaultCalendarId}
            intakeColumnId={fallbackColumnId(columns)}
          />
        </aside>
      </div>

      {editing && (
        <TodoCardDialog
          task={
            // A draft (empty id) is only ever itself; an existing card follows
            // the store's copy so a write-through is not edited over.
            editing.id ? (tasks.find((task) => task.id === editing.id) ?? editing) : editing
          }
          columns={columns}
          onClose={() => setEditing(null)}
          onOpenMail={(task) => void openMail(task)}
        />
      )}
    </div>
  );
}
