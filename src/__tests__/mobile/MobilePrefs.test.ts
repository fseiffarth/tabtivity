/**
 * The phone's own view preferences (`mobile-web/src/prefs.ts`): a filter or a
 * mode the reader set, kept in the browser and never sent across the bridge.
 * What is pinned here is the *fallback* discipline — only the two stored strings
 * answer a flag, so a default-on flag can't be switched off by a stray value —
 * and that a blocked store degrades to the default rather than throwing.
 */
import { describe, expect, it } from "vitest";
import {
  readChoice,
  readFlag,
  readTerminalView,
  writeChoice,
  writeFlag,
  writeTerminalView,
} from "../../../mobile-web/src/prefs";
import { BRAND, storageKey } from "../../lib/brand";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
  };
}

const throwingStorage = {
  getItem: () => { throw new Error("SecurityError"); },
  setItem: () => { throw new Error("SecurityError"); },
};

describe(`${BRAND.display} Mobile prefs — flags`, () => {
  it(`round-trips a flag under the ${BRAND.slug}.mobile. prefix`, () => {
    const storage = memoryStorage();
    writeFlag("todoHideDone", true, storage);
    expect(storage.map.get(storageKey("mobile.todoHideDone"))).toBe("1");
    expect(readFlag("todoHideDone", false, storage)).toBe(true);
    writeFlag("todoHideDone", false, storage);
    expect(storage.map.get(storageKey("mobile.todoHideDone"))).toBe("0");
    expect(readFlag("todoHideDone", true, storage)).toBe(false);
  });

  it("answers an unset flag with its fallback, in both directions", () => {
    const storage = memoryStorage();
    expect(readFlag("todoHideArchived", true, storage)).toBe(true);
    expect(readFlag("todoHideArchived", false, storage)).toBe(false);
    expect(readFlag("projectsAgents", undefined, storage)).toBe(false);
  });

  it("treats anything but the two stored strings as unset, so an on-by-default flag cannot be turned off by accident", () => {
    const storage = memoryStorage({
      [storageKey("mobile.todoHideArchived")]: "false",
      [storageKey("mobile.todoHideDone")]: "yes",
    });
    expect(readFlag("todoHideArchived", true, storage)).toBe(true);
    expect(readFlag("todoHideDone", false, storage)).toBe(false);
  });

  it("keeps the default when the store is blocked, and swallows a failed write", () => {
    expect(readFlag("todoHideArchived", true, throwingStorage)).toBe(true);
    expect(() => writeFlag("todoHideArchived", false, throwingStorage)).not.toThrow();
  });

  it("uses localStorage when no store is given", () => {
    localStorage.clear();
    writeFlag("projectsAgents", true);
    expect(localStorage.getItem(storageKey("mobile.projectsAgents"))).toBe("1");
    expect(readFlag("projectsAgents")).toBe(true);
    localStorage.clear();
  });
});

describe(`${BRAND.display} Mobile prefs — choices`, () => {
  const isSort = (value: unknown): value is "lastWorking" | "native" =>
    value === "lastWorking" || value === "native";

  it("returns the stored value only when the guard accepts it", () => {
    const storage = memoryStorage();
    writeChoice("agentsSort", "native", storage);
    expect(readChoice("agentsSort", isSort, "lastWorking", storage)).toBe("native");
    // A value the guard rejects (a retired option, a hand edit) falls back.
    writeChoice("agentsSort", "byColour", storage);
    expect(readChoice("agentsSort", isSort, "lastWorking", storage)).toBe("lastWorking");
  });

  it("falls back on an empty or blocked store", () => {
    expect(readChoice("agentsSort", isSort, "lastWorking", memoryStorage())).toBe("lastWorking");
    expect(readChoice("agentsSort", isSort, "native", throwingStorage)).toBe("native");
    expect(() => writeChoice("agentsSort", "native", throwingStorage)).not.toThrow();
  });
});

describe(`${BRAND.display} Mobile prefs — terminal view per agent`, () => {
  it("holds no choice until the reader picks one, keyed by the agent", () => {
    const storage = memoryStorage();
    expect(readTerminalView("Claude Code", storage)).toBeNull();
    writeTerminalView("Claude Code", "terminal", storage);
    expect(readTerminalView("Claude Code", storage)).toBe("terminal");
    writeTerminalView("Claude Code", "focus", storage);
    expect(readTerminalView("Claude Code", storage)).toBe("focus");
    // Another agent keeps its own answer.
    expect(readTerminalView("Codex", storage)).toBeNull();
    expect(readTerminalView("Codex", throwingStorage)).toBeNull();
  });

  it("normalises the agent name into one key, so casing and spacing do not split a preference", () => {
    const storage = memoryStorage();
    writeTerminalView("  Claude   Code ", "focus", storage);
    expect([...storage.map.keys()]).toEqual([storageKey("mobile.view.claude-code")]);
    expect(readTerminalView("claude code", storage)).toBe("focus");
    expect(readTerminalView("CLAUDE-CODE", storage)).toBe("focus");
  });

  it("gives a nameless agent a shared key rather than an empty one", () => {
    const storage = memoryStorage();
    writeTerminalView("", "focus", storage);
    expect(storage.map.has(storageKey("mobile.view.agent"))).toBe(true);
    expect(readTerminalView("   ", storage)).toBe("focus");
  });

  it("reads anything but the literal 'focus' or 'terminal' as no choice, and survives a blocked store", () => {
    const storage = memoryStorage({ [storageKey("mobile.view.codex")]: "Focus" });
    expect(readTerminalView("Codex", storage)).toBeNull();
    expect(readTerminalView("Codex", throwingStorage)).toBeNull();
    expect(() => writeTerminalView("Codex", "focus", throwingStorage)).not.toThrow();
  });
});
