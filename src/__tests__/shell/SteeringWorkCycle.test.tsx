/** Keep the keyboard usable through repeated file navigation and editing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import type { Terminal } from "@xterm/xterm";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { registerReaderViews, type ReaderViewId } from "../../lib/agents/readerSteering";
import { useKeyboard } from "../../hooks/useKeyboard";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

let clock = 1000;
const disposals: (() => void)[] = [];
/** Dispatch where the browser sends keys, retaining native cancellation. */
function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "timeStamp", { value: ++clock });
  act(() => { (document.activeElement ?? document.body).dispatchEvent(event); });
  return event;
}

function file(label: string) {
  const tab = useTabsStore.getState().addTab({ label, cmd: "", cwd: "/p", kind: "files" });
  const pane = document.createElement("div");
  pane.className = "center-pane";
  pane.dataset.scopeKey = "p";
  pane.dataset.tabKey = tab.key;
  pane.getBoundingClientRect = () => ({
    width: useTabsStore.getState().activeKey === tab.key ? 800 : 0,
    height: useTabsStore.getState().activeKey === tab.key ? 600 : 0,
  }) as DOMRect;
  const editor = document.createElement("textarea");
  editor.className = "file-viewer-editor";
  editor.value = label;
  pane.appendChild(editor);
  document.body.appendChild(pane);
  return { tab, editor };
}

beforeEach(() => {
  clock = 1000;
  useTabsStore.setState({
    scope: "p", tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {},
    tabs: [], layout: null, focusedGroupId: null, activeKey: null, fullscreenGroupId: null,
  });
  useSettingsStore.setState({ settings: null });
  useProjectsStore.setState({ projects: [] });
  useKeyboardSteeringStore.getState().exit();
});

afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  document.body.innerHTML = "";
});

describe("steering between editing visits", () => {
  it.each([
    { workKey: "Enter", projects: false },
    { workKey: "Escape", projects: false },
    { workKey: "Enter", projects: true },
    { workKey: "Escape", projects: true },
    { workKey: "ShiftSpace", projects: false },
    { workKey: "ShiftSpace", projects: true },
  ])("$workKey gives the selected file the caret before navigating further (projects: $projects)", ({ workKey, projects }) => {
    const first = file("first.txt");
    const second = file("second.txt");
    const third = file("third.txt");
    first.editor.focus();
    first.editor.setSelectionRange(2, 4);
    second.editor.setSelectionRange(1, 3);
    third.editor.setSelectionRange(0, 2);
    render(<Harness />);

    expect(press(" ", { shiftKey: true }).defaultPrevented).toBe(true);
    press("ArrowLeft"); // third -> second
    expect(useTabsStore.getState().activeKey).toBe(second.tab.key);
    if (projects) {
      press("ArrowUp");
      expect(useKeyboardSteeringStore.getState().level).toBe("projects");
    }
    press(workKey === "ShiftSpace" ? " " : workKey, { shiftKey: workKey === "ShiftSpace" });
    expect(useKeyboardSteeringStore.getState().active).toBe(false);
    expect(document.activeElement).toBe(second.editor);
    expect([second.editor.selectionStart, second.editor.selectionEnd]).toEqual([1, 3]);
    expect(press("x").defaultPrevented).toBe(false);

    // Normal typing owns Shift+Space during a burst; a deliberate pause lets
    // that same chord take navigation back from the actual editing caret.
    expect(press(" ", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(useKeyboardSteeringStore.getState().active).toBe(false);
    clock += 500;
    expect(press(" ", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(useKeyboardSteeringStore.getState().active).toBe(true);
    press("ArrowRight");
    expect(useTabsStore.getState().activeKey).toBe(third.tab.key);
    press(workKey === "ShiftSpace" ? " " : workKey, { shiftKey: workKey === "ShiftSpace" });
    expect(document.activeElement).toBe(third.editor);
    expect([third.editor.selectionStart, third.editor.selectionEnd]).toEqual([0, 2]);
    expect(press("y").defaultPrevented).toBe(false);
    expect(first.editor.value).toBe("first.txt");
  });
});


describe("steering hands Work to the visible terminal", () => {
  it.each(["Enter", "Escape", "ShiftSpace"])("%s focuses the selected terminal only when it is shown", (workKey) => {
    for (const view of [null, "terminal", "chat", "changes", "files"] as const) {
      const previous = document.createElement("button");
      document.body.appendChild(previous);
      previous.focus();
      const tab = useTabsStore.getState().addTab({ label: "agent", cmd: "agent", cwd: "/p", kind: "agent" });
      const id = `p:${tab.key}`;
      const input = document.createElement("textarea");
      const element = document.createElement("div");
      element.className = "xterm";
      element.appendChild(input);
      document.body.appendChild(element);
      const focus = vi.fn(() => input.focus());
      const terminal = {
        element, focus, rows: 30, modes: { mouseTrackingMode: "none" },
        buffer: { active: { type: "normal" } }, scrollToBottom: vi.fn(),
      } as unknown as Terminal;
      registerTerminal(id, terminal);
      disposals.push(() => unregisterTerminal(id, terminal));
      if (view) {
        disposals.push(registerReaderViews(id, {
          view: () => view,
          offered: () => ["chat", "changes", "files", "terminal"] as ReaderViewId[],
          show: vi.fn(),
        }));
      }
      const harness = render(<Harness />);
      clock += 500;
      press(" ", { shiftKey: true });
      expect(useKeyboardSteeringStore.getState().active).toBe(true);
      press(workKey === "ShiftSpace" ? " " : workKey, { shiftKey: workKey === "ShiftSpace" });
      expect(useKeyboardSteeringStore.getState().active).toBe(false);
      if (view === null || view === "terminal") {
        expect(focus).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(input);
      } else {
        expect(focus).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(previous);
      }
      harness.unmount();
    }
  });
});

describe("Work while the selected file loads", () => {
  it("focuses the selected editor when it mounts without requiring another steering visit", async () => {
    const selected = file("loading.txt");
    const pane = selected.editor.parentElement!;
    selected.editor.remove();
    const loading = document.createElement("div");
    loading.className = "file-viewer-loading";
    pane.appendChild(loading);
    const previous = document.createElement("button");
    document.body.appendChild(previous);
    previous.focus();
    render(<Harness />);
    press(" ", { shiftKey: true });
    press("Enter");
    expect(useKeyboardSteeringStore.getState().active).toBe(false);
    expect(document.activeElement).toBe(previous);
    selected.editor.setSelectionRange(1, 4);
    act(() => { loading.replaceWith(selected.editor); });
    await waitFor(() => expect(document.activeElement).toBe(selected.editor));
    expect([selected.editor.selectionStart, selected.editor.selectionEnd]).toEqual([1, 4]);
  });
});
