import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { DueAlarm, Snoozed } from "../../lib/calendar/alarms";
import {
  alarmWindow,
  describeLead,
  dueAlarms,
  mutedCalendarIds,
  snooze as makeSnooze,
  wokenSnoozes,
} from "../../lib/calendar/alarms";
import { expandEvents } from "../../lib/calendar/recurrence";
import { formatStampTime } from "../../lib/calendar/calendarTime";
import { readUse24h } from "../../lib/timeFormat";
import { translate, useI18nStore } from "../../lib/i18n";
import { useCalendarStore } from "./calendar";
import { holdsTimerLease } from "../timerLease";
import { storageKey } from "../../lib/brand";

/** How often the ticker looks for due reminders. */
const TICK_MS = 30_000;

/**
 * Where the "already fired" set is persisted.
 *
 * localStorage, not the calendar file: this is per-machine UI state, not calendar
 * data. Writing it into `calendar.json` would mean an exported .ics carried
 * "this user already dismissed this" — which is nobody else's business, and would
 * churn the file on every reminder.
 */
const FIRED_KEY = storageKey("calendar.firedAlarms");

/** Cap on remembered keys, so the list cannot grow without bound. */
const MAX_FIRED = 500;

function loadFired(): Set<string> {
  try {
    const raw = localStorage.getItem(FIRED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function saveFired(fired: Set<string>) {
  try {
    // Keep the most recent; the oldest reminders will never come due again.
    const list = [...fired].slice(-MAX_FIRED);
    localStorage.setItem(FIRED_KEY, JSON.stringify(list));
  } catch {
    // A full/blocked localStorage must not take the reminder loop down; the cost
    // is only that an alarm may re-fire after a restart.
  }
}

interface AlarmStore {
  /** Reminders showing in the in-app popup right now. */
  active: DueAlarm[];
  /** Snoozed reminders, waiting to come back. */
  snoozed: Snoozed[];
  /** Keys of every reminder already shown — the fire-once guard. */
  fired: Set<string>;
  started: boolean;

  /** Begin the ticker. Idempotent. */
  start: () => void;
  stop: () => void;
  /** One scan. Exposed for tests and for an immediate check after an edit. */
  tick: (now?: Date) => Promise<void>;

  dismiss: (key: string) => void;
  dismissAll: () => void;
  snooze: (key: string, minutes: number) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Whether the OS has granted notification permission (asked once, lazily). */
let osPermission: boolean | null = null;

/** A reminder as one notification's title and body — the OS toast and the
 * phone's push notice say the same thing. */
function alarmNotice(alarm: DueAlarm): { title: string; body: string } {
  const lang = useI18nStore.getState().lang;
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate(lang, key, params);
  const when = alarm.allDay
    ? t("alarms.today")
    // The imperative read, not the hook — this runs outside React, and the
    // notification is one string built once rather than a subscription.
    : formatStampTime(alarm.start, readUse24h()) || describeLead(alarm.minutesBefore, t);
  return {
    title: alarm.title || t("alarms.defaultEventTitle"),
    body: [when, alarm.location].filter(Boolean).join(" · "),
  };
}

async function notifyOs(alarm: DueAlarm) {
  try {
    if (osPermission === null) {
      osPermission = await isPermissionGranted();
      if (!osPermission) osPermission = (await requestPermission()) === "granted";
    }
    if (!osPermission) return;
    sendNotification(alarmNotice(alarm));
  } catch {
    // No OS notification (permission denied, no daemon, headless CI). The in-app
    // popup still shows, so the reminder is not lost — this channel is additive.
  }
}

/**
 * The same reminder as a push notice on every phone that switched reminders
 * on (Tabtivity Mobile's Calendar → Reminders). The sidecar holds the
 * subscriptions and encrypts per phone; with Mobile off or no phone
 * subscribed the call has nowhere to go, which is not an error here.
 */
function notifyPhone(alarm: DueAlarm) {
  const notice = alarmNotice(alarm);
  void invoke("mobile_admin", {
    request: { type: "notify", kind: "calendar", title: notice.title, body: notice.body, tag: alarm.key },
  }).catch(() => undefined);
}

/**
 * The keys of `keys` this window may show: the backend answers the ones
 * nobody had claimed. A backend without the command (an older binary under a
 * hot-reloaded `src/`), or one that fails, leaves the decision to this window
 * alone, as before the record existed.
 */
async function claimFired(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  try {
    const granted = await invoke<string[] | null>("calendar_alarms_claim", { keys });
    if (Array.isArray(granted)) return new Set(granted);
  } catch {
    // Fall through: this window decides.
  }
  return new Set(keys);
}

/**
 * The reminder engine.
 *
 * A single ticker scans the calendar for reminders that have come due and shows
 * each one **twice over**: an OS notification (which reaches the user when Tabtivity
 * is not focused, or not even visible) and an in-app popup (which offers snooze
 * and dismiss) — plus a push notice to a subscribed phone. All channels are
 * driven from one fire-once record, so a reminder cannot double-show or re-show
 * after a restart.
 */
export const useAlarmStore = create<AlarmStore>((set, get) => ({
  active: [],
  snoozed: [],
  fired: loadFired(),
  started: false,

  start: () => {
    if (get().started) return;
    set({ started: true });
    void get().tick();
    timer = setInterval(() => void get().tick(), TICK_MS);
  },

  stop: () => {
    if (timer) clearInterval(timer);
    timer = null;
    set({ started: false });
  },

  tick: async (now = new Date()) => {
    // Another Tabtivity window holds the timer lease: it fires the reminders,
    // this one does not (headless owner plan, H2 interim).
    if (!holdsTimerLease()) return;
    const { events, calendars, loaded } = useCalendarStore.getState();
    if (!loaded) return;

    const muted = mutedCalendarIds(calendars);
    const state = get();
    const { fired } = state;
    // Muting a calendar also takes down what it already has on screen or
    // snoozed — "off" that left a popup standing would not read as off.
    const active = state.active.filter((a) => !muted.has(a.calendarId));
    const snoozed = state.snoozed.filter((s) => !muted.has(s.alarm.calendarId));
    const dropped = active.length !== state.active.length || snoozed.length !== state.snoozed.length;

    // Snoozed reminders that have come back around.
    const woken = wokenSnoozes(snoozed, now);
    const stillSnoozed = snoozed.filter((s) => !woken.some((w) => w.key === s.key));

    // Expand only far enough to see every reminder that could be due.
    const window = alarmWindow(events, now);
    const occurrences = expandEvents(events, window.start, window.end);
    const allDue = dueAlarms(occurrences, fired, now);
    // Claim before showing (headless owner plan, H2): the backend's fired
    // record is shared with every other window and with the Mobile sidecar,
    // which pushes reminders to the phone while no window is open. A key
    // somebody else claimed is theirs — it still joins this window's own set
    // below, so it is never asked about again.
    const granted = await claimFired(allDue.map((a) => a.key));
    const due = allDue.filter((a) => granted.has(a.key) && !muted.has(a.calendarId));

    if (allDue.length === 0 && woken.length === 0) {
      if (dropped) set({ active, snoozed: stillSnoozed });
      return;
    }

    // Fresh reminders get both channels; a woken snooze is already known to the
    // user, so it only comes back to the popup.
    for (const alarm of due) {
      void notifyOs(alarm);
      notifyPhone(alarm);
    }

    // A muted calendar's reminders are recorded as fired without being shown:
    // switching alerts back on should not replay up to a day of stale ones.
    const nextFired = new Set(fired);
    for (const alarm of allDue) nextFired.add(alarm.key);
    saveFired(nextFired);

    const showing = [...active];
    for (const alarm of [...due, ...woken.map((w) => w.alarm)]) {
      if (!showing.some((a) => a.key === alarm.key)) showing.push(alarm);
    }

    set({ active: showing, snoozed: stillSnoozed, fired: nextFired });
  },

  dismiss: (key) => set((s) => ({ active: s.active.filter((a) => a.key !== key) })),

  dismissAll: () => set({ active: [] }),

  snooze: (key, minutes) =>
    set((s) => {
      const alarm = s.active.find((a) => a.key === key);
      if (!alarm) return s;
      return {
        active: s.active.filter((a) => a.key !== key),
        snoozed: [...s.snoozed.filter((x) => x.key !== key), makeSnooze(alarm, minutes)],
      };
    }),
}));
