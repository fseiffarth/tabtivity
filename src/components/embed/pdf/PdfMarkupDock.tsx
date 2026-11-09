/**
 * The desktop markup mode's tool dock (`docs/markup_notes_style_plan.md`): a
 * small floating toolbar over the pages — the six tools (pen, highlighter,
 * eraser, lasso, text, Proof), the favourites (saved pens), undo/redo and
 * the ⋯ menu. Pressing the armed tool again opens its options (`PdfMarkupToolOptions`);
 * nothing else opens by itself. The grip drags the dock to the bottom, top,
 * left or right edge, where it stays (kept in `localStorage`); a click on the
 * grip folds it down to the grip and back.
 *
 * Chrome: the shared `.context-menu` surface (the floating recipe); the
 * dock's own CSS is size and layout only.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useT, type TranslationKey } from "../../../lib/i18n";
import { storageKey } from "../../../lib/brand";
import { readJson, writeJson } from "../../../lib/persist";
import { useChordHint } from "../../../lib/shortcuts/shortcutHint";
import { COLOR_KEYS, PdfMarkupMore, STAMP_GLYPHS, TextMarkGlyph } from "./PdfMarkupBar";
import { DOCK_LABEL_KEYS, DockIcon, ERASER_MODE_KEYS, LASSO_KEYS, proofKey } from "../../../../mobile-web/src/markup/dock";
import { UntestedTag } from "../../common/UntestedTag";
import { SquareIcon } from "../../common/icons/Icon";
import { INK } from "../../../../mobile-web/src/markup/rasterize";
import {
  colorsFor,
  DOCK_TOOLS,
  dockToolOf,
  ERASER_MODES,
  isArmed,
  LASSO_MODES,
  PEN_ONLY_STYLES,
  PROOF_PICKS,
  proofOf,
  SIZE_MAX,
  SIZE_MIN,
  type DockTool,
  type PenPreset,
  type ProofPick,
} from "../../../../mobile-web/src/markup/pen";
import type { MarkColor, PenStyle, StampSymbol } from "../../../../mobile-web/src/markup/layer";
import type { PdfMarkup } from "./usePdfMarkup";

export type DockEdge = "bottom" | "top" | "left" | "right";
const EDGES: readonly DockEdge[] = ["bottom", "top", "left", "right"];
type DockPlace = { edge: DockEdge; folded: boolean };
const DOCK_KEY = storageKey("markup.dock");
const DEFAULT_PLACE: DockPlace = { edge: "bottom", folded: false };

/** Reads the dock's place; anything unreadable is the bottom edge, open. */
export function parseDockPlace(raw: unknown): DockPlace {
  if (!raw || typeof raw !== "object") return DEFAULT_PLACE;
  const r = raw as Record<string, unknown>;
  return {
    edge: EDGES.includes(r.edge as DockEdge) ? (r.edge as DockEdge) : DEFAULT_PLACE.edge,
    folded: typeof r.folded === "boolean" ? r.folded : DEFAULT_PLACE.folded,
  };
}

/** The edge nearest to `(x, y)` within a box `width` × `height`. */
export function nearestEdge(x: number, y: number, width: number, height: number): DockEdge {
  const distances: [DockEdge, number][] = [["left", x], ["right", width - x], ["top", y], ["bottom", height - y]];
  return distances.reduce((best, next) => (next[1] < best[1] ? next : best))[0];
}

/** How far a press on the grip may travel and still be a click (fold). */
const GRIP_SLOP = 5;

const DOCK_KEYS: Record<DockTool, string> = { ink: "p", highlight: "h", eraser: "e", select: "l", text: "t", proof: "k" };
export const PEN_STYLE_KEYS: Record<PenStyle, TranslationKey> = {
  pen: "mobile.markup.style.pen",
  marker: "mobile.markup.style.marker",
  dashed: "mobile.markup.style.dashed",
  arrow: "mobile.markup.style.arrow",
};

/** A proofreading pick drawn: the box, "ab" struck / underlined /
 *  highlighted, or the stamp's symbol. */
export function ProofGlyph({ pick }: { pick: ProofPick }) {
  if (pick === "box") return <SquareIcon />;
  if (pick === "strike" || pick === "underline" || pick === "highlight") return <TextMarkGlyph mode={pick} />;
  return <span aria-hidden="true">{STAMP_GLYPHS[pick as StampSymbol]}</span>;
}

/** A favourite drawn as a dot of its colour, as wide as its size draws (the
 *  highlighter's wider and see-through). */
export function FavouriteDot({ preset }: { preset: PenPreset }) {
  const wide = preset.tool === "highlight" || preset.tool === "box";
  const px = wide ? 16 : Math.round(5 + preset.size * 0.9);
  return <span className={`file-viewer-pdf-markup-fav-dot${wide ? " is-wide" : ""}`} style={{ width: px, height: px, background: INK[preset.color] }} aria-hidden="true" />;
}

export function PdfMarkupDock({
  markup,
  page,
  picture = false,
  area,
}: {
  markup: PdfMarkup;
  /** The page on screen, for Clear page. */
  page: number;
  picture?: boolean;
  /** The pages' own box within the dock's container: the dock sits over it,
   *  clear of a page rail or the agent panel beside it. The whole container
   *  when left out. */
  area?: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const chordHint = useChordHint();
  const [place, setPlace] = useState<DockPlace>(() => readJson(DOCK_KEY, parseDockPlace, DEFAULT_PLACE));
  useEffect(() => {
    writeJson(DOCK_KEY, place);
  }, [place]);
  const ref = useRef<HTMLDivElement>(null);
  const [inset, setInset] = useState({ left: 0, right: 0 });
  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    const over = area?.current;
    if (!box || !over) return;
    const measure = () => {
      const outer = box.getBoundingClientRect();
      const inner = over.getBoundingClientRect();
      const next = { left: Math.max(0, Math.round(inner.left - outer.left)), right: Math.max(0, Math.round(outer.right - inner.right)) };
      setInset((was) => (was.left === next.left && was.right === next.right ? was : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    watch.observe(over);
    return () => watch.disconnect();
  }, [area]);
  /** The grip's drag: where it began, and the pointer now (container px). */
  const [drag, setDrag] = useState<{ id: number; startX: number; startY: number; x: number; y: number; moved: boolean } | null>(null);
  const container = () => ref.current?.parentElement?.getBoundingClientRect() ?? null;
  const onGripDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const box = container();
    setDrag({ id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0), moved: false });
  };
  const onGripMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.id !== event.pointerId) return;
    const moved = drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > GRIP_SLOP;
    const box = container();
    setDrag({ ...drag, moved, x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) });
  };
  const onGripUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.id !== event.pointerId) return;
    setDrag(null);
    if (!drag.moved) {
      setPlace((was) => ({ ...was, folded: !was.folded }));
      markup.setOptions(false);
      return;
    }
    const box = container();
    if (box) setPlace((was) => ({ ...was, edge: nearestEdge(drag.x, drag.y, box.width, box.height) }));
  };
  const slot = dockToolOf(markup.tool);
  // The text marks read the words of the page on screen.
  const wantText = markup.edit.wantText;
  useEffect(() => {
    if (markup.tool === "textmark") wantText(page);
  }, [markup.tool, page, wantText]);
  const noText = markup.tool === "textmark" && markup.edit.text(page)?.length === 0;
  const vertical = place.edge === "left" || place.edge === "right";
  const style: CSSProperties = {
    ["--dock-inset-left" as string]: `${inset.left}px`,
    ["--dock-inset-right" as string]: `${inset.right}px`,
    ...(drag?.moved ? { left: drag.x, top: drag.y, right: "auto", bottom: "auto", transform: "translate(-50%, -50%)" } : {}),
  };
  const sep = <span className="file-viewer-pdf-markup-dock-sep" aria-hidden="true" />;
  return (
    <div
      ref={ref}
      className={`context-menu file-viewer-pdf-markup-dock is-${place.edge}${vertical ? " is-vertical" : ""}${place.folded ? " is-folded" : ""}${drag?.moved ? " is-dragging" : ""}`}
      style={style}
      role="toolbar"
      aria-label={t("pdfMarkup.dock")}
      aria-orientation={vertical ? "vertical" : "horizontal"}
    >
      <button
        type="button"
        className="file-viewer-pdf-markup-grip"
        title={t("pdfMarkup.dockGrip")}
        aria-label={t("pdfMarkup.dockGrip")}
        aria-expanded={!place.folded}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={() => setDrag(null)}
      >
        <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true">
          <circle cx="2" cy="2" r="1.3" /><circle cx="6" cy="2" r="1.3" /><circle cx="2" cy="7" r="1.3" />
          <circle cx="6" cy="7" r="1.3" /><circle cx="2" cy="12" r="1.3" /><circle cx="6" cy="12" r="1.3" />
        </svg>
      </button>
      {!place.folded && (
        <>
          {DOCK_TOOLS.map((tool) => {
            const on = slot === tool;
            const label = t(DOCK_LABEL_KEYS[tool]);
            return (
              <button
                key={tool}
                type="button"
                className={`file-viewer-pdf-markup-dock-btn${on ? " active" : ""}`}
                aria-pressed={on}
                aria-expanded={on ? markup.options : undefined}
                title={chordHint(label, { key: DOCK_KEYS[tool] })}
                aria-label={label}
                onClick={() => markup.pressDock(tool)}
              >
                <DockIcon tool={tool} />
              </button>
            );
          })}
          {markup.pen.presets.length > 0 && sep}
          {markup.pen.presets.map((preset, i) => {
            const on = isArmed(markup.pen, preset);
            return (
              <button
                key={i}
                type="button"
                className={`file-viewer-pdf-markup-dock-btn file-viewer-pdf-markup-fav${on ? " active" : ""}`}
                aria-pressed={on}
                title={chordHint(t("pdfMarkup.favouriteTitle", { n: i + 1 }), { key: String(i + 1), shift: true })}
                aria-label={t("mobile.markup.preset", { n: i + 1 })}
                onClick={() => {
                  markup.setOptions(false);
                  markup.applyPreset(i);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  markup.removePreset(i);
                }}
              >
                <FavouriteDot preset={preset} />
              </button>
            );
          })}
          {sep}
          <button
            type="button"
            className="file-viewer-pdf-markup-dock-btn"
            onClick={markup.undo}
            disabled={!markup.canUndo || markup.sending}
            title={chordHint(t("mobile.markup.undo"), { key: "z", ctrl: true })}
            aria-label={t("mobile.markup.undo")}
          >
            ↶
          </button>
          <button
            type="button"
            className="file-viewer-pdf-markup-dock-btn"
            onClick={markup.redo}
            disabled={!markup.canRedo || markup.sending}
            title={chordHint(t("mobile.markup.redo"), { key: "z", ctrl: true, shift: true })}
            aria-label={t("mobile.markup.redo")}
          >
            ↷
          </button>
          <PdfMarkupMore markup={markup} page={page} busy={markup.sending} picture={picture} />
          <UntestedTag id="desktop.markup.dock" />
          {markup.options && <PdfMarkupToolOptions markup={markup} slot={slot} noText={noText} />}
        </>
      )}
    </div>
  );
}

/** A row of colour swatches; `chosen` is pressed, digit keys 1–6 in order. */
function DockSwatches({ colors, chosen, onPick }: { colors: readonly MarkColor[]; chosen: MarkColor | null; onPick: (color: MarkColor) => void }) {
  const t = useT();
  const chordHint = useChordHint();
  return (
    <span className="file-viewer-pdf-markup-colors file-viewer-pdf-markup-pop-row" role="group" aria-label={t("mobile.markup.color")}>
      {colors.map((color, i) => {
        const name = t(COLOR_KEYS[color]);
        return (
          <button
            key={color}
            type="button"
            className={`file-viewer-zoom-btn file-viewer-pdf-markup-swatch is-${color}${chosen === color ? " active" : ""}`}
            aria-pressed={chosen === color}
            title={chordHint(name, { key: String(i + 1) })}
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

/** A segmented choice (`.seg`). */
function Seg<T extends string>({ label, options, chosen, name, onPick }: { label: string; options: readonly T[]; chosen: T; name: (option: T) => string; onPick: (option: T) => void }) {
  return (
    <span className="seg file-viewer-pdf-markup-pop-row" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option} type="button" className={chosen === option ? "active" : undefined} aria-pressed={chosen === option} onClick={() => onPick(option)}>
          {name(option)}
        </button>
      ))}
    </span>
  );
}

/** The size slider, 1–12; `[` and `]` step it. */
function SizeSlider({ markup }: { markup: PdfMarkup }) {
  const t = useT();
  return (
    <label className="file-viewer-pdf-markup-pop-row file-viewer-pdf-markup-size-row">
      <span>{t("mobile.markup.size")}</span>
      <input
        type="range"
        min={SIZE_MIN}
        max={SIZE_MAX}
        step={1}
        value={markup.pen.size}
        onChange={(event) => markup.setSize(Number(event.target.value))}
        aria-label={t("mobile.markup.size")}
      />
      <span className="file-viewer-pdf-markup-value">{markup.pen.size}</span>
    </label>
  );
}

/** The armed slot's options, opened by pressing that slot again: the pen's
 *  colours, size and style; the highlighter's colours, size and straight
 *  lines; the eraser's mode and highlighter-only switch; the lasso's shape;
 *  a note's colour; the proofreading marks' grid and colours. */
export function PdfMarkupToolOptions({ markup, slot, noText = false }: { markup: PdfMarkup; slot: DockTool; noText?: boolean }) {
  const t = useT();
  const { pen } = markup;
  const title = t("mobile.markup.options", { tool: t(DOCK_LABEL_KEYS[slot]) });
  const saveable = slot === "ink" || slot === "highlight";
  const colors = slot === "eraser" || slot === "select" ? [] : colorsFor(markup.tool, pen.style, pen.textMark);
  const proof = proofOf(pen);
  return (
    <div className="context-menu menu-form file-viewer-pdf-markup-pop" role="group" aria-label={title} onPointerDown={(event) => event.stopPropagation()}>
      <div className="file-viewer-pdf-markup-pop-head">{title}</div>
      {slot === "proof" && (
        <div className="file-viewer-pdf-markup-proof" role="group" aria-label={t("mobile.markup.tool.proof")}>
          {PROOF_PICKS.map((pick) => (
            <button key={pick} type="button" className={proof === pick ? "active" : undefined} aria-pressed={proof === pick} onClick={() => markup.pickProof(pick)}>
              <ProofGlyph pick={pick} />
              <span>{t(proofKey(pick))}</span>
            </button>
          ))}
        </div>
      )}
      {slot === "proof" && noText && <p className="file-viewer-pdf-markup-pop-hint file-viewer-pdf-redact-warn">{t("mobile.markup.noText")}</p>}
      {colors.length > 0 && <DockSwatches colors={colors} chosen={markup.color} onPick={markup.setColor} />}
      {(slot === "ink" || slot === "highlight" || (slot === "proof" && markup.tool === "textmark" && pen.textMark !== "highlight")) && <SizeSlider markup={markup} />}
      {slot === "ink" && (
        <Seg label={t("mobile.markup.style")} options={PEN_ONLY_STYLES} chosen={pen.style} name={(style) => t(PEN_STYLE_KEYS[style])} onPick={markup.setStyle} />
      )}
      {slot === "highlight" && (
        <>
          <label className="file-viewer-pdf-markup-pop-row">
            <input type="checkbox" checked={pen.straight} onChange={(event) => markup.setStraight(event.target.checked)} />
            {t("mobile.markup.straight")}
          </label>
          <p className="file-viewer-pdf-markup-pop-hint">{t("mobile.markup.highlightHint")}</p>
        </>
      )}
      {slot === "eraser" && (
        <>
          <Seg label={t("mobile.markup.tool.eraser")} options={ERASER_MODES} chosen={pen.eraser} name={(mode) => t(ERASER_MODE_KEYS[mode])} onPick={markup.setEraser} />
          <label className="file-viewer-pdf-markup-pop-row">
            <input type="checkbox" checked={pen.eraseHighlights} onChange={(event) => markup.setEraseHighlights(event.target.checked)} />
            {t("mobile.markup.eraseHighlights")}
          </label>
          <p className="file-viewer-pdf-markup-pop-hint">{t("pdfMarkup.quickEraseHint")}</p>
          <UntestedTag id="desktop.markup.eraser" />
          <UntestedTag id="desktop.markup.areaEraser" />
        </>
      )}
      {slot === "select" && (
        <>
          <Seg label={t("mobile.markup.tool.lasso")} options={LASSO_MODES} chosen={pen.lasso} name={(mode) => t(LASSO_KEYS[mode])} onPick={markup.setLasso} />
          <p className="file-viewer-pdf-markup-pop-hint">{t("pdfMarkup.lassoHint")}</p>
        </>
      )}
      {slot === "text" && <p className="file-viewer-pdf-markup-pop-hint">{t("pdfMarkup.textHint")}</p>}
      {saveable && (
        <button type="button" className="btn-quiet file-viewer-pdf-markup-pop-save" onClick={markup.savePreset}>
          {t("mobile.markup.savePreset")}
        </button>
      )}
      {slot === "ink" ? <UntestedTag id="desktop.markup.pen" /> : slot === "proof" || slot === "select" ? <UntestedTag id="desktop.markup.tools2" /> : null}
    </div>
  );
}
