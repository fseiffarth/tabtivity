import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../../lib/i18n";
import { loginIdForCmd } from "../../../lib/agents/signInLaunch";
import { AGENT_ITEMS } from "../../../lib/tabs/newTabItems";
import { UntestedTag } from "../../common/UntestedTag";
import { CheckIcon } from "../../common/icons/Icon";
import { IMPORT_CONFIG_KEY, type ImportOffer, type ImportOutcome } from "./introData";
import { IntroActions, IntroStatus } from "./introUi";

/** How the question ended in this wizard session: what an import took, or a
 *  plain no. */
export type ImportAnswer = ImportOutcome | "declined";


/**
 * Intro page 2 on a fresh install whose computer already holds agent logins
 * or agent config — "Already on this computer". The app's agents run in
 * their own homes, so they start signed out and without the user's
 * instructions; this page asks whether to bring those along. One toggle card
 * per found login and one for the config (the Goals page's cards, all on to
 * start), then Import or Don't import. Nothing is copied before one of the two
 * is pressed, and either closes the question for good
 * (`agent_import_offer_answer`); Settings → Manage CLIs keeps the per-CLI
 * import. `offer` is the question as it stood when the wizard opened; the
 * ticks (`picked`) and `answer` live in `HowToStart`, because a page is
 * unmounted when the user pages away: a login they unticked must still be
 * unticked when they come back.
 */
export function ComputerPage({
  offer,
  picked,
  onPick,
  answer,
  onAnswer,
}: {
  offer: ImportOffer;
  /** Ticked card keys: CLI ids and `IMPORT_CONFIG_KEY`. */
  picked: readonly string[];
  onPick: (picked: string[]) => void;
  answer: ImportAnswer | null;
  onAnswer: (answer: ImportAnswer) => void;
}) {
  const t = useT();
  const labels = useMemo(() => {
    const byId = new Map<string, string>();
    for (const a of AGENT_ITEMS) {
      byId.set(a.cmd, a.label);
      byId.set(loginIdForCmd(a.cmd), a.label);
    }
    return byId;
  }, []);
  const label = (id: string) => labels.get(id) ?? id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: string) => onPick(picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key]);
  const send = (logins: string[], config: boolean) => {
    setError(null);
    setBusy(true);
    invoke<ImportOutcome>("agent_import_offer_answer", { logins, config })
      .then((outcome) => onAnswer(logins.length > 0 || config ? outcome : "declined"))
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const folders = offer.config.map((dir) => `~/${dir}`).join(", ");
  const cards = [
    ...offer.logins.map((id) => ({
      key: id,
      icon: "🔑",
      title: t("intro.computer.login", { label: label(id) }),
      blurb: t("intro.computer.loginBlurb"),
    })),
    ...(offer.config.length > 0
      ? [{ key: IMPORT_CONFIG_KEY, icon: "🧩", title: t("intro.computer.config"), blurb: t("intro.computer.configBlurb", { folders }) }]
      : []),
  ];

  if (answer) {
    const outcome = answer === "declined" ? null : answer;
    return (
      <>
        {!outcome && <p className="settings-help">{t("intro.computer.declined")}</p>}
        {outcome?.logins.map((l) => (
          <p key={l.id} className="settings-help">
            <IntroStatus ok={!l.error}>
              {l.error
                ? t("intro.computer.loginFailed", { label: label(l.id), error: l.error })
                : t("intro.computer.loginDone", { label: label(l.id) })}
            </IntroStatus>
          </p>
        ))}
        {outcome?.config && (
          <p className="settings-help">
            <IntroStatus ok={true}>
              {t("intro.computer.configDone", { count: outcome.config.files + outcome.config.configs })}
            </IntroStatus>
          </p>
        )}
        {outcome?.configError && (
          <p className="settings-help">
            <IntroStatus ok={false}>{t("intro.computer.configFailed", { error: outcome.configError })}</IntroStatus>
          </p>
        )}
        <p className="settings-help">{t("intro.computer.later")}</p>
      </>
    );
  }

  return (
    <>
      <p className="settings-help">
        {t("intro.computer.lead")} <UntestedTag id="desktop.intro.computer" />
      </p>
      <div className="intro-goal-grid" role="group" aria-label={t("intro.computer.groupLabel")}>
        {cards.map((card) => {
          const on = picked.includes(card.key);
          return (
            <button
              key={card.key}
              type="button"
              className="settings-card intro-goal-card"
              aria-pressed={on}
              disabled={busy}
              onClick={() => toggle(card.key)}
            >
              <span className="intro-goal-icon" aria-hidden="true">
                {card.icon}
              </span>
              <span className="intro-goal-text">
                <span className="how-to-start-step-title">{card.title}</span>
                <span className="settings-help">{card.blurb}</span>
              </span>
              <span className="intro-goal-check" aria-hidden="true">
                {on ? <CheckIcon /> : ""}
              </span>
            </button>
          );
        })}
      </div>
      <p className="settings-help">{t("intro.computer.note")}</p>
      <IntroActions>
        {/* Not .primary: the footer's Next is this view's one primary. */}
        <button
          type="button"
          className="settings-btn"
          disabled={busy || picked.length === 0}
          onClick={() =>
            send(
              offer.logins.filter((id) => picked.includes(id)),
              picked.includes(IMPORT_CONFIG_KEY),
            )
          }
        >
          {t("intro.computer.import")}
        </button>
        <button type="button" className="settings-btn" disabled={busy} onClick={() => send([], false)}>
          {t("intro.computer.decline")}
        </button>
      </IntroActions>
      {error && <p className="settings-help">{error}</p>}
    </>
  );
}
