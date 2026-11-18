import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hintChance, rollHint } from "../../lib/hintChance";
import { HINTS, pickHint, type HintCtx } from "../../lib/shortcuts/hints";
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

describe("hint rotation", () => {
  const onScreen = { anchorOnScreen: () => true };

  it("a hint closed without reading gives way to the next one at the next start", () => {
    expect(pickHint(active, new Set(), true, { ...onScreen, shownAt: {} })).toBe("add-tab");
    expect(pickHint(active, new Set(), true, { ...onScreen, shownAt: { "add-tab": 100 } })).toBe("toggle-panels");
  });

  it("walks the feature tips instead of opening every sitting on the same three", () => {
    const shownAt: Record<string, number> = { "add-tab": 1, "toggle-panels": 2, "file-tree": 3 };
    const picks: string[] = [];
    for (let at = 10; at < 16; at += 1) {
      const id = pickHint(active, new Set(), true, { ...onScreen, shownAt })!;
      picks.push(id);
      shownAt[id] = at;
    }
    expect(new Set(picks).size).toBe(6);
  });

  it("the tip that has waited longest comes back once every other has had its turn", () => {
    const everyOther = Object.fromEntries(HINTS.map((h) => [h.id, 1_000]));
    expect(pickHint(active, new Set(), true, { ...onScreen, shownAt: { ...everyOther, "header-todo": 5 } })).toBe("header-todo");
  });

  it("a repeat of an onboarding hint waits out the same pacing as a feature tip", () => {
    const shownAt = { "add-tab": 1, "toggle-panels": 2, "file-tree": 3 };
    expect(pickHint(active, new Set(), true, { ...onScreen, shownAt, allowFeature: false })).toBeNull();
    expect(pickHint(active, new Set(), true, { ...onScreen, shownAt: {}, allowFeature: false })).toBe("add-tab");
  });

  it("a hint about the state right now neither rotates nor waits", () => {
    const empty: HintCtx = { projectCount: 0, activeId: null };
    expect(pickHint(empty, new Set(), true, { ...onScreen, shownAt: { "create-project": 100 }, allowFeature: false })).toBe("create-project");
    const codex: HintCtx = { ...active, codexHookNeedsTrust: true };
    expect(pickHint(codex, new Set(), true, { ...onScreen, shownAt: { "codex-hook-trust": 100 }, allowFeature: false })).toBe("codex-hook-trust");
  });

  it("a stored time that is not a number counts as never shown", () => {
    const shownAt = { "add-tab": "soon" } as unknown as Record<string, number>;
    expect(pickHint(active, new Set(), true, { ...onScreen, shownAt })).toBe("add-tab");
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

  it("remembers when a hint came up, whichever way it is closed; reset forgets it", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    useHintsStore.getState().show("add-tab");
    useHintsStore.getState().dismiss("add-tab");
    expect(saved.hints_shown).toEqual({ "add-tab": 5_000 });
    useHintsStore.getState().reset();
    expect(saved.hints_shown).toEqual({});
  });

  it("a repeat counts towards the sitting's cap, a first showing of an onboarding hint does not", () => {
    useHintsStore.setState({ featureShown: 0 });
    useHintsStore.getState().show("add-tab");
    expect(useHintsStore.getState().featureShown).toBe(0);
    useHintsStore.getState().show("add-tab");
    expect(useHintsStore.getState().featureShown).toBe(1);
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
