import { useModalFocus } from "../../hooks/useModalFocus";
/**
 * **The keyword filters** — words the user watches for, and the Important /
 * Urgent list a matching message lands in.
 *
 * Four things about this dialog are decisions rather than layout:
 *
 * **It says what a rule cannot do, on the face of it.** A filter dialog is where
 * people form a model of what the software is doing to their mail, and every
 * wrong model here is expensive: a rule marks a message *locally* (nothing is
 * uploaded, nothing moves folder, no other mail client sees it), it runs on mail
 * that **arrives** (plus an explicit re-run over what is already here), it
 * searches the body **snippet** rather than the body, and it never touches a
 * message that already carries a mark. Those four sentences are in the intro,
 * not in a tooltip.
 *
 * **The preview is a dry run of the real thing.** "Test" calls the same backend
 * command the apply calls, with `dryRun`, so the number it reports is produced
 * by the code that would do the marking — there is no second matcher in
 * TypeScript that could disagree with the one in Rust. It is also why the test
 * works on the rule *as edited*, including one that is switched off: "what would
 * this catch" is asked before committing to it.
 *
 * **Order is data, so the list is reorderable and the first match wins.** A
 * message gets one mark; two rules disagreeing has to resolve somewhere, and the
 * order the user can see and move is the only resolution that can be explained.
 * That is also why saving is wholesale (`mailFiltersSet`).
 *
 * **A rule that matches nothing is called out as an error.** No terms, or no
 * searched fields, saves happily and then never fires — which from the user's
 * side is indistinguishable from the feature being broken.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../../lib/i18n";
import { mailFiltersApply, mailFiltersList, mailFiltersSet } from "../../lib/mail";
import {
  FIELD_LABEL_KEY,
  FILTER_FIELDS,
  PROBLEM_KEY,
  addTerms,
  blankRule,
  moveRule,
  removeTerm,
  ruleLabel,
  ruleProblems,
  toggleField,
} from "../../lib/mailFilters";
import { useMailStore } from "../../stores/mail";
import type {
  MailAccount,
  MailFilterReport,
  MailFilterRule,
  MailPriority,
} from "../../types/mail";
import { stripFormatControls } from "../../lib/textSafety";
import { UntestedTag } from "../common/UntestedTag";
import { ErrorNote } from "../common/ErrorNote";

export interface MailFiltersDialogProps {
  accounts: MailAccount[];
  onClose: () => void;
}

export function MailFiltersDialog({ accounts, onClose }: MailFiltersDialogProps) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const [rules, setRules] = useState<MailFilterRule[]>([]);
  const [selected, setSelected] = useState<number>(-1);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<MailFilterReport | null>(null);
  const [termInput, setTermInput] = useState("");

  useEffect(() => {
    let alive = true;
    void mailFiltersList()
      .then((list) => {
        if (!alive) return;
        setRules(list);
        setSelected(list.length > 0 ? 0 : -1);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const rule = selected >= 0 ? rules[selected] : undefined;
  const problems = useMemo(() => (rule ? ruleProblems(rule) : []), [rule]);

  const edit = useCallback(
    (patch: Partial<MailFilterRule>) => {
      setRules((prev) =>
        prev.map((r, i) => (i === selected ? { ...r, ...patch } : r)),
      );
      setDirty(true);
      // A report is about the rule that produced it. Keeping it on screen after
      // an edit would let a stale "12 messages" describe a rule that no longer
      // exists in that shape.
      setReport(null);
    },
    [selected],
  );

  /** Write the list and adopt what came back — the backend mints ids, so the
   *  local copy has to be replaced rather than merely marked clean. */
  const save = useCallback(async (): Promise<MailFilterRule[]> => {
    const saved = await mailFiltersSet(rules);
    setRules(saved);
    setDirty(false);
    return saved;
  }, [rules]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const addRule = () => {
    setRules((prev) => [...prev, blankRule()]);
    setSelected(rules.length);
    setDirty(true);
    setReport(null);
  };

  const deleteRule = (index: number) => {
    setRules((prev) => prev.filter((_, i) => i !== index));
    setSelected((prev) => (prev >= index ? Math.max(-1, prev - 1) : prev));
    setDirty(true);
    setReport(null);
  };

  const move = (from: number, to: number) => {
    setRules((prev) => moveRule(prev, from, to));
    setSelected(to);
    setDirty(true);
  };

  const commitTerms = () => {
    if (!rule || !termInput.trim()) return;
    edit({ terms: addTerms(rule.terms, termInput) });
    setTermInput("");
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="settings-dialog mail-filters-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-title-row">
          <h2>
            {t("mail.filters.title")} <UntestedTag id="mail.filters.title" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dialog-scroll">
          <p className="mail-note">{t("mail.filters.intro")}</p>
          {/* The limits, as a list rather than prose: each one is a separate
              wrong assumption somebody would otherwise make. */}
          <ul className="mail-filters-limits">
            <li>{t("mail.filters.limitLocal")}</li>
            <li>{t("mail.filters.limitNew")}</li>
            <li>{t("mail.filters.limitPreview")}</li>
            <li>{t("mail.filters.limitFolders")}</li>
          </ul>

          <div className="mail-filters-body">
            {/* ── The list. Order is the resolution rule, so it is editable ── */}
            <div className="mail-filters-list">
              <div className="mail-field-label">{t("mail.filters.rules")}</div>
              {rules.length === 0 && <p className="mail-note">{t("mail.filters.none")}</p>}
              {rules.map((r, i) => (
                <div
                  key={r.id || `new-${i}`}
                  className={`mail-filter-row${i === selected ? " selected" : ""}`}
                  onClick={() => {
                    setSelected(i);
                    setReport(null);
                  }}
                >
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    title={t("mail.filters.enabled")}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      setRules((prev) =>
                        prev.map((x, xi) =>
                          xi === i ? { ...x, enabled: e.target.checked } : x,
                        ),
                      );
                      setDirty(true);
                    }}
                  />
                  <span className={`mail-filter-mark ${r.mark}`} aria-hidden="true">
                    {r.mark === "urgent" ? "!!" : "!"}
                  </span>
                  <span className="mail-filter-name">
                    {stripFormatControls(ruleLabel(r, t("mail.filters.unnamed")))}
                  </span>
                  <span className="mail-filter-row-actions">
                    <button
                      type="button"
                      className="settings-btn sm icon"
                      title={t("mail.filters.moveUp")}
                      disabled={i === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        move(i, i - 1);
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="settings-btn sm icon"
                      title={t("mail.filters.moveDown")}
                      disabled={i === rules.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        move(i, i + 1);
                      }}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="settings-btn sm icon"
                      title={t("common.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteRule(i);
                      }}
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))}
              <button type="button" className="settings-btn sm mail-filters-add" onClick={addRule}>
                {t("mail.filters.addRule")}
              </button>
              {rules.length > 1 && (
                <p className="mail-note">{t("mail.filters.orderHint")}</p>
              )}
            </div>

            {/* ── The editor ───────────────────────────────────────────────── */}
            {rule && (
              <div className="mail-filter-editor">
                <label className="mail-field">
                  <span>{t("mail.filters.name")}</span>
                  <input
                    className="mail-input"
                    value={rule.name}
                    placeholder={t("mail.filters.namePlaceholder")}
                    onChange={(e) => edit({ name: e.target.value })}
                  />
                </label>

                <div className="mail-field">
                  <span>{t("mail.filters.terms")}</span>
                  <div className="mail-filter-chips">
                    {rule.terms.map((term) => (
                      <span key={term} className="mail-filter-chip">
                        {stripFormatControls(term)}
                        <button
                          type="button"
                          className="mail-filter-chip-x"
                          title={t("common.remove")}
                          onClick={() => edit({ terms: removeTerm(rule.terms, term) })}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="mail-filters-term-add">
                    <input
                      className="mail-input"
                      value={termInput}
                      placeholder={t("mail.filters.termsPlaceholder")}
                      onChange={(e) => setTermInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitTerms();
                        }
                      }}
                      /* Committed on blur too: a word typed and left in the box
                         is a word the user believes they added, and a Save that
                         silently dropped it would be the worst bug this dialog
                         could have. */
                      onBlur={commitTerms}
                    />
                    <button type="button" className="settings-btn" onClick={commitTerms}>
                      {t("common.add")}
                    </button>
                  </div>
                  <small className="mail-note">{t("mail.filters.termsHint")}</small>
                </div>

                <div className="mail-field">
                  <span>{t("mail.filters.searchIn")}</span>
                  <div className="mail-filter-fields">
                    {FILTER_FIELDS.map((field) => (
                      <label key={field} className="mail-filter-field-toggle">
                        <input
                          type="checkbox"
                          checked={rule.fields.includes(field)}
                          onChange={() => edit({ fields: toggleField(rule.fields, field) })}
                        />
                        <span>{t(FIELD_LABEL_KEY[field])}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <label className="mail-field">
                  <span>{t("mail.filters.mark")}</span>
                  <select
                    className="mail-input"
                    value={rule.mark}
                    onChange={(e) => edit({ mark: e.target.value as MailPriority })}
                  >
                    <option value="urgent">{t("mail.urgent")}</option>
                    <option value="important">{t("mail.important")}</option>
                  </select>
                </label>

                <label className="mail-field">
                  <span>{t("mail.filters.account")}</span>
                  <select
                    className="mail-input"
                    value={rule.account_id ?? ""}
                    onChange={(e) =>
                      edit({ account_id: e.target.value === "" ? undefined : e.target.value })
                    }
                  >
                    <option value="">{t("mail.filters.allAccounts")}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label || a.address}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="mail-filter-field-toggle">
                  <input
                    type="checkbox"
                    checked={rule.match_all}
                    onChange={(e) => edit({ match_all: e.target.checked })}
                  />
                  <span>{t("mail.filters.matchAll")}</span>
                </label>
                <label className="mail-filter-field-toggle">
                  <input
                    type="checkbox"
                    checked={rule.whole_word}
                    onChange={(e) => edit({ whole_word: e.target.checked })}
                  />
                  <span>{t("mail.filters.wholeWord")}</span>
                </label>

                {problems.length > 0 && (
                  <div className="mail-warning-strip">
                    <span>
                      {problems.map((p) => t(PROBLEM_KEY[p])).join(" ")}
                    </span>
                  </div>
                )}

                <div className="mail-dialog-actions">
                  {/* The rule AS EDITED, saved or not, switched on or not — see
                      the header. */}
                  <button
                    type="button"
                    className="settings-btn"
                    disabled={busy || problems.length > 0}
                    onClick={() =>
                      void run(async () => {
                        setReport(
                          await mailFiltersApply({ dryRun: true, rules: [rule] }),
                        );
                      })
                    }
                  >
                    {t("mail.filters.test")}
                  </button>
                </div>
              </div>
            )}
          </div>

          {report && <FilterReportView report={report} />}
          {error && <ErrorNote className="project-dialog-error" error={error} />}

          <div className="mail-dialog-actions">
            <button
              type="button"
              className="settings-btn"
              disabled={busy || rules.length === 0}
              title={t("mail.filters.applyExistingHint")}
              onClick={() =>
                void run(async () => {
                  // Saved first, always: applying a list the user is looking at
                  // but has not stored would leave the mailbox marked by rules
                  // that are not in the file.
                  const saved = dirty ? await save() : rules;
                  const result = await mailFiltersApply({
                    dryRun: false,
                    rules: saved.filter((r) => r.enabled),
                  });
                  setReport(result);
                  // The rail badges and any open priority list are now wrong.
                  await useMailStore.getState().refreshPriorityCounts();
                })
              }
            >
              {t("mail.filters.applyExisting")}
            </button>
            <div className="mail-toolbar-spacer" />
            <button type="button" className="settings-btn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="settings-btn primary"
              disabled={busy || !dirty}
              onClick={() => void run(async () => void (await save()))}
            >
              {dirty ? t("mail.filters.save") : t("mail.filters.saved")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * What the run found. `dry_run` is rendered as a *different sentence*, not as a
 * smaller number: "would mark 12" and "marked 12" are different claims about the
 * user's mailbox and must never be confusable.
 */
function FilterReportView({ report }: { report: MailFilterReport }) {
  const t = useT();
  return (
    <div className="mail-filter-report">
      <div className="mail-field-label">
        {report.dry_run
          ? t("mail.filters.reportDry", { matched: report.matched, scanned: report.scanned })
          : t("mail.filters.reportApplied", {
              marked: report.marked,
              scanned: report.scanned,
            })}
      </div>
      {/* The bound, stated. Without it "3 matches" reads as a claim about the
          whole mailbox — the `mail-list-scan-note` bargain. */}
      {report.capped !== undefined && (
        <p className="mail-note">{t("mail.filters.reportCapped", { limit: report.capped })}</p>
      )}
      {report.matched === 0 && <p className="mail-note">{t("mail.filters.reportNone")}</p>}
      {report.samples.map((s) => (
        <div key={s.message_id} className="mail-filter-sample">
          <span className="mail-filter-sample-subject">
            {stripFormatControls(s.subject) || t("mail.noSubject")}
          </span>
          {/* The addr-spec, always — `MailList`'s rule: an attacker-chosen
              display name must never stand alone as identity, and this list is
              full of mail from strangers by construction. */}
          <span className="mail-filter-sample-from">{s.from.address}</span>
          <span className="mail-filter-sample-why">
            {t("mail.filters.sampleWhy", {
              term: stripFormatControls(s.hit.term),
              field: t(FIELD_LABEL_KEY[s.hit.field]),
              rule: stripFormatControls(s.hit.rule_name) || t("mail.filters.unnamed"),
            })}
          </span>
        </div>
      ))}
    </div>
  );
}
