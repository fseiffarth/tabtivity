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

  it("takes the whole tail when the retained window moved past what was seen", () => {
    expect(sliceBeyond(tail, 40)).toEqual({ data: "0123456789", range: { startOffset: 100, endOffset: 110 } });
  });
});
