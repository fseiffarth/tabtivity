/**
 * Scroll a phone drag through the session.  The emulator carries the desktop
 * tmux window's geometry, so its screen is usually taller *and* wider than the
 * phone's box: a vertical drag pans the box over the rows it hides before it
 * moves the buffer — one continuous gesture over `[scrollback] + [the rows
 * below the fold]` — and a horizontal one pans it over the columns off the
 * right edge.  A session that fits has no overflow to consume and scrolls
 * history from the first pixel, as before.
 *
 * Both axes are driven from here, and `.terminal` is `touch-action:none` to
 * say so.  Handing the horizontal one to the browser's own pan (`pan-x`) read
 * well but did not work: the browser arbitrates a touch-action gesture over
 * the first few pixels, and this handler had already claimed those pixels —
 * it scrolled on the first `pointermove`, before any axis was known, and took
 * pointer capture with it.  A sideways drag was consumed as a stunted vertical
 * scroll and the pan never started; when the browser did win the arbitration
 * it cancelled the pointer mid-drag, which is the vertical scroll that jumps
 * and then stops dead.  Nothing moves now until the drag has committed to an
 * axis, and the axis it commits to is one this file scrolls itself.
 *
 * Pointer Events are the reliable touch stream in current Android/iOS
 * browsers; some older embedded webviews only expose Touch Events, so keep
 * that path as a fallback.
 */
export interface TerminalScroller {
  scrollLines(lines: number): void;
}

const PIXELS_PER_LINE = 14;
/** How far a drag must travel before it commits to an axis. Below it nothing
 * moves at all, so the wobble in a tap stays a tap. */
const AXIS_SLACK = 8;

/** The axis a drag committed to, or "" while it is still under the slack. */
type Axis = "" | "x" | "y";

export function installTerminalTouchScroll(host: HTMLElement, terminal: TerminalScroller) {
  let activeId: number | undefined;
  let axis: Axis = "";
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let remainder = 0;

  /**
   * Moves the box over the emulated screen and returns the pixels it could not
   * take, so a drag that runs out of hidden rows continues into the buffer.
   * `.terminal` is `overflow-y:hidden` — user scrolling is this function, not
   * the browser's — but a hidden box still scrolls programmatically.
   */
  const panRows = (delta: number) => {
    const room = host.scrollHeight - host.clientHeight;
    if (room <= 0) return delta;
    const before = host.scrollTop;
    host.scrollTop = Math.min(room, Math.max(0, before + delta));
    return delta - (host.scrollTop - before);
  };
  /**
   * Pans the box across the desktop-width screen. There is nothing past the
   * last column to continue into, so unlike `panRows` this consumes the drag
   * and stops at the edge. A browser clamps the assignment itself; clamping
   * here keeps the arithmetic the same wherever it runs.
   */
  const panColumns = (delta: number) => {
    const room = host.scrollWidth - host.clientWidth;
    if (room <= 0) return;
    host.scrollLeft = Math.min(room, Math.max(0, host.scrollLeft + delta));
  };
  const begin = (id: number, clientX: number, clientY: number) => {
    if (activeId !== undefined) return false;
    activeId = id;
    startX = clientX;
    startY = clientY;
    lastX = clientX;
    lastY = clientY;
    axis = "";
    remainder = 0;
    return true;
  };
  /** Whether the drag is this handler's; a `true` is swallowed and prevented. */
  const move = (id: number, clientX: number, clientY: number) => {
    if (id !== activeId) return false;
    if (!axis) {
      // Decided once per gesture, and only once the finger has left the slack
      // — the pixels before that belong to no axis and move nothing. The whole
      // delta from the touch-down is applied when it does commit, so the view
      // stays under the finger rather than lagging it by the slack.
      const sideways = Math.abs(clientX - startX);
      const upright = Math.abs(clientY - startY);
      if (sideways <= AXIS_SLACK && upright <= AXIS_SLACK) return true;
      axis = sideways > upright ? "x" : "y";
    }
    if (axis === "x") {
      panColumns(lastX - clientX);
      lastX = clientX;
      lastY = clientY;
      return true;
    }
    remainder += lastY - clientY;
    lastX = clientX;
    lastY = clientY;
    remainder = panRows(remainder);
    const lines = remainder < 0
      ? Math.ceil(remainder / PIXELS_PER_LINE)
      : Math.floor(remainder / PIXELS_PER_LINE);
    if (lines) {
      terminal.scrollLines(lines);
      remainder -= lines * PIXELS_PER_LINE;
    }
    return true;
  };
  const end = (id: number) => {
    if (id !== activeId) return false;
    activeId = undefined;
    axis = "";
    remainder = 0;
    return true;
  };

  const pointerStart = (event: PointerEvent) => {
    // A pen (the iPad's Pencil) drags like a finger; only a mouse is xterm's.
    if (event.pointerType === "mouse") return;
    if (!begin(event.pointerId, event.clientX, event.clientY)) return;
    // Do not let xterm turn this drag into a terminal mouse gesture. Capture
    // waits for the first move: taking the pointer on the down event would
    // claim every tap, including the ones xterm answers itself.
    event.stopPropagation();
  };
  const pointerMove = (event: PointerEvent) => {
    if (!move(event.pointerId, event.clientX, event.clientY)) return;
    host.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const pointerEnd = (event: PointerEvent) => {
    if (!end(event.pointerId)) return;
    if (host.hasPointerCapture?.(event.pointerId)) host.releasePointerCapture?.(event.pointerId);
    event.stopPropagation();
  };

  const touchAt = (touches: TouchList, identifier: number) => {
    for (let index = 0; index < touches.length; index += 1) {
      const touch = touches.item(index);
      if (touch?.identifier === identifier) return touch;
    }
    return null;
  };
  const touchStart = (event: TouchEvent) => {
    const touch = event.changedTouches.item(0);
    if (!touch || !begin(touch.identifier, touch.clientX, touch.clientY)) return;
    event.stopPropagation();
  };
  const touchMove = (event: TouchEvent) => {
    if (activeId === undefined) return;
    const touch = touchAt(event.touches, activeId);
    if (!touch || !move(touch.identifier, touch.clientX, touch.clientY)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const touchEnd = (event: TouchEvent) => {
    if (activeId === undefined || !touchAt(event.changedTouches, activeId)) return;
    end(activeId);
    event.stopPropagation();
  };

  const options: AddEventListenerOptions = { capture: true, passive: false };
  if ("PointerEvent" in window) {
    // A phone fires Touch Events alongside Pointer Events, and stopping the
    // pointer stream does nothing to the touch one. xterm listens for
    // `touchstart`/`touchmove` on its own element and scrolls its viewport by
    // the raw finger delta — so a drag that this handler already turned into
    // `scrollLines` was scrolled a second time by xterm, at a different rate.
    const swallowTouch = (event: TouchEvent) => event.stopPropagation();
    const touchOptions: AddEventListenerOptions = { capture: true, passive: true };
    host.addEventListener("pointerdown", pointerStart, options);
    host.addEventListener("pointermove", pointerMove, options);
    host.addEventListener("pointerup", pointerEnd, options);
    host.addEventListener("pointercancel", pointerEnd, options);
    host.addEventListener("touchstart", swallowTouch, touchOptions);
    host.addEventListener("touchmove", swallowTouch, touchOptions);
    return () => {
      host.removeEventListener("pointerdown", pointerStart, true);
      host.removeEventListener("pointermove", pointerMove, true);
      host.removeEventListener("pointerup", pointerEnd, true);
      host.removeEventListener("pointercancel", pointerEnd, true);
      host.removeEventListener("touchstart", swallowTouch, true);
      host.removeEventListener("touchmove", swallowTouch, true);
    };
  }
  host.addEventListener("touchstart", touchStart, options);
  host.addEventListener("touchmove", touchMove, options);
  host.addEventListener("touchend", touchEnd, options);
  host.addEventListener("touchcancel", touchEnd, options);
  return () => {
    host.removeEventListener("touchstart", touchStart, true);
    host.removeEventListener("touchmove", touchMove, true);
    host.removeEventListener("touchend", touchEnd, true);
    host.removeEventListener("touchcancel", touchEnd, true);
  };
}
