/**
 * A name that merely exists on `Object.prototype` is not a member of a lookup
 * table: `"toString" in TABLE` is true, and what came back was a function
 * rendered as a colour, a message key or a command arity.
 */
import { describe, expect, it } from "vitest";

import { parseOverlayCommandAt } from "../../lib/viewers/tex/beamer";
import { voiceErrorKey } from "../../lib/voice/desktopVoice";
import { isTabColor, tabColorCss } from "../../lib/theme/tabColors";

const INHERITED = ["__proto__", "toString", "constructor", "hasOwnProperty"];

describe("own-property membership", () => {
  it("tab colours (the phone shares this module): an inherited name is no colour", () => {
    for (const name of INHERITED) {
      expect(isTabColor(name)).toBe(false);
      expect(tabColorCss(name)).toBeUndefined();
    }
    expect(isTabColor("teal")).toBe(true);
  });

  it("voice errors: an inherited name falls back to the generic message", () => {
    for (const name of INHERITED) expect(voiceErrorKey(name)).toBe("terminal.reader.voice.err.failed");
    expect(voiceErrorKey("device-busy")).toBe("terminal.reader.voice.err.busy");
  });

  it("beamer overlays: an inherited name is no overlay command", () => {
    for (const name of INHERITED) expect(parseOverlayCommandAt(`\\${name}<2>{x}`, 0)).toBeNull();
  });
});
