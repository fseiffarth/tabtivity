import { describe, expect, it } from "vitest";
import { sliceBeyond } from "../../lib/terminal/terminalBus";

/**
 * The browser client's reconnect catch-up (hosted plan §3.5): a pane takes
 * from the retained tail only what lies past the last chunk it saw.
 */
describe("sliceBeyond", () => {
  const tail = { data: "0123456789", startOffset: 100, endOffset: 110 };

  it("takes the whole tail when the pane saw nothing yet", () => {
    expect(sliceBeyond(tail, undefined)).toEqual({ data: "0123456789", range: { startOffset: 100, endOffset: 110 } });
  });

  it("cuts at the last seen offset inside the tail", () => {
    expect(sliceBeyond(tail, 104)).toEqual({ data: "456789", range: { startOffset: 104, endOffset: 110 } });
  });

  it("answers nothing when the pane is current", () => {
    expect(sliceBeyond(tail, 110)).toBeNull();
    expect(sliceBeyond(tail, 200)).toBeNull();
  });

  it("cuts in UTF-8 bytes, as the backend counts, past non-ASCII output (final review B8)", () => {
    const seenText = "⏺ Done │ ";
    const newText = "next line\r\n";
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    const snapshot = { data: seenText + newText, startOffset: 1000, endOffset: 1000 + bytes(seenText + newText) };
    const seen = 1000 + bytes(seenText);
    expect(sliceBeyond(snapshot, seen)).toEqual({ data: newText, range: { startOffset: seen, endOffset: snapshot.endOffset } });
    const box = "│x│";
    expect(sliceBeyond({ data: box, startOffset: 0, endOffset: bytes(box) }, bytes("│x"))?.data).toBe("│");
  });

  it("takes the whole tail when the retained window moved past what was seen", () => {
    expect(sliceBeyond(tail, 40)).toEqual({ data: "0123456789", range: { startOffset: 100, endOffset: 110 } });
  });
});
