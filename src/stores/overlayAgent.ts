import { create } from "zustand";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "./tabs";
import type { SteeringApp } from "../lib/shortcuts/steeringRegion";
import { storageKey } from "../lib/brand";

/**
 * The **docked agent** of the mail, calendar and to-do overlays — a root agent
 * tab shown in a column beside the app, so the agent's MCP writes land next to
 * the prompt that caused them (`docs/overlay_agent_plan.md`).
 *
 * The tab itself is an ordinary root tab (`addTabToRoot`): its PTY is owned by
 * `CenterPanel`'s keep-alive layer and it shows in the root console's strip.
 * This store only remembers WHICH root tab each overlay docks and whether the
 * column is showing it — one docked agent per overlay. Hiding the column keeps
 * the key, so the next Ctrl+N can put the same conversation back.
 *
 * Session-only on purpose: after a relaunch the tab is just a root tab, and
 * the column starts closed. Only the column's WIDTH is remembered, per machine
 * (localStorage, like the root console's frame) — where a column sits on one
 * desk is not a preference worth syncing.
 *
 * Policy (reuse the docked tab or mint a new one, which agent a chord means)
 * belongs to the column's hook; this store just records the outcome.
 */
export interface OverlayAgentDock {
  /** The docked root tab's key; `null` = nothing docked. */
  key: string | null;
  /** The column is showing. Never true without a `key`. */
  open: boolean;
}

/** Bounds for the docked column (px). Wider than the ◫ file column's
 *  (`clampFilesWidth`): an agent CLI wants ~80 columns of text. */
export const DEFAULT_OVERLAY_AGENT_WIDTH = 560;
export const MIN_OVERLAY_AGENT_WIDTH = 320;
export const MAX_OVERLAY_AGENT_WIDTH = 1100;

export function clampOverlayAgentWidth(w: number): number {
  return Math.min(MAX_OVERLAY_AGENT_WIDTH, Math.max(MIN_OVERLAY_AGENT_WIDTH, Math.round(w)));
}

const WIDTH_STORAGE_KEY = storageKey("overlayAgentWidth");

function readPersistedWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? clampOverlayAgentWidth(n) : DEFAULT_OVERLAY_AGENT_WIDTH;
  } catch {
    return DEFAULT_OVERLAY_AGENT_WIDTH;
  }
}

function writePersistedWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    // localStorage unavailable — the width still holds for this session.
  }
}

const EMPTY_DOCK: OverlayAgentDock = { key: null, open: false };

interface OverlayAgentState {
  docks: Record<SteeringApp, OverlayAgentDock>;
  /** Dock root tab `key` in `app`'s column and show it. */
  dock: (app: SteeringApp, key: string) => void;
  /** Close `app`'s column; the docked key stays for `reopen`. */
  hide: (app: SteeringApp) => void;
  /** Show `app`'s column again — only when something is docked. */
  reopen: (app: SteeringApp) => void;
  /** Forget `app`'s docked tab and close its column. */
  clear: (app: SteeringApp) => void;
  /**
   * Root tab keys a mounted column is displaying right now. `CenterPanel`'s
   * root copy steps aside for these: one visible view per PTY. Written by the
   * column's mount effect; the set keeps its identity while nothing changes.
   */
  shownKeys: ReadonlySet<string>;
  markShown: (key: string) => void;
  unmarkShown: (key: string) => void;
  /** The column's width (px), already clamped. */
  width: number;
  /** Commit a finished resize drag: clamped, then remembered on this machine. */
  setWidth: (width: number) => void;
}

export const useOverlayAgentStore = create<OverlayAgentState>((set) => ({
  docks: { mail: EMPTY_DOCK, calendar: EMPTY_DOCK, todo: EMPTY_DOCK },
  dock: (app, key) =>
    set((s) => {
      const cur = s.docks[app];
      if (cur.key === key && cur.open) return s;
      return { docks: { ...s.docks, [app]: { key, open: true } } };
    }),
  hide: (app) =>
    set((s) => {
      const cur = s.docks[app];
      if (!cur.open) return s;
      return { docks: { ...s.docks, [app]: { ...cur, open: false } } };
    }),
  reopen: (app) =>
    set((s) => {
      const cur = s.docks[app];
      if (cur.open || !cur.key) return s;
      return { docks: { ...s.docks, [app]: { ...cur, open: true } } };
    }),
  clear: (app) =>
    set((s) => {
      if (!s.docks[app].key && !s.docks[app].open) return s;
      return { docks: { ...s.docks, [app]: EMPTY_DOCK } };
    }),
  shownKeys: new Set<string>(),
  markShown: (key) =>
    set((s) => {
      if (s.shownKeys.has(key)) return s;
      const shownKeys = new Set(s.shownKeys);
      shownKeys.add(key);
      return { shownKeys };
    }),
  unmarkShown: (key) =>
    set((s) => {
      if (!s.shownKeys.has(key)) return s;
      const shownKeys = new Set(s.shownKeys);
      shownKeys.delete(key);
      return { shownKeys };
    }),
  width: readPersistedWidth(),
  setWidth: (width) => {
    const w = clampOverlayAgentWidth(width);
    writePersistedWidth(w);
    set({ width: w });
  },
}));

/**
 * The root tab `app` has docked, or `null` when nothing is docked or root has
 * not been restored yet. For the column's hook (does the docked tab run the
 * agent a chord asks for?) without it reaching into both stores itself.
 */
export function dockedRootTab(app: SteeringApp): TabEntry | null {
  const key = useOverlayAgentStore.getState().docks[app].key;
  if (!key) return null;
  return useTabsStore.getState().tabsByScope[ROOT_SCOPE]?.find((tab) => tab.key === key) ?? null;
}

/**
 * Forget docked tabs that left root — closed in the console, or exited. An
 * ABSENT root array is not "gone": before root is restored this session there
 * is no array at all, and the docked tab is simply not loaded yet.
 */
function dropDeparted(rootTabs: readonly TabEntry[] | undefined) {
  if (!rootTabs) return;
  const { docks, shownKeys, clear, unmarkShown } = useOverlayAgentStore.getState();
  const live = new Set(rootTabs.map((tab) => tab.key));
  for (const app of Object.keys(docks) as SteeringApp[]) {
    const key = docks[app].key;
    if (key && !live.has(key)) {
      clear(app);
      if (shownKeys.has(key)) unmarkShown(key);
    }
  }
}

let lastRootTabs = useTabsStore.getState().tabsByScope[ROOT_SCOPE];
useTabsStore.subscribe((s) => {
  const rootTabs = s.tabsByScope[ROOT_SCOPE];
  if (rootTabs === lastRootTabs) return;
  lastRootTabs = rootTabs;
  dropDeparted(rootTabs);
});
