/**
 * The desktop markup mode's agent panel (`docs/markup_notes_style_plan.md`):
 * everything the agent's round says, behind the send header's **Agent**
 * badge, opened by it only — the round's pill, a dialog the target tab waits
 * on, the agent's questions (`PdfMarkupQuestions`), its ✓ groups and Approve
 * all, Make these changes, Undo round, Reload, and the notes about the file
 * and the stored layer. While it is open, the questions' `?` pins and the ✓
 * badges show on the pages (`PdfViewer`); while it is closed, nothing of the
 * round draws over the writing.
 */
import { useT, type TranslationKey } from "../../../lib/i18n";
import { UntestedTag } from "../../common/UntestedTag";
import { CloseIcon } from "../../common/icons/Icon";
import { TabStatusMark } from "../../tabs/TabLocalityBadges";
import { NO_UNDO_KEYS, ROUND_KEYS, ROUND_MARK } from "./PdfMarkupBar";
import { PdfMarkupQuestions } from "./PdfMarkupQuestions";
import { PdfTicksStatus } from "./PdfMarkupTicks";
import type { PdfMarkup } from "./usePdfMarkup";

/** The panel's width, CSS px — the dock keeps clear of it. */
export const AGENT_PANEL_PX = 320;

export function PdfMarkupAgentPanel({
  markup,
  pinned,
  onReload,
  picture = false,
}: {
  markup: PdfMarkup;
  /** The questions with a pin on a page (`pinKey`). */
  pinned: ReadonlySet<string>;
  /** Load the file as it is now under the layer. */
  onReload: () => void;
  /** The image viewer's panel: the words say picture, not PDF. */
  picture?: boolean;
}) {
  const t = useT();
  const said = (pdf: TranslationKey, image: TranslationKey) => (picture ? image : pdf);
  const { round, roundUndo } = markup;
  const busy = markup.sending;
  const roundWords = round
    ? round.phase === "finished"
      ? t(markup.stale ? said("mobile.markup.round.finishedChanged", "pdfMarkup.picture.finishedChanged") : "mobile.markup.round.finished")
      : round.phase === "question" && markup.questions.asks.length > 0
        ? t("pdfMarkup.round.asks")
        : round.phase === "working" && markup.targetModel
          ? t("mobile.markup.round.workingModel", { model: markup.targetModel })
          : t(ROUND_KEYS[round.phase])
    : null;
  const mark = round ? ROUND_MARK[round.phase] : undefined;
  /** Reload is offered only when the file changed under the marks; it leads
   *  until reloaded once. */
  const reloadLeads = markup.stale && !markup.reloaded;
  const anything =
    !!round || markup.stale || markup.autoReloaded || markup.storage === "unsaved" || markup.changed || markup.leftOut > 0
    || !!markup.askElsewhere || !!roundUndo.note || roundUndo.noUndo !== null || markup.ticks.marks.length > 0
    || markup.questions.asks.length > 0 || !!markup.questions.failure;
  return (
    <aside className="file-viewer-pdf-markup-panel" aria-label={t("pdfMarkup.agent")} style={{ width: AGENT_PANEL_PX }}>
      <div className="file-viewer-pdf-markup-panel-head">
        <span className="file-viewer-pdf-markup-panel-title">{t("pdfMarkup.agent")}</span>
        <button
          type="button"
          className="file-viewer-zoom-btn"
          onClick={() => markup.setPanel(false)}
          title={t("pdfMarkup.agentClose")}
          aria-label={t("pdfMarkup.agentClose")}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="file-viewer-pdf-markup-panel-body" role="status" aria-live="polite">
        {!anything && <p className="file-viewer-pdf-markup-panel-empty">{t("pdfMarkup.agentNothing")}</p>}
        {round && roundWords && (
          <div className="file-viewer-pdf-markup-round">
            {mark && <TabStatusMark stateClass={mark} />}
            <span>{roundWords}</span>
            <UntestedTag id="desktop.markup" />
          </div>
        )}
        {markup.tabDialog && markup.roundTarget && (
          <div className="file-viewer-pdf-markup-panel-row">
            {markup.tabDialog.line && (
              <span className="file-viewer-pdf-markup-dialog" title={markup.tabDialog.line}>
                {t("pdfMarkup.tabDialog", { line: markup.tabDialog.line })}
              </span>
            )}
            <button
              type="button"
              className="file-viewer-zoom-btn file-viewer-zoom-text active"
              onClick={markup.showRoundTarget}
              title={t("pdfMarkup.answerInTabTitle", { tab: markup.roundTarget.label })}
            >
              {t("pdfMarkup.answerInTab")} <UntestedTag id="desktop.markup.tabDialog" />
            </button>
          </div>
        )}
        <PdfMarkupQuestions questions={markup.questions} pinned={pinned} />
        {markup.ticks.groups.length > 0 && (
          <div className="file-viewer-pdf-markup-panel-row">
            <PdfTicksStatus count={markup.ticks.groups.length} disabled={busy} onApproveAll={markup.ticks.approveAll} />
          </div>
        )}
        {markup.stale && !(round?.phase === "finished") && <p>{t(said("pdfMarkup.stale", "pdfMarkup.picture.stale"))}</p>}
        {markup.autoReloaded && !markup.stale && (
          <p className="file-viewer-pdf-markup-auto-reloaded">
            {t(said("pdfMarkup.autoReloaded", "pdfMarkup.picture.autoReloaded"))} <UntestedTag id="desktop.markup.autoReload" />
          </p>
        )}
        {(markup.canApply || roundUndo.offered || markup.stale) && (
          <div className="file-viewer-pdf-markup-panel-row">
            {markup.canApply && (
              <button
                type="button"
                className={`file-viewer-zoom-btn file-viewer-zoom-text${reloadLeads ? "" : " active"}`}
                onClick={() => void markup.apply()}
                disabled={busy}
                title={t("mobile.markup.applyTitle")}
              >
                {t("mobile.markup.apply")} <UntestedTag id="desktop.markup.apply" />
              </button>
            )}
            {roundUndo.offered && (
              <button
                type="button"
                className={`file-viewer-zoom-btn file-viewer-zoom-text${reloadLeads ? "" : " active"}`}
                onClick={() => void roundUndo.ask()}
                disabled={busy || roundUndo.busy}
                title={t("mobile.markup.undoRoundTitle")}
                aria-label={t("mobile.markup.undoRoundTitle")}
              >
                {t("mobile.markup.undoRound")} <UntestedTag id="desktop.markup.undo" />
              </button>
            )}
            {markup.stale && (
              <button
                type="button"
                className={`file-viewer-zoom-btn file-viewer-zoom-text${reloadLeads ? " active" : ""}`}
                onClick={onReload}
                disabled={busy}
              >
                {t(said("mobile.markup.reload", "pdfMarkup.picture.reload"))}
              </button>
            )}
          </div>
        )}
        {roundUndo.noUndo && (
          <p>{t("mobile.markup.noUndo", { reason: t(NO_UNDO_KEYS[roundUndo.noUndo] ?? "mobile.markup.noUndo.other") })}</p>
        )}
        {roundUndo.note && (
          <p className={roundUndo.note.alert ? "file-viewer-pdf-redact-warn" : undefined} role={roundUndo.note.alert ? "alert" : undefined}>
            {roundUndo.note.text}
          </p>
        )}
        {markup.askElsewhere && (
          <p>
            {t("pdfMarkup.questions.elsewhere", { tab: markup.askElsewhere.label })}{" "}
            <button
              type="button"
              className="file-viewer-zoom-btn file-viewer-zoom-text"
              onClick={() => markup.askElsewhere && markup.chooseTarget(markup.askElsewhere.scheduleTargetId)}
              disabled={busy}
            >
              {t("pdfMarkup.questions.elsewhereShow")}
            </button>
            <UntestedTag id="desktop.markup.questions" />
          </p>
        )}
        {markup.storage === "unsaved" && <p>{t(said("pdfMarkup.unsaved", "pdfMarkup.picture.unsaved"))}</p>}
        {markup.changed && <p>{t("mobile.markup.changed")}</p>}
        {markup.leftOut > 0 && (
          <p>{t(markup.leftOut === 1 ? "mobile.markup.leftOutOne" : "mobile.markup.leftOut", { count: markup.leftOut })}</p>
        )}
      </div>
    </aside>
  );
}
