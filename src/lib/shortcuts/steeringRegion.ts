/**
 * The region cursor of keyboard steering mode: one highlighted control inside a
 * surface that has no tab bar to step through — the side panel, the mail /
 * calendar / to-do views, a pane's + menu, the settings dialog. ↑/↓ walk
 * it, Enter presses it.
 *
 * It is deliberately NOT DOM focus. Focusing a control runs its focus handlers
 * (the header buttons open their menus on focus, a menu closes when focus
 * leaves it), and every key is steering's while the mode is on anyway — so the
 * cursor is a class on the element (`.steer-cursor`) and Enter is a `click()`.
 * DOM focus moves only where the user is about to type: Enter on a text field
 * leaves steering with the caret in it (`activateRegionCursor`).
 *
 * The walk is generic on purpose. What can be pressed is found, not listed:
 * the focusable controls plus anything the stylesheet marks clickable
 * (`cursor: pointer` — tree rows, list rows, chips are divs with an onClick),
 * so a surface needs no steering code of its own to be walkable.
 */
import { experimentalEnabled } from "../experimental";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import type { Settings } from "../../types";
import type { SteeringRegion } from "../../stores/keyboardSteering";
import { steeringInRoot } from "./steeringScope";
import { useRootOverlayStore } from "../../stores/rootOverlay";

const CURSOR_CLASS = "steer-cursor";

/** Controls that are pressable by their nature, whatever their cursor. */
const PRESSABLE =
  'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), ' +
  "select:not(:disabled), textarea:not(:disabled), [contenteditable='true'], " +
  '[tabindex]:not([tabindex="-1"]), [role="button"], [role="tab"], [role="treeitem"], ' +
  '[role="option"], [role="menuitem"], [role="checkbox"], [role="switch"]';

/** The header apps steering can show (views of the console window), and the gate
 *  each one's button has. */
export type SteeringApp = "mail" | "calendar" | "todo";

export function steeringAppEnabled(app: SteeringApp, settings: Settings | null | undefined): boolean {
  switch (app) {
    case "mail":
      return experimentalEnabled(settings, "mail_client");
    case "calendar":
      return settings?.calendar_global_app ?? true;
    case "todo":
      return settings?.todo_board ?? true;
  }
}

let cursor: HTMLElement | null = null;

/** The root window's frame while the chrome region walks it: the cursor then
 *  lands only on the window's own controls (`CHROME_ZONE`), not on the Root
 *  view's terminals or a cockpit view's rows. `regionRoot` sets and clears it
 *  per region, ahead of every use of the root. */
const chromeFrames = new WeakSet<HTMLElement>();
/** The same frame while an app region (mail / calendar / to-do) walks it: the
 *  whole window but its view strip, which is the chrome level's. */
const appFrames = new WeakSet<HTMLElement>();
const APP_SKIP = ".root-view-strip";
/** What the subagents region walks in an agent tab's pane: the Subagents (and
 *  Workspaces) lists in the Chat's top bar, and an open subagent's bar. */
const SUBAGENT_ZONE = ".terminal-reader-subagent-index, .terminal-reader-subagent-bar";
/** The panes the subagents region walks, so `regionTargets` keeps to its zone. */
const subagentFrames = new WeakSet<HTMLElement>();
/** What the chrome level walks: the title bar's view tabs and buttons, and the
 *  rail's fold toggle. */
const CHROME_ZONE = ".root-overlay-bar, .cockpit-rail-expand, .cockpit-rail-collapse";
/** Root's own tab strip sits in the bar too: those tabs are the tab level's. */
const CHROME_SKIP = ".root-overlay-slot .tab-strip, .root-overlay-slot .tab-new-wrap";
const ADD_TAB_SUBMENU = "[data-steer-add-tab-submenu]";

function lastMatch(selector: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(selector);
  return all.length > 0 ? all[all.length - 1] : null;
}

/** The element a region's cursor walks inside, or null while it is not on
 *  screen (the overlay still loading, the panel closed by the pointer). */
export function regionRoot(region: SteeringRegion): HTMLElement | null {
  switch (region) {
    case "cockpit": {
      const frame = document.querySelector<HTMLElement>(".root-console-backdrop > .root-overlay");
      if (frame) { chromeFrames.delete(frame); appFrames.delete(frame); }
      return frame;
    }
    case "side":
      return document.querySelector<HTMLElement>(".side-panel.open");
    case "addTab": {
      const menu = lastMatch(".tab-add-menu");
      const submenus = menu?.querySelectorAll<HTMLElement>(`${ADD_TAB_SUBMENU}:not([data-steer-add-tab-submenu="hover"])`);
      // More and its machine picker are siblings. The deeper one is rendered
      // last. A pointer preview does not take over the keyboard cursor.
      if (submenus) {
        for (let i = submenus.length - 1; i >= 0; i--) {
          if (shown(submenus[i])) return submenus[i];
        }
      }
      return menu;
    }
    case "header":
      return document.querySelector<HTMLElement>(".app-header");
    case "chrome": {
      // The root window's frame, walked only over its chrome (`CHROME_ZONE`).
      const frame = document.querySelector<HTMLElement>(".root-console-backdrop > .root-overlay");
      if (frame) {
        appFrames.delete(frame);
        chromeFrames.add(frame);
      }
      return frame;
    }
    case "card":
      return activeTabCard();
    case "subagents": {
      const frame = activeSubagentFrame();
      if (frame) subagentFrames.add(frame);
      return frame;
    }
    case "overlay": {
      // The same frame, walked whole (a cockpit view opened with U).
      const layer = topLayer();
      if (layer) {
        chromeFrames.delete(layer);
        appFrames.delete(layer);
      }
      return layer;
    }
    case "settings":
      // The page, not the whole dialog: ←/→ step the left-hand list
      // (`stepSettingsPage`), so ↑/↓ need not wade through it.
      return settingsDialog()?.querySelector<HTMLElement>(".settings-panel-content") ?? null;
    default: {
      // The three apps are views of the root console's window: the region
      // walks its frame, minus the view strip (`APP_SKIP`).
      const frame = document.querySelector<HTMLElement>(".root-console-backdrop > .root-overlay");
      if (frame) {
        chromeFrames.delete(frame);
        appFrames.add(frame);
      }
      return frame;
    }
  }
}

/** The settings dialog, while it is open — the one with the page list, not
 *  the other dialogs that borrow its frame (the theme customizer, How to
 *  start, a project's file settings). */
export function settingsDialog(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(".settings-dialog:not(.how-to-start-dialog)"));
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].querySelector(".settings-navigation-links")) return all[i];
  }
  return null;
}

// ── Layers: whatever floats over the window ──────────────────────────────
// Dialogs, the header apps and the root console (all `.modal-backdrop`, most
// with an `aria-modal` frame), right-click menus (`.context-menu`, the shared
// `ContextMenuPortal`), and the top bar's drop-down menus. Steering walks the
// one on top (the "overlay" region) instead of acting behind it.

/** Floating surfaces that sit over the whole window. */
const LAYER =
  ".modal-backdrop, [aria-modal='true'], .context-menu-portal, .context-menu:not(.dropdown-menu)";
/** The top bar's drop-down menus: in the header's own tree, so they come first
 *  in the document — any window-wide layer is above them. */
const HEADER_POPUP =
  ".app-header [role='menu'], .app-header .tab-new-menu, .app-header .project-switcher-add-menu";

function lastShown(selector: string, skip?: (el: HTMLElement) => boolean): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(selector);
  for (let i = all.length - 1; i >= 0; i--) {
    if (shown(all[i]) && !all[i].closest(".steering-legend") && !skip?.(all[i])) return all[i];
  }
  return null;
}

/** The root window itself, while steering's tab levels belong to its Root view
 *  (`steeringScope`): that window is the place being steered, not a layer over
 *  it, so it is not walked as an overlay (a menu or dialog over it still is). */
const rootWindow = (el: HTMLElement) => steeringInRoot() && !!el.closest(".root-console-backdrop");

/** The floating surface on top, or null when the window is bare. Last in the
 *  document wins: a portal opens at the end of <body>, a dialog raised from
 *  inside another sits inside it, and among equal z-indexes the later one
 *  paints on top. */
export function topLayer(): HTMLElement | null {
  return lastShown(LAYER, rootWindow) ?? lastShown(HEADER_POPUP);
}

/** The region that walks `layer`: the surfaces with a region of their own
 *  keep it (settings pages, a header app, the + menu), anything else is the
 *  generic overlay. */
export function regionForLayer(layer: HTMLElement): SteeringRegion {
  const holds = (sel: string) => layer.matches(sel) || !!layer.querySelector(sel);
  const settings = settingsDialog();
  if (settings && layer.contains(settings)) return "settings";
  // The apps are views of the console window: that window, while one of them
  // is the shown view, is the app's region.
  const { open, view } = useRootOverlayStore.getState();
  if (open && (view === "mail" || view === "calendar" || view === "todo") && holds(".root-console-backdrop")) {
    return view;
  }
  if (holds(".tab-add-menu")) return "addTab";
  if (open && !["root", "mail", "calendar", "todo"].includes(view) && holds(".root-console-backdrop")) return "cockpit";
  return "overlay";
}

/** Keys steering sends on the user's behalf (Escape to a dialog, ↓ to a menu
 *  button). Its own listeners let them through. */
const synthetic = new WeakSet<Event>();

export function isSteeringSynthetic(e: Event): boolean {
  return synthetic.has(e);
}

function sendKey(target: HTMLElement, key: string): boolean {
  const e = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
  synthetic.add(e);
  return target.dispatchEvent(e);
}

/** Let the add-tab flyout consume Escape without closing its parent portal. */
export function closeAddTabSubmenu(root: HTMLElement): boolean {
  return root.matches(ADD_TAB_SUBMENU) && !sendKey(root, "Escape");
}

/**
 * Close `layer` the way its own Escape does — the dialog decides (a dirty form
 * may ask first). The key goes to what has focus inside it, else to the layer
 * itself; never to a terminal or text field in it, where Escape is the
 * program's. A layer that ignores Escape and is still up a moment later gets
 * its × pressed, or — a menu — a click beside it; a dialog with neither is
 * left for its Cancel button. `after` runs once that fallback had its turn.
 */
export function dismissLayer(layer: HTMLElement, after?: () => void): void {
  const focused = document.activeElement;
  const target =
    focused instanceof HTMLElement && layer.contains(focused) && !isTextEntry(focused) && !focused.closest(".xterm")
      ? focused
      : layer;
  const needsFallback = sendKey(target, "Escape");
  window.setTimeout(() => {
    if (needsFallback) fallBack();
    if (after) window.setTimeout(after, 0);
  }, 0);
  function fallBack() {
    if (!layer.isConnected || !shown(layer)) return;
    const close = Array.from(layer.querySelectorAll<HTMLElement>(".dialog-close-btn")).find(shown);
    if (close) {
      close.click();
      return;
    }
    if (layer.matches(HEADER_POPUP)) {
      // A top-bar menu steering hovered open has no mouse-leave coming.
      useHeaderHoverMenuStore.setState({ openId: null });
    }
    if (layer.matches(".context-menu, .context-menu-portal, [role='menu'], .tab-new-menu, .project-switcher-add-menu")) {
      const away = document.querySelector<HTMLElement>(".context-menu-catcher") ?? document.body;
      const press = new MouseEvent("pointerdown", { bubbles: true });
      synthetic.add(press);
      away.dispatchEvent(press);
    }
  }
}

/** Drop the menu of the control under the cursor as the pointer would — the
 *  top bar's buttons open theirs on hover (a mouse-over from outside the
 *  window, so the button's wrapper sees it entered), which moves no focus.
 *  False when it has no menu. */
export function openCursorPopup(): boolean {
  const el = regionCursor();
  if (!el?.hasAttribute("aria-haspopup")) return false;
  if (el.getAttribute("aria-expanded") !== "true") {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  }
  return true;
}

/** Right-click `el`: its context menu opens under it, as the pointer would
 *  open it. */
export function openContextMenu(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: r.left + Math.min(12, r.width / 2),
      clientY: r.bottom,
    }),
  );
}

/** The active tab, as its tab bar draws it: the workspace's — not a header app's
 *  or the root console's (they share the subwindow frame) — or, while steering
 *  walks the Root view (`steeringScope`), the one in Root's strip. */
export function activeTabElement(): HTMLElement | null {
  if (steeringInRoot()) {
    const within = (selector: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector));
    // A split layout draws a strip per subwindow (inside `.root-overlay-group`):
    // the focused one's active tab. Unsplit, the one strip sits in the window's
    // bar, outside any group. (A single selector for both would also match
    // every other subwindow's active tab, and the first in the document wins.)
    const inFocusedGroup = within(".root-console-backdrop .root-overlay-group.focused .tab.active").find(shown);
    if (inFocusedGroup) return inFocusedGroup;
    return (
      within(".root-console-backdrop .tab-strip .tab.active:not(.root-view-tab)").find(
        (el) => shown(el) && !el.closest(".root-overlay-group"),
      ) ?? null
    );
  }
  const all = Array.from(document.querySelectorAll<HTMLElement>(".subwindow.focused .tab.active"));
  return all.find((el) => shown(el) && !el.closest(".root-overlay")) ?? null;
}

/** The card floating over the active tab's terminal — Undo clear, a sign-in
 *  link, a CLI update notice (`TerminalSignInCard` and its siblings, all in
 *  its frame); only the active tab's pane is on screen. */
export function activeTabCard(): HTMLElement | null {
  if (steeringInRoot()) {
    return Array.from(document.querySelectorAll<HTMLElement>(".root-console-backdrop .terminal-sign-in")).find(shown) ?? null;
  }
  const all = Array.from(document.querySelectorAll<HTMLElement>(".subwindow.focused .terminal-sign-in"));
  return all.find((el) => shown(el) && !el.closest(".root-overlay")) ?? null;
}

/** The active agent tab's Subagents toggle, or its open subagent's bar —
 *  whichever is on screen first; only the active tab's pane is. */
function activeSubagentControl(): HTMLElement | null {
  const controls = ".terminal-reader-subagent-toggle, .terminal-reader-subagent-bar";
  if (steeringInRoot()) {
    return Array.from(document.querySelectorAll<HTMLElement>(`.root-console-backdrop :is(${controls})`)).find(shown) ?? null;
  }
  const all = Array.from(document.querySelectorAll<HTMLElement>(`.subwindow.focused :is(${controls})`));
  return all.find((el) => shown(el) && !el.closest(".root-overlay")) ?? null;
}

/** The pane the subagents region walks: the one holding both the Chat's top bar
 *  (the Subagents list) and the Chat (an open subagent's bar). Null while the
 *  active tab shows neither — no agent tab, the Terminal view, no subagents. */
export function activeSubagentFrame(): HTMLElement | null {
  let pane = activeSubagentControl()?.parentElement ?? null;
  while (pane && !pane.querySelector(".terminal-reader")) pane = pane.parentElement;
  return pane;
}

/** Open the pane's Subagents list unless a subagent is open (its bar is then
 *  what the region walks first). True when it pressed the toggle: the list
 *  draws after this event, not yet. */
export function openSubagentList(frame: HTMLElement): boolean {
  if (frame.querySelector(".terminal-reader-subagent-bar:not(.terminal-reader-chat-bar)")) return false;
  const toggle = Array.from(frame.querySelectorAll<HTMLElement>(".terminal-reader-subagent-toggle")).find(shown);
  if (!toggle || toggle.getAttribute("aria-expanded") === "true") return false;
  toggle.click();
  return true;
}

/** Close whichever of the pane's lists is open. */
export function closeSubagentList(frame: HTMLElement): void {
  frame.querySelector<HTMLElement>('.terminal-reader-subagent-toggle[aria-expanded="true"]')?.click();
}

/** The subagents region's first stop: an open list's first subagent (the ones
 *  at work head it), else an open subagent's Back, else the Subagents toggle. */
export function placeSubagentCursor(frame: HTMLElement): boolean {
  if (cursor?.isConnected && frame.contains(cursor) && regionTargets(frame).includes(cursor)) return true;
  const first =
    frame.querySelector<HTMLElement>(".terminal-reader-subagent-list button:not(:disabled)") ??
    frame.querySelector<HTMLElement>(".terminal-reader-subagent-bar .terminal-reader-subagent-nav:not(:disabled)");
  return (first && pointRegionCursor(frame, first)) || placeRegionCursor(frame);
}

/** The current project's pill (or box chip) in the header. */
export function activeProjectElement(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(".project-pill.active, .box-chip.active")).find(shown) ?? null;
}

/** Scroll `root`'s first scrolling box by part of its height — for a surface
 *  with nothing to press but text to read (the shortcut cheat sheet). False
 *  when nothing in it scrolls. */
export function scrollRegion(root: HTMLElement, delta: 1 | -1): boolean {
  const boxes = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  const box = boxes.find(
    (el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY),
  );
  if (!box) return false;
  box.scrollTop += delta * Math.max(40, Math.round(box.clientHeight * 0.4));
  return true;
}

/** Whether `root` has anything to press besides its ×. */
export function regionHasControls(root: HTMLElement): boolean {
  return regionTargets(root).some((el) => !el.matches(".dialog-close-btn"));
}

const LAYER_CLASS = "steer-layer";
let markedLayer: HTMLElement | null = null;

/** Frame the surface the overlay region walks (the dialog inside a backdrop,
 *  else the layer itself); null clears it. */
export function markLayer(layer: HTMLElement | null) {
  const frame =
    layer?.matches(".modal-backdrop") && layer.firstElementChild instanceof HTMLElement
      ? layer.firstElementChild
      : layer;
  if (frame === markedLayer) return;
  markedLayer?.classList.remove(LAYER_CLASS);
  markedLayer = frame;
  frame?.classList.add(LAYER_CLASS);
}

/** Open the previous / next page of the settings dialog's left-hand list
 *  (the search narrows it, and so what this steps through). False when there
 *  is no other page to go to. */
export function stepSettingsPage(delta: 1 | -1): boolean {
  const pages = Array.from(
    settingsDialog()?.querySelectorAll<HTMLElement>(".settings-navigation-links button") ?? [],
  );
  if (pages.length === 0) return false;
  const at = pages.findIndex((el) => el.matches('[aria-current]:not([aria-current="false"])'));
  const next = at < 0 ? (delta > 0 ? 0 : pages.length - 1) : (at + delta + pages.length) % pages.length;
  if (next === at) return false;
  pages[next].click();
  return true;
}

function shown(el: HTMLElement): boolean {
  if (el.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function pointerish(el: Element): boolean {
  return getComputedStyle(el).cursor === "pointer";
}

/** Never under the cursor: the project pills (the projects level walks them —
 *  the top bar's walk would wade through every one) and the window's own
 *  minimize / maximize / close buttons. */
const NOT_A_TARGET = ".app-header .project-pill, .wm-controls";

/** Everything in `root` the cursor can land on, in document order. A clickable
 *  row counts once — its label spans inherit `cursor: pointer` but are not
 *  targets of their own — while a real control nested in it (a row's × button)
 *  is one. */
export function regionTargets(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const chrome = chromeFrames.has(root);
  const app = appFrames.has(root);
  const subagents = subagentFrames.has(root);
  const addTab = root.matches(".tab-add-menu");
  // Every element's cursor is read once: a parent comes before its children
  // in document order, so its answer is already here when they ask. (The mail
  // overlay is thousands of elements; each step walks them all.)
  const pointer = new Map<Element, boolean>();
  const pointerOf = (el: Element) => {
    let is = pointer.get(el);
    if (is === undefined) {
      is = pointerish(el);
      pointer.set(el, is);
    }
    return is;
  };
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (el.closest(NOT_A_TARGET)) continue;
    if (addTab && el.closest(ADD_TAB_SUBMENU)) continue;
    if (chrome && (!el.closest(CHROME_ZONE) || el.closest(CHROME_SKIP))) continue;
    if (app && el.closest(APP_SKIP)) continue;
    if (subagents && !el.closest(SUBAGENT_ZONE)) continue;
    const pressable = el.matches(PRESSABLE);
    if (!pressable) {
      if (!pointerOf(el)) continue;
      const parent = el.parentElement;
      if (parent && parent !== root && root.contains(parent) && pointerOf(parent)) continue;
    }
    if (shown(el)) out.push(el);
  }
  return out;
}

/** Where the cursor last was on each surface, so coming back to one (a dialog
 *  opened from it closed, a menu picked) lands where it left. */
let lastCursorIn = new WeakMap<HTMLElement, HTMLElement>();

function setCursor(el: HTMLElement | null, root?: HTMLElement) {
  if (el && root) lastCursorIn.set(root, el);
  if (cursor === el) {
    // A re-render that rewrote the element's `className` dropped the class.
    if (el && !el.classList.contains(CURSOR_CLASS)) el.classList.add(CURSOR_CLASS);
    return;
  }
  cursor?.classList.remove(CURSOR_CLASS);
  cursor = el;
  if (!el) return;
  el.classList.add(CURSOR_CLASS);
  el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

export function clearRegionCursor() {
  setCursor(null);
}

/** Put the cursor on `el` (a target of `root`) and remember it there — for a
 *  surface that steers itself (`steeringSidePanel`). */
export function setRegionCursor(el: HTMLElement, root: HTMLElement) {
  setCursor(el, root);
}

/** Where the cursor last was on `root`, if that control is still on screen. */
export function rememberedCursor(root: HTMLElement): HTMLElement | null {
  const back = lastCursorIn.get(root);
  return back?.isConnected && root.contains(back) ? back : null;
}

/** Forget every surface's last cursor (tests). */
export function forgetRegionCursors() {
  lastCursorIn = new WeakMap();
}

/** Put the cursor back where it last was on `root`, if that control is still
 *  there; else as `placeRegionCursor` does. */
export function resumeRegionCursor(root: HTMLElement): boolean {
  const back = lastCursorIn.get(root);
  if (back?.isConnected && root.contains(back) && regionTargets(root).includes(back)) {
    setCursor(back, root);
    return true;
  }
  return placeRegionCursor(root);
}

/** Put the cursor on the control of `root` the pointer just pressed — the
 *  innermost target holding `el`. False when it pressed none. */
export function pointRegionCursor(root: HTMLElement, el: Element): boolean {
  let hit: HTMLElement | null = null;
  // Document order: a target nested in another comes after it.
  for (const target of regionTargets(root)) if (target.contains(el)) hit = target;
  if (!hit) return false;
  setCursor(hit, root);
  return true;
}

/** The element under the cursor, if it is still on screen. */
export function regionCursor(): HTMLElement | null {
  return cursor?.isConnected ? cursor : null;
}

/** Put the cursor on `root`'s selected control (the active view tab, the open
 *  message, a dialog's `data-steering-default` button), else its first one.
 *  False when there is nothing to land on yet. */
export function placeRegionCursor(root: HTMLElement): boolean {
  if (cursor?.isConnected && root.contains(cursor)) return true;
  const targets = regionTargets(root);
  if (targets.length === 0) return false;
  const selected = targets.find((el) =>
    el.matches('[aria-selected="true"], [aria-current]:not([aria-current="false"]), .selected, [data-steering-default]'),
  );
  // Never land on a dialog's × first: Enter there would close what was just
  // opened.
  setCursor(selected ?? targets.find((el) => !el.matches(".dialog-close-btn")) ?? targets[0], root);
  return true;
}

/** Step the cursor through `root`'s targets, wrapping. A cursor that fell off
 *  the page (its row re-rendered away) restarts at the near end. */
export function moveRegionCursor(root: HTMLElement, delta: 1 | -1): void {
  const targets = regionTargets(root);
  if (targets.length === 0) {
    setCursor(null);
    return;
  }
  const at = cursor ? targets.indexOf(cursor) : -1;
  const next =
    at < 0
      ? delta > 0
        ? 0
        : targets.length - 1
      : (at + delta + targets.length) % targets.length;
  setCursor(targets[next], root);
}

/** Whether `b` sits on `a`'s line: nested in it (a row's own buttons), or
 *  overlapping it vertically (a toolbar's). */
function sameLine(a: HTMLElement, b: HTMLElement): boolean {
  if (a.contains(b) || b.contains(a)) return true;
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  return Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 1;
}

/** `targets` cut into lines: runs, in document order, that share their first
 *  target's line. */
export function regionLines(targets: HTMLElement[]): HTMLElement[][] {
  const lines: HTMLElement[][] = [];
  for (const el of targets) {
    const line = lines[lines.length - 1];
    if (line && sameLine(line[0], el)) line.push(el);
    else lines.push([el]);
  }
  return lines;
}

/** Step the cursor a whole line, wrapping — onto the next row, not through
 *  the buttons beside it or inside it (←/→ still walk those). The cursor lands
 *  on the line's first target: the row itself, a toolbar's first button. */
export function moveRegionCursorByLine(root: HTMLElement, delta: 1 | -1): void {
  const lines = regionLines(regionTargets(root));
  if (lines.length === 0) {
    setCursor(null);
    return;
  }
  const current = cursor;
  const at = current ? lines.findIndex((line) => line.includes(current)) : -1;
  const next =
    at < 0 ? (delta > 0 ? 0 : lines.length - 1) : (at + delta + lines.length) % lines.length;
  setCursor(lines[next][0], root);
}

function isTextEntry(el: HTMLElement): boolean {
  if (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true;
  }
  if (!(el instanceof HTMLInputElement)) return false;
  return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"].includes(
    el.type,
  );
}

/**
 * Press the control under the cursor. "type" — it takes text, so it now has
 * DOM focus and the caller leaves steering for the user to type; "press" — it
 * was clicked; "open" — it was double-clicked; null — no cursor.
 */
/** `root`'s first shown text field — the + menu's filter, a search box. */
export function regionSearchField(root: HTMLElement): HTMLElement | null {
  return regionTargets(root).find(isTextEntry) ?? null;
}

/** Hand `root`'s first text field the caret (steering's `/`). False when the
 *  surface has none. */
export function focusRegionSearch(root: HTMLElement): boolean {
  const field = regionSearchField(root);
  if (!field) return false;
  setCursor(null);
  field.focus();
  return true;
}

/** Close a dropdown list open in `root` (Enter opened it), the cursor back on
 *  its trigger — what Escape does before it leaves the surface. False when
 *  none is open. */
export function closeRegionDropdown(root: HTMLElement): boolean {
  const trigger = root.querySelector<HTMLElement>('.dropdown-trigger[aria-expanded="true"]');
  if (!trigger) return false;
  trigger.click();
  setCursor(trigger);
  return true;
}

export function activateRegionCursor(): "type" | "press" | "open" | null {
  const el = regionCursor();
  if (!el) return null;
  if (isTextEntry(el) || (el instanceof HTMLInputElement && el.type === "range")) {
    setCursor(null);
    el.focus();
    return "type";
  }
  // A row that opens on a double-click (a file in the tree) is opened as the
  // pointer does: with that event, since a click only selects it. No modifier
  // rides along — Shift would send the file to the OS default app.
  if (el.matches('[data-steer-open="dblclick"]')) {
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
    return "open";
  }
  // A dropdown option closes its list, taking the cursor with it: hand the
  // cursor back to the dropdown, so the next ↑/↓ goes on from there.
  const trigger =
    el.getAttribute("role") === "option"
      ? el.closest(".dropdown")?.querySelector<HTMLElement>(".dropdown-trigger")
      : null;
  el.click();
  if (trigger) setCursor(trigger);
  return "press";
}
