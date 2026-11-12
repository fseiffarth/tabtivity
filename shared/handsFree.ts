// The hands-free send guard shared by the phone (Chrome's Web Speech) and the
// desktop (the backend's whisper), docs/desktop_voice_plan.md fixed decision 3:
// a hands-free send is never immediate. The pause after speech opens a short
// cancel window (the caller plays a chime); "stop", the stop key or a tap
// cancels it and the draft stays; otherwise the draft is sent when it closes.
// Pure: no browser, no i18n; the clock is passed in, so tests drive it.

import { isStopWord } from "./voice";

export interface GuardClock {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const BROWSER_CLOCK: GuardClock = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The cancel window after the chime. */
export const SEND_WINDOW_MS = 1_500;

export type GuardPhase =
  /** Nothing to send, or speech still going. */
  | "idle"
  /** Speech settled with a draft; the pause is running. */
  | "pausing"
  /** The chime played; a stop now cancels the send. */
  | "window"
  /** Speech started inside the window: the send waits for that segment's
   * text, which decides it. A spoken "stop" takes longer to settle than the
   * window lasts, so a timer alone would send over it. */
  | "holding";

export interface SendGuardHandlers {
  /** Whether the draft holds anything to send. An empty draft never sends. */
  hasDraft(): boolean;
  /** The pause passed: play the chime, the window is open. */
  onWindow(): void;
  /** The window closed with no stop: send the draft now. */
  onSend(): void;
  /** A stop closed the window; the draft stays unsent. */
  onCancel(): void;
  /** Every phase change, for the composer's line. */
  onPhase?(phase: GuardPhase): void;
}

export interface SendGuard {
  /** Speech started (a segment opened; on the phone, an interim result). No
   * pause counts while it is open; inside the window, the window holds. */
  speechStarted(): void;
  /**
   * The open speech settled as `text` (empty when it was dropped as noise).
   * Returns whether `text` belongs in the draft: a stop word never does — it
   * cancels the window, or the pause, and is dropped, so it can never be
   * sent. Call it before putting the text in the draft; the pause it starts
   * reads `hasDraft()` only when it runs out.
   */
  settled(text: string): boolean;
  /** The stop key, the indicator or a tap: cancels a pause or window. */
  cancel(): void;
  /** The draft went another way (a typed or spoken send, a clear) or the
   * session ended: back to idle, silently. */
  reset(): void;
  phase(): GuardPhase;
}

/**
 * `pauseMs` is how long settled speech must stay quiet before the chime. The
 * desktop passes 0: its voice detector already waited the pause before it
 * closed the segment. The phone's recognizer does not, so it passes the
 * setting.
 */
export function createSendGuard(
  pauseMs: number,
  handlers: SendGuardHandlers,
  clock: GuardClock = BROWSER_CLOCK,
  windowMs = SEND_WINDOW_MS,
): SendGuard {
  let phase: GuardPhase = "idle";
  let open = false;
  let timer: unknown = null;

  const stopTimer = () => {
    if (timer !== null) clock.clear(timer);
    timer = null;
  };
  const enter = (next: GuardPhase) => {
    if (phase === next) return;
    phase = next;
    handlers.onPhase?.(next);
  };
  const closeWindow = () => {
    timer = null;
    enter("idle");
    if (!open && handlers.hasDraft()) handlers.onSend();
  };
  const openWindow = (chime: boolean) => {
    stopTimer();
    if (open || !handlers.hasDraft()) {
      enter("idle");
      return;
    }
    enter("window");
    if (chime) handlers.onWindow();
    timer = clock.set(closeWindow, windowMs);
  };
  // A timer even at 0 ms: the caller puts the settled text in the draft
  // after `settled` returns, and the window must see it there.
  const startPause = () => {
    stopTimer();
    enter("pausing");
    timer = clock.set(() => {
      timer = null;
      openWindow(true);
    }, Math.max(0, pauseMs));
  };
  const cancelled = () => {
    const live = phase !== "idle";
    stopTimer();
    enter("idle");
    if (live) handlers.onCancel();
  };

  return {
    speechStarted() {
      open = true;
      if (phase === "window") {
        stopTimer();
        enter("holding");
      } else if (phase === "pausing") {
        stopTimer();
        enter("idle");
      }
    },
    settled(text) {
      open = false;
      if (isStopWord(text)) {
        cancelled();
        return false;
      }
      // Noise inside the window: nothing was said, so the window goes on —
      // fresh, and without a second chime.
      if (!text.trim() && phase === "holding") {
        openWindow(false);
        return true;
      }
      startPause();
      return true;
    },
    cancel: cancelled,
    reset() {
      stopTimer();
      open = false;
      enter("idle");
    },
    phase: () => phase,
  };
}

/**
 * A spoken pick of a dialog's row that waits for the send guard's window
 * (docs/threat_model.md gap 80): a voice never answers a dialog at once, as a
 * click would, because a number heard by a mic near speakers or a passenger
 * is not a decision. The pick is staged, the guard's pause, chime and cancel
 * window run on it exactly as on a dictated prompt (`hasDraft` counts it), and
 * it is applied only when the window closes. Pure: the owner keeps one per tab.
 */
export interface PickStage<T> {
  /** Any new settled utterance supersedes a staged pick — a "stop" cancels
   * it, other words replace it. Call it first, for every non-empty utterance;
   * the guard's own `onCancel` covers the stop key and a tap. */
  heard(): void;
  stage(pick: T): void;
  pending(): T | null;
  /** The window closed with no stop: the staged pick, once. */
  take(): T | null;
  clear(): void;
}

export function createPickStage<T>(): PickStage<T> {
  let staged: T | null = null;
  return {
    heard() { staged = null; },
    stage(pick) { staged = pick; },
    pending: () => staged,
    take() {
      const pick = staged;
      staged = null;
      return pick;
    },
    clear() { staged = null; },
  };
}

/** What a send guard that carries a `PickStage` asks of its owner. */
export interface StagedSendHandlers<T> {
  /** Whether the draft holds anything to send; a staged pick counts as well. */
  hasDraft(): boolean;
  /** The pause passed: play the chime, the window is open. */
  onWindow(): void;
  /** The window closed with no stop: `pick` is the staged pick, taken once,
   * or null when there is none and the draft is to be sent. */
  onSend(pick: T | null): void;
  onPhase?(phase: GuardPhase): void;
}

/**
 * The send guard with a spoken pick riding it, as both voice owners (the
 * phone's hands-free, the desktop Reader's) wire it: the pick counts as a
 * draft, it is handed over only when the window closes — a voice never
 * answers a dialog at once (gap 80) — and a stop, a cancel or a reset drops
 * it with the window.
 */
export function createStagedSendGuard<T>(
  pauseMs: number,
  stage: PickStage<T>,
  handlers: StagedSendHandlers<T>,
  clock?: GuardClock,
  windowMs?: number,
): SendGuard {
  const guard = createSendGuard(pauseMs, {
    hasDraft: () => stage.pending() !== null || handlers.hasDraft(),
    onWindow: () => handlers.onWindow(),
    onSend: () => handlers.onSend(stage.take()),
    onCancel: () => stage.clear(),
    onPhase: (next) => handlers.onPhase?.(next),
  }, clock, windowMs);
  return {
    ...guard,
    // Whatever resets or cancels the guard (a typed send, the mic's stop, the
    // stop key) drops a staged pick with it.
    reset() {
      stage.clear();
      guard.reset();
    },
    cancel() {
      stage.clear();
      guard.cancel();
    },
  };
}

/** A spoken pick, staged: `key` names the dialog it was heard on (so the
 * window's close answers only that one), `index` the row, `heard` what the
 * "Heard:" line shows ("2. Blue"). */
export interface VoicePick {
  key: string;
  index: number;
  heard: string;
}

/** What a hands-free caller makes of a settled utterance while a dialog may be
 * on screen: a staged pick, `"refused"` (a dialog a voice may not answer is
 * up: drop the words, never type them), or `null` (not a pick: dictation). */
export type VoicePickResult = VoicePick | "refused" | null;
