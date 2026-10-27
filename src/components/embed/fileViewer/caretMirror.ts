import { useEffect, useState } from "react";

/** Live device-pixel ratio, updated when it changes (window moved between
 *  monitors, display scale changed, browser zoom). Used to snap the editor's
 *  line-height to whole device pixels — see `snapToDevicePx`. */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() =>
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const update = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [dpr]);
  return dpr;
}

/**
 * Snap a CSS-pixel length to a whole number of device pixels at `dpr`.
 *
 * The code editor stacks a transparent <textarea> (which owns the caret) over a
 * syntax-highlighted <pre>. WebKitGTK lays the textarea's lines out as
 * whole-device-pixel line boxes (height `round(lineHeight·dpr)` each, stacked),
 * but positions the <pre>'s lines at the exact fractional multiple
 * (`round(n·lineHeight·dpr)`). Under a fractional display scale those differ by
 * a fraction of a pixel per line and accumulate — over a long file (hundreds of
 * lines) the caret drifts a full line above the coloured text by the bottom.
 * Making `lineHeight·dpr` a whole number means both layouts land on the same
 * grid, so the per-line advance is identical and nothing accumulates. A no-op at
 * an integer dpr (e.g. 1.0 or 2.0), where the drift never appeared.
 */
export function snapToDevicePx(cssPx: number, dpr: number): number {
  return Math.round(cssPx * dpr) / dpr;
}

/**
 * Where the caret at character `pos` of a textarea is, used to anchor the
 * `\ref`/`\cite` completion dropdown right under the typed key. The standard
 * hidden-mirror technique, in two halves: a div copies the textarea's box/text
 * metrics, holds the text up to `pos`, and a trailing marker span's offset gives
 * the caret position (`textareaCaretMirrorOffsets` → these offsets, relative to
 * the textarea's padding box); the textarea's own scroll and screen rect then
 * map it to the viewport (`textareaMirrorToViewport`).
 */
export interface CaretMirrorOffsets {
  top: number;
  left: number;
  height: number;
}

/**
 * The textarea's content-box width — the width its lines wrap at — as the
 * fractional number layout actually uses, NOT `clientWidth`. `clientWidth` is
 * rounded to a whole pixel, and the editor's box is routinely fractional (it
 * is whatever flex leaves beside the gutter). Measured on WebKitGTK 2.52 with
 * the bundled JetBrains Mono at 12px (7.20006px advance): at a 527.5px box the
 * textarea wraps a 70-column comment onto two rows (70 × 7.20006 = 504.004 >
 * 503.5) while a mirror sized to `clientWidth` = 528 fits it on one — so every
 * gutter cell, caret mark and search mark below that line sat a row off, and the
 * coloured glyphs wrapped at a column the caret never reached. Sized to this
 * width instead, the mirror matched the textarea on every line of that document
 * at every width tried. The scrollbar is subtracted as `offsetWidth -
 * clientWidth`: both are rounded, but the difference is the scrollbar's whole-
 * pixel width, so it survives the rounding that the width itself does not.
 */
export function textareaWrapWidth(ta: HTMLTextAreaElement): number {
  return ta.getBoundingClientRect().width - (ta.offsetWidth - ta.clientWidth);
}

/** Map mirror offsets to viewport coordinates. Cheap — one `getBoundingClientRect`
 *  and the live scroll offsets — so the completion dropdown can re-anchor on
 *  every keystroke while the expensive mirror layout below runs once per token. */
export function textareaMirrorToViewport(
  ta: HTMLTextAreaElement,
  m: CaretMirrorOffsets,
): { left: number; top: number; height: number } {
  const rect = ta.getBoundingClientRect();
  return { left: rect.left + m.left - ta.scrollLeft, top: rect.top + m.top - ta.scrollTop, height: m.height };
}

/**
 * The mirror measurement itself: lay out the text up to `pos` in a hidden div
 * with the textarea's metrics and read the marker's offsets. This is a full
 * layout of everything before the caret — on a long document the single most
 * expensive thing a keystroke can do — which is why the caller caches it for
 * as long as the same token is being typed (the token's start does not move).
 */
export function textareaCaretMirrorOffsets(ta: HTMLTextAreaElement, pos: number): CaretMirrorOffsets {
  const style = getComputedStyle(ta);
  const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
  const div = document.createElement("div");
  const copy = [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom",
    "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
    "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle",
    "fontVariant", "letterSpacing", "wordSpacing", "lineHeight", "tabSize",
    "textIndent", "textTransform",
  ] as const;
  for (const p of copy) div.style[p as never] = style[p as never];
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = ta.wrap === "off" ? "pre" : "pre-wrap";
  div.style.overflowWrap = "anywhere";
  div.style.overflow = "hidden";
  div.style.height = "auto";
  div.textContent = ta.value.slice(0, pos);
  const marker = document.createElement("span");
  // Only the word the caret is in follows it: that is what decides whether a
  // soft wrap moves the caret to the next line, and it is all the marker's
  // position depends on. The rest of the document was laid out for nothing.
  marker.textContent = /^\S{0,200}/.exec(ta.value.slice(pos, pos + 200))?.[0] || ".";
  div.appendChild(marker);
  document.body.appendChild(div);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  document.body.removeChild(div);
  return { left, top, height: lh };
}
