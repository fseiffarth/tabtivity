/**
 * The DOM side of keyboard steering, as plain functions with no React and no
 * layout call (jsdom has none, and the oldest targets lack `checkVisibility`).
 * The cursor is real focus: a row is a `[data-steer-row="<id>"]` element, and
 * moving the cursor focuses it. Rules 7-10 of the plan's "Engine rules".
 */
import { focusables } from "../modalFocus";
import { typingField } from "./phoneSteeringKeys";

/** Surfaces that own their keys: the engine passes every key through while one is on top. The markup view carries `outbox-viewer`. */
export const OWN_KEYS_SELECTOR = ".files-library, .outbox-viewer";

/** Row-local acts a button can carry as `data-steer-act`. */
export type SteerAct = "new" | "close" | "menu";

const HIDDEN_ANCESTOR = "[hidden], [inert], [aria-hidden='true']";

/** Whether an element can be reached: connected, not `disabled`, not inside a hidden, inert or aria-hidden subtree, and not clipped by `checkVisibility`. */
export function isReachable(el: Element): boolean {
  if (!el.isConnected || el.closest(HIDDEN_ANCESTOR)) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === "function" ? check.call(el) : true;
}

/** The last connected `aria-modal="true"` element that is not inert: the surface keys belong to, or null. */
export function topModal(): HTMLElement | null {
  const modals = [...document.querySelectorAll<HTMLElement>("[aria-modal='true']")];
  for (let i = modals.length - 1; i >= 0; i--) {
    if (modals[i].isConnected && !modals[i].closest("[inert]")) return modals[i];
  }
  return null;
}

/**
 * Whether an own-keys surface (the files library, a viewer, Mark up) is the top
 * one: a visible, non-inert one exists and no other modal is on top of it. A
 * sheet opened over it makes the sheet the top modal and its surface inert, so
 * it is walked as a region instead. A paned surface is `aria-modal="false"`.
 */
export function ownKeysUp(): boolean {
  const surfaces = [...document.querySelectorAll<HTMLElement>(OWN_KEYS_SELECTOR)].filter(isReachable);
  if (surfaces.length === 0) return false;
  const modal = topModal();
  return modal === null || surfaces.some((surface) => surface === modal || surface.contains(modal));
}

/** The steering rows under `root`, in document order, skipping unreachable ones. */
export function rows(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-steer-row]")].filter(isReachable);
}

/** The id a row carries. */
export function rowId(el: Element): string {
  return el.getAttribute("data-steer-row") ?? "";
}

/** The row with that id among the reachable ones, or null. */
export function rowById(id: string, root: ParentNode = document): HTMLElement | null {
  return rows(root).find((row) => rowId(row) === id) ?? null;
}

/**
 * The index of the row the cursor stands on: `from` itself, or the one row held
 * by the nearest ancestor of `from` that holds exactly one (focus on a card's
 * own ⋯ button counts as that card's row). An ancestor holding several is the
 * list itself, which stops the search. -1 when none.
 */
function indexOfCursor(list: readonly HTMLElement[], from: Element | null): number {
  if (!from) return -1;
  const direct = list.indexOf(from as HTMLElement);
  if (direct >= 0) return direct;
  for (let node: Element | null = from; node; node = node.parentElement) {
    const held = list.filter((row) => node!.contains(row));
    if (held.length === 1) return list.indexOf(held[0]);
    if (held.length > 1) return -1;
  }
  return -1;
}

/** The row `dir` steps from `from`, wrapping at both ends. With no cursor, 1 gives the first row and -1 the last; null for an empty list. */
export function walk(list: readonly HTMLElement[], dir: 1 | -1, from: Element | null): HTMLElement | null {
  if (list.length === 0) return null;
  const at = indexOfCursor(list, from);
  if (at < 0) return dir > 0 ? list[0] : list[list.length - 1];
  return list[(at + dir + list.length) % list.length];
}

/** Moves the cursor: focus without scrolling, then bring the element into view the cheapest way. */
export function focusRow(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: "nearest" });
}

/** What the cursor can stand on inside a sheet or a section's screen, in document order. */
export function controls(modal: HTMLElement): HTMLElement[] {
  return focusables(modal).filter(isReachable);
}

/** Presses a control: a text field takes the caret instead (typing starts there), anything else is clicked. */
export function press(el: HTMLElement): "clicked" | "focused" {
  if (typingField(el) === el) {
    el.focus({ preventScroll: true });
    return "focused";
  }
  el.click();
  return "clicked";
}

function actButton(scope: ParentNode, act: SteerAct): HTMLElement | null {
  return [...scope.querySelectorAll<HTMLElement>(`[data-steer-act='${act}']`)].find(isReachable) ?? null;
}

/** Clicks the `act` button of the card holding row `id` (`.tab-card`, `.home-project-card`); false when the card or marker is missing. */
export function rowAct(id: string, act: SteerAct): boolean {
  const card = rowById(id)?.closest(".tab-card, .home-project-card");
  const button = card ? actButton(card, act) : null;
  button?.click();
  return button !== null;
}

/** Clicks the screen's own `act` button (the + FAB, Home's new-project); false when there is none. */
export function screenAct(act: SteerAct): boolean {
  const button = actButton(document, act);
  button?.click();
  return button !== null;
}

/** What ↑/↓ scroll inside a tab: the chat's `[data-steer-scroll]`, else the visible terminal's `.xterm-viewport`. */
export function scrollTarget(): HTMLElement | null {
  const find = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find(isReachable) ?? null;
  return find("[data-steer-scroll]") ?? find(".xterm-viewport");
}

/** Scrolls the target by a third of its height (a page: nine tenths). Writes `scrollTop`; false when there is no target. */
export function scrollStep(dir: 1 | -1, page = false): boolean {
  const el = scrollTarget();
  if (!el) return false;
  const h = el.clientHeight;
  el.scrollTop += dir * (page ? Math.max(96, 0.9 * h) : Math.max(48, h / 3));
  return true;
}

/** Jumps the target to its end (the chat's latest message); false when there is no target. */
export function toLatest(): boolean {
  const el = scrollTarget();
  if (!el) return false;
  el.scrollTop = el.scrollHeight;
  return true;
}
