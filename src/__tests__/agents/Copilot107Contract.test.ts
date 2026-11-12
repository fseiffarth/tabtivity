import { describe, expect, it } from "vitest";
import screens from "../fixtures/copilot107.json";
import { readReaderLive } from "../../lib/agents/readerLive";
import { looksLikeDecisionPromptStripped } from "../../lib/agents/prompt/prompt";

// Real 1.0.107 TUI, isolated home and loopback stub provider, its work folder
// inside a git repo (so row 2 says "in this repo (…)" and wraps).
const buffer = (rows: string[]) => ({
  length: rows.length,
  getLine: (row: number) => rows[row] === undefined ? undefined : { translateToString: () => rows[row] },
});

describe("Copilot 1.0.107 terminal contract", () => {
  it("reads all three choices of a file approval whose rows wrap with no hanging indent", () => {
    for (const [rows, columns] of [[screens.approval, 110], [screens.approval60, 60]] as const) {
      const live = readReaderLive(buffer([...rows]), "Copilot", columns);
      expect(live.question?.options.map((option) => option.number)).toEqual([1, 2, 3]);
      expect(live.question?.current).toBe(0);
      expect(live.question?.options[1].label).toMatch(/^Yes, and don't ask again for file operations when in this repo \(.*projectwspace\)$/u);
      expect(live.question?.options[2].label).toBe("No, and tell Copilot what to do differently (Esc to stop)");
      expect(looksLikeDecisionPromptStripped(rows.join("\n"))).toBe(true);
    }
  });

  it("reads the idle composer without an approval or working card", () => {
    const live = readReaderLive(buffer(screens.idle), "Copilot", 110);
    expect(live.question).toBeNull();
    expect(live.working).toBeNull();
    expect(live.status).not.toBeNull();
  });

  it("keeps the wrap rule to Copilot: another agent's line under the number column ends the run", () => {
    const live = readReaderLive(buffer(screens.approval), "Claude", 110);
    expect(live.question?.options).toHaveLength(2);
  });
});
