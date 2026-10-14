import { useEffect, useRef, useState } from "react";
import { getUncommitted, type ChatUncommitted } from "../api";

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
  const read = useRef<() => void>(() => {});
  useEffect(() => {
    setAnswer(null);
    if (!enabled) return;
    let stopped = false;
    let request: AbortController | undefined;
    read.current = () => {
      if (stopped || document.visibilityState === "hidden") return;
      lastRead.current = Date.now();
      request?.abort();
      const controller = new AbortController();
      request = controller;
      void getUncommitted(tabId, controller.signal).then(
        (next) => {
          if (stopped || controller.signal.aborted) return;
          if (next === null || (typeof next === "object" && Array.isArray(next.files))) setAnswer(next);
        },
        () => {},
      );
    };
    const onVisible = () => read.current();
    read.current();
    const timer = window.setInterval(() => read.current(), UNCOMMITTED_POLL);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      request?.abort();
      read.current = () => {};
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tabId, enabled]);
  useEffect(() => {
    if (!enabled || transcriptVersion === undefined) return;
    const wait = lastRead.current + UNCOMMITTED_MIN_GAP - Date.now();
    if (wait <= 0) {
      read.current();
      return;
    }
    const timer = window.setTimeout(() => read.current(), wait);
    return () => window.clearTimeout(timer);
  }, [enabled, transcriptVersion]);
  useEffect(() => {
    if (enabled && refresh > 0) read.current();
  }, [enabled, refresh]);
  return answer;
}
