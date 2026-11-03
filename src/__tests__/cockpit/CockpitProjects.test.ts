/**
 * The Projects view's model (`lib/cockpit/projectCards`, C4): open projects
 * first, grouped by box, and a scope that is not hydrated shows no agent
 * counts — it is "not open", never "0 agents".
 */
import { describe, expect, it } from "vitest";
import { buildProjectCards, toProjectCard, type ProjectCardInput } from "../../lib/cockpit/projectCards";

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

  it("groups by box in box order, projects in no box last, and narrows to one box", () => {
    const inputs = [card("a", { boxIds: ["b2"] }), card("b", { boxIds: ["b1", "b2"] }), card("c")];
    const groups = buildProjectCards(inputs, { boxFilter: null, boxOrder: ["b1", "b2"] });
    expect(groups.map((g) => [g.boxId, g.cards.map((c) => c.id)])).toEqual([["b1", ["b"]], ["b2", ["a", "b"]], ["", ["c"]]]);
    expect(buildProjectCards(inputs, { boxFilter: "b2", boxOrder: ["b1", "b2"] })[0].cards.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
