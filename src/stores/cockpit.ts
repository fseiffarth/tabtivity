import { create } from "zustand";
import { DEFAULT_AGENT_SORT, type AgentSort } from "../../shared/agentSort";

/**
 * The desktop cockpit's UI state (`docs/desktop_cockpit_plan.md`): whether the
 * overlay is up, which view it shows, which agent tab the Now view has
 * selected and how its roster is cut. Nothing else.
 *
 * The cockpit's DATA stays in the stores that own it — activity, tabs,
 * schedules, the root review queue, the alerts feed. A copy here would be a
 * second answer that can disagree with them, so this store holds no rows.
 *
 * Session-only: after a relaunch the overlay starts closed on the Now view.
 * The rail and detail widths are the overlay's own per-machine convenience
 * (localStorage, in the component).
 *
 * Named like the other header overlays' stores (`overlayOpen`, `openOverlay`,
 * `closeOverlay`), so keyboard steering treats it as one of the family.
 */
export type CockpitView = "now" | "projects" | "tonight" | "usage";
export const COCKPIT_VIEWS: readonly CockpitView[] = ["now", "projects", "tonight", "usage"];

/** How the roster groups its rows. */
export type CockpitRosterMode = "flat" | "project" | "box";

/** The roster's state chips. `all` also shows idle tabs. */
export type CockpitStateFilter = "asking" | "working" | "done" | "active" | "all";

interface CockpitState {
  overlayOpen: boolean;
  view: CockpitView;
  /** The selected agent tab's PTY id (`<scope>:<key>`), or null. */
  selected: string | null;
  rosterMode: CockpitRosterMode;
  stateFilter: CockpitStateFilter;
  sort: AgentSort;
  /** The roster's text filter (tab, project, prompt). */
  query: string;
  /** Narrows every view to one box; null = all projects. */
  boxFilter: string | null;
  /** Narrows the roster to one scope (a Projects card's Agents); null = all. */
  scopeFilter: string | null;
  /** When the overlay was last closed (ms epoch), for Tonight's away recap. */
  lastClosedAt: number | null;
  openOverlay: (view?: CockpitView) => void;
  closeOverlay: () => void;
  toggleOverlay: () => void;
  setView: (view: CockpitView) => void;
  select: (ptyId: string | null) => void;
  setRosterMode: (mode: CockpitRosterMode) => void;
  setStateFilter: (filter: CockpitStateFilter) => void;
  setSort: (sort: AgentSort) => void;
  setQuery: (query: string) => void;
  setBoxFilter: (box: string | null) => void;
  /** The Now view, narrowed to one scope's agents. */
  showScope: (scope: string | null) => void;
}

export const useCockpitStore = create<CockpitState>((set) => ({
  overlayOpen: false,
  view: "now",
  selected: null,
  rosterMode: "flat",
  stateFilter: "active",
  sort: DEFAULT_AGENT_SORT,
  query: "",
  boxFilter: null,
  scopeFilter: null,
  lastClosedAt: null,
  openOverlay: (view) => set((s) => ({ overlayOpen: true, view: view ?? s.view })),
  closeOverlay: () =>
    set((s) => (s.overlayOpen ? { overlayOpen: false, lastClosedAt: Date.now() } : s)),
  toggleOverlay: () =>
    set((s) => (s.overlayOpen ? { overlayOpen: false, lastClosedAt: Date.now() } : { overlayOpen: true })),
  setView: (view) => set({ view }),
  select: (selected) => set({ selected }),
  setRosterMode: (rosterMode) => set({ rosterMode }),
  setStateFilter: (stateFilter) => set({ stateFilter }),
  setSort: (sort) => set({ sort }),
  setQuery: (query) => set({ query }),
  setBoxFilter: (boxFilter) => set({ boxFilter }),
  showScope: (scopeFilter) => set({ scopeFilter, view: "now", stateFilter: "all" }),
}));
