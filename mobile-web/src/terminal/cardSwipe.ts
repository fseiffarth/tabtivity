/**
 * The project screen's swipe-to-close, as a drag: a card (`data-swipe-close`)
 * follows the finger leftwards, fading as it goes, and on release either
 * leaves (far enough, or a quick flick) or springs back. Lifting early is how
 * a swipe is called off. It is the one place that moves a card by hand; the
 * exit itself (slide, collapse) is `.tab-card.swiped-out`, which the host
 * applies once `onClose` takes the card.
 *
 * Cards declare `touch-action:pan-y`, so the browser keeps the vertical scroll
 * and hands every sideways move to this listener instead of cancelling the
 * pointer. Only touch and pen drag; a rightward move is left to the files
 * drawer's own swipe (`focusSwipe.ts`).
 */

/** Sideways travel that decides the gesture is a drag and not a tap or a scroll. */
export const CARD_DRAG_SLOP = 10;
/** A drag counts only while it is clearly more sideways than vertical. */
export const CARD_DRAG_AXIS_RATIO = 1.5;
/** Past this share of the card's width, letting go closes it. */
export const CARD_CLOSE_SHARE = 0.4;
/** A quick flick closes it from here, however short. */
export const CARD_FLICK_MIN = 56;
export const CARD_FLICK_MAX_MS = 350;

/** Pure: whether letting go at `dx` (negative = leftwards) closes the card. */
export function cardSwipeCloses(dx: number, width: number, ms: number): boolean {
  const travel = -dx;
  if (travel <= 0) return false;
  return travel >= width * CARD_CLOSE_SHARE || (travel >= CARD_FLICK_MIN && ms <= CARD_FLICK_MAX_MS);
}

/** Pure: how opaque the card is at `dx` — it thins out as it leaves. */
export function cardDragOpacity(dx: number, width: number): number {
  if (width <= 0) return 1;
  return Math.max(0.25, 1 - Math.min(1, -dx / width) * 0.75);
}

const IGNORE = ".tab-card-grip, .sheet-backdrop, [role='dialog'], input, textarea, select";

/** Hand the card back to its stylesheet: the class then decides where it is. */
export function clearCardDrag(card: HTMLElement) {
  card.style.transition = "";
  card.style.transform = "";
  card.style.opacity = "";
}

interface Drag {
  id: number;
  card: HTMLElement;
  x: number;
  y: number;
  t: number;
  width: number;
  /** "pending" until the finger has moved enough to say which way it goes. */
  mode: "pending" | "drag" | "ignore";
  dx: number;
}

export function installCardSwipe(
  host: HTMLElement,
  /** Takes the card (true) or refuses it (false: another close is in flight). */
  onClose: (card: HTMLElement) => boolean,
): () => void {
  if (!("PointerEvent" in window)) return () => {};
  let drag: Drag | null = null;
  /** The click a finished drag would otherwise fire on the card's opener. */
  let swallowClickUntil = 0;

  const settle = (current: Drag, close: boolean) => {
    const { card } = current;
    card.style.transition = "";
    if (close && onClose(card)) {
      card.style.transform = "translateX(-100%)";
      card.style.opacity = "0";
    } else clearCardDrag(card);
  };

  const down = (event: PointerEvent) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    if (drag) { drag = null; return; }
    const target = event.target as Element | null;
    if (!target || target.closest(IGNORE)) return;
    const card = target.closest<HTMLElement>("[data-swipe-close]");
    if (!card || card.classList.contains("swiped-out")) return;
    drag = { id: event.pointerId, card, x: event.clientX, y: event.clientY, t: Date.now(), width: card.getBoundingClientRect().width, mode: "pending", dx: 0 };
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id || drag.mode === "ignore") return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (drag.mode === "pending") {
      if (Math.abs(dx) < CARD_DRAG_SLOP && Math.abs(dy) < CARD_DRAG_SLOP) return;
      // Rightwards belongs to the drawer; a mostly vertical move is a scroll.
      if (dx >= 0 || Math.abs(dx) < CARD_DRAG_AXIS_RATIO * Math.abs(dy)) { drag.mode = "ignore"; return; }
      drag.mode = "drag";
      drag.card.style.transition = "none";
      try { drag.card.setPointerCapture(event.pointerId); } catch { /* the pointer already ended */ }
    }
    // Leftwards only: pulling back past where it started stops at the start.
    drag.dx = Math.min(0, dx);
    drag.card.style.transform = `translateX(${drag.dx}px)`;
    drag.card.style.opacity = String(cardDragOpacity(drag.dx, drag.width));
  };
  const up = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const current = drag;
    drag = null;
    if (current.mode !== "drag") return;
    swallowClickUntil = Date.now() + 400;
    settle(current, cardSwipeCloses(current.dx, current.width, Date.now() - current.t));
  };
  const cancel = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const current = drag;
    drag = null;
    if (current.mode === "drag") settle(current, false);
  };
  const click = (event: MouseEvent) => {
    if (Date.now() > swallowClickUntil) return;
    swallowClickUntil = 0;
    event.stopPropagation();
    event.preventDefault();
  };

  const options: AddEventListenerOptions = { capture: true };
  host.addEventListener("pointerdown", down, options);
  host.addEventListener("pointermove", move, options);
  host.addEventListener("pointerup", up, options);
  host.addEventListener("pointercancel", cancel, options);
  host.addEventListener("click", click, options);
  return () => {
    host.removeEventListener("pointerdown", down, options);
    host.removeEventListener("pointermove", move, options);
    host.removeEventListener("pointerup", up, options);
    host.removeEventListener("pointercancel", cancel, options);
    host.removeEventListener("click", click, options);
    if (drag?.mode === "drag") clearCardDrag(drag.card);
  };
}
