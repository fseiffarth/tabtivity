import { describe, expect, it } from "vitest";
import screens from "../fixtures/codex167.json";
import { readSelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";
import { sessionStatus } from "../../../mobile-web/src/terminal/statusLine";

// Captured from the installed 0.167.0 TUI, isolated home, 100 columns.
const lines = (screen: string[]) => screen.map((text) => ({ text }));
describe("Codex 0.167.0 terminal contract", () => {
  it("reads both live model picker steps", () => {
    const model = readSelectPrompt(lines(screens.model), "Codex");
    expect(model?.title).toBe("Select Model and Effort");
    expect(model?.options[0].label).toBe("GPT-6.1-Sol");
    const effort = readSelectPrompt(lines(screens.effort), "Codex");
    expect(effort?.title).toBe("Select Reasoning Level for GPT-6.1-Sol");
    expect(effort?.options).toHaveLength(5);
    expect(effort?.options[4].label).toContain("More reasoning");
  });
  it("reads the live plan mode indicator", () => {
    expect(sessionStatus(lines(screens.plan), "Codex")?.mode).toBe("plan");
  });
});
