/**
 * Root's Needs-you rail (`docs/cockpit_root_merge_plan.md`, M8): a 40 px icon rail of the live-store groups beside the
 * console; a click opens the real rail (with the groups that need a read),
 * scrolled to that group; the fold is remembered per machine; a mouse press
 * never moves the focus off a terminal; a picked row goes to its tab.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((cmd: string, _args?: unknown) => {
  if (cmd === "root_mcp_status") return Promise.resolve({ running: true, tools: [] });
  if (cmd === "list_agents") return Promise.resolve([]);
  return Promise.resolve([]);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => null }));
// Which view mounts is the question here, not what a cockpit view draws.
vi.mock("../../components/cockpit/CockpitViews", () => ({
  CockpitViewBody: () => <div data-testid="cockpit-body" />,
}));
vi.mock("../../components/cockpit/CockpitRoster", () => ({ jumpToRow: vi.fn() }));

import { RootOverlayHost } from "../../components/layout/RootOverlay";
import { jumpToRow } from "../../components/cockpit/CockpitRoster";
import { storageKey } from "../../lib/brand";
import { useActivityStore } from "../../stores/activity";
import { useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useRootReviewStore } from "../../stores/rootReview";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";

const agent = (key: string, label = key): TabEntry => ({ key, label, cmd: "claude", cwd: "/p", kind: "agent" });
const project = (id: string): ProjectEntry =>
  ({ id, name: id.toUpperCase(), status: "active", position: 1, local_file: `/${id}/project.json` }) as ProjectEntry;
const FOLD = storageKey("cockpitRootRail");

const icons = () => document.querySelector(".cockpit-rail-icons");
const groupIcons = () => Array.from(document.querySelectorAll<HTMLElement>(".cockpit-rail-icon[data-group]"));

async function openRoot() {
  render(<RootOverlayHost />);
  await act(async () => useRootOverlayStore.getState().show());
  await act(async () => {});
}

beforeEach(() => {
  cleanup();
  invokeMock.mockClear();
  localStorage.clear();
  useProjectsStore.setState({ projects: [project("p1")], activeId: "p1", rootDir: "/r" });
  useBoxesStore.setState({ boxes: [] });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { p1: [{ ...agent("a", "alpha"), scheduleTargetId: "t-a" }, agent("b", "beta")], root: [agent("r", "rooty")] },
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
  });
  useActivityStore.setState({
    busyByTab: {},
    attentionByTab: { "p1:a": "decision", "root:r": "interrupted" },
    lastDoneByTab: {},
    lastWorkingByTab: {},
  });
  useRootReviewStore.setState({ proposals: [], imports: [], refresh: vi.fn(() => Promise.resolve()) });
  useRootOverlayStore.setState({ open: false, view: "root", installTabs: {} });
});
afterEach(() => cleanup());

describe("the icon rail", () => {
  it("is collapsed by default: one icon per non-empty live-store group, with its count", async () => {
    await openRoot();
    expect(icons()).toBeTruthy();
    expect(groupIcons().map((el) => el.dataset.group)).toEqual(["asking", "interrupted"]);
    expect(groupIcons().map((el) => el.getAttribute("aria-label"))).toEqual(["Asking: 1", "Interrupted: 1"]);
    expect(document.querySelector(".cockpit-rail")).toBeNull();
  });

  it("is amber for asking and red for interrupted, by class", async () => {
    await openRoot();
    expect(groupIcons()[0].classList.contains("group-asking")).toBe(true);
    expect(groupIcons()[1].classList.contains("group-interrupted")).toBe(true);
  });

  it("follows the stores live", async () => {
    await openRoot();
    act(() => useActivityStore.setState({ attentionByTab: {} }));
    expect(groupIcons()).toHaveLength(0);
    act(() => useActivityStore.setState({ attentionByTab: { "p1:b": "decision" } }));
    expect(groupIcons().map((el) => el.dataset.group)).toEqual(["asking"]);
  });

  it("is not there on a cockpit view", async () => {
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("usage"));
    expect(await screen.findByTestId("cockpit-body")).toBeTruthy();
    expect(icons()).toBeNull();
  });

  it("reads nothing from the backend while collapsed", async () => {
    await openRoot();
    const reads = invokeMock.mock.calls.map(([cmd]) => cmd);
    for (const cmd of ["git_push_mcp_proposals", "agent_schedules_list", "markup_mcp_list"]) {
      expect(reads).not.toContain(cmd);
    }
  });

  it("a mouse press does not take the focus from where it was", async () => {
    await openRoot();
    const press = fireEvent.mouseDown(groupIcons()[0]);
    // fireEvent returns false when the event was default-prevented.
    expect(press).toBe(false);
  });
});

describe("opening the rail", () => {
  it("a group icon opens the real rail scrolled to that group, and remembers the fold", async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push((this as HTMLElement).dataset.group ?? "");
    };
    try {
      await openRoot();
      await act(async () => fireEvent.click(groupIcons()[1]));
      expect(icons()).toBeNull();
      expect(document.querySelector(".cockpit-rail")).toBeTruthy();
      expect(scrolled).toContain("interrupted");
      expect(localStorage.getItem(FOLD)).toBe("open");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("the open rail reads the groups that need a read (push, schedules, markup)", async () => {
    await openRoot();
    await act(async () => fireEvent.click(screen.getByLabelText("Open the Needs-you rail")));
    const reads = invokeMock.mock.calls.map(([cmd]) => cmd);
    for (const cmd of ["git_push_mcp_proposals", "agent_schedules_list", "markup_mcp_list"]) {
      expect(reads).toContain(cmd);
    }
  });

  it("starts open when it was left open, and folds again with its button", async () => {
    localStorage.setItem(FOLD, "open");
    await openRoot();
    expect(document.querySelector(".cockpit-rail")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByLabelText("Fold the Needs-you rail")));
    expect(icons()).toBeTruthy();
    expect(localStorage.getItem(FOLD)).toBe("closed");
  });

  it("every picked row goes through jumpToRow (it knows a root row stays in this view)", async () => {
    localStorage.setItem(FOLD, "open");
    await openRoot();
    const pick = (label: string) =>
      fireEvent.click(screen.getAllByText(label).find((el) => el.closest(".cockpit-rail-pick"))!);
    await act(async () => pick("rooty"));
    expect(jumpToRow).toHaveBeenCalledWith("root:r");
    await act(async () => pick("alpha"));
    expect(jumpToRow).toHaveBeenCalledWith("p1:a");
  });
});
