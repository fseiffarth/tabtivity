import { useEffect, useMemo, useRef, useState } from "react";
import type { Calendar } from "../../types";
import { calendarSyncStatus, useCalDavStore } from "../../stores/calendar/caldav";
import { caldavErrorText } from "../../lib/calendar/caldav";
import { addMonths, datePart, monthGrid, monthName, todayStr, weekdayLabel } from "../../lib/calendar/calendarTime";
import { useI18nStore, useT } from "../../lib/i18n";
import { BellIcon } from "../common/BellIcon";
import { UntestedTag } from "../common/UntestedTag";
import { LinkIcon, LockIcon } from "../common/icons/Icon";

/** The palette a new calendar picks from. */
const CALENDAR_COLORS = [
  "#4aa3df", "#e8663d", "#59b96a", "#c164d6",
  "#e2b93b", "#d9556b", "#4fc3c3", "#8d8fd6",
];

/** How long a picked colour sits on the swatch before it is written. */
const COLOR_COMMIT_MS = 250;

/**
 * A stored colour as the native swatch can render it.
 *
 * The grid draws `Calendar.color` as plain CSS, which accepts far more than the
 * `#rrggbb` an `<input type="color">` does — and an unacceptable value renders
 * as **black**, i.e. as a colour the calendar does not have. `#rgb` and the
 * `#rrggbbaa` a CalDAV server sends are widened/trimmed rather than dropped;
 * anything else keeps the palette's own neutral instead of black.
 */
function swatchColor(raw: string): string {
  const value = (raw || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{8}$/i.test(value)) return value.slice(0, 7);
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return CALENDAR_COLORS[CALENDAR_COLORS.length - 1];
}

interface Props {
  calendars: Calendar[];
  /** The date the mini-month highlights and navigates from. */
  selected: string;
  onSelect: (date: string) => void;
  onToggleVisible: (id: string) => void;
  onCreateCalendar: (name: string, color: string) => void;
  onUpdateCalendar: (calendar: Calendar) => void;
  onDeleteCalendar: (id: string) => void;
  /** Create a calendar subscribed to a read-only ICS feed URL and import it. */
  onSubscribeCalendar: (name: string, url: string) => void;
  /** Re-fetch a subscribed calendar's feed and replace its events with it. */
  onRefreshCalendar: (id: string) => void;
  /** Sync a CalDAV-backed calendar now (the forcing kind — it skips the ctag
   *  check, because a user clicking Sync after fixing something on the server
   *  should not be told "nothing changed" by a token). */
  onSyncCaldav: (calendarId: string) => void;
  /** Open the CalDAV account manager. */
  onOpenCaldav: () => void;
  weekStart: 0 | 1;
}

/**
 * The left rail: a mini-month for jumping around, and the calendar list.
 *
 * Unchecking a calendar hides its events everywhere (the checkbox writes through
 * to `visible` on disk, so the choice survives a restart — same as Thunderbird).
 */
export function CalendarSidebar({
  calendars,
  selected,
  onSelect,
  onToggleVisible,
  onCreateCalendar,
  onUpdateCalendar,
  onDeleteCalendar,
  onSubscribeCalendar,
  onRefreshCalendar,
  onSyncCaldav,
  onOpenCaldav,
  weekStart,
}: Props) {
  const t = useT();
  // A CalDAV-backed calendar gets its own affordance rather than the ICS feed's
  // ↻: the two are the same *kind* of action ("go get the latest from wherever
  // this came from") but not the same path, and a failed unattended sync has to
  // be visible on the row rather than only inside a dialog nobody has open.
  const caldavAccounts = useCalDavStore((s) => s.accounts);
  const caldavStatus = useCalDavStore((s) => s.status);
  const lang = useI18nStore((s) => s.lang);
  // The mini-month browses independently of the main view's anchor, so you can
  // look ahead without moving what you are working on until you click a day.
  const [browse, setBrowse] = useState(() => datePart(selected));
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [subName, setSubName] = useState("");
  const [subUrl, setSubUrl] = useState("");
  // The colour a row's swatch is *showing*, while it differs from the stored one.
  // See `pickColor` — a picked colour has to be on the input before the store
  // knows about it, or the picker and React fight over the element.
  const [draftColor, setDraftColor] = useState<Record<string, string>>({});
  const colorTimers = useRef<Record<string, number>>({});

  const today = todayStr();
  const year = Number(browse.slice(0, 4));
  const month = Number(browse.slice(5, 7));

  const weeks = useMemo(
    () => monthGrid(year, month, weekStart, 6),
    [year, month, weekStart],
  );

  const labels = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => weekdayLabel(lang, i, "narrow"));
    return [...days.slice(weekStart), ...days.slice(0, weekStart)];
  }, [weekStart, lang]);

  // Drop a draft the moment the store agrees with it, so a colour changed
  // elsewhere (a CalDAV sync, another window) still reaches the swatch.
  useEffect(() => {
    setDraftColor((drafts) => {
      let next = drafts;
      for (const cal of calendars) {
        if (drafts[cal.id] === undefined || drafts[cal.id] !== cal.color) continue;
        if (next === drafts) next = { ...drafts };
        delete next[cal.id];
      }
      return next;
    });
  }, [calendars]);

  useEffect(() => {
    const timers = colorTimers.current;
    return () => {
      for (const id of Object.keys(timers)) window.clearTimeout(timers[id]);
    };
  }, []);

  /**
   * A colour pick is a **gesture**, not one event: the picker stays open and
   * reports every movement, and writing the element's value back between those
   * reports is echoed straight back as another pick. A controlled input does
   * exactly that — the store write is a round trip through the backend, so React
   * re-asserts the *old* colour in the gap — and the two then ping-pong until
   * one of them lands last: the swatch showing the colour that was replaced
   * while the calendar (and disk) keep the new one.
   *
   * So the swatch renders the picked colour immediately, from a local draft, and
   * the store write trails it — which also spares `calendar.json` one write per
   * movement of the picker.
   */
  function pickColor(cal: Calendar, color: string) {
    setDraftColor((drafts) => ({ ...drafts, [cal.id]: color }));
    window.clearTimeout(colorTimers.current[cal.id]);
    colorTimers.current[cal.id] = window.setTimeout(() => {
      delete colorTimers.current[cal.id];
      onUpdateCalendar({ ...cal, color });
    }, COLOR_COMMIT_MS);
  }

  function submitNew() {
    const name = newName.trim();
    if (!name) return;
    // Cycle the palette so a fresh calendar never collides with the last one.
    onCreateCalendar(name, CALENDAR_COLORS[calendars.length % CALENDAR_COLORS.length]);
    setNewName("");
    setAdding(false);
  }

  function submitSubscribe() {
    const url = subUrl.trim();
    if (!url) return;
    const name = subName.trim() || url;
    onSubscribeCalendar(name, url);
    setSubName("");
    setSubUrl("");
    setSubscribing(false);
  }

  return (
    <div className="cal-sidebar">
      <div className="cal-mini">
        <div className="cal-mini-head">
          <button
            className="cal-nav-btn"
            onClick={() => setBrowse(addMonths(browse, -1))}
            title={t("calendarSidebar.prevMonthTitle")}
          >
            ‹
          </button>
          <span className="cal-mini-title">{monthName(lang, month)} {year}</span>
          <button
            className="cal-nav-btn"
            onClick={() => setBrowse(addMonths(browse, 1))}
            title={t("calendarSidebar.nextMonthTitle")}
          >
            ›
          </button>
        </div>

        <div className="cal-mini-weekdays">
          {labels.map((w, i) => (
            <span key={i} className="cal-mini-weekday">{w}</span>
          ))}
        </div>

        {weeks.map((week, wi) => (
          <div key={wi} className="cal-mini-week">
            {week.map((date) => {
              const inMonth = Number(date.slice(5, 7)) === month;
              const classes = ["cal-mini-day"];
              if (!inMonth) classes.push("cal-mini-day-out");
              if (date === today) classes.push("cal-mini-day-today");
              if (date === datePart(selected)) classes.push("cal-mini-day-selected");
              return (
                <button
                  key={date}
                  className={classes.join(" ")}
                  onClick={() => onSelect(date)}
                >
                  {Number(date.slice(8, 10))}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="cal-list">
        <div className="cal-list-head">
          {/* The per-calendar bell's pill sits on the title, once: inside every
              row's bell it took the width the calendar's name needed. */}
          <span className="cal-list-title">
            {t("calendarSidebar.calendarsTitle")} <UntestedTag id="calendarSidebar.alerts" />
          </span>
          {/* Title and actions sit on separate rows: three actions beside the
              title overflowed the 190px sidebar and clipped the last one. */}
          <div className="cal-list-actions">
            <button
              className={`cal-chip${adding ? " cal-chip-on" : ""}`}
              aria-pressed={adding}
              onClick={() => setAdding((a) => !a)}
            >
              {t("calendarSidebar.newButton")}
            </button>
            <button
              className={`cal-chip${subscribing ? " cal-chip-on" : ""}`}
              aria-pressed={subscribing}
              onClick={() => setSubscribing((s) => !s)}
            >
              <LinkIcon /> {t("calendarSidebar.subscribeButton")}
            </button>
            <button
              className="cal-chip"
              onClick={onOpenCaldav}
              title={t("caldav.manageAccountsTitle")}
            >
              <LockIcon /> {t("caldav.accountsButton")}
            </button>
          </div>
        </div>

        {adding ? (
          <div className="cal-list-add">
            <input
              className="cal-input"
              type="text"
              placeholder={t("calendarSidebar.namePlaceholder")}
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNew();
                if (e.key === "Escape") {
                  setAdding(false);
                  setNewName("");
                }
              }}
            />
            <button className="cal-btn cal-btn-primary" disabled={!newName.trim()} onClick={submitNew}>
              {t("common.add")}
            </button>
          </div>
        ) : null}

        {subscribing ? (
          <div className="cal-list-add cal-list-subscribe">
            <input
              className="cal-input"
              type="text"
              placeholder={t("calendarSidebar.subscribeNamePlaceholder")}
              autoFocus
              value={subName}
              onChange={(e) => setSubName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSubscribing(false);
                  setSubName("");
                  setSubUrl("");
                }
              }}
            />
            <input
              className="cal-input"
              type="url"
              placeholder={t("calendarSidebar.subscribeUrlPlaceholder")}
              value={subUrl}
              onChange={(e) => setSubUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitSubscribe();
                if (e.key === "Escape") {
                  setSubscribing(false);
                  setSubName("");
                  setSubUrl("");
                }
              }}
            />
            <button className="cal-btn cal-btn-primary" disabled={!subUrl.trim()} onClick={submitSubscribe}>
              {t("common.add")}
            </button>
          </div>
        ) : null}

        {calendars.map((cal) => (
          <div key={cal.id} className="cal-list-row">
            <input
              type="checkbox"
              checked={cal.visible}
              onChange={() => onToggleVisible(cal.id)}
              title={cal.visible ? t("calendarSidebar.hideCalendarTitle") : t("calendarSidebar.showCalendarTitle")}
            />

            {/* The swatch is painted by the label's own background, not by the
                native colour well: in the live window the well stayed white
                while the calendar took the picked colour everywhere else. The
                input still sits on top, invisible, as the click target. */}
            <label
              className="cal-color-dot"
              style={{ background: swatchColor(draftColor[cal.id] ?? cal.color) }}
              title={t("calendarSidebar.colorTitle")}
            >
              <input
                type="color"
                // `<input type="color">` takes only `#rrggbb`; anything else (a
                // CalDAV `#rrggbbaa` that slipped through, an empty string) makes
                // it render black, which is a colour the calendar does not have.
                value={swatchColor(draftColor[cal.id] ?? cal.color)}
                aria-label={t("calendarSidebar.colorTitle")}
                onChange={(e) => pickColor(cal, e.target.value)}
              />
            </label>

            {editing === cal.id ? (
              <input
                className="cal-input cal-list-rename"
                type="text"
                autoFocus
                defaultValue={cal.name}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== cal.name) onUpdateCalendar({ ...cal, name });
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span
                className={`cal-list-name${cal.visible ? "" : " cal-list-name-off"}`}
                onDoubleClick={() => setEditing(cal.id)}
                title={t("calendarSidebar.renameHintTitle")}
              >
                {cal.name}
              </span>
            )}

            {/* Reminders on/off for this calendar. Always shown, on or off; the
                header's own bell, struck through when off — a mute nobody can see is a missed meeting. */}
            <button
              className={`cal-link-btn cal-list-refresh cal-list-alerts${cal.alerts_off ? " cal-list-alerts-off" : ""}`}
              aria-pressed={!cal.alerts_off}
              title={cal.alerts_off ? t("calendarSidebar.alertsOffTitle") : t("calendarSidebar.alertsOnTitle")}
              onClick={() => onUpdateCalendar({ ...cal, alerts_off: !cal.alerts_off })}
            >
              <BellIcon className="cal-list-alerts-icon" off={cal.alerts_off} />
            </button>

            {cal.source_url ? (
              <button
                className="cal-link-btn cal-list-refresh"
                title={t("calendarSidebar.refreshCalendarTitle")}
                onClick={() => onRefreshCalendar(cal.id)}
              >
                ↻
              </button>
            ) : null}

            {(() => {
              const sync = calendarSyncStatus(caldavStatus, caldavAccounts, cal.id);
              if (!sync) return null;
              const failed = sync.phase === "error";
              return (
                <button
                  className={`cal-link-btn cal-list-refresh${failed ? " cal-list-sync-error" : ""}`}
                  // The error is the button's own tooltip, verbatim from the
                  // backend: an amber mark that cannot say why is a mark the
                  // user can only respond to by opening things at random.
                  title={
                    failed
                      ? t("caldav.syncFailedTitle", { error: caldavErrorText(sync.error, t) })
                      : sync.at
                        ? t("caldav.syncedAtTitle", { at: sync.at })
                        : t("caldav.syncNowTitle")
                  }
                  onClick={() => onSyncCaldav(cal.id)}
                >
                  {sync.phase === "syncing" ? "…" : failed ? "!" : "⇅"}
                </button>
              );
            })()}

            {/* The last calendar cannot be deleted — the store always keeps one. */}
            {calendars.length > 1 ? (
              <button
                className="cal-link-btn cal-link-danger cal-list-del"
                title={t("calendarSidebar.deleteCalendarTitle")}
                onClick={() => onDeleteCalendar(cal.id)}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
