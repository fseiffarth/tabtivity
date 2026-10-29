import { describe, expect, it } from "vitest";
import { limitWarnings } from "../../../mobile-web/src/terminal/sessionUsage";

const now = new Date("2026-10-29T10:00:00Z");
const later = now.getTime() / 1000 + 3600;

describe("limitWarnings", () => {
  it("names the smallest of Codex's steps each window has gone under", () => {
    expect(limitWarnings({ session: { used: 49, resetsAt: later } }, now)).toEqual([]);
    expect(limitWarnings({ session: { used: 50, resetsAt: later } }, now)).toEqual([{ window: "session", left: 50 }]);
    expect(limitWarnings({ session: { used: 91, resetsAt: later }, week: { used: 76 } }, now))
      .toEqual([{ window: "session", left: 10 }, { window: "week", left: 25 }]);
    expect(limitWarnings({ week: { used: 100 } }, now)).toEqual([{ window: "week", left: 5 }]);
  });

  it("warns of nothing once the window has reset, or without a reading", () => {
    expect(limitWarnings({ session: { used: 96, resetsAt: now.getTime() / 1000 - 1 } }, now)).toEqual([]);
    expect(limitWarnings(undefined, now)).toEqual([]);
    expect(limitWarnings({ contextLeft: 3 }, now)).toEqual([]);
  });
});
