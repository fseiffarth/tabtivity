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
import { activeTabCard } from "./steeringRegion";
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
  /** The edge the caps ride: the top one by default. */
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

function drawn(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
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
  prompt: { find: () => first(`${FOCUSED} .prompt-strip`), align: "start" },
  // The side panel's row of views (Files, Git, Apps, Agents).
  sideViews: {
    find: () => first(".side-panel.open .toolbar-btn--tab")?.parentElement ?? null,
    align: "start",
  },
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
    const top = def.edge === "bottom" ? r.bottom - CAP_H - OVERLAP : r.top - CAP_H + OVERLAP;
    out[id] = { x: Math.round(x), y: Math.round(Math.max(1, top)), align: def.align };
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
