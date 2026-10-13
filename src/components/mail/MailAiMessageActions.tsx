import { useState } from "react";

import { EventDialog, type EditScope, type EventDialogTarget } from "../calendar/EventDialog";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import {
  formatAddress,
  mailAiErrorKey,
  mailExtractEvent,
  mailExtractTask,
  mailSummarize,
  useMailAiFeature,
} from "../../lib/mail";
import { boardColumns, fallbackColumnId, taskFromMail } from "../../lib/todoBoard";
import { toDate, toStamp } from "../../lib/calendar/calendarTime";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useMailStore } from "../../stores/mail";
import { useSettingsStore } from "../../stores/settings";
import type { CalendarEvent, EventMailLink } from "../../types";
import type { MailExtractedEvent, MailExtractedTask, MailHeader } from "../../types/mail";
import { ErrorNote } from "../common/ErrorNote";

/**
 * The message pane's **local-model** controls (Group Q #204/#207/#208): summarize
 * this message, pull a calendar event out of it, pull a to-do out of it. Each is
 * on-demand, gated by its own toggle *and* a resolvable loopback mail-role model
 * (`useMailAiFeature`), and each carries an `UntestedTag`.
 *
 * Two invariants shape it:
 *  - **The summary is ephemeral.** It lives in this component's state and is never
 *    persisted — decrypted plaintext to disk is forbidden. Closing the message
 *    (unmounting) discards it.
 *  - **Review before create is the default.** An extracted event prefills the
 *    real `EventDialog` for one confirming click; an extracted to-do is shown in
 *    a small review panel before it becomes a card. Only the account's
 *    `ai.auto_create` toggle skips the review step.
 */
export function MailAiMessageActions({ header }: { header: MailHeader }) {
  const t = useT();

  // The Mail AI toggles are per account now, so the gate reads the account this
  // message belongs to — `header.account_id` — from the mail store.
  const account = useMailStore((s) => s.accounts.find((a) => a.id === header.account_id));
  const canSummarize = useMailAiFeature(account, "summarize");
  const canEvent = useMailAiFeature(account, "calendar");
  const canTask = useMailAiFeature(account, "todo");
  const autoCreate = account?.ai?.auto_create === true;
  const defaultReminder = useSettingsStore(
    (s) => s.settings?.calendar_default_reminder_minutes ?? 0,
  );

  const calendars = useCalendarStore((s) => s.calendars);
  const storedColumns = useCalendarStore((s) => s.taskColumns);
  const createEvent = useCalendarStore((s) => s.createEvent);
  const createTask = useCalendarStore((s) => s.createTask);

  const defaultCalendarId = calendars[0]?.id ?? "default";
  const intakeColumnId = fallbackColumnId(boardColumns(storedColumns));

  // #204 — the ephemeral summary.
  const [summary, setSummary] = useState<string[] | null>(null);
  const [summarizing, setSummarizing] = useState(false);

  // #207 — the extracted event, held until the dialog confirms it.
  const [eventTarget, setEventTarget] = useState<EventDialogTarget | null>(null);
  const [eventBusy, setEventBusy] = useState(false);

  // #208 — the extracted to-do, held for review.
  const [taskDraft, setTaskDraft] = useState<MailExtractedTask | null>(null);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskAdded, setTaskAdded] = useState(false);

  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  // The provenance every event made here carries (decision E3): the root
  // agent's tools then serve it as someone else's text, URLs removed.
  const fromMail: EventMailLink = { message_id: header.id, account_id: header.account_id };

  const senderLine = (() => {
    const s = formatAddress(header.from);
    return s;
  })();

  const showError = (err: unknown) => {
    const key = mailAiErrorKey(err);
    setError(key ? t(key) : typeof err === "string" ? err : String(err));
  };

  const clearTransient = () => {
    setNote("");
    setError("");
  };

  const doSummarize = async () => {
    clearTransient();
    setSummarizing(true);
    setSummary(null);
    try {
      const text = await mailSummarize(header.id);
      setSummary(toBullets(text));
    } catch (err) {
      showError(err);
    } finally {
      setSummarizing(false);
    }
  };

  const eventDraftTargetFrom = (ev: MailExtractedEvent): EventDialogTarget => ({
    event: null,
    occurrence: null,
    draftStart: ev.start,
    draftEnd: ev.end ?? undefined,
    draftAllDay: ev.all_day,
    draftTitle: ev.title,
    draftLocation: ev.location ?? undefined,
    draftNotes: senderLine,
  });

  const doExtractEvent = async () => {
    clearTransient();
    setEventBusy(true);
    try {
      const ev = await mailExtractEvent(header.id);
      if (!ev) {
        setNote(t("mailAi.noEventFound"));
        return;
      }
      if (autoCreate) {
        // No review step: write the event directly, tagged with its provenance
        // and trivially deletable like any other. A missing end gets a sensible
        // default (all-day → same day; timed → one hour) rather than a
        // zero-duration event, since there is no dialog here to fix it.
        const draft: Omit<CalendarEvent, "id"> = {
          calendar_id: defaultCalendarId,
          start: ev.start,
          end: ev.end ?? defaultEventEnd(ev.start, ev.all_day),
          all_day: ev.all_day,
          title: ev.title,
          location: ev.location ?? undefined,
          notes: senderLine,
          from_mail: fromMail,
        };
        await createEvent(draft);
        setNote(t("mailAi.taskAdded"));
        return;
      }
      setEventTarget(eventDraftTargetFrom(ev));
    } catch (err) {
      showError(err);
    } finally {
      setEventBusy(false);
    }
  };

  const buildCard = (extracted: MailExtractedTask) => {
    // Reuse `taskFromMail` so an AI card is the same kind of card as a hand-made
    // one (board's first column, the mail link, the provenance note), then apply
    // the model's own title/due/priority on top.
    const base = taskFromMail(
      header,
      { calendarId: defaultCalendarId, columnId: intakeColumnId, now: new Date() },
      t("mail.noSubject"),
    );
    const priority = mapTaskPriority(extracted.priority) ?? base.priority;
    return {
      ...base,
      title: extracted.title || base.title,
      due: extracted.due ?? base.due,
      priority,
    };
  };

  const doExtractTask = async () => {
    clearTransient();
    setTaskAdded(false);
    setTaskDraft(null);
    setTaskBusy(true);
    try {
      const task = await mailExtractTask(header.id);
      if (!task) {
        setNote(t("mailAi.noTaskFound"));
        return;
      }
      if (autoCreate) {
        await createTask(buildCard(task));
        setNote(t("mailAi.taskAdded"));
        return;
      }
      setTaskDraft(task);
    } catch (err) {
      showError(err);
    } finally {
      setTaskBusy(false);
    }
  };

  const confirmTask = async () => {
    if (!taskDraft) return;
    try {
      await createTask(buildCard(taskDraft));
      setTaskDraft(null);
      setTaskAdded(true);
    } catch (err) {
      showError(err);
    }
  };

  const saveEvent = async (event: CalendarEvent, _scope: EditScope) => {
    // Creating only — the extraction always seeds a new event.
    const { id: _id, ...draft } = event;
    void _id;
    void _scope;
    await createEvent({ ...draft, from_mail: fromMail });
    setEventTarget(null);
    setNote(t("mailAi.taskAdded"));
  };

  if (!canSummarize && !canEvent && !canTask) return null;

  return (
    <div className="mail-ai-actions">
      <div className="mail-ai-actions-row">
        {canSummarize && (
          <button
            type="button"
            className="settings-btn"
            disabled={summarizing}
            onClick={() => void doSummarize()}
          >
            {summarizing ? t("mailAi.summarizing") : t("mailAi.summarize")}
          </button>
        )}
        {canEvent && (
          <button
            type="button"
            className="settings-btn"
            disabled={eventBusy}
            onClick={() => void doExtractEvent()}
          >
            {eventBusy ? t("mailAi.extractingEvent") : t("mailAi.extractEvent")}
          </button>
        )}
        {canTask && (
          <button
            type="button"
            className="settings-btn"
            disabled={taskBusy}
            onClick={() => void doExtractTask()}
          >
            {taskBusy ? t("mailAi.extractingTask") : t("mailAi.extractTask")}
          </button>
        )}
        <UntestedTag id="mailAiMessageActions.1" />
      </div>

      {note && <div className="mail-note">{note}</div>}
      {error && <ErrorNote className="project-dialog-error" error={error} />}

      {summary && (
        <div className="mail-ai-summary">
          <div className="mail-ai-summary-head">
            <span className="mail-meta-label">{t("mailAi.summaryTitle")}</span>
            <button
              type="button"
              className="mail-ai-summary-close"
              title={t("mailAi.summaryHide")}
              aria-label={t("mailAi.summaryHide")}
              onClick={() => setSummary(null)}
            >
              ×
            </button>
          </div>
          <ul className="mail-ai-summary-list">
            {summary.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <p className="settings-help">{t("mailAi.summaryEphemeral")}</p>
        </div>
      )}

      {taskDraft && (
        <div className="mail-ai-task-review">
          <strong>{t("mailAi.taskReviewTitle")}</strong>
          <div className="mail-ai-task-title">{taskDraft.title}</div>
          <div className="settings-help">
            {taskDraft.due ? t("mailAi.taskDue", { date: taskDraft.due }) : t("mailAi.taskNoDue")}
          </div>
          <div className="mail-ai-task-actions">
            <button type="button" className="settings-btn" onClick={() => setTaskDraft(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="settings-btn primary"
              onClick={() => void confirmTask()}
            >
              {t("mailAi.taskAdd")}
            </button>
          </div>
        </div>
      )}
      {taskAdded && <div className="mail-note">{t("mailAi.taskAdded")}</div>}

      {eventTarget && (
        <EventDialog
          target={eventTarget}
          calendars={calendars}
          defaultCalendarId={defaultCalendarId}
          defaultReminderMinutes={defaultReminder}
          onClose={() => setEventTarget(null)}
          onSave={saveEvent}
          onDelete={() => setEventTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * The read-only provenance line (Group Q #205): who set this message's priority
 * mark. A model classifier must not pass for a keyword rule the user wrote, so
 * the source is stated plainly — "Marked Urgent by the local model: '…'".
 * Renders nothing when there is no mark or no recorded source.
 */
export function MailAiProvenance({ header }: { header: MailHeader }) {
  const t = useT();
  const source = header.priority_source;
  if (!header.priority || !source) return null;

  const priority =
    header.priority === "urgent" ? t("mailAi.priorityUrgent") : t("mailAi.priorityImportant");
  const lead =
    source === "model"
      ? t("mailAi.markedByModel", { priority })
      : source === "filter"
        ? t("mailAi.markedByFilter", { priority })
        : t("mailAi.markedByUser", { priority });
  const reason = source === "user" ? "" : (header.priority_reason ?? "").trim();

  return (
    <div className={`mail-ai-provenance mail-ai-provenance-${source}`}>
      <span className="mail-ai-provenance-lead">{lead}</span>
      {reason && <span className="mail-ai-provenance-reason">{reason}</span>}
    </div>
  );
}

/** Split the model's plain-text summary into bullet lines, stripping any leading
 *  bullet glyph or dash the model may have added itself. Blank lines are dropped. */
function toBullets(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•·]\s*/, "").trim())
    .filter((l) => l.length > 0);
}

/** A sensible end for an auto-created event whose extraction gave none: the same
 *  day for an all-day event, else one hour after the start. Never zero-length,
 *  because the auto-create path has no dialog to correct it. */
function defaultEventEnd(start: string, allDay: boolean): string {
  if (allDay) return start;
  const d = toDate(start);
  if (Number.isNaN(d.getTime())) return start;
  d.setMinutes(d.getMinutes() + 60);
  return toStamp(d);
}

/** The model's priority word → the board's numeric priority, or `undefined` to
 *  keep the base card's. Accepts the board vocabulary the extraction emits. */
function mapTaskPriority(p?: string | null): number | undefined {
  switch ((p ?? "").toLowerCase()) {
    case "high":
    case "urgent":
      return 1;
    case "normal":
    case "medium":
      return 5;
    case "low":
      return 9;
    default:
      return undefined;
  }
}
