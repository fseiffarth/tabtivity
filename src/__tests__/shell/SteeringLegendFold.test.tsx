/**
 * The steering bar's H key: it folds the key list down to the badge and the
 * ladder while the mode stays on, H (or a click on the badge) unfolds it, and
 * the choice is remembered. Plus the bar's contents — the ladder with its lit
 * rung, the move/status/leave keys in `.tok-*`-coloured caps — and the caps
 * pinned to the controls they fire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { SteeringLegend } from "../../components/layout/SteeringLegend";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { STEERING_GROUPS, STEERING_KEYS } from "../../lib/shortcuts/shortcuts";
import { STEERING_BINDINGS, findSteeringConflicts, steeringActionFor } from "../../lib/shortcuts/steeringBindings";
import { storageKey } from "../../lib/brand";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

const steering = () => useKeyboardSteeringStore.getState();

beforeEach(() => {
  localStorage.clear();
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    fullscreenGroupId: null,
  });
  useSettingsStore.setState({ settings: null });
  useKeyboardSteeringStore.setState({ legendHidden: false });
  useKeyboardSteeringStore.getState().exit();
  useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("steering bar fold (H)", () => {
  it("binds H on every level without clashing", () => {
    const h = { key: "h", code: "KeyH" };
    for (const level of ["projects", "panes", "region"] as const) {
      expect(steeringActionFor(h, level, null)).toBe("legend");
    }
    expect(findSteeringConflicts(null).has("legend")).toBe(false);
  });

  it("folds the bar to the badge and the ladder and back, steering staying on", () => {
    render(
      <>
        <Harness />
        <SteeringLegend />
      </>,
    );
    press({ key: " ", shiftKey: true });
    const bar = () => document.querySelector(".steering-bar")!;
    expect(bar().classList.contains("folded")).toBe(false);
    expect(bar().querySelector(".steering-bar-keys")?.children.length).toBeGreaterThan(0);

    press({ key: "h" });
    expect(steering()).toMatchObject({ active: true, level: "tabs", legendHidden: true });
    expect(bar().classList.contains("folded")).toBe(true);
    // The ladder stays and the keys go; what is left is the way back and out.
    expect(bar().querySelector(".steering-rung.lit")?.textContent).toBe("Tabs");
    expect(bar().querySelector(".steering-bar-keys")?.children.length).toBe(0);
    const tail = [...bar().querySelectorAll(".steering-bar-tail .steering-bar-item")].map((el) => el.textContent);
    expect(tail).toEqual(["HShow keys", "EscExit"]);
    // The window still wears the steering frame.
    expect(document.documentElement.dataset.steer).toBe("tabs");

    press({ key: "h" });
    expect(steering()).toMatchObject({ active: true, legendHidden: false });
    expect(bar().classList.contains("folded")).toBe(false);
  });

  it("shows the keys again on every entry, and a badge click unfolds", () => {
    render(
      <>
        <Harness />
        <SteeringLegend />
      </>,
    );
    press({ key: " ", shiftKey: true });
    press({ key: "h" });
    expect(document.querySelector(".steering-bar.folded")).not.toBeNull();
    fireEvent.click(document.querySelector(".steering-bar-badge") as HTMLElement);
    expect(steering()).toMatchObject({ active: true, legendHidden: false });

    press({ key: "h" });
    press({ key: "Escape" });
    expect(steering().active).toBe(false);
    expect(document.querySelector(".steering-bar")).toBeNull();

    press({ key: " ", shiftKey: true });
    expect(steering()).toMatchObject({ active: true, legendHidden: false });
    expect(document.querySelector(".steering-bar.folded")).toBeNull();
    expect(document.querySelector(".steering-bar-keys")?.children.length).toBeGreaterThan(0);
    // Nothing is kept per machine any more.
    expect(localStorage.getItem(storageKey("steering.legendHidden"))).toBeNull();
  });
});

describe("steering bar hands-free mic", () => {
  const voice = (on: boolean) =>
    useSettingsStore.setState({ settings: { voice_hands_free: true, voice_hands_free_on: on } as never });
  const mic = () => document.querySelector(".steering-bar-mic");

  it("wears the mic on the badge while hands-free is on, folded too", () => {
    voice(true);
    render(<SteeringLegend />);
    act(() => steering().enter());
    expect(document.querySelector(".steering-bar-badge .steering-bar-mic")).not.toBeNull();
    expect(mic()?.getAttribute("aria-label")).toBe("Hands-free");

    act(() => steering().toggleLegend());
    expect(document.querySelector(".steering-bar.folded .steering-bar-badge .steering-bar-mic")).not.toBeNull();
  });

  it("shows no mic with the chip off or the experiment off", () => {
    voice(false);
    render(<SteeringLegend />);
    act(() => steering().enter());
    expect(document.querySelector(".steering-bar-badge")).not.toBeNull();
    expect(mic()).toBeNull();

    act(() => useSettingsStore.setState({ settings: { voice_hands_free: false, voice_hands_free_on: true } as never }));
    expect(mic()).toBeNull();
  });
});

describe("steering bar contents", () => {
  it("files every row under a known group", () => {
    const ids = new Set(STEERING_GROUPS.map((g) => g.id));
    for (const row of STEERING_KEYS) expect(ids.has(row.group)).toBe(true);
    // The fold key is listed, so the bar says how to fold it.
    expect(STEERING_KEYS.some((r) => r.actions.includes("legend"))).toBe(true);
    expect(STEERING_BINDINGS.some((b) => b.action === "legend")).toBe(true);
  });

  it("names the level on a ladder and colours each key cap by its group", () => {
    render(<SteeringLegend />);
    act(() => steering().enter());
    const bar = document.querySelector(".steering-bar")!;
    expect([...bar.querySelectorAll(".steering-rung")].map((r) => r.textContent)).toEqual([
      "Projects",
      "Subwindows",
      "Tabs",
      "Inside",
    ]);
    expect(bar.querySelector(".steering-rung.lit")?.textContent).toBe("Tabs");
    // Nothing is drawn (no layout here), so every key is in the bar, in its
    // group's token colour.
    const colourOf = (label: string) =>
      [...bar.querySelectorAll(".steering-bar-item")]
        .find((el) => el.querySelector(".steering-bar-label")?.textContent === label)
        ?.querySelector(".steering-cap")?.className;
    expect(colourOf("Hide keys")).toContain("tok-comment");
    expect(colourOf("Work here")).toContain("tok-comment");
    expect(colourOf("Exit")).toContain("tok-comment");
    // The up/down pair is the ladder's one entry.
    expect(colourOf("Up · down")).toContain("tok-func");
  });

  it("takes its height out of the window while it is up", () => {
    render(<SteeringLegend />);
    expect(document.documentElement.dataset.steerBar).toBeUndefined();
    act(() => steering().enter());
    expect(document.documentElement.dataset.steerBar).toBe("");
    act(() => steering().handOff("search"));
    expect(document.documentElement.dataset.steerBar).toBe("");
    act(() => steering().exit());
    expect(document.documentElement.dataset.steerBar).toBeUndefined();
  });

  it("shows the rebound key, not the default one", () => {
    useSettingsStore.setState({ settings: { steering_keys: { legend: ["g"], exit: ["q"] } } as never });
    render(<SteeringLegend />);
    act(() => steering().enter());
    act(() => steering().toggleLegend());
    const tail = [...document.querySelectorAll(".steering-bar-tail .steering-bar-item")].map((el) => el.textContent);
    expect(tail).toEqual(["GShow keys", "QExit"]);
  });
});
