/**
 * The Focus view's sideways swipe: left→right reveals the agent's status
 * strip, right→left puts it away. The project screen reads the same gesture
 * for its files drawer (`ProjectFiles`), which slides in from the left, and
 * for closing a tab card, which a right→left swipe over it does.
 *
 * Every listener here is passive and nothing is ever prevented. The Focus view
 * is a reading surface whose vertical scroll and text selection are the
 * browser's own, and the swipe is only ever *read* off a gesture the browser
 * is free to handle as well — unlike `touchScroll.ts`, which owns its axes and
 * says so with `touch-action:none`. The cost is that the browser may claim the
 * gesture first, which the pointer path below has to allow for.
 *
 * Three gestures are deliberately not swipes: one starting at a screen edge
 * (Android's system back gesture lives there, and toggling the strip on the
 * way out of the app would be a surprise — the files drawer opts its left edge
 * back in, `leftEdge`), one starting in a text field (a
 * drag there moves the caret), and one over something that can still pan
 * sideways in that direction (a wide code block has to keep scrolling).
 */

export interface SwipePoint { x: number; y: number; t: number }
export type SwipeDirection = "right" | "left";

/** How far the finger must travel sideways, in CSS pixels. Well past a tap's
 * wobble and a scroll's drift, well short of the phone's width. */
export const SWIPE_MIN_DISTANCE = 56;
/** Horizontal travel must be at least this multiple of the vertical — a
 * scroll that wanders sideways is still a scroll. */
export const SWIPE_AXIS_RATIO = 2;
/** A swipe is a flick. A slower drag is reading, selecting or hesitating. */
export const SWIPE_MAX_DURATION_MS = 700;
/** Starts this close to either viewport edge belong to the system gesture. */
export const SWIPE_EDGE_GUARD = 16;

/** Pure: a finished gesture's direction, or null when it was not a swipe. */
export function classifySwipe(start: SwipePoint, end: SwipePoint): SwipeDirection | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const duration = end.t - start.t;
  if (duration < 0 || duration > SWIPE_MAX_DURATION_MS) return null;
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return null;
  if (Math.abs(dx) < SWIPE_AXIS_RATIO * Math.abs(dy)) return null;
  return dx > 0 ? "right" : "left";
}

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** The element a gesture started on; a text node's is its parent. */
function elementOf(target: EventTarget | null): Element | null {
  const node = target as Node | null;
  if (!node || typeof node.nodeType !== "number") return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/**
 * Whether the user could still pan `element` the way this swipe would move
 * its content: a right swipe drags content rightwards, which needs columns to
 * the left (`scrollLeft > 0`); a left swipe needs columns to the right. Only a
 * box whose `overflow-x` lets the user scroll counts — a clipped (`hidden`) or
 * unclipped (`visible`) box can report `scrollWidth > clientWidth` while no
 * finger can move it, and would otherwise swallow every left swipe over it.
 * The 1px slack absorbs the fractional widths a zoomed phone reports.
 */
function pansSideways(element: Element, direction: SwipeDirection) {
  const overflow = getComputedStyle(element).overflowX;
  if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay") return false;
  if (direction === "right") return element.scrollLeft > 0;
  return element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
}

function blockedByScroller(start: Element | null, host: HTMLElement, direction: SwipeDirection) {
  for (let element = start; element && element !== host; element = element.parentElement) {
    if (pansSideways(element, direction)) return true;
  }
  return false;
}

function currentSelection() {
  try {
    return String(window.getSelection?.() ?? "");
  } catch {
    return "";
  }
}

interface Gesture {
  id: number;
  start: SwipePoint;
  target: Element | null;
  /** The text selected when the finger landed, so a drag that *made* a
   * selection is not also read as a swipe. */
  selection: string;
  /** The browser cancelled the pointer stream; the touch stream finishes it. */
  handedOff: boolean;
}

export function installFocusSwipe(
  host: HTMLElement,
  /** Both are told where the finger landed and on what, so a host can read a
   * swipe from the left of the screen, or one over a list row, as something
   * else. */
  handlers: {
    onSwipeRight: (start: SwipePoint, target: Element | null) => void;
    onSwipeLeft: (start: SwipePoint, target: Element | null) => void;
  },
  /** `ignore`: a selector whose elements never start a swipe — a control
   * that owns its own drag (`touch-action:none`), or a sheet laid over the
   * host that the swipe must not reach through. `leftEdge`: a start at the
   * left edge counts too — a drawer that slides in from there is pulled from
   * there. Where Android keeps that edge for its back gesture it cancels the
   * touch, and a cancelled touch is never a swipe. */
  config: { ignore?: string; leftEdge?: boolean } = {},
): () => void {
  let gesture: Gesture | null = null;

  const begin = (id: number, x: number, y: number, target: EventTarget | null) => {
    const now = Date.now();
    if (gesture && now - gesture.start.t <= SWIPE_MAX_DURATION_MS) {
      // A second finger: a pinch or a two-finger scroll, never a swipe. Both
      // contacts are dropped, so lifting either one fires nothing. A gesture
      // older than a swipe can last is a leftover whose end never arrived.
      gesture = null;
      return;
    }
    gesture = null;
    if ((x < SWIPE_EDGE_GUARD && !config.leftEdge) || x > window.innerWidth - SWIPE_EDGE_GUARD) return;
    const element = elementOf(target);
    if (element?.closest(EDITABLE)) return;
    if (config.ignore && element?.closest(config.ignore)) return;
    gesture = { id, start: { x, y, t: now }, target: element, selection: currentSelection(), handedOff: false };
  };

  const finish = (x: number, y: number) => {
    const current = gesture;
    gesture = null;
    if (!current) return;
    const direction = classifySwipe(current.start, { x, y, t: Date.now() });
    if (!direction) return;
    // Decided at the end, from where the finger landed: whether a code block
    // can still pan is only known once the direction is.
    if (blockedByScroller(current.target, host, direction)) return;
    const selection = currentSelection();
    if (selection && selection !== current.selection) return;
    if (direction === "right") handlers.onSwipeRight(current.start, current.target);
    else handlers.onSwipeLeft(current.start, current.target);
  };

  const touchAt = (touches: TouchList, identifier?: number) => {
    for (let index = 0; index < touches.length; index += 1) {
      const touch = touches[index];
      if (touch && (identifier === undefined || touch.identifier === identifier)) return touch;
    }
    return null;
  };

  const options: AddEventListenerOptions = { capture: true, passive: true };
  const listen = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void) => {
    host.addEventListener(type, listener, options);
    return () => host.removeEventListener(type, listener, true);
  };
  const removers: (() => void)[] = [];

  if ("PointerEvent" in window) {
    // A mouse stays out of it: a desktop drag over the reading view is a text
    // selection, and the strip has its own control there. A pen (the iPad's
    // Pencil) swipes like a finger.
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      begin(event.pointerId, event.clientX, event.clientY, event.target);
    };
    const pointerUp = (event: PointerEvent) => {
      if (!gesture || gesture.handedOff || event.pointerId !== gesture.id) return;
      finish(event.clientX, event.clientY);
    };
    // A phone browser fires `pointercancel` the moment it starts panning a
    // touch-action:auto surface — which on the Focus view is every gesture,
    // since nothing here claims one — and sends no `pointerup` after it. That
    // is not the finger leaving, and Touch Events, which the same browsers
    // keep firing through the pan, still report where it does. So a cancelled
    // pointer hands its gesture to `touchend`; a `touchcancel` (or a browser
    // with no touch stream at all) is a real cancel.
    const touchStream = "ontouchstart" in window || "TouchEvent" in window;
    const pointerCancel = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      if (touchStream) gesture.handedOff = true;
      else gesture = null;
    };
    removers.push(
      listen("pointerdown", pointerDown),
      listen("pointerup", pointerUp),
      listen("pointercancel", pointerCancel),
    );
    if (touchStream) {
      const handedOffEnd = (event: TouchEvent) => {
        if (!gesture?.handedOff || event.touches.length > 0) return;
        const touch = touchAt(event.changedTouches);
        if (touch) finish(touch.clientX, touch.clientY);
        else gesture = null;
      };
      const handedOffCancel = () => {
        if (gesture?.handedOff) gesture = null;
      };
      removers.push(listen("touchend", handedOffEnd), listen("touchcancel", handedOffCancel));
    }
  } else {
    // Older embedded webviews expose only Touch Events.
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        gesture = null;
        return;
      }
      const touch = touchAt(event.changedTouches);
      if (touch) begin(touch.identifier, touch.clientX, touch.clientY, event.target);
    };
    const touchEnd = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = touchAt(event.changedTouches, gesture.id);
      if (touch) finish(touch.clientX, touch.clientY);
    };
    const touchCancel = () => {
      gesture = null;
    };
    removers.push(
      listen("touchstart", touchStart),
      listen("touchend", touchEnd),
      listen("touchcancel", touchCancel),
    );
  }

  return () => {
    gesture = null;
    for (const remove of removers) remove();
  };
}
