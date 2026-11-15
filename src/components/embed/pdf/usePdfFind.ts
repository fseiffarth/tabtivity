/** The PDF viewer's Ctrl+F find bar (#71): matches over the arrangement's text, the
 *  per-page overlays, the scrollbar ticks and next/previous. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchText } from "./useSearchText";
import type { PageList } from "../../../lib/viewers/pageModel";
import type { PdfSources } from "./pdfDoc";
import { pdfPageMatches, type SyncRect } from "../../../lib/viewers/tex/tex";

/**
 * Find over the sheets' extracted text. `pageText` is shared with the blackout tool
 * (its snapping), so the text is extracted while either is in use.
 */
export function usePdfFind({
  pages,
  sources,
  paneVisible,
  redacting,
  scrollRef,
  contentRef,
  scale,
}: {
  pages: PageList;
  sources: PdfSources;
  paneVisible: boolean;
  /** The blackout tool is armed: it needs the page text too. */
  redacting: boolean;
  scrollRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
  scale: number;
}) {
  // ── Ctrl+F text search (#71) ───────────────────────────────────────
  // A floating find bar over the page stack with next/previous navigation, a
  // live match count, and a case toggle. Matches are found in each page's
  // extracted text (`getTextContent`) and painted as translucent boxes over the
  // canvases (`pdfPageMatches` → per-page rects), the current one brighter and
  // scrolled into view — the PDF counterpart to the editors' in-text search.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  const pageText = useSearchText(pages, sources, paneVisible && (findOpen || redacting));

  // Flat list of matches across all pages, in document order; each carries its
  // 1-based page and the big-point boxes covering it.
  const matches = useMemo(() => {
    if (!findOpen || !query || !pageText) return [];
    const out: { page: number; rects: SyncRect[] }[] = [];
    pageText.forEach((items, i) => {
      for (const rects of pdfPageMatches(items, i + 1, query, caseSensitive)) {
        out.push({ page: i + 1, rects });
      }
    });
    return out;
  }, [findOpen, query, caseSensitive, pageText]);

  // Bumped to ask the page holding the current match to scroll it into view.
  const [searchScrollNonce, setSearchScrollNonce] = useState(0);

  // Per-page search overlays passed to each PdfPageCanvas: its matches (with the
  // current one flagged) plus a scroll nonce that only advances for the page the
  // current match sits on.
  const searchByPage = useMemo(() => {
    const map = new Map<number, { rects: SyncRect[]; current: boolean }[]>();
    matches.forEach((m, i) => {
      const list = map.get(m.page) ?? [];
      list.push({ rects: m.rects, current: i === current });
      map.set(m.page, list);
    });
    return map;
  }, [matches, current]);
  const currentPage = matches[current]?.page ?? 0;

  // #71 scrollbar markers: one tick per match positioned over the native
  // scrollbar track at the match's fractional position through the document, so
  // hits scrolled off-screen are still locatable at a glance. Each tick's `top`
  // is px within the track (= the scroll area's visible height); the current
  // match's tick is flagged. Derived from live geometry — the page wraps'
  // on-screen rects plus the match box's y within its page — so it stays correct
  // across zoom and resize (recomputed by the effect below).
  const [markerTops, setMarkerTops] = useState<{ top: number; current: boolean }[]>([]);
  const recomputeMarkers = useCallback(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!findOpen || !scroll || !content || matches.length === 0) {
      setMarkerTops((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const wraps = content.children; // page wraps, in page order
    const scrollTop0 = scroll.getBoundingClientRect().top;
    const track = scroll.clientHeight; // scrollbar track height = visible height
    const total = scroll.scrollHeight;
    if (total <= 0) return;
    const tops: { top: number; current: boolean }[] = [];
    matches.forEach((m, i) => {
      const wrap = wraps[m.page - 1] as HTMLElement | undefined;
      if (!wrap) return;
      // The page's top in scroll-content coordinates (independent of the current
      // scroll offset), plus the match box's y within the page.
      const pageTop = wrap.getBoundingClientRect().top - scrollTop0 + scroll.scrollTop;
      const matchTop = pageTop + (m.rects[0]?.y ?? 0) * scale;
      tops.push({ top: (matchTop / total) * track, current: i === current });
    });
    setMarkerTops(tops);
  }, [findOpen, matches, current, scale, contentRef, scrollRef]);

  // Recompute markers when the match set / zoom / find-bar visibility changes,
  // and whenever the scroll area or page stack resizes (canvases render lazily,
  // growing the stack over several frames; a window/pane resize changes the
  // track height).
  useEffect(() => {
    recomputeMarkers();
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recomputeMarkers());
    ro.observe(scroll);
    ro.observe(content);
    return () => ro.disconnect();
  }, [recomputeMarkers, contentRef, scrollRef]);

  // Clamp the current index when the match set shrinks (query/case change).
  useEffect(() => {
    if (current > 0 && current >= matches.length) {
      setCurrent(matches.length > 0 ? matches.length - 1 : 0);
    }
  }, [matches.length, current]);

  // Jump to the first match whenever the query/case changes, the bar opens, or
  // the page text finishes extracting (so a query typed before extraction
  // completed still scrolls to its first hit).
  useEffect(() => {
    if (!findOpen) return;
    setCurrent(0);
    setSearchScrollNonce((n) => n + 1);
  }, [query, caseSensitive, findOpen, pageText]);

  const goToMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches.length === 0) return;
      setCurrent((c) => (c + dir + matches.length) % matches.length);
      setSearchScrollNonce((n) => n + 1);
    },
    [matches.length],
  );

  const openFind = useCallback(() => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    scrollRef.current?.focus();
  }, [scrollRef]);

  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

  return {
    findOpen,
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    current,
    findInputRef,
    pageText,
    matches,
    searchScrollNonce,
    searchByPage,
    currentPage,
    markerTops,
    goToMatch,
    openFind,
    closeFind,
    onFindKeyDown,
  };
}
