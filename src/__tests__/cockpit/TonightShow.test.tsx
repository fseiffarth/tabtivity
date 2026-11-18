/**
 * F7 (`docs/cockpit_followup_handoff.md`): Tonight's "Show" on an item. Wide, it
 * switches to Now with the agent selected (the detail sits beside the roster);
 * in a narrow window Now shows one column, so it must land on that agent's
 * DETAIL, with the roster one back press away.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((cmd: string, _args?: unknown) => {
  if (cmd === "root_mcp_status") return Promise.resolve({ running: true, tools: [] });
  return Promise.resolve([]);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: { tab: { key: string } }) => <div data-testid={`attached-${props.tab.key}`} />,
}));
// The lazy view body: the two views this test walks between, already imported.
vi.mock("../../components/cockpit/CockpitViews", async () => {
  const { CockpitNow } = await import("../../components/cockpit/CockpitNow");
  const { CockpitTonight } = await import("../../components/cockpit/CockpitTonight");
  return { CockpitViewBody: ({ view }: { view: string }) => (view === "tonight" ? <CockpitTonight /> : <CockpitNow />) };
});
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab: vi.fn(), openPromptChartTab: vi.fn() }));

import { RootOverlayHost } from "../../components/layout/RootOverlay";
import { useActivityStore } from "../../stores/activity";
import { useBoxesStore } from "../../stores/boxes";
import { useCockpitStore } from "../../stores/cockpit";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useRootReviewStore } from "../../stores/rootReview";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import type { ProjectEntry } from "../../types";

const agent = (key: string, label = key, extra: Partial<TabEntry> = {}): TabEntry => ({ key, label, cmd: "claude", cwd: "/p", kind: "agent", ...extra });
const project = (id: string): ProjectEntry =>
  ({ id, name: id.toUpperCase(), status: "active", position: 1, local_file: `/${id}/project.json` }) as ProjectEntry;

let width = 1400;
beforeEach(() => {
  cleanup();
  localStorage.clear();
  width = 1400;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useProjectsStore.setState({ projects: [project("p1"), project("p2")], activeId: "p1", rootDir: "/r" });
  useBoxesStore.setState({ boxes: [] });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { p1: [agent("a", "alpha")], p2: [agent("b", "beta", { autoContinue: true }), agent("c", "gamma")], root: [] },
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
  });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, lastDoneByTab: {}, lastWorkingByTab: {} });
  useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
  useRootReviewStore.setState({ proposals: [], imports: [], refresh: vi.fn(() => Promise.resolve()) });
  useOverlayAgentStore.setState({ scopeShownKeys: new Set() });
  useRootOverlayStore.setState({ open: false, view: "root", installTabs: {} });
  useCockpitStore.setState({ selected: null, detailAsked: false, stateFilter: "all", query: "", rosterMode: "flat", boxFilter: null, scopeFilter: null });
});
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  vi.unstubAllGlobals();
});

async function showFromTonight(w: number) {
  width = w;
  render(<RootOverlayHost />);
  await act(async () => useRootOverlayStore.getState().openView("tonight"));
  await act(async () => {});
  const show = await screen.findByRole("button", { name: "Show" });
  await act(async () => void fireEvent.click(show));
  await act(async () => {});
}

describe("Tonight's Show", () => {
  it("narrow: lands on the agent's detail, the row selected, and back returns to the list", async () => {
    await showFromTonight(700);
    expect(useRootOverlayStore.getState().view).toBe("now");
    expect(useCockpitStore.getState().selected).toBe("p2:b");
    expect(screen.getByTestId("attached-b")).toBeTruthy();
    expect(document.querySelector(".cockpit-roster")).toBeNull();
    // The request is spent: it does not reopen the detail later.
    expect(useCockpitStore.getState().detailAsked).toBe(false);

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Agents" })));
    expect(document.querySelectorAll(".cockpit-roster-row")).toHaveLength(3);
    expect(document.querySelector('[data-pty="p2:b"]')?.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("attached-b")).toBeNull();
  });

  it("wide: Now with the agent selected beside the roster, nothing left over", async () => {
    await showFromTonight(1400);
    expect(useRootOverlayStore.getState().view).toBe("now");
    expect(useCockpitStore.getState().selected).toBe("p2:b");
    expect(useCockpitStore.getState().detailAsked).toBe(false);
    expect(document.querySelectorAll(".cockpit-roster-row")).toHaveLength(3);
    expect(screen.getByTestId("attached-b")).toBeTruthy();
  });

  it("a later narrow Now opened the ordinary way starts on the roster", async () => {
    await showFromTonight(700);
    await act(async () => useRootOverlayStore.getState().openView("tonight"));
    await act(async () => useRootOverlayStore.getState().openView("now"));
    await act(async () => {});
    expect(document.querySelectorAll(".cockpit-roster-row")).toHaveLength(3);
    expect(document.querySelector(".cockpit-now-detail")).toBeNull();
  });
});
