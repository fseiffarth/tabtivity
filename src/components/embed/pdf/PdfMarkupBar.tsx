/**
 * The desktop markup mode's strips under the PDF toolbar (`usePdfMarkup`):
 * the tools, the agent tab a Submit goes to and Submit itself, then a status
 * line with the round's pill and Reload. Built from the blackout tool's strip
 * (`file-viewer-pdf-redact-bar`) and the copy mode's status line
 * (`file-viewer-pdf-copy-bar`), as the metadata panel is — no new chrome, and
 * nothing portaled.
 *
 * The tool strip reads left to right: the tools, the armed tool's options
 * (the pen's style, size and colours; a box's or note's colours; the text
 * marks' mode, the stamp's symbol; the selection's colours, styles, Delete
 * and Comment; the eraser's reach or area), the saved pens (presets),
 * undo/redo and a ⋯ menu for the clearing and the pen's settings; the
 * sending half — target, model, Submit, Done — sits at the right end.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT, type TranslationKey } from "../../../lib/i18n";
import { useChordHint } from "../../../lib/shortcuts/shortcutHint";
import { STAMP_SYMBOLS, type Layer, type MarkColor, type StampSymbol } from "../../../../mobile-web/src/markup/layer";
import {
  COLOR_MEANING,
  colorsFor,
  ERASER_MODES,
  PEN_SIZES,
  PEN_STYLES,
  TEXT_MARK_MODES,
  type EraserMode,
  type PenPreset,
  type PenPrefs,
  type PenSize,
  type PenStyle,
  type PressureCurve,
  type TextMarkMode,
} from "../../../../mobile-web/src/markup/pen";
import { EraserIcon } from "../../../../mobile-web/src/markup/EraserIcon";
import { INK } from "../../../../mobile-web/src/markup/rasterize";
import { undoSummary, type RoundPhase } from "../../../../mobile-web/src/markup/submitState";
import { ConfirmDialog } from "../../common/PromptDialogs";
import { UntestedTag } from "../../common/UntestedTag";
import { TabStatusMark } from "../../tabs/TabLocalityBadges";
import { PdfMarkupModel } from "./PdfMarkupModel";
import { PdfTicksStatus } from "./PdfMarkupTicks";
import type { MarkSelection, MarkupTool, PdfMarkup } from "./usePdfMarkup";

/** The text marks' modes as the word "ab" struck, underlined or highlighted. */
function TextMarkGlyph({ mode }: { mode: TextMarkMode }) {
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

/** Each tool with its key (`PdfViewer`'s markup keys), in the phone's order;
 *  the text marks and the stamp show their armed mode or symbol. */
function toolList(pen: PenPrefs): { tool: MarkupTool; glyph: ReactNode; label: TranslationKey; key: string }[] {
  return [
    { tool: "ink", glyph: "✎", label: "mobile.markup.tool.ink", key: "p" },
    { tool: "box", glyph: "▭", label: "mobile.markup.tool.box", key: "b" },
    { tool: "text", glyph: "T", label: "mobile.markup.tool.text", key: "t" },
    { tool: "stamp", glyph: STAMP_GLYPHS[pen.stamp], label: "mobile.markup.tool.stamp", key: "k" },
    { tool: "textmark", glyph: <TextMarkGlyph mode={pen.textMark} />, label: "mobile.markup.tool.textmark", key: "m" },
    { tool: "select", glyph: "⬚", label: "mobile.markup.tool.select", key: "s" },
    { tool: "eraser", glyph: <EraserIcon />, label: "mobile.markup.tool.eraser", key: "e" },
  ];
}

/** A preset's chip: the glyph of its tool (the pen's style) over a bar of its
 *  colour. */
function presetGlyph(preset: PenPreset): ReactNode {
  if (preset.tool === "ink") return STYLE_GLYPHS[preset.style];
  if (preset.tool === "box") return "▭";
  if (preset.tool === "text") return "T";
  if (preset.tool === "stamp") return STAMP_GLYPHS.insert;
  return <TextMarkGlyph mode="highlight" />;
}

/** Whether the armed pen is `preset`. */
function armed(pen: PenPrefs, color: MarkColor, preset: PenPreset): boolean {
  return pen.tool === preset.tool && color === preset.color && pen.size === preset.size && (preset.tool !== "ink" || pen.style === preset.style);
}

/** The colours a selection may take, in strip order: yellow too when one of
 *  its marks highlights (a box or the marker); none without a selection. */
export function selectionColors(layer: Layer, selection: MarkSelection | null): readonly MarkColor[] {
  if (!selection) return [];
  const marks = selection.indices.map((i) => layer.pages[selection.n]?.marks[i]);
  const highlights = marks.some((mark) => mark?.kind === "box" || (mark?.kind === "ink" && mark.style === "marker"));
  return colorsFor(highlights ? "box" : "ink", "pen");
}

export const STYLE_GLYPHS: Record<PenStyle, string> = { pen: "✎", marker: "▬", dashed: "┄", arrow: "↗" };
export const STYLE_KEYS: Record<PenStyle, TranslationKey> = {
  pen: "mobile.markup.style.pen",
  marker: "mobile.markup.style.marker",
  dashed: "mobile.markup.style.dashed",
  arrow: "mobile.markup.style.arrow",
};
export const SIZE_KEYS: Record<PenSize, TranslationKey> = {
  0: "mobile.markup.size.0",
  1: "mobile.markup.size.1",
  2: "mobile.markup.size.2",
};
export const ERASER_KEYS: Record<EraserMode, TranslationKey> = {
  small: "mobile.markup.eraser.small",
  medium: "mobile.markup.eraser.medium",
  large: "mobile.markup.eraser.large",
  area: "mobile.markup.eraser.area",
};
export const MEANING_KEYS: Record<(typeof COLOR_MEANING)[MarkColor], TranslationKey> = {
  fix: "mobile.markup.meaning.fix",
  insert: "mobile.markup.meaning.insert",
  neutral: "mobile.markup.meaning.neutral",
  check: "mobile.markup.meaning.check",
};
/** A size or reach as a dot of its own size, CSS px. */
const DOT_PX: Record<PenSize, number> = { 0: 4, 1: 7, 2: 11 };

export const COLOR_KEYS: Record<MarkColor, TranslationKey> = {
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

/** Why an asked-for `apply` round runs as `list` (the backend's `noUndo`). */
const NO_UNDO_KEYS: Record<string, TranslationKey> = {
  not_git: "mobile.markup.noUndo.notGit",
  no_git: "mobile.markup.noUndo.noGit",
  too_big: "mobile.markup.noUndo.tooBig",
  filtered: "mobile.markup.noUndo.filtered",
  git_failed: "mobile.markup.noUndo.gitFailed",
  remote: "mobile.markup.noUndo.remote",
  not_pdf: "mobile.markup.noUndo.notPdf",
};

/** The tab bar's own status mark, where a phase has one. */
const ROUND_MARK: Partial<Record<RoundPhase, string>> = {
  working: "working",
  question: "needs-decision",
  finished: "finished",
};

/** The ⋯ menu: the clearing and the sent marks' switch, then the pen's
 *  settings (shape snapping, the pressure curve) and the presets, out of the
 *  strip's way — the shared dropdown (`.context-menu.dropdown-menu`), closed
 *  by a click outside or Escape. */
function PdfMarkupMore({ markup, page, busy }: { markup: PdfMarkup; page: number; busy: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
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
          <button type="button" role="menuitem" onClick={pick(() => markup.clearPage(page))} disabled={!pageMarked || busy}>
            {t("mobile.markup.clearPage", { n: page })}
          </button>
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
          <button
            type="button"
            role="menuitem"
            onClick={pick(markup.savePreset)}
            disabled={markup.tool === "eraser" || markup.tool === "select"}
          >
            <span aria-hidden="true" className="file-viewer-pdf-markup-check" />
            {t("mobile.markup.savePreset")}
          </button>
          <button type="button" role="menuitem" onClick={pick(markup.resetPresets)}>
            <span aria-hidden="true" className="file-viewer-pdf-markup-check" />
            {t("mobile.markup.resetPresets")}
          </button>
        </div>
      )}
    </span>
  );
}

/** A row of colour swatches; `chosen` is pressed, digit keys 1–4 in order. */
function Swatches({ colors, chosen, onPick }: { colors: readonly MarkColor[]; chosen: MarkColor | null; onPick: (color: MarkColor) => void }) {
  const t = useT();
  const chordHint = useChordHint();
  return (
    <span className="file-viewer-pdf-markup-colors" role="group" aria-label={t("mobile.markup.color")}>
      {colors.map((color, i) => {
        const name = t(COLOR_KEYS[color]);
        const meaning = t(MEANING_KEYS[COLOR_MEANING[color]]);
        return (
          <button
            key={color}
            type="button"
            className={`file-viewer-zoom-btn file-viewer-pdf-markup-swatch is-${color}${chosen === color ? " active" : ""}`}
            aria-pressed={chosen === color}
            title={chordHint(t("mobile.markup.colorMeaning", { color: name, meaning }), { key: String(i + 1) })}
            aria-label={t("mobile.markup.colorOf", { color: name })}
            onClick={() => onPick(color)}
            style={{ ["--swatch" as string]: INK[color] }}
          >
            <span aria-hidden="true" />
          </button>
        );
      })}
    </span>
  );
}

/** The select tool's options: how many marks are picked, their colours and
 *  (strokes among them) styles, Delete, and Comment for a lone mark. */
function PdfSelectionOptions({ markup }: { markup: PdfMarkup }) {
  const t = useT();
  const chordHint = useChordHint();
  const selection = markup.edit.selection;
  if (!selection) return null;
  const marks = selection.indices.flatMap((i) => markup.edit.base.pages[selection.n]?.marks[i] ?? []);
  const inks = marks.flatMap((mark) => (mark.kind === "ink" ? [mark] : []));
  /** What every picked mark shares, else nothing pressed. */
  const same = <T,>(values: readonly T[]): T | null => (values.length && values.every((v) => v === values[0]) ? values[0] : null);
  const style = same(inks.map((mark) => mark.style ?? "pen"));
  const color = same(marks.map((mark) => mark.color));
  return (
    <>
      <span className="file-viewer-pdf-redact-count">{t("mobile.markup.selected", { count: selection.indices.length })}</span>
      {inks.length > 0 && (
        <span className="file-viewer-pdf-markup-styles" role="group" aria-label={t("mobile.markup.style")}>
          {PEN_STYLES.map((entry) => (
            <button
              key={entry}
              type="button"
              className={`file-viewer-zoom-btn${style === entry ? " active" : ""}`}
              aria-pressed={style === entry}
              title={t(STYLE_KEYS[entry])}
              aria-label={t(STYLE_KEYS[entry])}
              onClick={() => markup.restyleSelection({ style: entry })}
            >
              {STYLE_GLYPHS[entry]}
            </button>
          ))}
        </span>
      )}
      <Swatches colors={selectionColors(markup.edit.base, selection)} chosen={color} onPick={(next) => markup.restyleSelection({ color: next })} />
      <button
        type="button"
        className="file-viewer-zoom-btn file-viewer-zoom-text"
        onClick={markup.openComment}
        disabled={!markup.canComment || markup.edit.comment !== null}
        title={t("mobile.markup.commentPlaceholder")}
      >
        {t("mobile.markup.comment")}
      </button>
      <button
        type="button"
        className="file-viewer-zoom-btn file-viewer-zoom-text file-viewer-pdf-note-del"
        onClick={markup.deleteSelection}
        title={chordHint(t("mobile.markup.deleteSelected"), { key: "Delete" })}
      >
        {t("mobile.markup.deleteSelected")}
      </button>
    </>
  );
}

/** The armed tool's options: the pen's style, size and colours; a box's or
 *  a note's colours; the text marks' modes and the stamp's symbols, each
 *  with their colours; the selection's; the eraser's reach or its area mode. */
function PdfMarkupOptions({ markup }: { markup: PdfMarkup }) {
  const t = useT();
  const chordHint = useChordHint();
  const { pen, tool } = markup;
  if (tool === "eraser") {
    return (
      <span className="file-viewer-pdf-markup-options" role="group" aria-label={t("mobile.markup.tool.eraser")}>
        {ERASER_MODES.map((mode, i) => (
          <button
            key={mode}
            type="button"
            className={`file-viewer-zoom-btn file-viewer-pdf-markup-size${pen.eraser === mode ? " active" : ""}`}
            aria-pressed={pen.eraser === mode}
            title={mode === "area" ? chordHint(t(ERASER_KEYS[mode]), { key: "e" }) : t(ERASER_KEYS[mode])}
            aria-label={t(ERASER_KEYS[mode])}
            onClick={() => markup.setEraser(mode)}
          >
            {mode === "area" ? (
              <span className="file-viewer-pdf-markup-area" aria-hidden="true" />
            ) : (
              <span className="file-viewer-pdf-markup-ring" style={{ width: DOT_PX[i as PenSize] + 3, height: DOT_PX[i as PenSize] + 3 }} aria-hidden="true" />
            )}
          </button>
        ))}
        <UntestedTag id="desktop.markup.areaEraser" />
      </span>
    );
  }
  if (tool === "select") {
    return (
      <span className="file-viewer-pdf-markup-options" role="group" aria-label={t("mobile.markup.tool.select")}>
        <PdfSelectionOptions markup={markup} />
      </span>
    );
  }
  const colors = colorsFor(tool, pen.style, pen.textMark);
  return (
    <span className="file-viewer-pdf-markup-options">
      {tool === "ink" && (
        <span className="file-viewer-pdf-markup-styles" role="group" aria-label={t("mobile.markup.style")}>
          {PEN_STYLES.map((style) => (
            <button
              key={style}
              type="button"
              className={`file-viewer-zoom-btn${pen.style === style ? " active" : ""}`}
              aria-pressed={pen.style === style}
              title={chordHint(t(STYLE_KEYS[style]), { key: "p" })}
              aria-label={t(STYLE_KEYS[style])}
              onClick={() => markup.setStyle(style)}
            >
              {STYLE_GLYPHS[style]}
            </button>
          ))}
        </span>
      )}
      {tool === "textmark" && (
        <span className="file-viewer-pdf-markup-styles" role="group" aria-label={t("mobile.markup.tool.textmark")}>
          {TEXT_MARK_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={`file-viewer-zoom-btn${pen.textMark === mode ? " active" : ""}`}
              aria-pressed={pen.textMark === mode}
              title={chordHint(t(TEXT_MARK_KEYS[mode]), { key: "m" })}
              aria-label={t(TEXT_MARK_KEYS[mode])}
              onClick={() => markup.setTextMark(mode)}
            >
              <TextMarkGlyph mode={mode} />
            </button>
          ))}
        </span>
      )}
      {tool === "stamp" && (
        <span className="file-viewer-pdf-markup-styles" role="group" aria-label={t("mobile.markup.tool.stamp")}>
          {STAMP_SYMBOLS.map((symbol) => (
            <button
              key={symbol}
              type="button"
              className={`file-viewer-zoom-btn${pen.stamp === symbol ? " active" : ""}`}
              aria-pressed={pen.stamp === symbol}
              title={chordHint(t(STAMP_KEYS[symbol]), { key: "k" })}
              aria-label={t(STAMP_KEYS[symbol])}
              onClick={() => markup.setStamp(symbol)}
            >
              {STAMP_GLYPHS[symbol]}
            </button>
          ))}
        </span>
      )}
      {(tool === "ink" || tool === "textmark") && (
        <span className="file-viewer-pdf-markup-sizes" role="group" aria-label={t("mobile.markup.size")}>
          {PEN_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={`file-viewer-zoom-btn file-viewer-pdf-markup-size${pen.size === size ? " active" : ""}`}
              aria-pressed={pen.size === size}
              title={chordHint(t(SIZE_KEYS[size]), { key: size < pen.size ? "[" : "]" })}
              aria-label={t(SIZE_KEYS[size])}
              onClick={() => markup.setSize(size)}
            >
              <span style={{ width: DOT_PX[size], height: DOT_PX[size], background: INK[markup.color] }} aria-hidden="true" />
            </button>
          ))}
        </span>
      )}
      <Swatches colors={colors} chosen={markup.color} onPick={markup.setColor} />
      {tool === "textmark" || tool === "stamp" ? <UntestedTag id="desktop.markup.tools2" /> : <UntestedTag id="desktop.markup.pen" />}
    </span>
  );
}

/** The saved pens: a chip each, its tool's glyph over a bar of its colour;
 *  a click or Shift+1…4 arms it. */
function PdfMarkupPresets({ markup }: { markup: PdfMarkup }) {
  const t = useT();
  const chordHint = useChordHint();
  return (
    <span className="file-viewer-pdf-markup-presets" role="group" aria-label={t("mobile.markup.presets")}>
      {markup.pen.presets.map((preset, i) => {
        const on = armed(markup.pen, markup.color, preset);
        return (
          <button
            key={i}
            type="button"
            className={`file-viewer-zoom-btn file-viewer-pdf-markup-preset${on ? " active" : ""}`}
            aria-pressed={on}
            title={chordHint(t("mobile.markup.preset", { n: i + 1 }), { key: String(i + 1), shift: true })}
            aria-label={t("mobile.markup.preset", { n: i + 1 })}
            onClick={() => markup.applyPreset(i)}
            style={{ ["--swatch" as string]: INK[preset.color] }}
          >
            {presetGlyph(preset)}
          </button>
        );
      })}
    </span>
  );
}

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
  const chordHint = useChordHint();
  const { round, target, targets, roundUndo } = markup;
  const busy = markup.sending;
  const canSubmit = markup.sendable.length > 0 && target !== null && !busy && markup.edit.note === null;
  const roundWords = round
    ? round.phase === "finished"
      ? t(markup.stale ? "mobile.markup.round.finishedChanged" : "mobile.markup.round.finished")
      : round.phase === "question" && markup.questions.asks.length > 0
        ? t("pdfMarkup.round.asks")
        : round.phase === "working" && markup.targetModel
          ? t("mobile.markup.round.workingModel", { model: markup.targetModel })
          : t(ROUND_KEYS[round.phase])
    : null;
  const mark = round ? ROUND_MARK[round.phase] : undefined;
  /** Reload is offered only when the file changed under the marks — the
   *  mtime poll's word — never when there is nothing new to load; it leads
   *  until reloaded once. */
  const canReload = markup.stale;
  const reloadLeads = markup.stale && !markup.reloaded;
  // The text marks read the words of the page on screen — and the hint says
  // when it has none.
  const wantText = markup.edit.wantText;
  useEffect(() => {
    if (markup.tool === "textmark") wantText(page);
  }, [markup.tool, page, wantText]);
  const pageRuns = markup.edit.text(page);
  const hint: TranslationKey | null =
    markup.tool === "text"
      ? "pdfMarkup.textHint"
      : markup.tool === "eraser"
        ? markup.pen.eraser === "area" ? "mobile.markup.eraserAreaHint" : "pdfMarkup.eraserHint"
        : markup.tool === "textmark"
          ? pageRuns && pageRuns.length === 0 ? "mobile.markup.noText" : "mobile.markup.textMarkHint"
          : markup.tool === "stamp"
            ? "mobile.markup.stampHint"
            : markup.tool === "select" && !markup.edit.selection
              ? "mobile.markup.selectHint"
              : null;

  return (
    <>
      <div className="file-viewer-pdf-redact-bar file-viewer-pdf-markup-bar" role="group" aria-label={t("pdfMarkup.toggle")}>
        <span className="file-viewer-pdf-markup-tools" role="group" aria-label={t("mobile.markup.tools")}>
          {toolList(markup.pen).map(({ tool, glyph, label, key }) => (
            <button
              key={tool}
              type="button"
              className={`file-viewer-zoom-btn${markup.tool === tool ? " active" : ""}`}
              aria-pressed={markup.tool === tool}
              title={chordHint(tool === "ink" ? `${t(label)} — ${t("pdfMarkup.hint")}` : t(label), { key })}
              aria-label={t(label)}
              onClick={() => markup.setTool(tool)}
            >
              {glyph}
            </button>
          ))}
          <UntestedTag id="desktop.markup.tools2" />
        </span>
        <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
        <PdfMarkupOptions markup={markup} />
        <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
        {markup.pen.presets.length > 0 && (
          <>
            <PdfMarkupPresets markup={markup} />
            <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
          </>
        )}
        <button
          type="button"
          className="file-viewer-zoom-btn"
          onClick={markup.undo}
          disabled={!markup.canUndo || busy}
          title={chordHint(t("mobile.markup.undo"), { key: "z", ctrl: true })}
          aria-label={t("mobile.markup.undo")}
        >
          ↶
        </button>
        <button
          type="button"
          className="file-viewer-zoom-btn"
          onClick={markup.redo}
          disabled={!markup.canRedo || busy}
          title={chordHint(t("mobile.markup.redo"), { key: "z", ctrl: true, shift: true })}
          aria-label={t("mobile.markup.redo")}
        >
          ↷
        </button>
        <PdfMarkupMore markup={markup} page={page} busy={busy} />
        {hint && (
          <span className={`file-viewer-pdf-redact-hint${hint === "mobile.markup.noText" ? " file-viewer-pdf-redact-warn" : ""}`}>
            {t(hint)}
            {markup.tool === "eraser" && <UntestedTag id="desktop.markup.eraser" />}
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
              agent={markup.agent}
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
      {(round || markup.stale || markup.autoReloaded || busy || markup.failure || markup.storage === "unsaved" || markup.changed
        || markup.leftOut > 0 || markup.limitHit || markup.askElsewhere || roundUndo.note || markup.ticks.marks.length > 0) && (
        <div className="file-viewer-pdf-copy-bar file-viewer-pdf-markup-status" role="status" aria-live="polite">
          {round && roundWords && (
            <span className="file-viewer-pdf-markup-round">
              {mark && <TabStatusMark stateClass={mark} />}
              <span>{roundWords}</span>
            </span>
          )}
          {markup.tabDialog && target && (
            <>
              {markup.tabDialog.line && (
                <span className="file-viewer-pdf-markup-dialog" title={markup.tabDialog.line}>
                  {t("pdfMarkup.tabDialog", { line: markup.tabDialog.line })}
                </span>
              )}
              <button
                type="button"
                className="file-viewer-zoom-btn file-viewer-zoom-text active"
                onClick={markup.showTarget}
                title={t("pdfMarkup.answerInTabTitle", { tab: target.label })}
              >
                {t("pdfMarkup.answerInTab")} <UntestedTag id="desktop.markup.tabDialog" />
              </button>
            </>
          )}
          <PdfTicksStatus count={markup.ticks.groups.length} disabled={busy} onApproveAll={markup.ticks.approveAll} />
          {markup.stale && !(round?.phase === "finished") && <span>{t("pdfMarkup.stale")}</span>}
          {markup.autoReloaded && !markup.stale && (
            <span className="file-viewer-pdf-markup-auto-reloaded">
              {t("pdfMarkup.autoReloaded")} <UntestedTag id="desktop.markup.autoReload" />
            </span>
          )}
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
          {roundUndo.noUndo && (
            <span>{t("mobile.markup.noUndo", { reason: t(NO_UNDO_KEYS[roundUndo.noUndo] ?? "mobile.markup.noUndo.other") })}</span>
          )}
          {roundUndo.note && (
            <span className={roundUndo.note.alert ? "file-viewer-pdf-redact-warn" : undefined} role={roundUndo.note.alert ? "alert" : undefined}>
              {roundUndo.note.text}
            </span>
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
      {roundUndo.preview && (
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
      )}
    </>
  );
}
