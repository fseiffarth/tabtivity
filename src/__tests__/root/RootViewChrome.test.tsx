/**
 * The Root view's chrome (`docs/cockpit_root_merge_plan.md`, M3): the root tab strip, + menu, ⚿ badge
 * and ◫ toggle sit in a sub-bar under the title bar (a split layout drops it),
 * the Root tab carries a lamp (amber count while a root agent asks, the working
 * ring while one works), and the empty card starts the default agent in Root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    switch (cmd) {
      case "root_mcp_status":
        return Promise.resolve({ running: true, tools: ["calendar_add_event"] });
      case "list_agents":
        return Promise.resolve([{ id: "claude", bin: "claude", installed: true }]);
      case "root_mcp_review_list":
        return Promise.resolve([]);
      default:
        return Promise.resolve(undefined);
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => null }));
vi.mock("../../components/cockpit/CockpitViews", () => ({
  CockpitViewBody: () => <div data-testid="cockpit-body" />,
}));

import { RootOverlayHost } from "../../components/layout/RootOverlay";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useRootReviewStore } from "../../stores/rootReview";
import { useSettingsStore } from "../../stores/settings";
import { useActivityStore } from "../../stores/activity";
import { isUntested } from "../../lib/untested";
import { scopeLamp } from "../../lib/cockpit/scopeLamp";
import type { Settings } from "../../types";

function setRootAgents(rootAgents: string[]) {
  useSettingsStore.setState({ settings: { root_agents: rootAgents } as Settings });
}

function seed() {
  const tabs = useTabsStore.getState();
  const a = tabs.addTabToScope("root", { label: "Claude", cmd: "claude", cwd: "/r", kind: "agent" });
  const b = tabs.addTabToScope("root", { label: "Shell", cmd: "", cwd: "/r", kind: "shell" });
  return { a, b };
}

const subBar = () => document.querySelector(".root-overlay-subbar");
const titleBar = () => document.querySelector(".root-overlay-bar:not(.root-overlay-subbar)") as HTMLElement;
const rootTab = () => document.querySelector(".root-view-tab-root") as HTMLElement;

async function openRoot() {
  render(<RootOverlayHost />);
  await act(async () => useRootOverlayStore.getState().show());
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  setRootAgents(["claude"]);
  useTabsStore.setState({ scope: "p1", tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
  useProjectsStore.setState({ rootDir: "/r", activeId: "p1" });
  useRootOverlayStore.setState({ open: false, view: "root", installTabs: {} });
  useRootReviewStore.setState({ proposals: [], imports: [], count: 0, busy: false, error: null, refresh: vi.fn(() => Promise.resolve()) });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, busyKindByTab: {} });
});
afterEach(() => cleanup());

describe("scopeLamp", () => {
  const agent = (key: string) => ({ key, label: key, cmd: "claude", cwd: "/r", kind: "agent" as const });
  const shell = { key: "s", label: "s", cmd: "", cwd: "/r", kind: "shell" as const };
  const viewer = { key: "v", label: "v", cmd: "", cwd: "/r", kind: "monitor" as const };

  it("counts asking agents that are not working, and working PTY tabs", () => {
    expect(
      scopeLamp(
        "root",
        [agent("a"), agent("b"), agent("c"), shell, viewer],
        { "root:b": true, "root:s": true, "root:v": true },
        { "root:a": "decision", "root:b": "decision", "root:c": "done", "root:v": "decision" },
      ),
    ).toEqual({ asking: 1, working: 2, agentWorking: true });
  });

  it("a command alone is not an agent working", () => {
    expect(scopeLamp("root", [shell], { "root:s": true }, {})).toEqual({ asking: 0, working: 1, agentWorking: false });
  });
});

describe("the Root view", () => {
  it("holds the tab strip, + and ⚿ badge in a sub-bar under the title bar", async () => {
    seed();
    await openRoot();
    const sub = subBar() as HTMLElement;
    expect(sub).toBeTruthy();
    expect(sub.querySelector(".tab-new-btn")).toBeTruthy();
    expect(Array.from(sub.querySelectorAll(".tab-label")).map((n) => n.textContent)).toEqual(["Claude", "Shell"]);
    expect(sub.querySelector(".root-overlay-rights")).toBeTruthy();
    // ... and the title bar keeps the view strip, with none of them.
    expect(titleBar().querySelector(".root-view-strip")).toBeTruthy();
    expect(titleBar().querySelector(".tab-new-btn")).toBeNull();
    expect(titleBar().querySelector(".root-overlay-controls .root-overlay-approvals")).toBeTruthy();
    expect(titleBar().textContent).not.toContain("Claude");
  });

  it("gives the docked file toggle to the sub-bar", async () => {
    seed();
    await openRoot();
    expect((subBar() as HTMLElement).querySelector(".subwindow-files-toggle")).toBeTruthy();
    expect(titleBar().querySelector(".subwindow-files-toggle")).toBeNull();
  });

  it("drops the sub-bar when the layout is split: each subwindow carries its own strip, the badge stays in the title bar", async () => {
    const { a, b } = seed();
    useTabsStore.getState().splitWithTabInScope("root", b.key, allGroups(useTabsStore.getState().layoutByScope.root)[0].id, "right");
    expect(allGroups(useTabsStore.getState().layoutByScope.root).length).toBe(2);
    await openRoot();
    expect(subBar()).toBeNull();
    expect(titleBar().querySelector(".root-overlay-rights:not(.root-overlay-approvals)")).toBeTruthy();
    expect(document.querySelectorAll(".root-overlay-region .tab-new-btn").length).toBe(2);
    expect(a.key).toBeTruthy();
  });

  it("no sub-bar on a cockpit view", async () => {
    seed();
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("usage"));
    expect(await screen.findByTestId("cockpit-body")).toBeTruthy();
    expect(subBar()).toBeNull();
  });
});

describe("the Root tab's lamp", () => {
  it("is quiet with nothing asking or working", async () => {
    seed();
    await openRoot();
    expect(rootTab().className).not.toMatch(/needs-decision|working/);
    expect(rootTab().querySelector(".root-view-count")).toBeNull();
  });

  it("shows an amber count while a root agent asks", async () => {
    const { a } = seed();
    useActivityStore.setState({ attentionByTab: { [`root:${a.key}`]: "decision" } });
    await openRoot();
    expect(rootTab().classList.contains("needs-decision")).toBe(true);
    expect(rootTab().querySelector(".root-view-count")?.textContent).toBe("1");
    expect(rootTab().querySelector(".root-view-count")?.getAttribute("aria-label")).toBe("Asking in Root: 1");
  });

  it("shows the working ring while one works, and follows the store live", async () => {
    const { a } = seed();
    await openRoot();
    act(() => useActivityStore.setState({ busyByTab: { [`root:${a.key}`]: true }, busyKindByTab: { [`root:${a.key}`]: "agent" } }));
    expect(rootTab().classList.contains("working")).toBe(true);
    expect(rootTab().querySelector(".root-view-count")).toBeNull();
    act(() => useActivityStore.setState({ busyByTab: {} }));
    expect(rootTab().classList.contains("working")).toBe(false);
  });

  it("a question outranks work", async () => {
    const { a, b } = seed();
    useActivityStore.setState({
      busyByTab: { [`root:${b.key}`]: true },
      attentionByTab: { [`root:${a.key}`]: "decision" },
    });
    await openRoot();
    expect(rootTab().classList.contains("needs-decision")).toBe(true);
    expect(rootTab().classList.contains("working")).toBe(false);
  });
});

describe("Start <agent> in Root", () => {
  it("opens the default root-allowed agent in the root scope in one click", async () => {
    await openRoot();
    const button = await screen.findByRole("button", { name: /Start .* in Root/ });
    await act(async () => fireEvent.click(button));
    const tabs = useTabsStore.getState().tabsByScope.root ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: "agent", cmd: "claude" });
    // The empty card is gone with it.
    expect(screen.queryByRole("button", { name: /Start .* in Root/ })).toBeNull();
  });

  it("names the switch when the default agent is not allowed in Root", async () => {
    setRootAgents([]);
    await openRoot();
    expect(await screen.findByText(/Allow .* in the root console/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Start .* in Root/ })).toBeNull();
  });
});

describe("the title bar pills", () => {
  it("the ✓ is tagged as the new surface it is", async () => {
    await openRoot();
    const controls = titleBar().querySelector(".root-overlay-controls") as HTMLElement;
    const approvals = controls.querySelector(".root-overlay-approvals") as HTMLElement;
    if (isUntested("overlayApprovals.button")) {
      expect(approvals.nextElementSibling?.classList.contains("untested-tag")).toBe(true);
    }
  });
});
