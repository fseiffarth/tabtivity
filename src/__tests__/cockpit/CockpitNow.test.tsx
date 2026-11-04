/**
 * The cockpit's Now view (C3): the rail lists Asking first and says so when
 * nothing waits, the roster lists every hydrated scope's agent tabs, the
 * keyboard moves the selection and jumps, and nothing selected shows the top
 * Asking row in the detail pane.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: { tab: { key: string } }) => <div data-testid={`attached-${props.tab.key}`} />,
}));
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab: vi.fn(), openPromptChartTab: vi.fn() }));

import { CockpitNow } from "../../components/cockpit/CockpitNow";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import { useCockpitStore } from "../../stores/cockpit";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useActivityStore } from "../../stores/activity";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { useRootReviewStore } from "../../stores/rootReview";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { ASSISTANT_SCOPE } from "../../lib/assistant";
import type { ProjectEntry } from "../../types";

const agent = (key: string, label = key): TabEntry => ({ key, label, cmd: "claude", cwd: "/p", kind: "agent" });
const project = (id: string, status = "active"): ProjectEntry => ({ id, name: id.toUpperCase(), status, position: 1, local_file: `/${id}/project.json` }) as ProjectEntry;

beforeEach(() => {
  localStorage.clear();
  useProjectsStore.setState({ projects: [project("p1"), project("p2"), project("p3", "inactive")], activeId: "p1" });
  useBoxesStore.setState({ boxes: [] });
  useTabsStore.setState({
    tabsByScope: {
      p1: [agent("a", "alpha"), { ...agent("s"), kind: "shell" }],
      p2: [agent("b", "beta"), agent("c", "gamma")],
      [ASSISTANT_SCOPE]: [agent("t", "tabby")],
    },
    detachedGroupsByScope: {},
  });
  useActivityStore.setState({ busyByTab: { "p2:c": true }, attentionByTab: {}, lastDoneByTab: {}, lastWorkingByTab: {} });
  useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
  useRootReviewStore.setState({ proposals: [], imports: [] });
  useOverlayAgentStore.setState({ scopeShownKeys: new Set() });
  useRootOverlayStore.setState({ open: true, view: "now" });
  useCockpitStore.setState({ selected: null, stateFilter: "all", query: "", rosterMode: "flat", boxFilter: null, scopeFilter: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const rosterLabels = () =>
  Array.from(document.querySelectorAll(".cockpit-roster-row .cockpit-roster-tab")).map((el) => el.textContent);

describe("CockpitNow", () => {
  it("lists every hydrated scope's agent tabs, never a shell or the assistant's", async () => {
    render(<CockpitNow />);
    await act(async () => {});
    expect(rosterLabels().sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("says nothing is waiting when the rail is empty", async () => {
    render(<CockpitNow />);
    await act(async () => {});
    expect(screen.getByText("Nothing is waiting for you.")).toBeTruthy();
  });

  it("puts an asking tab in the rail and shows it in the detail pane with nothing selected", async () => {
    useActivityStore.setState({ attentionByTab: { "p2:b": "decision" } });
    render(<CockpitNow />);
    await act(async () => {});
    const group = document.querySelector('.cockpit-rail-group[data-group="asking"]');
    expect(group?.textContent).toContain("beta");
    expect(screen.getByTestId("attached-b")).toBeTruthy();
    expect(useOverlayAgentStore.getState().scopeShownKeys.has("p2:b")).toBe(true);
  });

  it("moves the selection with the keys and jumps with Enter", async () => {
    render(<CockpitNow />);
    await act(async () => {});
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "j" });
    const first = useCockpitStore.getState().selected;
    expect(first).not.toBeNull();
    fireEvent.keyDown(list, { key: "j" });
    expect(useCockpitStore.getState().selected).not.toBe(first);
    fireEvent.keyDown(list, { key: "k" });
    expect(useCockpitStore.getState().selected).toBe(first);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(jumpToTab).toHaveBeenCalledTimes(1);
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("Enter on a root row jumps to it and leaves the window up (it is the Root view that opens)", async () => {
    useTabsStore.setState({ tabsByScope: { ...useTabsStore.getState().tabsByScope, root: [agent("r", "rooty")] } });
    render(<CockpitNow />);
    await act(async () => {});
    useCockpitStore.getState().select("root:r");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(jumpToTab).toHaveBeenCalledWith("root", "r");
    expect(useRootOverlayStore.getState().open).toBe(true);
  });

  it("a root agent is an ordinary row with the star Root chip; Space draws it, its button says Open in Root", async () => {
    useTabsStore.setState({ tabsByScope: { ...useTabsStore.getState().tabsByScope, root: [agent("r", "rooty")] } });
    render(<CockpitNow />);
    await act(async () => {});
    const row = document.querySelector('[data-pty="root:r"]')!;
    const chip = row.querySelector(".cockpit-chip.root")!;
    expect(chip.textContent).toContain("Root");
    expect(chip.querySelector("svg")).toBeTruthy();
    // A project row has the plain chip.
    expect(document.querySelector('[data-pty="p2:b"] .cockpit-chip.root')).toBeNull();
    useCockpitStore.getState().select("root:r");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: " " });
    await act(async () => {});
    expect(screen.getByTestId("attached-r")).toBeTruthy();
    expect(useOverlayAgentStore.getState().shownKeys.has("r")).toBe(true);
    expect(screen.getByText("Open in Root")).toBeTruthy();
    expect(screen.queryByText("Jump to tab")).toBeNull();
  });

  it("filters by text", async () => {
    render(<CockpitNow />);
    await act(async () => {});
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "gam" } });
    expect(rosterLabels()).toEqual(["gamma"]);
  });
});
