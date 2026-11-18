/**
 * The pen bar's choices, shared by the phone's `MarkupView` and the desktop's
 * `usePdfMarkup`: the armed tool, a colour per tool, the pen's style and size,
 * the eraser's mode, the highlighter's straight lines, the proofreading
 * mark the Proof slot arms, the lasso's shape, and the saved pens. Kept per
 * viewer (`localStorage`), a convenience only: an unreadable or missing
 * record is the defaults.
 *
 * The dock shows six tools (`DOCK_TOOLS`, `docs/markup_notes_style_plan.md`):
 * pen, highlighter, eraser, lasso (`select`), text and Proof — the box, the
 * text marks and the stamps behind one slot (`PROOF_PICKS`).
 *
 * The colours are plain colours: the prompt names a mark's colour so the
 * agent finds it on the page picture, never what it should mean. Yellow and
 * pink only highlight — a box, the highlighter, highlighted words — since
 * yellow or pink ink or text is unreadable on white.
 *
 * Beside the tools: shape snapping, the stylus's pressure curve, palm
 * rejection (phone) and up to five saved pens (`presets`, the dock's
 * favourites).
 *
 * Everything here is pure but `readPenPrefs` / `writePenPrefs`.
 */

import { storageKey } from "../../../src/lib/brand";
import { readJson, writeJson } from "../../../src/lib/persist";
import type { TextMarkMode } from "./anchors";
import { MARK_COLORS, MARKER_FACTOR, PEN_STYLES, STAMP_SYMBOLS, type MarkColor, type PenStyle, type StampSymbol } from "./layer";

export { MARKER_FACTOR, PEN_STYLES, type PenStyle, type TextMarkMode };

export type PenTool = "ink" | "highlight" | "box" | "text" | "stamp" | "textmark" | "select" | "eraser";
export const PEN_TOOLS: readonly PenTool[] = ["ink", "highlight", "box", "text", "stamp", "textmark", "select", "eraser"];
/** The tools that draw in a colour, each remembering its own. */
export type ColorTool = Exclude<PenTool, "eraser" | "select">;

/** The dock's six slots: the proofreading tools share `proof`. */
export type DockTool = "ink" | "highlight" | "eraser" | "select" | "text" | "proof";
export const DOCK_TOOLS: readonly DockTool[] = ["ink", "highlight", "eraser", "select", "text", "proof"];
/** What the Proof slot arms: a box, struck / underlined / highlighted words,
 * or a stamp's symbol. */
export type ProofPick = "box" | TextMarkMode | StampSymbol;
export const PROOF_PICKS: readonly ProofPick[] = ["box", "strike", "underline", "highlight", "insert", "delete", "paragraph", "swap"];

/** The pen's own styles — the marker is the highlighter tool's. */
export const PEN_ONLY_STYLES: readonly PenStyle[] = ["pen", "dashed", "arrow"];

/** A size on the slider, 1 (finest) … 12; 3 is the old Normal. */
export type PenSize = number;
export const SIZE_MIN = 1;
export const SIZE_MAX = 12;
/** The size the base width (`strokeWidth`) is drawn at, unscaled. */
export const SIZE_BASE = 3;

/** Whole stroke takes every mark it touches; Partial rubs out the part of a
 * pen stroke under it; Area takes what a dragged rectangle covers. */
export type EraserMode = "stroke" | "partial" | "area";
export const ERASER_MODES: readonly EraserMode[] = ["stroke", "partial", "area"];
export const TEXT_MARK_MODES: readonly TextMarkMode[] = ["strike", "underline", "highlight"];
/** How a pen's pressure maps onto the stroke's width (`strokePressure`). */
export type PressureCurve = "light" | "normal" | "firm";
export const PRESSURE_CURVES: readonly PressureCurve[] = ["light", "normal", "firm"];
/** How eagerly the phone ignores a resting palm (`palmRejects`). */
export type PalmRejection = "off" | "normal" | "strict";
export const PALM_MODES: readonly PalmRejection[] = ["off", "normal", "strict"];
/** The lasso's shape: a freehand loop or a dragged rectangle. */
export type LassoMode = "free" | "rect";
export const LASSO_MODES: readonly LassoMode[] = ["free", "rect"];

/** A saved pen — a favourite in the dock: one tap (or Shift+1…5 on the
 * desktop) arms its tool in its colour, style and size (`applyPreset`). */
export type PenPreset = { tool: "ink" | "highlight" | "box" | "text" | "stamp" | "textmark"; color: MarkColor; style: PenStyle; size: PenSize };
const PRESET_TOOLS: readonly PenPreset["tool"][] = ["ink", "highlight", "box", "text", "stamp", "textmark"];
export const MAX_PRESETS = 5;
/** What Reset presets restores: a red pen, a blue pen, a fine black pen and a
 * yellow highlighter. No arrow — an arrowhead is only ever picked by hand. */
export const DEFAULT_PRESETS: PenPreset[] = [
  { tool: "ink", color: "red", style: "pen", size: 3 },
  { tool: "ink", color: "blue", style: "pen", size: 3 },
  { tool: "ink", color: "black", style: "pen", size: 2 },
  { tool: "highlight", color: "yellow", style: "pen", size: 3 },
];

export type PenPrefs = {
  tool: PenTool;
  colors: Record<ColorTool, MarkColor>;
  /** The pen's style (`PEN_ONLY_STYLES`). */
  style: PenStyle;
  size: PenSize;
  eraser: EraserMode;
  /** The eraser leaves everything but boxes and highlighter strokes alone. */
  eraseHighlights: boolean;
  /** A highlighter stroke becomes the straight line from its start to its end. */
  straight: boolean;
  /** The symbol the stamp tool places. */
  stamp: StampSymbol;
  /** What a drag of the text-mark tool makes. */
  textMark: TextMarkMode;
  /** What the Proof slot armed last. */
  proof: ProofPick;
  lasso: LassoMode;
  /** Whether a stroke held still at its end snaps to a line or an ellipse. */
  snap: boolean;
  pressure: PressureCurve;
  /** Phone only: the desktop has no touch to reject. */
  palm: PalmRejection;
  presets: PenPreset[];
};

export const DEFAULT_PEN_PREFS: PenPrefs = {
  tool: "ink",
  colors: { ink: "red", highlight: "yellow", box: "yellow", text: "black", stamp: "red", textmark: "yellow" },
  style: "pen",
  size: SIZE_BASE,
  eraser: "stroke",
  eraseHighlights: false,
  straight: true,
  stamp: "insert",
  textMark: "highlight",
  proof: "box",
  lasso: "free",
  snap: true,
  pressure: "normal",
  palm: "normal",
  presets: DEFAULT_PRESETS,
};

/** Ink's colours (the pen, notes, stamps, struck or underlined words), in
 * swatch and digit-key order. */
export const INK_COLORS: readonly MarkColor[] = ["red", "blue", "black", "green", "orange", "purple"];
/** A highlighter's colours (the highlighter, the box, highlighted words). */
export const HIGHLIGHT_COLORS: readonly MarkColor[] = ["yellow", "green", "pink", "blue"];

/** The colours a tool offers: the highlighter's where it highlights — the
 * highlighter, the box, a pen still on the old marker style, and the text
 * marks' highlight (`textMark`, the highlight when left out) — ink's
 * elsewhere. */
export function colorsFor(tool: PenTool, style: PenStyle, textMark: TextMarkMode = "highlight"): readonly MarkColor[] {
  if (tool === "highlight" || tool === "box" || (tool === "ink" && style === "marker") || (tool === "textmark" && textMark === "highlight")) return HIGHLIGHT_COLORS;
  return INK_COLORS;
}

/** The tool whose colour stands in while `tool` is armed: the pen's for the
 * eraser and the select tool, which draw nothing themselves. */
function colorTool(tool: PenTool): ColorTool {
  return tool === "eraser" || tool === "select" ? "ink" : tool;
}

/** The colour a tool draws in now: its remembered one where the tool (and the
 * pen's style, the text marks' mode) offers it, else the first it does. The
 * record keeps the remembered one, so the highlighter gets its yellow back. */
export function colorOf(prefs: PenPrefs, tool: PenTool = prefs.tool): MarkColor {
  const offered = colorsFor(tool, prefs.style, prefs.textMark);
  const wanted = prefs.colors[colorTool(tool)];
  return offered.includes(wanted) ? wanted : offered[0];
}

/** `prefs` with `color` remembered for the armed tool (the pen, while the
 * eraser or the select tool is armed). */
export function withColor(prefs: PenPrefs, color: MarkColor): PenPrefs {
  return { ...prefs, colors: { ...prefs.colors, [colorTool(prefs.tool)]: color } };
}

/** The style a new stroke of the armed tool takes: the highlighter draws the
 * marker, the pen its own style. */
export function inkStyle(prefs: Pick<PenPrefs, "tool" | "style">): PenStyle {
  return prefs.tool === "highlight" ? "marker" : prefs.style;
}

/** The dock slot the armed tool sits in. */
export function dockToolOf(tool: PenTool): DockTool {
  return tool === "box" || tool === "stamp" || tool === "textmark" ? "proof" : tool;
}

/** The proofreading mark the armed tool makes now, when it is one. */
export function proofOf(prefs: Pick<PenPrefs, "tool" | "textMark" | "stamp">): ProofPick | null {
  if (prefs.tool === "box") return "box";
  if (prefs.tool === "textmark") return prefs.textMark;
  if (prefs.tool === "stamp") return prefs.stamp;
  return null;
}

/** A proofreading mark armed from the Proof slot: its tool, with the text
 * marks' mode or the stamp's symbol, remembered as the slot's pick. */
export function armProof(prefs: PenPrefs, pick: ProofPick): PenPrefs {
  if (pick === "box") return { ...prefs, tool: "box", proof: pick };
  if ((TEXT_MARK_MODES as readonly string[]).includes(pick)) return { ...prefs, tool: "textmark", textMark: pick as TextMarkMode, proof: pick };
  return { ...prefs, tool: "stamp", stamp: pick as StampSymbol, proof: pick };
}

/** A dock slot pressed: arms its tool (Proof: what it armed last). The same
 * slot again is the caller's — it opens the slot's options. */
export function armDock(prefs: PenPrefs, slot: DockTool): PenPrefs {
  if (slot === "proof") return armProof(prefs, prefs.proof);
  return prefs.tool === slot ? prefs : { ...prefs, tool: slot };
}

/** A preset armed: its tool, and its colour remembered for that tool; its
 * style only for the pen (a box preset leaves the pen's style alone), its
 * size for every tool. A box, text-mark or stamp preset is the Proof slot's
 * pick from then on. */
export function applyPreset(prefs: PenPrefs, preset: PenPreset): PenPrefs {
  const proof = preset.tool === "box" ? "box" : preset.tool === "textmark" ? prefs.textMark : preset.tool === "stamp" ? prefs.stamp : prefs.proof;
  return {
    ...prefs,
    tool: preset.tool,
    colors: { ...prefs.colors, [preset.tool]: preset.color },
    style: preset.tool === "ink" ? preset.style : prefs.style,
    size: preset.size,
    proof,
  };
}

function samePreset(a: PenPreset, b: PenPreset): boolean {
  return a.tool === b.tool && a.color === b.color && (a.tool !== "ink" || a.style === b.style) && a.size === b.size;
}

/** The armed pen as a preset, or `null` for the eraser and the lasso. */
export function presetOf(prefs: PenPrefs): PenPreset | null {
  if (prefs.tool === "eraser" || prefs.tool === "select") return null;
  return { tool: prefs.tool, color: colorOf(prefs), style: prefs.tool === "ink" ? prefs.style : "pen", size: prefs.size };
}

/** Whether `preset` is what is armed now. */
export function isArmed(prefs: PenPrefs, preset: PenPreset): boolean {
  const now = presetOf(prefs);
  return !!now && samePreset(now, preset);
}

/** The armed pen saved as a preset: appended — an equal one moves to the end
 * instead of standing twice — and the oldest dropped past `MAX_PRESETS`. The
 * eraser and the select tool are no pen: `prefs` as it is. */
export function savePreset(prefs: PenPrefs): PenPrefs {
  const preset = presetOf(prefs);
  if (!preset) return prefs;
  return { ...prefs, presets: [...prefs.presets.filter((kept) => !samePreset(kept, preset)), preset].slice(-MAX_PRESETS) };
}

/** Preset `i` taken out of the favourites. */
export function removePreset(prefs: PenPrefs, i: number): PenPrefs {
  if (!prefs.presets[i]) return prefs;
  return { ...prefs, presets: prefs.presets.filter((_, at) => at !== i) };
}

/** Reset presets: the defaults back. */
export function resetPresets(prefs: PenPrefs): PenPrefs {
  return { ...prefs, presets: DEFAULT_PRESETS };
}

/** A size within the slider's range, whole. */
export function clampSize(size: number): PenSize {
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(Number.isFinite(size) ? size : SIZE_BASE)));
}

/** A new stroke's base width on a page `pageWidth` units wide: the pen's
 * default (`pageWidth / 350`, about 1.7 pt on A4) at `size / SIZE_BASE`, five
 * times that for the highlighter (the marker), within the backend's 0.1–100. */
export function strokeWidth(pageWidth: number, prefs: { size: PenSize; style: PenStyle; tool?: PenTool }): number {
  const marker = prefs.style === "marker" || prefs.tool === "highlight";
  const base = (pageWidth / 350) * (clampSize(prefs.size) / SIZE_BASE) * (marker ? MARKER_FACTOR : 1);
  return Math.round(Math.min(100, Math.max(0.1, base)) * 10) / 10;
}

/** Each pressure curve's exponent on a pen's reading: light presses draw
 * wider under `light`, narrower under `firm`. */
export const PRESSURE_EXPONENT: Record<PressureCurve, number> = { light: 0.6, normal: 1, firm: 1.6 };

/** Only the pen follows a stylus's pressure: the other styles draw evenly, so
 * their samples are stored at the even `0.5`. `curve` bends a real pen's
 * reading — pass it only for a stylus: a finger or a mouse reports the even
 * `0.5`, which must stay the base width (leave `curve` out for them). */
export function strokePressure(style: PenStyle, pressure: number, curve: PressureCurve = "normal"): number {
  if (style !== "pen") return 0.5;
  const p = Math.min(1, Math.max(0, pressure));
  return curve === "normal" ? p : Math.round(p ** PRESSURE_EXPONENT[curve] * 1000) / 1000;
}

/** How long a stroke's end must be held still, and how far it may wander
 * meanwhile in CSS px, before it snaps (`layer.ts` `snapStroke`). */
export const SNAP_HOLD_MS = 500;
export const SNAP_SLOP_PX = 3;

/** The widest touch, in CSS px, each palm mode still takes for a finger; and
 * how long `strict` ignores every touch after the pen lifts. */
export const PALM_MAX_TOUCH: Record<Exclude<PalmRejection, "off">, number> = { normal: 30, strict: 18 };
export const PALM_AFTER_PEN_MS = 600;

/** Whether a touch is a resting palm to ignore: wider than its mode takes
 * (`PALM_MAX_TOUCH`), or — `strict` — any touch within `PALM_AFTER_PEN_MS`
 * of the pen lifting. Only touches are asked about; pens and mice never. */
export function palmRejects(palm: PalmRejection, touch: { width: number; height: number }, msSincePenUp: number): boolean {
  if (palm === "off") return false;
  if (Math.max(touch.width, touch.height) > PALM_MAX_TOUCH[palm]) return true;
  return palm === "strict" && msSincePenUp >= 0 && msSincePenUp < PALM_AFTER_PEN_MS;
}

/** The eraser's reach, given the view's own default in CSS px: one reach for
 * every mode (the area mode drags a rectangle instead). */
export function eraserPx(base: number, _mode?: EraserMode): number {
  return base;
}

/** One step finer (`-1`) or bolder (`+1`) on the size slider. The eraser
 * has no size: `prefs` as it is. */
export function stepSize(prefs: PenPrefs, delta: -1 | 1): PenPrefs {
  if (prefs.tool === "eraser") return prefs;
  const size = clampSize(prefs.size + delta);
  return size === prefs.size ? prefs : { ...prefs, size };
}

/** The pen's next style after `style`, round (`PEN_ONLY_STYLES`). */
export function nextStyle(style: PenStyle): PenStyle {
  const at = PEN_ONLY_STYLES.indexOf(style);
  return PEN_ONLY_STYLES[(at + 1) % PEN_ONLY_STYLES.length];
}

/** The record's shape: version 2 holds slider sizes (1–12); a record without
 * it holds the old three sizes (0 fine, 1 normal, 2 bold). */
const PREFS_VERSION = 2;
const OLD_SIZES: Record<number, PenSize> = { 0: 2, 1: SIZE_BASE, 2: 6 };

/** Parses a stored record, field by field: whatever is unreadable falls back
 * to the default, so a record from another build never locks a choice. */
export function parsePenPrefs(raw: unknown): PenPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_PEN_PREFS;
  const r = raw as Record<string, unknown>;
  const pick = <T>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback);
  const colors = (r.colors && typeof r.colors === "object" ? r.colors : {}) as Record<string, unknown>;
  const defaults = DEFAULT_PEN_PREFS;
  const current = r.v === PREFS_VERSION;
  const sizeOf = (value: unknown): PenSize => {
    if (typeof value !== "number" || !Number.isFinite(value)) return defaults.size;
    return current ? clampSize(value) : OLD_SIZES[value] ?? defaults.size;
  };
  // Absent (a record from before presets) or unreadable is the defaults; a
  // list keeps its readable entries. A marker preset is the highlighter's.
  const presets = Array.isArray(r.presets)
    ? r.presets.flatMap((entry: unknown): PenPreset[] => {
      if (!entry || typeof entry !== "object") return [];
      const e = entry as Record<string, unknown>;
      if (!PRESET_TOOLS.includes(e.tool as PenPreset["tool"]) || !MARK_COLORS.includes(e.color as MarkColor)) return [];
      const marker = e.tool === "ink" && e.style === "marker";
      return [{
        tool: marker ? "highlight" : (e.tool as PenPreset["tool"]),
        color: e.color as MarkColor,
        style: marker ? "pen" : pick(e.style, PEN_ONLY_STYLES, "pen"),
        size: sizeOf(e.size),
      }];
    }).slice(-MAX_PRESETS)
    : defaults.presets;
  // A pen left on the marker is the highlighter now.
  const markerPen = r.tool === "ink" && r.style === "marker";
  const textMark = pick(r.textMark, TEXT_MARK_MODES, defaults.textMark);
  const stamp = pick(r.stamp, STAMP_SYMBOLS, defaults.stamp);
  return {
    tool: markerPen ? "highlight" : pick(r.tool, PEN_TOOLS, defaults.tool),
    colors: {
      ink: pick(colors.ink, MARK_COLORS, defaults.colors.ink),
      // Before the highlighter was a tool, the marker wore the pen's colour.
      highlight: pick(colors.highlight, MARK_COLORS, defaults.colors.highlight),
      box: pick(colors.box, MARK_COLORS, defaults.colors.box),
      text: pick(colors.text, MARK_COLORS, defaults.colors.text),
      stamp: pick(colors.stamp, MARK_COLORS, defaults.colors.stamp),
      textmark: pick(colors.textmark, MARK_COLORS, defaults.colors.textmark),
    },
    // The arrow lasts for the visit it was picked in: a new one starts on
    // the plain pen again.
    style: r.style === "arrow" ? defaults.style : pick(r.style, PEN_ONLY_STYLES, defaults.style),
    size: sizeOf(r.size),
    // The old reaches (small, medium, large) rubbed: Partial.
    eraser: r.eraser === "small" || r.eraser === "medium" || r.eraser === "large" ? "partial" : pick(r.eraser, ERASER_MODES, defaults.eraser),
    eraseHighlights: typeof r.eraseHighlights === "boolean" ? r.eraseHighlights : defaults.eraseHighlights,
    straight: typeof r.straight === "boolean" ? r.straight : defaults.straight,
    stamp,
    textMark,
    proof: pick(r.proof, PROOF_PICKS, defaults.proof),
    lasso: pick(r.lasso, LASSO_MODES, defaults.lasso),
    snap: typeof r.snap === "boolean" ? r.snap : defaults.snap,
    pressure: pick(r.pressure, PRESSURE_CURVES, defaults.pressure),
    palm: pick(r.palm, PALM_MODES, defaults.palm),
    presets,
  };
}

const PEN_PREFS_KEY = storageKey("markup.pen");

type PrefStorage = Pick<Storage, "getItem" | "setItem">;

export function readPenPrefs(storage?: PrefStorage): PenPrefs {
  return readJson(PEN_PREFS_KEY, parsePenPrefs, DEFAULT_PEN_PREFS, storage);
}

/** A convenience only: the choices hold for this view. */
export function writePenPrefs(prefs: PenPrefs, storage?: PrefStorage): void {
  writeJson(PEN_PREFS_KEY, { ...prefs, v: PREFS_VERSION }, storage);
}

/** A cursor that shows what the next stroke draws — a dot of the pen's colour
 * at its width, or the eraser's ring at its reach — as a CSS `cursor` value,
 * hot spot at its centre. `diameter` is CSS px; the image stays within the
 * 128 px browsers take. */
export function penCursor(kind: "dot" | "ring", diameter: number, color: string): string {
  const d = Math.max(3, Math.min(120, diameter));
  const size = Math.ceil(d + 4);
  const c = size / 2;
  const r = d / 2;
  const shape = kind === "dot"
    ? `<circle cx="${c}" cy="${c}" r="${r}" fill="${color}" stroke="white" stroke-width="1"/>`
    : `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="white" stroke-width="2.5"/><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#333" stroke-width="1"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${shape}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.round(c)} ${Math.round(c)}, crosshair`;
}
