/**
 * WebKitGTK reports Shift+Tab as key "Unidentified", code "Tab" (GTK's
 * ISO_Left_Tab keyval). Every Tab reader goes through `eventKey` / `isTabKey`,
 * so the app's chords, steering and its captures see a Tab.
 */
import { describe, expect, it } from "vitest";
import { chordFromEvent, chordMatches, eventKey, isTabKey } from "../../lib/shortcuts/shortcuts";
import { steeringActionFor, steeringKeyFromEvent } from "../../lib/shortcuts/steeringBindings";

const gtkShiftTab = { key: "Unidentified", code: "Tab", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false };

describe("WebKitGTK's Shift+Tab", () => {
  it("reads as Tab", () => {
    expect(eventKey(gtkShiftTab)).toBe("Tab");
    expect(isTabKey(gtkShiftTab)).toBe(true);
    expect(isTabKey({ key: "Tab", code: "Tab" })).toBe(true);
    // Only the Tab key: another unidentified key stays unidentified.
    expect(eventKey({ key: "Unidentified", code: "KeyQ" })).toBe("Unidentified");
  });

  it("matches the Shift+Tab chord and is captured as one", () => {
    expect(chordMatches({ key: "Tab", shift: true }, gtkShiftTab)).toBe(true);
    expect(chordFromEvent(new KeyboardEvent("keydown", gtkShiftTab))).toEqual({ key: "Tab", shift: true });
  });

  it("resolves steering's Tab binding and is captured as Tab", () => {
    expect(steeringActionFor(gtkShiftTab, "panes", null)).toBe("readerView");
    expect(steeringKeyFromEvent(gtkShiftTab)).toBe("Tab");
  });
});
