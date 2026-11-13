/**
 * `jumpToRow` (the cockpit's Enter / double-click / Jump) for a root row: the
 * Root view of the very window opens on that tab, the workspace scope stays
 * what it was, and the window is not closed. Any other row still shows its tab
 * in its own pane and closes the window. Root is no place to switch to
 * (`docs/cockpit_root_merge_plan.md`, M4).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve("")) }));

import { jumpToRow } from "../../components/cockpit/CockpitRoster";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { shownStatusTab } from "../../lib/shortcuts/statusJump";
import type { ProjectEntry } from "../../types";

const agent = (key: string): TabEntry => ({ key, label: key, cmd: "claude", cwd: "/p", kind: "agent" });
const project = (id: string): ProjectEntry =>
  ({ id, name: id, status: "active", position: 1, local_file: `/${id}/project.json` }) as ProjectEntry;
const setActive = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  useProjectsStore.setState({ projects: [project("p1")], activeId: "p1", setActive });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { p1: [agent("a")], root: [agent("r")] },
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
  });
  useRootOverlayStore.setState({ open: true, view: "now", installTabs: {} });
});

describe("jumpToRow", () => {
  it("a root row opens the Root view on it: no scope switch, the window stays open", () => {
    jumpToRow("root:r");
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "root" });
    expect(setActive).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().activeId).toBe("p1");
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("a project row shows its tab in its own pane and closes the window", () => {
    jumpToRow("p1:a");
    expect(useRootOverlayStore.getState().open).toBe(false);
    expect(setActive).not.toHaveBeenCalled();
  });

  it("another project's row switches to it and closes", () => {
    jumpToRow("p2:x");
    expect(setActive).toHaveBeenCalledWith("p2");
    expect(useRootOverlayStore.getState().open).toBe(false);
  });
});

describe("shownStatusTab (the steering status keys walk on from the tab showing)", () => {
  it("is the workspace's active tab while the Root view is not up", () => {
    useTabsStore.setState({ activeKey: "a" });
    useRootOverlayStore.setState({ open: true, view: "now" });
    expect(shownStatusTab()).toEqual({ scope: "p1", key: "a" });
  });

  it("is the root layout's focused tab while the Root view is up", () => {
    useTabsStore.setState({
      activeKey: "a",
      layoutByScope: { root: { type: "group", id: "g1", tabKeys: ["r"], activeKey: "r" } as never },
      focusedGroupByScope: { root: "g1" },
    });
    useRootOverlayStore.setState({ open: true, view: "root" });
    expect(shownStatusTab()).toEqual({ scope: "root", key: "r" });
  });
});
