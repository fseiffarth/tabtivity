import { create } from "zustand";

/**
 * Which header hover-menu (Clock, SettingsMenu, LocalModelMenu, Mail/Calendar/Todo
 * indicators, MobileIndicator, VpnIndicator, MachinesIndicator) is open right now — ONE id, shared across all of
 * them. Each menu opens instantly on mouseenter and closes on a deferred timer
 * (`headerMenuCloseDelay`); with independent `useState`s that grace period is what let two
 * adjacent menus render at once — the mouse leaves A (A's timer starts) and
 * enters B (B opens immediately) before A's timer fires. Routing both through
 * one id fixes it structurally: opening B overwrites `openId` in the same
 * frame, so A's derived `open` (`openId === "A"`) flips false immediately
 * instead of waiting out its own timer. `close` is a no-op once a different
 * menu has already claimed `openId`, so a late-firing close from A can never
 * clobber B.
 */
/** The grace a pointer gets on its way from the top bar down into a menu. */
const BAR_LEAVE_GRACE_MS = 250;
/** How far below the bar a leave still counts as "on the way down": one or
 *  two pointer samples of a quick move, which can skip the seam. */
const BAR_LEAVE_SLACK_PX = 24;

/**
 * How long a header hover menu waits after the pointer leaves it before
 * closing. A pointer that left while still in the top bar (or just under it)
 * may be heading down into the list — buttons sit inside the bar and lists are
 * wider than their buttons, so that path can briefly leave the hovered element
 * — and gets the grace. One that left from the open list below the bar is done
 * with it, and the list goes at once. The close stays a timer even at 0, so a
 * `mouseenter` in the same pointer move (into a portaled list, or back onto the
 * wrapper) still cancels it. No event (a non-pointer path) keeps the grace.
 */
export function headerMenuCloseDelay(e?: Pick<MouseEvent, "clientY">): number {
  if (!e) return BAR_LEAVE_GRACE_MS;
  const bar = document.querySelector(".app-header");
  if (!bar) return BAR_LEAVE_GRACE_MS;
  return e.clientY < bar.getBoundingClientRect().bottom + BAR_LEAVE_SLACK_PX ? BAR_LEAVE_GRACE_MS : 0;
}

interface HeaderHoverMenuState {
  openId: string | null;
  open: (id: string) => void;
  close: (id: string) => void;
}

export const useHeaderHoverMenuStore = create<HeaderHoverMenuState>((set) => ({
  openId: null,
  open: (id) => set({ openId: id }),
  close: (id) => set((s) => (s.openId === id ? { openId: null } : s)),
}));
