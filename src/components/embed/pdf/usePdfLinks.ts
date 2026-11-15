/** The PDF viewer's own hyperlinks (#pdf-links): following one, the landing mark, the
 *  way back, and the confirm before an external address leaves the app. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useExperimental } from "../../../lib/experimental";
import { SELF, type PageList } from "../../../lib/viewers/pageModel";
import type { PdfSources } from "./pdfDoc";
import type { PdfDest } from "./outline";
import { destTopInBigPoints, type PdfLink } from "./links";
import { scrollIntoPdfBox } from "./scrollBox";
import { openRoutedUri } from "../../../lib/linkTarget";
import { useSettingsStore } from "../../../stores/settings";
import { useT } from "../../../lib/i18n";

/**
 * Internal links land on the destination's line, mark it and push the old position on
 * a bounded back stack; external ones wait for `linkConfirm` and then go through the
 * app's one routing table (#33).
 */
export function usePdfLinks({
  path,
  scale,
  pagesRef,
  sourcesRef,
  scrollRef,
  contentRef,
  restoreScroll,
  setEditError,
}: {
  path: string;
  scale: number;
  pagesRef: React.MutableRefObject<PageList>;
  sourcesRef: React.MutableRefObject<PdfSources>;
  scrollRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
  /** A same-path reload's pending scroll restore, which a followed link supersedes. */
  restoreScroll: React.MutableRefObject<{ top: number; left: number } | null>;
  setEditError: (msg: string | null) => void;
}) {
  const t = useT();
  // What an external link in the PDF is routed by (#33). Read here rather than at
  // the click so the routing sees the same settings the rest of the app does.
  const settings = useSettingsStore((s) => s.settings);
  const browserEnabled = useExperimental("web_browser");
  const mailEnabled = useExperimental("mail_client");

  // ── The document's own hyperlinks (#pdf-links) ────────────────────────────
  // A `hyperref` PDF is full of them — every `\ref`, `\cite`, `\autoref` and
  // contents row is a GoTo annotation — so following one has to feel like part of
  // reading, not like navigation: the jump lands ON the target rather than at the
  // top of its page, marks where it landed, and leaves a way back.

  /** Where the reader was before each followed internal link (newest last). */
  const [linkBack, setLinkBack] = useState<{ top: number; left: number }[]>([]);
  /** The landing band: which sheet, how far down it (big points), and a nonce so
   *  a repeat jump to the same anchor flashes again. */
  const [destMark, setDestMark] = useState<{ index: number; top: number; nonce: number } | null>(null);
  const destMarkTimer = useRef<number | null>(null);
  /** The external address awaiting the confirm, or null. */
  const [linkConfirm, setLinkConfirm] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (destMarkTimer.current != null) window.clearTimeout(destMarkTimer.current);
    },
    [],
  );
  // A different file is a different document: its back stack and its landing mark
  // are positions in a page stack that no longer exists.
  useEffect(() => {
    setLinkBack([]);
    setDestMark(null);
    setLinkConfirm(null);
  }, [path]);

  /** How far below the viewport top an internal link's target is parked, so the
   *  landing line is not flush against the edge (and, on a `\ref`, the line above
   *  it is readable as context). */
  const DEST_PAD = 24;

  /** Scroll to a resolved destination. Returns false when nothing was moved —
   *  the arrangement may no longer contain the target page at all (it was
   *  deleted), and a back entry must not be pushed for a jump that did nothing. */
  const jumpToDest = useCallback(
    async (dest: PdfDest): Promise<boolean> => {
      const list = pagesRef.current;
      const idx = list.findIndex((r) => r.src === SELF && r.page === dest.page);
      if (idx < 0) return false;
      const scroller = scrollRef.current;
      const wrap = contentRef.current?.children[idx] as HTMLElement | undefined;
      if (!scroller || !wrap) return false;
      // Explicit navigation supersedes a same-path reload's scroll restoration —
      // the rule `onReveal` already applies to a SyncTeX jump.
      restoreScroll.current = null;
      const srcDoc = sourcesRef.current.get(SELF)?.doc;
      const top = srcDoc ? await destTopInBigPoints(srcDoc, dest, list[idx].rot ?? 0) : null;
      if (top == null) {
        // A whole-page destination (`/Fit`) names no line to land on.
        scrollIntoPdfBox(wrap, "start");
        return true;
      }
      // Measured rather than read off `offsetTop`: the page stack's offset parent
      // is not guaranteed to be the scroller, and a rect delta is right either way.
      const delta = wrap.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += delta + top * scale - DEST_PAD;
      setDestMark((m) => ({ index: idx, top, nonce: (m?.nonce ?? 0) + 1 }));
      if (destMarkTimer.current != null) window.clearTimeout(destMarkTimer.current);
      destMarkTimer.current = window.setTimeout(() => setDestMark(null), 2200);
      return true;
    },
    [scale, contentRef, pagesRef, restoreScroll, scrollRef, sourcesRef],
  );

  /** Step back to where the last internal link was followed from. */
  const linkGoBack = useCallback(() => {
    setLinkBack((s) => {
      const last = s[s.length - 1];
      if (!last) return s;
      const el = scrollRef.current;
      if (el) {
        restoreScroll.current = null;
        el.scrollTop = last.top;
        el.scrollLeft = last.left;
      }
      return s.slice(0, -1);
    });
  }, [restoreScroll, scrollRef]);

  const onPdfLink = useCallback(
    (link: PdfLink) => {
      if (link.kind === "external") {
        setLinkConfirm(link.url);
        return;
      }
      const el = scrollRef.current;
      const from = el ? { top: el.scrollTop, left: el.scrollLeft } : null;
      void jumpToDest(link.dest).then((moved) => {
        // Bounded: the stack is a way back from a chain of citations, not a
        // history of the session.
        if (moved && from) setLinkBack((s) => [...s.slice(-19), from]);
      });
    },
    [jumpToDest, scrollRef],
  );

  /** Open a confirmed external address through the app's ONE routing table
   *  (#33). `origin: "viewer"` is the load-bearing argument: a URL that came out
   *  of a file the user is looking at is untrusted, so it can never become a live
   *  in-app page in one click. No `openBrowserTab` hook is passed — this viewer
   *  does not own a tab store — so an in-app target degrades to the user's real
   *  browser rather than to a click that goes nowhere. */
  const openPdfLink = useCallback(
    (url: string) => {
      openRoutedUri(
        url,
        {
          setting: settings?.browser_link_target,
          browserEnabled,
          mailEnabled,
          origin: "viewer",
          browserRoleConfigured: !!settings?.global_apps?.browser?.exec,
        },
        {
          globalApps: settings?.global_apps,
          onRefuse: (reason) => setEditError(t("pdfLinks.refused", { reason })),
        },
      );
    },
    [settings, browserEnabled, mailEnabled, t, setEditError],
  );

  return { linkBack, destMark, linkConfirm, setLinkConfirm, linkGoBack, onPdfLink, openPdfLink };
}
