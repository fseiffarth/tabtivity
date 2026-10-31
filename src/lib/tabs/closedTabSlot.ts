import { useLayoutEffect, type RefObject } from "react";

/**
 * Closing tabs with the mouse: the tab that takes the closed one's place ends
 * with its × where the closed tab's × was, so the next close needs no aiming.
 *
 * Tabs are as wide as their labels, so nothing lines up by itself. The heir is
 * sized to reach that spot (its label stretches or is cut) and stays so until
 * the pointer leaves the strip, the tab set changes or another tab turns
 * current. A strip scrolled to its end would also lose scroll position with the
 * closed tab, so the width it lost stays as slack behind the last tab (the
 * strip's `::after`).
 *
 * The × notes the tab it closes (`noteTabClose`) and the strip's layout effect
 * acts once the tab is gone (`useClosedTabSlot`): a popout's close comes back
 * from the main window, so the two are not always one commit.
 */

/** A close that took longer than this (a dialog asked first) moves nothing. */
const NOTE_TTL_MS = 1000;

interface ClosedTab {
  tab: HTMLElement;
  /** What follows it, or what precedes it when it was the last. */
  heir: Element | null;
  closeX: number;
  scrollLeft: number;
  scrollWidth: number;
  at: number;
}

const notes = new WeakMap<HTMLElement, ClosedTab>();
const holds = new WeakMap<HTMLElement, () => void>();

function centerOf(el: Element): number {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
}

/** Call from a tab's × just before it closes the tab. */
export function noteTabClose(closeButton: HTMLElement): void {
  const tab = closeButton.closest<HTMLElement>(".tab");
  const strip = tab?.closest<HTMLElement>(".tab-strip");
  if (!tab || !strip) return;
  notes.set(strip, {
    tab,
    heir: tab.nextElementSibling ?? tab.previousElementSibling,
    closeX: centerOf(closeButton),
    scrollLeft: strip.scrollLeft,
    scrollWidth: strip.scrollWidth,
    at: Date.now(),
  });
}

function hold(strip: HTMLElement, { heir, closeX, scrollLeft, scrollWidth }: ClosedTab): void {
  // A tab-group chip has no × of its own.
  const close = heir?.querySelector(".tab-close");
  if (!(heir instanceof HTMLElement) || !heir.isConnected || !close) return;
  // Measured against the scrolled content: the removal may have clamped the
  // scroll position, which the slack below gives back.
  const drift = closeX + scrollLeft - (centerOf(close) + strip.scrollLeft);
  // An attribute, not a class: React rewrites `className` on every status change.
  heir.dataset.slotHeld = "";
  heir.style.width = `${heir.getBoundingClientRect().width + drift}px`;
  // Only the label gives way: never squeeze a tab past its badges and ×.
  if (heir.scrollWidth > heir.clientWidth + 1) heir.style.width = `${heir.scrollWidth}px`;
  if (scrollLeft > 0) {
    strip.style.setProperty("--tab-slot-slack", `${Math.max(0, scrollWidth - strip.scrollWidth)}px`);
    strip.scrollLeft = scrollLeft;
  }
  const release = () => {
    strip.removeEventListener("pointerleave", release);
    holds.delete(strip);
    delete heir.dataset.slotHeld;
    heir.style.removeProperty("width");
    strip.style.removeProperty("--tab-slot-slack");
  };
  strip.addEventListener("pointerleave", release);
  holds.set(strip, release);
}

/** Whether the strip keeps a heir under the pointer: nothing may scroll it now. */
export function closedTabSlotHeld(strip: HTMLElement): boolean {
  return holds.has(strip);
}

/** Runs after every commit that changes the strip's `revision`. */
export function settleClosedTabSlot(strip: HTMLElement | null): void {
  if (!strip) return;
  holds.get(strip)?.();
  const note = notes.get(strip);
  if (!note || note.tab.isConnected) return;
  notes.delete(strip);
  // The pointer is on the strip only for a close made there: not for one the
  // keyboard pressed, nor after a dialog drew it away.
  if (Date.now() - note.at <= NOTE_TTL_MS && strip.matches(":hover")) hold(strip, note);
}

/**
 * Holds a closed tab's slot in the strip. `revision` names the strip's tab set
 * and its current tab, so a later switch ends the hold and may scroll again.
 */
export function useClosedTabSlot(strip: RefObject<HTMLElement | null>, revision: string): void {
  useLayoutEffect(() => {
    settleClosedTabSlot(strip.current);
  }, [strip, revision]);
}
