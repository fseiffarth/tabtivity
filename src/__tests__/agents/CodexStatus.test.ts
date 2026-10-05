import { describe, expect, it } from "vitest";
import { codexRemaining, codexReset, readCodexStatus } from "../../lib/agents/codexStatus";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";

const lines = (rows: string[]) => rows.map((text) => ({ text }));

describe("Codex's /status card", () => {
  it("reads the newest card, joins narrow-terminal continuations, and stops at the input frame", () => {
    const card = readCodexStatus(lines([
      "/status", ">_ OpenAI Codex (v0.100.0)", "Model: gpt-6", "Directory: /old", "Session: old",
      "› fix it", "/status", "", ">_ OpenAI Codex (v0.101.0)", "",
      "Model: gpt-6 (high)", "Directory: /p", "Permissions: Custom (workspace-write)",
      "  with network access", "Context window: 0% left (272K used / 272K)",
      "5h limit: [██████░░░░] 60% left", "  (resets 13:45 on 1 Oct)",
      "Weekly limit: [░░░░░░░░░░] 5% left (resets 5 Oct)",
      "Credits: Available", "Session: current", "› draft", "Model: untrusted output",
    ]));
    expect(card?.fields.find((field) => field.label === "Model")?.value).toBe("gpt-6 (high)");
    expect(card?.fields.find((field) => field.label === "Permissions")?.value).toContain("with network access");
    expect(card?.fields.find((field) => field.label === "Session")?.value).toBe("current");
    const limit = card!.fields.find((field) => field.label === "5h limit")!.value;
    expect(codexRemaining(limit)).toBe(60);
    expect(codexReset(limit)).toBe("13:45 on 1 Oct");
    expect(card?.raw).not.toContain("untrusted output");
    expect(card?.fields.find((field) => field.label === "Credits")?.value).toBe("Available");
  });

  it("does not turn the startup banner or prose into status", () => {
    expect(readCodexStatus(lines([">_ OpenAI Codex (v0.101.0)", "Model: gpt-6", "Directory: /p"]))).toBeNull();
    expect(readCodexStatus(lines(["› /status", "Here is your status:", "Model: gpt-6", "Directory: /p"]))).toBeNull();
    expect(readCodexStatus(lines(["/status", ">_ OpenAI Codex (v0.101.0)", "Model: gpt-6"]))).toBeNull();
  });

  it("reads the box-drawn card through the same buffer reader as the desktop", () => {
    const rows = ["/status", "╭──────────────────────────────────────╮", "│ >_ OpenAI Codex (v0.101.0)            │",
      "│ Model: gpt-6                        │", "│ Directory: /p                       │",
      "│ 5h limit: [█████░░░░░] 50% left      │", "│   (resets 13:45)                     │",
      "╰──────────────────────────────────────╯", "Ordinary output: leave this alone", "›"];
    const buffer = { length: rows.length, getLine: (row: number) => rows[row] === undefined ? undefined : { translateToString: () => rows[row] } };
    const card = readCodexStatus(readableScreen(buffer).lines);
    expect(card?.fields.find((field) => field.label === "5h limit")?.value).toBe("[█████░░░░░] 50% left (resets 13:45)");
    expect(card?.raw).not.toContain("Ordinary output");
  });

  it("preserves zero and leaves missing or malformed percentages absent", () => {
    expect(codexRemaining("0% left (272K used / 272K)")).toBe(0);
    expect(codexRemaining("100% left")).toBe(100);
    expect(codexRemaining("data not available yet")).toBeUndefined();
    expect(codexRemaining("101% left")).toBeUndefined();
    expect(codexRemaining("10% used")).toBeUndefined();
    expect(codexRemaining(undefined)).toBeUndefined();
  });
});
