import { useMemo, useState } from "react";

import type { AlertItem, AlertKind, AlertSeverity } from "../../lib/alerts";
import { alertCounts, readsInHours } from "../../lib/alerts";
import { finishAlert } from "../../lib/alertDone";
import type { AlertsFeed } from "../files/useAlertsFeed";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useMailStore } from "../../stores/mail";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import { useExperimental } from "../../lib/experimental";
import { joinConference } from "../../lib/linkTarget";
import { awayDelta, type DueDelta } from "../../lib/todoBoard";
import { useT, type TranslationKey } from "../../lib/i18n";
import { BellIcon } from "../common/BellIcon";
import { CalendarIcon, CheckboxIcon, MailIcon, VideoIcon, type IconProps } from "../common/icons/Icon";
import { ErrorNote } from "../common/ErrorNote";

/**
 * The list behind the header bell's hover: urgent mail, the next appointments,
 * and the to-do cards whose due date is here or past, as one time-ordered strip.
 *
 * It used to be a group stacked under the side panel's file tree
 * (`files/AlertsSection`). The rows are machine-wide — the same ones whichever
 * project is open — so a per-project panel was the wrong home, and it cost the
 * tree its height all day for a list that is empty on a good one. It now hangs
 * off the switch that already governs it (`AlertsToggle`), the way the ☑ and 🗓
 * buttons read their cards out on hover.
 *
 * The rows come from `useAlertsFeed` (called by the toggle, so the list is warm
 * when the pointer arrives) whose selectors are `lib/alerts`' pure ones; this
 * component keeps no second copy of alert state. Opening a row hands off to the
 * owning surface, while its Done button resolves each kind on its own terms: a
 * task is completed, priority mail is returned to normal, and a calendar
 * occurrence is removed from this list without deleting the appointment.
 *
 * **Muting is the one exception, and it is not a dismissal.** A row's 🔕 hides
 * that row *in this list* and changes nothing about the thing behind it — the
 * mail stays marked urgent, the card stays due, the meeting still happens — so
 * there is no second source of truth to disagree with. It is deliberately
 * reversible and visibly so: the header keeps a 🔕 count, the reveal renders the
 * muted rows, and each carries its own unmute.
 */
interface AlertsMenuProps {
  feed: AlertsFeed;
  /** The pointer has handed off to another surface; shut the menu. */
  onNavigate: () => void;
}

/** Icon per source. The row's kind is also its `title`, so this is decoration. */
const KIND_ICON: Record<AlertKind, (p: IconProps) => React.ReactElement> = {
  mail: MailIcon,
  event: CalendarIcon,
  task: CheckboxIcon,
};

function KindIcon({ kind }: { kind: AlertKind }) {
  const Icon = KIND_ICON[kind];
  return <Icon />;
}

/**
 * `dueDeltaKey`'s counterpart for this list: the same *choice* of phrase off the
 * same measurement, pointed at this list's own wording rather than the board
 * chip's. A chip on a card is squeezed ("2d 5h late"), a row here has a column
 * for it ("2 d 5 h overdue") — only the wording differs, never which unit is
 * printed.
 */
const alertDeltaKey = (d: DueDelta): TranslationKey => {
  if (d.late) {
    if (d.unit === "d") return "filesAlerts.daysOverdue";
    if (d.unit === "dh") return "filesAlerts.daysHoursOverdue";
    return d.unit === "h" ? "filesAlerts.hoursOverdue" : "filesAlerts.minutesOverdue";
  }
  if (d.unit === "d") return "filesAlerts.inDays";
  if (d.unit === "dh") return "filesAlerts.inDaysHours";
  return d.unit === "h" ? "filesAlerts.inHours" : "filesAlerts.inMinutes";
};

export function AlertsMenu({ feed, onNavigate }: AlertsMenuProps) {
  const t = useT();
  const { enabled, items, loading, error, refresh, mutedItems, mute, unmute, unmuteAll } = feed;
  // The reveal is local and transient on purpose: it is a way to look at what
  // you silenced, not a second visibility setting to keep in step with the first.
  const [showMuted, setShowMuted] = useState(false);
  const [finishingId, setFinishingId] = useState<string | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);

  // Which surfaces can actually be raised. Each of the three is behind its own
  // switch, and a row that opened nothing would be worse than one that says why
  // it can't — `TodoAgendaRail` makes the same call about its calendar button.
  const mailClient = useExperimental("mail_client");
  const calendarApp = useSettingsStore((s) => s.settings?.calendar_global_app ?? false);
  const todoBoard = useSettingsStore((s) => s.settings?.todo_board ?? false);

  const counts = useMemo(() => alertCounts(items), [items]);

  const canOpen = (kind: AlertKind): boolean =>
    kind === "mail" ? mailClient : kind === "event" ? calendarApp : todoBoard;

  const severityLabel = (severity: AlertSeverity): string =>
    severity === "overdue"
      ? t("filesAlerts.severityOverdue")
      : severity === "now"
        ? t("filesAlerts.severityNow")
        : severity === "soon"
          ? t("filesAlerts.severitySoon")
          : t("filesAlerts.severityUpcoming");

  const kindLabel = (kind: AlertKind): string =>
    kind === "mail"
      ? t("filesAlerts.kindMail")
      : kind === "event"
        ? t("filesAlerts.kindEvent")
        : t("filesAlerts.kindTask");

  /**
   * How far off the row is, as a phrase. Units are abbreviated (`min`/`h`/`d`,
   * the shape `todo.menuLate` already uses) rather than spelled out, because a
   * plural that has to be right in five languages from one `{count}` placeholder
   * cannot be.
   *
   * **The measurement is `lib/todoBoard`'s `awayDelta`, not a second one here.**
   * The board card and the header's to-do list already print "in 2d 5h" off it,
   * and a list beside them saying "in 3 d" about the same card is one app
   * disagreeing with itself.
   *
   * What it turns on is `readsInHours`, not `allDay` — the two part exactly at
   * the **date-only card**. A card with no time is still a deadline, and the one
   * it has is the midnight its day runs out at, which is already the instant
   * `minutesAway` counts to; read in whole days it says "today" for the whole of
   * its last day and never says how much of that day is left. An all-day
   * *event* keeps the whole-day reading, because a conference day is a fact
   * about the calendar rather than an hour to make.
   *
   * `null` from the measurement is the row that has arrived rather than an error:
   * today for a whole-day stamp, this very minute for anything read in hours.
   */
  const relativeLabel = (item: AlertItem): string => {
    if (item.minutesAway === null) return t("filesAlerts.noDate");
    const hourly = readsInHours(item);
    const delta = awayDelta(item.minutesAway, item.daysAway ?? 0, !hourly);
    if (!delta) return hourly ? t("filesAlerts.rightNow") : t("filesAlerts.today");
    return t(alertDeltaKey(delta), { count: delta.count, hours: delta.hours ?? 0 });
  };

  /**
   * Hand the row off to the surface that owns it.
   *
   * Mail lands *on the message*: the priority page is loaded before the message
   * gets its tab, which is `TodoMailRail`'s order and for its reason — opening
   * resolves the header out of the loaded page, so one made before the page
   * lands opens nothing.
   *
   * The calendar has no per-event focus request in `stores/calendar/calendar`, so an
   * event row opens the calendar overlay plainly rather than inventing one. A
   * task row *can* be aimed (`openCard` → `focusTaskId`, consumed once by
   * `TodoPane`), so it is.
   */
  const openItem = async (item: AlertItem) => {
    if (!canOpen(item.kind)) return;
    onNavigate();
    if (item.kind === "mail") {
      const mail = useMailStore.getState();
      await mail.openPriority(item.source.mailPriority ?? "urgent").catch(() => {});
      mail.openInbox();
      if (item.source.mailId) mail.openMessage(item.source.mailId);
      return;
    }
    if (item.kind === "event") {
      useCalendarStore.getState().openOverlay();
      return;
    }
    if (item.source.taskId) useTodoStore.getState().openCard(item.source.taskId);
  };

  const openLabel = (kind: AlertKind): string =>
    kind === "mail"
      ? t("filesAlerts.openMail")
      : kind === "event"
        ? t("filesAlerts.openEvent")
        : t("filesAlerts.openTask");

  const closedReason = (kind: AlertKind): string =>
    kind === "mail"
      ? t("filesAlerts.mailOff")
      : kind === "event"
        ? t("filesAlerts.calendarOff")
        : t("filesAlerts.boardOff");

  const finishLabel = (kind: AlertKind): string =>
    kind === "mail"
      ? t("filesAlerts.doneMail")
      : kind === "event"
        ? t("filesAlerts.doneEvent")
        : t("filesAlerts.doneTask");

  /**
   * Resolve the item in the way its source supports.
   *
   * The three resolutions live in `lib/alertDone` rather than here, because
   * Tabtivity Mobile's Alerts rows press the same ✓ through the desktop bridge and
   * a second copy of "what Done means for a meeting" is exactly how the two
   * surfaces would start disagreeing. What stays local is the busy row and the
   * failure line — this component's chrome, not the act.
   */
  const finishItem = async (item: AlertItem) => {
    if (finishingId) return;
    setFinishingId(item.id);
    setFinishError(null);
    try {
      await finishAlert(item, mute);
    } catch {
      setFinishError(t("filesAlerts.doneFailed"));
    } finally {
      setFinishingId(null);
    }
  };

  /**
   * One row: the open button, plus its own mute/unmute — and, for a meeting with
   * a video call, a **Join** — **beside** it rather than inside it, because a
   * button nested in a button is invalid markup and, here, would also make the
   * silencer (or the door) part of the click target that opens the thing.
   *
   * The Join goes to the same place the calendar's own Join buttons do, through
   * the same `lib/calendar/conference` verdict (`item.source.conferenceUrl`,
   * computed in `lib/alerts`): a video meeting two minutes off is the one alert
   * whose point is the door, not the surface behind it. It is shown even on a
   * muted row — muting silenced the reminder, it did not cancel the meeting.
   *
   * The same renderer draws a live row and a muted one, so the two can't drift
   * into looking like different kinds of object; `muted` only swaps the trailing
   * control and adds the class that dims it.
   */
  const renderRow = (item: AlertItem, muted: boolean) => {
    const openable = canOpen(item.kind);
    const conferenceUrl = item.source.conferenceUrl;
    return (
      <div key={item.id} className={`alerts-row-wrap${muted ? " muted" : ""}`}>
        <button
          type="button"
          className="alerts-done"
          disabled={finishingId !== null}
          onClick={() => void finishItem(item)}
          title={finishLabel(item.kind)}
          aria-label={finishLabel(item.kind)}
        >
          {finishingId === item.id ? "…" : "✓"}
        </button>
        <button
          type="button"
          role="menuitem"
          className={`alerts-row ${item.severity}`}
          disabled={!openable}
          title={openable ? openLabel(item.kind) : closedReason(item.kind)}
          onClick={() => void openItem(item)}
        >
          <span
            className={`alerts-dot ${item.severity}`}
            title={severityLabel(item.severity)}
            aria-hidden
          >
            ●
          </span>
          <span className="alerts-kind" title={kindLabel(item.kind)}>
            <KindIcon kind={item.kind} />
          </span>
          <span className="alerts-text">
            <span className="alerts-row-title">{item.title}</span>
            {item.detail && <span className="alerts-detail">{item.detail}</span>}
          </span>
        </button>
        {/* The Join sits **before** the time readout: a meeting's door belongs
            next to the meeting, and the countdown ("in 4 min") is precisely the
            number that makes it worth clicking now. */}
        {conferenceUrl && (
          <button
            type="button"
            className="alerts-join"
            title={t("calendar.joinTitle", {
              provider: item.source.conferenceProvider ?? "",
            })}
            aria-label={t("calendar.joinTitle", {
              provider: item.source.conferenceProvider ?? "",
            })}
            onClick={() => joinConference(conferenceUrl)}
          >
            <VideoIcon />
            <span className="alerts-join-text">{t("calendar.join")}</span>
          </button>
        )}
        <span className={`alerts-when ${item.severity}`}>{relativeLabel(item)}</span>
        <button
          type="button"
          className="alerts-mute"
          onClick={() => (muted ? unmute(item.id) : mute(item.id))}
          title={muted ? t("filesAlerts.unmute") : t("filesAlerts.mute")}
          aria-label={muted ? t("filesAlerts.unmute") : t("filesAlerts.mute")}
        >
          <BellIcon className="alerts-bell" off={!muted} />
        </button>
      </div>
    );
  };

  return (
    <>
      {/* Pinned title + scrolling region: the unified menu shape (the accent
          rail and the wash live on the menu itself, so it must not be what
          scrolls). The count, its overdue emphasis, the muted reveal and the
          refresh ride the title row. */}
      <div className="tab-new-menu-group-label alerts-menu-head">
        <span className="alerts-title">{t("filesAlerts.title")}</span>
        {items.length > 0 && (
          <span
            className={"alerts-count" + (counts.overdue > 0 ? " overdue" : "")}
            title={t("filesAlerts.countsTitle", {
              overdue: counts.overdue,
              now: counts.now,
              soon: counts.soon,
            })}
          >
            {items.length}
          </span>
        )}
        {/* The way back. Rendered only while something muted is still live —
            with nothing silenced there is nothing to reveal, and `unmuteAll`
            below (which also clears ids whose row has gone) rides the same
            control rather than standing there permanently as a dead button. */}
        {mutedItems.length > 0 && (
          <button
            type="button"
            className={`alerts-muted-chip${showMuted ? " active" : ""}`}
            aria-pressed={showMuted}
            onClick={() => setShowMuted((v) => !v)}
            title={showMuted ? t("filesAlerts.hideMuted") : t("filesAlerts.showMuted")}
          >
            <BellIcon className="alerts-bell" off /> {mutedItems.length}
          </button>
        )}
        <button
          type="button"
          className="toolbar-btn toolbar-btn--sm alerts-menu-refresh"
          onClick={refresh}
          title={t("filesAlerts.refresh")}
        >
          ⟳
        </button>
      </div>

      <div className="menu-scroll-region">
        {error && <div className="alerts-error">{t("filesAlerts.failed")}</div>}
        {finishError && <ErrorNote className="alerts-error" error={finishError} />}

        {!enabled ? (
          <div className="tab-new-menu-hint">{t("filesAlerts.disabled")}</div>
        ) : loading && items.length === 0 ? (
          <div className="tab-new-menu-hint">{t("filesAlerts.loading")}</div>
        ) : items.length === 0 ? (
          <div className="tab-new-menu-hint">
            {error ? t("filesAlerts.emptyAfterError") : t("filesAlerts.empty")}
          </div>
        ) : (
          items.map((item) => renderRow(item, false))
        )}

        {/* The muted rows, below the live ones and visibly apart from them:
            they are what you decided *not* to be told about, so folding them
            into the same list at the same weight would undo the mute. */}
        {showMuted && mutedItems.length > 0 && (
          <div className="alerts-muted">
            <div className="alerts-muted-head">
              <span>{t("filesAlerts.mutedHeading", { count: mutedItems.length })}</span>
              <button
                type="button"
                className="alerts-muted-all"
                onClick={() => {
                  unmuteAll();
                  setShowMuted(false);
                }}
                title={t("filesAlerts.unmuteAllTitle")}
              >
                {t("filesAlerts.unmuteAll")}
              </button>
            </div>
            {mutedItems.map((item) => renderRow(item, true))}
          </div>
        )}
      </div>
    </>
  );
}
