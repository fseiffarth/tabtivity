/**
 * The DOM half of steering's key caps (`steeringBar.ts` holds the model): where
 * on screen each control a cap row is pinned to is. Found by selector at
 * measure time, never by a ref into a component — the controls are the tab
 * bar's, the header's, the rail's and the prompt strip's, and none of them
 * should know a steering mode exists.
 *
 * A control that is not on screen (the panel is hidden, the active tab is no
 * agent's) has no placement, and its keys fall back into the bar.
 */
import { activeSubagentFrame, activeTabCard } from "./steeringRegion";
import type { CapAnchor } from "./steeringBar";

/** Where a cap row sits: the corner it hangs from and the side of the control
 *  it rides. */
export interface CapPlacement {
  /** The anchor point, in window pixels. */
  x: number;
  y: number;
  /** Which part of the row sits at `x`: its left edge, middle or right edge. */
  align: "start" | "center" | "end";
}

export type CapPlacements = Partial<Record<CapAnchor, CapPlacement>>;

interface AnchorDef {
  find: () => HTMLElement | null;
  align: CapPlacement["align"];
  /** The edge the caps ride: the top one by default. A control with no room
   *  on that side (the tab strip at the window's top edge) gets the other. */
  edge?: "top" | "bottom";
}

/** The first match of `selector` that is drawn and not in the root console
 *  (it shares the subwindow frame with the workspace's own). */
function first(selector: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if (!el.closest(".root-overlay") && drawn(el)) return el;
  }
  return null;
}

/** Has a box and is not `visibility: hidden` — the fullscreen header parks
 *  just above the window hidden, and its controls still measure. */
function drawn(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return typeof el.checkVisibility === "function"
    ? el.checkVisibility({ visibilityProperty: true })
    : getComputedStyle(el).visibility !== "hidden";
}

const FOCUSED = ".subwindow.focused";

const ANCHORS: Record<CapAnchor, AnchorDef> = {
  addProject: { find: () => first('[data-hint-anchor="add-project"]'), align: "start" },
  mail: { find: () => first(".app-header .mail-indicator-btn"), align: "center" },
  calendar: { find: () => first(".app-header .calendar-indicator-btn"), align: "center" },
  todo: { find: () => first(".app-header .todo-indicator-btn"), align: "center" },
  cockpit: { find: () => first(".app-header .cockpit-indicator-btn"), align: "center" },
  settings: { find: () => first('.app-header [data-hint-anchor="settings"]'), align: "center" },
  sidePanel: { find: () => first('.side-panel-reveal-rail [data-rail-action="open"]'), align: "center" },
  panels: { find: () => first(".side-panel-reveal-rail"), align: "center", edge: "bottom" },
  tab: { find: () => first(`${FOCUSED} .tab.active`), align: "end" },
  add: { find: () => first(`${FOCUSED} .tab-new-btn`), align: "start" },
  files: { find: () => first(`${FOCUSED} .subwindow-files-toggle`), align: "end" },
  card: { find: () => activeTabCard(), align: "end" },
  // On the Subagents toggle; with a subagent open, on its bar.
  subagents: {
    find: () => {
      const frame = activeSubagentFrame();
      if (!frame) return null;
      // The top-bar toggle can stay mounted while a subagent is open, and
      // hidden Reader copies may precede the visible control in DOM order.
      for (const selector of [
        ".terminal-reader-subagent-bar:not(.terminal-reader-chat-bar)",
        ".terminal-reader-subagent-toggle",
      ]) {
        const control = Array.from(frame.querySelectorAll<HTMLElement>(selector)).find(drawn);
        if (control) return control;
      }
      return null;
    },
    align: "end",
  },
  prompt: { find: () => first(`${FOCUSED} .prompt-strip`), align: "start" },
  // The control the region cursor is on: Enter presses it.
  cursor: { find: () => first(".steer-cursor"), align: "end" },
};

/** Cap height; a row hangs 4 px into its control, so it reads as attached. */
const CAP_H = 15;
const OVERLAP = 4;

/** Measures the given controls. Anything not drawn, or outside the window, has
 *  no entry. */
export function measureCaps(ids: readonly CapAnchor[]): CapPlacements {
  const out: CapPlacements = {};
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  for (const id of ids) {
    const def = ANCHORS[id];
    const el = def.find();
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) continue;
    const x = def.align === "start" ? r.left - 2 : def.align === "end" ? r.right + 2 : r.left + r.width / 2;
    // Above: the row hangs 4 px into the control's top. Below: it hangs from the
    // control's bottom the same way, inside on the bottom edge, outside when
    // flipped off the top. Clamping instead would sit it on the control's text.
    const above = r.top - CAP_H + OVERLAP;
    const below = def.edge === "bottom" ? r.bottom - CAP_H - OVERLAP : r.bottom - OVERLAP;
    const top = def.edge === "bottom" ? (below + CAP_H > vh ? above : below) : above < 0 ? below : above;
    out[id] = { x: Math.round(x), y: Math.round(Math.min(Math.max(0, top), vh - CAP_H)), align: def.align };
  }
  return out;
}

export function samePlacements(a: CapPlacements, b: CapPlacements): boolean {
  const ka = Object.keys(a) as CapAnchor[];
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const p = a[k]!;
    const q = b[k];
    return !!q && p.x === q.x && p.y === q.y && p.align === q.align;
  });
}

/** A drawn cap row's box, in window pixels. */
export interface CapBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * How far to move each cap row sideways so no two on the same line overlap:
 * rows pinned to neighbouring controls (W on the tab, N O + beside it, V on
 * the files toggle) would otherwise cover each other. Left to right, a row
 * starts after every earlier row it shares a line with; then right to left,
 * a row pushed past the window's right edge comes back in, taking the rows
 * before it along.
 */
export function spreadRows(boxes: readonly CapBox[], width: number, gap = 2): number[] {
  const dx = boxes.map(() => 0);
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].left - boxes[b].left || a - b);
  const sameLine = (a: CapBox, b: CapBox) => a.top < b.bottom && b.top < a.bottom;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    for (let j = 0; j < k; j++) {
      const p = order[j];
      if (!sameLine(boxes[i], boxes[p])) continue;
      dx[i] = Math.max(dx[i], boxes[p].right + dx[p] + gap - boxes[i].left);
    }
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    let limit = width - gap;
    for (let j = k + 1; j < order.length; j++) {
      const q = order[j];
      if (sameLine(boxes[i], boxes[q])) limit = Math.min(limit, boxes[q].left + dx[q] - gap);
    }
    const over = boxes[i].right + dx[i] - limit;
    if (over > 0) dx[i] -= over;
  }
  return dx;
}
