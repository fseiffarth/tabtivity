/**
 * Group L / #62 — shared shortcut model helpers.
 *
 * Verifies the chord capture/serialization round-trip (KeyboardEvent → chord
 * descriptor → matcher) and the default-resolution / lone-modifier behaviour
 * that both `useKeyboard` and the settings panel depend on — plus the
 * grouping metadata and the conflict/fixed-key detection the settings panel
 * warns from (part 3 of the keyboard-only steering system).
 *
 * `IS_MAC` is an import-time constant and vitest runs on a non-mac
 * `navigator`, so `chordMatches` is exercised on the exact-modifier
 * (non-macOS) path only; the ⌘/⌃-collapsing mac path is untestable here.
 */
import { describe, it, expect, vi } from "vitest";
import {
  SHORTCUT_DEFS,
  SHORTCUT_GROUPS,
  chordFromEvent,
  chordLabel,
  chordMatches,
  chordsEqual,
  LONE_SUPER,
  UNBOUND,
  findConflicts,
  isLoneModifier,
  modifierLabel,
  normalizeKey,
  resolveChord,
  zoomFor,
} from "../../lib/shortcuts/shortcuts";

describe("#62 shortcut helpers", () => {
  it("round-trips a KeyboardEvent to a chord and back to a matcher", () => {
    const e = new KeyboardEvent("keydown", {
      key: "W",
      ctrlKey: true,
      shiftKey: true,
    });
    const chord = chordFromEvent(e)!;
    expect(chord).toEqual({ key: "w", ctrl: true, shift: true });
    // The derived chord matches an equivalent event (key case-insensitive).
    expect(
      chordMatches(
        chord,
        new KeyboardEvent("keydown", { key: "w", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    // And does NOT match when a modifier differs.
    expect(
      chordMatches(chord, new KeyboardEvent("keydown", { key: "w", ctrlKey: true })),
    ).toBe(false);
  });

  it("preserves named keys (Tab, ArrowLeft) verbatim", () => {
    const tab = chordFromEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }))!;
    expect(tab).toEqual({ key: "Tab", shift: true });
    expect(normalizeKey("ArrowLeft")).toBe("ArrowLeft");
  });

  it("ignores lone modifier keypresses", () => {
    for (const k of ["Control", "Shift", "Alt", "Meta", "Super"]) {
      expect(isLoneModifier(k)).toBe(true);
      expect(chordFromEvent(new KeyboardEvent("keydown", { key: k }))).toBeNull();
    }
  });

  it("resolveChord returns the override when present, else the default", () => {
    const def = SHORTCUT_DEFS.find((d) => d.action === "closeTab")!.default;
    expect(resolveChord("closeTab", null)).toEqual(def);
    expect(resolveChord("closeTab", {})).toEqual(def);
    const custom = { key: "q", ctrl: true };
    expect(resolveChord("closeTab", { closeTab: custom })).toEqual(custom);
  });

  it("renders readable chord labels", () => {
    expect(chordLabel({ key: "Tab", ctrl: true, shift: true })).toBe("Ctrl+Shift+Tab");
    expect(chordLabel({ key: "ArrowLeft", shift: true })).toBe("Shift+←");
    expect(chordLabel({ key: "w", ctrl: true })).toBe("Ctrl+W");
    expect(chordLabel({ key: " ", ctrl: true, shift: true })).toBe("Ctrl+Shift+Space");
  });

  it("names the mouse modifier Ctrl off macOS", () => {
    expect(modifierLabel()).toBe("Ctrl");
  });

  it("captures alt/meta modifiers into the descriptor", () => {
    const e = new KeyboardEvent("keydown", { key: "w", altKey: true, metaKey: true });
    expect(chordFromEvent(e)).toEqual({ key: "w", alt: true, meta: true });
  });

  it("matches modifiers exactly off macOS (meta included)", () => {
    const chord = { key: "w", ctrl: true };
    // A stray Meta/Super rejects the chord on the exact (non-mac) path.
    expect(
      chordMatches(chord, new KeyboardEvent("keydown", { key: "w", ctrlKey: true, metaKey: true })),
    ).toBe(false);
    expect(
      chordMatches(chord, new KeyboardEvent("keydown", { key: "w", ctrlKey: true })),
    ).toBe(true);
  });
});

describe("shortcut grouping metadata", () => {
  it("every def's group exists in SHORTCUT_GROUPS", () => {
    const ids = new Set(SHORTCUT_GROUPS.map((g) => g.id));
    for (const def of SHORTCUT_DEFS) {
      expect(ids.has(def.group), `${def.action} names unknown group ${def.group}`).toBe(true);
    }
  });
});

describe("chordsEqual / findConflicts", () => {
  it("compares normalized keys and coerced modifier booleans", () => {
    // Upper/lower case and absent-vs-explicit-false modifiers are one chord.
    expect(
      chordsEqual({ key: "W", ctrl: true }, { key: "w", ctrl: true, shift: false, alt: false }),
    ).toBe(true);
    expect(chordsEqual({ key: "w", ctrl: true }, { key: "w", ctrl: true, shift: true })).toBe(false);
    expect(chordsEqual({ key: "Tab", shift: true }, { key: "tab", shift: true })).toBe(false);
  });

  it("finds no conflicts in the pristine default table", () => {
    // Doubles as a guard: a future default chord may never collide with an
    // existing one — this fails the moment one does.
    expect(findConflicts(null).size).toBe(0);
    expect(findConflicts({}).size).toBe(0);
  });

  it("reports both sides of a crafted override collision", () => {
    // Rebind closeTab onto cycleProject's default chord (Ctrl+Shift+Tab).
    const conflicts = findConflicts({ closeTab: { key: "Tab", ctrl: true, shift: true } });
    expect(conflicts.get("closeTab")).toEqual(["cycleProject"]);
    expect(conflicts.get("cycleProject")).toEqual(["closeTab"]);
    // Nothing else is dragged in.
    expect(conflicts.size).toBe(2);
  });

  it("treats an equivalent-but-differently-spelled override as a collision", () => {
    // Upper-case key + explicit false modifiers still equals closeTab's
    // default Ctrl+W.
    const conflicts = findConflicts({
      prevTab: { key: "W", ctrl: true, shift: false, alt: false, meta: false },
    });
    expect(conflicts.get("prevTab")).toEqual(["closeTab"]);
    expect(conflicts.get("closeTab")).toEqual(["prevTab"]);
  });
});

describe("the former fixed keys", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

  it("keeps the zoom defaults layout-tolerant until rebound", () => {
    expect(zoomFor(key({ key: "+", ctrlKey: true, shiftKey: true }), null)).toBe("in");
    expect(zoomFor(key({ key: "=", code: "Equal", ctrlKey: true }), null)).toBe("in");
    expect(zoomFor(key({ key: "ß", code: "Minus", ctrlKey: true }), null)).toBe("out");
    expect(zoomFor(key({ key: "0", ctrlKey: true }), null)).toBe("reset");
    expect(zoomFor(key({ key: "0" }), null)).toBeNull();
    // Rebound: the new chord zooms, the old one no longer does.
    const map = { zoomIn: { key: "i", ctrl: true, alt: true } };
    expect(zoomFor(key({ key: "i", ctrlKey: true, altKey: true }), map)).toBe("in");
    expect(zoomFor(key({ key: "+", ctrlKey: true }), map)).toBeNull();
    expect(zoomFor(key({ key: "-", ctrlKey: true }), map)).toBe("out");
  });

  it("makes F11, the panel toggle and Escape ordinary rebindable chords", () => {
    expect(resolveChord("osFullscreen", null)).toEqual({ key: "F11" });
    expect(resolveChord("exitFullscreen", null)).toEqual({ key: "Escape" });
    expect(chordMatches(resolveChord("osFullscreen", { osFullscreen: { key: "F10" } }), key({ key: "F10" }))).toBe(
      true,
    );
    // The panel toggle's default is the desktop's key (vitest: no Linux Super).
    expect(["F9", "Super"]).toContain(resolveChord("togglePanels", null).key);
  });

  it("never fires an unbound chord or a lone-Super one from a keydown", () => {
    expect(chordMatches(UNBOUND, key({ key: "" }))).toBe(false);
    expect(chordLabel(UNBOUND)).toBe("—");
    expect(chordMatches(LONE_SUPER, key({ key: "Super" }))).toBe(false);
    // Two switched-off actions are no conflict.
    expect(findConflicts({ closeTab: UNBOUND, prevTab: UNBOUND }).size).toBe(0);
  });
});

/** `IS_MAC`/`IS_WINDOWS` are import-time constants, so the per-platform labels
 *  are read from a fresh module graph under a mocked `lib/platform`. */
describe("platform labels (mocked platform)", () => {
  async function labelsOn(platform: "macos" | "windows" | "linux") {
    vi.resetModules();
    vi.doMock("../../lib/platform", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../lib/platform")>()),
      IS_MAC: platform === "macos",
      IS_WINDOWS: platform === "windows",
      IS_LINUX: platform === "linux",
      PLATFORM: platform,
    }));
    try {
      const mod = await import("../../lib/shortcuts/shortcuts");
      return {
        modifier: mod.modifierLabel(),
        cycle: mod.chordLabel({ key: "Tab", ctrl: true, shift: true }),
        save: mod.chordLabel({ key: "s", ctrl: true }),
        altRight: mod.chordLabel({ key: "ArrowRight", alt: true }),
      };
    } finally {
      vi.doUnmock("../../lib/platform");
      vi.resetModules();
    }
  }

  it("renders ⌘ and the mac glyph chords on macOS", async () => {
    expect(await labelsOn("macos")).toEqual({
      modifier: "⌘",
      cycle: "⇧⌘Tab",
      save: "⌘S",
      altRight: "⌥→",
    });
  });

  it("keeps the textual Ctrl/Alt labels on Windows and Linux", async () => {
    const textual = { modifier: "Ctrl", cycle: "Ctrl+Shift+Tab", save: "Ctrl+S", altRight: "Alt+→" };
    expect(await labelsOn("windows")).toEqual(textual);
    expect(await labelsOn("linux")).toEqual(textual);
  });
});
