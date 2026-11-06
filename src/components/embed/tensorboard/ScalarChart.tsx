import { memo, useMemo, useRef, useState } from "react";
import {
  extent,
  formatValue,
  formatX,
  logTicks,
  nearestIndex,
  niceTicks,
  pathData,
  smooth,
  downsample,
  xOf,
  type Line,
  type TfPoint,
  type XMode,
} from "../../../lib/viewers/tensorboard";
import { useT } from "../../../lib/i18n";

/** One run's series for a tag, with the colour slot it keeps for good. */
export interface ChartRun {
  name: string;
  slot: number;
  dash: string | null;
  points: readonly TfPoint[];
}

/** The most points a drawn path holds; more is paint cost with no pixels to show it. */
const DRAW_MAX = 1500;

interface Shape {
  run: ChartRun;
  /** The raw points as drawn (thinned, spikes kept). */
  raw: Line;
  /** The smoothed line (stride-thinned). */
  smooth: Line;
  /** x of every point, for the hover search. */
  xs: number[];
  /** Smoothed value of every point, for the readout. */
  sm: number[];
}

function shapeOf(run: ChartRun, mode: XMode, weight: number): Shape {
  const t0 = run.points.length ? run.points[0][1] : 0;
  const xs = run.points.map((p) => xOf(p, mode, t0));
  const sm = smooth(run.points, weight);
  const thin = run.points.length > DRAW_MAX ? downsample(run.points, DRAW_MAX) : run.points;
  const raw: Line = { xs: thin.map((p) => xOf(p, mode, t0)), ys: thin.map((p) => p[2]) };
  const stride = Math.max(1, Math.ceil(run.points.length / DRAW_MAX));
  const sx: number[] = [];
  const sy: number[] = [];
  for (let i = 0; i < run.points.length; i += stride) {
    sx.push(xs[i]);
    sy.push(sm[i]);
  }
  // Keep the newest point: a live line must reach the end of the data.
  const last = run.points.length - 1;
  if (last >= 0 && (last % stride !== 0)) {
    sx.push(xs[last]);
    sy.push(sm[last]);
  }
  return { run, raw, smooth: { xs: sx, ys: sy }, xs, sm };
}

interface Hover {
  /** Data x under the pointer. */
  x: number;
  /** Per run: index of its nearest point, or -1. */
  idx: number[];
}

const W = 320;
const H = 180;
const BIG_W = 960;
const BIG_H = 460;

/**
 * One tag's chart: every shown run as a line over one shared axis pair,
 * hand-drawn SVG like the rest of the app (no chart library). The raw line is
 * faint under the smoothed one; the crosshair reads the nearest point of each
 * run. Text wears the text tokens and only the marks carry a run's colour.
 */
export const ScalarChart = memo(function ScalarChart({
  tag,
  runs,
  xMode,
  logY,
  smoothing,
  big = false,
  onOpen,
}: {
  tag: string;
  runs: readonly ChartRun[];
  xMode: XMode;
  logY: boolean;
  smoothing: number;
  big?: boolean;
  onOpen?: () => void;
}) {
  const t = useT();
  const w = big ? BIG_W : W;
  const h = big ? BIG_H : H;
  const m = { l: big ? 56 : 44, r: 10, t: 8, b: big ? 28 : 22 };
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const shapes = useMemo(() => runs.map((r) => shapeOf(r, xMode, smoothing)), [runs, xMode, smoothing]);
  const box = useMemo(
    () => extent(shapes.flatMap((s) => [s.raw, s.smooth]), logY),
    [shapes, logY],
  );

  if (!box) {
    return (
      <div className="tb-chart tb-chart-empty">
        <div className="tb-chart-title">{tag}</div>
        <div className="tb-chart-nodata">{t("tensorboard.noData")}</div>
      </div>
    );
  }

  const plotW = w - m.l - m.r;
  const plotH = h - m.t - m.b;
  const dx = box.x1 - box.x0 || 1;
  const sx = (x: number) => m.l + ((x - box.x0) / dx) * plotW;
  let y0 = box.y0;
  let y1 = box.y1;
  let sy: (y: number) => number;
  let yTicks: number[];
  if (logY) {
    const l0 = Math.log10(y0);
    const l1 = Math.log10(y1);
    const pad = (l1 - l0) * 0.05 || 0.5;
    const a = l0 - pad;
    const b = l1 + pad;
    sy = (y) => m.t + (1 - (Math.log10(y) - a) / (b - a)) * plotH;
    yTicks = logTicks(Math.pow(10, a), Math.pow(10, b)).filter((v) => Math.log10(v) >= a && Math.log10(v) <= b);
    if (yTicks.length < 2) yTicks = niceTicks(y0, y1, 3).filter((v) => v > 0);
  } else {
    // A flat line (or one lost in rounding) gets a margin of its own size.
    const flat = y1 - y0 <= Math.max(Math.abs(y0), Math.abs(y1)) * 1e-9;
    const pad = flat ? Math.abs(y0) * 0.1 || 1 : (y1 - y0) * 0.06;
    y0 -= pad;
    y1 += pad;
    sy = (y) => m.t + (1 - (y - y0) / (y1 - y0)) * plotH;
    yTicks = niceTicks(y0, y1, big ? 6 : 4);
  }
  const xTicks = niceTicks(box.x0, box.x1, big ? 7 : 3);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    if (r.width === 0) return;
    const px = ((e.clientX - r.left) / r.width) * w;
    const x = box.x0 + ((px - m.l) / plotW) * dx;
    setHover({ x, idx: shapes.map((s) => nearestIndex(s.xs, x)) });
  };

  const hoverShape = hover
    ? shapes
        .map((s, i) => ({ s, i: hover.idx[i] }))
        .filter((h2) => h2.i >= 0)
    : [];
  // The crosshair sits on the nearest actual point of the closest run.
  const anchorX = hoverShape.length
    ? hoverShape.reduce((best, h2) => {
        const x = h2.s.xs[h2.i];
        return Math.abs(x - hover!.x) < Math.abs(best - hover!.x) ? x : best;
      }, hoverShape[0].s.xs[hoverShape[0].i])
    : null;
  const anchorPct = anchorX == null ? 0 : (sx(anchorX) / w) * 100;
  const showSmooth = smoothing > 0;

  return (
    <div className={`tb-chart${big ? " tb-chart-big" : ""}`}>
      {onOpen ? (
        <button type="button" className="tb-chart-title tb-chart-title-btn" onClick={onOpen} title={t("tensorboard.enlarge")}>
          {tag}
        </button>
      ) : (
        <div className="tb-chart-title">{tag}</div>
      )}
      <div className="tb-chart-plot">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${w} ${h}`}
          role="img"
          aria-label={t("tensorboard.chartAria", { tag, count: runs.length })}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onClick={onOpen}
          className="tb-svg"
        >
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line className="tb-grid" x1={m.l} x2={w - m.r} y1={sy(v)} y2={sy(v)} />
              <text className="tb-tick" x={m.l - 5} y={sy(v)} textAnchor="end" dominantBaseline="middle">
                {formatValue(v)}
              </text>
            </g>
          ))}
          {xTicks.map((v) => (
            <text key={`x${v}`} className="tb-tick" x={sx(v)} y={h - m.b + 12} textAnchor="middle">
              {formatX(v, xMode)}
            </text>
          ))}
          <line className="tb-axis" x1={m.l} x2={w - m.r} y1={h - m.b} y2={h - m.b} />
          {shapes.map((s) => {
            const colour = { stroke: `var(--tb-series-${s.run.slot})` };
            const dash = s.run.dash ?? undefined;
            const single = s.raw.xs.length === 1;
            return (
              <g key={s.run.name}>
                {single ? (
                  <circle cx={sx(s.raw.xs[0])} cy={sy(s.raw.ys[0])} r={3} style={{ fill: colour.stroke }} />
                ) : (
                  <>
                    <path
                      d={pathData(s.raw, sx, sy, logY)}
                      className={showSmooth ? "tb-line tb-line-raw" : "tb-line"}
                      style={colour}
                      strokeDasharray={dash}
                    />
                    {showSmooth && (
                      <path d={pathData(s.smooth, sx, sy, logY)} className="tb-line" style={colour} strokeDasharray={dash} />
                    )}
                  </>
                )}
              </g>
            );
          })}
          {hover && anchorX != null && (
            <g pointerEvents="none">
              <line className="tb-cross" x1={sx(anchorX)} x2={sx(anchorX)} y1={m.t} y2={h - m.b} />
              {hoverShape.map(({ s, i }) => {
                const v = showSmooth ? s.sm[i] : s.run.points[i][2];
                if (logY && v <= 0) return null;
                return (
                  <circle
                    key={s.run.name}
                    className="tb-marker"
                    cx={sx(s.xs[i])}
                    cy={sy(v)}
                    r={4}
                    style={{ fill: `var(--tb-series-${s.run.slot})` }}
                  />
                );
              })}
            </g>
          )}
        </svg>
        {hover && hoverShape.length > 0 && (
          <div
            className={`tb-tooltip${anchorPct > 55 ? " tb-tooltip-left" : ""}`}
            style={{ left: `${anchorPct}%` }}
            role="status"
          >
            {hoverShape.map(({ s, i }) => {
              const p = s.run.points[i];
              return (
                <div key={s.run.name} className="tb-tip-row">
                  <span className="tb-swatch" style={{ background: `var(--tb-series-${s.run.slot})` }} aria-hidden="true" />
                  <span className="tb-tip-run">{s.run.name}</span>
                  <span className="tb-tip-val">
                    {showSmooth ? `${formatValue(s.sm[i])} (${formatValue(p[2])})` : formatValue(p[2])}
                  </span>
                  <span className="tb-tip-meta">
                    {t("tensorboard.tipStep", { step: p[0] })} · {new Date(p[1] * 1000).toLocaleTimeString()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
