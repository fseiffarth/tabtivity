import { describe, expect, it } from "vitest";
import { buildPromptChart, type PromptChartCard, type PromptChartStrand } from "../../lib/agents/prompt/chart";
import {
  dayClusters,
  formatTimelineInstant,
  packLanes,
  promptTargetColor,
  queueReorderWrites,
  queuedStack,
  sessionItems,
  shiftAnchor,
  snapTimelineTime,
  timelineDropAction,
  timelineHitZone,
  timelineItems,
  timelineTicks,
  timelineTimeAt,
  timelineWindow,
  timelineX,
  zoomTimelineView,
  hourAnchor,
  dayFold,
  TIMELINE_FOLD_PX,
  type TimelineRects,
} from "../../lib/agents/prompt/timeline";

const now = new Date(2026, 8, 4, 12, 2, 0);
const strand: PromptChartStrand = {
  id: "s1", label: "Claude", scheduleTargetId: "target-1", sessionId: "session-1", agent: "claude", schedules: [],
};

function card(over: Partial<PromptChartCard>): PromptChartCard {
  return {
    key: "k", id: "id", state: "draft", message: "m", tags: [], autoTags: [], strandId: "drafts", at: null, recurring: false, ...over,
  };
}

describe("timeline windows", () => {
  it("fits a day, a week and a month edge to edge", () => {
    const day = timelineWindow("day", "2026-09-04", 1);
    expect([day.start, day.end]).toEqual([new Date(2026, 8, 4), new Date(2026, 8, 5)]);
    expect(day.snapMinutes).toBe(5);
    const monday = timelineWindow("week", "2026-09-04", 1);
    expect([monday.start, monday.end]).toEqual([new Date(2026, 7, 31), new Date(2026, 8, 7)]);
    const sunday = timelineWindow("week", "2026-09-04", 0);
    expect(sunday.start).toEqual(new Date(2026, 7, 30));
    expect(sunday.snapMinutes).toBe(15);
    const month = timelineWindow("month", "2026-09-04", 1);
    expect([month.start, month.end]).toEqual([new Date(2026, 8, 1), new Date(2026, 9, 1)]);
    expect(month.snapMinutes).toBe(60);
  });

  it("steps the anchor by the view and clamps a month end", () => {
    expect(shiftAnchor("day", "2026-09-04", 1)).toBe("2026-09-05");
    expect(shiftAnchor("week", "2026-09-04", -1)).toBe("2026-08-28");
    expect(shiftAnchor("month", "2026-08-31", 1)).toBe("2026-09-30");
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-28");
  });

  it("fits an hour with a 5-minute grid and steps it across midnight", () => {
    const hour = timelineWindow("hour", "2026-09-04T13", 1);
    expect([hour.start, hour.end]).toEqual([new Date(2026, 8, 4, 13), new Date(2026, 8, 4, 14)]);
    expect(hour.snapMinutes).toBe(5);
    expect(timelineWindow("hour", "2026-09-04", 1).start).toEqual(new Date(2026, 8, 4, 0));
    const ticks = timelineTicks(hour, 1200);
    expect(ticks).toHaveLength(12);
    expect(ticks.filter((tick) => tick.major)).toHaveLength(4);
    expect(ticks[1].x).toBe(100);
    expect(snapTimelineTime(new Date(2026, 8, 4, 13, 7), hour)).toEqual(new Date(2026, 8, 4, 13, 5));
    expect(shiftAnchor("hour", "2026-09-04T23", 1)).toBe("2026-09-05T00");
    expect(shiftAnchor("hour", "2026-09-05T00", -1)).toBe("2026-09-04T23");
    // A date-only anchor names midnight.
    expect(shiftAnchor("hour", "2026-09-04", 1)).toBe("2026-09-04T01");
    expect(hourAnchor(new Date(2026, 8, 4, 9, 41))).toBe("2026-09-04T09");
  });

  it("maps x to time and back, and snaps per view", () => {
    const day = timelineWindow("day", "2026-09-04", 1);
    expect(timelineX(new Date(2026, 8, 4, 12), day, 2400)).toBe(1200);
    expect(timelineTimeAt(1200, day, 2400)).toEqual(new Date(2026, 8, 4, 12));
    expect(timelineTimeAt(-50, day, 2400)).toEqual(day.start);
    expect(timelineTimeAt(9999, day, 2400)).toEqual(day.end);
    expect(snapTimelineTime(new Date(2026, 8, 4, 12, 7), day)).toEqual(new Date(2026, 8, 4, 12, 5));
    expect(snapTimelineTime(new Date(2026, 8, 4, 12, 7), timelineWindow("week", "2026-09-04", 1))).toEqual(new Date(2026, 8, 4, 12, 0));
    expect(snapTimelineTime(new Date(2026, 8, 4, 12, 37), timelineWindow("month", "2026-09-04", 1))).toEqual(new Date(2026, 8, 4, 13, 0));
  });

  it("marks hours across a day, days plus quarters across a week, days across a month", () => {
    expect(timelineTicks(timelineWindow("day", "2026-09-04", 1), 2400)).toHaveLength(24);
    expect(timelineTicks(timelineWindow("day", "2026-09-04", 1), 2400).filter((tick) => tick.major)).toHaveLength(4);
    const week = timelineTicks(timelineWindow("week", "2026-09-04", 1), 700);
    expect(week.filter((tick) => tick.label === "day")).toHaveLength(7);
    expect(week.filter((tick) => tick.label === "hour")).toHaveLength(21);
    expect(timelineTicks(timelineWindow("month", "2026-09-04", 1), 3000)).toHaveLength(30);
  });

  it("labels every hour of a day wide enough to hold them, and the majors otherwise", () => {
    const day = timelineWindow("day", "2026-09-04", 1);
    // 36 px an hour is the line: 864 px labels all 24, 863 px only the four majors.
    expect(timelineTicks(day, 864).every((tick) => tick.labelled)).toBe(true);
    const narrow = timelineTicks(day, 863);
    expect(narrow.filter((tick) => tick.labelled).map((tick) => tick.at.getHours())).toEqual([0, 6, 12, 18]);
    // The other views keep the labels they had.
    expect(timelineTicks(timelineWindow("hour", "2026-09-04T13", 1), 300).every((tick) => tick.labelled)).toBe(true);
    const week = timelineTicks(timelineWindow("week", "2026-09-04", 1), 700);
    expect(week.filter((tick) => tick.labelled).every((tick) => tick.label === "day")).toBe(true);
    expect(week.filter((tick) => tick.labelled)).toHaveLength(7);
    const month = timelineTicks(timelineWindow("month", "2026-09-04", 1), 3000);
    expect(month.every((tick) => tick.labelled === tick.major)).toBe(true);
  });
});

describe("timeline items", () => {
  const week = timelineWindow("week", "2026-09-04", 1);

  it("places sent and once cards and expands a recurring rule per future occurrence", () => {
    const cards = buildPromptChart({
      now,
      strands: [{ ...strand, schedules: [
        { id: "once", enabled: true, message: "Once", rule: { type: "once", at: "2026-09-05T09:00" } },
        { id: "daily", enabled: true, message: "Daily", rule: { type: "daily", time: "08:00" } },
        { id: "wd", enabled: true, message: "Mon Fri", rule: { type: "weekdays", weekdays: [1, 5], time: "15:00" } },
        { id: "queued", enabled: true, message: "Waiting", rule: { type: "once", at: "2026-09-04T11:30" } },
      ] }],
      prompts: [
        { id: "draft", message: "Draft", created_at: "x", updated_at: "x" },
        { id: "chain", message: "Next", created_at: "x", updated_at: "x" },
      ],
      links: [{ id: "l", from: "draft", to: "chain", kind: "after", target: "target-1" }],
      history: [
        { id: "sent", message: "Done", created_at: "x", sent_at: "2026-09-03T11:00:00", tab_label: "Claude", session_id: "session-1", result: "delivered" },
        { id: "old", message: "Old", created_at: "x", sent_at: "2026-08-20T11:00:00", tab_label: "Claude", session_id: "session-1", result: "delivered" },
      ],
    });
    const items = timelineItems(cards, week, now);
    const byMessage = (message: string) => items.filter((item) => item.card.message === message);
    expect(byMessage("Done")).toHaveLength(1);
    expect(byMessage("Old")).toHaveLength(0);
    expect(byMessage("Once")).toHaveLength(1);
    // Friday 4th at 08:00 is past; Saturday and Sunday remain in the week.
    expect(byMessage("Daily").map((item) => item.at.getDate())).toEqual([5, 6]);
    expect(byMessage("Daily")[0].occurrence).toBeUndefined();
    expect(byMessage("Daily")[1].occurrence).toBe("2026-09-06T08:00");
    // Friday 15:00 is still ahead of 12:02.
    expect(byMessage("Mon Fri").map((item) => item.at.getDate())).toEqual([4]);
    expect(byMessage("Waiting")).toHaveLength(0);
    expect(byMessage("Draft")).toHaveLength(0);
    // A chained card waits on the board, never at its source's minute.
    expect(byMessage("Next")).toHaveLength(0);
    expect(items.map((item) => item.at.getTime())).toEqual([...items].map((item) => item.at.getTime()).sort());
    expect(queuedStack(cards, now).map((item) => item.message)).toEqual(["Waiting"]);
  });

  it("folds a session's sent prompts into one card spanning its first to its last", () => {
    const day = timelineWindow("day", "2026-09-04", 1);
    const sent = (id: string, hour: number, session?: string) => ({
      key: id,
      card: card({ id, key: id, state: "sent", strandId: "s1", history: { id, message: id, created_at: "x", sent_at: "x", tab_label: "Claude", session_id: session, result: "delivered" } }),
      at: new Date(2026, 8, 4, hour),
    });
    const rule = { key: "r", card: card({ id: "r", key: "r", state: "scheduled" }), at: new Date(2026, 8, 4, 14) };
    const grouped = sessionItems([sent("a", 9, "one"), sent("b", 10, "two"), sent("c", 12, "one"), rule]);
    // A lone prompt stays a card of its own, and a rule is never folded in.
    expect(grouped.map((item) => item.key)).toEqual(["session:one", "b", "r"]);
    expect(grouped[0].card.id).toBe("c");
    expect(grouped[0].members?.map((item) => item.key)).toEqual(["a", "c"]);
    // A 2400px day is 100px an hour: 9:00 to 12:00 is 300px, plus the tick room.
    // The session ended at 12:00 (x 1200), so it hangs left of it; the lone
    // prompt at 10:00 hangs left of 1000; the 14:00 rule starts at 1400.
    const packed = packLanes(grouped, day, 2400, now);
    expect(packed.items.map((item) => [item.key, item.x, item.width, item.lane, item.anchor])).toEqual([
      ["session:one", 894, 306, 0, "right"],
      ["b", 832, 168, 1, "right"],
      ["r", 1400, 168, 0, "left"],
    ]);
  });

  describe("anchoring", () => {
    // A 2400px day is 100px an hour; now (12:02) is at x 1203.3.
    const day = timelineWindow("day", "2026-09-04", 1);
    const at = (hour: number, minute = 0) => new Date(2026, 8, 4, hour, minute);
    const sent = (id: string, start: Date, filesAt?: Date) => ({
      key: id,
      card: card({
        id, key: id, state: "sent", at: start,
        history: { id, message: id, created_at: "x", sent_at: start.toISOString(), files_at: filesAt?.toISOString(), tab_label: "Claude", session_id: id, result: "delivered" },
      }),
      at: start,
    });
    const rule = (id: string, when: Date) => ({ key: id, card: card({ id, key: id, state: "scheduled", at: when }), at: when });
    const place = (items: Parameters<typeof packLanes>[0]) => packLanes(items, day, 2400, now).items;

    it("hangs a past card left of the x of its end, and a future card right of its start", () => {
      const [past] = place([sent("p", at(9), at(9, 30))]);
      expect([past.x, past.anchor]).toEqual([782, "right"]);
      const [future] = place([rule("f", at(14))]);
      expect([future.x, future.anchor]).toEqual([1400, "left"]);
    });

    it("ends a card without a finish at its own minute and wears a minimum bar", () => {
      const [unblamed] = place([sent("u", at(10))]);
      expect([unblamed.x, unblamed.barWidth]).toEqual([832, 4]);
    });

    it("draws the duration bar as wide as the turn took, never wider than the card", () => {
      const [short] = place([sent("s", at(9), at(9, 30))]);
      expect(short.barWidth).toBe(50);
      const [long] = place([sent("l", at(1), at(11))]);
      expect(long.barWidth).toBe(168);
      // A future card has no duration to show: just the corner.
      expect(place([rule("f", at(14))])[0].barWidth).toBe(4);
    });

    it("clamps a past card at the left edge and a future card inside the body", () => {
      const [early] = place([sent("e", at(0, 5), at(0, 10))]);
      expect(early.x).toBe(0);
      const [late] = place([rule("z", at(23, 50))]);
      expect(late.x).toBe(2400 - 168);
      // A card never starts left of the body when the body is narrower than a card.
      expect(packLanes([rule("n", at(14))], day, 100, now).items[0].x).toBe(0);
    });

    it("never lets a past card cross the now line", () => {
      // A turn that "ended" after now (clock skew) is not past: it is placed from its start.
      const [skewed] = place([sent("k", at(11), at(13))]);
      expect(skewed.anchor).toBe("left");
      // One that ended just before now hangs entirely left of it.
      const [recent] = place([sent("r", at(11), at(12))]);
      expect(recent.x + recent.width).toBeLessThanOrEqual(1203.4);
    });

    it("packs on the intervals the cards occupy, not on their start positions", () => {
      // 9:00 hangs over [732, 900]; 10:00 over [832, 1000]; a 14:00 rule over [1400, 1568].
      const packed = packLanes([sent("a", at(9)), sent("b", at(10)), rule("c", at(14))], day, 2400, now);
      expect(packed.items.map((item) => [item.key, item.lane])).toEqual([["a", 1], ["b", 0], ["c", 0]]);
      // Far enough apart that nothing overlaps: one lane.
      expect(packLanes([sent("a", at(6)), sent("b", at(9))], day, 2400, now).lanes).toBe(1);
    });

    it("measures a session card's ticks from its own left edge", () => {
      const grouped = sessionItems([sent("a", at(9)), { ...sent("c", at(11), at(11, 30)), key: "c" }].map((item) => ({
        ...item, card: { ...item.card, history: { ...item.card.history!, session_id: "one" } },
      })));
      const [session] = packLanes(grouped, day, 2400, now).items;
      // Ends at 11:30 (x 1150); spans 9:00..11:30 = 250px + the tick room.
      expect(session.width).toBe(256);
      expect(session.x).toBe(1150 - 256);
      const offsets = session.members!.map((member) => timelineX(member.at, day, 2400) - session.x);
      expect(offsets).toEqual([900 - 894, 1100 - 894]);
      expect(Math.max(...offsets)).toBeLessThan(session.width);
    });
  });

  it("packs overlapping cards into lanes and clusters a month by day", () => {
    const at = (hour: number, minute = 0) => new Date(2026, 8, 4, hour, minute);
    const day = timelineWindow("day", "2026-09-04", 1);
    const items = [
      { key: "a", card: card({ id: "a" }), at: at(9) },
      { key: "b", card: card({ id: "b" }), at: at(9, 30) },
      { key: "c", card: card({ id: "c" }), at: at(15) },
    ];
    const packed = packLanes(items, day, 2400, now, 168, 6);
    expect(packed.lanes).toBe(2);
    // Newest on top: the 9:30 card keeps lane 0 and the 9:00 one it overlaps steps down.
    expect(packed.items.map((item) => [item.key, item.lane])).toEqual([["a", 1], ["b", 0], ["c", 0]]);
    expect(packLanes(items, day, 24_000, now).lanes).toBe(1);
    const clusters = dayClusters(items, timelineWindow("month", "2026-09-04", 1), 3000);
    expect(clusters).toHaveLength(30);
    expect(clusters[3]).toMatchObject({ date: "2026-09-04", x: 300, width: 100 });
    expect(clusters[3].items).toHaveLength(3);
    expect(clusters[4].items).toHaveLength(0);
  });
});

describe("queue reorder", () => {
  const queued = (id: string, at: string, targetId = "t1") => card({
    key: `rule:s:${id}`, id, state: "queued", targetId,
    schedule: { id, enabled: true, message: id, rule: { type: "once", at } },
  });
  const a = queued("a", "2026-09-04T11:58");
  const b = queued("b", "2026-09-04T11:59");
  const c = queued("c", "2026-09-04T12:00");
  const elsewhere = queued("x", "2026-09-04T11:57", "t2");
  // Stored in an order the queue column does not show: a previous reorder
  // rewrote the minutes and left the rules where they were.
  const cards = [c, a, elsewhere, b];

  it("swaps a card with its neighbour in the order the queue column shows", () => {
    expect(queuedStack(cards, now).filter((item) => item.targetId === "t1").map((item) => item.id)).toEqual(["a", "b", "c"]);
    const swapped = [
      { id: "b", at: "2026-09-04T12:00" },
      { id: "a", at: "2026-09-04T12:01" },
      { id: "c", at: "2026-09-04T12:02" },
    ];
    expect(queueReorderWrites(cards, b, -1, now)).toEqual(swapped);
    expect(queueReorderWrites(cards, a, 1, now)).toEqual(swapped);
  });

  it("does nothing past either end, and never writes another tab's queue", () => {
    expect(queueReorderWrites(cards, a, -1, now)).toEqual([]);
    expect(queueReorderWrites(cards, c, 1, now)).toEqual([]);
    expect(queueReorderWrites(cards, elsewhere, -1, now)).toEqual([]);
    expect(queueReorderWrites(cards, b, 1, now).map((write) => write.id)).toEqual(["a", "c", "b"]);
    expect(queueReorderWrites(cards, card({ key: "draft" }), 1, now)).toEqual([]);
  });
});

describe("timeline drops", () => {
  const day = timelineWindow("day", "2026-09-04", 1);
  const rects: TimelineRects = {
    strip: { left: 0, top: 0, width: 1000, height: 60 },
    body: { left: 0, top: 100, width: 1000, height: 300 },
    nowBand: { left: 490, top: 100, width: 20, height: 300 },
  };

  it("names the zone under the pointer", () => {
    const zone = (x: number, y: number, scrollLeft = 0) => timelineHitZone({ x, y }, rects, day, 2400, scrollLeft, now);
    expect(zone(10, 10)).toEqual({ kind: "strip" });
    // The band itself is the send; the body left of the now line is the past.
    expect(zone(500, 200)).toEqual({ kind: "now" });
    expect(zone(100, 200)).toEqual({ kind: "past" });
    expect(zone(480, 200, 720)).toEqual({ kind: "past" });
    expect(zone(900, 200, 800)).toEqual({ kind: "time", at: new Date(2026, 8, 4, 17, 0) });
    expect(zone(900, 200, 807)).toEqual({ kind: "time", at: new Date(2026, 8, 4, 17, 5) });
    expect(zone(500, 600)).toEqual({ kind: "none" });
    expect(zone(1205, 200)).toEqual({ kind: "none" });
  });

  it("turns a zone into exactly one write", () => {
    const at = { kind: "time" as const, at: new Date(2026, 8, 4, 14, 5) };
    const draft = card({ state: "draft" });
    const aimed = card({ state: "draft", targetId: "t2" });
    const scheduled = card({ state: "scheduled", targetId: "t1", schedule: { id: "s", enabled: true, message: "m", rule: { type: "once", at: "2026-09-04T13:00" } } });
    const queued = card({ ...scheduled, state: "queued" });
    const recurring = card({ ...scheduled, recurring: true });
    const sent = card({ state: "sent", history: { id: "h", message: "m", created_at: "x", sent_at: "x", tab_label: "Claude", result: "delivered" } });
    const targets = ["t1", "t2"];
    expect(timelineDropAction(draft, at, targets)).toEqual({ type: "schedule", targetId: "t1", at: "2026-09-04T14:05" });
    expect(timelineDropAction(aimed, at, targets)).toEqual({ type: "schedule", targetId: "t2", at: "2026-09-04T14:05" });
    expect(timelineDropAction(card({ state: "draft", targetId: "gone" }), at, targets)).toEqual({ type: "schedule", targetId: "t1", at: "2026-09-04T14:05" });
    expect(timelineDropAction(draft, { kind: "now" }, targets)).toEqual({ type: "send", targetId: "t1" });
    // One card dropped on the past body is a send, as on the band.
    expect(timelineDropAction(draft, { kind: "past" }, targets)).toEqual({ type: "send", targetId: "t1" });
    expect(timelineDropAction(draft, { kind: "strip" }, targets)).toEqual({ type: "none" });
    // With no agent tab at all, the refusal says so.
    expect(timelineDropAction(draft, at, [])).toEqual({ type: "none", reason: "no-target" });
    expect(timelineDropAction(draft, { kind: "now" }, [])).toEqual({ type: "none", reason: "no-target" });
    expect(timelineDropAction(scheduled, at, targets)).toEqual({ type: "retime", targetId: "t1", fromTargetId: "t1", at: "2026-09-04T14:05" });
    expect(timelineDropAction(scheduled, { kind: "now" }, targets)).toEqual({ type: "send", targetId: "t1" });
    expect(timelineDropAction(scheduled, { kind: "past" }, targets)).toEqual({ type: "send", targetId: "t1" });
    expect(timelineDropAction(scheduled, { kind: "strip" }, targets)).toEqual({ type: "unschedule", fromTargetId: "t1" });
    expect(timelineDropAction(queued, { kind: "now" }, targets)).toEqual({ type: "none" });
    expect(timelineDropAction(queued, { kind: "past" }, targets)).toEqual({ type: "none" });
    // A tab already holding a rule takes no second one from a draft: an
    // unaimed draft goes to the first free tab, an aimed one is refused, and
    // a rule keeps its own tab.
    const occupied = new Set(["t1"]);
    expect(timelineDropAction(draft, at, targets, occupied)).toEqual({ type: "schedule", targetId: "t2", at: "2026-09-04T14:05" });
    expect(timelineDropAction(card({ state: "draft", targetId: "t1" }), at, targets, occupied)).toEqual({ type: "none", reason: "occupied" });
    expect(timelineDropAction(draft, { kind: "now" }, targets, new Set(targets))).toEqual({ type: "none", reason: "occupied" });
    expect(timelineDropAction(scheduled, at, targets, occupied)).toEqual({ type: "retime", targetId: "t1", fromTargetId: "t1", at: "2026-09-04T14:05" });
    expect(timelineDropAction(queued, at, targets)).toMatchObject({ type: "retime" });
    expect(timelineDropAction(recurring, at, targets)).toEqual({ type: "none" });
    expect(timelineDropAction(recurring, { kind: "strip" }, targets)).toEqual({ type: "none" });
    expect(timelineDropAction(sent, { kind: "strip" }, targets)).toEqual({ type: "none" });
    expect(timelineDropAction(sent, { kind: "now" }, targets)).toEqual({ type: "none" });
    expect(timelineDropAction(sent, at, targets)).toEqual({ type: "none" });
    expect(timelineDropAction(draft, { kind: "none" }, targets)).toEqual({ type: "none" });
  });

  it("colours targets by index and closed sessions grey", () => {
    expect(promptTargetColor(0)).toBe("var(--accent)");
    expect(promptTargetColor(5)).toBe(promptTargetColor(0));
    expect(promptTargetColor(-1)).toBe("var(--text-muted)");
  });
});

describe("timeline zoom and clock", () => {
  it("steps one view finer or coarser and stops at either end", () => {
    expect(zoomTimelineView("month", "in")).toBe("week");
    expect(zoomTimelineView("week", "in")).toBe("day");
    expect(zoomTimelineView("day", "in")).toBe("hour");
    expect(zoomTimelineView("hour", "in")).toBeNull();
    expect(zoomTimelineView("hour", "out")).toBe("day");
    expect(zoomTimelineView("day", "out")).toBe("week");
    expect(zoomTimelineView("week", "out")).toBe("month");
    expect(zoomTimelineView("month", "out")).toBeNull();
  });

  it("writes an instant in the app's clock, not the browser locale's", () => {
    const at = new Date(2026, 8, 14, 22, 2, 52);
    expect(formatTimelineInstant(at, "en", true)).toBe("Mon 14 Sep · 22:02");
    expect(formatTimelineInstant(at, "en", false)).toBe("Mon 14 Sep · 10:02 PM");
    expect(formatTimelineInstant(at, "en", true, false)).toBe("22:02");
    expect(formatTimelineInstant(at, "de", true)).toMatch(/^Mo\.? 14 Sep · 22:02$/u);
    expect(formatTimelineInstant(new Date(Number.NaN), "en", true)).toBe("");
  });
});

describe("the folded night", () => {
  const base = timelineWindow("day", "2026-09-04", 1);
  const at = (hour: number, minute = 0) => new Date(2026, 8, 4, hour, minute);
  const fold = dayFold(base, [at(12)])!;
  const folded = { ...base, fold };

  it("folds 00:00–06:00 to 40px only on an empty night of a Day view", () => {
    expect(fold).toEqual({ start: at(0), end: at(6), px: TIMELINE_FOLD_PX });
    // Anything in the stretch, its edges included, keeps the night open.
    expect(dayFold(base, [at(12), at(0)])).toBeUndefined();
    expect(dayFold(base, [at(5, 59)])).toBeUndefined();
    // 06:00 itself is outside the stretch.
    expect(dayFold(base, [at(6)])).toBeDefined();
    // Other views never fold.
    expect(dayFold(timelineWindow("week", "2026-09-04", 1), [])).toBeUndefined();
    expect(dayFold(timelineWindow("month", "2026-09-04", 1), [])).toBeUndefined();
    expect(dayFold(timelineWindow("hour", "2026-09-04T13", 1), [])).toBeUndefined();
  });

  it("draws the night as the first 40px and shares the rest in proportion", () => {
    // 1000px: 960px for 18 hours, 53.33px an hour.
    expect(timelineX(at(0), folded, 1000)).toBe(0);
    expect(timelineX(at(3), folded, 1000)).toBeCloseTo(20, 6);
    expect(timelineX(at(6), folded, 1000)).toBeCloseTo(40, 6);
    expect(timelineX(at(12), folded, 1000)).toBeCloseTo(40 + 6 * 53.3333333, 4);
    expect(timelineX(new Date(2026, 8, 5), folded, 1000)).toBeCloseTo(1000, 6);
    // Unfolded, nothing changes.
    expect(timelineX(at(12), base, 1000)).toBeCloseTo(500, 6);
  });

  it("round-trips x and time across the fold", () => {
    for (const time of [at(0), at(2, 30), at(5, 59), at(6), at(6, 1), at(12), at(18, 45), at(23, 59)]) {
      const back = timelineTimeAt(timelineX(time, folded, 1000), folded, 1000);
      expect(Math.abs(back.getTime() - time.getTime())).toBeLessThan(2);
    }
    for (const x of [0, 10, 39, 40, 41, 500, 999, 1000]) {
      expect(timelineX(timelineTimeAt(x, folded, 1000), folded, 1000)).toBeCloseTo(x, 4);
    }
    // Past either end clamps.
    expect(timelineTimeAt(-5, folded, 1000)).toEqual(at(0));
    expect(timelineTimeAt(2000, folded, 1000)).toEqual(new Date(2026, 8, 5));
  });

  it("snaps a pointer inside the block to the grid, like anywhere else", () => {
    // x 20 of the 40px block is 03:00; x 21 is 03:11.25, snapped to 03:10.
    expect(snapTimelineTime(timelineTimeAt(20, folded, 1000), folded)).toEqual(at(3));
    expect(snapTimelineTime(timelineTimeAt(21, folded, 1000), folded)).toEqual(at(3, 10));
    // And a hit inside the block lands on the same minute.
    const rects: TimelineRects = { strip: null, body: { left: 0, top: 0, width: 1000, height: 300 }, nowBand: null };
    const zone = timelineHitZone({ x: 20, y: 50 }, rects, folded, 1000, 0, new Date(2026, 8, 3));
    expect(zone).toEqual({ kind: "time", at: at(3) });
  });

  it("leaves no hour ticks inside the block, and labels the hours that remain", () => {
    const ticks = timelineTicks(folded, 1000);
    expect(ticks).toHaveLength(18);
    expect(ticks[0].at).toEqual(at(6));
    expect(ticks[0].x).toBeCloseTo(40, 6);
    expect(ticks[0].major).toBe(true);
    // 53px an hour is wide enough to label every one.
    expect(ticks.every((tick) => tick.labelled)).toBe(true);
    expect(timelineTicks(base, 1000)).toHaveLength(24);
  });
});
