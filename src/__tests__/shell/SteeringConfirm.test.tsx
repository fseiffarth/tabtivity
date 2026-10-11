/**
 * Steering asks before W closes a tab or K clears an agent's conversation: the
 * box comes up as the overlay region with the cursor on Cancel; the Confirm
 * key (Y) does it, Escape keeps the tab, and steering is back on the level
 * either way.
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
vi.mock("../../lib/shortcuts/steeringAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/shortcuts/steeringAgent")>()),
  clearAgentTab: vi.fn().mockResolvedValue(true),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { SteeringConfirmOverlay } from "../../components/layout/SteeringConfirmOverlay";
import { clearAgentTab } from "../../lib/shortcuts/steeringAgent";
import { steeringKeysFor } from "../../lib/shortcuts/shortcuts";
import { clearRegionCursor, forgetRegionCursors } from "../../lib/shortcuts/steeringRegion";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

function Keyboard() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(key: string) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

const steering = () => useKeyboardSteeringStore.getState();
const dialog = () => document.querySelector('[role="dialog"]');

function activeTab(tab: Partial<TabEntry>) {
  const entry = { key: "t1", label: "Claude", cmd: "claude", cwd: "/p", ...tab } as TabEntry;
  useTabsStore.setState({ scope: "p", tabs: [entry], tabsByScope: { p: [entry] }, activeKey: entry.key });
}

function mount() {
  render(
    <>
      <Keyboard />
      <SteeringConfirmOverlay />
    </>,
  );
  act(() => {
    steering().enter();
    steering().setLevel("panes");
  });
}

beforeEach(() => {
  vi.mocked(clearAgentTab).mockClear();
  useSettingsStore.setState({ settings: null });
  useKeyboardSteeringStore.getState().exit();
  forgetRegionCursors();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 10, height: 5, x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 5, toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  clearRegionCursor();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("steering asks before closing or clearing", () => {
  it("W asks; Y closes the tab and steering comes back on the level", async () => {
    activeTab({ kind: "shell" });
    mount();
    press("w");
    expect(dialog()?.textContent).toContain("Close “Claude”?");
    expect(useTabsStore.getState().tabs).toHaveLength(1);
    await settle();
    expect(steering()).toMatchObject({ active: true, level: "region", region: "overlay", regionReturn: "panes" });
    press("y");
    await settle();
    expect(dialog()).toBeNull();
    expect(useTabsStore.getState().tabsByScope.p ?? []).toHaveLength(0);
    expect(steering()).toMatchObject({ active: true, level: "panes" });
  });

  it("Escape keeps the tab", async () => {
    activeTab({ kind: "shell" });
    mount();
    press("w");
    await settle();
    press("Escape");
    await settle();
    expect(dialog()).toBeNull();
    expect(useTabsStore.getState().tabsByScope.p).toHaveLength(1);
    expect(steering()).toMatchObject({ active: true, level: "panes" });
  });

  it("K asks before /clear goes in; nothing asks on a tab that is not an agent", async () => {
    activeTab({ kind: "agent", scheduleTargetId: "target" });
    mount();
    press("k");
    expect(dialog()?.textContent).toContain("Clear “Claude”?");
    expect(clearAgentTab).not.toHaveBeenCalled();
    await settle();
    press("y");
    await settle();
    expect(clearAgentTab).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();

    activeTab({ kind: "shell" });
    press("k");
    expect(dialog()).toBeNull();
  });

  it("the legend lists the Confirm key only over steering's own box", () => {
    const base = {
      level: "region" as const,
      sideRegion: false,
      overlayRegion: true,
      multiPane: false,
      apps: { mail: false, calendar: false, todo: false },
      statusCounts: { decision: 0, working: 0, done: 0 },
    };
    const lists = (s: typeof base & { steeringConfirm?: boolean }) =>
      steeringKeysFor(s).some((k) => k.actions.includes("confirm"));
    expect(lists({ ...base, steeringConfirm: true })).toBe(true);
    expect(lists(base)).toBe(false);
  });
});
