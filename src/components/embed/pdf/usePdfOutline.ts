/** The PDF viewer's contents (#pdf-outline): the embedded outline, the font-size heading
 *  fallback, and where the reader is in it. */
import { useCallback, useEffect, useMemo, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { SELF, type PageList } from "../../../lib/viewers/pageModel";
import {
  loadOutline,
  detectHeadings,
  flattenOutline,
  outlineIsNavigable,
  type OutlineNode,
  type HeadingRun,
} from "./outline";
import { scrollIntoPdfBox } from "./scrollBox";
import { useT } from "../../../lib/i18n";

/**
 * The contents sidebar's state: the outline loaded per document, the heading scan
 * run only once the sidebar is opened on an outline-less document, the entry under
 * the reader, and the jump from a file page to the sheet showing it.
 */
export function usePdfOutline({
  doc,
  pages,
  pagesRef,
  visiblePage,
  contentRef,
}: {
  doc: PDFDocumentProxy | null;
  pages: PageList;
  pagesRef: React.MutableRefObject<PageList>;
  /** The 1-based sheet in view (the toolbar's "X / N"). */
  visiblePage: number;
  /** The page stack: its children are the sheets, in order. */
  contentRef: React.RefObject<HTMLDivElement>;
}) {
  const t = useT();
  /** The contents sidebar (the PDF's chapters/outline) is showing. */
  const [outlineOpen, setOutlineOpen] = useState(false);
  /** The document's resolved outline: null = not loaded yet, [] = none. */
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  /** The font-size heading fallback, used only when `outline` is empty: null =
   *  not scanned yet, [] = none found. */
  const [headings, setHeadings] = useState<OutlineNode[] | null>(null);

  // ── Contents / outline (#pdf-outline) ────────────────────────────────────
  // Load the PDF's embedded outline (its chapters) when a document loads. Reset
  // to "not loaded" first so a file switch never shows the prior file's chapters.
  useEffect(() => {
    setOutline(null);
    setHeadings(null);
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      try {
        const nodes = await loadOutline(doc, t("pdfOutline.untitled"));
        if (!cancelled) setOutline(nodes);
      } catch {
        if (!cancelled) setOutline([]); // treat an unreadable outline as none
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // Font-size heading fallback: when the PDF ships NO embedded outline, infer
  // chapters from the text's typography (`detectHeadings`). Run it lazily — only
  // once the contents pane is opened on an outline-less document — because it
  // reads every page's text content, which is far heavier than `getOutline`.
  useEffect(() => {
    if (!outlineOpen || !doc) return;
    // A lone title bookmark (some LaTeX templates ship exactly that) is not real
    // navigation, so scan for headings as if the outline were absent.
    if (outline == null || outlineIsNavigable(outline)) return; // usable outline present/pending
    if (headings != null) return; // already scanned
    let cancelled = false;
    void (async () => {
      const runs: HeadingRun[] = [];
      // Sequential (not Promise.all): a 500-page document would otherwise fire
      // 500 concurrent text extractions at the pdf.js worker at once.
      for (let p = 1; p <= doc.numPages; p++) {
        if (cancelled) return;
        try {
          const page = await doc.getPage(p);
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          for (const it of content.items) {
            if (!("str" in it) || typeof it.str !== "string" || !it.str.trim()) continue;
            const tx = pdfjs.Util.transform(viewport.transform, it.transform);
            const size = Math.hypot(tx[2], tx[3]);
            runs.push({ str: it.str, size, page: p, x: tx[4], y: tx[5] - size });
          }
          // Hand the page's parse back before moving on. This walks the WHOLE
          // document, so without it a scan of a long one ends holding every page
          // pdf.js had to parse to answer — and the pages the reader is looking at
          // are re-rendered from the file when they are next painted anyway.
          page.cleanup();
        } catch {
          /* skip an unreadable page */
        }
      }
      if (!cancelled) setHeadings(detectHeadings(runs));
    })();
    return () => { cancelled = true; };
  }, [outlineOpen, doc, outline, headings]);

  // The chapters actually shown: the embedded outline if the PDF has one, else
  // the inferred headings. `activeOutline` is null while its source is still
  // loading/scanning; `outlineDerived` says the fallback is in use.
  // A present-but-degenerate outline (a lone title bookmark) is treated as absent:
  // the fallback headings stand in, and the sidebar labels them as derived.
  const outlineUsable = outline != null && outlineIsNavigable(outline);
  const outlineDerived = outline != null && !outlineUsable;
  const activeOutline: OutlineNode[] | null =
    outline == null ? null : outlineUsable ? outline : headings;
  const outlinePlaceholder =
    activeOutline && activeOutline.length > 0
      ? null
      : outline == null
        ? t("pdfOutline.reading")
        : outlineDerived && headings == null
          ? t("pdfOutline.scanning")
          : t("pdfOutline.noChapters");

  // Jump the reader to a 1-based FILE page from the contents sidebar. The reader
  // shows an arrangement, so resolve the file page to whichever sheet is showing
  // it now (a moved/merged page still lands right; a deleted one is a no-op).
  const jumpToPage = useCallback((filePage: number) => {
    const idx = pagesRef.current.findIndex((r) => r.src === SELF && r.page === filePage);
    if (idx < 0) return;
    const wrap = contentRef.current?.children[idx] as HTMLElement | undefined;
    if (wrap) scrollIntoPdfBox(wrap, "start");
  }, [contentRef, pagesRef]);

  // The outline entry to highlight: the last chapter (in document order) whose
  // page is at or before the page currently in view. Recomputed from the flat
  // outline as the reader scrolls (`visiblePage`) — but keyed off the *file* page
  // the visible SHEET shows, so it stays right after pages are rearranged.
  const currentOutlineId = useMemo(() => {
    if (!activeOutline || activeOutline.length === 0) return null;
    const sheet = pages[visiblePage - 1];
    const filePage = sheet && sheet.src === SELF ? sheet.page : visiblePage;
    let best: string | null = null;
    for (const { node } of flattenOutline(activeOutline)) {
      if (node.page != null && node.page <= filePage) best = node.id;
    }
    return best;
  }, [activeOutline, visiblePage, pages]);

  return {
    outlineOpen,
    setOutlineOpen,
    activeOutline,
    outlineDerived,
    outlinePlaceholder,
    currentOutlineId,
    jumpToPage,
  };
}
