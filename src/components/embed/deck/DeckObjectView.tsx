/**
 * Rendering one deck object.
 *
 * Objects render as **DOM/SVG over the page canvas**, not into it. That is the
 * decision this file encodes, and it is what separates an editor from an
 * annotator: hit-testing, selection outlines and z-order all come free from the
 * browser, whereas the repo's one canvas-drawing precedent (`ImageAnnotator`) is
 * pixel-destructive and cannot select anything it has drawn.
 *
 * Geometry arrives normalized (0..1 of the page) and converts to CSS pixels
 * exactly once, here, by the page's rendered size. Type size is the exception: it
 * is stored in PDF points and converts by `pointScale`. Mixing the two up is the
 * bug that makes text resize when you change monitor.
 *
 * **Text is laid out with PDF metrics, not the browser's.** Each visual line is
 * positioned absolutely from `deck/fonts.ts`'s wrap, rather than left to CSS —
 * because the exporter breaks lines with those same metrics, and a paragraph that
 * wraps one way on screen and another in the PDF is the single most corrosive bug
 * this feature could ship. Before the metrics finish loading it falls back to CSS
 * wrapping, which is approximately right and never blank.
 */

import type { CSSProperties } from "react";
import type { DeckObject } from "../../../lib/viewers/deck/model";
import { useT } from "../../../lib/i18n";
import {
  type TextMetrics,
  cssFontFor,
  lineOffset,
  listMarker,
  wrapText,
} from "../../../lib/viewers/deck/fonts";
import { iconByKey, ICON_VIEWBOX } from "../../../lib/viewers/deck/icons";
import {
  arrowHeadPath,
  isClosedShape,
  lineAngle,
  shapePath,
} from "../../../lib/viewers/deck/shapes";
import { basename } from "../../../lib/paths";

/** The metric-compatible stacks the three standard-14 families resolve to. */
export const FONT_STACKS: Record<string, string> = {
  sans: 'Helvetica, "Liberation Sans", "Nimbus Sans", Arial, sans-serif',
  serif: 'Times, "Liberation Serif", "Nimbus Roman", "Times New Roman", serif',
  mono: 'Courier, "Liberation Mono", "Nimbus Mono PS", "Courier New", monospace',
};

export interface ObjectViewProps {
  obj: DeckObject;
  /** Rendered page size in CSS px. */
  pageW: number;
  pageH: number;
  /** CSS px per PDF point — for font sizes and stroke widths. */
  pointScale: number;
  /** Resolved `src` → displayable URL, for images. Absent while loading. */
  assetUrl?: string;
  /** PDF text metrics; null until they finish loading. */
  metrics: TextMetrics | null;
  selected: boolean;
}

export function DeckObjectView({
  obj,
  pageW,
  pageH,
  pointScale,
  assetUrl,
  metrics,
  selected,
}: ObjectViewProps) {
  const t = useT();
  const w = obj.w * pageW;
  const h = obj.h * pageH;

  const frame: CSSProperties = {
    position: "absolute",
    left: obj.x * pageW,
    top: obj.y * pageH,
    width: w,
    height: h,
    opacity: obj.opacity,
    // Rotate about the centre, which is what a rotation handle implies.
    transform: obj.rot ? `rotate(${obj.rot}deg)` : undefined,
    transformOrigin: "50% 50%",
  };

  return (
    <div
      className={`deck-object${selected ? " selected" : ""}${obj.locked ? " locked" : ""}`}
      style={frame}
      data-object-id={obj.id}
    >
      {body(obj, w, h, pointScale, metrics, assetUrl, t)}
    </div>
  );
}

function body(
  obj: DeckObject,
  w: number,
  h: number,
  pointScale: number,
  metrics: TextMetrics | null,
  assetUrl: string | undefined,
  t: ReturnType<typeof useT>,
) {
  switch (obj.kind) {
    case "text":
      return <TextBody obj={obj} w={w} h={h} pointScale={pointScale} metrics={metrics} t={t} />;

    case "image":
      return assetUrl ? (
        <img
          src={assetUrl}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: obj.fit === "stretch" ? "fill" : obj.fit,
            display: "block",
          }}
        />
      ) : (
        <div className="deck-object-missing" title={obj.src}>
          {basename(obj.src)}
        </div>
      );

    case "shape": {
      const sw = obj.strokeWidth * pointScale;
      // Inset by half the stroke so a stroked edge sits INSIDE the box. Without
      // it a snapped edge is visually half a stroke off from the guide it
      // snapped to — the kind of small lie that makes alignment feel unreliable.
      const iw = Math.max(0, w - sw);
      const ih = Math.max(0, h - sw);
      const angle = lineAngle(iw, ih);
      const heads = [
        obj.head && obj.head !== "none" ? arrowHeadPath(obj.head, iw, ih, angle, sw) : "",
        obj.tail && obj.tail !== "none" ? arrowHeadPath(obj.tail, 0, 0, angle + Math.PI, sw) : "",
      ].filter(Boolean);
      return (
        <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
          <g transform={`translate(${sw / 2} ${sw / 2})`}>
            <path
              d={shapePath(obj.shape, iw, ih, obj.radius ?? 0.12)}
              fill={isClosedShape(obj.shape) ? (obj.fill ?? "none") : "none"}
              stroke={obj.stroke}
              strokeWidth={sw}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {heads.map((hd, i) => (
              <path key={i} d={hd} fill={obj.stroke} stroke={obj.stroke} strokeWidth={sw} />
            ))}
          </g>
        </svg>
      );
    }

    case "icon": {
      const def = iconByKey(obj.icon);
      if (!def) {
        // A deck written by a later build can name an icon this one lacks.
        // Showing where it was beats silently leaving a hole in the slide.
        return (
          <div className="deck-object-missing" title={obj.icon}>
            {obj.icon}
          </div>
        );
      }
      // Icons are authored in a 24-unit box that is scaled to fit the object, so
      // the stroke — stored in points like every other width in the deck — has to
      // be converted INTO viewBox units, or a small icon draws a hairline and a
      // large one draws a slab.
      const unitPx = Math.min(w, h) / ICON_VIEWBOX;
      const strokeUnits = unitPx > 0 ? (obj.strokeWidth * pointScale) / unitPx : 1;
      return (
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ display: "block", overflow: "visible" }}
        >
          <g
            transform={
              def.rotate ? `rotate(${def.rotate} ${ICON_VIEWBOX / 2} ${ICON_VIEWBOX / 2})` : undefined
            }
          >
            {def.paths.map((d, i) => (
              <path
                key={i}
                d={d}
                fill={def.filled ? obj.color : "none"}
                stroke={def.filled ? "none" : obj.color}
                strokeWidth={def.filled ? undefined : strokeUnits}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </g>
        </svg>
      );
    }
  }
}

/** Text, laid out line by line from the PDF metrics. See the module note. */
function TextBody({
  obj,
  w,
  h,
  pointScale,
  metrics,
  t,
}: {
  obj: Extract<DeckObject, { kind: "text" }>;
  w: number;
  h: number;
  pointScale: number;
  metrics: TextMetrics | null;
  t: ReturnType<typeof useT>;
}) {
  const s = obj.style;
  const pad = obj.padding * pointScale;

  const boxStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    boxSizing: "border-box",
    background: obj.fill ?? "transparent",
    border: obj.stroke ? `${(obj.strokeWidth ?? 1) * pointScale}px solid ${obj.stroke}` : undefined,
    overflow: "hidden",
  };

  const textStyle: CSSProperties = {
    // An embedded face is named by the `@font-face` `deckFonts.ts` installs; the
    // standard stack behind it is the fallback for the frame or two before the
    // file has been read, and for a font that could not be read at all — which is
    // also what the exporter substitutes, so the two still agree (#120).
    fontFamily: cssFontFor(s.family, FONT_STACKS),
    fontSize: s.size * pointScale,
    fontWeight: s.bold ? 700 : 400,
    fontStyle: s.italic ? "italic" : "normal",
    color: s.color,
    lineHeight: s.lineHeight,
    whiteSpace: "pre",
  };

  // Fallback until the metrics load: CSS wrapping. Approximately right, never
  // blank, and replaced within a frame or two.
  if (!metrics) {
    return (
      <div style={boxStyle}>
        <div
          style={{
            ...textStyle,
            position: "absolute",
            inset: pad,
            whiteSpace: "pre-wrap",
            textAlign: s.align,
          }}
        >
          {obj.list
            ? obj.text
                .split("\n")
                .map((l, i) => `${listMarker(obj.list!.kind, i, obj.list!.start)} ${l}`)
                .join("\n")
            : obj.text}
        </div>
      </div>
    );
  }

  const innerPt = Math.max(1, (w - pad * 2) / pointScale);
  const lines = wrapText(metrics, obj.text, s, innerPt, obj.list);
  const lineH = s.size * s.lineHeight * pointScale;

  return (
    <div style={boxStyle}>
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            ...textStyle,
            position: "absolute",
            left: pad,
            top: pad + i * lineH,
            width: w - pad * 2,
            height: lineH,
            lineHeight: `${lineH}px`,
          }}
        >
          {line.marker && (
            <span
              style={{
                position: "absolute",
                left: 0,
                width: line.indent * pointScale,
              }}
            >
              {line.marker}
            </span>
          )}
          <span
            style={{
              position: "absolute",
              left: lineOffset(line, s, innerPt) * pointScale,
            }}
          >
            {line.text}
          </span>
        </div>
      ))}
      {/* A box too short for its text is a real authoring mistake, not a render
          bug — say so rather than silently clipping the last line away. */}
      {lines.length * lineH > h - pad * 2 && (
        <span className="deck-text-overflow" title={t("deckObjectView.textOverflowTitle")} />
      )}
    </div>
  );
}
