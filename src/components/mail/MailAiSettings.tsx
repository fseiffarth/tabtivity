import { useState, type ReactNode } from "react";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { useMailStore } from "../../stores/mail";
import {
  mailAccountSetAi,
  mailAiClassifyApply,
  mailAiErrorKey,
  mailAiPrefOn,
  mailAiResolvable,
} from "../../lib/mail";
import type { MailAccount, MailAiClassifyReport, MailAiPrefs } from "../../types/mail";
import { ErrorNote } from "../common/ErrorNote";

/**
 * The **Mail AI (local)** settings section (Group Q #203), now **per account**.
 *
 * The toggles are opt-in and default off — except Autocomplete, which reads on
 * until turned off (`mailAiPrefOn`) — each additionally gated by the
 * global master switch `mail_ai_allow` and a resolvable loopback mail-role model
 * (`mailAiResolvable`) — the toggles are disabled with a stated reason when the
 * path is not resolvable, because a switch that turns on a feature that cannot
 * run is a switch that lies.
 *
 * It writes the *account's* `ai` prefs (`mailAccountSetAi`), never global
 * settings, and reloads the account list so every surface that reads a toggle
 * (the message-view actions, the composer, the toolbar tags) updates at once.
 *
 * It also hosts the manual **"what would the model catch"** preview (#205), run
 * over this account.
 *
 * Two hosts render this one section: a dialog raised from the mail toolbar
 * (`MailAiSettingsDialog`) and — on creating a new account — the same dialog.
 * `embedded` drops the section title, because the dialog's title row carries it.
 */

/** One per-account toggle: its `MailAiPrefs` key and its label/help/tag keys. */
interface AiItem {
  key: keyof MailAiPrefs;
  label: TranslationKey;
  help: TranslationKey;
  /** The short chip label used by {@link MailAiQuickTags}. */
  tag: TranslationKey;
}

const AI_ITEMS: readonly AiItem[] = [
  {
    key: "summarize",
    label: "mailAi.toggleSummarize",
    help: "mailAi.toggleSummarizeHelp",
    tag: "mailAi.tagSummarize",
  },
  {
    key: "autoclassify",
    label: "mailAi.toggleAutoclassify",
    help: "mailAi.toggleAutoclassifyHelp",
    tag: "mailAi.tagAutoclassify",
  },
  {
    key: "formalize",
    label: "mailAi.toggleFormalize",
    help: "mailAi.toggleFormalizeHelp",
    tag: "mailAi.tagFormalize",
  },
  {
    key: "autocomplete",
    label: "mailAi.toggleAutocomplete",
    help: "mailAi.toggleAutocompleteHelp",
    tag: "mailAi.tagAutocomplete",
  },
  {
    key: "calendar",
    label: "mailAi.toggleCalendar",
    help: "mailAi.toggleCalendarHelp",
    tag: "mailAi.tagCalendar",
  },
  { key: "todo", label: "mailAi.toggleTodo", help: "mailAi.toggleTodoHelp", tag: "mailAi.tagTodo" },
  {
    key: "auto_create",
    label: "mailAi.toggleAutoCreate",
    help: "mailAi.toggleAutoCreateHelp",
    tag: "mailAi.tagAutoCreate",
  },
];

/** Apply one patch to an account's `ai` prefs and reload the account list so
 *  every reader (message actions, composer, tags, dialog) sees it at once. */
async function patchAi(account: MailAccount, patch: Partial<MailAiPrefs>): Promise<void> {
  const ai: MailAiPrefs = { ...(account.ai ?? {}), ...patch };
  await mailAccountSetAi(account.id, ai);
  await useMailStore.getState().reloadAccounts(account.id);
}

function AiToggle({
  label,
  help,
  checked,
  disabled,
  untested,
  onChange,
}: {
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  untested?: ReactNode;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="settings-toggle-card">
      <label className="settings-toggle-card-row">
        <span>{label} {untested}</span>
        <Toggle checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      </label>
      <p className="settings-help">{help}</p>
    </div>
  );
}

export function MailAiSettings({
  account,
  embedded = false,
}: {
  account: MailAccount;
  embedded?: boolean;
}) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const resolvable = mailAiResolvable(settings);
  const disabled = !resolvable;

  const [report, setReport] = useState<MailAiClassifyReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const set = (key: keyof MailAiPrefs) => (on: boolean) =>
    void patchAi(account, { [key]: on }).catch((err) => {
      const k = mailAiErrorKey(err);
      setError(k ? t(k) : typeof err === "string" ? err : String(err));
    });

  const runPreview = async () => {
    setRunning(true);
    setError("");
    setReport(null);
    try {
      const r = await mailAiClassifyApply(true, { accountId: account.id });
      setReport(r);
    } catch (err) {
      const key = mailAiErrorKey(err);
      setError(key ? t(key) : typeof err === "string" ? err : String(err));
    } finally {
      setRunning(false);
    }
  };

  const priorityLabel = (p: string) =>
    p === "urgent" ? t("mailAi.priorityUrgent") : t("mailAi.priorityImportant");

  const item = (key: keyof MailAiPrefs) => AI_ITEMS.find((i) => i.key === key) as AiItem;
  const toggle = (key: keyof MailAiPrefs) => {
    const it = item(key);
    return (
      <AiToggle
        label={t(it.label)}
        help={t(it.help)}
        checked={mailAiPrefOn(account, key)}
        disabled={disabled}
        untested={key === "autocomplete" ? <UntestedTag id="mail.autocomplete" /> : undefined}
        onChange={set(key)}
      />
    );
  };

  return (
    <>
      {!embedded && (
        <div className="settings-section-title">
          {t("mailAi.settingsTitle")} <UntestedTag id="mailAi.settingsTitle" />
        </div>
      )}
      <p className="settings-help">{t("mailAi.settingsHelp")}</p>
      {/* This section writes the *account's* prefs, so it names the account it is
          about — two accounts' settings look identical otherwise. */}
      <p className="settings-help">{t("mailAi.perAccount", { account: account.label || account.address })}</p>
      {!resolvable && <p className="settings-help mail-ai-unavailable">{t("mailAi.unavailable")}</p>}

      {toggle("summarize")}
      {toggle("autoclassify")}

      {/* The manual "what would this catch" preview — a dry run of the same
          classifier the sync uses, rendered distinctly from the keyword-filter
          report so the model's suggestions never pass for the user's rules. */}
      <div className="mail-ai-preview">
        <button
          type="button"
          className="settings-btn"
          disabled={disabled || running}
          onClick={() => void runPreview()}
        >
          {running ? t("mailAi.classifyRunning") : t("mailAi.classifyPreview")}
        </button>
        {error && <ErrorNote className="project-dialog-error" error={error} />}
        {report && (
          <div className="mail-ai-report">
            <div className="mail-ai-report-head">
              <strong>{t("mailAi.classifyReportTitle")}</strong>
              <UntestedTag id="mailAiSettings.1" />
            </div>
            <p className="settings-help">{t("mailAi.classifyDistinct")}</p>
            <p className="settings-help">
              {t("mailAi.classifyScanned", { count: report.scanned })}
            </p>
            {report.matched.length === 0 ? (
              <p className="settings-help">{t("mailAi.classifyNone")}</p>
            ) : (
              <>
                <p className="settings-help">
                  {t("mailAi.classifyMatched", { count: report.matched.length })}
                </p>
                <ul className="mail-ai-report-list">
                  {report.matched.map((m) => (
                    <li key={m.message_id} className="mail-ai-report-row">
                      <span className={`mail-ai-report-mark ${m.priority}`}>
                        {priorityLabel(m.priority)}
                      </span>
                      <span className="mail-ai-report-reason">{m.reason}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {toggle("formalize")}
      {/* The one toggle that is on until turned off: ghost text writes nothing
          and sends nothing, and still needs the master switch and a model. */}
      {toggle("autocomplete")}
      {toggle("calendar")}
      {toggle("todo")}
      {/* The one flag that removes the review step from #207/#208 — off by
          default, so extraction otherwise prefills a dialog for one click. */}
      {toggle("auto_create")}
    </>
  );
}

/**
 * The toolbar's **quick-toggle tags**: one clickable chip per per-account Mail
 * AI feature, click to activate / click to deactivate — the fast path that does
 * not open the settings dialog.
 *
 * Rendered only when the global master switch is on (its caller gates it), and
 * each chip is disabled with a tooltip when the path is not resolvable, for the
 * same "a control that cannot act must not pretend it can" reason the dialog's
 * toggles are disabled.
 */
export function MailAiQuickTags({ account }: { account: MailAccount }) {
  const t = useT();
  const resolvable = useSettingsStore((s) => mailAiResolvable(s.settings));

  return (
    <div className="mail-ai-tags" role="group" aria-label={t("mailAi.settingsTitle")}>
      {AI_ITEMS.map((it) => {
        const on = mailAiPrefOn(account, it.key);
        return (
          <button
            key={it.key}
            type="button"
            className={`mail-ai-tag${on ? " on" : ""}`}
            aria-pressed={on}
            disabled={!resolvable}
            title={resolvable ? t(it.label) : t("mailAi.unavailable")}
            onClick={() => void patchAi(account, { [it.key]: !on })}
          >
            {t(it.tag)}
          </button>
        );
      })}
    </div>
  );
}
