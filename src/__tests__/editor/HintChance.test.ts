import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hintChance, rollHint } from "../../lib/hintChance";
import { pickHint, type HintCtx } from "../../lib/shortcuts/hints";
import { hintDrawn, useHintsStore } from "../../stores/hints";
import { useSettingsStore } from "../../stores/settings";

const active: HintCtx = { projectCount: 1, activeId: "p1" };

describe("hint chance", () => {
  it("halves with every read", () => {
    expect(hintChance(0)).toBe(1);
    expect(hintChance(1)).toBe(0.5);
    expect(hintChance(3)).toBe(0.125);
  });

  it("an unread hint always wins its draw, a read one only under its chance", () => {
    expect(rollHint(0, () => 0.99)).toBe(true);
    expect(rollHint(2, () => 0.2)).toBe(true);
    expect(rollHint(2, () => 0.3)).toBe(false);
  });

  it("pickHint passes over a hint that lost its draw", () => {
    expect(pickHint(active, new Set(), true, { drawn: (id) => id !== "add-tab" })).toBe("toggle-panels");
  });
});

describe("hints store reads", () => {
  let saved: Record<string, unknown>;
  beforeEach(() => {
    saved = {};
    useSettingsStore.setState({
      settings: {},
      updateSettings: async (patch: Record<string, unknown>) => {
        saved = { ...saved, ...patch };
        useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...patch } }));
      },
    } as never);
    useHintsStore.getState().reset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("Read counts one more read and keeps the hint away for the sitting", () => {
    useHintsStore.getState().show("add-tab");
    useHintsStore.getState().read("add-tab");
    expect(useHintsStore.getState().active).toBeNull();
    expect(saved.hints_read).toEqual({ "add-tab": 1 });
    useHintsStore.getState().read("add-tab");
    expect(saved.hints_read).toEqual({ "add-tab": 2 });
    expect(hintDrawn("add-tab")).toBe(false);
  });

  it("× closes for the sitting without counting a read", () => {
    useHintsStore.getState().show("add-tab");
    useHintsStore.getState().dismiss("add-tab");
    expect(saved.hints_read).toEqual({});
    expect(saved.hints_seen).toEqual([]);
    expect(hintDrawn("add-tab")).toBe(false);
  });

  it("draws once per sitting from the stored reads; reset restores full chance", () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, hints_read: { "file-tree": 1 } } }));
    vi.spyOn(Math, "random").mockReturnValue(0.7);
    expect(hintDrawn("file-tree")).toBe(false);
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    expect(hintDrawn("file-tree")).toBe(false);
    useHintsStore.getState().reset();
    expect(saved).toMatchObject({ hints_seen: [], hints_read: {}, hints_enabled: true });
    expect(hintDrawn("file-tree")).toBe(true);
  });
});
