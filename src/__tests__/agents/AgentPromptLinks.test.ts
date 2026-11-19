import { describe, expect, it } from "vitest";
import { afterLinkRefusal, edgeCommandChoices, nextAfter, prunePromptLinks, toggleEdgeCommand } from "../../lib/agents/prompt/links";

const links = [
  { id: "l1", from: "source", to: "target", kind: "after" as const, target: "tab-1" },
  { id: "l2", from: "source", to: "gone", kind: "related" as const },
];
const draft = { id: "target", message: "Review it", created_at: "a", updated_at: "a" };

describe("prompt links", () => {
  it("prunes invalid and dangling endpoints", () => {
    expect(prunePromptLinks(links, ["source", "target"])).toEqual([links[0]]);
  });

  it("resolves one after hop for a live target, including recurring record ids", () => {
    const rows = nextAfter("source@2026-09-04T09:00", links, [draft], [
      { scheduleTargetId: "tab-1", label: "Codex" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ prompt: draft, stopped: null, strand: { label: "Codex" } });
  });

  it("queues nothing for a paused edge, and resumes with the same edge once the flag is gone", () => {
    const strands = [{ scheduleTargetId: "tab-1", label: "Codex" }];
    const held = [{ ...links[0], paused: true }];
    expect(nextAfter("source", held, [draft], strands)).toEqual([]);
    expect(nextAfter("source@2026-09-04T09:00", held, [draft], strands)).toEqual([]);
    expect(nextAfter("source", [links[0]], [draft], strands)).toHaveLength(1);
  });

  it("keeps a closed target visible but refuses to nominate a strand", () => {
    expect(nextAfter("source", links, [draft], [])[0]).toMatchObject({ stopped: "closed", strand: undefined });
  });

  it("carries an edge's commands to the queued target and offers them as chips", () => {
    const withClear = [{ ...links[0], preface: ["/clear"] }];
    expect(nextAfter("source", withClear, [draft], [{ scheduleTargetId: "tab-1", label: "Codex" }])[0].link.preface).toEqual(["/clear"]);
    // A command the agent no longer offers stays a chip, so it can be switched off.
    expect(edgeCommandChoices(["/clear", "/compact"], ["/old"])).toEqual(["/clear", "/compact", "/old"]);
    expect(toggleEdgeCommand(["/clear", "/compact"], ["/compact"], "/clear")).toEqual(["/clear", "/compact"]);
    expect(toggleEdgeCommand(["/clear", "/compact"], ["/clear"], "/clear")).toEqual([]);
  });

  it("does not resolve a target that is no longer a draft", () => {
    expect(nextAfter("source", links, [], [{ scheduleTargetId: "tab-1", label: "Codex" }])).toEqual([]);
  });
});

describe("refusing an after link at write time", () => {
  const edge = (id: string, from: string, to: string, kind: "after" | "related" = "after") => ({ id, from, to, kind });
  const chain = [edge("ab", "a", "b"), edge("bc", "b", "c")];

  it("refuses a loop of two and of three", () => {
    expect(afterLinkRefusal(chain, "b", "a")).toBe("cycle");
    expect(afterLinkRefusal(chain, "c", "a")).toBe("cycle");
  });

  it("refuses a second incoming after edge", () => {
    expect(afterLinkRefusal(chain, "d", "c")).toBe("join");
    expect(afterLinkRefusal(chain, "c", "d")).toBeNull();
  });

  it("does not count related edges as a sequence", () => {
    expect(afterLinkRefusal([edge("dc", "d", "c", "related")], "e", "c")).toBeNull();
    expect(afterLinkRefusal([edge("ca", "c", "a", "related")], "a", "c")).toBeNull();
  });

  it("skips the edge being edited", () => {
    expect(afterLinkRefusal(chain, "b", "c", "bc")).toBeNull();
    expect(afterLinkRefusal(chain, "d", "c", "bc")).toBeNull();
    // Moved onto a prompt that already waits on another, it is still a join.
    expect(afterLinkRefusal(chain, "a", "c", "ab")).toBe("join");
  });

  it("lets an unchanged edge of a join written before the check be re-saved", () => {
    const joined = [edge("ac", "a", "c"), edge("bc", "b", "c")];
    expect(afterLinkRefusal(joined, "b", "c", "bc")).toBeNull();
    // A new edge, a changed end, or a related edge turned after still joins.
    expect(afterLinkRefusal(joined, "d", "c")).toBe("join");
    expect(afterLinkRefusal(joined, "d", "c", "bc")).toBe("join");
    expect(afterLinkRefusal([edge("ac", "a", "c"), edge("bc", "b", "c", "related")], "b", "c", "bc")).toBe("join");
    // A loop written before the check is re-saved the same way.
    expect(afterLinkRefusal([edge("ab", "a", "b"), edge("ba", "b", "a")], "b", "a", "ba")).toBeNull();
  });

  it("never counts the history's session-roll edges", () => {
    expect(afterLinkRefusal([edge("roll:c", "b", "c")], "a", "c")).toBeNull();
    expect(afterLinkRefusal([edge("roll:a", "c", "a")], "a", "c")).toBeNull();
    // Nor is a session-roll edge judged when it is the one being written.
    expect(afterLinkRefusal([edge("ab", "a", "b")], "b", "a", "roll:a")).toBeNull();
  });
});
