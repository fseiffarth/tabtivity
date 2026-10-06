import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  Alarm,
  Calendar,
  CalendarEvent,
  EventStatus,
  Freq,
  NthWeekday,
  Occurrence,
  Rrule,
} from "../../types";
import { CATEGORIES, categoryLabel } from "../../lib/calendar/calendarCategories";
import {
  addMinutes,
  allDayEndToLastDay,
  datePart,
  daysInMonth,
  lastDayToAllDayEnd,
  minutesBetween,
  parseStamp,
  timePart,
  weekdayLabel,
  weekdayOf,
} from "../../lib/calendar/calendarTime";
import { conferenceLink, isJoinableUrl } from "../../lib/calendar/conference";
import { joinConference } from "../../lib/linkTarget";
import { sameRule } from "../../lib/calendar/ics";
import { describeNthWeekdays, describeRrule } from "../../lib/calendar/recurrence";
import { useI18nStore, useT, type TranslationKey } from "../../lib/i18n";
import { DateField } from "../common/DateField";
import { TimeField } from "../common/TimeField";
import { UntestedTag } from "../common/UntestedTag";

/** The reminder offsets the dropdown offers, in minutes before the start. */
const REMINDER_CHOICE_KEYS: { labelKey: TranslationKey; minutes: number }[] = [
  { labelKey: "eventDialog.reminderAtTime", minutes: 0 },
  { labelKey: "eventDialog.reminder5", minutes: 5 },
  { labelKey: "eventDialog.reminder15", minutes: 15 },
  { labelKey: "eventDialog.reminder30", minutes: 30 },
  { labelKey: "eventDialog.reminder1h", minutes: 60 },
  { labelKey: "eventDialog.reminder1day", minutes: 1440 },
];

/** What the dialog was opened on. */
export interface EventDialogTarget {
  /** The stored event, or null when creating. */
  event: CalendarEvent | null;
  /** The occurrence clicked, when editing one instance of a series. */
  occurrence: Occurrence | null;
  /** Prefilled span for a new event (from a drag or a day double-click). */
  draftStart?: string;
  draftEnd?: string;
  draftAllDay?: boolean;
  /** Prefilled title/location for a new event extracted from elsewhere — the mail
   *  assistant's calendar extraction (#207) seeds these so a message becomes an
   *  event with one confirming click. Ignored when editing an existing event. */
  draftTitle?: string;
  draftLocation?: string;
  /** Prefilled notes — the mail extraction seeds a provenance line here so the
   *  created event records what it came from. */
  draftNotes?: string;
}

/** How an edit to a recurring event should apply. */
export type EditScope = "this" | "all";

interface Props {
  target: EventDialogTarget;
  calendars: Calendar[];
  defaultCalendarId: string;
  defaultReminderMinutes: number;
  onClose: () => void;
  /** Save. `scope` is meaningful only for a recurring event. */
  onSave: (event: CalendarEvent, scope: EditScope) => Promise<void> | void;
  onDelete: (event: CalendarEvent, scope: EditScope) => Promise<void> | void;
}

/** The dialog's editable form state. */
interface Form {
  calendarId: string;
  title: string;
  location: string;
  notes: string;
  /** The video call's join URL — see `lib/calendar/conference.ts`. */
  conference: string;
  category: string;
  status: EventStatus;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  repeats: boolean;
  freq: Freq;
  interval: number;
  byweekday: number[];
  /**
   * Monthly/yearly: repeat on the start's day of month (`"day"`), on its
   * numbered weekday (`"nth"`, the 3rd Thursday) or on the last such weekday.
   */
  repeatOn: RepeatOn;
  /** The start date the form opened with — while it stands, the rule's own
   *  day/weekday choices are kept rather than re-derived from the start. */
  initialStartDate: string;
  /** `""` = forever, `"count"`, or `"until"`. */
  endMode: "" | "count" | "until";
  count: number;
  until: string;
  alarms: Alarm[];
}

type RepeatOn = "day" | "nth" | "last";

/** How long a new event runs once its start is moved, until its end is set by hand. */
const DEFAULT_EVENT_MINUTES = 60;

/** Seed the form from the event/occurrence being edited, or from a new draft. */
function initialForm(
  target: EventDialogTarget,
  defaultCalendarId: string,
  defaultReminderMinutes: number,
): Form {
  const { event, occurrence } = target;

  // When editing one occurrence of a series, the form shows THAT occurrence's
  // times — not the master's — since that is what the user clicked on.
  const start = occurrence?.start ?? event?.start ?? target.draftStart ?? "";
  const end = occurrence?.end ?? event?.end ?? target.draftEnd ?? "";
  const allDay = occurrence?.allDay ?? event?.all_day ?? target.draftAllDay ?? false;
  const rrule = event?.rrule ?? null;

  return {
    calendarId: event?.calendar_id ?? defaultCalendarId,
    title: occurrence?.title ?? event?.title ?? target.draftTitle ?? "",
    location: occurrence?.location ?? event?.location ?? target.draftLocation ?? "",
    notes: occurrence?.notes ?? event?.notes ?? target.draftNotes ?? "",
    // The master's, never an occurrence's: a series has one call, and the
    // override record has no field for a second one.
    conference: event?.conference ?? "",
    category: event?.category ?? "",
    status: (event?.status || "confirmed") as EventStatus,
    allDay,
    startDate: datePart(start),
    startTime: timePart(start) || "09:00",
    // An all-day event's end is exclusive on disk; the picker shows the LAST day,
    // which is what a user means by "ends on".
    endDate: allDay ? allDayEndToLastDay(end) : datePart(end),
    endTime: timePart(end) || "10:00",
    repeats: !!rrule,
    freq: rrule?.freq ?? "weekly",
    interval: rrule?.interval ?? 1,
    byweekday: rrule?.byweekday ?? [],
    repeatOn: rrule?.bynthweekday?.length
      ? rrule.bynthweekday.every((e) => e.n < 0) ? "last" : "nth"
      : "day",
    initialStartDate: datePart(start),
    endMode: rrule?.count ? "count" : rrule?.until ? "until" : "",
    count: rrule?.count ?? 10,
    until: rrule?.until ?? "",
    alarms:
      event?.alarms ??
      (defaultReminderMinutes > 0 && !event
        ? [{ minutes_before: defaultReminderMinutes }]
        : []),
  };
}

/** How long after opening a backdrop press is still the tail of a double-click. */
const DOUBLE_CLICK_GRACE_MS = 500;

/**
 * The event editor.
 *
 * Reuses the app's canonical dialog shell (`.modal-backdrop` > `.settings-dialog`
 * with an accent `.settings-title-row` header and divider), so it reads
 * identically to every other modal. Being portaled, it sets its text color
 * explicitly — `body` carries none, so an inherited color would render black.
 *
 * Editing an occurrence of a recurring event asks the "this one / the whole
 * series" question on save, exactly once, rather than up front — most edits are
 * to a single occurrence and the prompt would otherwise be pure friction.
 */
export function EventDialog({
  target,
  calendars,
  defaultCalendarId,
  defaultReminderMinutes,
  onClose,
  onSave,
  onDelete,
}: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const [form, setForm] = useState<Form>(() =>
    initialForm(target, defaultCalendarId, defaultReminderMinutes),
  );
  /** Set when a recurring event needs its scope confirmed; holds the pending act. */
  const [scopeAsk, setScopeAsk] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set once the end is edited by hand; until then a new event's end follows its start. */
  const [endTouched, setEndTouched] = useState(false);

  const creating = target.event === null;
  const recurring = !!target.event?.rrule;

  /** When the dialog opened. A single click opens an event now, so a habitual
   *  double-click lands its second press on the backdrop — which must not
   *  close the dialog it just opened. */
  const openedAt = useRef(performance.now());

  // Re-seed on the TARGET only. The other two are seeds, not inputs: settings
  // load after the pane mounts (and a background CalDAV sync can add a calendar),
  // so listing them here re-ran `initialForm` over a form somebody was typing in
  // and threw the draft away mid-edit.
  useEffect(() => {
    setForm(initialForm(target, defaultCalendarId, defaultReminderMinutes));
    setScopeAsk(null);
    setError(null);
    setEndTouched(false);
    openedAt.current = performance.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const patch = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));

  // A new event defaults to one hour: moving its start carries the end along,
  // an hour later. Once the end is set by hand, the start no longer moves it.
  const patchStart = (p: Partial<Pick<Form, "startDate" | "startTime">>) =>
    setForm((f) => {
      const next = { ...f, ...p };
      if (!creating || endTouched || next.allDay || !next.startDate) return next;
      const end = addMinutes(`${next.startDate}T${next.startTime}`, DEFAULT_EVENT_MINUTES);
      return { ...next, endDate: datePart(end), endTime: timePart(end) };
    });
  const patchEnd = (p: Partial<Pick<Form, "endDate" | "endTime">>) => {
    setEndTouched(true);
    patch(p);
  };

  // The call this event would offer as you type — the field when it holds a
  // usable link, otherwise whatever the location or notes give up. Computed off
  // the *form* rather than the saved event so the Join button and the "detected"
  // hint both track an edit before it is saved.
  const formConference = useMemo(
    () =>
      conferenceLink({
        conference: isJoinableUrl(form.conference) ? form.conference : "",
        location: form.location,
        notes: form.notes,
      }),
    [form.conference, form.location, form.notes],
  );

  const ruleSummary = useMemo(
    () =>
      form.repeats
        ? describeRrule(buildRrule(form, target.event?.rrule ?? null), t, lang, form.startDate)
        : t("recurrence.doesNotRepeat"),
    [form, target.event, t, lang],
  );

  /** The monthly/yearly "repeats on" choices, labelled as the rule each would save. */
  const repeatOnChoices = useMemo(() => {
    const c = parseStamp(form.startDate);
    if (!c || (form.freq !== "monthly" && form.freq !== "yearly")) return [];
    const original = target.event?.rrule ?? null;
    const label = (on: RepeatOn) => {
      const rule = buildRrule({ ...form, repeatOn: on }, original);
      if (on !== "day") return describeNthWeekdays(rule, t, lang, form.startDate);
      if (form.freq === "monthly") {
        return t("recurrence.onDayOfMonth", { day: rule.bymonthday ?? c.day });
      }
      const date = new Date(Date.UTC(2023, c.month - 1, c.day)).toLocaleDateString(lang, {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      });
      return t("recurrence.onDate", { date });
    };
    // "The 5th Thursday" only exists in some months, and in those it IS the
    // last — offer "last" there, and "nth" only for the 1st to 4th. Whatever
    // the rule already says stays on the list.
    const choices: RepeatOn[] = ["day"];
    if (Math.ceil(c.day / 7) <= 4 || form.repeatOn === "nth") choices.push("nth");
    if (c.day + 7 > daysInMonth(c.year, c.month) || form.repeatOn === "last") choices.push("last");
    return choices.map((on) => ({ on, label: label(on) }));
  }, [form, target.event, t, lang]);

  /** The form, back as a stored event. */
  function toEvent(): CalendarEvent | null {
    const title = form.title.trim();
    if (!title) {
      setError(t("eventDialog.errTitleRequired"));
      return null;
    }
    if (!form.startDate) {
      setError(t("eventDialog.errStartRequired"));
      return null;
    }

    const start = form.allDay ? form.startDate : `${form.startDate}T${form.startTime}`;
    const endDay = form.endDate || form.startDate;
    const end = form.allDay
      ? lastDayToAllDayEnd(endDay)
      : `${endDay}T${form.endTime}`;

    if (!form.allDay && minutesBetween(start, end) <= 0) {
      setError(t("eventDialog.errEndAfterStart"));
      return null;
    }
    if (form.allDay && lastDayToAllDayEnd(endDay) <= form.startDate) {
      setError(t("eventDialog.errEndOnOrAfterStart"));
      return null;
    }

    const base = target.event;
    return {
      // What the form does not edit rides along: a synced row's `caldav_href`,
      // `caldav_etag` and `uid` above all. Without them every save pushed the
      // event to its server as a brand-new appointment beside the old one.
      ...base,
      id: base?.id ?? "",
      calendar_id: form.calendarId,
      start,
      end,
      all_day: form.allDay,
      title,
      location: form.location.trim(),
      notes: form.notes.trim(),
      conference: form.conference.trim(),
      category: form.category,
      status: form.status,
      rrule: form.repeats ? buildRrule(form, base?.rrule ?? null) : null,
      // Exdates/overrides belong to the series and must survive an edit to it.
      exdates: base?.exdates ?? [],
      overrides: base?.overrides ?? [],
      alarms: form.alarms,
    };
  }

  function attemptSave() {
    setError(null);
    const event = toEvent();
    if (!event) return;
    // Editing one occurrence of a series → ask which it applies to.
    if (recurring && target.occurrence) {
      setScopeAsk("save");
      return;
    }
    void onSave(event, "all");
  }

  function attemptDelete() {
    if (!target.event) return;
    if (recurring && target.occurrence) {
      setScopeAsk("delete");
      return;
    }
    void onDelete(target.event, "all");
  }

  function resolveScope(scope: EditScope) {
    const pending = scopeAsk;
    setScopeAsk(null);
    if (pending === "delete") {
      if (target.event) void onDelete(target.event, scope);
      return;
    }
    const event = toEvent();
    if (event) void onSave(event, scope);
  }

  const toggleWeekday = (d: number) =>
    patch({
      byweekday: form.byweekday.includes(d)
        ? form.byweekday.filter((x) => x !== d)
        : [...form.byweekday, d].sort((a, b) => a - b),
    });

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (performance.now() - openedAt.current > DOUBLE_CLICK_GRACE_MS) onClose();
      }}
    >
      <div
        className="settings-dialog cal-event-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{creating ? t("eventDialog.newEventTitle") : t("eventDialog.editEventTitle")}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="dialog-scroll">
        {scopeAsk ? (
          /* The this-one-or-all question. It replaces the form rather than
             stacking a second modal on top of it — one decision, in place. */
          <div className="cal-scope-ask">
            <p className="settings-help">
              <strong>{form.title || t("eventDialog.thisEventFallback")}</strong> {t("eventDialog.repeatsSuffix")}{" "}
              {scopeAsk === "delete"
                ? t("eventDialog.deleteScopeQuestion")
                : t("eventDialog.saveScopeQuestion")}
            </p>
            <div className="cal-form-actions">
              <button className="cal-btn cal-btn-primary" onClick={() => resolveScope("this")}>
                {scopeAsk === "delete" ? t("eventDialog.deleteThisOccurrence") : t("eventDialog.thisOccurrenceOnly")}
              </button>
              <button className="cal-btn" onClick={() => resolveScope("all")}>
                {scopeAsk === "delete" ? t("eventDialog.deleteWholeSeries") : t("eventDialog.allOccurrences")}
              </button>
              <button className="cal-link-btn" onClick={() => setScopeAsk(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <div className="cal-event-form">
            <label className="cal-field">
              <span className="cal-field-label">{t("eventDialog.titleField")}</span>
              <input
                className="cal-input"
                type="text"
                autoFocus
                value={form.title}
                onChange={(e) => patch({ title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") attemptSave();
                }}
              />
            </label>

            <label className="cal-field">
              <span className="cal-field-label">{t("eventDialog.locationField")}</span>
              <input
                className="cal-input"
                type="text"
                value={form.location}
                onChange={(e) => patch({ location: e.target.value })}
              />
            </label>

            {/* The video call. Its own field rather than a URL in the location,
                so the Join buttons elsewhere (the header's 🗓 dropdown) are
                acting on something the user stated rather than on a guess about
                what a room name meant. The guess still exists — `conferenceLink`
                derives one from the location or the notes for the imported
                invitations that carry it there — and when it fires, this field
                says so instead of silently filling itself in: writing a
                derivation into the user's data would freeze it, and there would
                be no way left to tell the two apart. */}
            <label className="cal-field">
              <span className="cal-field-label">{t("eventDialog.conferenceField")}</span>
              <div className="cal-conference-row">
                <input
                  className="cal-input"
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  value={form.conference}
                  onChange={(e) => patch({ conference: e.target.value })}
                />
                {/* Enabled only for something that can actually be handed to a
                    browser: a half-typed link is the normal state of this field
                    while it is being filled in, and a Join that refuses is worse
                    than one that is visibly not ready yet. */}
                <button
                  type="button"
                  className="cal-link-btn cal-conference-join"
                  disabled={!formConference}
                  title={
                    formConference
                      ? t("calendar.joinTitle", { provider: formConference.provider })
                      : undefined
                  }
                  onClick={() => {
                    if (formConference) joinConference(formConference.url);
                  }}
                >
                  {t("calendar.join")}
                </button>
              </div>
              {formConference && formConference.source !== "field" && (
                <span className="cal-field-hint">
                  {t("eventDialog.conferenceDetected", {
                    provider: formConference.provider,
                  })}
                </span>
              )}
            </label>

            <label className="cal-check-row">
              <input
                type="checkbox"
                checked={form.allDay}
                onChange={(e) => patch({ allDay: e.target.checked })}
              />
              <span>{t("calendar.allDay")}</span>
            </label>

            <div className="cal-field-row">
              <div className="cal-field" role="group" aria-label={t("eventDialog.startsField")}>
                <span className="cal-field-label">{t("eventDialog.startsField")}</span>
                <div className="cal-datetime">
                  <DateField
                    className="cal-input"
                    value={form.startDate}
                    aria-label={t("dateTime.date")}
                    onChange={(startDate) => patchStart({ startDate })}
                  />
                  {!form.allDay ? (
                    <TimeField
                      className="cal-input"
                      value={form.startTime}
                      aria-label={t("dateTime.time")}
                      onChange={(startTime) => patchStart({ startTime })}
                    />
                  ) : null}
                </div>
              </div>

              <div className="cal-field" role="group" aria-label={t("eventDialog.endsField")}>
                <span className="cal-field-label">{t("eventDialog.endsField")}</span>
                <div className="cal-datetime">
                  <DateField
                    className="cal-input"
                    value={form.endDate}
                    aria-label={t("dateTime.date")}
                    onChange={(endDate) => patchEnd({ endDate })}
                  />
                  {!form.allDay ? (
                    <TimeField
                      className="cal-input"
                      value={form.endTime}
                      aria-label={t("dateTime.time")}
                      onChange={(endTime) => patchEnd({ endTime })}
                    />
                  ) : null}
                </div>
              </div>
            </div>

            <div className="cal-field-row">
              <label className="cal-field">
                <span className="cal-field-label">{t("eventDialog.calendarField")}</span>
                <select
                  className="cal-input"
                  value={form.calendarId}
                  onChange={(e) => patch({ calendarId: e.target.value })}
                >
                  {calendars.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>

              <label className="cal-field">
                <span className="cal-field-label">{t("eventDialog.categoryField")}</span>
                <select
                  className="cal-input"
                  value={form.category}
                  onChange={(e) => patch({ category: e.target.value })}
                >
                  <option value="">{t("eventDialog.noCategoryOption")}</option>
                  {CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>{categoryLabel(c, t)}</option>
                  ))}
                </select>
              </label>

              <label className="cal-field">
                <span className="cal-field-label">{t("eventDialog.statusField")}</span>
                <select
                  className="cal-input"
                  value={form.status}
                  onChange={(e) => patch({ status: e.target.value as EventStatus })}
                >
                  <option value="confirmed">{t("eventDialog.statusConfirmed")}</option>
                  <option value="tentative">{t("eventDialog.statusTentative")}</option>
                  <option value="cancelled">{t("eventDialog.statusCancelled")}</option>
                </select>
              </label>
            </div>

            {/* ── Repeat ─────────────────────────────────────────────────── */}
            <div className="cal-section">
              <label className="cal-check-row">
                <input
                  type="checkbox"
                  checked={form.repeats}
                  onChange={(e) => patch({ repeats: e.target.checked })}
                />
                <span>{t("eventDialog.repeatCheckbox")}</span>
                <span className="cal-rule-summary">{ruleSummary}</span>
              </label>

              {form.repeats ? (
                <div className="cal-repeat">
                  <div className="cal-field-row">
                    <label className="cal-field">
                      <span className="cal-field-label">{t("eventDialog.everyField")}</span>
                      <input
                        className="cal-input cal-input-num"
                        type="number"
                        min={1}
                        value={form.interval}
                        onChange={(e) =>
                          patch({ interval: Math.max(1, Number(e.target.value) || 1) })
                        }
                      />
                    </label>
                    <label className="cal-field">
                      <span className="cal-field-label">&nbsp;</span>
                      <select
                        className="cal-input"
                        value={form.freq}
                        onChange={(e) => patch({ freq: e.target.value as Freq })}
                      >
                        <option value="daily">{t("eventDialog.freqDays")}</option>
                        <option value="weekly">{t("eventDialog.freqWeeks")}</option>
                        <option value="monthly">{t("eventDialog.freqMonths")}</option>
                        <option value="yearly">{t("eventDialog.freqYears")}</option>
                      </select>
                    </label>
                  </div>

                  {repeatOnChoices.length > 1 ? (
                    <div className="cal-field-row">
                      <label className="cal-field">
                        <span className="cal-field-label">
                          {t("eventDialog.repeatOnField")} <UntestedTag id="eventDialog.repeatOnField" />
                        </span>
                        <select
                          className="cal-input"
                          value={form.repeatOn}
                          onChange={(e) => patch({ repeatOn: e.target.value as RepeatOn })}
                        >
                          {repeatOnChoices.map(({ on, label }) => (
                            <option key={on} value={on}>{label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ) : null}

                  {form.freq === "weekly" ? (
                    <div className="cal-weekdays">
                      {Array.from({ length: 7 }, (_, d) => (
                        <button
                          key={d}
                          type="button"
                          className={`cal-weekday-btn${form.byweekday.includes(d) ? " cal-weekday-on" : ""}`}
                          onClick={() => toggleWeekday(d)}
                          title={weekdayLabel(lang, d, "long")}
                        >
                          {weekdayLabel(lang, d, "narrow")}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <div className="cal-field-row">
                    <label className="cal-field">
                      <span className="cal-field-label">{t("eventDialog.endsField")}</span>
                      <select
                        className="cal-input"
                        value={form.endMode}
                        onChange={(e) =>
                          patch({ endMode: e.target.value as Form["endMode"] })
                        }
                      >
                        <option value="">{t("eventDialog.endNever")}</option>
                        <option value="count">{t("eventDialog.endAfterCount")}</option>
                        <option value="until">{t("eventDialog.endOnDate")}</option>
                      </select>
                    </label>

                    {form.endMode === "count" ? (
                      <label className="cal-field">
                        <span className="cal-field-label">{t("eventDialog.timesField")}</span>
                        <input
                          className="cal-input cal-input-num"
                          type="number"
                          min={1}
                          value={form.count}
                          onChange={(e) =>
                            patch({ count: Math.max(1, Number(e.target.value) || 1) })
                          }
                        />
                      </label>
                    ) : null}

                    {form.endMode === "until" ? (
                      <div className="cal-field">
                        <span className="cal-field-label">{t("eventDialog.untilField")}</span>
                        <DateField
                          className="cal-input"
                          value={form.until}
                          min={form.startDate || undefined}
                          aria-label={t("eventDialog.untilField")}
                          onChange={(until) => patch({ until })}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            {/* ── Reminders ──────────────────────────────────────────────── */}
            <div className="cal-section">
              <div className="cal-section-head">
                <span className="cal-field-label">{t("eventDialog.remindersLabel")}</span>
                <button
                  type="button"
                  className="cal-link-btn"
                  onClick={() => patch({ alarms: [...form.alarms, { minutes_before: 15 }] })}
                >
                  {t("eventDialog.addReminderButton")}
                </button>
              </div>

              {form.alarms.length === 0 ? (
                <div className="cal-hint">{t("eventDialog.noRemindersHint")}</div>
              ) : (
                form.alarms.map((alarm, i) => (
                  <div key={i} className="cal-alarm-row">
                    <select
                      className="cal-input"
                      value={alarm.minutes_before}
                      onChange={(e) => {
                        const alarms = [...form.alarms];
                        alarms[i] = { minutes_before: Number(e.target.value) };
                        patch({ alarms });
                      }}
                    >
                      {REMINDER_CHOICE_KEYS.map((c) => (
                        <option key={c.minutes} value={c.minutes}>{t(c.labelKey)}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="cal-link-btn cal-link-danger"
                      onClick={() => patch({ alarms: form.alarms.filter((_, j) => j !== i) })}
                    >
                      {t("common.remove")}
                    </button>
                  </div>
                ))
              )}
            </div>

            <label className="cal-field">
              <span className="cal-field-label">{t("eventDialog.notesField")}</span>
              <textarea
                className="cal-input cal-textarea"
                value={form.notes}
                onChange={(e) => patch({ notes: e.target.value })}
              />
            </label>

            {error ? <div className="cal-error">{error}</div> : null}

            <div className="cal-form-actions">
              <button className="cal-btn cal-btn-primary" onClick={attemptSave}>
                {t("common.save")}
              </button>
              {!creating ? (
                <button className="cal-btn cal-btn-danger" onClick={attemptDelete}>
                  {t("common.delete")}
                </button>
              ) : null}
              <button className="cal-link-btn" onClick={onClose}>{t("common.cancel")}</button>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The form's repeat fields, as a stored rule.
 *
 * A monthly/yearly rule's day comes from the start date — "the 3rd Thursday" is
 * the start's own weekday and week — except while the start is still the one
 * the dialog opened with: then the rule's own choice stands, so a rule the form
 * cannot draw (the 1st AND 3rd Monday, the 15th of a series starting on the
 * 12th) survives a save that did not touch it. A rule that comes out saying
 * what `original` said IS `original`, imported RRULE text and all.
 */
function buildRrule(form: Form, original: Rrule | null): Rrule {
  const byMonthOrYear = form.freq === "monthly" || form.freq === "yearly";
  const repeatOn: RepeatOn = byMonthOrYear ? form.repeatOn : "day";
  const keep = original !== null && original.freq === form.freq && form.startDate === form.initialStartDate;

  let bynthweekday: NthWeekday[] = [];
  let bymonthday: number | null = null;
  if (repeatOn === "day") {
    if (form.freq === "monthly" && keep && !original.bynthweekday?.length) {
      bymonthday = original.bymonthday ?? null;
    }
  } else {
    const originalOn = original?.bynthweekday?.length
      ? original.bynthweekday.every((e) => e.n < 0) ? "last" : "nth"
      : "day";
    if (keep && originalOn === repeatOn) {
      bynthweekday = original.bynthweekday ?? [];
    } else {
      const c = parseStamp(form.startDate);
      bynthweekday = c
        ? [{ n: repeatOn === "last" ? -1 : Math.ceil(c.day / 7), day: weekdayOf(form.startDate) }]
        : [];
    }
  }

  const rule: Rrule = {
    freq: form.freq,
    interval: Math.max(1, form.interval),
    byweekday: form.freq === "weekly" ? form.byweekday : [],
    bymonthday,
    until: form.endMode === "until" && form.until ? form.until : null,
    count: form.endMode === "count" ? Math.max(1, form.count) : null,
  };
  if (bynthweekday.length) rule.bynthweekday = bynthweekday;
  return original && sameRule(original, rule) ? original : rule;
}
