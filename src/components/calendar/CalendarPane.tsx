import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  useCalendarStore,
  visibleCalendarIds,
  type DeletedCalendar,
} from "../../stores/calendar/calendar";
import { useDialogs } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";
import { useSettingsStore } from "../../stores/settings";
import type {
  CalendarEvent,
  CalendarViewKind,
  Occurrence,
} from "../../types";
import {
  addDays,
  addMonths,
  datePart,
  dateRange,
  formatLongDate,
  minutesBetween,
  monthGrid,
  monthName,
  startOfWeek,
  todayStr,
  weekDates,
} from "../../lib/calendar/calendarTime";
import { expandEvents } from "../../lib/calendar/recurrence";
import { serializeIcs } from "../../lib/calendar/ics";
import { inspectIcs, type IcsReport } from "../../lib/calendar/icsSafety";
import { IcsImportReviewDialog } from "./IcsImportReviewDialog";
import { importIcsText } from "../../stores/calendar/importIcs";
import { MonthView } from "./MonthView";
import { TimeGrid } from "./TimeGrid";
import { AgendaView } from "./AgendaView";
import { TasksView } from "./TasksView";
import { CalendarSidebar } from "./CalendarSidebar";
import { CalDavAccountDialog } from "./CalDavAccountDialog";
import { EventDialog, type EditScope, type EventDialogTarget } from "./EventDialog";
import { CalendarContextMenu, type CalendarMenuTarget } from "./CalendarContextMenu";
import { useCalendarClipboardStore } from "../../stores/calendar/clipboard";
import { copyOfOccurrence, pastedAt, type PasteTarget } from "../../lib/calendar/calendarClipboard";
import { isCalDavConflict, useCalDavStore } from "../../stores/calendar/caldav";
import type { CalDavAccount } from "../../types/caldav";
import { useI18nStore, useT, type TranslationKey } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { BRAND } from "../../lib/brand";

interface Props {
  /** Whether this pane's tab is the visible one in its group. */
  visible?: boolean;
}

/** Weeks the multiweek view shows. */
const MULTIWEEK_WEEKS = 4;

const VIEW_KEYS: { kind: CalendarViewKind; labelKey: TranslationKey; key: string }[] = [
  { kind: "day", labelKey: "calendarPane.viewDay", key: "1" },
  { kind: "week", labelKey: "calendarPane.viewWeek", key: "2" },
  { kind: "multiweek", labelKey: "calendarPane.viewMultiweek", key: "3" },
  { kind: "month", labelKey: "calendarPane.viewMonth", key: "4" },
  { kind: "agenda", labelKey: "calendarPane.viewAgenda", key: "5" },
  { kind: "tasks", labelKey: "calendarPane.viewTasks", key: "6" },
];

/**
 * The native calendar tab.
 *
 * A shell around the views: a toolbar (view switcher, navigation, search,
 * import/export), the sidebar (mini-month + calendar list), and whichever view is
 * active. The event store is global — every calendar tab, in any project scope,
 * shows the same events and sees the others' edits live.
 *
 * Views never read raw events. They consume *occurrences* — the result of
 * expanding recurrence over the visible window (`expandEvents`) — so a repeating
 * event is just many occurrences and no view has to know about rules.
 */
export function CalendarPane({ visible }: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const calendars = useCalendarStore((s) => s.calendars);
  const events = useCalendarStore((s) => s.events);
  const tasks = useCalendarStore((s) => s.tasks);
  const loaded = useCalendarStore((s) => s.loaded);
  const load = useCalendarStore((s) => s.load);
  const createEvent = useCalendarStore((s) => s.createEvent);
  const updateEvent = useCalendarStore((s) => s.updateEvent);
  const deleteEvent = useCalendarStore((s) => s.deleteEvent);
  const deleteOccurrence = useCalendarStore((s) => s.deleteOccurrence);
  const updateOccurrence = useCalendarStore((s) => s.updateOccurrence);
  const createTask = useCalendarStore((s) => s.createTask);
  const updateTask = useCalendarStore((s) => s.updateTask);
  const deleteTask = useCalendarStore((s) => s.deleteTask);
  const createCalendar = useCalendarStore((s) => s.createCalendar);
  const updateCalendar = useCalendarStore((s) => s.updateCalendar);
  const deleteCalendar = useCalendarStore((s) => s.deleteCalendar);
  const restoreCalendar = useCalendarStore((s) => s.restoreCalendar);
  const toggleCalendarVisible = useCalendarStore((s) => s.toggleCalendarVisible);
  const refreshCalendarFromUrl = useCalendarStore((s) => s.refreshCalendarFromUrl);

  const settings = useSettingsStore((s) => s.settings);

  const weekStart = (settings?.calendar_week_start ?? 1) as 0 | 1;
  // App-wide now, not the calendar's own switch — the grid, the header clock,
  // the to-do cards and the reminder popup are one app's idea of the time.
  const use24h = useUse24h();
  const dayStartHour = settings?.calendar_day_start_hour ?? 8;
  const defaultReminder = settings?.calendar_default_reminder_minutes ?? 0;

  // Null until the user picks a view, so the configured default still applies when
  // settings load *after* this pane mounts (a calendar tab restored at startup
  // does exactly that). Snapshotting it into useState would silently ignore it.
  const [picked, setPicked] = useState<CalendarViewKind | null>(null);
  const view = picked ?? settings?.calendar_default_view ?? "month";
  const setView = setPicked;

  const [anchor, setAnchor] = useState(() => todayStr());
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<EventDialogTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { confirmAction, dialogs } = useDialogs();
  /** The calendar the sidebar's × just removed, kept so the notice can put it back. */
  const [undoDelete, setUndoDelete] = useState<DeletedCalendar | null>(null);
  /** A picked `.ics` waiting on the review dialog. The text is held here rather
   *  than re-read on confirm: re-reading would inspect one file and import
   *  whatever is at that path a moment later. */
  const [pendingImport, setPendingImport] = useState<{
    name: string;
    text: string;
    report: IcsReport;
  } | null>(null);
  /** `null` = closed; `{account}` = editing (a `null` account is "add new"). */
  const [caldavDialog, setCaldavDialog] = useState<{ account: CalDavAccount | null } | null>(null);
  /** The open right-click menu: where it is, and what it is about. */
  const [menu, setMenu] = useState<CalendarMenuTarget | null>(null);

  // The clipboard is a module store, not pane state: a copy made here pastes in
  // another calendar tab, and survives navigating away from the source day.
  const clipboard = useCalendarClipboardStore((s) => s.entry);
  const copyToClipboard = useCalendarClipboardStore((s) => s.copy);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const visibleIds = useMemo(() => visibleCalendarIds(calendars), [calendars]);
  const defaultCalendarId = calendars[0]?.id ?? "default";

  // ── The visible window ────────────────────────────────────────────────────

  /** The dates the active view covers — and thus the expansion window. */
  const windowDates = useMemo((): string[] => {
    switch (view) {
      case "day":
        return [datePart(anchor)];
      case "week":
        return weekDates(anchor, weekStart);
      case "multiweek":
        return dateRange(startOfWeek(anchor, weekStart), MULTIWEEK_WEEKS * 7);
      case "month":
        return monthGrid(
          Number(anchor.slice(0, 4)),
          Number(anchor.slice(5, 7)),
          weekStart,
          6,
        ).flat();
      case "agenda":
        // The agenda looks forward a month from the anchor, like a "what's next" list.
        return dateRange(datePart(anchor), 31);
      case "tasks":
        return [];
    }
  }, [view, anchor, weekStart]);

  const windowStart = windowDates[0] ?? todayStr();
  const windowEnd = windowDates.length
    ? addDays(windowDates[windowDates.length - 1], 1)
    : addDays(windowStart, 1);

  /** Everything visible in the window, with recurrence expanded. */
  const occurrences = useMemo(
    () => expandEvents(events, windowStart, windowEnd, visibleIds),
    [events, windowStart, windowEnd, visibleIds],
  );

  /** Search filters what the views draw, across title, location and notes. */
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return occurrences;
    return occurrences.filter((o) =>
      `${o.title} ${o.location} ${o.notes}`.toLowerCase().includes(q),
    );
  }, [occurrences, search]);

  // ── Navigation ────────────────────────────────────────────────────────────

  const shift = useCallback(
    (dir: -1 | 1) => {
      setAnchor((a) => {
        switch (view) {
          case "day":
            return addDays(a, dir);
          case "week":
            return addDays(a, 7 * dir);
          case "multiweek":
            return addDays(a, MULTIWEEK_WEEKS * 7 * dir);
          case "month":
            return addMonths(a, dir);
          case "agenda":
            return addDays(a, 31 * dir);
          case "tasks":
            return a;
        }
      });
    },
    [view],
  );

  /** The heading over the grid — what range you are looking at. */
  const title = useMemo(() => {
    if (view === "tasks") return t("calendarPane.viewTasks");
    if (view === "day") return formatLongDate(datePart(anchor), lang);
    if (view === "month") {
      return `${monthName(lang, Number(anchor.slice(5, 7)))} ${anchor.slice(0, 4)}`;
    }
    const first = windowDates[0];
    const last = windowDates[windowDates.length - 1];
    if (!first || !last) return "";
    return `${formatLongDate(first, lang)} – ${formatLongDate(last, lang)}`;
  }, [view, anchor, windowDates, t, lang]);

  // Arrow keys and view digits, scoped to the pane (it must not steal keys from
  // a terminal in another tab, so the handler lives on the pane, not the window).
  const onKeyDown = (e: React.KeyboardEvent) => {
    // `dialogs` is portaled, but its key events still bubble through here.
    if (dialog || dialogs) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    if (e.key === "ArrowLeft") {
      shift(-1);
    } else if (e.key === "ArrowRight") {
      shift(1);
    } else if (e.key === "t" || e.key === "T") {
      setAnchor(todayStr());
    } else if (e.key === "n" || e.key === "N") {
      openCreate(datePart(anchor));
    } else {
      const match = VIEW_KEYS.find((v) => v.key === e.key);
      if (match) setView(match.kind);
      else return;
    }
    e.preventDefault();
  };

  // ── Event editing ─────────────────────────────────────────────────────────

  /**
   * Open the editor on a new event. A new event is always *timed* (09:00-10:00 by
   * default, or whatever span a grid drag produced) — "All day" is a checkbox the
   * user ticks. The draft must stay internally consistent: an all-day draft
   * carries bare dates and an exclusive end, so handing one a timed end would make
   * the dialog step it back a day and land the end before the start.
   */
  function openCreate(date: string, start?: string, end?: string) {
    setDialog({
      event: null,
      occurrence: null,
      draftStart: start ?? `${datePart(date)}T09:00`,
      draftEnd: end ?? `${datePart(date)}T10:00`,
      draftAllDay: false,
    });
  }

  function openOccurrence(occ: Occurrence) {
    const event = events.find((e) => e.id === occ.eventId);
    if (!event) return;
    setDialog({ event, occurrence: occ });
  }

  async function saveFromDialog(event: CalendarEvent, scope: EditScope) {
    const target = dialog;
    setDialog(null);

    // Creating.
    if (!target?.event) {
      const { id: _id, ...draft } = event;
      await createEvent(draft);
      return;
    }

    // Editing one occurrence of a series → store an override, leave the rest.
    if (scope === "this" && target.occurrence) {
      await updateOccurrence(target.event.id, target.occurrence.occurrenceStart, {
        start: event.start,
        end: event.end,
        title: event.title,
        location: event.location ?? "",
        notes: event.notes ?? "",
      });
      return;
    }

    // Editing the series (or a plain event).
    //
    // When the user edited an *occurrence* and chose "all", the times they see are
    // that occurrence's, not the master's — writing them straight onto the master
    // would drag the whole series onto that one occurrence's date. So only the
    // duration and the time-of-day carry over; the master keeps its own start date.
    let next = event;
    if (target.occurrence && target.occurrence.occurrenceStart !== target.event.start) {
      const masterDate = datePart(target.event.start);
      const durationMin = minutesBetween(event.start, event.end);
      const startTime = event.start.split("T")[1];
      const start = event.all_day ? masterDate : `${masterDate}T${startTime}`;
      const end = event.all_day
        ? addDays(masterDate, Math.max(1, Math.round(minutesBetween(event.start, event.end) / 1440)))
        : shiftBy(start, durationMin);
      next = { ...event, start, end };
    }
    try {
      await updateEvent(next);
    } catch (err) {
      // A synced series that cannot move to another calendar is refused before
      // anything is written; say why rather than dropping the edit silently.
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteFromDialog(event: CalendarEvent, scope: EditScope) {
    const target = dialog;
    setDialog(null);
    try {
      if (scope === "this" && target?.occurrence) {
        await deleteOccurrence(event.id, target.occurrence.occurrenceStart);
        return;
      }
      await deleteEvent(event.id);
    } catch (err) {
      // A CalDAV delete the server refused **rejects on purpose**, so the row is
      // still here rather than gone locally and present for everyone else. The
      // conflict dialog is already asking about that one, so it is the only
      // failure this does not repeat as a notice.
      if (!isCalDavConflict(err)) setNotice(String(err));
    }
  }

  /** A drag in the time grid created a span. */
  const onCreateSpan = useCallback((start: string, end: string) => {
    setDialog({
      event: null,
      occurrence: null,
      draftStart: start,
      draftEnd: end,
      draftAllDay: false,
    });
  }, []);

  /**
   * A block was dragged to a new time. A single occurrence of a series moves as
   * an override; a plain event moves outright. Either way the duration is kept.
   */
  const onMove = useCallback(
    async (occ: Occurrence, newStart: string) => {
      const event = events.find((e) => e.id === occ.eventId);
      if (!event) return;
      const durationMin = minutesBetween(occ.start, occ.end);
      const newEnd = shiftBy(newStart, durationMin);

      if (occ.recurring) {
        await updateOccurrence(occ.eventId, occ.occurrenceStart, {
          start: newStart,
          end: newEnd,
        });
        return;
      }
      await updateEvent({ ...event, start: newStart, end: newEnd });
    },
    [events, updateEvent, updateOccurrence],
  );

  /** A block's bottom edge was dragged. */
  const onResize = useCallback(
    async (occ: Occurrence, newEnd: string) => {
      const event = events.find((e) => e.id === occ.eventId);
      if (!event) return;
      if (occ.recurring) {
        await updateOccurrence(occ.eventId, occ.occurrenceStart, {
          start: occ.start,
          end: newEnd,
        });
        return;
      }
      await updateEvent({ ...event, end: newEnd });
    },
    [events, updateEvent, updateOccurrence],
  );

  // ── Copy / paste ──────────────────────────────────────────────────────────
  //
  // The narrow promise of the feature: a pasted entry is the copied one again on
  // another day. Only its start — and the end its own duration puts after it —
  // is new; see `lib/calendar/calendarClipboard` for what is deliberately left
  // behind (the identity fields, and the repeat rule).

  const copyOccurrence = useCallback(
    (occ: Occurrence) => {
      const event = events.find((e) => e.id === occ.eventId);
      if (!event) return;
      copyToClipboard(copyOfOccurrence(event, occ));
    },
    [events, copyToClipboard],
  );

  const pasteInto = useCallback(
    async (slot: PasteTarget) => {
      // Read through the store rather than close over `clipboard`: the copy may
      // have been made in another calendar tab a moment ago.
      const entry = useCalendarClipboardStore.getState().entry;
      if (!entry) return;
      let draft = pastedAt(entry, slot);

      // Never into a subscribed or read-only calendar: a refresh replaces those
      // rows wholesale (`calendar_replace_events`), so the paste would appear to
      // work and then be gone. It goes to the first writable calendar instead —
      // said out loud, because that IS a second thing the paste changed.
      const target = calendars.find((c) => c.id === draft.calendar_id);
      if (!target || target.readonly) {
        const writable = calendars.find((c) => !c.readonly);
        if (!writable) {
          setNotice(t("calendarMenu.pasteNoCalendar"));
          return;
        }
        draft = { ...draft, calendar_id: writable.id };
        setNotice(t("calendarMenu.pastedElsewhere", { name: writable.name }));
      }

      try {
        await createEvent(draft);
      } catch (err) {
        setNotice(t("calendarMenu.pasteFailed", { error: String(err) }));
      }
    },
    [calendars, createEvent, t],
  );

  /** Delete straight from the menu, by the dialog's rule rather than a second
   *  one: a plain event goes at once, a repeating one only with a scope. */
  const deleteFromMenu = useCallback(
    async (occ: Occurrence, scope: EditScope) => {
      try {
        if (scope === "this" && occ.recurring) {
          await deleteOccurrence(occ.eventId, occ.occurrenceStart);
          return;
        }
        await deleteEvent(occ.eventId);
      } catch (err) {
        // A CalDAV refusal is already being asked about in the conflict dialog;
        // it is the one failure this does not repeat as a notice.
        if (!isCalDavConflict(err)) setNotice(String(err));
      }
    },
    [deleteEvent, deleteOccurrence],
  );

  // ── ICS ───────────────────────────────────────────────────────────────────

  /**
   * Read the file, look at what is in it, and import — pausing for the review
   * dialog only when there is something to say.
   *
   * The pause is deliberately conditional. An ordinary calendar export produces
   * no findings and imports in one click, which is what keeps the dialog worth
   * reading on the file that *does* carry a `PROCEDURE` alarm or a `zoommtg:`
   * location. A dialog raised every time is a dialog nobody reads.
   */
  async function importIcs() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "iCalendar", extensions: ["ics", "ical", "ifb"] }],
    });
    if (typeof path !== "string") return;

    try {
      // A dedicated, extension-guarded command — the general file-read command is
      // confined to the current project and would refuse a path in ~/Downloads.
      const text = await invoke<string>("calendar_read_ics", { path });
      const report = inspectIcs(text);
      if (report.notable) {
        setPendingImport({ name: fileStem(path) || path, text, report });
        return;
      }
      await commitImport(text, fileStem(path));
    } catch (err) {
      setNotice(t("calendarPane.importFailed", { error: String(err) }));
    }
  }

  /** The import itself, once it is going ahead. */
  async function commitImport(text: string, stem: string) {
    try {
      const done = await importIcsText(text, stem || t("calendarPane.importedCalendarName"));
      setNotice(
        t("calendarPane.importedEvents", { count: done.events }) +
          (done.tasks ? t("calendarPane.andTasks", { count: done.tasks }) : "") +
          t("calendarPane.intoCalendar", { name: done.calendarName }) +
          (done.skipped ? t("calendarPane.skippedSuffix", { count: done.skipped }) : t("calendarPane.periodSuffix")),
      );
    } catch (err) {
      setNotice(t("calendarPane.importFailed", { error: String(err) }));
    }
  }

  async function exportIcs() {
    const path = await saveDialog({
      defaultPath: `${BRAND.slug}-calendar.ics`,
      filters: [{ name: "iCalendar", extensions: ["ics"] }],
    });
    if (typeof path !== "string") return;

    try {
      // Export what is checked in the sidebar — the same set the views show, so
      // what you see is what you get.
      const text = serializeIcs(
        events.filter((e) => visibleIds.has(e.calendar_id)),
        tasks.filter((tk) => visibleIds.has(tk.calendar_id)),
      );
      await invoke<void>("calendar_write_ics", { path, content: text });
      setNotice(t("calendarPane.exportedTo", { path }));
    } catch (err) {
      setNotice(t("calendarPane.exportFailed", { error: String(err) }));
    }
  }

  async function subscribeCalendar(name: string, url: string) {
    try {
      // A subscribed calendar is read-only in the UI (its content comes from
      // the feed, not from edits made here) and remembers its URL so a later
      // click on its refresh icon knows what to re-fetch.
      const target = await createCalendar({
        name,
        color: "#8d8fd6",
        visible: true,
        readonly: true,
        source_url: url,
      });
      const result = await refreshCalendarFromUrl(target.id, url);
      setNotice(
        t("calendarPane.subscribedEvents", { count: result.events }) +
          (result.tasks ? t("calendarPane.andTasks", { count: result.tasks }) : "") +
          t("calendarPane.intoCalendar", { name: target.name }) +
          (result.skipped ? t("calendarPane.skippedSuffix", { count: result.skipped }) : t("calendarPane.periodSuffix")),
      );
    } catch (err) {
      setNotice(t("calendarPane.subscribeFailed", { error: String(err) }));
    }
  }

  async function refreshCalendar(id: string) {
    const cal = calendars.find((c) => c.id === id);
    if (!cal?.source_url) return;
    try {
      const result = await refreshCalendarFromUrl(id, cal.source_url);
      setNotice(
        t("calendarPane.refreshedEvents", { count: result.events }) +
          (result.tasks ? t("calendarPane.andTasks", { count: result.tasks }) : "") +
          t("calendarPane.intoCalendar", { name: cal.name }) +
          (result.skipped ? t("calendarPane.skippedSuffix", { count: result.skipped }) : t("calendarPane.periodSuffix")),
      );
    } catch (err) {
      setNotice(t("calendarPane.refreshFailed", { error: String(err) }));
    }
  }

  // ── CalDAV ────────────────────────────────────────────────────────────────
  //
  // Deliberately thin: everything about a sync — the ctag check, the protocol,
  // the identity-based merge that keeps a card's board column — lives in
  // `stores/calendar/caldav` and the backend. This is the button and the sentence.

  function openCaldavDialog() {
    // Accounts are one local file; loading them is what lets the dialog open on
    // the existing account instead of a blank form.
    void useCalDavStore.getState().load();
    const accounts = useCalDavStore.getState().accounts;
    setCaldavDialog({ account: accounts[0] ?? null });
  }

  async function syncCaldavCalendar(calendarId: string) {
    const target = useCalDavStore.getState().accountForCalendar(calendarId);
    if (!target) return;
    const cal = calendars.find((c) => c.id === calendarId);
    // `force: true` — a manual Sync skips the ctag check.
    const status = await useCalDavStore
      .getState()
      .syncCalendar(target.account.id, target.href, true);
    setNotice(
      status.phase === "error"
        ? t("caldav.syncFailed", { error: status.error })
        : t("caldav.synced", { name: cal?.name ?? target.href }),
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const gridPrefs = { use24h, dayStartHour };

  /** Deleting a calendar takes every event and task on it along: ask first, and
   *  keep what was removed so the notice can undo it. */
  const confirmDeleteCalendar = async (id: string) => {
    const cal = calendars.find((c) => c.id === id);
    if (!cal) return;
    const state = useCalendarStore.getState();
    const ok = await confirmAction({
      title: t("calendarPane.deleteCalendarConfirmTitle", { name: cal.name }),
      body: t("calendarPane.deleteCalendarConfirmBody", {
        events: state.events.filter((e) => e.calendar_id === id).length,
        tasks: state.tasks.filter((task) => task.calendar_id === id).length,
      }),
      confirmLabel: t("calendarPane.deleteCalendarConfirmButton"),
      danger: true,
    });
    if (!ok) return;
    try {
      setUndoDelete(await deleteCalendar(id));
    } catch (err) {
      setNotice(t("calendarPane.deleteCalendarFailed", { error: String(err) }));
    }
  };

  const undoDeleteCalendar = async () => {
    if (!undoDelete) return;
    try {
      await restoreCalendar(undoDelete);
      setUndoDelete(null);
    } catch (err) {
      setNotice(t("calendarPane.restoreCalendarFailed", { error: String(err) }));
    }
  };

  return (
    <div
      className="cal-pane"
      style={{ display: visible === false ? "none" : undefined }}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="cal-toolbar">
        <div className="cal-toolbar-nav">
          <button className="cal-nav-btn" onClick={() => shift(-1)} title={t("calendarPane.previousTitle")}>‹</button>
          <button className="cal-btn" onClick={() => setAnchor(todayStr())} title={t("calendarPane.todayTitle")}>
            {t("calendar.today")}
          </button>
          <button className="cal-nav-btn" onClick={() => shift(1)} title={t("calendarPane.nextTitle")}>›</button>
        </div>

        <div className="cal-toolbar-title">{title}</div>

        <div className="cal-toolbar-views">
          {VIEW_KEYS.map((v) => (
            <button
              key={v.kind}
              className={`cal-chip${view === v.kind ? " cal-chip-on" : ""}`}
              onClick={() => setView(v.kind)}
              title={t("calendarPane.viewTitle", { label: t(v.labelKey), key: v.key })}
            >
              {t(v.labelKey)}
            </button>
          ))}
        </div>

        <input
          className="cal-input cal-search"
          type="search"
          placeholder={t("calendarPane.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="cal-toolbar-actions">
          <button
            className="cal-btn cal-btn-primary"
            onClick={() => openCreate(datePart(anchor))}
            title={t("calendarPane.newEventTitle")}
          >
            {t("calendarPane.addEventButton")}
          </button>
          <button className="cal-btn" onClick={() => void importIcs()} title={t("calendarPane.importTitle")}>
            {t("calendarPane.importButton")}
          </button>
          <button className="cal-btn" onClick={() => void exportIcs()} title={t("calendarPane.exportTitle")}>
            {t("calendarPane.exportButton")}
          </button>
        </div>
      </div>

      {notice ? (
        <div className="cal-notice" onClick={() => setNotice(null)} title={t("calendarPane.dismissNoticeTitle")}>
          {notice}
        </div>
      ) : null}

      {undoDelete ? (
        <div className="cal-notice cal-notice-undo">
          <span>{t("calendarPane.calendarDeleted", { name: undoDelete.calendar.name })}</span>
          <button className="cal-link-btn" onClick={() => void undoDeleteCalendar()}>
            {t("calendarPane.undoDeleteCalendar")}
            <UntestedTag id="calendarPane.undoDeleteCalendar" />
          </button>
          <button
            className="cal-link-btn"
            onClick={() => setUndoDelete(null)}
            title={t("calendarPane.dismissNoticeTitle")}
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="cal-body">
        <CalendarSidebar
          calendars={calendars}
          selected={anchor}
          onSelect={(date) => setAnchor(date)}
          onToggleVisible={(id) => void toggleCalendarVisible(id)}
          onCreateCalendar={(name, color) =>
            void createCalendar({ name, color, visible: true, readonly: false })
          }
          onUpdateCalendar={(cal) => void updateCalendar(cal)}
          onDeleteCalendar={(id) => void confirmDeleteCalendar(id)}
          onSubscribeCalendar={(name, url) => void subscribeCalendar(name, url)}
          onRefreshCalendar={(id) => void refreshCalendar(id)}
          onSyncCaldav={(id) => void syncCaldavCalendar(id)}
          onOpenCaldav={() => openCaldavDialog()}
          weekStart={weekStart}
        />

        <div className="cal-view">
          {view === "tasks" ? (
            <TasksView
              tasks={tasks}
              calendars={calendars}
              visibleCalendars={visibleIds}
              search={search}
              onCreate={createTask}
              onUpdate={updateTask}
              onDelete={deleteTask}
              defaultCalendarId={defaultCalendarId}
              use24h={use24h}
            />
          ) : view === "agenda" ? (
            <AgendaView
              occurrences={shown}
              calendars={calendars}
              use24h={use24h}
              onOpen={openOccurrence}
              onMenu={setMenu}
              emptyLabel={
                search.trim()
                  ? t("calendar.noEventsMatch", { query: search.trim() })
                  : t("calendar.nothingScheduled")
              }
            />
          ) : view === "month" || view === "multiweek" ? (
            <MonthView
              weeks={chunk(windowDates, 7)}
              month={view === "month" ? Number(anchor.slice(5, 7)) : null}
              occurrences={shown}
              calendars={calendars}
              use24h={use24h}
              selected={datePart(anchor)}
              onSelect={(date) => setAnchor(date)}
              onCreateOn={(date) => openCreate(date)}
              onOpen={openOccurrence}
              onMenu={setMenu}
              weekStart={weekStart}
            />
          ) : (
            <div className="cal-timeview">
              <AllDayBar
                dates={windowDates}
                occurrences={shown}
                onOpen={openOccurrence}
                onMenu={setMenu}
                selected={datePart(anchor)}
                onSelect={(date) => setAnchor(date)}
              />
              <TimeGrid
                dates={windowDates}
                occurrences={shown}
                calendars={calendars}
                prefs={gridPrefs}
                onOpen={openOccurrence}
                onCreate={onCreateSpan}
                onMove={(occ, start) => void onMove(occ, start)}
                onResize={(occ, end) => void onResize(occ, end)}
                onMenu={setMenu}
              />
            </div>
          )}
        </div>
      </div>

      {menu ? (
        <CalendarContextMenu
          target={menu}
          clipboard={clipboard}
          onClose={() => setMenu(null)}
          onEdit={openOccurrence}
          onCopy={copyOccurrence}
          onDelete={(occ, scope) => void deleteFromMenu(occ, scope)}
          onPaste={(slot) => void pasteInto(slot)}
          onCreate={(slot) =>
            openCreate(slot.date, slot.start, slot.start ? shiftBy(slot.start, 60) : undefined)
          }
        />
      ) : null}

      {dialog ? (
        <EventDialog
          target={dialog}
          calendars={calendars}
          defaultCalendarId={defaultCalendarId}
          defaultReminderMinutes={defaultReminder}
          onClose={() => setDialog(null)}
          onSave={saveFromDialog}
          onDelete={deleteFromDialog}
        />
      ) : null}

      {caldavDialog ? (
        <CalDavAccountDialog
          account={caldavDialog.account}
          onClose={() => setCaldavDialog(null)}
          onSaved={(accountId) => {
            setCaldavDialog(null);
            // Subscribing is what created the calendars; syncing them is a
            // separate act, and doing it here is what makes the first one
            // happen without waiting out a whole interval.
            const account = useCalDavStore.getState().accounts.find((a) => a.id === accountId);
            if (!account) return;
            void (async () => {
              for (const ref of account.calendars) {
                await useCalDavStore.getState().syncCalendar(accountId, ref.href, true);
              }
              setNotice(t("caldav.syncedAccount", { name: account.label || account.base_url }));
            })();
          }}
        />
      ) : null}

      {pendingImport ? (
        <IcsImportReviewDialog
          name={pendingImport.name}
          report={pendingImport.report}
          onImport={() => {
            const { text, name } = pendingImport;
            setPendingImport(null);
            void commitImport(text, name);
          }}
          onCancel={() => setPendingImport(null)}
        />
      ) : null}

      {dialogs}
    </div>
  );
}

/**
 * The strip above the day/week grid: the date headers, plus the all-day events,
 * which have no place on an hour grid.
 */
function AllDayBar({
  dates,
  occurrences,
  onOpen,
  onMenu,
  selected,
  onSelect,
}: {
  dates: string[];
  occurrences: Occurrence[];
  onOpen: (o: Occurrence) => void;
  /** Right-click, on a column or on an all-day chip. No minute is reported:
   *  this strip is the part of the day view that has no clock. */
  onMenu: (target: CalendarMenuTarget) => void;
  selected: string;
  onSelect: (date: string) => void;
}) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const today = todayStr();
  const allDay = occurrences.filter((o) => o.allDay);

  return (
    <div className="cal-allday">
      <div className="cal-allday-gutter">{t("calendar.allDayGutterLabel")}</div>
      <div className="cal-allday-cols">
        {dates.map((date) => {
          const here = allDay.filter((o) =>
            dateWithin(o, date),
          );
          const d = new Date(`${date}T12:00`);
          return (
            <div
              key={date}
              className={
                "cal-allday-col" +
                (date === today ? " cal-allday-col-today" : "") +
                (date === selected ? " cal-allday-col-selected" : "")
              }
              onClick={() => onSelect(date)}
              onContextMenu={(e) => {
                e.preventDefault();
                onMenu({ x: e.clientX, y: e.clientY, occ: null, slot: { date } });
              }}
            >
              <div className="cal-allday-head">
                <span className="cal-allday-dow">
                  {d.toLocaleDateString(lang, { weekday: "short" })}
                </span>
                <span className="cal-allday-num">{Number(date.slice(8, 10))}</span>
              </div>
              {here.map((o) => (
                <div
                  key={`${o.eventId}:${o.occurrenceStart}`}
                  className="cal-allday-chip"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(o);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onMenu({ x: e.clientX, y: e.clientY, occ: o, slot: { date } });
                  }}
                  title={o.title}
                >
                  {o.title || t("calendar.untitled")}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function dateWithin(o: Occurrence, date: string): boolean {
  return datePart(o.start) <= date && date < datePart(o.end);
}

/** Split a flat date list into rows of `n`. */
function chunk(dates: string[], n: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < dates.length; i += n) out.push(dates.slice(i, i + n));
  return out;
}

/** A stamp plus a duration in minutes. */
function shiftBy(start: string, minutes: number): string {
  const total = Math.max(15, minutes);
  const [date, time] = start.split("T");
  const [h, m] = (time ?? "00:00").split(":").map(Number);
  const end = h * 60 + m + total;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${addDays(date, Math.floor(end / 1440))}T${p(Math.floor((end % 1440) / 60))}:${p(end % 60)}`;
}

/** The bare filename, for naming an imported calendar. */
function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(ics|ical|ifb)$/i, "");
}
