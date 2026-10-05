import { describe, expect, it } from "vitest";
import { limitMeters, noteParts, parseUsageReport } from "../../../shared/usageReport";
import { BRAND } from "../../lib/brand";

/** The panel a real `claude -p "/usage" --output-format json` run returns, as
 * `services::agent_usage` hands it over. */
const CLAUDE_PANEL = [
  "Current session: 71% used · resets 6:20pm",
  "Current week (all models): 38% used · resets Mon 9am",
  "Current week (Fable): 12% used",
  "",
  "Last 24h: 41 requests · 6 sessions",
].join("\n");

describe(`${BRAND.display} Mobile agent usage panel`, () => {
  it("reads each window as a labelled bar, with its reset", () => {
    const report = parseUsageReport(CLAUDE_PANEL);
    expect(report.unparsed).toBe(false);
    expect(report.meters).toEqual([
      { label: "Current session", percent: 71, resets: "6:20pm" },
      { label: "Current week (all models)", percent: 38, resets: "Mon 9am" },
      { label: "Current week (Fable)", percent: 12, resets: undefined },
    ]);
  });

  it("keeps a dated reset whole — date, time and zone", () => {
    // What Claude Code 2.1.272 prints (2026-09-15). The comma inside the date
    // used to end the phrase, leaving `Sep 15` and no time at all.
    const report = parseUsageReport([
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 39% used · resets Sep 15, 10:30pm (Europe/Berlin)",
      "Current week (all models): 54% used · resets Sep 17, 2pm (Europe/Berlin)",
      "Current week (Fable): 94% used · resets Jan 3, 2027, 9am (Europe/Berlin)",
    ].join("\n"));
    expect(report.meters).toEqual([
      { label: "Current session", percent: 39, resets: "Sep 15, 10:30pm (Europe/Berlin)" },
      { label: "Current week (all models)", percent: 54, resets: "Sep 17, 2pm (Europe/Berlin)" },
      { label: "Current week (Fable)", percent: 94, resets: "Jan 3, 2027, 9am (Europe/Berlin)" },
    ]);
  });

  it("reads 2.1.284's contribution breakdown as notes, not as more windows", () => {
    // What Claude Code 2.1.284 prints (2026-09-29): the three windows, then a
    // "What's contributing" section whose `Label: name N%` lines are shares of
    // usage. Read as meters they became a 39% "Top subagents" bar on the phone.
    const report = parseUsageReport([
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 11% used · resets Sep 29, 11:40pm (Europe/Berlin)",
      "Current week (all models): 70% used · resets Oct 1, 2pm (Europe/Berlin)",
      "Current week (Fable): 74% used · resets Oct 1, 2pm (Europe/Berlin)",
      "",
      "What's contributing to your limits usage?",
      "Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.",
      "",
      "Last 24h · 3066 requests · 60 sessions",
      "  49% of your usage was at >150k context",
      "  47% of your usage came from subagent-heavy sessions",
      "  Top subagents: general-purpose 39%, Explore 1%",
      `  Top MCP servers: ${BRAND.slug}-git 1%`,
    ].join("\n"));
    expect(report.meters).toEqual([
      { label: "Current session", percent: 11, resets: "Sep 29, 11:40pm (Europe/Berlin)" },
      { label: "Current week (all models)", percent: 70, resets: "Oct 1, 2pm (Europe/Berlin)" },
      { label: "Current week (Fable)", percent: 74, resets: "Oct 1, 2pm (Europe/Berlin)" },
    ]);
    expect(report.notes).toContainEqual({ label: "Top subagents", value: "general-purpose 39%, Explore 1%" });
    expect(report.notes).toContainEqual({ label: undefined, value: "Last 24h · 3066 requests · 60 sessions" });
    const { session, week } = limitMeters(report);
    expect(session?.percent).toBe(11);
    expect(week?.label).toBe("Current week (all models)");
  });

  it("keeps a readout with no percentage as a note rather than dropping it", () => {
    const report = parseUsageReport(CLAUDE_PANEL);
    expect(report.notes).toEqual([{ label: "Last 24h", value: "41 requests · 6 sessions" }]);
    expect(noteParts("41 requests · 6 sessions")).toEqual(["41 requests", "6 sessions"]);
  });

  it("keeps decimals and clamps a figure outside 0–100", () => {
    const report = parseUsageReport("Current session: 45.2% used\nWeek: 140% used\nMonth: -3% used");
    expect(report.meters.map((meter) => meter.percent)).toEqual([45.2, 100, 0]);
  });

  it("reads a panel drawn inside a box, and drops the frame", () => {
    const report = parseUsageReport([
      "┌────────────────────────────┐",
      "│ Current session: 71% used  │",
      "└────────────────────────────┘",
    ].join("\n"));
    expect(report.meters).toEqual([{ label: "Current session", percent: 71, resets: undefined }]);
    expect(report.notes).toEqual([]);
  });

  it("reports a shape it does not recognize instead of inventing bars", () => {
    // What a CLI release that reworded the panel would look like. The sheet
    // shows the raw block for this, so nothing the CLI said is lost.
    const report = parseUsageReport("You have plenty of quota left this week.");
    expect(report.unparsed).toBe(true);
    expect(report.meters).toEqual([]);
    expect(report.notes).toEqual([{ label: undefined, value: "You have plenty of quota left this week." }]);
  });

  it("does not turn an unattributed percentage into a bar", () => {
    // A bar with no label is a figure the reader cannot attribute; it stays a
    // note, where it is still readable.
    const report = parseUsageReport("71% used");
    expect(report.meters).toEqual([]);
    expect(report.notes).toEqual([{ label: undefined, value: "71% used" }]);
  });

  it("survives an empty panel without throwing", () => {
    expect(parseUsageReport("")).toEqual({ meters: [], notes: [], unparsed: true });
  });

  it("picks the session window and the all-models week for the facts row", () => {
    const { session, week } = limitMeters(parseUsageReport(CLAUDE_PANEL));
    expect(session).toEqual({ label: "Current session", percent: 71, resets: "6:20pm" });
    expect(week?.label).toBe("Current week (all models)");
  });

  it("falls back to the only weekly line, and names nothing it cannot find", () => {
    expect(limitMeters(parseUsageReport("Current week (Fable): 12% used")).week?.percent).toBe(12);
    expect(limitMeters(parseUsageReport("Last 24h: 41 requests"))).toEqual({ session: undefined, week: undefined });
  });
});
