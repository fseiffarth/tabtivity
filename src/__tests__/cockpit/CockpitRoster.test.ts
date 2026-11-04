/**
 * The cockpit's pure layer (`lib/cockpit/roster`, `lib/cockpit/decisions`):
 * filters, sort, grouping and the keyboard step of the roster, and the rail's
 * groups, order and counts. Every reading carries its own stamps; nothing
 * reads a clock.
 */
import { describe, expect, it } from "vitest";
import { buildRoster, rosterCounts, stepSelection, toRosterRow, type RosterInput, type RosterOptions } from "../../lib/cockpit/roster";
import { buildDecisions, DECISION_GROUPS } from "../../lib/cockpit/decisions";
import type { AgentRosterFacts } from "../../lib/agents/agentRoster";
import type { TabEntry } from "../../stores/tabs";
import type { GitPushProposal } from "../../types";
import { turnDurationOf } from "../../../shared/turnDuration";

const scope = (id: string, boxIds: string[] = []) => ({ id, name: id.toUpperCase(), kind: "project" as const, boxIds });
function input(scopeId: string, key: string, facts: Partial<AgentRosterFacts>, extra: Partial<RosterInput> = {}, boxIds: string[] = []): RosterInput {
  const tab: TabEntry = { key, label: `tab-${key}`, cmd: "claude", cwd: "/p", kind: "agent" };
  return { scope: scope(scopeId, boxIds), tab, facts: { ptyId: `${scopeId}:${key}`, state: "idle", ...facts }, ...extra };
}
const OPTS: RosterOptions = { stateFilter: "all", sort: "lastWorking", mode: "flat", query: "", boxFilter: null, scopeFilter: null };

const rows = [
  input("p1", "a", { state: "done", doneAt: 100 }),
  input("p1", "b", { state: "question", workingAt: 50 }),
  input("p2", "c", { state: "working", workingAt: 200 }, {}, ["box1"]),
  input("p2", "d", { state: "idle", doneAt: 300 }, { lastPrompt: "rewrite the proof" }, ["box1"]),
  input("p3", "e", { state: "interrupted", workingAt: 80 }),
];

describe("buildRoster", () => {
  it("sorts a question first, then the ready tab, then the working tab, then by the last finished turn", () => {
    const roster = buildRoster(rows, OPTS);
    expect(roster.rows.map((r) => r.tab.key)).toEqual(["b", "a", "c", "d", "e"]);
  });

  it("hides idle tabs under Active and keeps the counts over every row", () => {
    const roster = buildRoster(rows, { ...OPTS, stateFilter: "active" });
    expect(roster.rows.map((r) => r.tab.key)).not.toContain("d");
    expect(roster.counts).toEqual({ total: 5, working: 1, asking: 1, interrupted: 1, done: 1, idle: 1 });
  });

  it("filters by state chip, text, box and scope", () => {
    expect(buildRoster(rows, { ...OPTS, stateFilter: "asking" }).rows.map((r) => r.tab.key)).toEqual(["b"]);
    expect(buildRoster(rows, { ...OPTS, stateFilter: "done" }).rows.map((r) => r.tab.key).sort()).toEqual(["a", "e"]);
    expect(buildRoster(rows, { ...OPTS, query: "PROOF" }).rows.map((r) => r.tab.key)).toEqual(["d"]);
    expect(buildRoster(rows, { ...OPTS, query: "p3" }).rows.map((r) => r.tab.key)).toEqual(["e"]);
    expect(buildRoster(rows, { ...OPTS, boxFilter: "box1" }).rows.map((r) => r.tab.key)).toEqual(["c", "d"]);
    expect(buildRoster(rows, { ...OPTS, scopeFilter: "p1" }).counts.total).toBe(2);
  });

  it("groups by project and by box in the sorted order", () => {
    expect(buildRoster(rows, { ...OPTS, mode: "project" }).groups.map((g) => g.id)).toEqual(["p1", "p2", "p3"]);
    const byBox = buildRoster(rows, { ...OPTS, mode: "box" }).groups;
    expect(byBox.map((g) => g.id)).toEqual(["", "box1"]);
    expect(byBox[1].rows.map((r) => r.tab.key)).toEqual(["c", "d"]);
  });

  it("reads a turn's length off the facts", () => {
    const row = toRosterRow(input("p1", "x", { state: "done", turnStartedAt: 1_000, doneAt: 61_000 }));
    expect(row.turn).toEqual({ ms: 60_000, running: false, end: 61_000 });
    expect(toRosterRow(input("p1", "y", { state: "working", turnStartedAt: 1_000, workingAt: 5_000 })).turn?.running).toBe(true);
    expect(rosterCounts([])).toEqual({ total: 0, working: 0, asking: 0, interrupted: 0, done: 0, idle: 0 });
  });
});

describe("turnDurationOf", () => {
  it("keeps a turn running while subagents work and has no end for an interrupted one", () => {
    expect(turnDurationOf({ status: "done", turnStartedAt: 10, workingAt: 90, subagents: 1 })).toEqual({ ms: 80, running: true, end: 90 });
    expect(turnDurationOf({ status: "interrupted", turnStartedAt: 10, workingAt: 5 })).toBeUndefined();
    expect(turnDurationOf({ status: "question", turnStartedAt: 10, workingAt: 30 })?.running).toBe(true);
  });
});

describe("stepSelection", () => {
  const list = [{ ptyId: "a" }, { ptyId: "b" }, { ptyId: "c" }];
  it("moves and wraps, and starts at an end with nothing selected", () => {
    expect(stepSelection(list, null, 1)).toBe("a");
    expect(stepSelection(list, null, -1)).toBe("c");
    expect(stepSelection(list, "b", 1)).toBe("c");
    expect(stepSelection(list, "c", 1)).toBe("a");
    expect(stepSelection(list, "a", -1)).toBe("c");
    expect(stepSelection(list, "gone", 1)).toBe("a");
    expect(stepSelection([], "a", 1)).toBeNull();
  });
});

describe("buildDecisions", () => {
  const all = buildRoster(
    [
      ...rows,
      input("p1", "q2", { state: "question", workingAt: 90 }),
      input("p2", "u2", { state: "done", doneAt: 400 }),
    ],
    OPTS,
  ).rows;
  const proposal = (id: string, status: GitPushProposal["status"]) => ({ id, status, commits: [] }) as unknown as GitPushProposal;

  it("draws only non-empty groups, in the rail's order, and says nothing is waiting when empty", () => {
    const empty = buildDecisions({ rows: [], push: [], schedules: [], approvals: 0, markup: [], alerts: [], names: {} });
    expect(empty.groups).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.topAsking).toBeNull();
    const d = buildDecisions({
      rows: all,
      push: [{ projectId: "p1", proposal: proposal("x", "pending") }, { projectId: "p1", proposal: proposal("y", "dismissed") }],
      schedules: [],
      approvals: 2,
      markup: [],
      alerts: [],
      names: {},
    });
    const order = d.groups.map((g) => g.id);
    expect(order).toEqual(["asking", "interrupted", "push", "approvals", "unseen"]);
    expect(order).toEqual(DECISION_GROUPS.filter((id) => order.includes(id)));
    expect(d.items.push.map((p) => p.proposal.id)).toEqual(["x"]);
  });

  it("puts the newest question first and makes it the pane's default", () => {
    const d = buildDecisions({ rows: all, push: [], schedules: [], approvals: 0, markup: [], alerts: [], names: {} });
    expect(d.items.asking.map((r) => r.tab.key)).toEqual(["q2", "b"]);
    expect(d.topAsking).toBe("p1:q2");
    expect(d.items.unseen.map((r) => r.tab.key)).toEqual(["u2", "a"]);
  });

  it("lists a finished push request without counting it", () => {
    const d = buildDecisions({ rows: [], push: [{ projectId: "p1", proposal: proposal("z", "pushed") }], schedules: [], approvals: 0, markup: [], alerts: [], names: {} });
    expect(d.groups).toEqual([{ id: "push", count: 0 }]);
    expect(d.total).toBe(0);
  });
});
