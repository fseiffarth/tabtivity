/**
 * A text field in a dialog takes the keys (`field` hand-off). Tab to a button
 * or checkbox in the same dialog means the user is not typing: steering takes
 * the keys back on the dialog, so one Escape closes it. Tab to another text
 * field keeps the hand-off, so Tab walks the fields as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { clearRegionCursor, forgetRegionCursors, regionCursor } from "../../lib/shortcuts/steeringRegion";

function Keyboard() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

/** A dialog with a name field (the caret goes there), a second field, and
 *  buttons. Closes on its own Escape, as most dialogs do. */
function Dialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" id="d">
      <div className="project-dialog">
        <button type="button" className="dialog-close-btn" onClick={onClose}>
          ×
        </button>
        <div data-y="10">
          <input id="d-name" type="text" autoFocus />
        </div>
        <div data-y="15">
          <input id="d-other" type="text" />
        </div>
        <div data-y="20">
          <button type="button" id="d-cancel" onClick={onClose}>
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("test:open", show);
    return () => window.removeEventListener("test:open", show);
  }, []);
  return <>{open && <Dialog onClose={() => setOpen(false)} />}</>;
}

/** A dialog with a slider only: Enter on it hands it the arrows. */
function SliderDialog() {
  return (
    <div className="modal-backdrop" id="s">
      <div className="project-dialog">
        <button type="button" className="dialog-close-btn">
          ×
        </button>
        <div data-y="10">
          <input id="s-zoom" type="range" min={0} max={10} defaultValue={5} />
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

// Past `syncSoon`'s late pass and the field-hand-off check's own timeout.
const SETTLE_MS = 200;
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  });
}

const steering = () => useKeyboardSteeringStore.getState();
const on = () => {
  press({ key: " ", shiftKey: true });
  expect(steering().active).toBe(true);
};

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
  useKeyboardSteeringStore.getState().exit();
  forgetRegionCursors();
  // jsdom has no layout: every element gets a box, its row set by the
  // nearest `data-y` so the cursor can find the controls.
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

describe("a dialog field handed the keys", () => {
  it("Tab to a button takes the keys back; one Escape closes the dialog", async () => {
    render(
      <>
        <Keyboard />
        <App />
      </>,
    );
    on();
    act(() => void window.dispatchEvent(new Event("test:open")));
    await settle();
    expect(document.activeElement?.id).toBe("d-name");
    expect(steering()).toMatchObject({ active: false, handedTo: "field" });

    // Tab moves the caret to the dialog's button.
    act(() => (document.getElementById("d-cancel") as HTMLButtonElement).focus());
    await settle();
    expect(steering()).toMatchObject({ active: true, level: "region", region: "overlay", handedTo: null });
    expect(regionCursor()?.id).toBe("d-cancel");

    press({ key: "Escape" });
    await settle();
    expect(document.getElementById("d")).toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "tabs", region: null });
  });

  it("a slider Enter handed the keys keeps them past the first arrow", async () => {
    render(
      <>
        <Keyboard />
        <SliderDialog />
      </>,
    );
    on();
    await settle();
    expect(regionCursor()?.id).toBe("s-zoom");
    press({ key: "Enter" });
    expect(document.activeElement?.id).toBe("s-zoom");
    expect(steering()).toMatchObject({ active: false, handedTo: "field" });

    // A slider is no text field, yet it is the control the keys went to.
    press({ key: "ArrowRight" });
    press({ key: "ArrowRight" });
    await settle();
    expect(steering()).toMatchObject({ active: false, handedTo: "field" });
    expect(document.activeElement?.id).toBe("s-zoom");
  });

  it("Tab to another text field keeps the hand-off", async () => {
    render(
      <>
        <Keyboard />
        <App />
      </>,
    );
    on();
    act(() => void window.dispatchEvent(new Event("test:open")));
    await settle();
    act(() => (document.getElementById("d-other") as HTMLInputElement).focus());
    await settle();
    expect(document.activeElement?.id).toBe("d-other");
    expect(steering()).toMatchObject({ active: false, handedTo: "field" });
    expect(document.getElementById("d")).not.toBeNull();
  });
});
