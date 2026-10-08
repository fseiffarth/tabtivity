import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startPoll, type Poll } from "./usePoll";

/**
 * **The** poll of Ollama's `stopped | idle | loaded` state — one timer for the
 * whole app, however many components ask.
 *
 * `ollama_status` is a `GET /api/ps` round trip, and it had two independent
 * callers on 5 s timers: the header's 🧠 `LocalModelMenu` lamp, and
 * `useLocalModelLoaded` in the file viewer — the second of which is **per
 * editable viewer tab**, so the request rate grew with the number of open tabs
 * rather than staying a property of the app. The observable result was a steady
 * stream of paired `/api/ps` hits a couple of seconds apart, forever, asking the
 * same question and getting the same answer.
 *
 * The state is genuinely global — whether a model is resident in Ollama's memory
 * is a fact about the machine, not about a tab — so a single shared poller is not
 * just cheaper, it is the more correct model: every surface now flips on the same
 * observation instead of each discovering it up to 5 s apart.
 *
 * Shape: subscribers register an interval they'd be happy with, the timer runs at
 * the **shortest** one asked for, and it only exists while at least one component
 * is subscribed. A tick that lands while a request is still in flight is skipped
 * rather than queued, so a slow or wedged Ollama can never accumulate a backlog.
 * The timer is `lib/usePoll`'s `startPoll`: it stops while the window is blurred
 * or hidden and catches up on return.
 */
export type OllamaStatus = "stopped" | "idle" | "loaded";

/** Default cadence, matching what each caller polled at individually before. */
export const DEFAULT_INTERVAL_MS = 5000;

interface Subscriber {
  notify: (s: OllamaStatus) => void;
  intervalMs: number;
}

const subscribers = new Set<Subscriber>();
let timer: Poll | undefined;
let inFlight = false;
/** Last observed value, replayed to a new subscriber so it renders the known
 *  state immediately instead of flashing `stopped` until the next tick. */
let current: OllamaStatus = "stopped";

async function poll(): Promise<void> {
  if (inFlight) return; // a wedged server must not build a queue of retries
  inFlight = true;
  try {
    const next = await invoke<OllamaStatus>("ollama_status");
    current = next;
    for (const s of subscribers) s.notify(next);
  } catch {
    // Unreachable backend — report the same thing an unreachable Ollama does.
    current = "stopped";
    for (const s of subscribers) s.notify("stopped");
  } finally {
    inFlight = false;
  }
}

/** (Re)start the shared timer at the shortest interval any subscriber wants, or
 *  stop it entirely when the last one leaves. */
function retime(): void {
  if (subscribers.size === 0) {
    timer?.stop();
    timer = undefined;
    return;
  }
  const wanted = Math.min(...[...subscribers].map((s) => s.intervalMs));
  // The subscriber asks straight away itself; the poll's first tick is one
  // interval out.
  if (timer === undefined) timer = startPoll(poll, wanted, { immediate: false });
  else timer.setIntervalMs(wanted);
}

/**
 * Subscribe to the shared Ollama status.
 *
 * `enabled` false unsubscribes (and reports `"stopped"`), so a caller gated on
 * something else — the menu's "is Ollama even installed?" check — contributes no
 * polling at all while it has nothing to show.
 */
export function useOllamaStatus(enabled = true, intervalMs = DEFAULT_INTERVAL_MS): OllamaStatus {
  const [status, setStatus] = useState<OllamaStatus>(enabled ? current : "stopped");

  useEffect(() => {
    if (!enabled) {
      setStatus("stopped");
      return;
    }
    let cancelled = false;
    const sub: Subscriber = {
      notify: (s) => {
        if (!cancelled) setStatus(s);
      },
      intervalMs,
    };
    subscribers.add(sub);
    retime();
    // Seat from the last known value, then ask straight away — a component that
    // mounts between ticks must not wait a whole interval for its first answer.
    setStatus(current);
    void poll();
    return () => {
      cancelled = true;
      subscribers.delete(sub);
      retime();
    };
  }, [enabled, intervalMs]);

  return status;
}

/** Reset the module between tests (no component is subscribed by then). */
export function resetOllamaStatusPoller(): void {
  subscribers.clear();
  timer?.stop();
  timer = undefined;
  inFlight = false;
  current = "stopped";
}
