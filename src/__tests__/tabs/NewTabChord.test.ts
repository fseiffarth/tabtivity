/**
 * The new-tab chords: Ctrl+Shift+N / M and Ctrl+1–9 resolve to the right
 * request (digits by physical key too), and the agent numbering the + menu
 * shows is the one the chord opens — default agent first.
 */
import { describe, it, expect } from "vitest";
import { newTabRequestFor } from "../../lib/shortcuts/newTabChord";
import { agentShortcutSlots, effectiveAgentOrder, moveInAgentOrder, sortByAgentOrder } from "../../lib/tabs/newTabItems";
import { agentMenuEntries } from "../../components/tabs/agentMenuEntries";
import type { CustomAgent } from "../../types";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("newTabRequestFor", () => {
  it("maps the default chords", () => {
    expect(newTabRequestFor(key({ key: "N", ctrlKey: true, shiftKey: true }), undefined)).toEqual({ kind: "shell" });
    expect(newTabRequestFor(key({ key: "M", ctrlKey: true, shiftKey: true }), undefined)).toEqual({ kind: "monitor" });
    expect(newTabRequestFor(key({ key: "1", code: "Digit1", ctrlKey: true }), undefined)).toEqual({ kind: "agent", slot: 0 });
    expect(newTabRequestFor(key({ key: "9", code: "Digit9", ctrlKey: true }), undefined)).toEqual({ kind: "agent", slot: 8 });
  });

  it("matches digits by physical key where the layout types a symbol", () => {
    // AZERTY: the key US calls 1 types "&".
    expect(newTabRequestFor(key({ key: "&", code: "Digit1", ctrlKey: true }), undefined)).toEqual({ kind: "agent", slot: 0 });
  });

  it("leaves plain digits and other modifiers alone", () => {
    expect(newTabRequestFor(key({ key: "1", code: "Digit1" }), undefined)).toBeNull();
    expect(newTabRequestFor(key({ key: "1", code: "Digit1", ctrlKey: true, altKey: true }), undefined)).toBeNull();
    expect(newTabRequestFor(key({ key: "n", ctrlKey: true }), undefined)).toBeNull();
  });

  it("follows a rebind", () => {
    const overrides = { newShellTab: { key: "e", alt: true } };
    expect(newTabRequestFor(key({ key: "e", altKey: true }), overrides)).toEqual({ kind: "shell" });
    expect(newTabRequestFor(key({ key: "N", ctrlKey: true, shiftKey: true }), overrides)).toBeNull();
  });
});

describe("agentShortcutSlots", () => {
  const custom: CustomAgent[] = [
    { id: "a", label: "Mine", cmd: "mine" } as CustomAgent,
    { id: "b", label: "Gone", cmd: "gone" } as CustomAgent,
  ];
  const base = {
    installedBuiltins: new Set(["claude", "codex", "gemini"]),
    installedCmds: new Set(["mine"]),
    customAgents: custom,
  };

  it("puts the default agent first, then the rest in menu order, skipping missing ones", () => {
    const slots = agentShortcutSlots({ ...base, defaultAgentBin: "codex" });
    expect(slots.map((s) => s?.key)).toEqual(["codex", "claude", "gemini", "custom:a"]);
  });

  it("leaves slot 1 empty when the default agent is not in the menu", () => {
    const slots = agentShortcutSlots({ ...base, defaultAgentBin: "aider" });
    expect(slots[0]).toBeNull();
    expect(slots.slice(1).map((s) => s?.key)).toEqual(["claude", "codex", "gemini", "custom:a"]);
  });

  it("labels the menu rows with the same numbers", () => {
    const entries = agentMenuEntries({
      ...base,
      pick: () => {},
      onAddCustom: () => {},
      defaultAgentBin: "codex",
      t: (k) => k,
    });
    const chord = (k: string) => entries.find((e) => e.key === k)?.shortcut;
    expect(chord("codex")).toBe("agentTab1");
    expect(chord("claude")).toBe("agentTab2");
    expect(chord("custom:a")).toBe("agentTab4");
    expect(chord("custom:b")).toBeUndefined();
  });

  it("shows no numbers where the chords do not work", () => {
    const entries = agentMenuEntries({ ...base, pick: () => {}, onAddCustom: () => {}, t: (k) => k });
    expect(entries.every((e) => e.shortcut === undefined)).toBe(true);
  });
});

describe("agent order (Settings.agent_order)", () => {
  const custom: CustomAgent[] = [{ id: "a", label: "Mine", cmd: "mine" } as CustomAgent];
  const base = {
    installedBuiltins: new Set(["claude", "codex", "gemini"]),
    installedCmds: new Set(["mine"]),
    customAgents: custom,
  };

  it("numbers the chords in the saved order, ahead of the default-agent rule", () => {
    const slots = agentShortcutSlots({
      ...base,
      defaultAgentBin: "claude",
      agentOrder: ["gemini", "custom:a", "claude"],
    });
    // codex is not in the saved order: it follows the named ones.
    expect(slots.map((s) => s?.key)).toEqual(["gemini", "custom:a", "claude", "codex"]);
  });

  it("orders the menu rows the same way and labels them with those numbers", () => {
    const entries = agentMenuEntries({
      ...base,
      pick: () => {},
      onAddCustom: () => {},
      defaultAgentBin: "claude",
      agentOrder: ["gemini", "codex"],
      t: (k) => k,
    });
    expect(entries.slice(0, 3).map((e) => e.key)).toEqual(["gemini", "codex", "claude"]);
    const chord = (k: string) => entries.find((e) => e.key === k)?.shortcut;
    expect(chord("gemini")).toBe("agentTab1");
    expect(chord("codex")).toBe("agentTab2");
    expect(chord("claude")).toBe("agentTab3");
    expect(chord("custom:a")).toBe("agentTab4");
  });

  it("sorts named keys first and keeps the rest stable", () => {
    expect(sortByAgentOrder(["a", "b", "c", "d"], (k) => k, ["c", "a"])).toEqual(["c", "a", "b", "d"]);
    expect(sortByAgentOrder(["a", "b"], (k) => k, undefined)).toEqual(["a", "b"]);
  });

  it("falls back to the default agent first when nothing is saved", () => {
    expect(effectiveAgentOrder(["claude", "codex", "gemini"], undefined, "codex")).toEqual(["codex", "claude", "gemini"]);
    expect(effectiveAgentOrder(["claude", "codex"], [], "aider")).toEqual(["claude", "codex"]);
    expect(effectiveAgentOrder(["claude", "codex"], ["codex"], "claude")).toEqual(["codex", "claude"]);
  });

  it("moves a key past its visible neighbour, leaving hidden keys in place", () => {
    const order = ["claude", "custom:a", "codex", "gemini"];
    const peers = ["claude", "codex", "gemini"];
    expect(moveInAgentOrder(order, "codex", -1, peers)).toEqual(["codex", "custom:a", "claude", "gemini"]);
    expect(moveInAgentOrder(order, "codex", 1, peers)).toEqual(["claude", "custom:a", "gemini", "codex"]);
    expect(moveInAgentOrder(order, "gemini", 1, peers)).toEqual(order);
    expect(moveInAgentOrder(order, "claude", -1, peers)).toEqual(order);
  });
});
