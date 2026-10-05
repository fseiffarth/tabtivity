/**
 * Steering and the real pointer, and held keys: a press while steering is on
 * starts navigation over from where it landed (a project pill → back on the
 * tabs; inside the walked surface → the cursor goes to what was pressed), and
 * a held key's repeats that the window had no time for are dropped instead of
 * queueing up and walking on after the key is let go.
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
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { clearRegionCursor, forgetRegionCursors, regionCursor } from "../../lib/shortcuts/steeringRegion";

function Keyboard() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function Header() {
  return (
    <header className="app-header">
      <button type="button" className="project-pill active" id="pill">
        project
      </button>
      <button type="button" id="plain">
        plain
      </button>
      <button type="button" id="other">
        other
      </button>
    </header>
  );
}

function Dialog() {
  return (
    <div className="modal-backdrop" id="d">
      <div className="project-dialog">
        <div data-y="10">
          <button type="button" id="d-a">
            a
          </button>
        </div>
        <div data-y="20">
          <button type="button" id="d-b">
            b
          </button>
        </div>
        <div data-y="30">
          <button type="button" id="d-c">
            c
          </button>
        </div>
      </div>
    </div>
  );
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

function pointer(id: string) {
  act(() => {
    document.getElementById(id)!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

const steering = () => useKeyboardSteeringStore.getState();

beforeEach(() => {
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
  useProjectsStore.setState({ projects: [] });
  useHeaderHoverMenuStore.setState({ openId: null });
  useKeyboardSteeringStore.getState().exit();
  forgetRegionCursors();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const y = Number(this.closest<HTMLElement>("[data-y]")?.dataset.y ?? 0);
    return { width: 10, height: 5, x: 0, y, top: y, left: 0, right: 10, bottom: y + 5, toJSON: () => ({}) };
  });
});

afterEach(() => {
  cleanup();
  clearRegionCursor();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("steering and the pointer", () => {
  it("a press on a project pill starts over on the tabs, from any level", async () => {
    render(
      <>
        <Keyboard />
        <Header />
      </>,
    );
    press({ key: " ", shiftKey: true });
    press({ key: "e" }); // tabs → projects (one subwindow)
    expect(steering().level).toBe("projects");
    pointer("pill");
    expect(steering()).toMatchObject({ active: true, level: "tabs", region: null });

    // From the top bar's cursor too, which never lands on a pill.
    press({ key: "e" });
    press({ key: "e" });
    expect(steering()).toMatchObject({ level: "region", region: "header" });
    await settle();
    pointer("pill");
    expect(steering()).toMatchObject({ active: true, level: "tabs", region: null });
    expect(regionCursor()).toBeNull();
  });

  it("a press inside the walked surface moves the cursor there and keeps the region", async () => {
    render(
      <>
        <Keyboard />
        <Header />
      </>,
    );
    press({ key: " ", shiftKey: true });
    press({ key: "e" });
    press({ key: "e" });
    await settle();
    expect(steering().region).toBe("header");
    pointer("other");
    expect(steering()).toMatchObject({ level: "region", region: "header" });
    expect(regionCursor()?.id).toBe("other");
  });

  it("a dialog still up after a press elsewhere takes steering back", async () => {
    render(
      <>
        <Keyboard />
        <Header />
        <Dialog />
      </>,
    );
    press({ key: " ", shiftKey: true });
    expect(steering()).toMatchObject({ level: "region", region: "overlay" });
    await settle();
    pointer("d-c");
    expect(regionCursor()?.id).toBe("d-c");
    pointer("plain");
    await settle();
    expect(steering()).toMatchObject({ level: "region", region: "overlay", regionReturn: "tabs" });
  });

  it("is ignored while steering is off", () => {
    render(
      <>
        <Keyboard />
        <Header />
      </>,
    );
    pointer("pill");
    expect(steering().active).toBe(false);
  });
});

describe("held keys", () => {
  it("drops a repeat that comes before the last step reached the screen", async () => {
    render(
      <>
        <Keyboard />
        <Dialog />
      </>,
    );
    press({ key: " ", shiftKey: true });
    await settle();
    expect(regionCursor()?.id).toBe("d-a");
    press({ key: "d" });
    expect(regionCursor()?.id).toBe("d-b");
    // Queued behind the step: dropped.
    press({ key: "d", repeat: true });
    expect(regionCursor()?.id).toBe("d-b");
    // A fresh press is never dropped.
    press({ key: "d" });
    expect(regionCursor()?.id).toBe("d-c");
    // A repeat after the step was painted walks on.
    await settle();
    press({ key: "d", repeat: true });
    expect(regionCursor()?.id).toBe("d-a");
  });
});
