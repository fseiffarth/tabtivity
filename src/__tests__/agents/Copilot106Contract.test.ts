import { describe, expect, it } from "vitest";
import screens from "../fixtures/copilot106.json";
import { readReaderLive } from "../../lib/agents/readerLive";
import { looksLikeDecisionPromptStripped } from "../../lib/agents/prompt/prompt";

// Real 1.0.106 TUI, isolated home and loopback stub provider, 110 columns.
const buffer = (rows: string[]) => ({
  length: rows.length,
  getLine: (row: number) => rows[row] === undefined ? undefined : { translateToString: () => rows[row] },
});
describe("Copilot 1.0.106 terminal contract", () => {
  it("reads folder trust and file approval as answerable questions", () => {
    for (const rows of [screens.trust, screens.approval]) {
      const live = readReaderLive(buffer(rows), "Copilot", 110);
      expect(live.question?.options).toHaveLength(3);
      expect(live.question?.options[0].label).toBe("Yes");
      expect(looksLikeDecisionPromptStripped(rows.join("\n"))).toBe(true);
    }
  });
  it("reads the idle composer without an approval or working card", () => {
    const live = readReaderLive(buffer(screens.idle), "Copilot", 110);
    expect(live.question).toBeNull();
    expect(live.working).toBeNull();
    expect(live.status).not.toBeNull();
  });
});
