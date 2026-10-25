/**
 * The pen bar's choices, shared by the phone's `MarkupView` and the desktop's
 * `usePdfMarkup`: the armed tool, a colour per tool, the pen's style and size,
 * and the eraser's reach — or its area mode, a dragged rectangle. Kept per
 * viewer (`localStorage`), a convenience only: an unreadable or missing record
 * is the defaults.
 *
 * The colours are plain colours: the prompt names a mark's colour so the
 * agent finds it on the page picture, never what it should mean. Yellow is a
 * highlighter's colour only — a box or the marker — since yellow ink or text
 * is unreadable on white.
 *
 * Beside the tools: the stamp's symbol, the text-mark mode, shape snapping,
 * the stylus's pressure curve, palm rejection (phone) and up to four saved
 * pens (`presets`).
 *
 * Everything here is pure but `readPenPrefs` / `writePenPrefs`.
 */

import { storageKey } from "../../../src/lib/brand";
import { readJson, writeJson } from "../../../src/lib/persist";
import type { TextMarkMode } from "./anchors";
import { MARK_COLORS, MARKER_FACTOR, PEN_STYLES, STAMP_SYMBOLS, type MarkColor, type PenStyle, type StampSymbol } from "./layer";

export { MARKER_FACTOR, PEN_STYLES, type PenStyle, type TextMarkMode };

export type PenTool = "ink" | "box" | "text" | "stamp" | "textmark" | "select" | "eraser";
export const PEN_TOOLS: readonly PenTool[] = ["ink", "box", "text", "stamp", "textmark", "select", "eraser"];
/** The tools that draw in a colour, each remembering its own. */
export type ColorTool = Exclude<PenTool, "eraser" | "select">;
/** Fine, normal, bold — a factor on the page's base width (`PEN_SIZE_FACTOR`). */
export type PenSize = 0 | 1 | 2;
export const PEN_SIZES: readonly PenSize[] = [0, 1, 2];
export type EraserMode = "small" | "medium" | "large" | "area";
export const ERASER_MODES: readonly EraserMode[] = ["small", "medium", "large", "area"];
export const TEXT_MARK_MODES: readonly TextMarkMode[] = ["strike", "underline", "highlight"];
/** How a pen's pressure maps onto the stroke's width (`strokePressure`). */
export type PressureCurve = "light" | "normal" | "firm";
export const PRESSURE_CURVES: readonly PressureCurve[] = ["light", "normal", "firm"];
/** How eagerly the phone ignores a resting palm (`palmRejects`). */
export type PalmRejection = "off" | "normal" | "strict";
export const PALM_MODES: readonly PalmRejection[] = ["off", "normal", "strict"];

/** A saved pen: one tap (or Shift+1…4 on the desktop) arms its tool in its
 * colour, style and size (`applyPreset`). */
export type PenPreset = { tool: "ink" | "box" | "text" | "stamp" | "textmark"; color: MarkColor; style: PenStyle; size: PenSize };
const PRESET_TOOLS: readonly PenPreset["tool"][] = ["ink", "box", "text", "stamp", "textmark"];
export const MAX_PRESETS = 4;
/** What Reset presets restores: a red pen, a yellow marker, a blue pen and
 * a fine black pen. No arrow — an arrowhead is only ever picked by hand. */
export const DEFAULT_PRESETS: PenPreset[] = [
  { tool: "ink", color: "red", style: "pen", size: 1 },
  { tool: "ink", color: "yellow", style: "marker", size: 1 },
  { tool: "ink", color: "blue", style: "pen", size: 1 },
  { tool: "ink", color: "black", style: "pen", size: 0 },
];
/** The defaults before the arrow left them: a stored list still equal to it
 * was never the user's choice and reads as today's defaults. */
const OLD_DEFAULT_PRESETS: PenPreset[] = DEFAULT_PRESETS.map((preset, i) => (i === 2 ? { ...preset, style: "arrow" } : preset));

export type PenPrefs = {
  tool: PenTool;
  colors: Record<ColorTool, MarkColor>;
  style: PenStyle;
  size: PenSize;
  eraser: EraserMode;
  /** The symbol the stamp tool places. */
  stamp: StampSymbol;
  /** What a drag of the text-mark tool makes. */
  textMark: TextMarkMode;
  /** Whether a stroke held still at its end snaps to a line or an ellipse. */
  snap: boolean;
  pressure: PressureCurve;
  /** Phone only: the desktop has no touch to reject. */
  palm: PalmRejection;
  presets: PenPreset[];
};

export const DEFAULT_PEN_PREFS: PenPrefs = {
  tool: "ink",
  colors: { ink: "red", box: "yellow", text: "black", stamp: "red", textmark: "yellow" },
  style: "pen",
  size: 1,
  eraser: "medium",
  stamp: "insert",
  textMark: "highlight",
  snap: true,
  pressure: "normal",
  palm: "normal",
  presets: DEFAULT_PRESETS,
};

const INK_COLORS: readonly MarkColor[] = ["red", "blue", "black"];

/** The colours a tool offers: yellow only where it highlights — the box,
 * the marker and the text marks' highlight (`textMark`, the highlight when
 * left out). A selection offers what its marks may wear (`layer.ts`
 * `restyleMarks` keeps yellow to those alike). */
export function colorsFor(tool: PenTool, style: PenStyle, textMark: TextMarkMode = "highlight"): readonly MarkColor[] {
  if (tool === "box" || (tool === "ink" && style === "marker") || (tool === "textmark" && textMark === "highlight")) return MARK_COLORS;
  return INK_COLORS;
}

/** The tool whose colour stands in while `tool` is armed: the pen's for the
 * eraser and the select tool, which draw nothing themselves. */
function colorTool(tool: PenTool): ColorTool {
  return tool === "eraser" || tool === "select" ? "ink" : tool;
}

/** The colour a tool draws in now: its remembered one where the tool (and the
 * pen's style, the text marks' mode) offers it, else the first it does. The
 * record keeps the remembered one, so the marker gets its yellow back. */
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

/** A preset armed: its tool, and its colour remembered for that tool; its
 * style only for the pen (a box preset leaves the pen's style alone), its
 * size for every tool. */
export function applyPreset(prefs: PenPrefs, preset: PenPreset): PenPrefs {
  return {
    ...prefs,
    tool: preset.tool,
    colors: { ...prefs.colors, [preset.tool]: preset.color },
    style: preset.tool === "ink" ? preset.style : prefs.style,
    size: preset.size,
  };
}

function samePreset(a: PenPreset, b: PenPreset): boolean {
  return a.tool === b.tool && a.color === b.color && a.style === b.style && a.size === b.size;
}

/** The armed pen saved as a preset: appended — an equal one moves to the end
 * instead of standing twice — and the oldest dropped past `MAX_PRESETS`. The
 * eraser and the select tool are no pen: `prefs` as it is. */
export function savePreset(prefs: PenPrefs): PenPrefs {
  if (prefs.tool === "eraser" || prefs.tool === "select") return prefs;
  const preset: PenPreset = { tool: prefs.tool, color: colorOf(prefs), style: prefs.style, size: prefs.size };
  return { ...prefs, presets: [...prefs.presets.filter((kept) => !samePreset(kept, preset)), preset].slice(-MAX_PRESETS) };
}

/** Reset presets: the defaults back. */
export function resetPresets(prefs: PenPrefs): PenPrefs {
  return { ...prefs, presets: DEFAULT_PRESETS };
}

/** A pen size's factor on the page's base width. */
export const PEN_SIZE_FACTOR: Record<PenSize, number> = { 0: 0.55, 1: 1, 2: 1.9 };

/** A new stroke's base width on a page `pageWidth` units wide: the pen's
 * default (`pageWidth / 350`, about 1.7 pt on A4) at the chosen size, five
 * times that for the marker, within the backend's 0.1–100. */
export function strokeWidth(pageWidth: number, prefs: Pick<PenPrefs, "size" | "style">): number {
  const base = (pageWidth / 350) * PEN_SIZE_FACTOR[prefs.size] * (prefs.style === "marker" ? MARKER_FACTOR : 1);
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

/** The eraser's reach for a mode, given the view's own default in CSS px. */
export function eraserPx(base: number, mode: EraserMode): number {
  return base * (mode === "small" ? 0.5 : mode === "large" ? 2.2 : 1);
}

/** One step finer (`-1`) or bolder (`+1`): the pen's size, or the eraser's
 * reach while it is armed (its area mode stays put). */
export function stepSize(prefs: PenPrefs, delta: -1 | 1): PenPrefs {
  if (prefs.tool === "eraser") {
    const reaches: EraserMode[] = ["small", "medium", "large"];
    const at = reaches.indexOf(prefs.eraser);
    if (at < 0) return prefs;
    return { ...prefs, eraser: reaches[Math.min(2, Math.max(0, at + delta))] };
  }
  return { ...prefs, size: Math.min(2, Math.max(0, prefs.size + delta)) as PenSize };
}

/** The next pen style after `style`, round. */
export function nextStyle(style: PenStyle): PenStyle {
  return PEN_STYLES[(PEN_STYLES.indexOf(style) + 1) % PEN_STYLES.length];
}

/** Parses a stored record, field by field: whatever is unreadable falls back
 * to the default, so a record from another build never locks a choice. */
export function parsePenPrefs(raw: unknown): PenPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_PEN_PREFS;
  const r = raw as Record<string, unknown>;
  const pick = <T>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback);
  const colors = (r.colors && typeof r.colors === "object" ? r.colors : {}) as Record<string, unknown>;
  const defaults = DEFAULT_PEN_PREFS;
  // Absent (a record from before presets) or unreadable is the defaults; a
  // list keeps its readable entries.
  const presets = Array.isArray(r.presets)
    ? r.presets.flatMap((entry: unknown): PenPreset[] => {
      if (!entry || typeof entry !== "object") return [];
      const e = entry as Record<string, unknown>;
      if (!PRESET_TOOLS.includes(e.tool as PenPreset["tool"]) || !MARK_COLORS.includes(e.color as MarkColor)) return [];
      return [{ tool: e.tool as PenPreset["tool"], color: e.color as MarkColor, style: pick(e.style, PEN_STYLES, "pen"), size: pick(e.size, PEN_SIZES, 1) }];
    }).slice(-MAX_PRESETS)
    : defaults.presets;
  const oldDefaults = presets.length === OLD_DEFAULT_PRESETS.length && presets.every((preset, i) => samePreset(preset, OLD_DEFAULT_PRESETS[i]));
  return {
    tool: pick(r.tool, PEN_TOOLS, defaults.tool),
    colors: {
      ink: pick(colors.ink, MARK_COLORS, defaults.colors.ink),
      box: pick(colors.box, MARK_COLORS, defaults.colors.box),
      text: pick(colors.text, MARK_COLORS, defaults.colors.text),
      stamp: pick(colors.stamp, MARK_COLORS, defaults.colors.stamp),
      textmark: pick(colors.textmark, MARK_COLORS, defaults.colors.textmark),
    },
    // The arrow lasts for the visit it was picked in: a new one starts on
    // the plain pen again.
    style: r.style === "arrow" ? defaults.style : pick(r.style, PEN_STYLES, defaults.style),
    size: pick(r.size, PEN_SIZES, defaults.size),
    eraser: pick(r.eraser, ERASER_MODES, defaults.eraser),
    stamp: pick(r.stamp, STAMP_SYMBOLS, defaults.stamp),
    textMark: pick(r.textMark, TEXT_MARK_MODES, defaults.textMark),
    snap: typeof r.snap === "boolean" ? r.snap : defaults.snap,
    pressure: pick(r.pressure, PRESSURE_CURVES, defaults.pressure),
    palm: pick(r.palm, PALM_MODES, defaults.palm),
    presets: oldDefaults ? defaults.presets : presets,
  };
}

const PEN_PREFS_KEY = storageKey("markup.pen");

type PrefStorage = Pick<Storage, "getItem" | "setItem">;

export function readPenPrefs(storage?: PrefStorage): PenPrefs {
  return readJson(PEN_PREFS_KEY, parsePenPrefs, DEFAULT_PEN_PREFS, storage);
}

/** A convenience only: the choices hold for this view. */
export function writePenPrefs(prefs: PenPrefs, storage?: PrefStorage): void {
  writeJson(PEN_PREFS_KEY, prefs, storage);
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
