/**
 * Steering lending the keyboard to a box (`handOff`): the project jump, the
 * prompt box (I, and Plan / Goal led with their command), a surface's search
 * field. The mode goes off, the legend stays with that box's keys and Esc back,
 * and coming back lands where steering was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

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
import { STEERING_PROMPT_EVENT, type SteeringPromptDetail } from "../../lib/shortcuts/steeringAgent";
import { BRAND } from "../../lib/brand";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(key: string) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
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
  steering().exit();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("steering hand-off", () => {
  it("comes back where it was lent from", () => {
    steering().enter();
    steering().enterRegion("side");
    steering().handOff("search");
    expect(steering()).toMatchObject({ active: false, handedTo: "search" });
    steering().resume();
    expect(steering()).toMatchObject({ active: true, level: "region", region: "side", handedTo: null });
  });

  it("keeps the bar up with the box's keys and Esc back, folded or not", () => {
    const { container } = render(<SteeringLegend />);
    expect(document.querySelector(".steering-bar")).toBeNull();
    act(() => {
      steering().enter();
      steering().handOff("prompt");
    });
    let bar = document.querySelector(".steering-bar");
    expect(bar?.textContent).toContain(`Back to ${BRAND.display} navigation`);
    expect(bar?.textContent).toContain("Esc");
    expect(bar?.textContent).toContain("Send");
    // The mark is hollow (steering is off) and the rung names the box.
    expect(bar?.querySelector(".steering-bar-badge.hollow")).not.toBeNull();
    expect(bar?.querySelector(".steering-rung.lent")?.textContent).toBe("Prompt");
    expect([...bar!.querySelectorAll(".steering-rung")].map((r) => r.textContent)).toEqual(["Tabs", "Prompt"]);
    act(() => {
      steering().toggleLegend();
    });
    bar = document.querySelector(".steering-bar");
    expect(bar?.textContent).toContain(`Back to ${BRAND.display} navigation`);
    act(() => {
      steering().dropHandoff();
    });
    expect(document.querySelector(".steering-bar")).toBeNull();
    expect(container).toBeTruthy();
  });

  it("Esc in a lent search field brings steering back on its surface", () => {
    render(<Harness />);
    act(() => {
      steering().enter();
      steering().enterRegion("side");
      steering().handOff("search");
    });
    press("Escape");
    expect(steering()).toMatchObject({ active: true, level: "region", region: "side", handedTo: null });
  });

  it("Plan opens the prompt box led with /plan instead of leaving the mode", () => {
    const seen: SteeringPromptDetail[] = [];
    const box = (e: Event) => {
      const detail = (e as CustomEvent<SteeringPromptDetail>).detail;
      detail.handled = true;
      seen.push(detail);
    };
    window.addEventListener(STEERING_PROMPT_EVENT, box);
    try {
      useTabsStore.getState().addTab({ label: "claude", cmd: "claude", cwd: "/p", kind: "agent" });
      render(<Harness />);
      act(() => steering().enter());
      press("l");
      expect(seen).toHaveLength(1);
      expect(seen[0].lead).toBe("/plan");
      expect(steering()).toMatchObject({ active: false, handedTo: "prompt" });
    } finally {
      window.removeEventListener(STEERING_PROMPT_EVENT, box);
    }
  });
});
