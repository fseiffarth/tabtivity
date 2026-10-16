import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { arrivedPending, pendingPrompt, recordsPrompt, withPending } from "../../../mobile-web/src/terminal/pendingPrompts";

describe("a sent prompt's record", () => {
  it("is the same words, or a cut record's opening", () => {
    expect(recordsPrompt({ text: "fix  the\nparser" }, "fix the parser")).toBe(true);
    expect(recordsPrompt({ text: "fix the" }, "fix the parser")).toBe(false);
    expect(recordsPrompt({ text: "fix the", cut: true }, "fix the parser")).toBe(true);
    expect(recordsPrompt({ text: "fix a", cut: true }, "fix the parser")).toBe(false);
    expect(recordsPrompt({ text: "", cut: true }, "fix the parser")).toBe(false);
  });

  it("takes a long prompt's cut record for its arrival: one bubble, not two", () => {
    const before: TranscriptEntry[] = [{ kind: "answer", text: "Done.", at: "2026-10-14T10:00:00Z" }];
    const long = `${"a long prompt ".repeat(500)}and its end`;
    const sent = pendingPrompt(1, long, before);
    const after: TranscriptEntry[] = [...before, { kind: "prompt", text: long.slice(0, 6000).trim(), cut: true, at: "2026-10-14T10:01:00Z" }];
    expect([...arrivedPending(after, [sent])]).toEqual([1]);
    expect(withPending(after, [sent]).filter((entry) => entry.kind === "prompt")).toHaveLength(1);
  });
});
