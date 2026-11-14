// Phone only, like `useSealedPdfFrame`: the desktop must never import it.
import { useEffect } from "react";
import type { PhoneMarkupAsk } from "../api";
import { RENDER_TIMEOUT, type SealedPdfFrame } from "./useSealedPdfFrame";

/**
 * What the sealed frame is asked to draw and find, once the view knows which
 * pages are alive. Called where the view's pages are laid out (after
 * `useSealedPdfFrame`), so these effects keep their place in the order.
 */
export function useFrameRenderQueue({ sealed, isPdf, reopening, alive, pixelWidth, asks }: {
  sealed: SealedPdfFrame;
  isPdf: boolean;
  /** A Reload's document has not told its pages yet: nothing is asked for. */
  reopening: boolean;
  /** The pages that get a picture, nearest to the reader first. */
  alive: readonly number[];
  pixelWidth: number;
  /** The agent's questions: each quote is looked for on its page. */
  asks: readonly PhoneMarkupAsk[];
}) {
  const { sizes, failure, pictures, setPictures, pageFailures, renderTick, inFlight, renderTimer, post, renderFailed, askFind } = sealed;

  // One page in flight at a time, the nearest to where the reader is first;
  // pictures far away are let go.
  useEffect(() => {
    if (!isPdf || !sizes || failure || reopening) return;
    const keep = new Set(alive);
    setPictures((known) => {
      const drop = Object.keys(known).map(Number).filter((n) => !keep.has(n));
      if (!drop.length) return known;
      const next = { ...known };
      for (const n of drop) { next[n].bitmap.close?.(); delete next[n]; }
      return next;
    });
    if (inFlight.current !== null) return;
    const wanted = alive.find((n) => !pageFailures.has(n) && (!pictures[n] || pictures[n].width < pixelWidth * 0.9));
    if (wanted === undefined) return;
    inFlight.current = wanted;
    post({ type: "render", n: wanted, width: pixelWidth });
    // A frame that never answers (wedged on a hostile page) must not hold
    // up every other page.
    window.clearTimeout(renderTimer.current);
    renderTimer.current = window.setTimeout(() => renderFailed(wanted), RENDER_TIMEOUT);
  }, [isPdf, sizes, failure, reopening, alive, pictures, setPictures, pageFailures, pixelWidth, post, renderTick, renderFailed, inFlight, renderTimer]);

  // Each question's quote is looked for once per document: the sealed frame
  // reads the page's text and answers boxes (`findText`), never the text.
  useEffect(() => {
    if (!isPdf || !sizes || failure || reopening) return;
    for (const ask of asks) {
      for (const question of ask.questions) {
        if (!question.quote || question.page === undefined || question.page > sizes.length) continue;
        askFind(question.page, question.quote);
      }
    }
  }, [isPdf, sizes, failure, reopening, asks, askFind]);
}
