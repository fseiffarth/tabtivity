/**
 * The prompts the desktop holds for a tab outlive the phone's chat view:
 * kept per tab, and on return checked against the desktop's schedules.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ScheduledPrompt } from "../../../mobile-web/src/api";
import { onHeldPatched, patchHeld, readHeld, stillHeld, writeHeld } from "../../../mobile-web/src/terminal/heldPrompts";
import { pendingPrompt, type PendingPrompt } from "../../../mobile-web/src/terminal/pendingPrompts";
import { storageKey } from "../../lib/brand";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const held = (id: number, text: string, heldId: string, sentAt = "2026-09-30T11:59:50.000Z"): PendingPrompt =>
  ({ ...pendingPrompt(id, text, []), held: heldId, sentAt });
const rule = (id: string, message: string, last?: ScheduledPrompt["last"]): ScheduledPrompt =>
  ({ id, enabled: true, message, rule: { type: "once", at: "2026-09-30T11:59:00.000Z" }, ...(last ? { last } : {}) });

describe("held prompt store", () => {
  beforeEach(() => localStorage.clear());

  it("keeps only held prompts, per tab", () => {
    writeHeld("a", [held(1, "one", "h1"), { ...pendingPrompt(2, "typed", []) }]);
    writeHeld("b", [held(3, "three", "h3")]);
    expect(readHeld("a").map((prompt) => prompt.text)).toEqual(["one"]);
    expect(readHeld("b").map((prompt) => prompt.text)).toEqual(["three"]);
    writeHeld("a", []);
    expect(readHeld("a")).toEqual([]);
    expect(readHeld("b")).toHaveLength(1);
  });

  it("ignores what is not a held prompt in storage", () => {
    localStorage.setItem(storageKey("mobile.heldPrompts"), JSON.stringify({ a: [{ id: "x" }, 5], b: "no" }));
    expect(readHeld("a")).toEqual([]);
    localStorage.setItem(storageKey("mobile.heldPrompts"), "{not json");
    expect(readHeld("a")).toEqual([]);
  });

  it("hands a late answer to whoever listens and to storage", () => {
    writeHeld("a", [held(1, "one", "")]);
    const heard: unknown[] = [];
    const stop = onHeldPatched((...args) => heard.push(args));
    patchHeld("a", 1, { held: "h1" });
    stop();
    patchHeld("a", 1, { held: "h2" });
    expect(heard).toEqual([["a", 1, { held: "h1" }]]);
    expect(readHeld("a")[0].held).toBe("h2");
    patchHeld("a", 1, { held: undefined });
    expect(readHeld("a")).toEqual([]);
  });
});

describe("stillHeld", () => {
  it("keeps what still waits and drops what is gone or long delivered", () => {
    const prompts = [held(1, "waits", "h1"), held(2, "gone", "h2"), held(3, "typed", "h3"), held(4, "just typed", "h4")];
    const kept = stillHeld(prompts, [
      rule("h1", "waits"),
      rule("h3", "typed", { occurrence: "o", result: "delivered", at: "2026-09-30T11:50:00.000Z" }),
      rule("h4", "just typed", { occurrence: "o", result: "delivered", at: "2026-09-30T11:59:40.000Z" }),
    ], NOW);
    expect(kept.map((prompt) => prompt.id)).toEqual([1, 4]);
  });

  it("gives an unanswered hold the id of a waiting rule with its words, once", () => {
    const kept = stillHeld([held(1, "again", ""), held(2, "again", "")], [rule("h1", "again")], NOW);
    expect(kept.map((prompt) => [prompt.id, prompt.held])).toEqual([[1, "h1"], [2, ""]]);
    const later = NOW + 5 * 60_000;
    expect(stillHeld([held(2, "again", "")], [], later)).toEqual([]);
  });

  it("does not hand out a rule another prompt already holds", () => {
    const kept = stillHeld([held(1, "same", "h1"), held(2, "same", "")], [rule("h1", "same")], NOW);
    expect(kept.map((prompt) => prompt.held)).toEqual(["h1", ""]);
  });
});
