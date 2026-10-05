/**
 * The agent warm-up cron (Manage CLIs → Scheduled warm-up), pure half.
 *
 * The problem it solves is not a terminal one: an agent CLI's usage allowance is
 * a **window that opens on the first message**, not a daily quota. Claude's is
 * five hours long, so a first prompt at 09:40 puts the boundary at 14:40 —
 * mid-afternoon, in the middle of whatever is being worked on — while the same
 * prompt sent at 09:00 puts it at 14:00. The window's start is the one part of
 * that anybody controls, and controlling it by hand means remembering to open a
 * tab and type something before starting work, which is exactly the kind of
 * thing nobody remembers on the morning it matters.
 *
 * So Tabtivity can do it: at each configured local time it sends one short message
 * ({@link AGENT_CRON_MESSAGE}) to that agent, and the window starts there.
 *
 * Three decisions are encoded here rather than in the UI.
 *
 * **A schedule is per agent, over a global default.** The times are a property
 * of the *allowance*, and different CLIs have different ones — so a single
 * global list could not say "Claude at 06:00, Codex at 08:30". But typing the
 * same two times into eight agents is worse, so an agent with no times of its
 * own follows the global list and only an agent that names times overrides it.
 * Participation is still per agent and defaults **off** ({@link
 * agentCronEnabled}): a schedule that fired for every installed CLI would open
 * a tab per agent and spend a window nobody asked for.
 *
 * **A missed time is not fired late.** The whole point is *which* five hours the
 * allowance covers, so a run at 10:20 for an 06:00 slot would spend the window
 * at the worst possible moment — later than the user would have started it
 * themselves. {@link dueAgentCronRuns} therefore only fires inside a short grace
 * window ({@link AGENT_CRON_GRACE_MIN}) after the time, which covers a tick lost
 * to a busy machine or a brief suspend and nothing else. A laptop asleep at
 * 06:00 simply misses that day.
 *
 * **Nothing here reads a clock.** `now` is a parameter at every entry point, for
 * `lib/todoBoard`'s reason: every interesting case is a boundary case (a minute
 * before the time, a minute after, midnight) and none of them is testable if the
 * clock is ambient.
 *
 * The impure half — asking the backend to run the agent's one-shot print mode
 * as a background process, with no terminal or tab — is `lib/agents/agentCronRun.ts`.
 * The scheduler that calls it is `components/layout/AgentCronHost.tsx`.
 */

/** The message sent to start the window. Deliberately fixed and deliberately
 *  trivial: it exists to be *sent*, not to be answered, and a configurable one
 *  would invite a prompt whose reply is then nobody's to read. */
export const AGENT_CRON_MESSAGE = "Test";

/** How late a run may still fire, in minutes. Covers a tick lost to a busy
 *  machine, a brief suspend, or a settings write landing between ticks — never
 *  a laptop that was closed at the time. */
export const AGENT_CRON_GRACE_MIN = 5;

/** One agent's participation and its own times. */
export interface AgentCronAgent {
  /** Whether this agent takes part. Absent is **off** — a schedule is never
   *  inferred for an agent the user did not tick. */
  enabled?: boolean;
  /** This agent's own times ("HH:MM", local). Absent or empty means it follows
   *  the global list, which is what keeps the common case one edit. */
  times?: string[];
}

/**
 * The whole feature's settings (`Settings.agent_cron`).
 *
 * Rides in the backend settings `extra` catch-all — no Rust field, the way
 * `side_panel_edge` does — because nothing in the backend reads it: the
 * scheduler, the times and the send are all frontend.
 */
export interface AgentCron {
  /** Master switch. Absent is off: no timer runs and nothing is scheduled. */
  enabled?: boolean;
  /** The global schedule, followed by every participating agent that names no
   *  times of its own. */
  times?: string[];
  /** Per-agent participation and overrides, keyed by the agent's CLI command
   *  (`AGENT_ITEMS[].cmd` — "claude", "codex", …), never by its label: the
   *  command is what launches the tab and what a saved schedule has to survive
   *  a rename of the brand. */
  agents?: Record<string, AgentCronAgent>;
}

/** One run that is due now: which agent, and the slot it belongs to. */
export interface AgentCronRun {
  /** The agent's CLI command. */
  cmd: string;
  /** The scheduled time ("HH:MM") this run answers, not the time it fires. */
  time: string;
  /** The stable id of this slot on this day — what a fired-record is keyed by,
   *  so a second tick inside the grace window does not send twice. */
  key: string;
}

/** Minutes since local midnight for an "HH:MM" string, or null when it is not
 *  one. Strict: two digits either side, a real hour and a real minute — a
 *  half-typed "1:" must not resolve to 01:00 and quietly schedule something. */
export function parseTimeOfDay(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes since local midnight as "HH:MM". Always two digits, always the
 *  24-hour face — this is a stored value, not a printed clock, so it is not
 *  `lib/timeFormat`'s question. */
export function formatTimeOfDay(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const m = String(wrapped % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/** Canonical form of a stored time list: every entry parsed (anything that is
 *  not a time is dropped rather than kept as a slot that can never fire),
 *  deduped, and sorted so the UI and the "next run" readout agree on order. */
export function normalizeTimes(times: readonly string[] | undefined): string[] {
  if (!times) return [];
  const minutes = new Set<number>();
  for (const entry of times) {
    const parsed = parseTimeOfDay(entry);
    if (parsed !== null) minutes.add(parsed);
  }
  return [...minutes].sort((a, b) => a - b).map(formatTimeOfDay);
}

/** The times an agent actually runs on: its own when it names any, the global
 *  list otherwise. Normalized, so a caller never has to. */
export function agentCronTimes(cron: AgentCron | undefined, cmd: string): string[] {
  const own = normalizeTimes(cron?.agents?.[cmd]?.times);
  return own.length > 0 ? own : normalizeTimes(cron?.times);
}

/** Whether this agent is scheduled at all: the master switch, this agent's own
 *  opt-in, and at least one time to fire on. An agent ticked on with no times
 *  anywhere is *not* scheduled — there is nothing to fire — which is what the
 *  panel's "no times yet" hint says out loud. */
export function agentCronEnabled(cron: AgentCron | undefined, cmd: string): boolean {
  if (!cron?.enabled) return false;
  if (cron.agents?.[cmd]?.enabled !== true) return false;
  return agentCronTimes(cron, cmd).length > 0;
}

/** Every agent command with a live schedule, in a stable order. */
export function scheduledAgentCmds(cron: AgentCron | undefined): string[] {
  return Object.keys(cron?.agents ?? {})
    .filter((cmd) => agentCronEnabled(cron, cmd))
    .sort();
}

/** Local calendar day as "YYYY-MM-DD" — the day a fired-record belongs to.
 *  Local, never UTC: the schedule is wall-clock, so a 23:30 slot has to belong
 *  to the day the user saw on the clock. */
export function localDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The id of one agent's one slot on one day. */
export function agentCronKey(cmd: string, day: string, time: string): string {
  return `${cmd}|${day}|${time}`;
}

/** Minutes since local midnight for a moment. */
function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * The runs due at `now` and not already fired.
 *
 * Due means the slot's time has passed *today* by no more than
 * {@link AGENT_CRON_GRACE_MIN} minutes. A slot the clock has run well past is
 * skipped for the day rather than fired late — see the module header.
 */
export function dueAgentCronRuns(
  cron: AgentCron | undefined,
  now: Date,
  fired: ReadonlySet<string>,
): AgentCronRun[] {
  const day = localDayKey(now);
  const nowMinutes = minutesOfDay(now);
  const due: AgentCronRun[] = [];
  for (const cmd of scheduledAgentCmds(cron)) {
    for (const time of agentCronTimes(cron, cmd)) {
      const at = parseTimeOfDay(time);
      if (at === null) continue;
      const late = nowMinutes - at;
      if (late < 0 || late > AGENT_CRON_GRACE_MIN) continue;
      const key = agentCronKey(cmd, day, time);
      if (fired.has(key)) continue;
      due.push({ cmd, time, key });
    }
  }
  return due;
}

/**
 * When this agent next fires, or null when it is not scheduled — the panel's
 * "Next: …" readout, and the only place the schedule is ever read forwards.
 *
 * The next slot strictly *after* the current minute, else the first slot
 * tomorrow. Strictly after, because the slot for the current minute has either
 * already fired or is about to, and naming it as "next" would leave the readout
 * showing a time that is passing as it is read.
 */
export function nextAgentCronRun(
  cron: AgentCron | undefined,
  cmd: string,
  now: Date,
): Date | null {
  if (!agentCronEnabled(cron, cmd)) return null;
  const times = agentCronTimes(cron, cmd)
    .map(parseTimeOfDay)
    .filter((m): m is number => m !== null);
  if (times.length === 0) return null;
  const nowMinutes = minutesOfDay(now);
  const laterToday = times.find((m) => m > nowMinutes);
  const at = new Date(now);
  at.setSeconds(0, 0);
  if (laterToday !== undefined) {
    at.setHours(Math.floor(laterToday / 60), laterToday % 60);
    return at;
  }
  at.setDate(at.getDate() + 1);
  at.setHours(Math.floor(times[0] / 60), times[0] % 60);
  return at;
}

/** The master switch, flipped. */
export function withCronEnabled(cron: AgentCron | undefined, enabled: boolean): AgentCron {
  return { ...cron, enabled };
}

/** The global time list, replaced (normalized on the way in, so what is stored
 *  is what the readouts read). */
export function withGlobalTimes(cron: AgentCron | undefined, times: readonly string[]): AgentCron {
  return { ...cron, times: normalizeTimes(times) };
}

/** One agent's record, replaced. An agent that ends up carrying nothing — not
 *  participating and naming no times — is dropped rather than stored as an
 *  empty object, so `agents` holds only real answers. */
function withAgent(
  cron: AgentCron | undefined,
  cmd: string,
  next: AgentCronAgent,
): AgentCron {
  const agents = { ...(cron?.agents ?? {}) };
  if (next.enabled !== true && (next.times ?? []).length === 0) delete agents[cmd];
  else agents[cmd] = next;
  return { ...cron, agents };
}

/** This agent's participation, flipped. */
export function withAgentCronEnabled(
  cron: AgentCron | undefined,
  cmd: string,
  enabled: boolean,
): AgentCron {
  const current = cron?.agents?.[cmd] ?? {};
  return withAgent(cron, cmd, { ...current, enabled });
}

/** Every agent in `cmds` switched on or off at once — the card's "All agents"
 *  toggle. A bulk flip and nothing more: it writes the same per-agent
 *  `enabled` the single toggles write, so there is no second "all" mode for
 *  the scheduler to reconcile against the list, and each agent's own times
 *  survive the flip. */
export function withAllAgentsEnabled(
  cron: AgentCron | undefined,
  cmds: readonly string[],
  enabled: boolean,
): AgentCron {
  return cmds.reduce<AgentCron>((acc, cmd) => withAgentCronEnabled(acc, cmd, enabled), cron ?? {});
}

/** True when every agent in `cmds` is switched on — what the "All agents"
 *  toggle shows. An empty list is *not* "all on": there is nothing to be on. */
export function allAgentsEnabled(cron: AgentCron | undefined, cmds: readonly string[]): boolean {
  return cmds.length > 0 && cmds.every((cmd) => cron?.agents?.[cmd]?.enabled === true);
}

/** This agent's own times, replaced. An empty list is a real answer — it hands
 *  the agent back to the global schedule. */
export function withAgentCronTimes(
  cron: AgentCron | undefined,
  cmd: string,
  times: readonly string[],
): AgentCron {
  const current = cron?.agents?.[cmd] ?? {};
  return withAgent(cron, cmd, { ...current, times: normalizeTimes(times) });
}

/** Add one time to a list, keeping it canonical. Adding one already there is a
 *  no-op rather than a duplicate slot. */
export function addTime(times: readonly string[], time: string): string[] {
  return normalizeTimes([...times, time]);
}

/** Drop one time from a list. */
export function removeTime(times: readonly string[], time: string): string[] {
  return normalizeTimes(times.filter((t) => t !== time));
}
