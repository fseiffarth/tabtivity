import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, listMarkupQuestions, type MarkupSource, type PhoneMarkupAsk } from "../api";

/** How often an open markup view (or a Focus chat) asks whether the agent has
 * a markup question, while it is on screen and the page is visible. */
export const MARKUP_ASK_POLL = 3_000;

/** Whether two listings show the same asks — a poll that found nothing new
 * leaves the card alone. */
function sameAsks(a: readonly PhoneMarkupAsk[], b: readonly PhoneMarkupAsk[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The agent tab's open markup questions (`markup_ask`,
 * `docs/markup_questions_mcp_plan.md` P3), for the file `source` names — or
 * every open one, without a source (the Focus banner).
 *
 * Read now, every `MARKUP_ASK_POLL` while `active` and the page is visible,
 * at once when the page comes back, and on every change of `edge` (the
 * agent's state: an ask comes with the end of a turn). Never while hidden or
 * inactive, and not while `paused` (an answer on its way, so the card does not
 * flicker between the answer and its reopen). A closed desktop
 * (`desktop_unavailable`) and a refusal read as no ask — the card hides; a
 * dropped connection keeps what is shown until the next poll.
 */
export function useMarkupAsks(tabId: string | undefined, source: MarkupSource | undefined, active: boolean, edge?: unknown, paused = false): {
  asks: PhoneMarkupAsk[];
  /** Read again now (after an answer or a refusal). */
  refresh: () => void;
  /** Take one ask off the card at once (answered or dismissed here). */
  drop: (id: string) => void;
} {
  const [asks, setAsks] = useState<PhoneMarkupAsk[]>([]);
  const [tick, setTick] = useState(0);
  const sourceKey = !source ? "" : "files" in source ? `files:${source.files}` : `outbox:${source.outbox}`;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const on = Boolean(tabId) && active && !paused;

  useEffect(() => {
    if (!tabId || !active) setAsks((was) => (was.length ? [] : was));
  }, [tabId, active]);

  useEffect(() => {
    if (!on || !tabId) return;
    let stopped = false;
    let inflight: AbortController | undefined;
    const poll = () => {
      if (stopped || document.visibilityState === "hidden") return;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      void listMarkupQuestions(tabId, sourceRef.current, controller.signal).then(
        (next) => { if (!stopped && !controller.signal.aborted) setAsks((was) => (sameAsks(was, next) ? was : next)); },
        (error: unknown) => {
          if (stopped || controller.signal.aborted) return;
          const code = error instanceof ApiError ? error.code : "";
          // Offline or slow: keep the card; the next poll retries.
          if (code === "offline" || code === "timeout") return;
          setAsks((was) => (was.length ? [] : was));
        },
      );
    };
    poll();
    const timer = window.setInterval(poll, MARKUP_ASK_POLL);
    document.addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      inflight?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [on, tabId, sourceKey, edge, tick]);

  const refresh = useCallback(() => setTick((was) => was + 1), []);
  const drop = useCallback((id: string) => setAsks((was) => was.filter((ask) => ask.id !== id)), []);
  return { asks, refresh, drop };
}
