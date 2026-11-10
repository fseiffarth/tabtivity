/**
 * The desktop markup mode's send header under the PDF toolbar
 * (`usePdfMarkup`, `docs/markup_notes_style_plan.md`): the agent tab a Submit
 * goes to, its model chip, Go to tab, the **Agent** badge that opens the
 * agent panel (`PdfMarkupAgentPanel`: the round, the agent's questions and
 * ticks, Reload, Apply, Undo round), Submit and Done — with only what a
 * Submit itself says (sending, its failure) beside them. The tools float over
 * the pages in the dock (`PdfMarkupDock`). Built from the blackout tool's
 * strip (`file-viewer-pdf-redact-bar`), no new chrome.
 *
 * Also here, shared by the dock, the layer and both viewers: the ⋯ menu, the
 * colour, stamp and text-mark names, and the markup keys (`markupStripKey`).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useT, type TranslationKey } from "../../../lib/i18n";
import { type Layer, type MarkColor, type StampSymbol } from "../../../../mobile-web/src/markup/layer";
import { colorsFor, type PressureCurve, type TextMarkMode } from "../../../../mobile-web/src/markup/pen";
import { undoSummary, type RoundPhase } from "../../../../mobile-web/src/markup/submitState";
import { ConfirmDialog } from "../../common/PromptDialogs";
import { UntestedTag } from "../../common/UntestedTag";
import { PdfMarkupModel } from "./PdfMarkupModel";
import type { MarkSelection, MarkupTool, PdfMarkup } from "./usePdfMarkup";

/** The text marks' modes as the word "ab" struck, underlined or highlighted. */
export function TextMarkGlyph({ mode }: { mode: TextMarkMode }) {
  return <span className={`file-viewer-pdf-markup-tm is-${mode}`} aria-hidden="true">ab</span>;
}
export const STAMP_GLYPHS: Record<StampSymbol, string> = { insert: "⁁", delete: "✕", paragraph: "¶", swap: "⇄" };
export const STAMP_KEYS: Record<StampSymbol, TranslationKey> = {
  insert: "mobile.markup.stamp.insert",
  delete: "mobile.markup.stamp.delete",
  paragraph: "mobile.markup.stamp.paragraph",
  swap: "mobile.markup.stamp.swap",
};
export const TEXT_MARK_KEYS: Record<TextMarkMode, TranslationKey> = {
  strike: "mobile.markup.textMark.strike",
  underline: "mobile.markup.textMark.underline",
  highlight: "mobile.markup.textMark.highlight",
};
const PRESSURE_KEYS: Record<PressureCurve, TranslationKey> = {
  light: "mobile.markup.pressure.light",
  normal: "mobile.markup.pressure.normal",
  firm: "mobile.markup.pressure.firm",
};

/** The colours a selection may take, in swatch order: the highlighter's
 *  when one of its marks highlights (a box or the highlighter), ink's
 *  otherwise; none without a selection. */
export function selectionColors(layer: Layer, selection: MarkSelection | null): readonly MarkColor[] {
  if (!selection) return [];
  const marks = selection.indices.map((i) => layer.pages[selection.n]?.marks[i]);
  const highlights = marks.some((mark) => mark?.kind === "box" || (mark?.kind === "ink" && mark.style === "marker"));
  return colorsFor(highlights ? "box" : "ink", "pen");
}

export const COLOR_KEYS: Record<MarkColor, TranslationKey> = {
  red: "mobile.markup.color.red",
  blue: "mobile.markup.color.blue",
  black: "mobile.markup.color.black",
  yellow: "mobile.markup.color.yellow",
  green: "mobile.markup.color.green",
  orange: "mobile.markup.color.orange",
  purple: "mobile.markup.color.purple",
  pink: "mobile.markup.color.pink",
};

/** The pill's words, by phase; `finished` says whether the PDF changed. */
export const ROUND_KEYS: Record<Exclude<RoundPhase, "finished">, TranslationKey> = {
  sent: "mobile.markup.round.sent",
  queued: "mobile.markup.round.queued",
  working: "mobile.markup.round.working",
  question: "pdfMarkup.round.question",
  unconfirmed: "mobile.markup.round.unconfirmed",
};

/** Why an asked-for `apply` round runs as `list` (the backend's `noUndo`). */
export const NO_UNDO_KEYS: Record<string, TranslationKey> = {
  not_git: "mobile.markup.noUndo.notGit",
  no_git: "mobile.markup.noUndo.noGit",
  too_big: "mobile.markup.noUndo.tooBig",
  filtered: "mobile.markup.noUndo.filtered",
  git_failed: "mobile.markup.noUndo.gitFailed",
  remote: "mobile.markup.noUndo.remote",
  not_pdf: "mobile.markup.noUndo.notPdf",
};

/** The tab bar's own status mark, where a phase has one. */
export const ROUND_MARK: Partial<Record<RoundPhase, string>> = {
  working: "working",
  question: "needs-decision",
  finished: "finished",
};

/** Closes an open dropdown on a click outside `ref` or Escape. */
function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close, ref]);
}


/** The ⋯ menu: the clearing and the sent marks' switch, then the pen's
 *  settings (shape snapping, the pressure curve) and the presets, out of the
 *  strip's way — the shared dropdown (`.context-menu.dropdown-menu`), closed
 *  by a click outside or Escape. */
export function PdfMarkupMore({ markup, page, busy, picture }: { markup: PdfMarkup; page: number; busy: boolean; picture: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);
  const pick = (run: () => void) => () => {
    run();
    setOpen(false);
  };
  const pageMarked = !!markup.edit.base.pages[page] || !!(markup.showSent && markup.edit.base.sent?.pages[page]);
  return (
    <span className="dropdown file-viewer-pdf-markup-more" ref={ref}>
      <button
        type="button"
        className={`file-viewer-zoom-btn${open ? " active" : ""}`}
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("mobile.markup.more")}
        aria-label={t("mobile.markup.more")}
      >
        ⋯
      </button>
      {open && (
        <div className="context-menu dropdown-menu" role="menu">
          {/* A picture is its one page: Clear all marks says it. */}
          {!picture && (
            <button type="button" role="menuitem" onClick={pick(() => markup.clearPage(page))} disabled={!pageMarked || busy}>
              {t("mobile.markup.clearPage", { n: page })}
            </button>
          )}
          <button type="button" role="menuitem" onClick={pick(markup.clearAll)} disabled={!markup.canClearAll || busy}>
            {t("mobile.markup.clearAll")}
          </button>
          {markup.sentShown && (
            <>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={markup.showSent}
                onClick={pick(() => markup.setShowSent(!markup.showSent))}
              >
                <span aria-hidden="true" className="file-viewer-pdf-markup-check">{markup.showSent ? "✓" : ""}</span>
                {t("mobile.markup.showSent")}
              </button>
              <button type="button" role="menuitem" onClick={pick(markup.clearSent)} disabled={busy}>
                {t("mobile.markup.clearSent")}
              </button>
            </>
          )}
          <hr />
          <button type="button" role="menuitemcheckbox" aria-checked={markup.pen.snap} onClick={pick(() => markup.setSnap(!markup.pen.snap))}>
            <span aria-hidden="true" className="file-viewer-pdf-markup-check">{markup.pen.snap ? "✓" : ""}</span>
            {t("mobile.markup.snap")}
          </button>
          {/* Steps light → normal → firm and stays open, so a few clicks find it. */}
          <button type="button" role="menuitem" onClick={markup.cyclePressure}>
            <span aria-hidden="true" className="file-viewer-pdf-markup-check" />
            {t("mobile.markup.pressure")}
            <span className="file-viewer-pdf-markup-value">{t(PRESSURE_KEYS[markup.pen.pressure])}</span>
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={pick(markup.resetPresets)}>
            <span aria-hidden="true" className="file-viewer-pdf-markup-check" />
            {t("mobile.markup.resetPresets")}
          </button>
        </div>
      )}
    </span>
  );
}


/** The markup keys, while marking: P H E L T K arm the dock's slots (the
 *  armed one again opens its options; S is the lasso too, B and M arm the box
 *  and the text marks straight away), a held E erases until it is let go
 *  (`markupStripKeyUp`), 1–6 pick the armed tool's colours in swatch order
 *  (a selection's, with marks selected), Shift+1–5 a favourite, [ and ] step
 *  the size, Delete or Backspace delete the selected marks, Escape closes the
 *  options. Whether it took the key. Shared by the PDF and the image viewer. */
export function markupStripKey(m: PdfMarkup, e: { key: string; code: string; shiftKey: boolean; repeat?: boolean }): boolean {
  const { key } = e;
  if (key === "Escape" && m.options) {
    m.setOptions(false);
    return true;
  }
  // By the key's place: Shift turns the digit into a layout's own symbol.
  const preset = e.shiftKey ? /^Digit([1-5])$/.exec(e.code) : null;
  if (preset) {
    m.applyPreset(Number(preset[1]) - 1);
    return true;
  }
  if ((key === "Delete" || key === "Backspace") && m.edit.selection) {
    m.deleteSelection();
    return true;
  }
  const lower = key.toLowerCase();
  if (lower === "e" && !e.shiftKey) {
    if (!e.repeat) m.eraserKeyDown();
    return true;
  }
  const tools: Record<string, MarkupTool> = { p: "ink", h: "highlight", l: "select", s: "select", t: "text", k: "stamp", b: "box", m: "textmark" };
  if (tools[lower] && !e.shiftKey) {
    if (lower === "k") m.pressDock("proof");
    else m.pressTool(tools[lower]);
    return true;
  }
  if (key === "[" || key === "]") {
    m.stepSize(key === "[" ? -1 : 1);
    return true;
  }
  const offered = m.tool === "select" ? selectionColors(m.edit.base, m.edit.selection) : colorsFor(m.tool, m.pen.style, m.pen.textMark);
  const color = /^[1-6]$/.test(key) ? offered[Number(key) - 1] : undefined;
  if (color && m.tool !== "eraser") {
    m.setColor(color);
    return true;
  }
  return false;
}

/** A markup key let go: the held E's quick eraser ends. Whether it took it. */
export function markupStripKeyUp(m: PdfMarkup, e: { key: string; shiftKey: boolean }): boolean {
  if (e.key.toLowerCase() !== "e" || e.shiftKey) return false;
  m.eraserKeyUp();
  return true;
}

/** How many things the agent panel holds for the reader, for the badge: the
 *  agent's open questions and its ✓ groups. `attention` — something there
 *  waits on the reader without a count (a dialog in the tab, a changed PDF, a
 *  question in another tab, a note that went wrong). */
export function agentBadge(markup: PdfMarkup): { count: number; attention: boolean } {
  const questions = markup.questions.asks.reduce((sum, ask) => sum + ask.questions.length, 0);
  const count = questions + markup.ticks.groups.length;
  const attention =
    markup.tabDialog !== null ||
    markup.stale ||
    markup.storage === "unsaved" ||
    markup.askElsewhere !== null ||
    !!markup.questions.failure ||
    !!markup.roundUndo.note?.alert ||
    markup.canApply ||
    markup.roundUndo.offered;
  return { count, attention };
}

export function PdfMarkupBar({
  markup,
  onDone,
}: {
  markup: PdfMarkup;
  /** Leave markup mode. */
  onDone: () => void;
}) {
  const t = useT();
  const { target, targets } = markup;
  const busy = markup.sending;
  const canSubmit = markup.sendable.length > 0 && target !== null && !busy && markup.edit.note === null;
  const badge = agentBadge(markup);
  return (
    <div className="file-viewer-pdf-redact-bar file-viewer-pdf-markup-bar" role="group" aria-label={t("pdfMarkup.toggle")}>
      {busy && <span className="file-viewer-pdf-redact-count">{t("mobile.markup.sendingMarks")}</span>}
      {markup.limitHit && <span className="file-viewer-pdf-redact-warn">{t("mobile.markup.limit")}</span>}
      {markup.failure && (
        <span className="file-viewer-pdf-redact-warn" role="alert">
          {markup.failure}{" "}
          <button type="button" className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={markup.dismissFailure}>
            {t("pdfViewer.dismiss")}
          </button>
        </span>
      )}
      <span className="file-viewer-pdf-markup-send">
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
        {target && markup.targetTab && (
          <PdfMarkupModel
            key={target.ptyId}
            tab={markup.targetTab}
            ptyId={target.ptyId}
            label={target.label}
            model={markup.targetModelTag}
            agent={markup.chipAgent}
            disabled={busy}
          />
        )}
        {target && (
          <button
            type="button"
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={markup.showTarget}
            title={t("pdfMarkup.showTargetTitle", { tab: target.label })}
          >
            {t("pdfMarkup.showTarget")} <UntestedTag id="desktop.markup.link" />
          </button>
        )}
        <button
          type="button"
          className={`file-viewer-zoom-btn file-viewer-zoom-text file-viewer-pdf-markup-agent${markup.panel ? " active" : ""}${badge.attention ? " is-attention" : ""}`}
          aria-pressed={markup.panel}
          aria-expanded={markup.panel}
          onClick={() => markup.setPanel(!markup.panel)}
          title={t("pdfMarkup.agentTitle")}
        >
          {t("pdfMarkup.agent")}
          {badge.count > 0 && <span className="file-viewer-pdf-markup-agent-count">{badge.count}</span>}
          {badge.count === 0 && badge.attention && <span className="file-viewer-pdf-markup-agent-dot" aria-hidden="true" />}
        </button>
        <UntestedTag id="desktop.markup.agentPanel" />
        <button
          type="button"
          className="file-viewer-zoom-btn file-viewer-zoom-text file-viewer-pdf-markup-submit"
          onClick={() => void markup.submit()}
          disabled={!canSubmit}
          title={target ? t("pdfMarkup.submitTitle", { tab: target.label }) : t("pdfMarkup.noAgent")}
        >
          {t("mobile.markup.submit")}
        </button>
        <UntestedTag id="desktop.markup.anchors" />
        <button type="button" className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={onDone} disabled={busy}>
          {t("mobile.markup.done")}
        </button>
      </span>
    </div>
  );
}

/** The Undo round confirm, wherever the agent panel is: open while the
 *  round's undo preview is. */
export function PdfMarkupUndoConfirm({ markup, onReload }: { markup: PdfMarkup; onReload: () => void }) {
  const t = useT();
  const { roundUndo } = markup;
  if (!roundUndo.preview) return null;
  return (
    <ConfirmDialog
      title={t("mobile.markup.undo.confirmTitle")}
      body={undoSummary(roundUndo.preview, t)}
      confirmLabel={t("mobile.markup.undo.confirm")}
      danger
      onCancel={roundUndo.cancel}
      onConfirm={() => {
        void roundUndo.confirm().then((done) => {
          if (done) onReload();
        });
      }}
    />
  );
}
