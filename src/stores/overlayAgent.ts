import { create } from "zustand";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "./tabs";
import type { SteeringApp } from "../lib/shortcuts/steeringRegion";
import { storageKey } from "../lib/brand";
import { ASSISTANT_SCOPE } from "../lib/assistant";

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

/** The room the docked column leaves the app beside it (px), while the
 *  overlay is wide enough for both. */
export const MIN_OVERLAY_APP_WIDTH = 360;

/**
 * The widest the column may be drawn in an overlay body `bodyWidth` px wide:
 * whatever leaves the app {@link MIN_OVERLAY_APP_WIDTH}, but never under the
 * column's own minimum. So in a frame too narrow for both (the frame's floor is
 * 420 px), the AGENT keeps its usable minimum and the app gives way — it
 * narrows, clipped by its body, and comes back as the frame grows. The user
 * asked for the agent; a terminal squeezed under ~40 columns is no use to them.
 * `undefined` (no cap) until the body has been measured.
 */
export function overlayAgentMaxWidth(bodyWidth: number): number | undefined {
  if (!(bodyWidth > 0)) return undefined;
  return Math.max(MIN_OVERLAY_AGENT_WIDTH, Math.floor(bodyWidth - MIN_OVERLAY_APP_WIDTH));
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
  /** The same for the Tabby scope: chat tab keys an attach-only view draws
   *  right now (`AttachedAgentPane`). `CenterPanel`'s copy of the chat keeps
   *  the PTY and stays hidden regardless; this only keeps it from sleeping. */
  assistantShownKeys: ReadonlySet<string>;
  /** Tabby chat keys whose CLI may run this session. A restored chat is only a
   *  saved record until it is first shown (or just made): `CenterPanel` mounts
   *  the pane that owns its PTY, and so spawns the CLI, only for keys in this
   *  set, so opening Tabby with many saved chats starts none of them. Nothing
   *  removes a key: the chat keeps running once started. */
  assistantStartedKeys: ReadonlySet<string>;
  markAssistantStarted: (key: string) => void;
  /** Started chats whose process has ended (the CLI quit, and with it the
   *  pane: a Tabby chat leaves no shell behind). Cleared when it respawns.
   *  `startAssistantChat` restarts one; the overlay offers the same. */
  assistantEndedKeys: ReadonlySet<string>;
  markAssistantEnded: (key: string, ended: boolean) => void;
  /** `scope` is the scope of `key`'s tab: root (the default) or Tabby. */
  markShown: (key: string, scope?: string) => void;
  unmarkShown: (key: string, scope?: string) => void;
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
  assistantShownKeys: new Set<string>(),
  assistantStartedKeys: new Set<string>(),
  markAssistantStarted: (key) =>
    set((s) => {
      if (s.assistantStartedKeys.has(key)) return s;
      return { assistantStartedKeys: new Set(s.assistantStartedKeys).add(key) };
    }),
  assistantEndedKeys: new Set<string>(),
  markAssistantEnded: (key, ended) =>
    set((s) => {
      if (s.assistantEndedKeys.has(key) === ended) return s;
      const keys = new Set(s.assistantEndedKeys);
      if (ended) keys.add(key);
      else keys.delete(key);
      return { assistantEndedKeys: keys };
    }),
  markShown: (key, scope = ROOT_SCOPE) =>
    set((s) => {
      const field = scope === ASSISTANT_SCOPE ? "assistantShownKeys" : "shownKeys";
      if (s[field].has(key)) return s;
      const keys = new Set(s[field]);
      keys.add(key);
      return { [field]: keys };
    }),
  unmarkShown: (key, scope = ROOT_SCOPE) =>
    set((s) => {
      const field = scope === ASSISTANT_SCOPE ? "assistantShownKeys" : "shownKeys";
      if (!s[field].has(key)) return s;
      const keys = new Set(s[field]);
      keys.delete(key);
      return { [field]: keys };
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
 * Forget docked tabs that left root — closed in the console's strip, or
 * closed by another client (`adoptSyncOutcome`). A tab whose process EXITED
 * stays in root (its pane prints `[process exited]`), so it stays docked too.
 * An ABSENT root array is not "gone": before root is restored this session
 * there is no array at all, and nothing is decided until there is one. (A
 * dock can only point at a tab of the current hydration: `addTabToRoot`
 * hydrates before it adds, and a restore mints every key afresh.)
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
