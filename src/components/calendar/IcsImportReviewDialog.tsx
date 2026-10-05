import { UntestedTag } from "../common/UntestedTag";
import type { IcsFinding, IcsReport } from "../../lib/calendar/icsSafety";
import { useT } from "../../lib/i18n";

/**
 * The report itself — the counts, then each finding with what Tabtivity does about
 * it. Apart from the dialog so the root console's review panel shows a file an
 * agent staged (`calendar_import_ics`) in exactly the same words.
 */
export function IcsReportBody({ report }: { report: IcsReport }) {
  const t = useT();
  const label = (f: IcsFinding): string =>
    t(`icsReview.finding.${f.kind}`, { count: f.count });
  const effect = (f: IcsFinding): string =>
    f.ignored ? t("icsReview.effectIgnored") : t("icsReview.effectKept");
  return (
    <>
      {!report.looksLikeIcs ? (
        // The one finding that is not a nuance: this is not a calendar file,
        // so nothing below it would mean anything.
        <p className="ics-review-notice ics-review-notice-bad">{t("icsReview.notIcs")}</p>
      ) : (
        <p className="ics-review-counts">
          {t("icsReview.counts", {
            events: report.events,
            tasks: report.tasks,
            kb: Math.max(1, Math.round(report.bytes / 1024)),
          })}
          {report.skipped > 0 ? ` ${t("icsReview.skipped", { count: report.skipped })}` : ""}
        </p>
      )}

      {report.findings.length > 0 && (
        <ul className="ics-review-list">
          {report.findings.map((f) => (
            <li
              key={f.kind}
              className={f.ignored ? "ics-review-row" : "ics-review-row ics-review-row-kept"}
            >
              <span className="ics-review-what">{label(f)}</span>
              <span className="ics-review-effect">{effect(f)}</span>
              {f.sample && <code className="ics-review-sample">{f.sample}</code>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * What is in this `.ics` file, shown before any of it is imported.
 *
 * ## Why a dialog, when the file cannot do anything
 *
 * It cannot. An `.ics` carries no code this app would run, and the module note
 * on `lib/calendar/icsSafety.ts` lists the four independent reasons why. This is not a
 * quarantine gate and it must not pretend to be one — a dialog that implies a
 * calendar file might infect something is a dialog that teaches people to click
 * through warnings.
 *
 * What it does is answer the question the defences cannot: **what am I about to
 * put in my calendar?** A file whose alarms ask for a program to be run, whose
 * events carry attachments, whose "location" is an application URL, or whose
 * titles contain right-to-left overrides is worth a second look — and every one
 * of those is dropped or cleaned *in silence* today. This is the difference
 * between "Tabtivity ignored it" and "you know it was there".
 *
 * ## The one rule the wording follows
 *
 * Every row says what Tabtivity **does** about the finding, and the `ignored` half
 * carries its own word for it. A warning that lists a hostile-sounding property
 * without saying it is discarded reads as a threat rather than as a fact, and the
 * user has no way to tell which they are looking at.
 *
 * The default button is therefore **Import** for a file with nothing but ignored
 * findings, and the dialog is not raised at all for a file with no findings —
 * the common case stays one click, which is what keeps the uncommon one worth
 * reading.
 */
export function IcsImportReviewDialog({
  name,
  report,
  onImport,
  onCancel,
}: {
  /** The file's own name, so the question names what it is about. */
  name: string;
  report: IcsReport;
  onImport: () => void;
  onCancel: () => void;
}) {
  const t = useT();

  return (
    <div className="modal-backdrop">
      <div className="project-dialog ics-review-dialog">
        <h2 className="ics-review-title">
          {t("icsReview.title")} <UntestedTag id="icsReview.title" />
        </h2>
        <p className="ics-review-file">{name}</p>

        <IcsReportBody report={report} />

        <p className="ics-review-footnote">{t("icsReview.footnote")}</p>

        <div className="ics-review-actions">
          <button type="button" className="cal-btn" onClick={onImport}>
            {t("icsReview.import")}
          </button>
          <button type="button" className="cal-btn cal-btn-ghost" onClick={onCancel}>
            {t("icsReview.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
