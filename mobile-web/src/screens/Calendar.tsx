import { useCallback, useEffect, useMemo, useState } from "react";
import { api, reloadIfApplied, wasApplied, type CalendarAction, type MobileCalendar, type MobileCalendarEvent, type MobileCalendarEventInput, type MobileCalendarInfo } from "../api";
import { OptionSheet } from "../components/OptionSheet";
import { describeFailure } from "../connection";
import { NotificationsSheet } from "../components/NotificationsSheet";
import { useI18nStore, useT, type Language, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/** A destructive act waiting on a second tap: the shared option sheet, with
 * one option, in place of `window.confirm` — the same sheet the composer's
 * choices and the calendar's edits use, so a delete looks like the rest of
 * the phone and cannot be reached by a stray tap. */
type Confirm = { title: string; note: string; label: string; run: () => Promise<void> };

function ConfirmSheet({ confirm, busy, onClose }: { confirm: Confirm; busy: boolean; onClose: () => void }) {
  return <OptionSheet
    title={confirm.title}
    note={{ text: confirm.note }}
    options={[{ key: "confirm", label: confirm.label, current: false }]}
    waiting=""
    busy={busy}
    onPick={() => { void confirm.run().finally(onClose); }}
    onClose={onClose}
  />;
}

const NAMES: TranslationKey[] = ["agentSchedule.sun", "agentSchedule.mon", "agentSchedule.tue", "agentSchedule.wed", "agentSchedule.thu", "agentSchedule.fri", "agentSchedule.sat"];
const today = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; };
const monthOf = (date = today()) => date.slice(0, 7);
const dayId = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (date: string, amount: number) => { const [y, m, d] = date.split("-").map(Number); return dayId(new Date(y, m - 1, d + amount, 12)); };
const addMonths = (month: string, amount: number) => { const [y, m] = month.split("-").map(Number); const d = new Date(y, m - 1 + amount, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const grid = (month: string, weekStart: 0 | 1) => { const [y, m] = month.split("-").map(Number); const first = new Date(y, m - 1, 1, 12); const start = addDays(`${month}-01`, -((first.getDay() - weekStart + 7) % 7)); return Array.from({ length: 42 }, (_, i) => addDays(start, i)); };
const datePart = (stamp: string) => stamp.slice(0, 10);
const eventEnd = (event: MobileCalendarEvent) => event.all_day || event.end.endsWith("T00:00") ? datePart(event.end) : addDays(datePart(event.end), 1);
const happensOn = (event: MobileCalendarEvent, date: string) => date >= datePart(event.start) && date < eventEnd(event);
const dateTitle = (date: string, lang: Language) => new Intl.DateTimeFormat(lang, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${date}T12:00`));

const blankEvent = (date: string, calendars: MobileCalendarInfo[]): MobileCalendarEventInput => ({ calendar_id: calendars.find((c) => !c.readonly)?.id ?? "", start: `${date}T09:00`, end: `${date}T10:00`, all_day: false, title: "", location: "", notes: "", conference: "", category: "", status: "confirmed" });
const inputOf = (event: MobileCalendarEvent, calendarId: string): MobileCalendarEventInput => ({ calendar_id: calendarId, start: event.start, end: event.end, all_day: event.all_day, title: event.title, location: event.location ?? "", notes: event.notes ?? "", conference: event.conference ?? "", category: event.category ?? "", status: event.status ?? "confirmed" });

/** The desktop stores an all-day end as the day *after* the last day (iCal's
 * exclusive DTEND), while "Ends" in an editor means the last day itself. These
 * convert between the two, exactly as the desktop dialog does — without them a
 * single-day all-day event was sent with `end == start` and rejected, and a
 * reopened one showed the day after it actually ends. */
export const shownAllDayEnd = (start: string, end: string) => { const last = addDays(datePart(end), -1); return last >= datePart(start) ? last : datePart(start); };
export const storedAllDayEnd = (day: string) => addDays(day, 1);
/** A new event runs an hour by default: the end a start of `stamp` implies,
 * as wall-clock math rolling past midnight, or null for a half-typed stamp. */
export const defaultEnd = (stamp: string) => { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(stamp); if (!m) return null; const total = Number(m[2]) * 60 + Number(m[3]) + 60; return `${addDays(m[1], Math.floor(total / 1440))}T${String(Math.floor((total % 1440) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; };
type Editing = { event?: MobileCalendarEvent; draft: MobileCalendarEventInput } | null;

export function Calendar() {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const [month, setMonth] = useState(monthOf); const [selected, setSelected] = useState(today);
  const [data, setData] = useState<MobileCalendar | null>(null); const [editing, setEditing] = useState<Editing>(null);
  const [manage, setManage] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [reminders, setReminders] = useState(false);
  const load = useCallback(async () => { setBusy(true); setError(""); try { const { calendar } = await api<{ calendar: MobileCalendar }>(`/api/v1/calendar?month=${month}`); setData(calendar); setSelected((d) => d.startsWith(month) ? d : `${month}-01`); } catch (e) { setError(describeFailure(e)); } finally { setBusy(false); } }, [month]);
  useEffect(() => { void load(); }, [load]);
  const mutate = async (action: CalendarAction) => { setBusy(true); setError(""); try { const { calendar } = await reloadIfApplied(api<{ calendar: MobileCalendar }>(`/api/v1/calendar?month=${month}`, { method: "POST", body: JSON.stringify(action) }), () => api<{ calendar: MobileCalendar }>(`/api/v1/calendar?month=${month}`)); setData(calendar); return true; } catch (e) { setError(describeFailure(e)); /* Made on the desktop, only not shown: done, as far as the editor goes. */ return wasApplied(e); } finally { setBusy(false); } };
  const weekStart = data?.week_start ?? 1; const days = useMemo(() => grid(month, weekStart), [month, weekStart]);
  const events = useCallback((date: string) => (data?.events ?? []).filter((event) => happensOn(event, date)), [data]);
  const selectedEvents = useMemo(() => events(selected).sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start.localeCompare(b.start)), [events, selected]);
  const label = useMemo(() => new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" }).format(new Date(`${month}-01T12:00`)), [month, lang]);
  const open = (event: MobileCalendarEvent) => { if (event.calendar_id) setEditing({ event, draft: inputOf(event, event.calendar_id) }); };
  return <main className="screen mobile-calendar-screen">
    <header><h1>{t("mobile.calendar.title")}</h1><button onClick={() => void load()} disabled={busy}>↻</button></header>
    <div className="mobile-calendar-actions"><button className="primary" disabled={busy || !data?.calendars.some((c) => !c.readonly)} onClick={() => setEditing({ draft: blankEvent(selected, data?.calendars ?? []) })}>{t("mobile.calendar.addEvent")}</button><button disabled={busy} onClick={() => setManage(true)}>{t("calendarSidebar.calendarsTitle")}</button><button onClick={() => setReminders(true)}>{t("mobile.push.reminders")}{isUntested("mobile.calendar.push") && <> <span className="untested">{t("mobile.newTab.untested")}</span></>}</button></div>
    {error && <p className="error">{error}</p>}
    {data?.desktop_available === false && <p className="notice">{t("mobile.headless.owner")} {isUntested("mobile.headless.calendar") && <span className="untested">{t("mobile.newTab.untested")}</span>}</p>}
    <div className="mobile-calendar-nav"><button onClick={() => setMonth((m) => addMonths(m, -1))} disabled={busy}>‹</button><strong>{label}</strong><button onClick={() => setMonth((m) => addMonths(m, 1))} disabled={busy}>›</button></div>
    <section className="mobile-calendar-grid" aria-label={label}>{Array.from({ length: 7 }, (_, i) => <span className="mobile-calendar-weekday" key={NAMES[(i + weekStart) % 7]}>{t(NAMES[(i + weekStart) % 7])}</span>)}{days.map((date) => { const rows = events(date); return <button className={`mobile-calendar-day${date.startsWith(month) ? "" : " outside"}${date === selected ? " selected" : ""}${date === today() ? " today" : ""}`} key={date} onClick={() => setSelected(date)}><span>{Number(date.slice(-2))}</span><i className="mobile-calendar-dots">{rows.slice(0, 3).map((event, i) => <b key={`${event.id}-${i}`} style={{ backgroundColor: event.color }} />)}</i></button>; })}</section>
    {data?.truncated && <p className="mobile-calendar-warning">{t("mobile.calendar.truncated")}</p>}
    <section className="mobile-calendar-agenda"><h2>{dateTitle(selected, lang)}</h2>{selectedEvents.length ? selectedEvents.map((event) => <button className={`mobile-calendar-event${event.status === "cancelled" ? " cancelled" : ""}`} key={`${event.id}-${event.occurrence_start}`} onClick={() => open(event)}><i style={{ backgroundColor: event.color }} /><div><small>{event.all_day ? t("calendar.allDay") : event.start.slice(11, 16)}{event.recurring ? ` · ${t("recurrence.repeats")}` : ""}</small><strong>{event.title || t("mobile.calendar.untitled")}</strong>{event.location && <span>{event.location}</span>}</div></button>) : <p>{t("mobile.calendar.noEvents")}</p>}</section>
    {editing && <EventEditor editing={editing} calendars={data?.calendars ?? []} busy={busy} close={() => setEditing(null)} save={async (event) => { const eventId = editing.event?.id; const ok = await mutate(eventId ? { type: "update_event", event_id: eventId, event } : { type: "create_event", event }); if (ok) setEditing(null); }} remove={editing.event ? () => { const eventId = editing.event?.id; if (!eventId) return; setConfirm({ title: t("mobile.calendar.deleteNamed", { name: editing.event?.title || t("mobile.calendar.untitled") }), note: t(editing.event?.recurring ? "mobile.calendar.deleteSeries" : "mobile.calendar.deleteFromDesktop"), label: t("mobile.calendar.deleteEvent"), run: async () => { if (await mutate({ type: "delete_event", event_id: eventId })) setEditing(null); } }); } : undefined} />}
    {manage && <CalendarManager calendars={data?.calendars ?? []} busy={busy} mutate={mutate} confirm={setConfirm} close={() => setManage(false)} />}
    {confirm && <ConfirmSheet confirm={confirm} busy={busy} onClose={() => setConfirm(null)} />}
    {reminders && <NotificationsSheet onClose={() => setReminders(false)} />}
  </main>;
}

function EventEditor({ editing, calendars, busy, close, save, remove }: { editing: Exclude<Editing, null>; calendars: MobileCalendarInfo[]; busy: boolean; close: () => void; save: (value: MobileCalendarEventInput) => Promise<void>; remove?: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState(editing.draft); const [endTouched, setEndTouched] = useState(false); const patch = (change: Partial<MobileCalendarEventInput>) => setDraft((v) => ({ ...v, ...change }));
  const startDay = datePart(draft.start), startTime = draft.start.slice(11, 16) || "09:00", endTime = draft.end.slice(11, 16) || "10:00";
  const endDay = draft.all_day ? shownAllDayEnd(draft.start, draft.end) : datePart(draft.end);
  const setTime = (which: "start" | "end", day: string, time: string) => {
    if (which === "end") setEndTouched(true);
    if (!draft.all_day) {
      const stamp = `${day}T${time}`;
      // Moving a new event's start carries its end an hour later — until the end is set by hand.
      const end = which === "start" && !editing.event && !endTouched ? defaultEnd(stamp) : null;
      patch(end ? { start: stamp, end } : { [which]: stamp } as Partial<MobileCalendarEventInput>);
      return;
    }
    if (which === "end") { patch({ end: storedAllDayEnd(day) }); return; }
    // Moving an all-day start past the end would otherwise be refused on save.
    patch({ start: day, end: storedAllDayEnd(day) > draft.end ? storedAllDayEnd(day) : draft.end });
  };
  return <div className="todo-editor-backdrop"><form className="todo-editor todo-editor-full calendar-editor" onSubmit={(e) => { e.preventDefault(); if (draft.title.trim()) void save(draft); }}><div className="todo-editor-heading"><h2>{t(editing.event ? "eventDialog.editEventTitle" : "eventDialog.newEventTitle")}</h2><button type="button" onClick={close}>×</button></div><label>{t("eventDialog.titleField")}<input autoFocus required maxLength={300} value={draft.title} onChange={(e) => patch({ title: e.target.value })} /></label><label>{t("eventDialog.calendarField")}<select value={draft.calendar_id} onChange={(e) => patch({ calendar_id: e.target.value })}>{calendars.map((c) => <option key={c.id} value={c.id} disabled={c.readonly}>{c.name}{c.readonly ? t("mobile.calendar.readOnlySuffix") : ""}</option>)}</select></label><label className="todo-inline-check"><input type="checkbox" checked={draft.all_day} onChange={(e) => patch(e.target.checked ? { all_day: true, start: startDay, end: storedAllDayEnd(endDay >= startDay ? endDay : startDay) } : { all_day: false, start: `${startDay}T${startTime}`, end: `${endDay}T${endTime}` })} /> {t("calendar.allDay")}</label><div className="todo-editor-grid"><label>{t("eventDialog.startsField")}<input type="date" value={startDay} onChange={(e) => setTime("start", e.target.value, startTime)} />{!draft.all_day && <input type="time" value={startTime} onChange={(e) => setTime("start", startDay, e.target.value)} />}</label><label>{t("eventDialog.endsField")}<input type="date" value={endDay} onChange={(e) => setTime("end", e.target.value, endTime)} />{!draft.all_day && <input type="time" value={endTime} onChange={(e) => setTime("end", endDay, e.target.value)} />}</label></div><label>{t("eventDialog.locationField")}<input value={draft.location} maxLength={1000} onChange={(e) => patch({ location: e.target.value })} /></label><label>{t("mobile.calendar.conference")}<input type="url" value={draft.conference} maxLength={2000} onChange={(e) => patch({ conference: e.target.value })} /></label><label>{t("eventDialog.notesField")}<textarea rows={4} value={draft.notes} maxLength={16 * 1024} onChange={(e) => patch({ notes: e.target.value })} /></label><div className="todo-editor-grid"><label>{t("eventDialog.categoryField")}<input value={draft.category} maxLength={80} onChange={(e) => patch({ category: e.target.value })} /></label><label>{t("eventDialog.statusField")}<select value={draft.status} onChange={(e) => patch({ status: e.target.value })}><option value="confirmed">{t("eventDialog.statusConfirmed")}</option><option value="tentative">{t("eventDialog.statusTentative")}</option><option value="cancelled">{t("eventDialog.statusCancelled")}</option></select></label></div>{editing.event?.recurring && <p className="notice">{t("mobile.calendar.seriesNotice")}</p>}<div className="todo-editor-actions">{remove && <button type="button" className="danger" onClick={remove} disabled={busy}>{t("common.delete")}</button>}<span /><button type="button" onClick={close}>{t("common.cancel")}</button><button className="primary" disabled={busy || !draft.title.trim() || !draft.calendar_id}>{t("common.save")}</button></div></form></div>;
}

/** A calendar's name and colour, edited in the sheet the tab rename uses
 * (`RenameSheet`'s shape: the same classes, the same Cancel/Save row) in
 * place of two `window.prompt`s — which a phone draws as the browser's own
 * dialog, with no way to pick a colour. Nothing is sent until Save. */
function CalendarEditSheet({ calendar, busy, save, onClose }: { calendar: MobileCalendarInfo; busy: boolean; save: (name: string, color: string) => Promise<boolean>; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(calendar.name); const [color, setColor] = useState(calendar.color); const [error, setError] = useState("");
  const trimmed = name.trim();
  const submit = async () => { if (!trimmed) { setError(t("mobile.calendar.enterName")); return; } setError(""); if (await save(trimmed, color)) onClose(); };
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.calendar.editCalendar")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("common.close")}>✕</button><h2>{t("mobile.calendar.editCalendar")} {isUntested("mobile.calendar.manage") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">{t("mobile.calendar.editNote")}</p>
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      <div className="mobile-schedule-form">
        <label>{t("calendarSidebar.namePlaceholder")}<input type="text" value={name} autoFocus maxLength={160} disabled={busy} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }} /></label>
        <label>{t("mobile.markup.color")}<input type="color" value={color} disabled={busy} onChange={(event) => setColor(event.target.value)} /></label>
        <div className="mobile-schedule-actions">
          <button disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <button className="primary" disabled={busy || !trimmed} onClick={() => void submit()}>{t(busy ? "common.saving" : "common.save")}</button>
        </div>
      </div>
    </section>
  </div>;
}

function CalendarManager({ calendars, busy, mutate, confirm, close }: { calendars: MobileCalendarInfo[]; busy: boolean; mutate: (action: CalendarAction) => Promise<boolean>; confirm: (confirm: Confirm) => void; close: () => void }) {
  const t = useT();
  const [name, setName] = useState(""); const [color, setColor] = useState("#4aa3df");
  const [editing, setEditingCalendar] = useState<MobileCalendarInfo | null>(null);
  return <div className="todo-editor-backdrop"><section className="todo-editor todo-editor-full calendar-manager"><div className="todo-editor-heading"><h2>{t("calendarSidebar.calendarsTitle")}</h2><button onClick={close}>×</button></div>{calendars.map((c) => <article className="mobile-calendar-manage-row" key={c.id}><i style={{ backgroundColor: c.color }} /><div><strong>{c.name}</strong><small>{c.readonly ? t("mobile.calendar.readOnly") : c.caldav ? "CalDAV" : c.subscribed ? t("mobile.calendar.subscribed") : t("mobile.calendar.local")}</small></div><label className="todo-inline-check"><input type="checkbox" checked={c.visible} disabled={busy} onChange={() => void mutate({ type: "update_calendar", calendar_id: c.id, name: c.name, color: c.color, visible: !c.visible })} /> {t("mobile.calendar.show")}</label>{!c.readonly && <><button disabled={busy} onClick={() => setEditingCalendar(c)} aria-label={t("mobile.calendar.editNamed", { name: c.name })}>{t("common.edit")}</button><button className="danger" disabled={busy || calendars.length <= 1} aria-label={t("mobile.calendar.deleteCalendarNamed", { name: c.name })} onClick={() => confirm({ title: t("mobile.calendar.deleteNamed", { name: c.name }), note: t("mobile.calendar.deleteCalendarNote"), label: t("mobile.calendar.deleteCalendar"), run: async () => { await mutate({ type: "delete_calendar", calendar_id: c.id }); } })}>{t("common.delete")}</button></>}</article>)}<form className="calendar-new" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void mutate({ type: "create_calendar", name: name.trim(), color }).then((ok) => { if (ok) setName(""); }); }}><label>{t("mobile.calendar.name")}<input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} /></label><label>{t("mobile.calendar.color")}<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label><button className="primary" disabled={busy || !name.trim()}>{t("mobile.calendar.addCalendar")}</button></form></section>
    {editing && <CalendarEditSheet calendar={editing} busy={busy} save={(nextName, nextColor) => mutate({ type: "update_calendar", calendar_id: editing.id, name: nextName, color: nextColor, visible: editing.visible })} onClose={() => setEditingCalendar(null)} />}
  </div>;
}
