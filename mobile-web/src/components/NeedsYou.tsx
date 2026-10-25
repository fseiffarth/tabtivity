import { useState, type ComponentType, type ReactNode } from "react";
import type { IconProps } from "../../../src/components/common/icons/Icon";
import { lastPrompt } from "../agentPrompts";
import { getActivity, resolveAlert, wasApplied, type ActivityTab, type MobileAlertItem, type MobileAlerts } from "../api";
import { describeFailure } from "../connection";
import { SECTION_ICON } from "../glyphs";
import { ageLabel } from "../terminal/fileLabels";
import { useVisiblePoll } from "../visiblePoll";
import { isUnseenDone, type SeenDone } from "../seenDone";
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

/** When the row's state began, as the desktop stamped it: a question since its
 * last output, a finished tab since its turn ended. */
function since(tab: ActivityTab): number | undefined {
  return tab.agent_status === "done" ? tab.done_at : tab.working_at ?? tab.done_at;
}

/**
 * Home's Needs you: what is waiting on the reader, above the projects, in one
 * group — agent tabs asking something or cut off, finished tabs not opened on
 * this phone yet (`seenDone.ts`), then the desktop's mail, to-do and calendar
 * alerts. Three rows, then "Show all" opens the rest in place; tabs still at
 * work are one summary row that switches to the Agents view.
 *
 * Nothing at all is drawn until there is something to show — not a heading
 * over an empty box, and not a second "loading" beside the project list's.
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
  useVisiblePoll((signal) => getActivity(signal)
    .then((body) => {
      if (signal.aborted) return;
      setTabs(Array.isArray(body.tabs) ? body.tabs : []);
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

  const listed = tabs ?? [];
  const asking = listed
    .filter((tab) => tab.agent_status === "question" || tab.agent_status === "interrupted")
    // A question first: it is the one thing that cannot go on without the
    // reader. Then the newest of each.
    .sort((a, b) => Number(b.agent_status === "question") - Number(a.agent_status === "question") || (since(b) ?? 0) - (since(a) ?? 0));
  const finished = listed
    .filter((tab) => isUnseenDone(seen, tab))
    .sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0));
  const working = listed.filter((tab) => tab.agent_status === "working").length;
  const alertItems = alerts?.enabled ? alerts.items : [];

  const rows: { key: string; node: ReactNode }[] = [
    ...[...asking, ...finished].map((tab, index) => {
      const at = since(tab);
      const asked = lastPrompt(tab);
      return {
        key: `tab-${tab.id}`,
        node: <button className="home-needs-row" disabled={!tab.available} onClick={() => open(tab.project_id, tab)}>
          {tab.agent_status && <AgentStatusMark status={tab.agent_status} />}
          <span className="home-needs-copy">
            <span className="home-needs-title">{`${tab.project_label} · ${tab.label}`}{tab.agent_status === "done" && index === asking.length && isUntested("mobile.home.seenDone") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>
            {asked && <small>{asked.text}</small>}
          </span>
          {at !== undefined && <time>{ageLabel((now - at) / 1000, t)}</time>}
        </button>,
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
          >{finishing === item.alert_id ? "…" : "✓"}</button>}
        </div>,
      };
    }),
  ];
  if (rows.length === 0 && working === 0 && !error) return null;
  const shown = expanded ? rows : rows.slice(0, CAP);
  return <section className="home-needs" aria-labelledby="home-needs-heading">
    <h2 className="home-section-head" id="home-needs-heading">{t("mobile.home.needsYou")}{isUntested("mobile.home.needsYou") && <span className="untested">{t("mobile.newTab.untested")}</span>}</h2>
    {error && <p className="mobile-alerts-error" role="alert">{error}</p>}
    <div className="home-group">
      {shown.map((row) => <div className="home-group-row" key={row.key}>{row.node}</div>)}
      {rows.length > shown.length && <button className="home-group-more" onClick={() => setExpanded(true)}>{t("mobile.home.needsShowAll", { count: rows.length })}</button>}
      {working > 0 && <button className="home-group-more" onClick={showAgents}><span aria-hidden="true" className="home-group-more-glyph">▶</span>{t("mobile.home.needsWorking", { count: working })}</button>}
    </div>
  </section>;
}
