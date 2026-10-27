import { useModalFocus } from "../../hooks/useModalFocus";
import { useEffect, useRef, useState } from "react";

import type { CalendarTask, Subtask, TaskColumn } from "../../types";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import { mailPrioritySet } from "../../lib/mail";
import { useExperimental } from "../../lib/experimental";
import { addSubtask, fallbackColumnId, moveSubtask, removeSubtask, setSubtask } from "../../lib/todoBoard";
import { datePart, formatTime, timePart, toDateStr } from "../../lib/calendar/calendarTime";
import { useUse24h } from "../../lib/timeFormat";
import { useT } from "../../lib/i18n";
import { TimeField } from "../common/TimeField";
import { useDialogs } from "../common/PromptDialogs";
import { useListReorder } from "../../hooks/useListReorder";

interface Props {
  task: CalendarTask;
  columns: TaskColumn[];
  onClose: () => void;
  onOpenMail: (task: CalendarTask) => void;
}

/**
 * The full card editor — everything the card itself is too small to hold, and
 * (since the column's title-only composer went) the one surface a card is
 * **added** in as well.
 *
 * Adding and editing are the same dialog on purpose: a new card wants exactly
 * the fields an existing one does, and the alternative — create first, edit
 * second — wrote a row to `calendar.json` before the user had said anything
 * about it, so backing out meant deleting something that already existed.
 * `task.id` is the whole distinction, and it is read off the record rather than
 * passed as a flag so the two cannot disagree: an empty id is what `createTask`
 * itself sends for a row that does not exist yet.
 *
 * Rendered on `.modal-backdrop-elevated` so it sits above the board's own
 * backdrop, and every text input's Escape calls `stopPropagation`: the overlay
 * host listens on `window`, where `stopPropagation` does not stop *sibling*
 * listeners, so an unguarded Escape while typing would close the board too.
 *
 * The checklist deliberately does **not** drive `percent`. Deriving it would make
 * the progress control unusable and — since 100% moves a card to Done — ticking
 * the last checkbox would silently relocate the card. The conversion is offered
 * as a button instead.
 */
/**
 * The stored `due` from the three controls that make it — the same shape the
 * calendar's event dialog builds `start`/`end` from (a date, an optional hour,
 * a whole-day switch), rather than editing the string in place per keystroke.
 *
 * No date → no deadline (`null`). A date with the time switch off, or on but
 * blank, is a **whole-day** deadline (`"YYYY-MM-DD"`, overdue at midnight). A
 * date with an hour is a fixed-hour one (`"YYYY-MM-DDTHH:MM"`).
 */
function combineDue(date: string, time: string, withTime: boolean): string | null {
  if (!date) return null;
  return withTime && time ? `${date}T${time}` : date;
}

export function TodoCardDialog({ task, columns, onClose, onOpenMail }: Props) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  // Rendered beside the card's backdrop, not inside the card: the card's own
  // Escape handler would otherwise see the question's Escape (React bubbles a
  // portal's events through the component tree) and close the card too.
  // `DialogShell` lifts the question above this elevated card by itself.
  const { confirmAction, dialogs } = useDialogs();
  const use24h = useUse24h();
  const isNew = !task.id;
  const mailClient = useExperimental("mail_client");
  const calendars = useCalendarStore((s) => s.calendars);
  const calendarApp = useSettingsStore((s) => s.settings?.calendar_global_app ?? true);
  const projects = useProjectsStore((s) => s.projects);

  const [draft, setDraft] = useState<CalendarTask>(task);
  const [tagInput, setTagInput] = useState("");
  const [stepInput, setStepInput] = useState("");
  const [clearMark, setClearMark] = useState(false);
  // The deadline as the calendar edits its start/end: a date and an optional
  // hour held as their **own** plain fields (so `TimeField` binds to a stable
  // string exactly as the event dialog's does), plus a whole-day-vs-hour switch.
  // Off (default) is a whole-day deadline — a date-only `due`, overdue at
  // midnight — and on reveals the clock field. Seeded from the card, so one
  // already due at an hour opens with the hour shown.
  const [dueDate, setDueDate] = useState(() => (task.due ? datePart(task.due) : ""));
  const [dueTime, setDueTime] = useState(() => (task.due ? timePart(task.due) : ""));
  const [showTime, setShowTime] = useState(() => !!(task.due && timePart(task.due)));
  const dueInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const dueTypedRef = useRef(false);

  useEffect(() => {
    setDraft(task);
    setDueDate(task.due ? datePart(task.due) : "");
    setDueTime(task.due ? timePart(task.due) : "");
    setShowTime(!!(task.due && timePart(task.due)));
  }, [task]);

  // The three due controls fold back into `draft.due` — one place, so the field
  // never edits the stored string per keystroke (the round-trip that broke it).
  // Guarded, or writing an unchanged value would re-render every keystroke.
  useEffect(() => {
    const due = combineDue(dueDate, dueTime, showTime);
    setDraft((d) => (d.due === due ? d : { ...d, due }));
  }, [dueDate, dueTime, showTime]);

  // A card being added opens on its title: it is the one field that must be
  // filled in, and the dialog is the composer now.
  useEffect(() => {
    if (isNew) titleInputRef.current?.focus();
  }, [isNew]);

  // WebKitGTK's native `<input type="date">` calendar popover doesn't dismiss
  // on its own (the same widget-class quirk `common/Dropdown.tsx` works around
  // for `<select>`) — blurring the input while it is focused is what closes it.
  // An outside click, though, is the case this listener could never cover on its
  // own: the popover is its own grabbing widget, so the click that picks a day
  // never reaches this document at all — that dismissal is `onChange`'s below,
  // the one signal we get that the picker has done its job. Capture phase,
  // because the dialog's own handlers stop pointer events on the way up.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const input = dueInputRef.current;
      if (!input || document.activeElement !== input) return;
      if (!input.contains(e.target as Node)) input.blur();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const patch = (changes: Partial<CalendarTask>) =>
    setDraft((d) => ({ ...d, ...changes }));

  const canSave = !isNew || !!draft.title.trim();

  const save = async () => {
    if (!canSave) return;
    try {
      if (isNew) {
        // `createTask` takes the record without an id; the draft's is the empty
        // string the board minted, which is what the command expects anyway.
        await useCalendarStore.getState().createTask(draft);
      } else {
        await useCalendarStore.getState().updateTask(draft);
      }
      if (clearMark && draft.mail?.message_id) {
        // Explicit, never implicit: mail may be switched off, and a completion
        // must not silently succeed-or-fail depending on a feature flag.
        await mailPrioritySet(draft.mail.message_id, null).catch(() => {});
      }
      onClose();
    } catch (err) {
      useTodoStore.getState().setError(String(err));
    }
  };

  const remove = async () => {
    const ok = await confirmAction({
      title: t("common.delete"),
      body: t("todoDialog.deleteConfirm"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    await useCalendarStore
      .getState()
      .deleteTask(task.id)
      .catch((err) => useTodoStore.getState().setError(String(err)));
    onClose();
  };

  const addTag = () => {
    const value = tagInput.trim();
    if (!value) return;
    const tags = draft.tags ?? [];
    if (!tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      patch({ tags: [...tags, value] });
    }
    setTagInput("");
  };

  // The checklist ops are `lib/todoBoard`'s, shared with the board card's inline
  // checklist — one definition of what an add or a delete does, for two surfaces
  // writing the same field of the same file. The only difference is here: this
  // one stages the result in the draft, the card saves it.
  const addStep = () => {
    const value = stepInput.trim();
    if (!value) return;
    setDraft((d) => addSubtask(d, value));
    setStepInput("");
  };

  const setStep = (id: string, changes: Partial<Subtask>) =>
    setDraft((d) => setSubtask(d, id, changes));

  const steps = draft.subtasks ?? [];
  const stepsDone = steps.filter((s) => s.done).length;

  // The same gesture the board card carries, staged in the draft here rather
  // than written — which is the only difference between the two surfaces.
  const reorder = useListReorder(steps, (id, to) =>
    setDraft((d) => moveSubtask(d, id, to)),
  );

  const stopEscape = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") e.stopPropagation();
  };

  return (
    <>
      <div
        className="modal-backdrop modal-backdrop-elevated"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          ref={modalRef}
          tabIndex={-1}
          className="project-dialog dialog-framed todo-card-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={isNew ? t("todoDialog.titleNew") : t("todoDialog.title")}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onClose();
            }
          }}
        >
          <div className="settings-title-row">
            <h2>{isNew ? t("todoDialog.titleNew") : t("todoDialog.title")}</h2>
            <button
              type="button"
              className="dialog-close-btn"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={onClose}
            >
              ×
            </button>
          </div>

          <div className="todo-card-dialog-body">
            <label className="todo-field">
              <span>{t("todoDialog.titleLabel")}</span>
              <input
                ref={titleInputRef}
                className="cal-input"
                value={draft.title}
                placeholder={isNew ? t("todoBoard.addCardPlaceholder") : undefined}
                onKeyDown={(e) => {
                  stopEscape(e);
                  // Enter on the title is the composer's old one-keystroke add,
                  // kept for the card that needs nothing else.
                  if (e.key === "Enter" && isNew && canSave) {
                    e.preventDefault();
                    void save();
                  }
                }}
                onChange={(e) => patch({ title: e.target.value })}
              />
            </label>

            <label className="todo-field">
              <span>{t("todoDialog.notes")}</span>
              <textarea
                className="cal-input"
                rows={3}
                value={draft.notes ?? ""}
                onKeyDown={stopEscape}
                onChange={(e) => patch({ notes: e.target.value })}
              />
            </label>

            {/* The deadline gets its **own full-width row**, exactly as the
                calendar's event dialog gives Starts/Ends a row — not a half-row
                squeezed beside another field, which left the date and clock too
                narrow to read as the calendar's do. Priority moves to its own row
                below. */}
            <div className="todo-field-row">
              {/* A div, not a label: this field holds several controls (the date,
                  the clock, the time toggle), so a wrapping label would bind its
                  text to only the first and let the toggle's own label nest inside
                  it — invalid. The toggle is its own `.cal-check-row` label. */}
              <div className="todo-field todo-field-due">
                <span>{t("todoDialog.dueDate")}</span>
                {/* Date and time are one deadline. A whole-day card is a date-only
                    `due` and is the default (overdue at midnight); the "Set a time"
                    toggle below reveals the calendar's own clock field to turn it
                    into an hour deadline instead. Clearing the date clears the whole
                    thing — an hour with no day is not a deadline `due` can hold. */}
                <div className="cal-datetime">
                  <input
                    ref={dueInputRef}
                    className="cal-input"
                    type="date"
                    value={dueDate}
                    onPointerDown={() => (dueTypedRef.current = false)}
                    onKeyDown={(e) => {
                      dueTypedRef.current = true;
                      stopEscape(e);
                    }}
                    onChange={(e) => {
                      // Its own field, folded into `due` by the effect above — the
                      // hour is kept across a change of day, and clearing the date
                      // takes the time switch with it (an hour with no day is not a
                      // deadline `due` can hold).
                      setDueDate(e.target.value);
                      if (!e.target.value) setShowTime(false);
                      // A change with no keystroke behind it is the popover
                      // reporting a picked day — and the click that picked it was
                      // swallowed by the widget's own grab, so this is the only
                      // moment the calendar can be told to go away. A *typed* date
                      // must not blur: the value first becomes complete the instant
                      // all three subfields are filled, which is mid-edit as often
                      // as not, and ejecting the keyboard there would make the
                      // field impossible to correct.
                      if (!dueTypedRef.current) e.currentTarget.blur();
                    }}
                  />
                  {/* The hour, entered in the **same** field the calendar's event
                      dialog uses (`common/TimeField`) and bound the **same** way —
                      a plain `value`/`onChange` over its own state, not a string
                      edited in place per keystroke. It draws its own segments so it
                      honours `Settings.time_format_24h`, which the native
                      `<input type="time">` cannot (that reads its 12-vs-24-hour
                      face off the engine locale, so it printed `05:30 PM` under a
                      24-hour setting). Shown only while the toggle is on. */}
                  {showTime ? (
                    <TimeField
                      className="cal-input"
                      title={t("todoDialog.dueTimeTitle")}
                      aria-label={t("todoDialog.dueTime")}
                      value={dueTime}
                      onKeyDown={stopEscape}
                      onChange={setDueTime}
                    />
                  ) : null}
                </div>
                {/* The whole-day-vs-hour switch, the calendar's `.cal-check-row`
                    chrome — always usable, like the calendar's own time fields.
                    Turning it on with no date yet lands on **today**, so an hour
                    always has a day to live on; the field never needs a date to be
                    picked first. */}
                <label className="cal-check-row">
                  <input
                    type="checkbox"
                    checked={showTime}
                    onChange={(e) => {
                      if (e.target.checked && !dueDate) setDueDate(toDateStr(new Date()));
                      setShowTime(e.target.checked);
                    }}
                    onKeyDown={stopEscape}
                  />
                  <span>{t("todoDialog.setTime")}</span>
                </label>
              </div>
            </div>

            <div className="todo-field-row">
              <label className="todo-field">
                <span>{t("todoDialog.priority")}</span>
                <select
                  className="cal-input"
                  value={draft.priority}
                  onChange={(e) => patch({ priority: Number(e.target.value) })}
                >
                  <option value={0}>{t("todoDialog.priorityNone")}</option>
                  <option value={1}>{t("tasksView.priorityHigh")}</option>
                  <option value={5}>{t("tasksView.priorityNormal")}</option>
                  <option value={9}>{t("tasksView.priorityLow")}</option>
                </select>
              </label>
            </div>

            <div className="todo-field-row">
              <label className="todo-field">
                <span>{t("todoDialog.column")}</span>
                <select
                  className="cal-input"
                  value={draft.column || fallbackColumnId(columns)}
                  onChange={(e) => patch({ column: e.target.value, rank: null })}
                >
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="todo-field">
                <span>{t("todoDialog.calendar")}</span>
                <select
                  className="cal-input"
                  value={draft.calendar_id}
                  onChange={(e) => patch({ calendar_id: e.target.value })}
                >
                  {calendars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="todo-field-row">
              <label className="todo-field">
                <span>{t("todoDialog.project")}</span>
                <select
                  className="cal-input"
                  value={draft.project_id ?? ""}
                  onChange={(e) => patch({ project_id: e.target.value })}
                >
                  <option value="">{t("todoDialog.projectNone")}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="todo-field">
                <span>
                  {t("todoDialog.percent")} — {draft.percent}%
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={draft.percent}
                  onChange={(e) => patch({ percent: Number(e.target.value) })}
                />
              </label>
            </div>

            <div className="todo-field">
              <span>{t("todoDialog.tags")}</span>
              <div className="todo-tag-editor">
                {(draft.tags ?? []).map((tag) => (
                  <span key={tag} className="todo-chip todo-chip-tag">
                    #{tag}
                    <button
                      type="button"
                      className="todo-chip-x"
                      aria-label={t("common.remove")}
                      onClick={() =>
                        patch({ tags: (draft.tags ?? []).filter((x) => x !== tag) })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  className="cal-input todo-tag-input"
                  value={tagInput}
                  placeholder={t("todoDialog.tagsPlaceholder")}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    stopEscape(e);
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                />
              </div>
            </div>

            <div className="todo-field">
              <span>
                {t("todoDialog.subtasks")}
                {steps.length > 0 ? ` — ${stepsDone}/${steps.length}` : ""}
              </span>
              <ul className="todo-steps">
                {steps.map((step, i) => (
                  <li
                    key={step.id || i}
                    ref={reorder.rowRef(step.id)}
                    className={
                      "todo-step" +
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
                      checked={step.done}
                      onChange={() => setStep(step.id, { done: !step.done })}
                    />
                    <input
                      className="cal-input"
                      value={step.title}
                      onKeyDown={stopEscape}
                      onChange={(e) => setStep(step.id, { title: e.target.value })}
                    />
                    <button
                      type="button"
                      className="cal-link-btn cal-link-danger"
                      onClick={() => setDraft((d) => removeSubtask(d, step.id))}
                    >
                      {t("common.remove")}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="todo-step-add">
                <input
                  className="cal-input"
                  value={stepInput}
                  placeholder={t("todoDialog.subtaskPlaceholder")}
                  onChange={(e) => setStepInput(e.target.value)}
                  onKeyDown={(e) => {
                    stopEscape(e);
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addStep();
                    }
                  }}
                />
                <button type="button" className="cal-btn" onClick={addStep}>
                  {t("todoDialog.addSubtask")}
                </button>
                {steps.length > 0 && (
                  <button
                    type="button"
                    className="cal-link-btn"
                    onClick={() =>
                      patch({ percent: Math.round((stepsDone / steps.length) * 100) })
                    }
                  >
                    {t("todoDialog.percentFromChecklist")}
                  </button>
                )}
              </div>
            </div>

            {/* The appointment half of the conversion, rendered exactly as the mail
                half is: what it was, and the two things that can be done about it.
                "Open" is the calendar overlay rather than a jump to the day — the
                calendar store has no per-date target to aim at — so it is offered
                only where `CalendarOverlayHost` would actually raise something, the
                agenda rail's rule. */}
            {draft.event && (
              <div className="todo-field todo-mail-link">
                <span>{t("todoDialog.linkedEvent")}</span>
                <div className="todo-mail-link-body">
                  <div className="todo-mail-link-subject">
                    {draft.event.title || t("calendar.untitled")}
                  </div>
                  <div className="todo-mail-link-from">
                    {[
                      draft.event.occurrence_start
                        ? `${datePart(draft.event.occurrence_start)} ${formatTime(
                            timePart(draft.event.occurrence_start),
                            use24h,
                          )}`
                        : "",
                      draft.event.location ?? "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <div className="todo-mail-link-actions">
                    {calendarApp && (
                      <button
                        type="button"
                        className="cal-link-btn"
                        onClick={() => {
                          onClose();
                          useTodoStore.getState().closeOverlay();
                          useCalendarStore.getState().openOverlay();
                        }}
                      >
                        {t("todoAgenda.openCalendar")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="cal-link-btn cal-link-danger"
                      onClick={() => patch({ event: null })}
                    >
                      {t("todoDialog.unlinkEvent")}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {draft.mail && (
              <div className="todo-field todo-mail-link">
                <span>{t("todoDialog.linkedMail")}</span>
                <div className="todo-mail-link-body">
                  <div className="todo-mail-link-subject">
                    {draft.mail.subject || t("mail.noSubject")}
                  </div>
                  <div className="todo-mail-link-from">{draft.mail.from}</div>
                  <div className="todo-mail-link-actions">
                    <button
                      type="button"
                      className="cal-link-btn"
                      disabled={!mailClient}
                      title={mailClient ? undefined : t("todoMail.disabled")}
                      onClick={() => onOpenMail(draft)}
                    >
                      {t("todoDialog.linkedMailOpen")}
                    </button>
                    <button
                      type="button"
                      className="cal-link-btn cal-link-danger"
                      onClick={() => patch({ mail: null })}
                    >
                      {t("todoDialog.unlinkMail")}
                    </button>
                  </div>
                  {mailClient && (
                    <label className="todo-mail-clear">
                      <input
                        type="checkbox"
                        checked={clearMark}
                        onChange={(e) => setClearMark(e.target.checked)}
                      />
                      {t("todoDialog.clearMailMark")}
                    </label>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="todo-card-dialog-actions">
            {/* No Delete on a card that was never written: Cancel already discards
                it, and a delete offered beside it would be the same act twice. */}
            {!isNew && (
              <button
                type="button"
                className="cal-link-btn cal-link-danger"
                onClick={() => void remove()}
              >
                {t("common.delete")}
              </button>
            )}
            <span className="todo-spacer" />
            <button type="button" className="cal-btn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="cal-btn cal-btn-primary"
              disabled={!canSave}
              title={canSave ? undefined : t("todoDialog.titleRequired")}
              onClick={() => void save()}
            >
              {isNew ? t("common.add") : t("common.save")}
            </button>
          </div>
        </div>
      </div>
      {dialogs}
    </>
  );
}
