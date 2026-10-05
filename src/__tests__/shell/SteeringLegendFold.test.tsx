/**
 * The steering legend's H key: it folds the key list into a round corner
 * badge while the mode stays on, H (or a click on the badge) unfolds it, and
 * the choice is remembered. Plus the legend's grouped boxes — no title, one
 * `.tok-*`-coloured box per `STEERING_GROUPS` entry.
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

describe("steering legend fold (H)", () => {
  it("binds H on every level without clashing", () => {
    const h = { key: "h", code: "KeyH" };
    for (const level of ["projects", "panes", "region"] as const) {
      expect(steeringActionFor(h, level, null)).toBe("legend");
    }
    expect(findSteeringConflicts(null).has("legend")).toBe(false);
  });

  it("folds the legend into the corner badge and back, steering staying on", () => {
    render(
      <>
        <Harness />
        <SteeringLegend />
      </>,
    );
    press({ key: " ", shiftKey: true });
    expect(document.querySelector(".steering-legend")).not.toBeNull();
    expect(document.querySelector(".steering-legend-fab")).toBeNull();

    press({ key: "h" });
    expect(steering()).toMatchObject({ active: true, level: "tabs", legendHidden: true });
    expect(document.querySelector(".steering-legend")).toBeNull();
    const fab = document.querySelector(".steering-legend-fab-button");
    expect(fab?.querySelector("kbd")?.textContent).toBe("H");
    // The window still wears the steering frame.
    expect(document.documentElement.dataset.steer).toBe("tabs");

    press({ key: "h" });
    expect(steering()).toMatchObject({ active: true, legendHidden: false });
    expect(document.querySelector(".steering-legend")).not.toBeNull();
  });

  it("remembers the fold across leaving steering, and a badge click unfolds", () => {
    render(
      <>
        <Harness />
        <SteeringLegend />
      </>,
    );
    press({ key: " ", shiftKey: true });
    press({ key: "h" });
    expect(localStorage.getItem(storageKey("steering.legendHidden"))).toBe("1");
    press({ key: " " });
    expect(steering().active).toBe(false);
    expect(document.querySelector(".steering-legend-fab")).toBeNull();

    press({ key: " ", shiftKey: true });
    const fab = document.querySelector(".steering-legend-fab-button") as HTMLElement;
    expect(fab).not.toBeNull();
    fireEvent.click(fab);
    expect(steering()).toMatchObject({ active: true, legendHidden: false });
    expect(localStorage.getItem(storageKey("steering.legendHidden"))).toBeNull();
  });
});

describe("steering legend groups", () => {
  it("files every row under a known group", () => {
    const ids = new Set(STEERING_GROUPS.map((g) => g.id));
    for (const row of STEERING_KEYS) expect(ids.has(row.group)).toBe(true);
    // The fold key is listed, so the legend says how to fold it.
    expect(STEERING_KEYS.some((r) => r.actions.includes("legend"))).toBe(true);
    expect(STEERING_BINDINGS.some((b) => b.action === "legend")).toBe(true);
  });

  it("shows no title, only the level name and token-coloured boxes", () => {
    render(<SteeringLegend />);
    act(() => steering().enter());
    const legend = document.querySelector(".steering-legend")!;
    expect(legend.querySelector(".steering-legend-title")).toBeNull();
    expect(legend.querySelector(".steering-legend-where")?.textContent).toContain("Tabs");
    const boxes = [...legend.querySelectorAll<HTMLElement>(".steering-legend-group")];
    expect(boxes.map((b) => b.dataset.group)).toEqual(expect.arrayContaining(["move", "new", "mode"]));
    for (const box of boxes) {
      const tok = STEERING_GROUPS.find((g) => g.id === box.dataset.group)!.tok;
      expect(box.classList.contains(tok)).toBe(true);
    }
    const mode = boxes.find((b) => b.dataset.group === "mode")!;
    expect(mode.textContent).toContain("Hide keys");
  });
});
