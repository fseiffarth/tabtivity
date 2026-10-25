import { useCallback, useEffect, useRef, useState } from "react";
import { getUncommitted, type ChatUncommitted } from "../api";
import { startVisiblePoll, type VisiblePoll } from "../visiblePoll";

/** How often the count is read while the chat is on screen: a commit made on
 * the desk, or by another session, moves it with no transcript change. */
export const UNCOMMITTED_POLL = 30_000;
/** The least time between two reads a moving transcript asks for — a turn
 * at work moves it on every poll. */
export const UNCOMMITTED_MIN_GAP = 5_000;

/**
 * The files this chat changed that are still not committed, for the Commit
 * chip (`GET /api/v1/tabs/{id}/uncommitted`). Read on open, when the page
 * comes back, every `UNCOMMITTED_POLL`, after the transcript moved (at most
 * once per `UNCOMMITTED_MIN_GAP`), and when `refresh` changes (the sheet
 * opening). A failed read keeps what is shown; `null` until the first answer,
 * and for a host that does not serve the count.
 */
export function useChatUncommitted(tabId: string, enabled: boolean, transcriptVersion: string | undefined, refresh: number): ChatUncommitted | null {
  const [answer, setAnswer] = useState<ChatUncommitted | null>(null);
  const lastRead = useRef(0);
  const poll = useRef<VisiblePoll | null>(null);
  const read = useCallback(() => poll.current?.now(), []);
  useEffect(() => {
    setAnswer(null);
    if (!enabled) return;
    const started = startVisiblePoll((signal) => {
      lastRead.current = Date.now();
      return getUncommitted(tabId, signal).then(
        (next) => {
          if (signal.aborted) return;
          if (next === null || (typeof next === "object" && Array.isArray(next.files))) setAnswer(next);
        },
        () => {},
      );
    }, UNCOMMITTED_POLL);
    poll.current = started;
    return () => {
      started.stop();
      if (poll.current === started) poll.current = null;
    };
  }, [tabId, enabled]);
  useEffect(() => {
    if (!enabled || transcriptVersion === undefined) return;
    const wait = lastRead.current + UNCOMMITTED_MIN_GAP - Date.now();
    if (wait <= 0) {
      read();
      return;
    }
    const timer = window.setTimeout(read, wait);
    return () => window.clearTimeout(timer);
  }, [enabled, transcriptVersion, read]);
  useEffect(() => {
    if (enabled && refresh > 0) read();
  }, [enabled, refresh, read]);
  return answer;
}
