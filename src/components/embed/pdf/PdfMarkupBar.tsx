/**
 * The desktop markup mode's strips under the PDF toolbar (`usePdfMarkup`):
 * the tools, the agent tab a Submit goes to and Submit itself, then a status
 * line with the round's pill and Reload. Built from the blackout tool's strip
 * (`file-viewer-pdf-redact-bar`) and the copy mode's status line
 * (`file-viewer-pdf-copy-bar`), as the metadata panel is — no new chrome, and
 * nothing portaled.
 */
import { useT, type TranslationKey } from "../../../lib/i18n";
import { MARK_COLORS, type MarkColor } from "../../../../mobile-web/src/markup/layer";
import { INK } from "../../../../mobile-web/src/markup/rasterize";
import type { RoundPhase } from "../../../../mobile-web/src/markup/submitState";
import { UntestedTag } from "../../common/UntestedTag";
import { TabStatusMark } from "../../tabs/TabLocalityBadges";
import type { MarkupTool, PdfMarkup } from "./usePdfMarkup";

const TOOLS: { tool: MarkupTool; glyph: string; label: TranslationKey }[] = [
  { tool: "ink", glyph: "✎", label: "mobile.markup.tool.ink" },
  { tool: "box", glyph: "▭", label: "mobile.markup.tool.box" },
  { tool: "text", glyph: "T", label: "mobile.markup.tool.text" },
  { tool: "eraser", glyph: "⌫", label: "mobile.markup.tool.eraser" },
];

const COLOR_KEYS: Record<MarkColor, TranslationKey> = {
  red: "mobile.markup.color.red",
  blue: "mobile.markup.color.blue",
  black: "mobile.markup.color.black",
  yellow: "mobile.markup.color.yellow",
};

/** The pill's words, by phase; `finished` says whether the PDF changed. */
const ROUND_KEYS: Record<Exclude<RoundPhase, "finished">, TranslationKey> = {
  sent: "mobile.markup.round.sent",
  queued: "mobile.markup.round.queued",
  working: "mobile.markup.round.working",
  question: "pdfMarkup.round.question",
  unconfirmed: "mobile.markup.round.unconfirmed",
};

/** The tab bar's own status mark, where a phase has one. */
const ROUND_MARK: Partial<Record<RoundPhase, string>> = {
  working: "working",
  question: "needs-decision",
  finished: "finished",
};

export function PdfMarkupBar({
  markup,
  page,
  onReload,
  onDone,
}: {
  markup: PdfMarkup;
  /** The page on screen, for Clear page. */
  page: number;
  /** Load the file as it is now under the layer. */
  onReload: () => void;
  /** Leave markup mode. */
  onDone: () => void;
}) {
  const t = useT();
  const { round, target, targets } = markup;
  const busy = markup.sending;
  const canSubmit = markup.sendable.length > 0 && target !== null && !busy && markup.edit.note === null;
  const roundWords = round
    ? round.phase === "finished"
      ? t(markup.stale ? "mobile.markup.round.finishedChanged" : "mobile.markup.round.finished")
      : round.phase === "question" && markup.questions.asks.length > 0
        ? t("pdfMarkup.round.asks")
        : t(ROUND_KEYS[round.phase])
    : null;
  const mark = round ? ROUND_MARK[round.phase] : undefined;
  /** Reload is offered once a round went out, or the file changed under the
   *  marks; it leads once the agent is done and the file is new. */
  const canReload = round !== null || markup.stale;
  const reloadLeads = markup.stale && !markup.reloaded;

  return (
    <>
      <div className="file-viewer-pdf-redact-bar file-viewer-pdf-markup-bar" role="group" aria-label={t("pdfMarkup.toggle")}>
        <span className="file-viewer-pdf-redact-hint">
          {t(markup.tool === "text" ? "pdfMarkup.textHint" : "pdfMarkup.hint")}
        </span>
        {TOOLS.map(({ tool, glyph, label }) => (
          <button
            key={tool}
            type="button"
            className={`file-viewer-zoom-btn${markup.tool === tool ? " active" : ""}`}
            aria-pressed={markup.tool === tool}
            title={t(label)}
            aria-label={t(label)}
            onClick={() => markup.setTool(tool)}
          >
            {glyph}
          </button>
        ))}
        <span className="file-viewer-pdf-markup-colors" role="group" aria-label={t("mobile.markup.color")}>
          {MARK_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`file-viewer-zoom-btn file-viewer-pdf-markup-swatch${markup.color === color ? " active" : ""}`}
              aria-pressed={markup.color === color}
              title={t(COLOR_KEYS[color])}
              aria-label={t("mobile.markup.colorOf", { color: t(COLOR_KEYS[color]) })}
              onClick={() => markup.setColor(color)}
            >
              <span style={{ background: INK[color] }} aria-hidden="true" />
            </button>
          ))}
        </span>
        <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
        <button
          type="button"
          className="file-viewer-zoom-btn"
          onClick={markup.undo}
          disabled={!markup.canUndo || busy}
          title={t("mobile.markup.undo")}
          aria-label={t("mobile.markup.undo")}
        >
          ↶
        </button>
        <button
          type="button"
          className="file-viewer-zoom-btn"
          onClick={markup.redo}
          disabled={!markup.canRedo || busy}
          title={t("mobile.markup.redo")}
          aria-label={t("mobile.markup.redo")}
        >
          ↷
        </button>
        <button
          type="button"
          className="file-viewer-zoom-btn file-viewer-zoom-text"
          onClick={() => markup.clearPage(page)}
          disabled={(!markup.edit.base.pages[page] && !(markup.showSent && markup.edit.base.sent?.pages[page])) || busy}
        >
          {t("mobile.markup.clearPage", { n: page })}
        </button>
        {markup.sentShown && (
          <>
            <label className="file-viewer-pdf-redact-opt">
              <input
                type="checkbox"
                checked={markup.showSent}
                onChange={(event) => markup.setShowSent(event.target.checked)}
              />
              {t("mobile.markup.showSent")}
            </label>
            <button
              type="button"
              className="file-viewer-zoom-btn file-viewer-zoom-text"
              onClick={markup.clearSent}
              disabled={busy}
            >
              {t("mobile.markup.clearSent")}
            </button>
          </>
        )}
        <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
        {targets.length === 0 ? (
          <span className="file-viewer-pdf-redact-warn">{t("pdfMarkup.noAgent")}</span>
        ) : targets.length === 1 ? (
          <span className="file-viewer-pdf-redact-count" title={t("pdfMarkup.targetTitle")}>
            {t("pdfMarkup.targetOne", { tab: targets[0].label })}
          </span>
        ) : (
          <label className="file-viewer-pdf-redact-opt">
            {t("pdfMarkup.target")}
            <select
              value={target?.scheduleTargetId ?? ""}
              onChange={(event) => markup.chooseTarget(event.target.value)}
              aria-label={t("pdfMarkup.targetTitle")}
              title={t("pdfMarkup.targetTitle")}
            >
              {targets.map((entry) => (
                <option key={entry.scheduleTargetId} value={entry.scheduleTargetId}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="file-viewer-zoom-btn file-viewer-zoom-text file-viewer-pdf-markup-submit"
          onClick={() => void markup.submit()}
          disabled={!canSubmit}
          title={target ? t("pdfMarkup.submitTitle", { tab: target.label }) : t("pdfMarkup.noAgent")}
        >
          {t("mobile.markup.submit")}
        </button>
        <button type="button" className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={onDone} disabled={busy}>
          {t("mobile.markup.done")}
        </button>
      </div>
      {(round || markup.stale || busy || markup.failure || markup.storage === "unsaved" || markup.changed
        || markup.leftOut > 0 || markup.limitHit || markup.askElsewhere) && (
        <div className="file-viewer-pdf-copy-bar file-viewer-pdf-markup-status" role="status" aria-live="polite">
          {round && roundWords && (
            <span className="file-viewer-pdf-markup-round">
              {mark && <TabStatusMark stateClass={mark} />}
              <span>{roundWords}</span>
            </span>
          )}
          {markup.stale && !(round?.phase === "finished") && <span>{t("pdfMarkup.stale")}</span>}
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
          {canReload && (
            <button
              type="button"
              className={`file-viewer-zoom-btn file-viewer-zoom-text${reloadLeads ? " active" : ""}`}
              onClick={onReload}
              disabled={busy}
            >
              {t("mobile.markup.reload")}
            </button>
          )}
          {round && <UntestedTag id="desktop.markup" />}
          {markup.askElsewhere && (
            <span>
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
            </span>
          )}
          {busy && <span>{t("mobile.markup.sendingMarks")}</span>}
          {markup.storage === "unsaved" && <span>{t("pdfMarkup.unsaved")}</span>}
          {markup.changed && <span>{t("mobile.markup.changed")}</span>}
          {markup.leftOut > 0 && (
            <span>
              {t(markup.leftOut === 1 ? "mobile.markup.leftOutOne" : "mobile.markup.leftOut", { count: markup.leftOut })}
            </span>
          )}
          {markup.limitHit && <span className="file-viewer-pdf-redact-warn">{t("mobile.markup.limit")}</span>}
          {markup.failure && (
            <span className="file-viewer-pdf-redact-warn" role="alert">
              {markup.failure}{" "}
              <button type="button" className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={markup.dismissFailure}>
                {t("pdfViewer.dismiss")}
              </button>
            </span>
          )}
        </div>
      )}
    </>
  );
}
