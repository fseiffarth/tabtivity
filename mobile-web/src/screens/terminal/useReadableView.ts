// The phone terminal's reading view (Focus over the screen): following its
// newest turn, and the lazily drawn earlier output.
// Their effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import {
  useEffect, useLayoutEffect, useMemo, type Dispatch, type SetStateAction, type MutableRefObject,
  type RefObject,
} from "react";
import { type SessionTranscript } from "../../api";
import { type TerminalViewChoice } from "../../prefs";
import { type ReadableLine } from "../../terminal/readableScreen";
import { type HistoryChunk } from "../../terminal/readableHistory";

/** Frozen history chunks each "Show earlier output" tap reveals (×400 lines). */
const REVEAL_CHUNKS = 2;

/** Re-reads the screen when Focus opens, and keeps the reading view on its
 * newest turn through a resize. */
export function useReadableFollow({
  readableHost, refreshReadable, altScreen, view, atBottomRef, transcript,
}: {
  readableHost: RefObject<HTMLElement>;
  refreshReadable: MutableRefObject<() => void>;
  altScreen: boolean;
  view: TerminalViewChoice;
  atBottomRef: MutableRefObject<boolean>;
  transcript: SessionTranscript | null;
}) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (view === "focus") refreshReadable.current(); }, [view]);
  // The reading view has the problem Terminal view's box has: the keyboard
  // opening, or the composer growing under a long draft, shrinks it without
  // moving its scroll offset, so the newest turn slides under the composer.
  // There it also stops following output, because the follow test is the
  // distance to the bottom the shrink just opened up — nothing came back until
  // the reader found "Jump to latest". Put it back on the newest whenever it
  // was there before the resize.
  useEffect(() => {
    const stream = readableHost.current;
    if (!stream || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!atBottomRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => stream.scrollTo({ top: stream.scrollHeight }));
    });
    observer.observe(stream);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // The stored session mounts the reading view over a full-screen program
    // too, so its availability re-runs this as well.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, altScreen, transcript?.available]);
}

/** The lazy half of the earlier-output log: the chunks drawn, and a reveal that
 * keeps the reader's place. */
export function useEarlierOutput({
  readableHost, earlier, revealed, setRevealed, revealAnchor,
}: {
  readableHost: RefObject<HTMLElement>;
  earlier: { chunks: HistoryChunk[]; open: ReadableLine[]; dropped: boolean; };
  revealed: number;
  setRevealed: Dispatch<SetStateAction<number>>;
  revealAnchor: MutableRefObject<{ height: number; top: number; } | undefined>;
}) {
  /** Chunks above the revealed window stay in memory but out of the DOM — the
   * lazy half of the earlier-output log. */
  const hiddenChunks = Math.max(0, earlier.chunks.length - revealed);
  const visibleChunks = useMemo(
    () => earlier.chunks.slice(hiddenChunks),
    [earlier.chunks, hiddenChunks],
  );
  const hiddenLines = useMemo(
    () => earlier.chunks.slice(0, hiddenChunks).reduce((sum, chunk) => sum + chunk.lines.length, 0),
    [earlier.chunks, hiddenChunks],
  );
  const showEarlier = () => {
    const stream = readableHost.current;
    if (stream) revealAnchor.current = { height: stream.scrollHeight, top: stream.scrollTop };
    setRevealed((count) => count + REVEAL_CHUNKS);
  };
  // Revealing prepends content, which would shove the line the reader tapped
  // beside out of view; restore the reading position by the height delta.
  useLayoutEffect(() => {
    const anchor = revealAnchor.current;
    const stream = readableHost.current;
    if (!anchor || !stream) return;
    revealAnchor.current = undefined;
    stream.scrollTop = anchor.top + (stream.scrollHeight - anchor.height);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed]);
  return { visibleChunks, hiddenLines, showEarlier };
}
