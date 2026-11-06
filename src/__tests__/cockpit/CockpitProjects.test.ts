/**
 * The Projects view's model (`lib/cockpit/projectCards`, C4): open projects
 * first, grouped by box, and a scope that is not hydrated shows no agent
 * counts — it is "not open", never "0 agents".
 */
import { describe, expect, it } from "vitest";
import {
  agentsSummary,
  buildProjectCards,
  filterGroups,
  hostsSummary,
  projectTotals,
  runHostLabel,
  splitGroups,
  toProjectCard,
  type ProjectCardInput,
} from "../../lib/cockpit/projectCards";
import type { RosterCounts } from "../../lib/cockpit/roster";
import { translate, type TranslationKey } from "../../lib/i18n";
import type { ConnState } from "../../stores/remote/remoteStatus";

const card = (id: string, extra: Partial<ProjectCardInput> = {}): ProjectCardInput => ({
  id,
  name: id,
  kind: "local",
  hostPinned: false,
  open: true,
  loaded: true,
  position: 0,
  boxIds: [],
  agentStates: [],
  hosts: [],
  pushPending: 0,
  ...extra,
});

describe("projectCards", () => {
  it("counts agents by state for a loaded scope only", () => {
    expect(toProjectCard(card("a", { agentStates: ["working", "question", "done", "idle"] })).counts).toEqual({
      total: 4, working: 1, asking: 1, interrupted: 0, done: 1, idle: 1,
    });
    expect(toProjectCard(card("b", { loaded: false, agentStates: undefined })).counts).toBeUndefined();
    expect(toProjectCard(card("c", { loaded: false, agentStates: ["working"] })).counts).toBeUndefined();
  });

  it("orders open projects first, then by pill position", () => {
    const groups = buildProjectCards(
      [card("z", { open: false, position: 1 }), card("y", { position: 30 }), card("x", { position: 20 })],
      { boxFilter: null, boxOrder: [] },
    );
    expect(groups.map((g) => g.cards.map((c) => c.id))).toEqual([["x", "y", "z"]]);
  });

  it("summarises agents by the non-zero parts and says nothing for no agents", () => {
    const counts = (c: Partial<RosterCounts>): RosterCounts => ({ total: 0, working: 0, asking: 0, interrupted: 0, done: 0, idle: 0, ...c });
    expect(agentsSummary(counts({ total: 17, working: 4 }))).toMatchObject({ total: 17, working: 4, asking: 0, state: "working" });
    expect(agentsSummary(counts({ total: 3, asking: 1, working: 1 }))?.state).toBe("question");
    expect(agentsSummary(counts({ total: 8, idle: 8 }))).toMatchObject({ working: 0, asking: 0, state: "idle" });
    expect(agentsSummary(counts({ total: 0 }))).toBeUndefined();
    expect(agentsSummary(undefined)).toBeUndefined();
  });

  it("summarises hosts as none, the single host, or how many are on", () => {
    const host = (id: string, ssh: ConnState) => ({ id, label: id, ssh, vpn: "off" as ConnState });
    expect(hostsSummary([])).toBeUndefined();
    expect(hostsSummary([host("a", "off")])).toEqual({ kind: "single", host: host("a", "off") });
    expect(hostsSummary([host("a", "off"), host("b", "connected"), host("c", "error")])).toEqual({ kind: "many", total: 3, on: 1 });
  });

  it("splits a box into rows and the not-open fold, filters by name, and counts distinct projects", () => {
    const groups = buildProjectCards(
      [
        card("alpha", { boxIds: ["b1"], agentStates: ["working"] }),
        card("beta", { boxIds: ["b1"], loaded: false, agentStates: undefined }),
        card("gamma", { boxIds: ["b1", "b2"], agentStates: ["idle"] }),
      ],
      { boxFilter: null, boxOrder: ["b1", "b2"] },
    );
    const split = splitGroups(groups);
    expect(split[0].rows.map((c) => c.id)).toEqual(["alpha", "gamma"]);
    expect(split[0].closed.map((c) => c.id)).toEqual(["beta"]);
    expect(projectTotals(groups)).toEqual({ projects: 3, open: 2, working: 1 });
    expect(filterGroups(groups, " ALP ").map((g) => g.cards.map((c) => c.id))).toEqual([["alpha"]]);
    expect(filterGroups(groups, "")).toHaveLength(2);
  });

  it("names the run host instead of printing its location", () => {
    const t = (key: TranslationKey) => translate("en", key);
    const project = { remote: { host: "gpu.example" }, compute_hosts: [{ id: "56bc0dda-1", label: "Big box", host: "big.example" }, { id: "h2", host: "h2.example" }] };
    expect(runHostLabel(project, undefined, t)).toBeUndefined();
    expect(runHostLabel(project, "local", t)).toBe("this machine");
    expect(runHostLabel(project, "remote", t)).toBe("gpu.example");
    expect(runHostLabel({}, "remote", t)).toBe("Primary");
    expect(runHostLabel(project, "host:56bc0dda-1", t)).toBe("Big box");
    expect(runHostLabel(project, "host:h2", t)).toBe("h2.example");
    expect(runHostLabel(project, "host:gone", t)).toBe("gone");
  });

  it("groups by box in box order, projects in no box last, and narrows to one box", () => {
    const inputs = [card("a", { boxIds: ["b2"] }), card("b", { boxIds: ["b1", "b2"] }), card("c")];
    const groups = buildProjectCards(inputs, { boxFilter: null, boxOrder: ["b1", "b2"] });
    expect(groups.map((g) => [g.boxId, g.cards.map((c) => c.id)])).toEqual([["b1", ["b"]], ["b2", ["a", "b"]], ["", ["c"]]]);
    expect(buildProjectCards(inputs, { boxFilter: "b2", boxOrder: ["b1", "b2"] })[0].cards.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
