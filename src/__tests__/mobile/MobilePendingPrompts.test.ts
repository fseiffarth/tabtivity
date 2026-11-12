import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { arrivedPending, pendingPrompt, recordedRun, recordsPrompt, withPending } from "../../../mobile-web/src/terminal/pendingPrompts";

describe("a sent prompt's record", () => {
  it("is the same words, or a cut record's opening", () => {
    expect(recordsPrompt({ text: "fix  the\nparser" }, "fix the parser")).toBe(true);
    expect(recordsPrompt({ text: "fix the" }, "fix the parser")).toBe(false);
    expect(recordsPrompt({ text: "fix the", cut: true }, "fix the parser")).toBe(true);
    expect(recordsPrompt({ text: "fix a", cut: true }, "fix the parser")).toBe(false);
    expect(recordsPrompt({ text: "", cut: true }, "fix the parser")).toBe(false);
  });

  it("takes a part the CLI recorded as a paste for the words sent there", () => {
    const sent = "there are problems\n[14:20] a very long log line\n[14:21] FAIL";
    expect(recordsPrompt({ text: "there are problems\n[Pasted text #1]\n[14:21] FAIL" }, sent)).toBe(true);
    expect(recordsPrompt({ text: "[Pasted text #1 +2 lines]" }, sent)).toBe(true);
    expect(recordsPrompt({ text: "there are problems [Pasted text #1] FAIL" }, sent)).toBe(true);
    expect(recordsPrompt({ text: "there are problems [Pasted text #1] [14:2", cut: true }, sent)).toBe(true);
    expect(recordsPrompt({ text: "other words [Pasted text #1] FAIL" }, sent)).toBe(false);
    expect(recordsPrompt({ text: "there are problems [Pasted text #1] OK" }, sent)).toBe(false);
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

describe("one record for several held prompts", () => {
  const held = (id: number, text: string) => ({ ...pendingPrompt(id, text, []), held: `h${id}` });

  it("gives each its bubble in the record's place: Codex sends a stopped queue as one", () => {
    const pending = [held(1, "second"), held(2, "third")];
    const entries: TranscriptEntry[] = [
      { kind: "prompt", text: "first" },
      { kind: "prompt", text: "second\nthird" },
      { kind: "answer", text: "done" },
    ];
    expect(arrivedPending(entries, pending)).toEqual(new Set([1, 2]));
    const shown = withPending(entries, pending);
    expect(shown.map((entry) => entry.text)).toEqual(["first", "second", "third", "done"]);
    expect(shown.some((entry) => entry.queued)).toBe(false);
  });

  it("leaves a third prompt outside the record queued", () => {
    const pending = [held(1, "second"), held(2, "third"), held(3, "fourth")];
    const entries: TranscriptEntry[] = [{ kind: "prompt", text: "second\nthird" }];
    expect(arrivedPending(entries, pending)).toEqual(new Set([1, 2]));
    const shown = withPending(entries, pending);
    expect(shown[shown.length - 1]).toMatchObject({ text: "fourth", queued: true });
  });

  it("names the run a record holds", () => {
    expect(recordedRun({ text: "b\nc" }, ["a", "b", "c", "d"])).toEqual([1, 2]);
    expect(recordedRun({ text: "b" }, ["a", "b"])).toEqual([]);
    expect(recordedRun({ text: "c\nb" }, ["b", "c"])).toEqual([]);
  });
});
