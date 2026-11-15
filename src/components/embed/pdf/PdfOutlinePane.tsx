/** The PDF viewer's contents sidebar: the outline tree and its page previews. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { OutlineNode } from "./outline";
import { UntestedTag } from "../../common/UntestedTag";
import { useT } from "../../../lib/i18n";

/**
 * One row of the contents sidebar, plus its children. A node with a resolved page
 * is a jump button; one without (an unresolvable destination) is inert text. A
 * node with children carries a ▸/▾ disclosure that toggles its subtree.
 */
/** The leading sign for a leaf row, one per level: a dot for the top tiers, a
 *  dash deeper down — the disclosure caret (a triangle) stands in for it on a row
 *  that has children, so a branch reads as ▸/▾, a mid leaf as •, a deep leaf as –. */
const leafSign = (depth: number) => (depth >= 2 ? "–" : "•");

function OutlineRow({
  node,
  depth,
  collapsed,
  currentId,
  onToggle,
  onJump,
  onHover,
}: {
  node: OutlineNode;
  depth: number;
  collapsed: Set<string>;
  currentId: string | null;
  onToggle: (id: string) => void;
  onJump: (page: number) => void;
  onHover: (page: number | null, rect: DOMRect | null) => void;
}) {
  const t = useT();
  const hasKids = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  return (
    <>
      <div
        className={`file-viewer-pdf-outline-row${node.id === currentId ? " current" : ""}${node.page == null ? " inert" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        {hasKids ? (
          <button
            className="file-viewer-pdf-outline-caret"
            onClick={() => onToggle(node.id)}
            aria-label={isCollapsed ? t("pdfOutline.expand") : t("pdfOutline.collapse")}
            title={isCollapsed ? t("pdfOutline.expand") : t("pdfOutline.collapse")}
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="file-viewer-pdf-outline-caret is-sign" aria-hidden="true">
            {leafSign(depth)}
          </span>
        )}
        <button
          className={`file-viewer-pdf-outline-title depth-${Math.min(depth, 3)}`}
          onClick={() => node.page != null && onJump(node.page)}
          onMouseEnter={(e) =>
            node.page != null && onHover(node.page, e.currentTarget.getBoundingClientRect())
          }
          onMouseLeave={() => onHover(null, null)}
          disabled={node.page == null}
          title={node.page != null ? t("pdfOutline.titlePageSuffix", { title: node.title, page: node.page }) : node.title}
        >
          {node.title}
        </button>
      </div>
      {hasKids &&
        !isCollapsed &&
        node.children.map((c) => (
          <OutlineRow
            key={c.id}
            node={c}
            depth={depth + 1}
            collapsed={collapsed}
            currentId={currentId}
            onToggle={onToggle}
            onJump={onJump}
            onHover={onHover}
          />
        ))}
    </>
  );
}

/** Preview card width in CSS px; the thumbnail's height follows the page aspect. */
const OUTLINE_PREVIEW_W = 220;

/**
 * A floating thumbnail of a contents entry's page, shown while its row is
 * hovered. Renders the page once at preview width and memoises it in the shared
 * `cache` (keyed by file page), so re-hovering the same chapter is instant and a
 * long document only rasterises the pages actually pointed at.
 */
function OutlinePreview({
  doc,
  page,
  top,
  left,
  cache,
}: {
  doc: PDFDocumentProxy;
  page: number;
  top: number;
  left: number;
  cache: Map<number, string>;
}) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(() => cache.get(page) ?? null);
  useEffect(() => {
    const hit = cache.get(page);
    if (hit) {
      setUrl(hit);
      return;
    }
    setUrl(null);
    let cancelled = false;
    void (async () => {
      try {
        const p = await doc.getPage(page);
        if (cancelled) return;
        const base = p.getViewport({ scale: 1, rotation: p.rotate });
        const dpr = window.devicePixelRatio || 1;
        const scale = (OUTLINE_PREVIEW_W / (base.width || 1)) * dpr;
        const viewport = p.getViewport({ scale, rotation: p.rotate });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await p.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (cancelled) return;
        const data = canvas.toDataURL("image/png");
        cache.set(page, data);
        setUrl(data);
      } catch {
        /* leave the card in its loading state on a render failure */
      }
    })();
    return () => { cancelled = true; };
  }, [doc, page, cache]);

  return (
    <div className="file-viewer-pdf-outline-preview" style={{ top, left, width: OUTLINE_PREVIEW_W }}>
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <div className="file-viewer-pdf-outline-preview-loading">{t("pdfOutline.renderingPage", { page })}</div>
      )}
      <div className="file-viewer-pdf-outline-preview-cap">{t("pdfOutline.pageCaption", { page })}</div>
    </div>
  );
}

/**
 * The contents sidebar: the PDF's embedded outline (chapters/sections) as a
 * collapsible tree. Clicking an entry jumps the reader to its page; the entry
 * whose page is currently in view is highlighted; hovering an entry shows a
 * thumbnail of its page. A PDF with no outline shows a short notice.
 */
export function OutlinePane({
  doc,
  nodes,
  placeholder,
  derived,
  currentId,
  onJump,
}: {
  /** The file's own document, for rendering hover previews (null while loading). */
  doc: PDFDocumentProxy | null;
  /** The chapters to show, or null while they're still being loaded/scanned. */
  nodes: OutlineNode[] | null;
  /** The message to show when there is nothing to render (loading or empty). */
  placeholder: string | null;
  /** True when `nodes` came from the font-size fallback, not an embedded outline. */
  derived: boolean;
  currentId: string | null;
  onJump: (page: number) => void;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Hover preview: a small debounce keeps a quick pass down the list from
  // rasterising every page it crosses; the card is placed just right of the pane
  // at the hovered row's height (clamped to stay on screen).
  const paneRef = useRef<HTMLDivElement>(null);
  const previewCache = useRef<Map<number, string>>(new Map());
  const [preview, setPreview] = useState<{ page: number; top: number; left: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const onHover = useCallback((page: number | null, rect: DOMRect | null) => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current);
    if (page == null || !rect) {
      setPreview(null);
      return;
    }
    hoverTimer.current = window.setTimeout(() => {
      const pane = paneRef.current?.getBoundingClientRect();
      const left = (pane?.right ?? rect.right) + 8;
      // Keep the card on screen: assume up to ~320px tall and nudge up if the row
      // sits near the bottom edge.
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 328));
      setPreview({ page, top, left });
    }, 140);
  }, []);
  useEffect(
    () => () => { if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current); },
    [],
  );

  return (
    <div className="file-viewer-pdf-outline" ref={paneRef}>
      <div className="file-viewer-pdf-outline-head">
        <span>{t("pdfOutline.contentsHeader")}</span>
        <UntestedTag id="pdfViewer.1" />
      </div>
      {derived && nodes && nodes.length > 0 && (
        <div className="file-viewer-pdf-outline-note" title={t("pdfOutline.derivedNoteTitle")}>
          {t("pdfOutline.derivedNote")}
        </div>
      )}
      <div
        className="file-viewer-pdf-outline-body"
        // A stale row rect after a scroll would misplace the card, so drop it.
        onScroll={() => setPreview(null)}
      >
        {placeholder != null ? (
          <div className="file-viewer-pdf-outline-empty">{placeholder}</div>
        ) : (
          nodes!.map((n) => (
            <OutlineRow
              key={n.id}
              node={n}
              depth={0}
              collapsed={collapsed}
              currentId={currentId}
              onToggle={toggle}
              onJump={onJump}
              onHover={onHover}
            />
          ))
        )}
      </div>
      {preview && doc && (
        <OutlinePreview
          doc={doc}
          page={preview.page}
          top={preview.top}
          left={preview.left}
          cache={previewCache.current}
        />
      )}
    </div>
  );
}
