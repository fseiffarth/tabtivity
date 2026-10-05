import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { resolveProjectDirectory, type CalendarTask, type TaskColumn } from "../../types";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useProjectsStore } from "../../stores/projects";
import { useTodoStore } from "../../stores/todo";
import { useTabsStore } from "../../stores/tabs";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import { addDays, datePart, formatTime, timePart, toStamp } from "../../lib/calendar/calendarTime";
import {
  addSubtask,
  dueDelta,
  dueDeltaKey,
  isOverdue,
  linkedTabOf,
  moveSubtask,
  priorityBucket,
  removeSubtask,
  subtaskProgress,
  toggleSubtask,
  toggleTaskDone,
} from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { useListReorder } from "../../hooks/useListReorder";
import { resolveRemarkAbsPath } from "../../lib/projects/projectRemarks";
import { jumpToSource } from "../embed/FileViewerPane";
import { basename } from "../../lib/paths";
import { ClockIcon, MailIcon, PinIcon } from "../common/icons/Icon";
import { useArrived } from "../../stores/calendar/arrivals";

interface Props {
  task: CalendarTask;
  columns: TaskColumn[];
  onPointerDown: (e: React.PointerEvent, task: CalendarTask, el: HTMLElement) => void;
  onEdit: (task: CalendarTask) => void;
  onOpenMail: (task: CalendarTask) => void;
}

const MAX_TAG_CHIPS = 3;

/**
 * One card.
 *
 * Two rules run through it. **Every inner control stops the pointer**
 * (`onPointerDown` → `stopPropagation`), or clicking a checkbox seeds a drag that
 * the 5px threshold then cancels — the same idiom `TabBar` applies to its own
 * per-tab buttons. And **the title edits inline**, because renaming is the
 * commonest edit on a board; its Escape must `stopPropagation` or the overlay
 * host's window listener tears the whole board down mid-rename.
 *
 * The **checklist** is inline for the title's reason: breaking a card into steps
 * is what you do *while* looking at the board, and routing it through the full
 * card dialog means losing sight of the column you were reasoning about. Every
 * edit writes immediately — there is no Save on a board, so a staged checklist
 * here would be a draft the user has no way to see is unsaved. The composer is
 * the column's: **Enter adds and stays open**, because steps are typed in a run.
 * Renaming a step is deliberately still the dialog's, where there is room for a
 * text field per row.
 *
 * A card's steps are **shown by default**, and the progress bar folds them away
 * rather than being what reveals them. They were hidden first, on the theory that
 * a checklist is a card's detail and its bar is the headline — but the two say
 * different things: "2/5" is a number, and *which* two is the reason to look at
 * the board at all. Hidden by default also made the bar the only thing that could
 * ever disclose them, so a card whose steps were all done showed a full bar and
 * nothing else, and reading the day meant clicking every card in the column.
 * Folding is still there for a card broken into fifteen steps — it is just the
 * exception now, remembered per card in `stores/todo` (which is why it survives
 * the board being closed: this component unmounts with the overlay, and a fold
 * that undid itself on the next open would be a flicker, not a control).
 */
export function TodoCard({ task, columns, onPointerDown, onEdit, onOpenMail }: Props) {
  const t = useT();
  const arrived = useArrived(task.id);
  const use24h = useUse24h();
  const projects = useProjectsStore((s) => s.projects);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  // The composer, opened by the head's `＋` on a card that has no steps yet —
  // the one case where there is no checklist to show and something still has to
  // appear. A card that HAS steps is open unless the user folded it.
  const [composing, setComposing] = useState(false);
  const [stepDraft, setStepDraft] = useState("");
  const collapsed = useTodoStore((s) => !!s.collapsedSteps[task.id]);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stepRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  // Focus follows the **composer**, never the panel: with checklists open by
  // default, focusing on open would have every card on the board grab the caret
  // as it mounted.
  useEffect(() => {
    if (composing) stepRef.current?.focus();
  }, [composing]);

  // The whole stamp, not just the day: a card carrying an **hour** deadline goes
  // red when that hour passes, and only a clock can say so. Re-read on every
  // render, which is what the card already did with `todayStr()`.
  // One clock for both readings, taken once: two `new Date()`s a line apart can
  // straddle a minute, and this is precisely the pair where that would show —
  // the chip saying "in 1 min" beside a card the same render calls overdue.
  const clock = new Date();
  const now = toStamp(clock);
  const today = datePart(now);
  const done = task.percent >= 100;
  const overdue = isOverdue(task, now);
  const dueDate = task.due ? datePart(task.due) : null;
  const dueTime = task.due ? formatTime(timePart(task.due), use24h) : "";
  const dueToday = dueDate === today;
  const dueTomorrow = dueDate === addDays(today, 1);
  // How long is left, or how long it has been — the header list's chip, on the
  // card, because the date alone leaves the arithmetic to the reader exactly
  // when it matters least. Only inside a day, and only for a **fixed-hour**
  // deadline past that (`dueDelta`: "2d 5h" is a real measurement, a whole-day
  // card's "2d" is what the date beside it already says).
  const delta = dueDelta(task, clock);
  const deltaLabel =
    delta && delta.unit !== "d"
      ? t(dueDeltaKey(delta), { count: delta.count, hours: delta.hours ?? 0 })
      : "";
  const priority = priorityBucket(task.priority);
  const steps = subtaskProgress(task);
  // Shown whenever the card has steps and the user has not folded it — plus the
  // composer's own case, a card with no steps at all.
  const openSteps = (!!steps && !collapsed) || composing;
  const tags = task.tags ?? [];
  const project = task.project_id ? projects.find((p) => p.id === task.project_id) : null;
  // The tab this card was made from (the tab carries the link — see
  // `TabEntry.todoId`). Shallow-compared, so the card re-renders only when the
  // answer changes, not on every tab write.
  const linkedTab = useTabsStore(useShallow((s) => linkedTabOf(s.tabsByScope, task.id)));

  const commitTitle = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === task.title) {
      setDraft(task.title);
      return;
    }
    await useCalendarStore
      .getState()
      .updateTask({ ...task, title: next })
      .catch((err) => useTodoStore.getState().setError(String(err)));
  };

  const toggle = async () => {
    await useCalendarStore
      .getState()
      .updateTask(toggleTaskDone(task, columns))
      .catch((err) => useTodoStore.getState().setError(String(err)));
  };

  /**
   * One checklist edit, saved.
   *
   * The card it edits is read out of the **store**, not off this render's props:
   * steps are typed in a run, and a second Enter one frame after the first would
   * otherwise apply to a card that does not know about the first step yet and
   * drop it.
   */
  const editSteps = async (change: (current: CalendarTask) => CalendarTask) => {
    const store = useCalendarStore.getState();
    const current = store.tasks.find((x) => x.id === task.id) ?? task;
    await store
      .updateTask(change(current))
      .catch((err) => useTodoStore.getState().setError(String(err)));
  };

  const addStep = async () => {
    const value = stepDraft.trim();
    if (!value) return;
    setStepDraft("");
    await editSteps((current) => addSubtask(current, value));
    stepRef.current?.focus();
  };

  // Reordering is one more checklist edit, written like every other one — the
  // gesture itself is `useListReorder`'s, shared with the dialog.
  const reorder = useListReorder(task.subtasks ?? [], (id, to) => {
    void editSteps((current) => moveSubtask(current, id, to));
  });

  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div
      ref={ref}
      className={
        "todo-card" +
        (done ? " todo-card-done" : "") +
        (overdue ? " todo-card-overdue" : "") +
        (arrived ? " arrived" : "")
      }
      data-task-id={task.id}
      onPointerDown={(e) => {
        // A card being renamed is an <input>: leave its caret alone.
        if (editing) return;
        if (ref.current) onPointerDown(e, task, ref.current);
      }}
      onDoubleClick={() => onEdit(task)}
    >
      <div className="todo-card-head">
        <input
          type="checkbox"
          className="todo-card-check"
          checked={done}
          onPointerDown={stop}
          onChange={() => void toggle()}
          title={done ? t("todoCard.markNotDone") : t("todoCard.markDone")}
        />

        {editing ? (
          <input
            ref={inputRef}
            className="todo-card-title-input"
            value={draft}
            onPointerDown={stop}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitTitle();
              } else if (e.key === "Escape") {
                // Or the overlay host's window listener closes the board.
                e.stopPropagation();
                setDraft(task.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="todo-card-title"
            onPointerDown={stop}
            onClick={() => {
              setDraft(task.title);
              setEditing(true);
            }}
            title={t("todoCard.renameTitle")}
          >
            {task.title}
          </button>
        )}

        <button
          type="button"
          className="todo-card-add-step"
          onPointerDown={stop}
          onClick={() => {
            setStepDraft("");
            setComposing(true);
            // Adding a step to a folded card unfolds it: the row about to be
            // typed has to land somewhere the user can see it.
            useTodoStore.getState().toggleSteps(task.id, false);
            // Already composing: the effect will not re-fire, so aim the caret here.
            stepRef.current?.focus();
          }}
          title={t("todoCard.addStep")}
          aria-label={t("todoCard.addStep")}
        >
          ＋
        </button>

        <button
          type="button"
          className="todo-card-edit"
          onPointerDown={stop}
          onClick={() => onEdit(task)}
          title={t("todoCard.edit")}
          aria-label={t("todoCard.edit")}
        >
          ✎
        </button>
      </div>

      {(dueDate || priority !== "none" || tags.length > 0) && (
        <div className="todo-card-chips">
          {dueDate && (
            <span
              className={
                "todo-chip todo-chip-due" +
                (overdue ? " todo-chip-overdue" : dueToday ? " todo-chip-today" : "")
              }
              title={
                (overdue
                  ? t("todoCard.overdue")
                  : dueToday
                    ? t("todoCard.dueToday")
                    : dueTomorrow
                      ? t("todoCard.dueTomorrow")
                      : dueDate) + (dueTime ? ` · ${dueDate} ${dueTime}` : "")
              }
            >
              {/* The hour is printed only when there is one — a card due "some
                  time on Friday" must not be dressed up as one due at 00:00. */}
              <ClockIcon /> {dueDate}
              {dueTime ? ` ${dueTime}` : ""}
              {/* And beside it, never instead of it: the date says *when*, the
                  countdown says how long that leaves, and only the second is
                  readable at a glance on the day it matters. */}
              {deltaLabel ? (
                <span className="todo-chip-delta"> · {deltaLabel}</span>
              ) : null}
            </span>
          )}
          {priority !== "none" && (
            <span className={`todo-chip todo-chip-prio todo-chip-prio-${priority}`}>
              {priority === "high"
                ? t("tasksView.priorityHigh")
                : priority === "normal"
                  ? t("tasksView.priorityNormal")
                  : t("tasksView.priorityLow")}
            </span>
          )}
          {tags.slice(0, MAX_TAG_CHIPS).map((tag) => (
            <span key={tag} className="todo-chip todo-chip-tag">
              #{tag}
            </span>
          ))}
          {tags.length > MAX_TAG_CHIPS && (
            <span className="todo-chip todo-chip-more">
              {t("todoCard.moreTags", { count: tags.length - MAX_TAG_CHIPS })}
            </span>
          )}
        </div>
      )}

      {steps && (
        <button
          type="button"
          className="todo-card-steps"
          onPointerDown={stop}
          // The bar is the FOLD control now, not the reveal: the checklist is
          // already on screen, and this puts it away for a card that has grown
          // too many steps to read past.
          onClick={() => {
            setComposing(false);
            useTodoStore.getState().toggleSteps(task.id, openSteps);
          }}
          title={
            t("todoCard.subtaskProgress", { done: steps.done, total: steps.total }) +
            " — " +
            (openSteps ? t("todoCard.hideSteps") : t("todoCard.showSteps"))
          }
          aria-expanded={openSteps}
        >
          <span className="todo-card-steps-bar">
            <span
              className="todo-card-steps-fill"
              style={{ width: `${(steps.done / steps.total) * 100}%` }}
            />
          </span>
          <span className="todo-card-steps-text">
            {steps.done}/{steps.total}
          </span>
          {/* The state, said rather than implied: a folded card is otherwise
              indistinguishable from one whose steps simply have not loaded. */}
          <span className="todo-card-steps-caret" aria-hidden>
            {openSteps ? "⌃" : "⌄"}
          </span>
        </button>
      )}

      {openSteps && (
        // The whole panel swallows the pointer: it is a stack of controls sitting
        // in the middle of a card whose own pointerdown starts a drag.
        <div className="todo-card-checklist" onPointerDown={stop}>
          <ul className="todo-card-step-list">
            {(task.subtasks ?? []).map((step, i) => (
              <li
                key={step.id}
                ref={reorder.rowRef(step.id)}
                className={
                  "todo-card-step" +
                  (reorder.isDragging(step.id)
                    ? " todo-step-dragging"
                    : reorder.drag
                      ? " todo-step-parting"
                      : "")
                }
                style={reorder.rowStyle(i)}
              >
                <button
                  type="button"
                  className="todo-step-grip"
                  title={t("todoCard.stepGrip")}
                  aria-label={t("todoCard.stepGripAria", { title: step.title })}
                  {...reorder.gripProps(step.id)}
                >
                  ⠿
                </button>
                <input
                  type="checkbox"
                  className="todo-card-step-check"
                  checked={step.done}
                  onChange={() => void editSteps((c) => toggleSubtask(c, step.id))}
                />
                <span
                  className={
                    "todo-card-step-title" + (step.done ? " todo-card-step-title-done" : "")
                  }
                >
                  {step.title}
                </span>
                <button
                  type="button"
                  className="todo-card-step-x"
                  onClick={() => void editSteps((c) => removeSubtask(c, step.id))}
                  title={t("todoCard.removeStep")}
                  aria-label={t("todoCard.removeStep")}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          {/* The composer appears only while something is being added. It used to
              be permanent, which was affordable while the panel itself was the
              rare state; with every card's checklist on screen it would put an
              empty input under every card on the board. The head's `＋` is the
              way back to it. */}
          {composing && (
            <input
              ref={stepRef}
              className="todo-card-step-input"
              value={stepDraft}
              placeholder={t("todoDialog.subtaskPlaceholder")}
              onChange={(e) => setStepDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addStep();
                } else if (e.key === "Escape") {
                  // Or the overlay host's window listener closes the whole board.
                  // Escape abandons the *composer*, never the checklist: a card
                  // with steps keeps showing them, which is now its normal state.
                  e.stopPropagation();
                  setStepDraft("");
                  setComposing(false);
                }
              }}
              onBlur={() => {
                // Nothing typed and nothing to show: the composer was the only
                // reason this panel was open, so it goes away with the caret.
                if (!stepDraft.trim()) setComposing(false);
              }}
            />
          )}
        </div>
      )}

      {(task.project_id || task.mail || task.file || linkedTab) && (
        <div className="todo-card-foot">
          {task.project_id && (
            <button
              type="button"
              className={"todo-card-project" + (project ? "" : " todo-card-project-unknown")}
              onPointerDown={stop}
              onClick={() => {
                if (project) void useProjectsStore.getState().setActive(project.id);
              }}
              title={project ? t("todoCard.openProject") : t("todoCard.unknownProject")}
              disabled={!project}
            >
              ⬤ {project ? project.name : t("todoCard.unknownProject")}
            </button>
          )}
          {task.mail && (
            <button
              type="button"
              className="todo-card-mail"
              onPointerDown={stop}
              onClick={() => onOpenMail(task)}
              title={task.mail.subject || t("todoCard.openMail")}
              aria-label={t("todoCard.openMail")}
            >
              <MailIcon />
            </button>
          )}
          {task.file && (
            <button
              type="button"
              className={"todo-card-mail" + (project ? "" : " todo-card-project-unknown")}
              onPointerDown={stop}
              disabled={!project}
              title={project ? task.file.path : t("todoCard.unknownProject")}
              onClick={() => {
                const abs = resolveRemarkAbsPath(resolveProjectDirectory(project), task.file!.path);
                if (abs) jumpToSource(abs, task.file!.line ?? 1);
              }}
            >
              <PinIcon /> {basename(task.file.path)}{task.file.line != null ? `:${task.file.line}` : ""}
            </button>
          )}
          {linkedTab && (
            <button
              type="button"
              className="todo-card-mail todo-card-tab"
              onPointerDown={stop}
              title={t("todoCard.openTab")}
              onClick={() => {
                useTodoStore.getState().closeOverlay();
                jumpToTab(linkedTab.scope, linkedTab.key);
              }}
            >
              ▭ {linkedTab.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
