import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { readFileText, useFileScope } from "../../lib/files/fileAccess";
import {
  buildMdGraph,
  layoutMdGraph,
  type MdGraph,
} from "../../lib/viewers/mdGraph";

/**
 * The markdown relationship graph (opt-in behind the `md_graph` experimental
 * flag): the "Graph" mode of `MarkdownView`. Renders the link graph
 * `lib/viewers/mdGraph.ts` crawls from the viewed document — markdown files as
 * crawled nodes, every other linked file as a leaf, a link the crawl could not
 * read marked as missing — laid out on concentric BFS rings. Clicking any node
 * except the viewed document opens that file through the same `openLinkedFile`
 * routing an ordinary preview link uses (the `onOpen` callback), so the graph
 * is a second way to *navigate* the links, not a second link semantics.
 *
 * Reads ride `readFileText` with the pane's project scope, so a link pointing
 * outside the confinement renders as unreadable rather than being read. The
 * crawl is one bounded pass per mount/rebuild — no polling — which keeps a
 * remote (SFTP-backed) project's cost at one read per markdown node, only when
 * the user asks for the graph.
 */
export function MdGraphView({
  path,
  onOpen,
}: {
  path: string;
  onOpen: (target: string) => void;
}) {
  const t = useT();
  const scope = useFileScope();
  const [graph, setGraph] = useState<MdGraph | null>(null);
  const [building, setBuilding] = useState(true);
  const [nonce, setNonce] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(true);
  const dragRef = useRef<{ id: number; x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<{ path: string; x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBuilding(true);
    void buildMdGraph(path, (p) => readFileText(p, scope).catch(() => null))
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      .finally(() => {
        if (!cancelled) setBuilding(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, scope, nonce]);

  const layout = useMemo(() => (graph ? layoutMdGraph(graph) : null), [graph]);

  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !layout || !el.clientWidth || !el.clientHeight) return;
    const scale = Math.min(el.clientWidth / layout.width, el.clientHeight / layout.height, 1);
    setView({
      scale,
      x: (el.clientWidth - layout.width * scale) / 2,
      y: (el.clientHeight - layout.height * scale) / 2,
    });
    fittedRef.current = true;
  }, [layout]);

  const zoomTo = useCallback((target: number | ((scale: number) => number), anchor?: { x: number; y: number }) => {
    const el = viewportRef.current;
    if (!el || !layout || !el.clientWidth || !el.clientHeight) return;
    const fitScale = Math.min(el.clientWidth / layout.width, el.clientHeight / layout.height, 1);
    const at = anchor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    setView((prev) => {
      const requested = typeof target === "function" ? target(prev.scale) : target;
      const next = Math.min(8, Math.max(Math.min(0.05, fitScale), requested));
      return {
        scale: next,
        x: at.x - (at.x - prev.x) * next / prev.scale,
        y: at.y - (at.y - prev.y) * next / prev.scale,
      };
    });
    fittedRef.current = false;
  }, [layout]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !layout || (graph?.nodes.length ?? 0) <= 1) return;
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (fittedRef.current) fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit, graph, layout]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !layout || (graph?.nodes.length ?? 0) <= 1) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      zoomTo((scale) => scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      setHover(null);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [graph, layout, zoomTo]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, offsetX: view.x, offsetY: view.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!suppressClickRef.current && Math.hypot(dx, dy) < 4) return;
    if (!suppressClickRef.current) e.currentTarget.setPointerCapture(e.pointerId);
    suppressClickRef.current = true;
    setDragging(true);
    setHover(null);
    setView((prev) => ({ ...prev, x: drag.offsetX + dx, y: drag.offsetY + dy }));
    fittedRef.current = false;
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  if (building && !graph) {
    return <div className="file-viewer-loading">{t("mdGraph.building")}</div>;
  }
  if (!graph || !layout) return null;

  const start = graph.start;
  const hoveredNode = hover && graph.nodes.find((node) => node.path === hover.path);

  return (
    <div className="md-graph">
      <div className="md-graph-toolbar">
        <button
          className="md-graph-refresh"
          onClick={() => setNonce((n) => n + 1)}
          title={t("mdGraph.refresh")}
          disabled={building}
        >
          ↻
        </button>
        {graph.nodes.length > 1 && (
          <div className="md-graph-zoom" role="group" aria-label={t("imageZoom.controlsLabel")}>
            <button onClick={() => zoomTo((scale) => scale / 1.2)} title={t("imageZoom.zoomOutTitle")} aria-label={t("imageZoom.zoomOutTitle")}>−</button>
            <span title={t("imageZoom.currentZoomTitle")}>{Math.round(view.scale * 100)}%</span>
            <button onClick={() => zoomTo((scale) => scale * 1.2)} title={t("imageZoom.zoomInTitle")} aria-label={t("imageZoom.zoomInTitle")}>+</button>
            <button onClick={fit} title={t("imageZoom.fitTitle")}>{t("imageZoom.fit")}</button>
            <UntestedTag id="mdGraph.zoom" />
          </div>
        )}
        <span className="md-graph-hint">
          {graph.nodes.length <= 1
            ? t("mdGraph.empty")
            : graph.truncated
              ? t("mdGraph.truncated", { count: graph.nodes.length })
              : t("mdGraph.hint")}
        </span>
      </div>
      {graph.nodes.length > 1 && (
        <div
          ref={viewportRef}
          className={`md-graph-viewport${dragging ? " dragging" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={(e) => { endDrag(e); suppressClickRef.current = false; }}
          onClickCapture={(e) => {
            if (!suppressClickRef.current) return;
            e.preventDefault();
            e.stopPropagation();
            suppressClickRef.current = false;
          }}
        >
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          >
            {graph.edges.map((e) => {
              const from = layout.positions.get(e.from);
              const to = layout.positions.get(e.to);
              if (!from || !to) return null;
              return (
                <line
                  key={`${e.from}→${e.to}`}
                  className="md-graph-edge"
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                />
              );
            })}
            {graph.nodes.map((n) => {
              const pos = layout.positions.get(n.path);
              if (!pos) return null;
              const isStart = n.path === start;
              return (
                <g
                  key={n.path}
                  className={`md-graph-node md-graph-node-${n.kind}${
                    isStart ? " md-graph-node-current" : ""
                  }`}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  onClick={isStart ? undefined : () => onOpen(n.path)}
                  onMouseEnter={(e) => {
                    if (n.kind !== "md") return;
                    const rect = viewportRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    setHover({
                      path: n.path,
                      x: Math.max(8, Math.min(e.clientX - rect.left + 14, rect.width - 320)),
                      y: Math.max(8, Math.min(e.clientY - rect.top + 14, rect.height - 130)),
                    });
                  }}
                  onMouseLeave={() => setHover(null)}
                >
                  {n.kind !== "md" && <title>{n.path}</title>}
                  <circle r={isStart ? 13 : 9} />
                  <text y={isStart ? 30 : 24} textAnchor="middle">
                    {n.label}
                  </text>
                </g>
              );
            })}
          </svg>
          {hoveredNode && (
            <div className="md-graph-tooltip" style={{ left: hover!.x, top: hover!.y }}>
              <strong>{hoveredNode.heading || hoveredNode.label}</strong>
              <span>{hoveredNode.path}</span>
              {hoveredNode.excerpt && <p>{hoveredNode.excerpt}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
