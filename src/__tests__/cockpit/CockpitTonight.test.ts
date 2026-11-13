/**
 * Tonight's model (`lib/cockpit/tonight`, C5): the bucket boundaries
 * (five minutes, the hour, the next midnight, the one after), recurrence,
 * disabled rules, the warm-up slots, and the away recap's window.
 */
import { describe, expect, it } from "vitest";
import { awaySince, buildAway, buildComingUp, scheduleItems, tonightBucket, warmupItems, type ComingUpItem } from "../../lib/cockpit/tonight";
import { toRosterRow } from "../../lib/cockpit/roster";
import type { ScheduledAgentPrompt } from "../../lib/agents/agentSchedule";
import type { GitPushProposal } from "../../types";
import type { RootProposal } from "../../stores/rootReview";

/** 2026-11-03 20:00 local. */
const NOW = new Date(2026, 10, 3, 20, 0, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m, 0).getTime();
const where = { scope: "p1", scopeName: "P1", tabLabel: "claude", ptyId: "p1:a", targetId: "t1" };

describe("tonightBucket", () => {
  it("splits at five minutes, the hour, the next midnight and the one after", () => {
    expect(tonightBucket(NOW - 60_000, NOW)).toBe("now");
    expect(tonightBucket(NOW + 5 * 60_000, NOW)).toBe("now");
    expect(tonightBucket(NOW + 6 * 60_000, NOW)).toBe("nextHour");
    expect(tonightBucket(NOW + 60 * 60_000, NOW)).toBe("nextHour");
    expect(tonightBucket(at(3, 23, 59), NOW)).toBe("tonight");
    expect(tonightBucket(at(4, 0, 0), NOW)).toBe("tomorrow");
    expect(tonightBucket(at(4, 23, 59), NOW)).toBe("tomorrow");
    expect(tonightBucket(at(5, 0, 0), NOW)).toBe("later");
  });
});

describe("scheduleItems", () => {
  const rule = (id: string, extra: Partial<ScheduledAgentPrompt>): ScheduledAgentPrompt =>
    ({ id, enabled: true, message: `m-${id}`, rule: { type: "once", at: "2026-11-03T22:00" }, ...extra }) as ScheduledAgentPrompt;

  it("gives an enabled rule its next run and a disabled one none", () => {
    const items = scheduleItems([rule("on", {}), rule("off", { enabled: false })], where, NOW);
    expect(items.map((i) => i.id)).toEqual(["schedule:t1:on"]);
    expect(items[0].at).toBe(at(3, 22));
    expect(items[0].recurring).toBe(false);
  });

  it("puts a daily rule's next run past midnight under tomorrow", () => {
    const daily = rule("d", { rule: { type: "daily", time: "07:30" } as ScheduledAgentPrompt["rule"] });
    const [item] = scheduleItems([daily], where, NOW);
    expect(item.recurring).toBe(true);
    expect(item.at).toBe(at(4, 7, 30));
    expect(tonightBucket(item.at!, NOW)).toBe("tomorrow");
  });
});

describe("buildComingUp", () => {
  it("orders buckets and items, keeps standing items under Now, and drops what is past the horizon", () => {
    const items: ComingUpItem[] = [
      { id: "late", kind: "schedule", at: at(3, 23), title: "late" },
      { id: "soon", kind: "schedule", at: at(3, 22), title: "soon" },
      { id: "auto", kind: "autoContinue", at: null, title: "auto" },
      { id: "far", kind: "event", at: at(20, 9), title: "far" },
      { id: "tmw", kind: "warmup", at: at(4, 6), title: "tmw" },
    ];
    const groups = buildComingUp(items, NOW);
    expect(groups.map((g) => [g.bucket, g.items.map((i) => i.id)])).toEqual([
      ["now", ["auto"]],
      ["tonight", ["soon", "late"]],
      ["tomorrow", ["tmw"]],
    ]);
  });
});

describe("warmupItems", () => {
  it("takes today's slot while it is ahead, else tomorrow's", () => {
    const cron = { enabled: true, times: ["06:00", "21:00"], agents: { claude: { enabled: true } } };
    const items = warmupItems(cron, NOW);
    expect(items.map((i) => i.at).sort()).toEqual([at(3, 21), at(4, 6)].sort());
    expect(warmupItems({ enabled: false, times: ["06:00"], agents: { claude: { enabled: true } } }, NOW)).toEqual([]);
  });
});

describe("the away recap", () => {
  it("starts at the later of the last close and the last input, else twelve hours back", () => {
    expect(awaySince(100, 200, NOW)).toBe(200);
    expect(awaySince(300, 200, NOW)).toBe(300);
    expect(awaySince(null, undefined, NOW)).toBe(NOW - 12 * 3_600_000);
  });

  it("lists what finished, was cut off, landed, fired and was written since then", () => {
    const tab = { key: "a", label: "a", cmd: "claude", cwd: "/", kind: "agent" as const };
    const scope = { id: "p1", name: "P1", kind: "project" as const, boxIds: [] };
    const row = (key: string, facts: object) => toRosterRow({ scope, tab: { ...tab, key }, facts: { ptyId: `p1:${key}`, state: "idle", ...facts } });
    const since = at(3, 12);
    const recap = buildAway({
      since,
      rows: [
        row("old", { state: "done", doneAt: at(3, 11) }),
        row("new", { state: "done", doneAt: at(3, 14) }),
        row("read", { state: "idle", doneAt: at(3, 15) }),
        row("cut", { state: "interrupted", workingAt: at(3, 13) }),
      ],
      schedules: [
        { rule: { id: "f", enabled: true, message: "x", rule: { type: "once", at: "" }, last: { occurrence: "", result: "sent", at: new Date(at(3, 13)).toISOString() } } as unknown as ScheduledAgentPrompt, scopeName: "P1", tabLabel: "a", targetId: "t" },
      ],
      push: [{ projectId: "p1", proposal: { id: "p", status: "pushed", created_at: new Date(at(3, 13)).toISOString() } as GitPushProposal }],
      root: [{ id: "r", status: "applied", created: new Date(at(3, 13)).toISOString(), tool: "calendar_add" } as RootProposal],
    });
    expect(recap.finished.map((r) => r.tab.key)).toEqual(["read", "new"]);
    expect(recap.cutOff.map((r) => r.tab.key)).toEqual(["cut"]);
    expect(recap.pushes).toHaveLength(1);
    expect(recap.fired).toHaveLength(1);
    expect(recap.rootWrites).toHaveLength(1);
    expect(recap.empty).toBe(false);
    expect(buildAway({ since: NOW, rows: [], schedules: [], push: [], root: [] }).empty).toBe(true);
  });
});
