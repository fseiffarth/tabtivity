import { create } from "zustand";
import { DEFAULT_AGENT_SORT, type AgentSort } from "../../shared/agentSort";

/**
 * The desktop cockpit's UI state (`docs/desktop_cockpit_plan.md`): which agent
 * tab the Now view has selected and how its roster is cut. Nothing else —
 * whether the window is up and which view it shows is `stores/rootOverlay`'s:
 * the cockpit's views are views of the root console's window.
 *
 * The cockpit's DATA stays in the stores that own it — activity, tabs,
 * schedules, the root review queue, the alerts feed. A copy here would be a
 * second answer that can disagree with them, so this store holds no rows.
 *
 * Session-only. The rail and detail widths are the window's own per-machine
 * convenience (localStorage, in the component).
 */
export { COCKPIT_VIEWS, type CockpitView } from "../lib/cockpit/views";

/** How the roster groups its rows. */
export type CockpitRosterMode = "flat" | "project" | "box";

/** The roster's state chips. `all` also shows idle tabs. */
export type CockpitStateFilter = "asking" | "working" | "done" | "active" | "all";

interface CockpitState {
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
  /** When the window was last closed on a cockpit view (ms epoch), for
   *  Tonight's away recap. Stamped by `RootOverlayHost`; stays here because
   *  "away since" is about the cockpit, not about terminal-only sessions. */
  lastClosedAt: number | null;
  /** Narrow window only: the next Now view opens on the selected agent's detail
   *  instead of the roster (Tonight's "Show"). Now takes the request when it
   *  mounts and clears it. */
  detailAsked: boolean;
  select: (ptyId: string | null) => void;
  askDetail: () => void;
  setRosterMode: (mode: CockpitRosterMode) => void;
  setStateFilter: (filter: CockpitStateFilter) => void;
  setSort: (sort: AgentSort) => void;
  setQuery: (query: string) => void;
  setBoxFilter: (box: string | null) => void;
  /** Narrow the roster to one scope's agents (all states). The caller shows
   *  the Now view (`rootOverlay.openView("now")`). */
  showScope: (scope: string | null) => void;
}

export const useCockpitStore = create<CockpitState>((set) => ({
  selected: null,
  rosterMode: "flat",
  stateFilter: "active",
  sort: DEFAULT_AGENT_SORT,
  query: "",
  boxFilter: null,
  scopeFilter: null,
  lastClosedAt: null,
  detailAsked: false,
  select: (selected) => set({ selected }),
  askDetail: () => set({ detailAsked: true }),
  setRosterMode: (rosterMode) => set({ rosterMode }),
  setStateFilter: (stateFilter) => set({ stateFilter }),
  setSort: (sort) => set({ sort }),
  setQuery: (query) => set({ query }),
  setBoxFilter: (boxFilter) => set({ boxFilter }),
  showScope: (scopeFilter) => set({ scopeFilter, stateFilter: "all" }),
}));
