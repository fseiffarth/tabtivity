// Build-time theming of the phone's stylesheet (`vite.mobile.config.ts`).
//
// `style.css` is written in one palette — the dark one the PWA has always had —
// with ~300 literal colours. Rewriting each by hand into a token for every
// desktop theme would be a second stylesheet to keep in step with the first.
// Instead every literal is fitted once, at build time, as "hue H at p% over the
// tone q" (in oklab, where mixing is linear), and replaced by a `color-mix` of
// the theme's own anchors (`themes.css`): its tone curve `--m-n0…--m-n4`
// (deepest surface to brightest ink, each stop carrying the theme's tint) and
// its hues (`--m-accent`, `--m-red`, …). A light theme runs the tone curve the
// other way, so a dark card becomes a light one and pale text dark, and a
// theme's accent recolours everything that was violet.
//
// Authors keep writing plain hex. A rule that must keep its literal colours
// says so with a `/* theme: fixed */` comment inside it. The xterm host is
// themed like the rest: xterm itself paints the desktop's terminal palette
// for the same theme (`theme.phoneTerminalTheme`).

import type { AtRule, Declaration, Plugin, Rule } from "postcss";

type Oklab = readonly [number, number, number];

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function oklab(r: number, g: number, b: number): Oklab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function hex(value: string): Oklab {
  const v = value.replace("#", "");
  return oklab(parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16));
}

/** Where on q each tone stop `--m-n0…--m-n4` sits. Not evenly spaced: the
 * authored palette packs page, card and border into q 0.1–0.3, and a light
 * theme has to pull exactly that band apart. */
export const TONE_STOPS = [0, 0.16, 0.4, 0.7, 1] as const;

/** The hues a colour can be fitted to, as the authored palette spells them —
 * the anchors each theme in `themes.css` sets from the desktop's own tokens. */
export const REFERENCE_HUES = {
  accent: "#7c6cff",
  red: "#ff5c75",
  yellow: "#ffcf5c",
  green: "#4fd18b",
  blue: "#6fa0ff",
} as const;

export type Hue = keyof typeof REFERENCE_HUES;
const HUES = Object.entries(REFERENCE_HUES).map(([name, value]) => [name as Hue, hex(value)] as const);

/** The authored greys are all a little blue (`#171a24`, `#383c4d`, `#9498aa`).
 * That blue is the palette's tint, not a hue anyone chose, so a grey is read
 * as its lightness alone and each theme's tone stops supply their own tint
 * (navy, lavender, none). A dark red wash (`#3b2027`) is as faint but points
 * elsewhere, and stays red. */
const GREY_CHROMA = 0.04;
const GREY_ANGLE = 270;
const GREY_ANGLE_SPREAD = 40;
/** An anchor fit worse than this is not that anchor: the colour keeps its own
 * hue instead (a syntax-highlighting green, a pill's rose). */
const ANCHOR_TOLERANCE = 0.015;
/** The source of a colour's own hue: its hue angle at its own lightness
 * (kept off the extremes, so the tone still carries a light theme's flip) and
 * at least this chroma, so the mix has room to reach the authored colour. */
const OWN_L_MIN = 0.4;
const OWN_L_MAX = 0.8;
const OWN_C = 0.2;

export interface ColorFit {
  /** The anchor mixed in, `own` for the colour's own hue, or `null` for a pure tone. */
  hue: Hue | "own" | null;
  /** How much of the hue, 0–1. */
  p: number;
  /** Where on the tone curve the rest sits, 0 (deepest) – 1 (brightest). */
  q: number;
  /** The own hue's source as oklch lightness, chroma and angle (`own` only). */
  own?: { l: number; c: number; h: number };
  /** The fit's distance from the authored colour, in oklab units (a grey's
   * dropped tint counts). */
  error: number;
}

/** `C ≈ p·H + (1−p)·q·white` in oklab — the fit is made against a plain
 * black-to-white tone, the curve every theme's stops stand in for: a grid over
 * p with q solved in closed form. */
function fitTo(c: Oklab, h: Oklab): { p: number; q: number; error: number } {
  let best = { p: 0, q: 0, error: Infinity };
  for (let step = 0; step <= 400; step += 1) {
    const p = step / 400;
    const rl = c[0] - p * h[0];
    const q = p >= 1 ? 0 : Math.min(1, Math.max(0, rl / (1 - p)));
    const error = Math.hypot(rl - (1 - p) * q, c[1] - p * h[1], c[2] - p * h[2]);
    if (error < best.error - 1e-9) best = { p, q, error };
  }
  return best;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function fitColor(r: number, g: number, b: number): ColorFit {
  const c = oklab(r, g, b);
  const chroma = Math.hypot(c[1], c[2]);
  const degrees = (((Math.atan2(c[2], c[1]) * 180) / Math.PI) + 360) % 360;
  const offGrey = Math.abs(((degrees - GREY_ANGLE + 540) % 360) - 180);
  if (chroma < 0.002 || (chroma < GREY_CHROMA && offGrey <= GREY_ANGLE_SPREAD)) {
    const q = clamp01(c[0]);
    return { hue: null, p: 0, q, error: Math.hypot(c[0] - q, chroma) };
  }
  const fits = HUES.map(([name, h]) => ({ hue: name, ...fitTo(c, h) }));
  const best = fits.reduce((a, b) => (b.error < a.error ? b : a));
  if (best.error <= ANCHOR_TOLERANCE) return best;
  const l = Math.round(Math.min(OWN_L_MAX, Math.max(OWN_L_MIN, c[0])) * 1000) / 1000;
  const sourceChroma = Math.round(Math.max(OWN_C, chroma) * 1000) / 1000;
  const h = Math.round(degrees * 10) / 10;
  const rad = (h * Math.PI) / 180;
  const source: Oklab = [l, sourceChroma * Math.cos(rad), sourceChroma * Math.sin(rad)];
  return { hue: "own", own: { l, c: sourceChroma, h }, ...fitTo(c, source) };
}

const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;

/** The tone at q as a mix of the two curve stops around it. */
function toneExpr(q: number): string {
  let lower = 0;
  while (lower < TONE_STOPS.length - 2 && q > TONE_STOPS[lower + 1]) lower += 1;
  const t = clamp01((q - TONE_STOPS[lower]) / (TONE_STOPS[lower + 1] - TONE_STOPS[lower]));
  if (t < 0.0005) return `var(--m-n${lower})`;
  if (t > 0.9995) return `var(--m-n${lower + 1})`;
  return `color-mix(in oklab, var(--m-n${lower + 1}) ${pct(t)}, var(--m-n${lower}))`;
}

export function fitExpr(fit: ColorFit): string {
  const tone = toneExpr(fit.q);
  if (!fit.hue || fit.p < 0.0005) return tone;
  const hue = fit.hue === "own" && fit.own ? `oklch(${Math.round(fit.own.l * 1000) / 10}% ${fit.own.c} ${fit.own.h})` : `var(--m-${fit.hue})`;
  if (fit.p > 0.9995) return hue;
  return `color-mix(in oklab, ${hue} ${pct(fit.p)}, ${tone})`;
}

const COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|rgba?\(\s*[\d.]+%?\s*[, ]\s*[\d.]+%?\s*[, ]\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)/g;

interface Rgba { r: number; g: number; b: number; a: number }

export function parseColor(literal: string): Rgba | null {
  if (literal.startsWith("#")) {
    let v = literal.slice(1);
    if (v.length <= 4) v = [...v].map((ch) => ch + ch).join("");
    const n = (i: number) => parseInt(v.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: v.length === 8 ? n(6) / 255 : 1 };
  }
  const parts = literal.slice(literal.indexOf("(") + 1, -1).split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (s: string) => (s.endsWith("%") ? (parseFloat(s) * 255) / 100 : parseFloat(s));
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha };
}

const key = ({ r, g, b }: Rgba) => [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** Splits a value at its `url(…)`s, so a colour inside an inline SVG (a select's
 * chevron) is left alone — it is markup, not a declaration colour. */
function mapOutsideUrls(value: string, map: (chunk: string) => string): string {
  return value.split(/(url\((?:"[^"]*"|'[^']*'|[^)]*)\))/).map((chunk, i) => (i % 2 ? chunk : map(chunk))).join("");
}

function isFixedRule(rule: Rule): boolean {
  return rule.nodes.some((node) => node.type === "comment" && /^\s*theme:\s*fixed\s*$/.test(node.text));
}

const BACKGROUND_PROPS = new Set(["background", "background-color"]);

/** A literal that is not a palette colour in any theme:
 * - a black shade (`rgba(0,0,0,.4)`) — shadows and scrims darken in every theme;
 * - a white background — the paper of a page or picture, never a dark-theme
 *   surface (those are all far darker), and white in every theme. */
function staysLiteral(color: Rgba, prop: string): boolean {
  if (color.r === 0 && color.g === 0 && color.b === 0 && color.a < 1) return true;
  return BACKGROUND_PROPS.has(prop) && color.r === 255 && color.g === 255 && color.b === 255 && color.a === 1;
}

/** The PostCSS plugin. Every colour literal becomes `var(--mc-<rrggbb>)` (with
 * its alpha kept by a mix toward transparent), and one `:root` block defines
 * each `--mc-*` from the fit, so a page names each colour's formula once. The
 * anchors themselves (`--m-*`) are never rewritten. */
export function themeColors(options: { include?: (file: string) => boolean } = {}): Plugin {
  return {
    postcssPlugin: "app-mobile-theme-colors",
    prepare(result) {
      // A vendor sheet (xterm's) styles what it draws in its own palette.
      const file = result.opts.from ?? "";
      if (options.include && !options.include(file)) return {};
      const used = new Map<string, Rgba>();
      const rewrite = (decl: Declaration) => {
        if (decl.prop.startsWith("--m-")) return;
        const rule = decl.parent;
        if (rule?.type === "rule" && isFixedRule(rule as Rule)) return;
        const prop = decl.prop.toLowerCase();
        const next = mapOutsideUrls(decl.value, (chunk) => chunk.replace(COLOR_RE, (literal) => {
          const color = parseColor(literal);
          if (!color || staysLiteral(color, prop)) return literal;
          const name = key(color);
          used.set(name, color);
          return color.a >= 1 ? `var(--mc-${name})` : `color-mix(in oklab, var(--mc-${name}) ${pct(color.a)}, transparent)`;
        }));
        if (next !== decl.value) decl.value = next;
      };
      return {
        Declaration: rewrite,
        RuleExit(rule: Rule) {
          addOnAccent(rule);
        },
        OnceExit(root, { Rule: RuleNode }) {
          if (used.size === 0) return;
          const defs = new RuleNode({ selector: ":root" });
          for (const [name, color] of [...used].sort(([a], [b]) => a.localeCompare(b))) {
            defs.append({ prop: `--mc-${name}`, value: fitExpr(fitColor(color.r, color.g, color.b)) });
          }
          // After every `@import`/`@charset`, which must lead the sheet.
          const leads = root.nodes.filter((node): node is AtRule => node.type === "atrule" && /^(charset|import)$/i.test(node.name));
          const lead = leads[leads.length - 1];
          if (lead) lead.after(defs);
          else root.prepend(defs);
        },
      };
    },
  };
}
themeColors.postcss = true as const;

/** Text on an accent-filled control. In the authored palette that is white on
 * violet, but Plain Dark's accent IS white — so a rule whose background is
 * mostly accent paints its text with the theme's `--m-on-accent` (the desktop's
 * filled-accent rule: the page colour), replacing a pale tone or adding one
 * where the text only inherited. */
function addOnAccent(rule: Rule) {
  const bg = rule.nodes.find((node): node is Declaration => node.type === "decl" && BACKGROUND_PROPS.has(node.prop.toLowerCase()));
  if (!bg) return;
  const ref = /var\(--mc-([0-9a-f]{6})\)/.exec(bg.value);
  // Only a background that IS one colour: a gradient's first stop says little.
  if (!ref || /gradient/.test(bg.value) || bg.value.trim() !== ref[0]) return;
  const color = parseColor(`#${ref[1]}`);
  if (!color) return;
  const fit = fitColor(color.r, color.g, color.b);
  if (fit.hue !== "accent" || fit.p < 0.6) return;
  const text = rule.nodes.find((node): node is Declaration => node.type === "decl" && node.prop.toLowerCase() === "color");
  if (!text) {
    bg.after({ prop: "color", value: "var(--m-on-accent)" });
    return;
  }
  const own = /^var\(--mc-([0-9a-f]{6})\)$/.exec(text.value.trim());
  const ownColor = own && parseColor(`#${own[1]}`);
  if (!ownColor) return;
  const textFit = fitColor(ownColor.r, ownColor.g, ownColor.b);
  if (textFit.q > 0.6 && (textFit.hue === null || textFit.p < 0.3)) text.value = "var(--m-on-accent)";
}
