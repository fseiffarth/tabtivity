/**
 * Which finished agent tabs this phone has opened (`seenDone.ts`): Home's
 * Needs you lists a done tab until it is opened here, and again once it has
 * finished another turn. The store is this phone's own, capped, and reads
 * anything it cannot trust as "nothing seen".
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SEEN_DONE_CAP, isUnseenDone, markDoneSeen, markInterruptedSeen, parseSeenDone, readSeenDone, readSeenInterrupted, showsStatusBadge, withSeen, withoutResumed } from "../../../mobile-web/src/seenDone";
import { storageKey } from "../../lib/brand";

beforeEach(() => {
  localStorage.clear();
});

describe("seen finished tabs", () => {
  it("lists a finished tab until it is seen, and again after a newer turn", () => {
    const tab = { id: "t1", agent_status: "done", done_at: 1_000 };
    expect(isUnseenDone([], tab)).toBe(true);
    const seen = withSeen([], "t1", 1_000);
    expect(isUnseenDone(seen, tab)).toBe(false);
    expect(isUnseenDone(seen, { ...tab, done_at: 2_000 })).toBe(true);
  });

  it("only ever lists a done tab", () => {
    expect(isUnseenDone([], { id: "t1", agent_status: "working", done_at: 1 })).toBe(false);
    expect(isUnseenDone([], { id: "t1", agent_status: "question" })).toBe(false);
    expect(isUnseenDone([], { id: "t1" })).toBe(false);
  });

  it("sees a tab with no finish time for good", () => {
    const seen = withSeen([], "t1", undefined);
    expect(isUnseenDone(seen, { id: "t1", agent_status: "done" })).toBe(false);
  });

  it("moves a re-seen tab to the front and keeps only the newest marks", () => {
    let seen = withSeen(withSeen([], "a", 1), "b", 2);
    seen = withSeen(seen, "a", 3);
    expect(seen).toEqual([["a", 3], ["b", 2]]);
    for (let i = 0; i < SEEN_DONE_CAP + 10; i++) seen = withSeen(seen, `t${i}`, i);
    expect(seen).toHaveLength(SEEN_DONE_CAP);
    expect(seen[0]).toEqual([`t${SEEN_DONE_CAP + 9}`, SEEN_DONE_CAP + 9]);
    expect(seen.some(([id]) => id === "a")).toBe(false);
  });

  it("stores the marks on the phone and reads them back", () => {
    markDoneSeen("t1", 5);
    markDoneSeen("t2", 6);
    expect(readSeenDone()).toEqual([["t2", 6], ["t1", 5]]);
    expect(JSON.parse(localStorage.getItem(storageKey("mobile.seenDone")) ?? "[]")).toEqual([["t2", 6], ["t1", 5]]);
  });

  it("reads anything it cannot trust as nothing seen", () => {
    expect(parseSeenDone(null)).toEqual([]);
    expect(parseSeenDone("not json")).toEqual([]);
    expect(parseSeenDone("{\"t1\":5}")).toEqual([]);
    expect(parseSeenDone("[[\"t1\",5],[\"t2\",\"x\"],[3,4],[\"t3\"]]")).toEqual([["t1", 5]]);
  });
});

describe("the card's state badge", () => {
  beforeEach(() => localStorage.clear());

  it("goes once a finished or interrupted tab has been opened, and only then", () => {
    const done = { id: "t1", agent_status: "done", done_at: 5 };
    const stopped = { id: "t2", agent_status: "interrupted" };
    expect(showsStatusBadge([], [], done)).toBe(true);
    expect(showsStatusBadge([["t1", 5]], [], done)).toBe(false);
    expect(showsStatusBadge([["t1", 5]], [], { ...done, done_at: 9 })).toBe(true);
    expect(showsStatusBadge([], [], stopped)).toBe(true);
    expect(showsStatusBadge([], ["t2"], stopped)).toBe(false);
    expect(showsStatusBadge([], [], { id: "t3", agent_status: "working" })).toBe(true);
  });

  it("forgets an interrupted tab once it runs again", () => {
    markInterruptedSeen("t2");
    expect(readSeenInterrupted()).toEqual(["t2"]);
    expect(withoutResumed(["t2"], [{ id: "t2", agent_status: "interrupted" }])).toEqual(["t2"]);
    expect(withoutResumed(["t2"], [{ id: "t2", agent_status: "working" }])).toEqual([]);
  });
});
