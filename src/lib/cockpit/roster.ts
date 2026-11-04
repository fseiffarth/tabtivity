import { sortAgentTabs, type AgentSort } from "../../../shared/agentSort";
import { turnDurationOf, type TurnDuration } from "../../../shared/turnDuration";
import type { TabEntry } from "../../stores/tabs";
import type { AgentRosterFacts, AgentRosterState } from "../agents/agentRoster";
import type { CockpitRosterMode, CockpitStateFilter } from "../../stores/cockpit";

/**
 * The cockpit roster (`docs/desktop_cockpit_plan.md`, View 1): every agent tab
 * of every hydrated scope as rows, filtered, sorted and grouped. Pure — the
 * caller reads the stores (`agentRosterFacts` per tab) and passes `now`.
 */

/** A scope a roster row belongs to, as the roster names and groups it. */
export interface RosterScope {
  id: string;
  /** The project's or box's name; root's own label. */
  name: string;
  kind: "project" | "box" | "root";
  /** The boxes a project belongs to (a box scope: its own id). */
  boxIds: readonly string[];
}

/** One agent tab, as the caller read it. */
export interface RosterInput {
  scope: RosterScope;
  tab: TabEntry;
  facts: AgentRosterFacts;
  /** The last prompt sent, one line. */
  lastPrompt?: string;
  /** An unsent draft in the composer (marked Not sent). */
  draft?: string;
  /** Its remote host's pool is down ("connect first"). */
  hostDown?: boolean;
  /** Where it runs: a remote host's label, or undefined for this machine. */
  host?: string;
  /** The next enabled schedule's time (ms epoch). */
  nextScheduleAt?: number;
}

export interface RosterRow extends RosterInput {
  ptyId: string;
  state: AgentRosterState;
  turn: TurnDuration | undefined;
}

export interface RosterGroup {
  /** A scope id, a box id, or `""` for the flat list / projects in no box. */
  id: string;
  label: string;
  rows: RosterRow[];
}

export interface RosterCounts {
  total: number;
  working: number;
  asking: number;
  interrupted: number;
  done: number;
  idle: number;
}

export interface RosterOptions {
  stateFilter: CockpitStateFilter;
  sort: AgentSort;
  mode: CockpitRosterMode;
  query: string;
  /** Only scopes in this box; null = all. */
  boxFilter: string | null;
  /** Only this scope; null = all. */
  scopeFilter: string | null;
}

export interface Roster {
  rows: RosterRow[];
  groups: RosterGroup[];
  /** Counts over every row the box / scope filters keep, before the state
   *  chips and the text filter — so a chip's number says what it would show. */
  counts: RosterCounts;
}

function matchesState(state: AgentRosterState, filter: CockpitStateFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return state !== "idle";
    case "asking":
      return state === "question";
    case "working":
      return state === "working";
    case "done":
      return state === "done" || state === "interrupted";
  }
}

function matchesQuery(row: RosterInput, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.tab.label, row.scope.name, row.lastPrompt ?? "", row.draft ?? "", row.facts.model ?? ""].some((field) =>
    field.toLowerCase().includes(q),
  );
}

export function rosterCounts(rows: readonly { state: AgentRosterState }[]): RosterCounts {
  const counts: RosterCounts = { total: rows.length, working: 0, asking: 0, interrupted: 0, done: 0, idle: 0 };
  for (const row of rows) {
    if (row.state === "working") counts.working += 1;
    else if (row.state === "question") counts.asking += 1;
    else if (row.state === "interrupted") counts.interrupted += 1;
    else if (row.state === "done") counts.done += 1;
    else counts.idle += 1;
  }
  return counts;
}

/** A row's sort keys, `shared/agentSort`'s: a question first, then an unread
 *  finished turn, then working (subagents at work count), then by the last
 *  finished turn. */
function sortKeys(row: RosterRow) {
  return {
    decision: row.state === "question",
    ready: row.state === "done",
    working: row.state === "working" || (row.facts.subagents ?? 0) > 0,
    workingAt: row.facts.workingAt,
    doneAt: row.turn && !row.turn.running ? row.turn.end : row.facts.doneAt,
  };
}

export function toRosterRow(input: RosterInput): RosterRow {
  const { facts } = input;
  return {
    ...input,
    ptyId: facts.ptyId,
    state: facts.state,
    turn: turnDurationOf({
      status: facts.state,
      turnStartedAt: facts.turnStartedAt,
      workingAt: facts.workingAt,
      doneAt: facts.doneAt,
      subagents: facts.subagents,
    }),
  };
}

/** The roster: box and scope filters, counts, then state chips, text, sort,
 *  and grouping. Groups keep the order their first row has after the sort. */
export function buildRoster(inputs: readonly RosterInput[], options: RosterOptions): Roster {
  const scoped = inputs
    .filter((row) => !options.boxFilter || row.scope.boxIds.includes(options.boxFilter))
    .filter((row) => !options.scopeFilter || row.scope.id === options.scopeFilter)
    .map(toRosterRow);
  const counts = rosterCounts(scoped);
  const shown = scoped.filter((row) => matchesState(row.state, options.stateFilter) && matchesQuery(row, options.query));
  const rows = sortAgentTabs(shown, options.sort, sortKeys);
  return { rows, groups: groupRows(rows, options.mode), counts };
}

function groupRows(rows: readonly RosterRow[], mode: CockpitRosterMode): RosterGroup[] {
  if (mode === "flat") return [{ id: "", label: "", rows: [...rows] }];
  const groups = new Map<string, RosterGroup>();
  for (const row of rows) {
    const id = mode === "project" ? row.scope.id : (row.scope.boxIds[0] ?? "");
    const label = mode === "project" ? row.scope.name : id;
    let group = groups.get(id);
    if (!group) {
      group = { id, label, rows: [] };
      groups.set(id, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

/** The row after (`+1`) or before (`-1`) `selected` in display order,
 *  wrapping; the first row when nothing (or a row no longer shown) is
 *  selected. The keyboard's j / k. */
export function stepSelection(rows: readonly { ptyId: string }[], selected: string | null, delta: 1 | -1): string | null {
  if (rows.length === 0) return null;
  const at = selected ? rows.findIndex((row) => row.ptyId === selected) : -1;
  if (at < 0) return rows[delta === 1 ? 0 : rows.length - 1].ptyId;
  return rows[(at + delta + rows.length) % rows.length].ptyId;
}
