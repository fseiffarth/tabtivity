// The To-do view of the console window (`todo/TodoView`): the board fills the
// window's body, the window's × closes it, Escape and a backdrop press close the
// window; a press inside the frame does not. The bar's agent button docks a root
// agent beside the board (`OverlayAgentColumn`), whose Escape is the agent's,
// and whose drawn width leaves the board room.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The root agent probe and the rights badge's reading; nothing else is asked.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: { bins?: string[] }) => {
    switch (cmd) {
      case "list_agents":
        return Promise.resolve([{ id: "claude", bin: "claude", installed: true }]);
      case "probe_binaries":
        return Promise.resolve(args?.bins ?? []);
      case "list_local_drivers":
        return Promise.resolve([]);
      case "root_mcp_status":
        return Promise.resolve({ running: true, tools: [] });
      default:
        return Promise.resolve(undefined);
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
// The docked pane is the column's subject; here only what it was handed.
const paneProps: Array<Record<string, unknown>> = [];
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: Record<string, unknown>) => {
    paneProps.push(props);
    return <div data-testid="agent-pane" />;
  },
}));

// The board is its own subject (and a heavy one); only the chrome is under test.
vi.mock("../../components/todo/TodoPane", () => ({
  TodoPane: () => <div data-testid="todo-pane" />,
}));
vi.mock("../../components/layout/OverlayApprovals", () => ({ OverlayApprovals: () => null }));

import { invoke } from "@tauri-apps/api/core";
import { RootOverlayHost } from "../../components/layout/RootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useOverlayAgentStore } from "../../stores/overlayAgent";

const rootTabs = () => useTabsStore.getState().tabsByScope.root ?? [];
const column = () => document.querySelector<HTMLElement>(".overlay-agent-column");
const agentButton = () => screen.getByRole("button", { name: "Agent (Ctrl+1)" });

/** Render the board and let the root agent probe answer. */
async function mountWithAgents() {
  render(<RootOverlayHost />);
  await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("list_agents"));
  await act(async () => {});
}

beforeEach(() => {
  localStorage.clear();
  paneProps.length = 0;
  vi.mocked(invoke).mockClear();
  useSettingsStore.setState({
    settings: { todo_board: true, default_agent_cmd: "claude", root_agents: ["claude"] },
    loaded: true,
  } as never);
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { root: [] },
    layoutByScope: { root: null },
    focusedGroupByScope: { root: null },
  });
  useProjectsStore.setState({ rootDir: "/r", activeId: "p1" });
  useRootOverlayStore.setState({ open: true, view: "todo" });
  useOverlayAgentStore.setState({
    docks: {
      mail: { key: null, open: false },
      calendar: { key: null, open: false },
      todo: { key: null, open: false },
    },
    shownKeys: new Set(),
    width: 560,
  });
});
afterEach(cleanup);

describe("the To-do view", () => {
  it("fills the window's body under the window's own bar, and the window's × closes it", async () => {
    render(<RootOverlayHost />);
    await screen.findByTestId("todo-pane");
    const frame = screen.getByRole("dialog", { name: "Cockpit" });
    expect(frame.classList.contains("root-overlay")).toBe(true);
    expect(frame.querySelector(".app-view-todo")).not.toBeNull();
    // The view strip marks it as the selected one.
    expect(screen.getByRole("tab", { name: "To-do" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("closes on Escape and on a backdrop press, not on a press inside", async () => {
    render(<RootOverlayHost />);
    fireEvent.mouseDown(await screen.findByTestId("todo-pane"));
    expect(useRootOverlayStore.getState().open).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useRootOverlayStore.getState().open).toBe(false);

    act(() => useTodoStore.getState().openOverlay());
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "todo" });
    const backdrop = document.querySelector(".app-overlay-backdrop")!;
    fireEvent.mouseDown(backdrop);
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("does not open while the board is switched off, and falls back to Now when it goes off", async () => {
    useSettingsStore.setState({ settings: { todo_board: false } } as never);
    useRootOverlayStore.setState({ open: false, view: "root" });
    render(<RootOverlayHost />);
    act(() => useTodoStore.getState().openOverlay());
    expect(useRootOverlayStore.getState().open).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();

    useSettingsStore.setState({ settings: { todo_board: true } } as never);
    act(() => useTodoStore.getState().openOverlay());
    expect(await screen.findByTestId("todo-pane")).toBeTruthy();
    act(() => useSettingsStore.setState({ settings: { todo_board: false } } as never));
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "now" });
  });

  it("leaving the view drops an in-flight drag and an unconsumed card request", async () => {
    render(<RootOverlayHost />);
    await screen.findByTestId("todo-pane");
    act(() => useTodoStore.setState({ focusTaskId: "c1", cardDrag: { id: "c1" } as never }));
    act(() => useRootOverlayStore.getState().openView("now"));
    expect(useTodoStore.getState()).toMatchObject({ focusTaskId: null, cardDrag: null });
  });

  it("docks the default root agent beside the board from the bar's button", async () => {
    await mountWithAgents();
    const button = agentButton();
    // Before the approvals pill, a subwindow button like ⤢ and ×.
    expect(button.classList.contains("subwindow-hide")).toBe(true);
    expect(button.closest(".root-overlay-controls")).not.toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(column()).toBeNull();

    fireEvent.click(button);

    expect(rootTabs()).toHaveLength(1);
    const tab = rootTabs()[0];
    expect(tab).toMatchObject({ cmd: "claude", kind: "agent" });
    expect(useOverlayAgentStore.getState().docks.todo).toEqual({ key: tab.key, open: true });
    // The column sits in the body row, after the board.
    const body = document.querySelector(".todo-overlay-body")!;
    expect(body.classList.contains("app-overlay-body-row")).toBe(true);
    expect(body.lastElementChild).toBe(column());
    const pane = paneProps[paneProps.length - 1];
    expect(pane).toMatchObject({ scope: "root", attachOnly: true, visible: true });
    expect((pane.tab as { key: string }).key).toBe(tab.key);
    expect(agentButton().getAttribute("aria-pressed")).toBe("true");

    // Pressed again: the column hides; the tab lives on in root.
    fireEvent.click(agentButton());
    expect(column()).toBeNull();
    expect(rootTabs()).toHaveLength(1);
  });

  it("leaves Escape typed in the docked agent to the agent, and still closes on any other", async () => {
    await mountWithAgents();
    fireEvent.click(agentButton());

    fireEvent.keyDown(screen.getByTestId("agent-pane"), { key: "Escape" });
    expect(useRootOverlayStore.getState().open).toBe(true);

    fireEvent.keyDown(screen.getByTestId("todo-pane"), { key: "Escape" });
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("caps the column's drawn width to leave the board room, without saving the cap", async () => {
    let bodyWidth = 1400;
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const w = this.classList.contains("todo-overlay-body") ? bodyWidth : 0;
        return { width: w, height: 600, top: 0, left: 0, right: w, bottom: 600, x: 0, y: 0, toJSON() {} } as DOMRect;
      });
    const observed: ResizeObserverCallback[] = [];
    const RealObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        observed.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      await mountWithAgents();
      fireEvent.click(agentButton());
      // Room for the user's 560 px and the board.
      expect(column()!.style.width).toBe("560px");

      // The frame shrinks: the column gives up what the board needs (360 px)…
      bodyWidth = 800;
      act(() => observed.forEach((cb) => cb([], {} as ResizeObserver)));
      expect(column()!.style.width).toBe("440px");

      // …but never below its own minimum; a window resize re-measures too.
      bodyWidth = 420;
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(column()!.style.width).toBe("320px");
      expect(useOverlayAgentStore.getState().width).toBe(560);
    } finally {
      globalThis.ResizeObserver = RealObserver;
      rect.mockRestore();
    }
  });
});
