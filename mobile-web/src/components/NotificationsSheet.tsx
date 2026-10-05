import { useEffect, useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { describeFailure } from "../connection";
import {
  disablePush,
  enablePush,
  getPushState,
  notificationPermission,
  pushSupport,
  wantsAny,
  type AgentNotices,
  type HostPushState,
  type PushPrefs,
} from "../push";

/** A summary line for the Home row: what this phone is told about. */
export function pushSummary(host: HostPushState | null, t: ReturnType<typeof useT>): string {
  if (!host?.subscribed || !wantsAny(host)) return t("mobile.push.off");
  const parts: string[] = [];
  if (host.calendar) parts.push(t("mobile.push.summaryCalendar"));
  if (host.agents === "questions") parts.push(t("mobile.push.summaryQuestions"));
  if (host.agents === "all") parts.push(t("mobile.push.summaryAgents"));
  return parts.join(" · ");
}

interface Choice { key: string; label: string; note?: string; current: boolean }

function Group({ heading, choices, busy, onPick }: { heading: string; choices: Choice[]; busy: boolean; onPick: (key: string) => void }) {
  return <section className="notifications-group" aria-label={heading}>
    <h3>{heading}</h3>
    <ul className="option-list">{choices.map((choice) => <li key={choice.key}>
      <button className={choice.current ? "current" : ""} aria-current={choice.current || undefined} disabled={busy} onClick={() => onPick(choice.key)}>
        <span><strong>{choice.label}</strong>{choice.note && <small>{choice.note}</small>}</span>
        {choice.current && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
      </button>
    </li>)}</ul>
  </section>;
}

const AGENT_CHOICES: { key: AgentNotices; label: TranslationKey }[] = [
  { key: "off", label: "mobile.push.off" },
  { key: "questions", label: "mobile.push.agentsQuestions" },
  { key: "all", label: "mobile.push.agentsAll" },
];

/**
 * What this phone is notified about, even with Tabtivity Mobile closed: calendar
 * reminders, agent tabs waiting on an answer (and, if asked, finished turns),
 * and whether a notification names what it is about. Choosing nothing is the
 * same as off, and unsubscribes the browser.
 */
export function NotificationsSheet({ onClose, onChange }: { onClose: () => void; onChange?: (host: HostPushState) => void }) {
  const t = useT();
  const support = pushSupport();
  const [host, setHost] = useState<HostPushState | null>(null);
  // Before anything is on, the details choice is only a local draft: there is
  // no subscription to store it on yet.
  const [draftDetails, setDraftDetails] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (support !== "supported") return;
    getPushState().then(setHost, (e: unknown) => setError(describeFailure(e)));
  }, [support]);

  const subscribed = host?.subscribed === true && wantsAny(host);
  const prefs: PushPrefs = subscribed && host
    ? { details: host.details, calendar: host.calendar, agents: host.agents }
    : { details: draftDetails, calendar: false, agents: "off" };
  // Straight from the tap: the permission prompt is refused outside a gesture.
  const apply = (change: Partial<PushPrefs>) => {
    const next = { ...prefs, ...change };
    if (!subscribed && !wantsAny(next)) {
      setDraftDetails(next.details);
      return;
    }
    setBusy(true);
    setError("");
    (wantsAny(next) ? enablePush(next) : disablePush())
      .then((state) => { setHost(state); onChange?.(state); }, (e: unknown) => setError(describeFailure(e)))
      .finally(() => setBusy(false));
  };

  const note = error ? { text: error, error: true }
    : support === "needs-install" ? { text: t("mobile.push.needsInstall") }
      : support === "unsupported" ? { text: t("mobile.push.unsupported") }
        : notificationPermission() === "denied" ? { text: t("mobile.push.blocked"), error: true }
          : { text: t("mobile.push.note") };
  const ready = support === "supported" && host !== null;

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet notifications-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.push.title")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.push.close")}>✕</button>
        <h2>{t("mobile.push.title")}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      <p className={note.error ? "sheet-note error" : "sheet-note"} role={note.error ? "alert" : undefined}>{note.text}</p>
      {ready ? <>
        <Group heading={t("mobile.push.calendar")} busy={busy} onPick={(key) => apply({ calendar: key === "on" })} choices={[
          { key: "on", label: t("mobile.push.on"), current: prefs.calendar },
          { key: "off", label: t("mobile.push.off"), current: !prefs.calendar },
        ]} />
        <Group heading={t("mobile.push.agents")} busy={busy} onPick={(key) => apply({ agents: key as AgentNotices })} choices={AGENT_CHOICES.map((choice) => ({
          key: choice.key, label: t(choice.label), current: prefs.agents === choice.key,
        }))} />
        <Group heading={t("mobile.push.shows")} busy={busy} onPick={(key) => apply({ details: key === "details" })} choices={[
          { key: "details", label: t("mobile.push.showDetails"), note: t("mobile.push.showDetailsNote"), current: prefs.details },
          { key: "bare", label: t("mobile.push.showBare"), note: t("mobile.push.showBareNote"), current: !prefs.details },
        ]} />
      </> : support === "supported" && !error && <p className="sheet-note">{t("mobile.push.loading")}</p>}
    </section>
  </div>;
}
