import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT, type TranslationKey } from "../../lib/i18n";

type TFunction = (key: TranslationKey, params?: Record<string, string | number>) => string;
import { basename } from "../../lib/paths";
import { formatSize } from "../../lib/window/printing";
import { decidePrintRequest, type PrintRequest } from "../../lib/window/printMcp";
import { reviewFailure, reviewPrintRequest } from "../../lib/viewers/printRequest";
import { usePrintRequestsStore } from "../../stores/printRequests";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { stripInvisible, tabLabelForPty } from "../layout/RootReviewStrip";
import { ErrorNote } from "../common/ErrorNote";
import { UntestedTag } from "../common/UntestedTag";

/**
 * Agent print requests (`services::print_mcp`): an agent tab asked to print a
 * PDF of its project, and nothing prints until the user approves it. Two
 * surfaces read the one store (`stores/printRequests`): the Print Manager
 * tab's "Agent print requests" card, and the shell's popup that announces a new
 * request wherever the user is. Both open the same print preview
 * (`lib/viewers/printRequest.ts`), whose Approve & print hands the PDF to the
 * system print dialog.
 */

/** The agent's options in a few words: copies, pages, grayscale, two-sided,
 *  pages per sheet, booklet. */
export function optionsSummary(request: PrintRequest, t: TFunction): string {
  const o = request.options;
  const parts = [t("printRequest.copies", { count: o.copies })];
  parts.push(o.pages ? t("printRequest.pages", { range: o.pages }) : t("printRequest.allPages"));
  if (o.grayscale) parts.push(t("printRequest.grayscale"));
  if (o.booklet) parts.push(t("printRequest.booklet"));
  else if (o.pagesPerSheet && o.pagesPerSheet > 1) parts.push(t("printRequest.perSheet", { count: o.pagesPerSheet }));
  if (o.duplex === "long" || o.duplex === "short") parts.push(t(o.duplex === "long" ? "printRequest.duplexLong" : "printRequest.duplexShort"));
  return parts.join(" · ");
}

/** Review and Reject, shared by both surfaces; `error` is the last failure. */
function useRequestActions() {
  const t = useT();
  const [error, setError] = useState("");
  const setReviewing = usePrintRequestsStore((s) => s.setReviewing);
  const refresh = usePrintRequestsStore((s) => s.refresh);
  const review = useCallback(async (request: PrintRequest) => {
    setError("");
    const requester = tabLabelForPty(useTabsStore.getState(), request.tab) ?? t("printRequest.anAgent");
    setReviewing(request.id);
    try {
      await reviewPrintRequest(request, requester);
    } catch (e) {
      setError(reviewFailure(e));
    } finally {
      setReviewing(null);
      void refresh();
    }
  }, [t, setReviewing, refresh]);
  const reject = useCallback(async (request: PrintRequest) => {
    setError("");
    try {
      await decidePrintRequest(request.id, "rejected");
    } catch (e) {
      setError(reviewFailure(e));
    } finally {
      void refresh();
    }
  }, [refresh]);
  return { review, reject, error };
}

/** Which tab asked, from which project. */
function RequestSource({ request }: { request: PrintRequest }) {
  const t = useT();
  const tab = useTabsStore((s) => tabLabelForPty(s, request.tab));
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === request.projectId)?.name);
  return <>{t("printRequest.from", { tab: tab ?? t("printRequest.anAgent"), project: stripInvisible(project ?? request.projectId) })}</>;
}

/** The Print Manager tab's card: every pending request with Review and Reject. */
export function PrintRequestsCard() {
  const t = useT();
  const requests = usePrintRequestsStore((s) => s.requests);
  const reviewing = usePrintRequestsStore((s) => s.reviewing);
  const start = usePrintRequestsStore((s) => s.start);
  const { review, reject, error } = useRequestActions();
  useEffect(() => start(), [start]);
  if (requests.length === 0 && !error) return null;
  return (
    <section className="print-card print-requests">
      <div className="print-card-head">
        <span className="print-printer-name">{t("printRequest.cardTitle")}</span>
        <UntestedTag id="printMcp" />
      </div>
      {error && <ErrorNote className="print-strip error" error={error} />}
      <table className="print-jobs">
        <thead>
          <tr>
            <th>{t("printRequest.colFile")}</th>
            <th>{t("printRequest.colRequest")}</th>
            <th aria-label={t("printing.colActions")} />
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.id}>
              <td className="print-job-title" title={stripInvisible(request.file)}>
                {stripInvisible(basename(request.file))} · {formatSize(request.size)}
                <div className="settings-help"><RequestSource request={request} /></div>
              </td>
              <td>
                {optionsSummary(request, t)}
                {request.note && <div className="settings-help">{stripInvisible(request.note)}</div>}
              </td>
              <td className="print-requests-actions">
                <button type="button" className="print-btn" disabled={reviewing !== null}
                  onClick={() => void review(request)}>{t("printRequest.review")}</button>
                <button type="button" className="print-btn danger" disabled={reviewing === request.id}
                  onClick={() => void reject(request)}>{t("printRequest.reject")}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Shell-mounted: announces new requests wherever the user is, bottom-left (the
 * reminder popup holds bottom-right). Later puts the shown ones off until
 * another arrives; the Print Manager tab still lists them. Renders nothing
 * while nothing waits.
 */
export function PrintRequestsHost() {
  const t = useT();
  const requests = usePrintRequestsStore((s) => s.requests);
  const later = usePrintRequestsStore((s) => s.later);
  const reviewing = usePrintRequestsStore((s) => s.reviewing);
  const start = usePrintRequestsStore((s) => s.start);
  const putOff = usePrintRequestsStore((s) => s.putOff);
  const { review, reject, error } = useRequestActions();
  useEffect(() => start(), [start]);
  const shown = requests.filter((r) => !later.includes(r.id) && r.id !== reviewing);
  if (shown.length === 0) return null;
  return createPortal(
    <div className="cal-alarm-popup print-request-popup" role="alertdialog" aria-label={t("printRequest.cardTitle")}>
      <div className="cal-alarm-head">
        <span className="cal-alarm-title">
          {shown.length === 1 ? t("printRequest.popupOne") : t("printRequest.popupMany", { count: shown.length })}
          {" "}<UntestedTag id="printMcp" />
        </span>
        <button type="button" className="btn-quiet" onClick={() => putOff(shown.map((r) => r.id))}>
          {t("printRequest.later")}
        </button>
      </div>
      {error && <ErrorNote className="print-strip error" error={error} />}
      <div className="cal-alarm-list">
        {shown.map((request) => (
          <div key={request.id} className="cal-alarm-row">
            <div className="cal-alarm-main">
              <div className="cal-alarm-event" title={stripInvisible(request.file)}>{stripInvisible(basename(request.file))}</div>
              <div className="cal-alarm-when"><RequestSource request={request} /> · {optionsSummary(request, t)}</div>
              {request.note && <div className="cal-alarm-when">{stripInvisible(request.note)}</div>}
            </div>
            <div className="cal-alarm-actions">
              <button type="button" className="settings-btn" onClick={() => void reject(request)}>
                {t("printRequest.reject")}
              </button>
              <button type="button" className="btn-primary print-request-review" disabled={reviewing !== null}
                onClick={() => void review(request)}>
                {t("printRequest.review")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
