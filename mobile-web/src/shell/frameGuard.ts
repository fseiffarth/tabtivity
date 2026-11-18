/**
 * The framed page's clickjacking guard (`docs/context/mobile_access.md`
 * § Linked desktops). A linked desktop frames this page; were that desktop
 * compromised, its page could cover, fade, move or transform this frame and
 * steer the reader's taps and keys into it. The framing page is the one not
 * trusted, so the guard is this page's own: inside any frame it takes no
 * input unless the browser itself reports it fully visible
 * (IntersectionObserver v2 `trackVisibility`: nothing drawn over it, no
 * opacity, transform or filter on it or an ancestor frame) and has for
 * `SETTLE_MS`, so a frame slid under the finger just before a tap misses.
 *
 * A browser without that report (iOS Safari, Firefox) never clears: fail
 * closed. `FrameGuard.tsx` then offers this desktop on its own instead.
 *
 * Not covered: a frame cropped by its parent (`clip-path`, a small frame)
 * still shows this page's own pixels, laid out for that size — what is
 * tapped is what is seen. And IntersectionObserver reports at most every
 * `VISIBILITY_DELAY_MS`; `state()` drains queued reports first.
 */

export type FrameGuardState =
  /** No visibility report in this browser: input stays off. */
  | "unsupported"
  /** Reported covered, faded, transformed or off screen, or not yet reported. */
  | "covered"
  /** Reported visible, for less than `SETTLE_MS`. */
  | "settling"
  /** Visible and settled: input passes. */
  | "clear";

/** How long the page must have been visible before input passes. */
export const SETTLE_MS = 500;
/** IntersectionObserver v2's floor for `delay` with `trackVisibility`. */
export const VISIBILITY_DELAY_MS = 100;

/** The v2 fields `lib.dom` does not type yet. */
type VisibilityInit = IntersectionObserverInit & { trackVisibility: boolean; delay: number };
type VisibilityEntry = IntersectionObserverEntry & { isVisible?: boolean };

/** Whether this browser reports occlusion (IntersectionObserver v2). */
export function visibilitySupported(): boolean {
  return typeof IntersectionObserver === "function"
    && typeof IntersectionObserverEntry === "function"
    && "isVisible" in IntersectionObserverEntry.prototype;
}

/** Whether this page sits in any frame, its parent's origin known or not. */
export function inAnyFrame(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

export interface FrameGuard {
  /** The state now, queued visibility reports applied first. */
  state(): FrameGuardState;
  stop(): void;
}

/** Watch `target` (the document's root element) and report state changes. */
export function startFrameGuard(
  target: Element,
  onChange: (state: FrameGuardState) => void,
  now: () => number = () => performance.now(),
): FrameGuard {
  if (!visibilitySupported()) {
    return { state: () => "unsupported", stop: () => undefined };
  }
  let visibleSince: number | null = null;
  let settleTimer: number | undefined;
  let last: FrameGuardState | null = null;
  const current = (): FrameGuardState => {
    if (visibleSince === null) return "covered";
    return now() - visibleSince >= SETTLE_MS ? "clear" : "settling";
  };
  const emit = () => {
    const state = current();
    if (state !== last) {
      last = state;
      onChange(state);
    }
  };
  const apply = (entries: IntersectionObserverEntry[]) => {
    const entry = entries[entries.length - 1] as VisibilityEntry | undefined;
    if (!entry) return;
    const visible = entry.isIntersecting && entry.isVisible === true;
    if (!visible) {
      visibleSince = null;
      window.clearTimeout(settleTimer);
      settleTimer = undefined;
    } else if (visibleSince === null) {
      visibleSince = now();
      settleTimer = window.setTimeout(() => {
        settleTimer = undefined;
        emit();
      }, SETTLE_MS);
    }
    emit();
  };
  const init: VisibilityInit = { threshold: [0, 1], trackVisibility: true, delay: VISIBILITY_DELAY_MS };
  const observer = new IntersectionObserver(apply, init);
  observer.observe(target);
  return {
    state: () => {
      apply(observer.takeRecords());
      return current();
    },
    stop: () => {
      observer.disconnect();
      window.clearTimeout(settleTimer);
    },
  };
}

/** What a tap or a key can start; scrolling and hover are left alone. */
export const GUARDED_EVENTS = [
  "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu",
  "touchstart", "touchend", "keydown", "keypress", "keyup", "beforeinput", "paste", "drop", "dragstart",
] as const;

/**
 * Drop every guarded event at the window, capture phase, unless the guard is
 * clear or `allowed(target)` (the guard's own card). The body is also made
 * inert while blocked (`FrameGuard.tsx`), which reaches nested frames this
 * listener cannot; this catches what inert leaves, such as window-level keys.
 */
export function blockInput(guard: FrameGuard, allowed: (target: EventTarget | null) => boolean): () => void {
  const listener = (event: Event) => {
    if (allowed(event.target) || guard.state() === "clear") return;
    if (event.cancelable && !passive(event.type)) event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of GUARDED_EVENTS) window.addEventListener(type, listener, { capture: true, passive: passive(type) });
  return () => {
    for (const type of GUARDED_EVENTS) window.removeEventListener(type, listener, { capture: true });
  };
}

/** Touch listeners stay passive, so scrolling never waits on this page's main
 * thread; the tap they start is still dropped at `click` and by the inert body. */
function passive(type: string): boolean {
  return type === "touchstart" || type === "touchend";
}
