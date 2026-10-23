import { describe, expect, it } from "vitest";
import { readContextUsage } from "../../lib/agents/contextUsage";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";

const lines = (rows: string[]) => rows.map((text) => ({ text }));
/** The rows through the desktop's own buffer reader, as the panel reads them. */
const screen = (rows: string[]) => readableScreen({
  length: rows.length,
  getLine: (row: number) => rows[row] === undefined ? undefined : { translateToString: () => rows[row] },
}, 400, { plain: true }).lines;

// Claude Code 2.1.309, 140 columns (lists shortened).
const CLAUDE = [
  "❯ /context",
  "  ⎿  Context Usage",
  "     ⛀ ⛁ ⛁ ⛁ ⛁ ⛀ ⛀ ⛀ ⛀ ⛁ ⛀ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   Opus 5.5",
  "     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   claude-opus-5-5",
  "     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   31.2k/1m tokens (3%)",
  "     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶",
  "     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   Estimated usage by category",
  "     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System prompt: 2.9k tokens (0.3%)",
  "     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System tools: 19.2k tokens (1.9%)",
  "     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ MCP tools: 744 tokens (0.1%)",
  "     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ MCP server instructions: 717 tokens (0.1%)",
  "     ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝   ⛁ Custom agents: 1.3k tokens (0.1%)",
  "                                               ⛁ Memory files: 385 tokens (0.0%)",
  "                                               ⛁ Skills: 5.9k tokens (0.6%)",
  "                                               ⛁ Messages: 10 tokens (0.0%)",
  "                                               ⛶ Free space: 935.8k (93.6%)",
  "                                               ⛝ Autocompact buffer: 33k tokens (3.3%)",
  "",
  "     Auto-compact window: 1m tokens",
  "",
  "     MCP tools · /mcp (loaded on-demand)",
  "",
  "     Loaded",
  "     ├ mcp__claude_ai_Claude_Docs__batch: 183 tokens",
  "     └ mcp__claude_ai_Claude_Docs__update: 330 tokens",
  "",
  "     Available",
  "     ├ mcp__claude_ai_Claude_Docs__create",
  "     └ mcp__claude_ai_Claude_Docs__read",
  "",
  "     Memory files · /memory",
  "     ├ ~/.claude/CLAUDE.md: 14 tokens",
  "     └ ~/.claude/RTK.md: 371 tokens",
  "",
  "     Skills · /skills",
  "",
  "     Built-in",
  "     ├ dataviz: ~480 tokens",
  "     └ init: ~20 tokens",
  "",
  "──────────────────────────────────────────────────",
  "❯ ",
  "──────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];

// GitHub Copilot CLI 1.0.102.
const COPILOT = [
  " ● Context Usage",
  "",
  "   ○ ○ ◌ ◌ ◌ ● · · · ·   GitHub Copilot • GPT-5.6 Terra · 19k/272k tokens (7%)",
  "   · · · · · · · · · ·   ○ System Prompt           7.5k   (3%)",
  "   · · · · · · · · · ·   ◌ System Tools           10.0k   (4%)",
  "   · · · · · · · · · ·   ● MCP Tools               1.1k  (<1%)",
  "   · · · · · · · · · ·   ◉ Messages                   0   (0%)",
  "   · · · · · · · · · ·   · Free Space            239.7k  (88%)",
  "   · · · · · · ◎ ◎ ◎ ◎   ◎ Buffer                 13.6k   (5%)",
  "",
  "────────────────────────────",
  "❯",
];

describe("the /context card", () => {
  it("reads Claude's total, legend, notes and listings through the buffer reader", () => {
    const usage = readContextUsage(screen(CLAUDE));
    expect(usage).toMatchObject({ model: "Opus 5.5", used: "31.2k", total: "1m", percent: 3 });
    expect(usage?.categories.map((entry) => entry.label)).toEqual([
      "System prompt", "System tools", "MCP tools", "MCP server instructions", "Custom agents",
      "Memory files", "Skills", "Messages", "Free space", "Autocompact buffer",
    ]);
    expect(usage?.categories[1]).toEqual({ label: "System tools", tokens: "19.2k", percent: 1.9, kind: "used" });
    expect(usage?.categories[8]).toMatchObject({ tokens: "935.8k", percent: 93.6, kind: "free" });
    expect(usage?.categories[9]).toMatchObject({ tokens: "33k", kind: "reserved" });
    expect(usage?.notes).toEqual([{ label: "Auto-compact window", value: "1m tokens" }]);
    expect(usage?.sections.map((entry) => [entry.title, entry.hint])).toEqual([
      ["MCP tools", "/mcp (loaded on-demand)"], ["Memory files", "/memory"], ["Skills", "/skills"],
    ]);
    expect(usage?.sections[0].groups).toEqual([
      { title: "Loaded", items: [{ name: "mcp__claude_ai_Claude_Docs__batch", tokens: "183" }, { name: "mcp__claude_ai_Claude_Docs__update", tokens: "330" }] },
      { title: "Available", items: [{ name: "mcp__claude_ai_Claude_Docs__create" }, { name: "mcp__claude_ai_Claude_Docs__read" }] },
    ]);
    expect(usage?.sections[1].groups).toEqual([{ items: [{ name: "~/.claude/CLAUDE.md", tokens: "14" }, { name: "~/.claude/RTK.md", tokens: "371" }] }]);
    expect(usage?.sections[2].groups[0]).toEqual({ title: "Built-in", items: [{ name: "dataviz", tokens: "~480" }, { name: "init", tokens: "~20" }] });
    expect(usage?.raw).not.toContain("auto mode");
  });

  it("reads Copilot's card, its model beside the total and a share under one percent", () => {
    const usage = readContextUsage(screen(COPILOT));
    expect(usage).toMatchObject({ model: "GPT-5.6 Terra", used: "19k", total: "272k", percent: 7 });
    expect(usage?.categories.map((entry) => [entry.label, entry.tokens, entry.kind])).toEqual([
      ["System Prompt", "7.5k", "used"], ["System Tools", "10.0k", "used"], ["MCP Tools", "1.1k", "used"],
      ["Messages", "0", "used"], ["Free Space", "239.7k", "free"], ["Buffer", "13.6k", "reserved"],
    ]);
    const mcp = usage!.categories[2].percent;
    expect(mcp).toBeGreaterThan(0);
    expect(mcp).toBeLessThan(1);
  });

  it("takes the newest card and ignores prose without the heading", () => {
    const older = CLAUDE.map((row) => row.replace("31.2k/1m", "90k/1m"));
    expect(readContextUsage(lines([...older.slice(0, 18), ...CLAUDE]))?.used).toBe("31.2k");
    expect(readContextUsage(lines(["System prompt: 2.9k tokens (0.3%)", "31.2k/1m tokens (3%)"]))).toBeNull();
    expect(readContextUsage(lines(["❯ /context", "  ⎿  Context Usage", "❯ "]))).toBeNull();
  });
});
