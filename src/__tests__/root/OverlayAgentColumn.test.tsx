/**
 * `OverlayAgentColumn` — the docked agent column of the mail / calendar / to-do
 * overlays. It is an attach-only view of a ROOT tab (the PTY is `CenterPanel`'s),
 * shows a placeholder while the root console shows that tab itself, registers
 * the key it draws in `shownKeys` so `CenterPanel`'s copy steps aside, and draws
 * the user's stored width capped by the room the overlay has — never saving
 * that cap.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    Promise.resolve(cmd === "root_mcp_status" ? { running: true, tools: ["calendar_add_event"] } : undefined),
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const paneProps: Array<Record<string, unknown>> = [];
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: Record<string, unknown>) => {
    paneProps.push(props);
    return <div data-testid="pane" data-focused={String(props.focused)} />;
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { OverlayAgentColumn } from "../../components/layout/OverlayAgentColumn";

let tab: TabEntry;
const lastPane = () => paneProps[paneProps.length - 1];
const column = () => document.querySelector(".overlay-agent-column") as HTMLElement;

/** Render, then let the badge's `root_mcp_status` reading land inside act. */
async function mount(ui: React.ReactElement) {
  const result = render(ui);
  await act(async () => {});
  return result;
}

beforeEach(() => {
  cleanup();
  paneProps.length = 0;
  vi.mocked(invoke).mockClear();
  localStorage.clear();
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { root: [] },
    layoutByScope: { root: null },
    focusedGroupByScope: { root: null },
  });
  tab = useTabsStore.getState().addTabToScope("root", {
    label: "Claude",
    cmd: "claude",
    cwd: "",
    kind: "agent",
  });
  useProjectsStore.setState({ rootDir: "/r", activeId: "p1" });
  useRootOverlayStore.setState({ open: false, installTabs: {} });
  useOverlayAgentStore.setState({
    docks: {
      mail: { key: null, open: false },
      calendar: { key: tab.key, open: true },
      todo: { key: null, open: false },
    },
    shownKeys: new Set(),
    width: 560,
  });
});

describe("OverlayAgentColumn", () => {
  it("renders an attach-only root pane of the docked tab, focused on docking", async () => {
    await mount(<OverlayAgentColumn app="calendar" tab={tab} hint={null} />);

    expect(column()).not.toBeNull();
    expect(lastPane()).toMatchObject({
      tab,
      scope: "root",
      visible: true,
      focused: true,
      attachOnly: true,
      filesProjectDir: "/r",
      terminalCwd: "/r",
    });
    expect(screen.getByText("Claude")).toBeTruthy();
    // The root console's own badge, asked once for this mount.
    expect(document.querySelector(".root-overlay-rights.status")).not.toBeNull();
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "root_mcp_status")).toHaveLength(1);
  });

  it("hands the keyboard back to the app on a press outside, and takes it on a press inside", async () => {
    await mount(
      <>
        <button data-testid="app-pane">app</button>
        <OverlayAgentColumn app="calendar" tab={tab} hint={null} />
      </>,
    );
    fireEvent.pointerDown(screen.getByTestId("app-pane"));
    expect(screen.getByTestId("pane").dataset.focused).toBe("false");
    fireEvent.pointerDown(screen.getByTestId("pane"));
    expect(screen.getByTestId("pane").dataset.focused).toBe("true");
  });

  it("marks its key shown while the pane is drawn, and unmarks it on unmount", async () => {
    const { unmount } = await mount(<OverlayAgentColumn app="calendar" tab={tab} hint={null} />);
    expect(useOverlayAgentStore.getState().shownKeys.has(tab.key)).toBe(true);
    unmount();
    expect(useOverlayAgentStore.getState().shownKeys.has(tab.key)).toBe(false);
  });

  it("shows a placeholder, and stops claiming the key, while the root console is open", async () => {
    await mount(<OverlayAgentColumn app="calendar" tab={tab} hint={null} />);
    expect(useOverlayAgentStore.getState().shownKeys.has(tab.key)).toBe(true);
    paneProps.length = 0;

    act(() => useRootOverlayStore.setState({ open: true }));

    expect(screen.queryByTestId("pane")).toBeNull();
    expect(screen.getByText("Shown in the root console")).toBeTruthy();
    expect(useOverlayAgentStore.getState().shownKeys.has(tab.key)).toBe(false);

    act(() => useRootOverlayStore.setState({ open: false }));
    expect(screen.getByTestId("pane")).toBeTruthy();
    expect(useOverlayAgentStore.getState().shownKeys.has(tab.key)).toBe(true);
  });

  it("↗ hides the column and opens the root console on the tab", async () => {
    await mount(<OverlayAgentColumn app="calendar" tab={tab} hint={null} />);

    fireEvent.click(screen.getByTitle("Open in the root console"));

    expect(useOverlayAgentStore.getState().docks.calendar).toEqual({ key: tab.key, open: false });
    expect(useRootOverlayStore.getState().open).toBe(true);
  });

  it("× hides the column and keeps the docked key", async () => {
    const dismiss = vi.fn();
    await mount(<OverlayAgentColumn app="calendar" tab={tab} hint={null} onDismissHint={dismiss} />);

    fireEvent.click(screen.getByTitle("Hide the agent column"));

    expect(useOverlayAgentStore.getState().docks.calendar).toEqual({ key: tab.key, open: false });
    expect(useRootOverlayStore.getState().open).toBe(false);
    expect(dismiss).toHaveBeenCalled();
  });

  it("shows the hint with no tab, and no pane", async () => {
    await mount(<OverlayAgentColumn app="todo" tab={null} hint="Allow Claude in the root console" />);
    expect(screen.getByText("Allow Claude in the root console")).toBeTruthy();
    expect(screen.queryByTestId("pane")).toBeNull();
    expect(screen.queryByTitle("Open in the root console")).toBeNull();
  });

  it("leaves a hidden docked tab hidden when the hint shows the column", async () => {
    act(() => useOverlayAgentStore.getState().hide("calendar"));
    await mount(<OverlayAgentColumn app="calendar" tab={tab} hint="Allow Claude in the root console" />);

    expect(screen.getByText("Allow Claude in the root console")).toBeTruthy();
    expect(screen.queryByTestId("pane")).toBeNull();
    expect(useOverlayAgentStore.getState().shownKeys.has(tab.key)).toBe(false);
  });

  it("draws min(stored width, maxWidth) and never saves the cap", async () => {
    useOverlayAgentStore.setState({ width: 700 });
    const { rerender } = await mount(<OverlayAgentColumn app="calendar" tab={tab} hint={null} />);
    expect(column().style.width).toBe("700px");

    rerender(<OverlayAgentColumn app="calendar" tab={tab} hint={null} maxWidth={500} />);
    expect(column().style.width).toBe("500px");
    expect(useOverlayAgentStore.getState().width).toBe(700);
  });

  it("a drag held at the cap saves nothing", async () => {
    useOverlayAgentStore.setState({ width: 700 });
    await mount(<OverlayAgentColumn app="calendar" tab={tab} hint={null} maxWidth={500} />);
    const handle = document.querySelector(".overlay-agent-column .subwindow-files-resize")!;

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 1000 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 900 });
    expect(column().style.width).toBe("500px");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 900 });

    expect(useOverlayAgentStore.getState().width).toBe(700);
  });

  it("a left-edge drag resizes live and saves the width only when it ends", async () => {
    await mount(<OverlayAgentColumn app="calendar" tab={tab} hint={null} />);
    const handle = document.querySelector(".overlay-agent-column .subwindow-files-resize")!;

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 1000 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 900 });
    expect(column().style.width).toBe("660px");
    expect(useOverlayAgentStore.getState().width).toBe(560);

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 900 });
    expect(useOverlayAgentStore.getState().width).toBe(660);
    expect(column().style.width).toBe("660px");
  });
});
