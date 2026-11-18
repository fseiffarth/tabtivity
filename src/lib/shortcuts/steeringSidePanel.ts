/**
 * Steering's keys inside the side panel (the `side` region): rows first. The
 * generic region cursor (`steeringRegion`) walks any surface as one flat list;
 * the panel is a head (header, view tabs, actions, the tree's breadcrumb) over
 * a list, so its keys are these instead:
 *
 *   ↑/↓            one line (Shift: a screenful), no wrap, from the view tabs
 *                  up through the head and down through the whole list
 *   ←/→            on the view tabs: the previous / next view; on a folder row →
 *                  opens it and ← on a tree row goes to the parent, the cursor
 *                  on the folder just left; elsewhere along the line's targets
 *   1–9            the Nth view tab (the user's slot bindings), cursor into its
 *                  list
 *   Enter          on a file row: opens it as a double-click does, and steering
 *                  goes to its tab (Shift+Enter stays in the panel); on a
 *                  folder row: opens the folder, as → does
 *
 * The cursor is a CSS class, never DOM focus (`steeringRegion`). Views are
 * switched by pressing the panel's own tab buttons, so what a scope offers
 * (`sidePanelViews`) decides what these keys reach. A press that needs the
 * panel to catch up (a folder loading, a view mounting) retries on a short
 * timer that stops by itself once steering left the side region or a newer key
 * came — there is no timer for the caller to cancel.
 */
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { wrapStep } from "../wrapStep";
import { useProjectsStore } from "../../stores/projects";
import {
  activateRegionCursor,
  regionCursor,
  regionLines,
  regionRoot,
  regionTargets,
  rememberedCursor,
  setRegionCursor,
} from "./steeringRegion";
import {
  STEERING_SLOT_ACTIONS,
  steeringKeyIs,
  type SteeringAction,
  type SteeringKeyMap,
} from "./steeringBindings";

/** What the caller does for steering that the module cannot reach. */
export interface SidePanelHooks {
  /** Out of the side panel to the tab level (closing a panel steering opened). */
  leaveToTabs(): void;
}

const VIEW_TABS = ".side-panel-views [data-view]";
/** The shown view's list, and the head the tree pins above its rows. */
const BODY = ".side-panel-scroll";
const HEAD = ".file-tree-head";
const OPENS_BY_DOUBLE_CLICK = '[data-steer-open="dblclick"]';
const SKELETON = ".file-tree-skeleton";

/** Lines a Shift+↑/↓ moves when nothing measures. */
const DEFAULT_PAGE = 10;
const RETRIES = 20;
const RETRY_MS = 50;

/** Bumped by every key: a wait started by an older one gives up. */
let generation = 0;
/** The tab the cursor was put on while its view's list had nothing to land on
 *  yet: the next placement may move it into the list. */
let provisional: HTMLElement | null = null;
/** The row the cursor was last on, per project and view (a signature, since
 *  the panel unmounts when it is closed). */
const lastRow = new Map<string, string>();

/** Forget the remembered rows (tests). */
export function forgetSidePanelRows() {
  lastRow.clear();
  provisional = null;
  generation++;
}

// ── The panel's parts ───────────────────────────────────────────────────

const tabsOf = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(VIEW_TABS));
const isActiveTab = (el: HTMLElement) => el.classList.contains("active");
const isViewTab = (el: HTMLElement) => el.matches(VIEW_TABS);
const inBody = (el: HTMLElement) => !!el.closest(BODY) && !el.closest(HEAD);

/** Elements that are focusable by `tabindex` alone are scroll or key hosts when
 *  they hold other controls (the file tree catches Enter / Delete for its
 *  selection), not controls: left in, they would swallow every row into one
 *  line. */
const OWN_CONTROL = "button, a[href], input, select, textarea, summary, [role], [contenteditable]";

/** The panel's controls (`regionTargets` less those hosts). */
function walkTargets(root: HTMLElement): HTMLElement[] {
  const all = regionTargets(root);
  return all.filter(
    (el) => !el.hasAttribute("tabindex") || el.matches(OWN_CONTROL) || !all.some((o) => o !== el && el.contains(o)),
  );
}

/** Controls of the shown view's list, head excluded. */
function bodyTargets(root: HTMLElement): HTMLElement[] {
  return walkTargets(root).filter(inBody);
}

function viewKey(root: HTMLElement): string {
  const view = tabsOf(root).find(isActiveTab)?.dataset.view ?? "";
  return `${useProjectsStore.getState().activeId ?? "root"}:${view}`;
}

/** What identifies a row across the panel unmounting: its entry path, else its
 *  text. Null for a control with neither. */
function signature(el: HTMLElement): string | null {
  const path = el.closest<HTMLElement>("[data-entry-path]")?.dataset.entryPath;
  if (path) return `p:${path}`;
  const text = (el.textContent ?? "").trim().replace(/\s+/g, " ") || el.getAttribute("aria-label") || el.getAttribute("title");
  return text ? `t:${text.slice(0, 80)}` : null;
}

function remember(root: HTMLElement, el: HTMLElement) {
  if (!inBody(el)) return;
  const sig = signature(el);
  if (sig) lastRow.set(viewKey(root), sig);
}

function put(root: HTMLElement, el: HTMLElement) {
  setRegionCursor(el, root);
  remember(root, el);
}

/** Where the cursor lands in the shown view's list: the row it was last on in
 *  this view, else the first control. Null when the list has none (yet). */
function landingInBody(root: HTMLElement): HTMLElement | null {
  const body = bodyTargets(root);
  if (body.length === 0) return null;
  const want = lastRow.get(viewKey(root));
  return (want ? body.find((el) => signature(el) === want) : undefined) ?? body[0];
}

/** Steering is still in the side region (a wait outliving it must stop). */
function sideActive(): boolean {
  const s = useKeyboardSteeringStore.getState();
  return s.active && s.level === "region" && s.region === "side";
}

/** Run `run` now and, while it says not yet, again shortly — until it is done,
 *  the tries are spent, a newer key came or steering left the panel. */
function retry(gen: number, run: () => boolean, tries = RETRIES) {
  if (gen !== generation || !sideActive()) return;
  if (run() || tries <= 0) return;
  window.setTimeout(() => retry(gen, run, tries - 1), tries === RETRIES ? 0 : RETRY_MS);
}

// ── Placement (B, resuming) ─────────────────────────────────────────────

/**
 * Put the cursor in the panel's list: back on the control it was on when a
 * dialog over the panel closed (`resume`), else on the row it was last on in
 * this view, else the list's first control, else the active view tab. True once
 * it is in the list; false while the list is empty — the cursor then waits on
 * the view tab, and the caller's next try may move it into the list.
 */
export function placeSidePanelCursor(root: HTMLElement, resume: boolean): boolean {
  const cur = regionCursor();
  if (cur && root.contains(cur) && cur !== provisional) return true;
  if (resume) {
    const back = rememberedCursor(root);
    if (back && walkTargets(root).includes(back)) {
      provisional = null;
      setRegionCursor(back, root);
      return true;
    }
  }
  const land = landingInBody(root);
  if (land) {
    provisional = null;
    put(root, land);
    return true;
  }
  const tab = tabsOf(root).find(isActiveTab);
  if (tab && walkTargets(root).includes(tab)) {
    provisional = tab;
    setRegionCursor(tab, root);
  }
  return false;
}

// ── Keys ────────────────────────────────────────────────────────────────

/**
 * Handle a key of the side region. False when it is not one of the panel's own
 * (Esc, `/`, `.`, the panel's closing key, …): the caller then gives it to the
 * generic region walk.
 */
export function steerSidePanel(
  e: KeyboardEvent,
  action: SteeringAction | null,
  bindings: SteeringKeyMap | undefined,
  hooks: SidePanelHooks,
): boolean {
  const root = regionRoot("side");
  if (!root) return false;
  generation++;
  // The pointer may have moved the cursor since the last key.
  const cur = regionCursor();
  if (cur && root.contains(cur)) remember(root, cur);
  if (action === null) {
    const slot = slotOf(e, bindings);
    if (slot !== null) {
      jumpToView(root, slot);
      return true;
    }
    return false;
  }
  switch (action) {
    case "up":
    case "down":
      moveByLines(root, action === "down" ? 1 : -1, e.shiftKey);
      return true;
    case "left":
    case "right":
      stepAcross(root, action === "right" ? 1 : -1);
      return true;
    case "press":
      return openRow(root, e, hooks);
    default:
      return false;
  }
}

/** The slot (1–9) a key is bound to. The slots are tab-bar bindings, so the
 *  region's own resolver never returns them. */
function slotOf(e: KeyboardEvent, bindings: SteeringKeyMap | undefined): number | null {
  const i = STEERING_SLOT_ACTIONS.findIndex((a) => steeringKeyIs(e, a, bindings));
  return i < 0 ? null : i + 1;
}

// ── ↑/↓ ────────────────────────────────────────────────────────────────

/** Where the cursor lands on a line: the active view tab on the view row, else
 *  the line's first control. */
function landingOf(line: HTMLElement[]): HTMLElement {
  return line.find((el) => isViewTab(el) && isActiveTab(el)) ?? line[0];
}

/** How many lines a screenful is: the list's height over the cursor's row
 *  height, less one for context. */
function pageSize(root: HTMLElement, cur: HTMLElement | null): number {
  const body = Array.from(root.querySelectorAll<HTMLElement>(BODY))
    .map((el) => el.getBoundingClientRect().height)
    .find((h) => h > 0);
  const row = cur?.getBoundingClientRect().height ?? 0;
  if (!body || row <= 0) return DEFAULT_PAGE;
  return Math.max(2, Math.floor(body / row) - 1);
}

function moveByLines(root: HTMLElement, delta: 1 | -1, page: boolean) {
  const lines = regionLines(walkTargets(root));
  if (lines.length === 0) return;
  const cur = regionCursor();
  const at = cur ? lines.findIndex((line) => line.includes(cur)) : -1;
  if (at < 0) {
    // The cursor fell off the page (its row re-rendered away, a folder took too
    // long to list): back into the list, not to an end of the whole panel.
    placeSidePanelCursor(root, false);
    return;
  }
  const next = Math.min(lines.length - 1, Math.max(0, at + delta * (page ? pageSize(root, cur) : 1)));
  put(root, landingOf(lines[next]));
}

// ── ←/→ ────────────────────────────────────────────────────────────────

function stepAcross(root: HTMLElement, delta: 1 | -1) {
  const cur = regionCursor();
  if (!cur || !root.contains(cur)) {
    placeSidePanelCursor(root, false);
    return;
  }
  if (isViewTab(cur)) {
    stepView(root, cur, delta);
  } else if (delta > 0 && cur.matches(".file-entry.dir")) {
    openFolder(root, cur);
  } else if (delta < 0 && cur.matches(".file-entry") && cur.closest(".file-tree")?.querySelector(".file-tree-breadcrumb")) {
    // A tree row: the parent folder (nothing at the tree's root).
    goToParent(root, cur);
  } else {
    const line = regionLines(walkTargets(root)).find((l) => l.includes(cur));
    if (!line) return;
    const from = line.indexOf(cur);
    // ← at the left end of the breadcrumb is the way out of an empty folder,
    // which has no row to press ← on.
    if (delta < 0 && from === 0 && cur.closest(".file-tree-breadcrumb") && parentOf(cur)) {
      goToParent(root, cur);
      return;
    }
    put(root, line[Math.min(line.length - 1, Math.max(0, from + delta))]);
  }
}

/** The ↑ button of the tree `el` belongs to, when that tree is in a folder.
 *  (Only the breadcrumb's own: the tree's refresh and search buttons borrow
 *  its class.) */
function parentOf(el: HTMLElement): HTMLElement | null {
  const crumbs = el.closest<HTMLElement>(".file-tree")?.querySelector(".file-tree-breadcrumb");
  const kids: Element[] = crumbs ? Array.from(crumbs.children) : [];
  return kids.find((c): c is HTMLElement => c instanceof HTMLElement && c.matches(".file-tree-up")) ?? null;
}

/** How deep the tree's breadcrumb is: one crumb per folder on the path. */
function depthOf(tree: HTMLElement): number {
  return tree.querySelectorAll(".file-tree-breadcrumb .file-tree-crumb").length;
}

/** The previous / next view tab (wrapping), the cursor following the active
 *  tab. */
function stepView(root: HTMLElement, cur: HTMLElement, delta: 1 | -1) {
  const tabs = tabsOf(root);
  if (tabs.length < 2) return;
  const active = tabs.findIndex(isActiveTab);
  const from = active >= 0 ? active : tabs.indexOf(cur);
  const next = tabs[wrapStep(from, delta, tabs.length)];
  const view = next.dataset.view;
  const gen = generation;
  next.click();
  retry(gen, () => {
    const r = regionRoot("side");
    const tab = r ? tabsOf(r).find((t) => t.dataset.view === view) : null;
    if (!r || !tab || !isActiveTab(tab)) return false;
    // The re-render dropped the cursor's class from the tabs it touched.
    put(r, tab);
    return true;
  });
}

/** Where the cursor goes once the tree has loaded another folder: `pick` out of
 *  the new listing's rows, else its first row, else the breadcrumb line (an
 *  empty folder). `listed` says the tree shows the other folder (a tree that
 *  was replaced meanwhile counts as listed). */
function afterNavigation(
  root: HTMLElement,
  tree: HTMLElement | null,
  listed: () => boolean,
  pick?: (rows: HTMLElement[]) => HTMLElement | undefined,
) {
  const gen = generation;
  retry(gen, () => {
    const r = regionRoot("side") ?? root;
    const scope = tree?.isConnected ? tree : null;
    if ((scope && !listed()) || scope?.querySelector(SKELETON)) return false;
    const targets = walkTargets(r).filter((el) => !scope || scope.contains(el));
    const rows = targets.filter((el) => el.matches(".file-entry"));
    const hit = pick?.(rows) ?? rows[0] ?? targets.find((el) => el.closest(".file-tree-breadcrumb"));
    if (!hit) return false;
    put(r, hit);
    return true;
  });
}

function openFolder(root: HTMLElement, row: HTMLElement) {
  const tree = row.closest<HTMLElement>(".file-tree");
  row.click();
  // The folder's own row goes with the listing it was in.
  afterNavigation(root, tree, () => !row.isConnected);
}

/** Up to the parent folder of the tree `from` is in (a row, or the breadcrumb's
 *  own ↑), the cursor on the folder just left. */
function goToParent(root: HTMLElement, from: HTMLElement) {
  const tree = from.closest<HTMLElement>(".file-tree");
  const up = parentOf(from);
  if (!tree || !up) return;
  // The folder being left, read before the listing changes under the crumbs.
  const name = tree.querySelector(".file-tree-breadcrumb .file-tree-crumb.current")?.textContent?.trim() ?? "";
  const depth = depthOf(tree);
  up.click();
  // One crumb fewer: the ↑ button itself may stay (the parent has a parent).
  afterNavigation(root, tree, () => depthOf(tree) < depth, (rows) =>
    rows.find((r) => r.matches(".dir") && r.querySelector(".file-name")?.textContent?.trim() === name),
  );
}

// ── Number keys ─────────────────────────────────────────────────────────

/** View `n` (1-based, in the order of the tabs the panel shows), the cursor
 *  into its list. */
function jumpToView(root: HTMLElement, n: number) {
  const tab = tabsOf(root)[n - 1];
  if (!tab) return;
  const view = tab.dataset.view;
  const gen = generation;
  if (!isActiveTab(tab)) tab.click();
  retry(gen, () => {
    const r = regionRoot("side");
    const now = r ? tabsOf(r).find((t) => t.dataset.view === view) : null;
    if (!r || !now || !isActiveTab(now)) return false;
    const land = landingInBody(r);
    if (land) {
      provisional = null;
      put(r, land);
      return true;
    }
    // The view is up but its list is not (loading) or has no control: the tab
    // holds the cursor meanwhile, and the list takes it once it has a row.
    if (regionCursor() !== now && walkTargets(r).includes(now)) {
      provisional = now;
      setRegionCursor(now, r);
    }
    return false;
  });
}

// ── Enter ───────────────────────────────────────────────────────────────

/** Enter on a file row opens it; steering goes to its tab (closing a panel
 *  steering opened). Shift+Enter, and a .zip (which extracts in place), stay in
 *  the panel. Enter on a folder row opens the folder as → does, so the cursor
 *  goes in with it. False for any other control. */
function openRow(root: HTMLElement, e: KeyboardEvent, hooks: SidePanelHooks): boolean {
  const cur = regionCursor();
  if (!cur || !root.contains(cur)) return false;
  if (cur.matches(".file-tree .file-entry.dir")) {
    openFolder(root, cur);
    return true;
  }
  if (!cur.matches(OPENS_BY_DOUBLE_CLICK)) return false;
  const stays = cur.hasAttribute("data-steer-stay");
  const tree = cur.closest<HTMLElement>(".file-tree");
  if (activateRegionCursor() !== "open") return true;
  if (stays) afterNavigation(root, tree, () => !cur.isConnected);
  else if (!e.shiftKey) hooks.leaveToTabs();
  return true;
}
