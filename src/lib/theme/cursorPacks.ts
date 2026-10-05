/**
 * Custom mouse-cursor packs — the app's own pointer art, drawn at runtime and
 * handed to CSS as `cursor: url(…)` images.
 *
 * Three things drove the design:
 *
 *  - **The art is PNG, not SVG.** WebKit has never supported SVG images as CSS
 *    cursors (a `cursor: url(x.svg)` silently falls through to the keyword),
 *    and Tabtivity's window IS WebKitGTK on Linux. So every shape is rasterised
 *    into a `<canvas>` and emitted as a `data:image/png` URL, which every
 *    engine and every platform accepts.
 *  - **The art is drawn, not shipped.** Because it is painted at runtime it can
 *    read the LIVE theme — the cursor takes the active `--accent` and text/
 *    surface tones, so it recolors with the theme, the custom accent and the
 *    Theme Customizer's per-token overrides instead of being a fixed asset that
 *    clashes with five of the seven themes. It also keeps ~40 KB of base64 out
 *    of the stylesheet.
 *  - **A cursor image is 32×32 CSS px, full stop.** `cursor: url()` sizes the
 *    image by its intrinsic pixels, so a bigger PNG is a bigger cursor, not a
 *    sharper one — there is no DPR trick to play here. Everything is authored
 *    in a 32-unit box and rasterised on a grid of `PackStyle.grid` pixels; the
 *    pixel pack draws on a 16-pixel grid and is scaled up with smoothing off,
 *    which is exactly what makes it chunky.
 *
 * Consumers: `stores/settings.applyCursor` writes the returned map onto the
 * root element as custom properties, and `styles/cursors.css` documents how the
 * app's rules read them (`cursor: var(--cur-pointer, pointer)` — with the
 * keyword as the fallback, so an inactive pack costs nothing and a failed
 * render degrades to the system cursor rather than to *no* cursor).
 */

/** The packs offered in Settings → Theme. `null`/unset means "system cursors",
 *  which is not a pack — it is the absence of one. */
export type CursorPack = "aurora" | "pixel" | "ink";

export const CURSOR_PACKS: readonly CursorPack[] = ["aurora", "pixel", "ink"];

const PACK_IDS = new Set<string>(CURSOR_PACKS);

/** Coerce an arbitrary string (settings value, hand-edited JSON, a preset) to a
 *  known pack, or null for "system". Everything reaching the document goes
 *  through here: the value ends up in a `data-cursor` attribute and picks the
 *  drawing routine, so an unknown id must mean "off", never "half-applied". */
export function normalizeCursorPack(value: string | null | undefined): CursorPack | null {
  return typeof value === "string" && PACK_IDS.has(value) ? (value as CursorPack) : null;
}

type ShapeId =
  | "arrow"
  | "hand"
  | "beam"
  | "openHand"
  | "fist"
  | "move"
  | "nsResize"
  | "ewResize"
  | "crosshair"
  | "deny";

export interface CursorSpec {
  /** The custom property this shape feeds. */
  readonly varName: string;
  /** The CSS keyword it replaces — also the fallback baked into the value, so
   *  an image that fails to decode still leaves a valid `cursor` declaration. */
  readonly fallback: string;
  readonly shape: ShapeId;
  /** Hotspot in the 32-unit design box; emitted after the url, in CSS px. */
  readonly hotspot: readonly [number, number];
}

/** Every cursor the packs replace. Anything absent here (`wait`, `cell`,
 *  `zoom-in`, …) deliberately keeps the system shape: a pack that redraws the
 *  ten cursors the app actually uses looks intentional, while one that redraws
 *  six of twelve looks broken. */
export const CURSOR_SPECS: readonly CursorSpec[] = [
  { varName: "--cur-default", fallback: "default", shape: "arrow", hotspot: [2, 1] },
  { varName: "--cur-pointer", fallback: "pointer", shape: "hand", hotspot: [9, 1] },
  { varName: "--cur-text", fallback: "text", shape: "beam", hotspot: [16, 16] },
  { varName: "--cur-grab", fallback: "grab", shape: "openHand", hotspot: [16, 14] },
  { varName: "--cur-grabbing", fallback: "grabbing", shape: "fist", hotspot: [16, 14] },
  { varName: "--cur-move", fallback: "move", shape: "move", hotspot: [16, 16] },
  { varName: "--cur-ns-resize", fallback: "ns-resize", shape: "nsResize", hotspot: [16, 16] },
  { varName: "--cur-ew-resize", fallback: "ew-resize", shape: "ewResize", hotspot: [16, 16] },
  // The two `*-resize` twins the panes and tables use. They are the same art as
  // the axis pair above, under the names the existing rules ask for.
  { varName: "--cur-row-resize", fallback: "row-resize", shape: "nsResize", hotspot: [16, 16] },
  { varName: "--cur-col-resize", fallback: "col-resize", shape: "ewResize", hotspot: [16, 16] },
  { varName: "--cur-crosshair", fallback: "crosshair", shape: "crosshair", hotspot: [16, 16] },
  { varName: "--cur-not-allowed", fallback: "not-allowed", shape: "deny", hotspot: [16, 16] },
];

/** The property names a pack writes — and, just as importantly, the ones
 *  `applyCursor` must CLEAR when the pack is switched off: an inline root var
 *  outranks every stylesheet, so a leftover would keep painting forever. */
export const CURSOR_VAR_NAMES: readonly string[] = CURSOR_SPECS.map((s) => s.varName);

/** The three theme colors the art is built from. */
export interface CursorPalette {
  /** `--accent`: the body of the tinted packs. */
  accent: string;
  /** `--text-primary`: the outline of the tinted packs, the body of `ink`. */
  ink: string;
  /** `--bg-main`: the outline of `ink`, and the shade the tinted packs sit on. */
  surface: string;
}

/** Fancy Dark's tones — what the palette falls back to when the document has no
 *  computed styles to read (tests) or a token is not a plain color. */
export const CURSOR_PALETTE_FALLBACK: CursorPalette = {
  accent: "#36c5f0",
  ink: "#f4f8ff",
  surface: "#101624",
};

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Only a literal hex may reach a canvas fill: a custom property hands back its
 *  raw token stream, which for some tokens is a `color-mix()` or a gradient —
 *  values `fillStyle` rejects, leaving the previous (black) paint in place
 *  rather than erroring. Anything not a plain hex falls back to the theme
 *  default, which is always better than a black-on-black cursor. */
function hexOr(value: string | undefined, fallback: string): string {
  const v = (value ?? "").trim();
  return HEX_RE.test(v) ? v.toLowerCase() : fallback;
}

/** Read the live palette off an element's computed style (the root, normally).
 *  Called on every re-render rather than cached: the whole point of drawing the
 *  art at runtime is that a theme switch, a custom accent or a Theme Customizer
 *  edit repaints it. */
export function readCursorPalette(el?: Element | null): CursorPalette {
  try {
    const target = el ?? document.documentElement;
    const cs = getComputedStyle(target);
    return {
      accent: hexOr(cs.getPropertyValue("--accent"), CURSOR_PALETTE_FALLBACK.accent),
      ink: hexOr(cs.getPropertyValue("--text-primary"), CURSOR_PALETTE_FALLBACK.ink),
      surface: hexOr(cs.getPropertyValue("--bg-main"), CURSOR_PALETTE_FALLBACK.surface),
    };
  } catch {
    return { ...CURSOR_PALETTE_FALLBACK };
  }
}

/** `#rgb`/`#rrggbb` → `[r, g, b]`. Only ever fed values `hexOr` cleared. */
function rgb(hex: string): [number, number, number] {
  const h =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  return [
    Number.parseInt(h.slice(1, 3), 16),
    Number.parseInt(h.slice(3, 5), 16),
    Number.parseInt(h.slice(5, 7), 16),
  ];
}

/** Mix two hex colors, `t` of the way from `a` to `b`. Used for the tinted
 *  packs' top-lit body gradient and for the translucent glow. */
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${c(r1, r2)}, ${c(g1, g2)}, ${c(b1, b2)})`;
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface PackStyle {
  /** Pixels the art is rasterised on before being emitted at 32×32. Below 32 the
   *  upscale is nearest-neighbour, which is the pixel pack's whole look. */
  grid: number;
  body: (p: CursorPalette) => string;
  edge: (p: CursorPalette) => string;
  /** Outline thickness, in 32-box units. */
  edgeWidth: number;
  /** A soft colored halo behind the shape (`aurora`). */
  glow?: (p: CursorPalette) => string;
  /** Light the body from the top, so it reads as a solid object rather than a
   *  flat sticker. */
  shade?: boolean;
}

const PACK_STYLES: Record<CursorPack, PackStyle> = {
  // Accent-bodied, white-outlined, haloed: the fancy one, and the reason the
  // palette is read live — it is the accent, made into a pointer.
  aurora: {
    grid: 32,
    body: (p) => p.accent,
    edge: (p) => p.ink,
    edgeWidth: 1.6,
    glow: (p) => rgba(p.accent, 0.55),
    shade: true,
  },
  // 16-pixel grid, hard edges, no halo: the same shapes as chunky sprites.
  pixel: {
    grid: 16,
    body: (p) => p.accent,
    edge: (p) => p.ink,
    edgeWidth: 2,
  },
  // Monochrome: text color on the window's own ground. The quiet pack, and the
  // one that stays legible when the accent is a near-background tone.
  ink: {
    grid: 32,
    body: (p) => p.ink,
    edge: (p) => p.surface,
    edgeWidth: 1.8,
  },
};

/* ── Shapes ──────────────────────────────────────────────────────────────────
   Every shape is authored in a 32×32 box and drawn as ONE path, filled once
   with the non-zero rule: overlapping sub-shapes (a palm and its fingers) merge
   into a single silhouette, which is what lets the outline pass below trace the
   union instead of every internal seam. `k` scales the box onto the pack grid. */

function rr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  k: number,
) {
  const rad = Math.min(r, w / 2, h / 2) * k;
  const x0 = x * k;
  const y0 = y * k;
  const x1 = (x + w) * k;
  const y1 = (y + h) * k;
  ctx.moveTo(x0 + rad, y0);
  ctx.arcTo(x1, y0, x1, y1, rad);
  ctx.arcTo(x1, y1, x0, y1, rad);
  ctx.arcTo(x0, y1, x0, y0, rad);
  ctx.arcTo(x0, y0, x1, y0, rad);
  ctx.closePath();
}

function poly(ctx: CanvasRenderingContext2D, pts: readonly number[][], k: number) {
  ctx.moveTo(pts[0][0] * k, pts[0][1] * k);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * k, pts[i][1] * k);
  ctx.closePath();
}

const SHAPES: Record<ShapeId, (ctx: CanvasRenderingContext2D, k: number) => void> = {
  // The classic arrow, tip at the hotspot (2,1).
  arrow: (ctx, k) =>
    poly(
      ctx,
      [
        [2, 1],
        [2, 23],
        [7.4, 17.8],
        [11, 26.4],
        [15.4, 24.4],
        [11.9, 16.3],
        [19.4, 16.3],
      ],
      k,
    ),
  // Link hand: palm plus four fingers and a thumb, hotspot at the index tip.
  hand: (ctx, k) => {
    rr(ctx, 6.2, 11, 17.4, 15.4, 5.2, k);
    rr(ctx, 6.6, 1, 4.6, 14.5, 2.3, k);
    rr(ctx, 11.4, 6.4, 4.6, 9.2, 2.3, k);
    rr(ctx, 15.9, 7.4, 4.6, 8.4, 2.3, k);
    rr(ctx, 20.3, 9, 4.3, 7, 2.15, k);
    rr(ctx, 1.6, 14.4, 6.6, 9.2, 3.2, k);
  },
  // I-beam with serifs, so it stays readable over both text and code.
  beam: (ctx, k) => {
    rr(ctx, 14.6, 4, 2.8, 24, 0.6, k);
    rr(ctx, 11, 4, 10, 2.6, 0.8, k);
    rr(ctx, 11, 25.4, 10, 2.6, 0.8, k);
  },
  // Open hand — the "you may drag this" affordance.
  openHand: (ctx, k) => {
    rr(ctx, 7, 13, 17.6, 13.6, 5.6, k);
    rr(ctx, 7.6, 6.2, 4.2, 10, 2.1, k);
    rr(ctx, 12, 4.6, 4.2, 11.4, 2.1, k);
    rr(ctx, 16.4, 5.6, 4.2, 10.4, 2.1, k);
    rr(ctx, 20.7, 8, 4, 8, 2, k);
    rr(ctx, 2.6, 15, 6.4, 8.4, 3.2, k);
  },
  // Closed fist — the same hand, mid-drag.
  fist: (ctx, k) => {
    rr(ctx, 7, 11.4, 17.6, 14.6, 5.8, k);
    rr(ctx, 8.4, 9, 4, 5.2, 2, k);
    rr(ctx, 12.8, 8.2, 4, 6, 2, k);
    rr(ctx, 17, 8.8, 4, 5.4, 2, k);
    rr(ctx, 21, 10, 3.6, 4.6, 1.8, k);
    rr(ctx, 3.4, 14.4, 6, 7.6, 3, k);
  },
  move: (ctx, k) => {
    poly(ctx, [[16, 2], [11.5, 8.6], [20.5, 8.6]], k);
    poly(ctx, [[16, 30], [11.5, 23.4], [20.5, 23.4]], k);
    poly(ctx, [[2, 16], [8.6, 11.5], [8.6, 20.5]], k);
    poly(ctx, [[30, 16], [23.4, 11.5], [23.4, 20.5]], k);
    rr(ctx, 14.2, 8, 3.6, 16, 0.6, k);
    rr(ctx, 8, 14.2, 16, 3.6, 0.6, k);
  },
  nsResize: (ctx, k) => {
    poly(ctx, [[16, 2.5], [10.8, 10], [21.2, 10]], k);
    poly(ctx, [[16, 29.5], [10.8, 22], [21.2, 22]], k);
    rr(ctx, 14.2, 9, 3.6, 14, 0.6, k);
  },
  ewResize: (ctx, k) => {
    poly(ctx, [[2.5, 16], [10, 10.8], [10, 21.2]], k);
    poly(ctx, [[29.5, 16], [22, 10.8], [22, 21.2]], k);
    rr(ctx, 9, 14.2, 14, 3.6, 0.6, k);
  },
  // Four bars around an open centre: the gap is the point — it leaves the
  // pixel being aimed at visible.
  crosshair: (ctx, k) => {
    rr(ctx, 14.8, 2, 2.4, 11, 0.4, k);
    rr(ctx, 14.8, 19, 2.4, 11, 0.4, k);
    rr(ctx, 2, 14.8, 11, 2.4, 0.4, k);
    rr(ctx, 19, 14.8, 11, 2.4, 0.4, k);
  },
  // Ring plus bar. The ring's hole is cut by winding the inner circle the other
  // way; the bar, wound like the outer ring, fills back over that hole.
  deny: (ctx, k) => {
    ctx.moveTo(27.5 * k, 16 * k);
    ctx.arc(16 * k, 16 * k, 11.5 * k, 0, Math.PI * 2, false);
    ctx.moveTo(23.5 * k, 16 * k);
    ctx.arc(16 * k, 16 * k, 7.5 * k, 0, Math.PI * 2, true);
    ctx.save();
    ctx.translate(16 * k, 16 * k);
    ctx.rotate(-Math.PI / 4);
    ctx.moveTo(-11.5 * k, -2.1 * k);
    ctx.lineTo(11.5 * k, -2.1 * k);
    ctx.lineTo(11.5 * k, 2.1 * k);
    ctx.lineTo(-11.5 * k, 2.1 * k);
    ctx.closePath();
    ctx.restore();
  },
};

/* ── Rasteriser ───────────────────────────────────────────────────────────── */

/** The emitted cursor's size in CSS pixels. Not a knob: `cursor: url()` has no
 *  sizing syntax, so this number IS how big the pointer is on screen. */
export const CURSOR_SIZE = 32;

function canvasOf(size: number): HTMLCanvasElement | null {
  try {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    return c;
  } catch {
    return null;
  }
}

function ctxOf(c: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  if (!c) return null;
  try {
    return c.getContext("2d");
  } catch {
    // jsdom (and any environment without a canvas backend) throws here rather
    // than returning null. A pack that cannot draw simply does not apply.
    return null;
  }
}

/** The shape as an opaque black silhouette on a transparent grid. Every later
 *  pass is this one image, recolored and offset — which is how a composite
 *  shape gets a single outline around its union. */
function silhouette(shape: ShapeId, grid: number): HTMLCanvasElement | null {
  const c = canvasOf(grid);
  const ctx = ctxOf(c);
  if (!c || !ctx) return null;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  SHAPES[shape](ctx, grid / 32);
  ctx.fill();
  return c;
}

/** The silhouette re-inked: `source-in` keeps the alpha and replaces the color,
 *  so a gradient or a flat fill can be poured into the exact shape. */
function tinted(
  src: HTMLCanvasElement,
  grid: number,
  paint: string | CanvasGradient,
): HTMLCanvasElement | null {
  const c = canvasOf(grid);
  const ctx = ctxOf(c);
  if (!c || !ctx) return null;
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = paint;
  ctx.fillRect(0, 0, grid, grid);
  return c;
}

/** Eight stamps of the edge-colored silhouette on a ring around the origin.
 *  Stroking the path itself would trace every internal seam of a composite
 *  shape; offsetting the filled silhouette traces only its outline. */
const EDGE_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0.7, 0.7],
  [0, 1],
  [-0.7, 0.7],
  [-1, 0],
  [-0.7, -0.7],
  [0, -1],
  [0.7, -0.7],
];

function render(spec: CursorSpec, style: PackStyle, palette: CursorPalette): string | null {
  const grid = style.grid;
  const base = silhouette(spec.shape, grid);
  if (!base) return null;

  const out = canvasOf(grid);
  const ctx = ctxOf(out);
  if (!out || !ctx) return null;

  const edge = tinted(base, grid, style.edge(palette));
  if (!edge) return null;

  // The halo first, painted as the edge silhouette's own shadow so it hugs the
  // shape. Drawn onto a throwaway layer would cost another canvas; drawing it
  // under the passes that follow is enough, since they cover it opaquely.
  const glow = style.glow?.(palette);
  if (glow) {
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = (grid / 32) * 5;
    // Three stamps: one shadow pass is faint, and canvas has no "spread".
    for (let i = 0; i < 3; i++) ctx.drawImage(edge, 0, 0);
    ctx.restore();
  }

  const w = (style.edgeWidth * grid) / 32;
  for (const [dx, dy] of EDGE_OFFSETS) ctx.drawImage(edge, dx * w, dy * w);

  const bodyColor = style.body(palette);
  let paint: string | CanvasGradient = bodyColor;
  if (style.shade) {
    try {
      const g = ctx.createLinearGradient(0, 0, 0, grid);
      g.addColorStop(0, mix(bodyColor, "#ffffff", 0.45));
      g.addColorStop(1, bodyColor);
      paint = g;
    } catch {
      // No gradient support (a stubbed context): the flat body still reads.
    }
  }
  const body = tinted(base, grid, paint);
  if (!body) return null;
  ctx.drawImage(body, 0, 0);

  // The pixel pack draws small and is blown up here with smoothing off; the
  // smooth packs already drew at 32 and skip the second canvas entirely.
  const final = grid === CURSOR_SIZE ? out : upscale(out, grid);
  if (!final) return null;
  try {
    return final.toDataURL("image/png");
  } catch {
    return null;
  }
}

function upscale(src: HTMLCanvasElement, grid: number): HTMLCanvasElement | null {
  const c = canvasOf(CURSOR_SIZE);
  const ctx = ctxOf(c);
  if (!c || !ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, grid, grid, 0, 0, CURSOR_SIZE, CURSOR_SIZE);
  return c;
}

/** Rendering all twelve shapes costs a handful of milliseconds, and the palette
 *  they were drawn from can change on any theme edit — so the result is cached
 *  by pack and palette rather than recomputed on every settings broadcast. */
const cache = new Map<string, Record<string, string>>();

function cacheKey(pack: CursorPack, p: CursorPalette): string {
  return `${pack}|${p.accent}|${p.ink}|${p.surface}`;
}

/**
 * The custom properties for one pack: `{"--cur-pointer": 'url("data:…") 9 1,
 * pointer', …}`. Returns an empty map when nothing could be drawn (no canvas
 * backend, an unknown pack) — the caller then clears the vars and every rule
 * falls back to its keyword, which is the system cursor.
 */
export function buildCursorVars(
  pack: string | null | undefined,
  palette?: CursorPalette,
): Record<string, string> {
  const id = normalizeCursorPack(pack);
  if (!id) return {};
  const p = palette ?? readCursorPalette();
  const key = cacheKey(id, p);
  const hit = cache.get(key);
  if (hit) return hit;

  const style = PACK_STYLES[id];
  const out: Record<string, string> = {};
  for (const spec of CURSOR_SPECS) {
    const url = render(spec, style, p);
    if (!url) return {};
    const [hx, hy] = spec.hotspot;
    out[spec.varName] = `url("${url}") ${hx} ${hy}, ${spec.fallback}`;
  }
  // Only complete sets are cached: a half-drawn pack is never handed out, so a
  // transient failure retries instead of sticking.
  cache.set(key, out);
  return out;
}

/** The pack's shapes as plain image URLs, for the Settings preview strip. Same
 *  render (and same cache) as the cursors themselves, so what the strip shows
 *  is literally what the pointer will be. */
export function buildCursorPreview(
  pack: string | null | undefined,
  shapes: readonly string[] = ["--cur-default", "--cur-pointer", "--cur-text", "--cur-grab"],
): string[] {
  const vars = buildCursorVars(pack);
  return shapes
    .map((name) => vars[name]?.match(/^url\("([^"]+)"\)/)?.[1] ?? "")
    .filter((url) => url.length > 0);
}
