import { useState, type ComponentType, type ReactNode } from "react";
import type { IconProps } from "../../../src/components/common/icons/Icon";
import { lastPrompt } from "../agentPrompts";
import { getActivity, holdPrompt, resolveAlert, wasApplied, type ActivityTab, type MobileAlertItem, type MobileAlerts } from "../api";
import { describeFailure } from "../connection";
import { CheckIcon, PlayMark, QuestionIcon, SECTION_ICON } from "../glyphs";
import { ageLabel } from "../terminal/fileLabels";
import { useVisiblePoll } from "../visiblePoll";
import { needsYouGroups, since } from "../needsYouGroups";
import { type SeenDone } from "../seenDone";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { AgentStatusMark } from "./AgentStatusPill";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** The Agents list's cadence: one desktop round trip per poll, and none while
 * the phone shows something else. */
const POLL_MS = 5_000;

/** Rows shown before "Show all": the group is a glance, not a second list. */
const CAP = 3;

const ALERT_ICON: Record<MobileAlertItem["kind"], ComponentType<IconProps>> = {
  mail: SECTION_ICON.mail,
  event: SECTION_ICON.calendar,
  task: SECTION_ICON.todo,
};

function relativeAlertTime(item: MobileAlertItem, t: Translate): string {
  if (item.minutes_away === undefined) return t("filesAlerts.noDate");
  if (item.all_day) {
    const days = item.days_away ?? 0;
    if (days === 0) return t("filesAlerts.today");
    const amount = t("mobile.home.alertDays", { count: Math.abs(days) });
    return days < 0 ? t("mobile.home.alertOverdue", { amount }) : t("mobile.home.alertIn", { amount });
  }
  const minutes = item.minutes_away;
  if (minutes === 0) return t("filesAlerts.rightNow");
  const abs = Math.abs(minutes);
  const amount = abs >= 1440
    ? t("mobile.home.alertDays", { count: Math.floor(abs / 1440) })
    : abs >= 60
      ? t("mobile.home.alertHours", { count: Math.floor(abs / 60) })
      : t("mobile.home.alertMinutes", { count: abs });
  return minutes < 0 ? t("mobile.home.alertOverdue", { amount }) : t("mobile.home.alertIn", { amount });
}

/** What the ✓ does to *this* row, said in the row's own terms — the desktop's
 * three labels verbatim, because it is the same act reaching the same stores.
 * None of the three deletes anything. */
const DONE_LABEL: Record<MobileAlertItem["kind"], TranslationKey> = {
  mail: "filesAlerts.doneMail",
  event: "filesAlerts.doneEvent",
  task: "filesAlerts.doneTask",
};

/** What the ▶ beside an interrupted row sends — the desktop tab strip's word
 * (`TabContinueButton`). */
const CONTINUE_PROMPT = "continue";

/**
 * Home's Needs you: what is waiting on the reader, above the projects, in one
 * group — agent tabs asking something or cut off, finished tabs not opened on
 * this phone yet (`seenDone.ts`), then the desktop's mail, to-do and calendar
 * alerts. Three rows, then "Show all" opens the rest in place.
 *
 * Above it, always, three tiles count the agent tabs waiting on the reader,
 * at work and finished unseen; each opens the Agents view, which has no
 * other door on Home. Their numbers wait for the first answer.
 *
 * The group itself is not drawn until there is something to show — not a
 * heading over an empty box, and not a second "loading" beside the project
 * list's.
 * The agent rows are the Agents view's own list (`getActivity`), polled on its
 * cadence only while this view is mounted and the page is shown.
 */
export function NeedsYou({ alerts, onAlerts, seen, open, todo, mail, showAgents }: {
  alerts: MobileAlerts | null;
  onAlerts: (alerts: MobileAlerts) => void;
  seen: SeenDone;
  open: (projectId: string, tab: ActivityTab) => void;
  todo: (card?: string) => void;
  mail: () => void;
  showAgents: () => void;
}) {
  const t = useT();
  /** Null until the first answer: no rows are guessed before it. */
  const [tabs, setTabs] = useState<ActivityTab[] | null>(null);
  /** Taken at each poll, so the ages move with the list. */
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  // The alert row being resolved, so its own ✓ can say it is working and the
  // rest go quiet: the three resolutions are desktop store writes, and two of
  // them landing at once is how a phone on bad signal ends up ticking the
  // wrong card.
  const [finishing, setFinishing] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** The desktop's AI switch: off, no ▶ is offered, as on its tab strip. */
  const [aiOff, setAiOff] = useState(false);
  // The interrupted turns a ▶ was sent for, by tab and the moment the turn was
  // cut, so the button goes until the next poll shows the new turn — and comes
  // back for a later cut of the same tab.
  const [continuing, setContinuing] = useState<string | null>(null);
  const [continued, setContinued] = useState<ReadonlySet<string>>(() => new Set());
  useVisiblePoll((signal) => getActivity(signal)
    .then((body) => {
      if (signal.aborted) return;
      setTabs(Array.isArray(body.tabs) ? body.tabs : []);
      setAiOff(body.ai_off === true);
      setNow(Date.now());
    })
    // Keep the last answer: the project list's own notice says the link
    // is down, and one dropped packet should not empty the group.
    .catch(() => undefined), POLL_MS);
  const finish = async (alertId: string) => {
    if (finishing) return;
    setFinishing(alertId);
    setError("");
    try {
      // The desktop answers with the feed as it stands afterwards, so the list
      // is replaced rather than patched here: what a ✓ removes is the desktop's
      // to decide, and a card that reappears because it was only 90% done is a
      // truth the phone should show rather than hide.
      onAlerts((await resolveAlert(alertId)).alerts);
    } catch (reason) {
      // Done on the desktop with a feed too large to show is not a failed ✓.
      setError(wasApplied(reason) ? describeFailure(reason) : t("mobile.failure.alertResolveFailed"));
    } finally {
      setFinishing(null);
    }
  };

  const resume = async (tab: ActivityTab, key: string) => {
    if (continuing) return;
    setContinuing(key);
    setError("");
    try {
      // Held, not typed: the desktop types it at the tab's next safe idle
      // point, which for a cut-off turn is now.
      await holdPrompt(tab.id, CONTINUE_PROMPT);
      setContinued((keys) => new Set(keys).add(key));
    } catch (reason) {
      setError(t("mobile.home.continueFailed", { reason: describeFailure(reason) }));
    } finally {
      setContinuing(null);
    }
  };

  const listed = tabs ?? [];
  const { asking, finished } = needsYouGroups(listed, seen);
  const working = listed.filter((tab) => tab.agent_status === "working").length;
  const alertItems = alerts?.enabled ? alerts.items : [];

  const rows: { key: string; node: ReactNode }[] = [
    ...[...asking, ...finished].map((tab, index) => {
      const at = since(tab);
      const asked = lastPrompt(tab);
      const resumeKey = `${tab.id}:${at ?? ""}`;
      const offerContinue = tab.agent_status === "interrupted" && tab.available && !aiOff && !continued.has(resumeKey);
      const row = <button className="home-needs-row" disabled={!tab.available} onClick={() => open(tab.project_id, tab)}>
        {tab.agent_status && <AgentStatusMark status={tab.agent_status} />}
        <span className="home-needs-copy">
          <span className="home-needs-title">{`${tab.project_label} · ${tab.label}`}{tab.agent_status === "done" && index === asking.length && isUntested("mobile.home.seenDone") && <span className="untested">{t("mobile.newTab.untested")}</span>}{offerContinue && isUntested("mobile.home.continue") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>
          {asked && <small>{asked.text}</small>}
        </span>
        {at !== undefined && <time>{ageLabel((now - at) / 1000, t)}</time>}
      </button>;
      return {
        key: `tab-${tab.id}`,
        // The ▶ sits beside the row, as the alerts' ✓ does: sending
        // "continue" is not the tap that opens the tab.
        node: offerContinue
          ? <div className="mobile-alert-row-wrap">
            {row}
            <button
              className="home-needs-continue"
              disabled={continuing !== null}
              onClick={() => void resume(tab, resumeKey)}
              title={t("tabBar.continueTitle")}
              aria-label={t("tabBar.continueTitle")}
            ><span aria-hidden="true"><PlayMark /></span>{continuing === resumeKey ? "…" : t("tabBar.continue")}</button>
          </div>
          : row,
      };
    }),
    ...alertItems.map((item, index) => {
      // A card row opens *its own* card: the alert has already named the one
      // thing that needs attention, and a board of forty is where finding it
      // again costs the search the row exists to save. A row the desktop
      // could not resolve to a card still opens the board.
      const openAlert = item.kind === "mail"
        ? mail
        : item.kind === "task"
          ? () => todo(item.task_id)
          : undefined;
      const AlertIcon = ALERT_ICON[item.kind];
      const contents = <>
        <span className={`mobile-alert-dot ${item.severity}`} aria-hidden="true" />
        <span className="mobile-alert-icon" aria-hidden="true"><AlertIcon /></span>
        <span className="mobile-alert-copy"><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span>
        <time>{relativeAlertTime(item, t)}</time>
      </>;
      // The ✓ sits **beside** the row rather than inside it, for the desktop
      // strip's reason: a button nested in a button is invalid markup, and it
      // would also make finishing the thing part of the tap that opens it.
      // A row the desktop minted no handle for keeps its opener and loses only
      // the ✓ — there is nothing honest to send back for it.
      return {
        key: item.alert_id ?? `${item.kind}-${item.at ?? ""}-${item.title}-${index}`,
        node: <div className="mobile-alert-row-wrap">
          {openAlert
            ? <button className="mobile-alert-row" onClick={openAlert}>{contents}</button>
            : <div className="mobile-alert-row">{contents}</div>}
          {item.alert_id && <button
            className="mobile-alert-done"
            disabled={finishing !== null}
            onClick={() => void finish(item.alert_id as string)}
            title={t(DONE_LABEL[item.kind])}
            aria-label={t(DONE_LABEL[item.kind])}
          >{finishing === item.alert_id ? "…" : <CheckIcon size="1em" />}</button>}
        </div>,
      };
    }),
  ];
  const shown = expanded ? rows : rows.slice(0, CAP);
  const tiles: { key: string; count: number; label: TranslationKey; glyph: ReactNode }[] = [
    { key: "waiting", count: asking.length, label: "mobile.home.glanceWaiting", glyph: <QuestionIcon size="1em" /> },
    { key: "working", count: working, label: "mobile.home.glanceWorking", glyph: <PlayMark /> },
    { key: "done", count: finished.length, label: "mobile.home.glanceDone", glyph: <CheckIcon size="1em" /> },
  ];
  const glance = <nav className="home-glance" aria-label={t("mobile.home.glance")}>
    {tiles.map((tile) => <button key={tile.key} className={`home-glance-tile ${tile.key}${tile.count > 0 ? " lit" : ""}`} aria-label={tabs ? t("mobile.home.glanceCount", { label: t(tile.label), count: tile.count }) : t(tile.label)} onClick={showAgents}>
      <span className="home-glance-top">
        <strong>{tabs ? tile.count : ""}</strong>
        <span className="home-glance-glyph" aria-hidden="true">{tile.glyph}</span>
      </span>
      <span className="home-glance-label">{t(tile.label)}</span>
    </button>)}
    {isUntested("mobile.home.glance") && <span className="untested">{t("mobile.newTab.untested")}</span>}
  </nav>;
  if (rows.length === 0 && !error) return glance;
  return <>{glance}<section className="home-needs" aria-labelledby="home-needs-heading">
    <h2 className="home-section-head" id="home-needs-heading">{t("mobile.home.needsYou")}{isUntested("mobile.home.needsYou") && <span className="untested">{t("mobile.newTab.untested")}</span>}</h2>
    {error && <p className="mobile-alerts-error" role="alert">{error}</p>}
    <div className="home-group">
      {shown.map((row) => <div className="home-group-row" key={row.key}>{row.node}</div>)}
      {rows.length > shown.length && <button className="home-group-more" onClick={() => setExpanded(true)}>{t("mobile.home.needsShowAll", { count: rows.length })}</button>}
    </div>
  </section></>;
}
