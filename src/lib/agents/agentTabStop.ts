/**
 * Stopping idle agent tabs (`docs/done/agent_tab_stop_plan.md`): the pure half.
 * A stopped tab keeps its place, its label and its conversation; its process
 * is ended and the tab respawns with its CLI's resume when it is shown again.
 * The settings readers say when the sweep (`AgentTabStopHost`) stops a tab,
 * the guards why it may not, the ranking which goes first; everything in this
 * file is pure, so the policy is tested on its own.
 */
import type { Settings } from "../../types";

/** Live agent tabs kept before the least recently used are stopped. */
export const STOP_AGENT_TABS_CAP_DEFAULT = 30;
export const STOP_AGENT_TABS_CAP_CHOICES = [10, 20, 30, 50, 80] as const;
/** Minutes unused before a tab is stopped. */
export const STOP_AGENT_TABS_IDLE_DEFAULT_MIN = 120;
export const STOP_AGENT_TABS_IDLE_CHOICES_MIN = [30, 60, 120, 240, 480] as const;
/** Free memory (MiB) under which tabs are stopped. */
export const STOP_AGENT_TABS_MIN_FREE_DEFAULT_MB = 4096;
export const STOP_AGENT_TABS_MIN_FREE_CHOICES_MB = [2048, 4096, 8192] as const;

type StopSettings = Pick<Settings, "stop_agent_tabs_cap" | "stop_agent_tabs_idle_min" | "stop_agent_tabs_min_free_mb">;

/** A stored count as the readers apply it: absent or junk → `fallback`; `0` is off. */
function storedCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** A stored count: absent or junk → `fallback`, `0` → off (null). */
function stored(value: unknown, fallback: number): number | null {
  const n = storedCount(value, fallback);
  return n === 0 ? null : n;
}

/** A settings row's menu: the value the readers apply (`0` = off) and the
 *  choices, with that value among them when it is not one (set by hand or by
 *  an older list), so the row shows what the sweep does, never a blank. */
export function stopSettingMenu(value: unknown, fallback: number, choices: readonly number[]): { value: number; choices: number[] } {
  const current = storedCount(value, fallback);
  const all = current === 0 || choices.includes(current) ? [...choices] : [...choices, current].sort((a, b) => a - b);
  return { value: current, choices: all };
}

/** The cap on live agent tabs, or null when that trigger is off. */
export function stopAgentTabsCap(settings: StopSettings | null | undefined): number | null {
  return stored(settings?.stop_agent_tabs_cap, STOP_AGENT_TABS_CAP_DEFAULT);
}

/** How long a tab may sit unused before it is stopped, or null when off. */
export function stopAgentTabsIdleMs(settings: StopSettings | null | undefined): number | null {
  const min = stored(settings?.stop_agent_tabs_idle_min, STOP_AGENT_TABS_IDLE_DEFAULT_MIN);
  return min === null ? null : min * 60_000;
}

/** The free-memory floor in bytes, or null when that trigger is off. */
export function stopAgentTabsMinFreeBytes(settings: StopSettings | null | undefined): number | null {
  const mb = stored(settings?.stop_agent_tabs_min_free_mb, STOP_AGENT_TABS_MIN_FREE_DEFAULT_MB);
  return mb === null ? null : mb * 1024 * 1024;
}

// ── Which tabs may be stopped ───────────────────────────────────────────────

/** CLIs whose respawn resumes a recorded conversation id, never "the folder's
 *  latest" — stoppable once the backend says the tab has one
 *  (`agent_tab_resume_pinned`). Claude and Codex always resume by id; the
 *  `PINNED_ONLY` ones resume by id only while their hook record exists, else
 *  fall back to the folder's latest, which may be another tab's: the same
 *  backend check refuses those. Keyed by the tab's `cmd`. */
export const ID_RESUME_CLIS: ReadonlySet<string> = new Set(["claude", "codex"]);
export const PINNED_ONLY_CLIS: ReadonlySet<string> = new Set(["agy", "vibe", "opencode", "copilot", "muse", "cursor-agent"]);

/** Whether a tab's CLI is on the stop allow-list at all. Everything else —
 *  the `--continue`/`latest` CLIs (Gemini, Grok, Qwen, Droid), CLIs
 *  with no resume, custom agents — stays always-live. */
export function isStoppableCli(cmd: string): boolean {
  return ID_RESUME_CLIS.has(cmd) || PINNED_ONLY_CLIS.has(cmd);
}

/** Why a tab is not stopped now. The static ones hold for the tab's life
 *  (the restore reads only those); the rest are its state of the moment. */
export type StopBlocker =
  // static
  | "not_agent"
  | "cli"
  | "custom"
  | "no_session"
  | "reserved_scope"
  | "host_session"
  | "remote"
  | "container"
  | "auto_continue"
  | "sign_in"
  | "attach"
  // the moment
  | "stopped"
  | "turn"
  | "busy"
  | "decision"
  | "attention"
  | "background"
  | "shown"
  | "phone"
  | "queued"
  | "print"
  | "fresh"
  | "recent"
  // final-candidate checks (one IPC each)
  | "subagents"
  | "markup"
  | "no_conversation";

/** The tab fields the guards read. */
export interface StopTab {
  kind: string;
  cmd: string;
  sessionId?: string;
  /** Launched from a custom agent (`TabEntry.customAgent`). */
  customAgent?: boolean;
  /** A custom agent's own resume flag: only custom agents carry one, so it
   *  marks one launched before `customAgent` existed. */
  resumeArgs?: string[];
  hostSession?: boolean;
  autoContinue?: boolean;
  signIn?: unknown;
  cloud?: unknown;
  login?: unknown;
  tmuxAttach?: string;
  assistant?: unknown;
  stopped?: boolean;
}

/** Where the tab runs, as the caller resolved it from the projects store. */
export interface StopPlace {
  /** `root`/`assistant` (`storage::is_reserved_scope`'s set). */
  reservedScope: boolean;
  /** The agent runs on this machine (`runsLocally`). */
  local: boolean;
  /** In the project's container or a host-pinned VM. */
  inContainer: boolean;
}

/** What never changes while the tab lives: the restore reads only these. */
export function staticStopBlockers(tab: StopTab, place: StopPlace): StopBlocker[] {
  const out: StopBlocker[] = [];
  if (tab.kind !== "agent") out.push("not_agent");
  if (!isStoppableCli(tab.cmd)) out.push("cli");
  // A custom agent is decided by what it is, not the binary it names: its
  // wake would respawn on the built-in's resume args and drop its own.
  if (tab.customAgent || tab.resumeArgs?.length) out.push("custom");
  if (!tab.sessionId) out.push("no_session");
  if (place.reservedScope || tab.assistant) out.push("reserved_scope");
  if (tab.hostSession) out.push("host_session");
  if (!place.local) out.push("remote");
  if (place.inContainer) out.push("container");
  if (tab.autoContinue) out.push("auto_continue");
  if (tab.signIn || tab.cloud || tab.login) out.push("sign_in");
  if (tab.tmuxAttach) out.push("attach");
  return out;
}

/** Background work seen within this long blocks a stop. */
export const BACKGROUND_GRACE_MS = 10 * 60_000;
/** A phone that looked at the tab within this long blocks a stop. */
export const PHONE_GRACE_MS = 15 * 60_000;
/** A tab spawned or woken within this long is never stopped (anti-thrash). */
export const FRESH_GRACE_MS = 10 * 60_000;
/** A tab used (shown, prompted, a turn worked or finished) within this long is
 *  never stopped, by any trigger: the cap and low memory ignore the idle time,
 *  and without this floor a cap filled by tabs that can never be stopped took
 *  a tab used a minute ago. */
export const RECENT_USE_GRACE_MS = 10 * 60_000;
/** A scheduled prompt due within this long blocks a stop. */
export const SCHEDULE_SOON_MS = 15 * 60_000;

/** The tab's state of the moment, gathered by the host from the stores. The
 *  three final-candidate answers are undefined until asked. */
export interface StopSignals {
  now: number;
  /** `agentDeliveryReady(ptyId, …)`: the turn is done and settled, no job running. */
  deliveryReady: boolean;
  /** `busyByTab`: the bytes say it works (hookless CLIs). */
  busy: boolean;
  /** `attentionByTab === "decision"`. */
  decision: boolean;
  /** The agent asked through `tab_request_attention` and it stands. */
  askedAttention: boolean;
  /** `lastBackgroundWorkAt`. */
  backgroundAt?: number;
  /** On screen: visible, in a popout, or drawn by another view. */
  shown: boolean;
  /** The phone's last `tab_seen`/`tab_input` for the tab. */
  phoneSeenAt?: number;
  /** A send-now, held, proposed or soon-due prompt for the tab. */
  queuedPrompt: boolean;
  /** A print card of the tab is pending. */
  printPending: boolean;
  /** When this window last spawned or woke the tab. */
  startedAt?: number;
  /** When the tab was last used: {@link lastUsedOf} without its spawn. */
  lastUsedAt?: number;
  /** Subagents still running (Claude's transcript read). */
  runningSubagents?: number;
  /** A markup question of the tab is open. */
  markupAsk?: boolean;
  /** The backend: a respawn resumes the tab's own recorded conversation. */
  resumePinned?: boolean;
}

/** Every reason the tab may not be stopped now; empty means it may. */
export function stopBlockers(tab: StopTab, place: StopPlace, signals: StopSignals): StopBlocker[] {
  const out = staticStopBlockers(tab, place);
  const now = signals.now;
  if (tab.stopped) out.push("stopped");
  if (!signals.deliveryReady) out.push("turn");
  if (signals.busy) out.push("busy");
  if (signals.decision) out.push("decision");
  if (signals.askedAttention) out.push("attention");
  if (signals.backgroundAt !== undefined && now - signals.backgroundAt < BACKGROUND_GRACE_MS) out.push("background");
  if (signals.shown) out.push("shown");
  if (signals.phoneSeenAt !== undefined && now - signals.phoneSeenAt < PHONE_GRACE_MS) out.push("phone");
  if (signals.queuedPrompt) out.push("queued");
  if (signals.printPending) out.push("print");
  if (signals.startedAt !== undefined && now - signals.startedAt < FRESH_GRACE_MS) out.push("fresh");
  if (signals.lastUsedAt !== undefined && now - signals.lastUsedAt < RECENT_USE_GRACE_MS) out.push("recent");
  if ((signals.runningSubagents ?? 0) > 0) out.push("subagents");
  if (signals.markupAsk) out.push("markup");
  if (signals.resumePinned === false) out.push("no_conversation");
  return out;
}

// ── Ranking and picking ─────────────────────────────────────────────────────

/** One tab that passed the cheap guards. */
export interface StopCandidate {
  ptyId: string;
  scope: string;
  key: string;
  lastUsedAt: number;
  /** The tab's MCP lanes went stale (the MCP-reattach work): a respawn
   *  costs it nothing it still has, so it goes first. */
  mcpStale?: boolean;
}

/** The timestamps `lastUsedOf` takes the latest of. */
export interface UseMarks {
  lastShownAt?: number;
  lastUserInputAt?: number;
  lastDoneAt?: number;
  lastWorkingAt?: number;
  /** The tab's persisted mark, from before a relaunch. */
  restoredLastUsedAt?: number;
  startedAt?: number;
}

/** When the tab was last used: the latest of its being shown, typed into,
 *  finishing or working a turn, its restored mark and its spawn. Never its
 *  creation alone — an old tab used a minute ago is recent. */
export function lastUsedOf(marks: UseMarks): number {
  let best = 0;
  for (const at of [
    marks.lastShownAt,
    marks.lastUserInputAt,
    marks.lastDoneAt,
    marks.lastWorkingAt,
    marks.restoredLastUsedAt,
    marks.startedAt,
  ]) {
    if (typeof at === "number" && Number.isFinite(at) && at > best) best = at;
  }
  return best;
}

/** Least recently used first; ties keep their order. One key in front: a
 *  tab whose MCP lanes went stale ranks before every other. */
export function rankStopCandidates(candidates: readonly StopCandidate[]): StopCandidate[] {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        Number(!!b.c.mcpStale) - Number(!!a.c.mcpStale) ||
        a.c.lastUsedAt - b.c.lastUsedAt ||
        a.i - b.i,
    )
    .map(({ c }) => c);
}

export type StopTrigger = "memory" | "cap" | "idle";

export interface StopPick {
  candidate: StopCandidate;
  trigger: StopTrigger;
}

/** The most stops one sweep makes. */
export const STOPS_PER_TICK = 5;
/** The most stops one sweep makes for low memory. */
export const MEMORY_STOPS_PER_TICK = 3;

export interface PickStopsInput {
  /** Agent tabs with a running process now (any CLI, stoppable or not). */
  live: number;
  /** Tabs that passed the guards. */
  candidates: readonly StopCandidate[];
  cap: number | null;
  idleMs: number | null;
  now: number;
  /** Free memory is under the floor (false when the reading is missing). */
  memLow: boolean;
  perTick?: number;
}

/** Which candidates one sweep stops, and why: low memory first (the least
 *  recently used, idle or not), then the cap (the least recently used while
 *  more are live than it allows), then the idle time. */
export function pickStops(input: PickStopsInput): StopPick[] {
  const perTick = input.perTick ?? STOPS_PER_TICK;
  const ranked = rankStopCandidates(input.candidates);
  const picks: StopPick[] = [];
  const taken = new Set<string>();
  const take = (c: StopCandidate, trigger: StopTrigger) => {
    picks.push({ candidate: c, trigger });
    taken.add(c.ptyId);
  };
  if (input.memLow) {
    for (const c of ranked) {
      if (picks.length >= Math.min(perTick, MEMORY_STOPS_PER_TICK)) break;
      take(c, "memory");
    }
  }
  if (input.cap !== null) {
    let over = input.live - picks.length - input.cap;
    for (const c of ranked) {
      if (over <= 0 || picks.length >= perTick) break;
      if (taken.has(c.ptyId)) continue;
      take(c, "cap");
      over -= 1;
    }
  }
  if (input.idleMs !== null) {
    for (const c of ranked) {
      if (picks.length >= perTick) break;
      if (taken.has(c.ptyId) || input.now - c.lastUsedAt <= input.idleMs) continue;
      take(c, "idle");
    }
  }
  return picks;
}

/** Free memory from a `machine_load_snapshot`, or null when the reading is
 *  missing (never read as zero). */
export function freeMemoryBytes(
  snapshot: { supported?: boolean; mem_total_bytes?: number | null; mem_used_bytes?: number | null } | null | undefined,
): number | null {
  if (!snapshot || snapshot.supported === false) return null;
  const total = snapshot.mem_total_bytes;
  const used = snapshot.mem_used_bytes;
  if (typeof total !== "number" || typeof used !== "number" || !Number.isFinite(total) || !Number.isFinite(used) || total <= 0) {
    return null;
  }
  return Math.max(0, total - used);
}

// ── Restore ─────────────────────────────────────────────────────────────────

export interface RestoreWakeTab {
  ptyId: string;
  lastUsedAt: number;
  /** The tab's own tmux session is still running (a crash left it). */
  sessionAlive: boolean;
}

/** Which tabs that came back stopped wake after a relaunch: every one whose
 *  session is still running (its agent never stopped; reattaching is free),
 *  then the most recently used until `live` reaches the cap (none while
 *  memory is low). How long the app was closed is not idle time: the idle
 *  clock of a woken tab starts at its wake. */
export function pickRestoreWakes(input: {
  live: number;
  cap: number | null;
  memLow: boolean;
  stopped: readonly RestoreWakeTab[];
}): string[] {
  const wakes = input.stopped.filter((t) => t.sessionAlive).map((t) => t.ptyId);
  if (input.cap === null || input.memLow) return wakes;
  let live = input.live + wakes.length;
  const rest = input.stopped
    .filter((t) => !t.sessionAlive)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.lastUsedAt - a.t.lastUsedAt || a.i - b.i);
  for (const { t } of rest) {
    if (live >= input.cap) break;
    wakes.push(t.ptyId);
    live += 1;
  }
  return wakes;
}
