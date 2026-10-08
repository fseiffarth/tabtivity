import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The desktop Reader's reads of a transcript, driven by the backend's watch
 * on it (`services::transcript_watch`) rather than a 2 s poll. Each read
 * passes a watch id; the backend arms it on the files that read went by and
 * says so (`watched`), then announces a change as `transcript-changed` with
 * the id. A watched Reader reads again on that, plus a slow backstop for what
 * no file event says (a background shell dying with its CLI). An unwatched
 * one — a session with nothing on disk yet, a remote tab, an older backend —
 * keeps the old 2 s clock.
 */

/** How often a Reader whose read is not watched reads again. */
export const UNWATCHED_POLL_MS = 2000;
/** The backstop read of a watched Reader. */
export const WATCHED_BACKSTOP_MS = 15_000;

export const TRANSCRIPT_CHANGED_EVENT = "transcript-changed";

const callbacks = new Map<string, () => void>();
let listening: Promise<unknown> | null = null;

function ensureListener(): void {
  listening ??= listen<string>(TRANSCRIPT_CHANGED_EVENT, (event) => {
    callbacks.get(event.payload)?.();
  }).catch(() => {
    listening = null;
  });
}

/** This window's prefix: watch ids are unique across windows sharing a backend. */
const WINDOW_PREFIX = Math.random().toString(36).slice(2, 10) || "w";
let counter = 0;

function newWatchId(): string {
  counter += 1;
  return `rw-${WINDOW_PREFIX}-${counter}`;
}

function unwatch(id: string): void {
  void invoke("agent_transcript_unwatch", { watchId: id }).catch(() => {});
}

/**
 * Read now, then on every change the backend announces for this read's
 * watch, and on a timer — `WATCHED_BACKSTOP_MS` while the last read came back
 * watched, `UNWATCHED_POLL_MS` otherwise. `read` gets the watch id to pass as
 * `watch` and answers whether the backend armed it. Reads never overlap: a
 * change during one runs one more after it. Returns the stop, which also
 * disarms the watch.
 */
export function watchedReads(read: (watch: string) => Promise<boolean>): () => void {
  const id = newWatchId();
  let stopped = false;
  let busy = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<void> => {
    if (stopped) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    let watched = false;
    try {
      watched = await read(id);
    } catch {
      watched = false;
    }
    busy = false;
    if (stopped) {
      // The read armed the watch after the stop disarmed it.
      if (watched) unwatch(id);
      return;
    }
    if (again) {
      again = false;
      void run();
      return;
    }
    timer = setTimeout(() => void run(), watched ? WATCHED_BACKSTOP_MS : UNWATCHED_POLL_MS);
  };
  callbacks.set(id, () => void run());
  ensureListener();
  void run();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    callbacks.delete(id);
    unwatch(id);
  };
}

/** Deliver a change for `watch` as the event would (tests). */
export function _notifyTranscriptChangedForTest(watch: string): void {
  callbacks.get(watch)?.();
}
