import { create } from "zustand";
import { useProjectsStore } from "./projects";
import { storageKey } from "../lib/brand";

/**
 * Where in the window steering is pointing. The mode is a small hierarchy the
 * arrows walk: ↓ goes one level in, ↑ one level out. It opens on the tabs of
 * the current project — switching tabs is what it is mostly for.
 *
 *   projects — ←/→ switch the project (the station ring), ↓ into its windows
 *   panes    — ←/→ step the subwindows (the tabs, when there is only one)
 *   tabs     — ←/→ step the focused subwindow's tabs
 *   scroll   — inside the active tab's terminal: ←/→ scroll it back and
 *              forth (`lib/terminal/terminalScroll`), ↓ back to its live end
 *   region   — a keyboard cursor walking the controls of one surface that
 *              has no tab bar: the side panel, the mail / calendar / to-do
 *              overlays, a pane's + menu, the settings dialog, the top bar
 *              (↑ from the projects), or whatever dialog or menu is on top
 *              (`SteeringRegion`)
 */
export type SteeringLevel = "projects" | "panes" | "tabs" | "scroll" | "region";

/** The surfaces the region cursor can walk (see `lib/shortcuts/steeringRegion`). */
export type SteeringRegion =
  | "side"
  | "mail"
  | "calendar"
  | "todo"
  | "addTab"
  | "settings"
  | "header"
  /** The card over the active tab's terminal (Undo clear, a sign-in link, a
   *  CLI update notice). */
  | "card"
  /** The dialog, right-click menu or top-bar menu on top of everything
   *  (`steeringRegion.topLayer`) — any of them, walked the same way. */
  | "overlay";

/** Every level but the region — where a region returns to. */
export type SteeringBaseLevel = Exclude<SteeringLevel, "region">;

/** A text box steering lent the keyboard to and takes it back from: the
 *  project jump (`/` on the tab-bar levels), the prompt box (I, and the Plan /
 *  Goal keys), a surface's own search field (`/` in a region). */
export type SteeringHandoff = "jump" | "prompt" | "search";

/**
 * Transient state for keyboard steering mode (the `steeringMode` chord).
 *
 * `subwindowNav`'s sibling: kept out of the tabs store so entering/leaving the
 * mode never churns the layout tree, and deliberately not persisted — a
 * relaunch never starts steering (only `legendHidden` is remembered). While `active`, `useKeyboard` swallows every
 * key in a capture-phase listener (nothing may leak to the terminal
 * underneath), `FocusFrameOverlay` shows the subwindow badges, the project
 * pills wear their station numbers on the projects level, and the bottom legend
 * renders the current level's keys from `STEERING_KEYS`.
 *
 * `useKeyboard` mutates this imperatively via `getState()`; the overlays
 * subscribe reactively.
 */
interface KeyboardSteeringState {
  /** Steering on → keys captured, badges/legend visible. */
  active: boolean;
  level: SteeringLevel;
  /** The surface the region cursor walks; set only while `level` is "region". */
  region: SteeringRegion | null;
  /** The level Escape returns to from a region. */
  regionReturn: SteeringBaseLevel;
  /** The regions under this one, innermost last: a dialog opened from the
   *  settings, a menu dropped from the top bar. Leaving a region comes back
   *  to the nearest one still on screen before the base level. */
  regionStack: SteeringRegion[];
  /** Enter the mode on the current project's tabs. */
  enter: () => void;
  exit: () => void;
  setLevel: (level: SteeringBaseLevel) => void;
  enterRegion: (region: SteeringRegion) => void;
  /** Leave the region for the nearest one under it that `alive` says is
   *  still there (any, when omitted), else for the level it was entered from.
   *  Returns the region it came back to, or null for the base level. */
  leaveRegion: (alive?: (region: SteeringRegion) => boolean) => SteeringRegion | null;
  /** The key list folded into the corner badge (steering's H). Unlike the
   *  rest this outlives the mode: per machine, in localStorage. */
  legendHidden: boolean;
  toggleLegend: () => void;
  /** The box that has the keyboard while steering waits to come back — the
   *  mode is off (keys reach the box) but the legend still says how to return.
   *  Null otherwise; entering or leaving the mode clears it. */
  handedTo: SteeringHandoff | null;
  /** Where `resume` comes back to. */
  handoffReturn: {
    level: SteeringLevel;
    region: SteeringRegion | null;
    regionReturn: SteeringBaseLevel;
    regionStack: SteeringRegion[];
  };
  /** Lend the keyboard to `box`: the mode goes off, remembering where it was. */
  handOff: (box: SteeringHandoff) => void;
  /** Steering back on where `handOff` left it. */
  resume: () => void;
  /** The box went away without coming back (a click elsewhere, a pick that
   *  moved focus on): nothing is waiting any more. */
  dropHandoff: () => void;
}

const LEGEND_HIDDEN_KEY = storageKey("steering.legendHidden");

function readLegendHidden(): boolean {
  try {
    return localStorage.getItem(LEGEND_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeLegendHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(LEGEND_HIDDEN_KEY, "1");
    else localStorage.removeItem(LEGEND_HIDDEN_KEY);
  } catch {
    // localStorage unavailable — the choice still holds for this session.
  }
}

export const useKeyboardSteeringStore = create<KeyboardSteeringState>((set, get) => ({
  active: false,
  level: "tabs",
  region: null,
  regionReturn: "tabs",
  regionStack: [],
  enter: () => set({ active: true, level: "tabs", region: null, regionStack: [], handedTo: null }),
  exit: () => set({ active: false, level: "tabs", region: null, regionStack: [], handedTo: null }),
  setLevel: (level) => set({ level, region: null, regionStack: [] }),
  enterRegion: (region) => {
    const { level, region: from, regionReturn, regionStack } = get();
    if (level !== "region" || !from) {
      set({ level: "region", region, regionReturn: level === "region" ? regionReturn : level, regionStack: [] });
      return;
    }
    // A surface over a surface (a dialog raised from settings, a menu off the
    // top bar) stacks: leaving it comes back to the one under it. The base
    // level stays the one the first was entered from.
    set({
      level: "region",
      region,
      regionReturn,
      regionStack: from === region ? regionStack : [...regionStack, from],
    });
  },
  leaveRegion: (alive) => {
    const stack = [...get().regionStack];
    while (stack.length > 0) {
      const under = stack.pop()!;
      if (!alive || alive(under)) {
        set({ region: under, regionStack: stack });
        return under;
      }
    }
    set({ level: get().regionReturn, region: null, regionStack: [] });
    return null;
  },
  legendHidden: readLegendHidden(),
  toggleLegend: () => {
    const legendHidden = !get().legendHidden;
    writeLegendHidden(legendHidden);
    set({ legendHidden });
  },
  handedTo: null,
  handoffReturn: { level: "tabs", region: null, regionReturn: "tabs", regionStack: [] },
  handOff: (box) => {
    const { level, region, regionReturn, regionStack } = get();
    set({ active: false, handedTo: box, handoffReturn: { level, region, regionReturn, regionStack } });
  },
  resume: () => set({ active: true, handedTo: null, ...get().handoffReturn }),
  dropHandoff: () => set({ handedTo: null }),
}));

/**
 * The project "station" ring — the ONE list behind cycleProject / cycleProjectBack,
 * the steering digits (1 = station index 0), and the pill badges, so the three
 * can never number the strip differently.
 *
 * The **root terminal (`null`) leads the ring**: it is the pill strip's first
 * pill, so a shortcut that walks the strip has to stop there too (see the
 * history note on `useKeyboard`'s cycleProject). The rest are the non-inactive
 * projects in pill display order (`position`).
 */
export function projectStations(): (string | null)[] {
  const ps = useProjectsStore.getState();
  return [
    null,
    ...ps.projects
      .filter((p) => p.status !== "inactive")
      .sort((a, b) => a.position - b.position)
      .map((p) => p.id),
  ];
}
