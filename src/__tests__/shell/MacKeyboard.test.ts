/**
 * 2442x: the Mac keyboard. Option changes the character a letter types, so an
 * Alt+letter chord matches by physical key there; ⌘ is the primary modifier
 * in terminal keyboard-select; fixed "Ctrl" prose shows ⌘; the file-tree
 * export drag takes ⌥ (Ctrl+press is a right-click on a Mac).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform")>()),
  IS_MAC: true,
  IS_WINDOWS: false,
  IS_LINUX: false,
  PLATFORM: "macos",
}));

import { chordFromEvent, chordMatches, forPlatformKeys, isOptionLetterOf, resolveChord } from "../../lib/shortcuts/shortcuts";
import { keySelectStep, type KeySelectState } from "../../lib/terminal/keyboardSelect";
import { exportDragHeld } from "../../components/files/fileTreeDrag";

const key = (over: Partial<KeyboardEvent>) =>
  ({ key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over }) as KeyboardEvent;

describe("Mac keyboard (2442x)", () => {
  it("matches an Option+letter chord by physical key", () => {
    const closeAll = resolveChord("closeAllTabs", undefined);
    // ⌘⇧⌥W types "„" on a US Mac layout.
    expect(chordMatches(closeAll, key({ key: "„", code: "KeyW", metaKey: true, shiftKey: true, altKey: true }))).toBe(true);
    expect(chordMatches(closeAll, key({ key: "„", code: "KeyQ", metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isOptionLetterOf("w", key({ code: "KeyW", altKey: false }))).toBe(false);
    expect(isOptionLetterOf("w", key({ code: "KeyW", altKey: true }), false)).toBe(false);
    // A capture stores the letter, not the character Option typed.
    expect(chordFromEvent(key({ key: "œ", code: "KeyQ", altKey: true, metaKey: true }))).toEqual({ key: "q", alt: true, meta: true });
  });

  it("copies with ⌘C and leaves with ⌘X in keyboard-select", () => {
    const state: KeySelectState = { cursor: { x: 0, y: 0 }, anchor: null, lines: false };
    const geo = { cols: 10, rows: 5, length: 5, lineText: () => "abc" };
    expect(keySelectStep(state, key({ key: "c", metaKey: true }), geo, true).kind).toBe("copy");
    expect(keySelectStep(state, key({ key: "x", metaKey: true }), geo, true).kind).toBe("exit");
    expect(keySelectStep(state, key({ key: "v", metaKey: true }), geo, true).kind).toBe("ignore");
    // Off a Mac ⌘ still belongs to nobody here.
    expect(keySelectStep(state, key({ key: "c", metaKey: true }), geo, false).kind).toBe("ignore");
  });

  it("shows ⌘ for Ctrl in fixed prose", () => {
    expect(forPlatformKeys("Ctrl+click: in a new subwindow")).toBe("⌘+click: in a new subwindow");
    expect(forPlatformKeys("Strg+Klick")).toBe("⌘+Klick");
    expect(forPlatformKeys("Ctrl + / Ctrl − zoom, Ctrl 0 resets")).toBe("⌘ + / ⌘ − zoom, ⌘ 0 resets");
    expect(forPlatformKeys("Ctrl+B", false)).toBe("Ctrl+B");
    expect(forPlatformKeys("Controls")).toBe("Controls");
  });

  it("takes ⌥ for the export drag on a Mac and Ctrl elsewhere", () => {
    expect(exportDragHeld({ ctrlKey: true, altKey: false })).toBe(false);
    expect(exportDragHeld({ ctrlKey: false, altKey: true })).toBe(true);
    expect(exportDragHeld({ ctrlKey: true, altKey: false }, false)).toBe(true);
    expect(exportDragHeld({ ctrlKey: false, altKey: true }, false)).toBe(false);
  });
});
