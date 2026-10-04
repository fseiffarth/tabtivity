// The calendar window (`calendar/CalendarOverlay`) and its docked agent: the
// bar's agent button (and Ctrl+1–9 while the calendar is in front) docks a root
// agent beside the calendar (`OverlayAgentColumn`). Escape typed into that agent
// is its own cancel key; anywhere else it still closes the window. A chord is
// answered only by the overlay it names, and only while that overlay is up.
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
// The calendar and the board are their own subjects; only the chrome is here.
vi.mock("../../components/calendar/CalendarPane", () => ({
  CalendarPane: () => <div data-testid="calendar-pane" />,
}));
vi.mock("../../components/todo/TodoPane", () => ({
  TodoPane: () => <div data-testid="todo-pane" />,
}));
vi.mock("../../components/layout/OverlayApprovals", () => ({ OverlayApprovals: () => null }));
const paneProps: Array<Record<string, unknown>> = [];
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: Record<string, unknown>) => {
    paneProps.push(props);
    return <div data-testid="agent-pane" />;
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { CalendarOverlayHost } from "../../components/calendar/CalendarOverlay";
import { TodoOverlayHost } from "../../components/todo/TodoOverlay";
import { requestOverlayAgent } from "../../lib/shortcuts/newTabChord";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useOverlayAgentStore } from "../../stores/overlayAgent";

const rootTabs = () => useTabsStore.getState().tabsByScope.root ?? [];
const docks = () => useOverlayAgentStore.getState().docks;
const column = () => document.querySelector<HTMLElement>(".overlay-agent-column");

/** Render, then let the root agent probe answer. */
async function mountWithAgents(ui: React.ReactElement) {
  render(ui);
  await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("list_agents"));
  await act(async () => {});
}

beforeEach(() => {
  localStorage.clear();
  paneProps.length = 0;
  vi.mocked(invoke).mockClear();
  useSettingsStore.setState({
    settings: {
      calendar_global_app: true,
      todo_board: true,
      default_agent_cmd: "claude",
      root_agents: ["claude"],
    },
    loaded: true,
  } as never);
  useCalendarStore.setState({ overlayOpen: true });
  useTodoStore.setState({ overlayOpen: false });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { root: [] },
    layoutByScope: { root: null },
    focusedGroupByScope: { root: null },
  });
  useProjectsStore.setState({ rootDir: "/r", activeId: "p1" });
  useRootOverlayStore.setState({ open: false });
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

describe("the calendar window's docked agent", () => {
  it("docks the default root agent beside the calendar from the bar's button", async () => {
    await mountWithAgents(<CalendarOverlayHost />);
    const button = screen.getByRole("button", { name: "Agent (Ctrl+1)" });
    // First in the controls, before the approvals pill and ⤢ / ×.
    expect(button.parentElement?.classList.contains("root-overlay-controls")).toBe(true);
    expect(button.parentElement?.firstElementChild).toBe(button);

    fireEvent.click(button);

    expect(rootTabs()).toHaveLength(1);
    const tab = rootTabs()[0];
    expect(docks().calendar).toEqual({ key: tab.key, open: true });
    const body = document.querySelector(".calendar-overlay-body")!;
    expect(body.classList.contains("app-overlay-body-row")).toBe(true);
    expect(body.firstElementChild).toBe(screen.getByTestId("calendar-pane"));
    expect(body.lastElementChild).toBe(column());
    const pane = paneProps[paneProps.length - 1];
    expect(pane).toMatchObject({ scope: "root", attachOnly: true });
    expect((pane.tab as { key: string }).key).toBe(tab.key);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("leaves Escape typed in the docked agent to the agent, and still closes on any other", async () => {
    await mountWithAgents(<CalendarOverlayHost />);
    fireEvent.click(screen.getByRole("button", { name: "Agent (Ctrl+1)" }));

    fireEvent.keyDown(screen.getByTestId("agent-pane"), { key: "Escape" });
    expect(useCalendarStore.getState().overlayOpen).toBe(true);
    // The column's own buttons are inside it too.
    fireEvent.keyDown(screen.getByRole("button", { name: "Hide the agent column" }), { key: "Escape" });
    expect(useCalendarStore.getState().overlayOpen).toBe(true);

    fireEvent.keyDown(screen.getByTestId("calendar-pane"), { key: "Escape" });
    expect(useCalendarStore.getState().overlayOpen).toBe(false);
  });

  it("answers Ctrl+1 only in the overlay that is up", async () => {
    await mountWithAgents(
      <>
        <CalendarOverlayHost />
        <TodoOverlayHost />
      </>,
    );

    // The board is not up: its number goes on, and nothing docks there.
    let answered = true;
    act(() => {
      answered = requestOverlayAgent("todo", 0);
    });
    expect(answered).toBe(false);
    expect(rootTabs()).toHaveLength(0);

    act(() => {
      answered = requestOverlayAgent("calendar", 0);
    });
    expect(answered).toBe(true);
    expect(rootTabs()).toHaveLength(1);
    expect(docks().calendar.key).toBe(rootTabs()[0].key);
    expect(docks().todo).toEqual({ key: null, open: false });
    expect(column()?.closest(".calendar-overlay")).not.toBeNull();
  });
});
