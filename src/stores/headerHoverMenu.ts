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

/** The pointer's last step, from one passive listener started with the first
 *  open: which way a pointer was going when it left a menu. */
const step = { x: NaN, y: NaN, dx: 0, dy: 0 };
let tracking = false;
function trackPointer() {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  window.addEventListener(
    "pointermove",
    (e) => {
      if (!Number.isNaN(step.x) && (e.clientX !== step.x || e.clientY !== step.y)) {
        step.dx = e.clientX - step.x;
        step.dy = e.clientY - step.y;
      }
      step.x = e.clientX;
      step.y = e.clientY;
    },
    { capture: true, passive: true },
  );
}

/** Mostly sideways or upward: running along the bar to the next icon, not down
 *  into this one's list. An unknown direction counts as heading down. */
function goingAlongBar(): boolean {
  if (step.dx === 0 && step.dy === 0) return false;
  return step.dy <= 0 || 2 * step.dy < Math.abs(step.dx);
}

/**
 * How long a header hover menu waits after the pointer leaves it before
 * closing. A pointer that left heading down, in the top bar or just under it,
 * may be on its way into the list — buttons sit inside the bar and lists are
 * wider than their buttons, so that path can briefly leave the hovered element
 * — and gets the grace. One running along the bar (to a gap, a readout, the
 * chevron) is going to the next icon, and one that left from the open list
 * below the bar is done with it: both close at once, so a sideways sweep over
 * the bar never leaves the last menu hanging. The close stays a timer even at
 * 0, so a `mouseenter` in the same pointer move (into a portaled list, or back
 * onto the wrapper) still cancels it. No event (a non-pointer path) keeps the
 * grace.
 */
export function headerMenuCloseDelay(e?: Pick<MouseEvent, "clientY">): number {
  if (!e) return BAR_LEAVE_GRACE_MS;
  const bar = document.querySelector(".app-header");
  if (!bar) return BAR_LEAVE_GRACE_MS;
  const bottom = bar.getBoundingClientRect().bottom;
  if (e.clientY >= bottom + BAR_LEAVE_SLACK_PX) return 0;
  return e.clientY < bottom && goingAlongBar() ? 0 : BAR_LEAVE_GRACE_MS;
}

interface HeaderHoverMenuState {
  openId: string | null;
  open: (id: string) => void;
  close: (id: string) => void;
  /** An icon drag is under way (`HeaderSlot`): the open menu closes and none
   *  opens until it ends, so the menus the pointer crosses stay shut. */
  held: boolean;
  hold: (held: boolean) => void;
}

export const useHeaderHoverMenuStore = create<HeaderHoverMenuState>((set) => ({
  openId: null,
  open: (id) => {
    trackPointer();
    set((s) => (s.held ? s : { openId: id }));
  },
  close: (id) => set((s) => (s.openId === id ? { openId: null } : s)),
  held: false,
  hold: (held) => set(held ? { held, openId: null } : { held }),
}));
