/** The PDF viewer's go-to-page box (Ctrl+G) and ← / → sheet stepping. */
import { useCallback, useRef, useState } from "react";
import type { PageList } from "../../../lib/viewers/pageModel";
import { scrollIntoPdfBox } from "./scrollBox";

/**
 * Moves by ARRANGEMENT position, the toolbar's "X / N", so it lands right after pages
 * are reordered, merged or deleted.
 */
export function usePageJump({
  pages,
  pagesRef,
  contentRef,
  scrollRef,
  visiblePage,
  visiblePageRef,
}: {
  pages: PageList;
  pagesRef: React.MutableRefObject<PageList>;
  contentRef: React.RefObject<HTMLDivElement>;
  scrollRef: React.RefObject<HTMLDivElement>;
  visiblePage: number;
  /** Ahead of `visiblePage` within a frame: two presses step two sheets. */
  visiblePageRef: React.MutableRefObject<number>;
}) {
  // ── Go to page (Ctrl+G) ───────────────────────────────────────────────────
  // Jumps by ARRANGEMENT position — the same "X / N" the toolbar readout and
  // `visiblePage` already count in — so it lands right even after pages have
  // been reordered/merged/deleted, without having to resolve a file page first.
  const [pageJumpOpen, setPageJumpOpen] = useState(false);
  const [pageJumpValue, setPageJumpValue] = useState("");
  const pageJumpInputRef = useRef<HTMLInputElement>(null);
  const jumpToArrangementIndex = useCallback((pos: number) => {
    const count = pagesRef.current.length;
    if (count === 0) return;
    const idx = Math.min(Math.max(Math.trunc(pos), 1), count) - 1;
    const wrap = contentRef.current?.children[idx] as HTMLElement | undefined;
    if (wrap) scrollIntoPdfBox(wrap, "start");
  }, [contentRef, pagesRef]);
  /** ← / → : one sheet per press, the way a deck of slides is read. Returns
   *  false at either end of the document, where the caller leaves the key to the
   *  scroller rather than yanking the reader back to the top of the page they
   *  are already at the bottom of. */
  const stepPage = useCallback(
    (delta: number) => {
      const target = visiblePageRef.current + delta;
      if (target < 1 || target > pagesRef.current.length) return false;
      visiblePageRef.current = target;
      jumpToArrangementIndex(target);
      return true;
    },
    [jumpToArrangementIndex, pagesRef, visiblePageRef],
  );
  const openPageJump = useCallback(() => {
    if (pages.length === 0) return;
    setPageJumpValue(String(visiblePage));
    setPageJumpOpen(true);
    requestAnimationFrame(() => {
      pageJumpInputRef.current?.focus();
      pageJumpInputRef.current?.select();
    });
  }, [pages.length, visiblePage]);
  const closePageJump = useCallback(() => {
    setPageJumpOpen(false);
    scrollRef.current?.focus();
  }, [scrollRef]);
  const commitPageJump = useCallback(() => {
    const n = parseInt(pageJumpValue, 10);
    if (Number.isFinite(n)) jumpToArrangementIndex(n);
    closePageJump();
  }, [pageJumpValue, jumpToArrangementIndex, closePageJump]);

  return {
    pageJumpOpen,
    pageJumpValue,
    setPageJumpValue,
    pageJumpInputRef,
    stepPage,
    openPageJump,
    closePageJump,
    commitPageJump,
  };
}
