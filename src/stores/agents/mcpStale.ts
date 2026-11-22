import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { subscribeTauri } from "../../hooks/useTauriListener";
import { translateNow } from "../../lib/i18n";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { agentDeliveryTurn, useActivityStore, type AgentTurnState } from "../activity";
import { isDetachedWindow } from "../detachedContext";
import { useProjectsStore } from "../projects";
import { isResumableAgentTab, useTabsStore, type TabEntry } from "../tabs";
import { relaunch, runsLocally, type UndoClearResult } from "./agentClearUndo";

/**
 * Local agent tabs whose Tabtivity tools went dead on a reattach
 * (docs/done/mcp_reattach_plan.md, Phase 1 step 6).
 *
 * A local agent tab that rejoins its surviving tmux session after a crash or a
 * restart keeps the agent process the earlier run started, and with it that
 * run's MCP port and tokens. The backend tells (`pty_spawn`'s `mcpStale`,
 * `root_mcp_mark::classify_reattach`; or later, when the peer check refused a
 * revived token nobody could be seen presenting: `MCP_SESSIONS_EVENT` with
 * `staleTab`); this store keeps the answer per PTY and
 * offers the one way back, a restart onto the same conversation
 * (`agentClearUndo::relaunch`). Never automatic: a restart drops what the user
 * typed and not sent, background shells and the session's approvals.
 *
 *  - **Reconnect** relaunches now. Offered while the agent is idle.
 *  - **Reconnect when this turn ends** is armed by the user while a turn is in
 *    flight and fires on the turn hook's `done` (or, for an agent with no
 *    hooks, once its bytes say it is no longer busy).
 *  - A "continue the latest" CLI (`mcpReconnectKind` = `latest`) may come back
 *    on another conversation of its folder: the card confirms first, and the
 *    bulk toast never takes it.
 *  - A tab that cannot resume at all gets the notice only.
 *
 * After a restore, one toast per batch of newly stale tabs offers to reconnect
 * the idle id-resumable ones, at most `BULK_PARALLEL` at a time.
 */

/** The CLIs whose relaunch resumes the tab's own conversation by its id
 *  (`agentClearUndo`'s header, `services::agent_relocate`): Claude by
 *  `--resume <id>`, the others from the id their hook or plugin recorded. */
const RESUMES_BY_ID: ReadonlySet<string> = new Set(["claude", "codex", "vibe", "opencode"]);

/** How many relaunches the bulk toast runs at once. */
export const BULK_PARALLEL = 4;
/** How long the toast waits after the last stale answer of a restore before it
 *  counts: the restore spawns its tabs one after another. */
export const TOAST_SETTLE_MS = 3_000;
/** How long a bulk slot waits for its tab's respawn to answer before it takes
 *  the next one (a pane in a hidden project spawns only when shown). */
const SPAWN_WAIT_MS = 15_000;

export type McpReconnectKind = "byId" | "latest" | "none";

/** How a stale tab comes back: on its own conversation (`byId`), on its
 *  folder's latest one (`latest`, confirmed first), or not at all (`none`). */
export function mcpReconnectKind(scope: string, tab: TabEntry): McpReconnectKind {
  if (!runsLocally(scope, tab) || !isResumableAgentTab(tab)) return "none";
  return RESUMES_BY_ID.has(tab.cmd) ? "byId" : "latest";
}

interface HookTurn {
  state: AgentTurnState;
  job: boolean;
}

interface McpStaleStore {
  /** Composed PTY id → its agent's Tabtivity tools are dead. */
  stale: Record<string, true>;
  /** Composed PTY id → "Reconnect when this turn ends" is armed. */
  armed: Record<string, true>;
  /** Composed PTY id → the user closed the card (the hover card still says it). */
  dismissed: Record<string, true>;
  /** The turn hook's verdicts seen for a stale tab, straight off the event, so
   *  the card follows them as they come. */
  turns: Record<string, HookTurn>;
}

export const useMcpStaleStore = create<McpStaleStore>(() => ({
  stale: {},
  armed: {},
  dismissed: {},
  turns: {},
}));

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

const spawnWaiters = new Map<string, () => void>();
/** Tabs a toast already counted, so a later batch announces only new ones. */
const announced = new Set<string>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let stopTurnListener: (() => void) | undefined;
let stopActivityWatch: (() => void) | undefined;

/** Record what a spawn of this PTY answered (`pty_spawn`'s `mcpStale`). Every
 *  launch answers, so a relaunch clears the flag of the run it replaced. */
export function noteMcpStale(ptyId: string, stale: boolean): void {
  spawnWaiters.get(ptyId)?.();
  spawnWaiters.delete(ptyId);
  const state = useMcpStaleStore.getState();
  if (stale) {
    markStale(ptyId);
  } else if (state.stale[ptyId] || state.armed[ptyId] || state.dismissed[ptyId] || state.turns[ptyId]) {
    useMcpStaleStore.setState({
      stale: without(state.stale, ptyId),
      armed: without(state.armed, ptyId),
      dismissed: without(state.dismissed, ptyId),
      turns: without(state.turns, ptyId),
    });
    announced.delete(ptyId);
  }
  syncWatchers();
}

function markStale(ptyId: string): void {
  const state = useMcpStaleStore.getState();
  if (!state.stale[ptyId]) useMcpStaleStore.setState({ stale: { ...state.stale, [ptyId]: true } });
  scheduleToast();
}

/** `root-mcp-sessions-changed` (`commands::root_mcp::SESSIONS_EVENT`): its
 *  payload names a running tab when the backend found its tools dead after
 *  the spawn answered, i.e. a revived token of it was refused because nobody
 *  could be seen holding the connection (a non-dumpable CLI). Any other
 *  payload is the session list's own cue. */
export const MCP_SESSIONS_EVENT = "root-mcp-sessions-changed";

/** Flag a running tab the backend found stale after its spawn: the same card
 *  and toast as a stale spawn answer; its next spawn answers afresh. */
export function noteMcpStaleLater(payload: unknown): void {
  const tab = (payload as { staleTab?: unknown } | null)?.staleTab;
  if (typeof tab !== "string" || !tab) return;
  markStale(tab);
  syncWatchers();
}

let noticeWatchers = 0;
let stopNotices: (() => void) | undefined;

/** Hear the backend's later stale flags while an agent terminal is mounted in
 *  this window (`TerminalMcpStaleCard`). */
export function watchMcpStaleNotices(): () => void {
  noticeWatchers += 1;
  if (!stopNotices) {
    stopNotices = subscribeTauri(() => listen<unknown>(MCP_SESSIONS_EVENT, (ev) => noteMcpStaleLater(ev.payload)));
  }
  return () => {
    noticeWatchers -= 1;
    if (noticeWatchers <= 0 && stopNotices) {
      noticeWatchers = 0;
      stopNotices();
      stopNotices = undefined;
    }
  };
}

export function dismissMcpStale(ptyId: string): void {
  const state = useMcpStaleStore.getState();
  if (state.stale[ptyId]) useMcpStaleStore.setState({ dismissed: { ...state.dismissed, [ptyId]: true } });
}

/** Whether the agent is in a turn right now: the hook's verdict where it has
 *  one (a turn, or an approval it waits on), its bytes otherwise. */
export function mcpStaleTurnInFlight(ptyId: string): boolean {
  const turn = useMcpStaleStore.getState().turns[ptyId] ?? agentDeliveryTurn(ptyId);
  if (turn) return turn.state === "working" || turn.state === "decision";
  return !!useActivityStore.getState().busyByTab[ptyId];
}

/** Idle enough for the bulk toast: no turn, no shell it left running in the
 *  background, nothing on screen moving. */
function idleForBulk(ptyId: string): boolean {
  const turn = useMcpStaleStore.getState().turns[ptyId] ?? agentDeliveryTurn(ptyId);
  return !mcpStaleTurnInFlight(ptyId) && !turn?.job && !useActivityStore.getState().busyByTab[ptyId];
}

function tabOf(ptyId: string): { scope: string; tab: TabEntry } | null {
  const parts = splitPtyId(ptyId);
  const tab = parts && useTabsStore.getState().tabsByScope[parts.scope]?.find((t) => t.key === parts.key);
  return parts && tab ? { scope: parts.scope, tab } : null;
}

/** The stale tabs that are still open. */
function liveStaleIds(): string[] {
  return Object.keys(useMcpStaleStore.getState().stale).filter((id) => tabOf(id) !== null);
}

/** What the bulk toast reconnects: idle, unarmed, resumed by id. */
export function mcpStaleBulkCandidates(): string[] {
  return liveStaleIds().filter((id) => {
    const found = tabOf(id);
    return (
      !!found &&
      !useMcpStaleStore.getState().armed[id] &&
      mcpReconnectKind(found.scope, found.tab) === "byId" &&
      idleForBulk(id)
    );
  });
}

/** Restart the tab onto its conversation. Clears its flag at once; the
 *  respawn's own answer raises it again if the new run is somehow stale too. */
export async function reconnectMcpStale(ptyId: string): Promise<UndoClearResult | "gone"> {
  const found = tabOf(ptyId);
  if (!found) {
    noteMcpStale(ptyId, false);
    return "gone";
  }
  const result = await relaunch(found.scope, found.tab);
  if (result === "undone") {
    const state = useMcpStaleStore.getState();
    useMcpStaleStore.setState({
      stale: without(state.stale, ptyId),
      armed: without(state.armed, ptyId),
      dismissed: without(state.dismissed, ptyId),
      turns: without(state.turns, ptyId),
    });
    syncWatchers();
  }
  return result;
}

/** Arm "Reconnect when this turn ends"; a turn that is already over reconnects
 *  now. The caller has confirmed a `latest` CLI before. */
export async function armMcpReconnect(ptyId: string): Promise<UndoClearResult | "gone" | "armed"> {
  if (!mcpStaleTurnInFlight(ptyId)) return reconnectMcpStale(ptyId);
  const state = useMcpStaleStore.getState();
  if (!state.stale[ptyId]) return "gone";
  useMcpStaleStore.setState({ armed: { ...state.armed, [ptyId]: true } });
  syncWatchers();
  return "armed";
}

export function disarmMcpReconnect(ptyId: string): void {
  const state = useMcpStaleStore.getState();
  if (!state.armed[ptyId]) return;
  useMcpStaleStore.setState({ armed: without(state.armed, ptyId) });
  syncWatchers();
}

function fireArmed(ptyId: string): void {
  if (!useMcpStaleStore.getState().armed[ptyId]) return;
  disarmMcpReconnect(ptyId);
  void reconnectMcpStale(ptyId);
}

/** Reconnect every idle id-resumable stale tab, `BULK_PARALLEL` at a time,
 *  each slot waiting for its tab's respawn before it takes the next. A tab
 *  that started a turn since the toast is left alone. */
export async function reconnectIdleMcpStale(parallel = BULK_PARALLEL): Promise<void> {
  const queue = mcpStaleBulkCandidates();
  const slot = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (!idleForBulk(id) || useMcpStaleStore.getState().armed[id]) continue;
      const spawned = waitForSpawn(id);
      const result = await reconnectMcpStale(id);
      if (result === "undone") await spawned;
      else spawnWaiters.delete(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, slot));
}

function waitForSpawn(ptyId: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (spawnWaiters.get(ptyId) === done) spawnWaiters.delete(ptyId);
      resolve();
    }, SPAWN_WAIT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    spawnWaiters.set(ptyId, done);
  });
}

function scheduleToast(): void {
  // The main window speaks for every tab; a popout raising its own would be
  // a second toast for the same tabs.
  if (isDetachedWindow()) return;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(raiseToast, TOAST_SETTLE_MS);
}

function raiseToast(): void {
  toastTimer = undefined;
  const live = liveStaleIds();
  if (!live.some((id) => !announced.has(id))) return;
  for (const id of live) announced.add(id);
  const text =
    live.length === 1
      ? translateNow("terminal.mcpStale.toastOne")
      : translateNow("terminal.mcpStale.toast", { count: live.length });
  const offer = mcpStaleBulkCandidates().length > 0;
  useProjectsStore.setState({
    switchToast: text,
    switchToastAction: offer
      ? {
          text,
          label: translateNow("terminal.mcpStale.toastReconnect"),
          run: () => void reconnectIdleMcpStale(),
          untested: "terminal.mcpStale.bulk",
        }
      : null,
  });
}

/** The turn hook's verdicts and the activity store, followed only while a tab
 *  is stale (the card's state) or armed (the trigger). */
function syncWatchers(): void {
  const { stale, armed } = useMcpStaleStore.getState();
  const anyStale = Object.keys(stale).length > 0;
  const anyArmed = Object.keys(armed).length > 0;
  if (anyStale && !stopTurnListener) {
    stopTurnListener = subscribeTauri(() =>
      listen<{ id: string; state: AgentTurnState; job?: boolean }>("agent-turn", (ev) => {
        const { id, state, job } = ev.payload;
        const current = useMcpStaleStore.getState();
        if (!current.stale[id]) return;
        useMcpStaleStore.setState({ turns: { ...current.turns, [id]: { state, job: !!job } } });
        if (state === "done" || state === "idle") fireArmed(id);
      }),
    );
  } else if (!anyStale && stopTurnListener) {
    stopTurnListener();
    stopTurnListener = undefined;
  }
  if (anyArmed && !stopActivityWatch) {
    // An agent with no hooks never reports `done`: its bytes going quiet is
    // the only end of its turn there is.
    stopActivityWatch = useActivityStore.subscribe(() => {
      for (const id of Object.keys(useMcpStaleStore.getState().armed)) {
        if (!mcpStaleTurnInFlight(id)) fireArmed(id);
      }
    });
  } else if (!anyArmed && stopActivityWatch) {
    stopActivityWatch();
    stopActivityWatch = undefined;
  }
}

/** Test seam. */
export function _resetMcpStaleForTest(): void {
  clearTimeout(toastTimer);
  toastTimer = undefined;
  announced.clear();
  spawnWaiters.clear();
  useMcpStaleStore.setState({ stale: {}, armed: {}, dismissed: {}, turns: {} });
  syncWatchers();
}
