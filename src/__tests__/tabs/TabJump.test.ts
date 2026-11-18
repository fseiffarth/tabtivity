/**
 * `lib/shortcuts/tabJump`: showing the tab a surface points at. Reveal first (so the
 * scope's own layout already has the tab up when the scope arrives), then bring
 * the scope up through the right store — a box via the boxes store, a project
 * or the root via the projects store — and cost nothing for a scope already up.
 * The two fallbacks: `setActive` for a popout that owns no layout, and a switch
 * that still happens for a tab the reveal cannot find. `openPromptChartTab`
 * adds the tab only once its scope is really the one the tab bar shows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { jumpToTab, openPromptChartTab } from "../../lib/shortcuts/tabJump";
import { translate, useI18nStore } from "../../lib/i18n";
import { useBoxesStore } from "../../stores/boxes";
import { installDetachedWindowContext } from "../../stores/detachedContext";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { PROMPTCHART_TAB_CMD, useTabsStore } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";
import { BRAND } from "../../lib/brand";

const revealTabInScope = vi.fn();
const tabSetActive = vi.fn();
const ensureTab = vi.fn();
const projectSetActive = vi.fn(async (id: string | null) => {
  // The real switch ends with the tabs store showing that scope.
  useProjectsStore.setState({ activeId: id });
  useTabsStore.setState({ scope: id ?? "root" });
});
const openBox = vi.fn(async (boxId: string) => {
  useTabsStore.setState({ scope: `box:${boxId}` });
});

const p1: ProjectEntry = {
  id: "p1",
  name: "One",
  status: "active",
  position: 0,
  local_file: `/home/u/${BRAND.slug}/projects/one/project.json`,
  directory: `/home/u/${BRAND.slug}/projects/one`,
};

beforeEach(() => {
  vi.clearAllMocks();
  useTabsStore.setState({ scope: "p1", revealTabInScope, setActive: tabSetActive, ensureTab });
  useProjectsStore.setState({ activeId: "p1", projects: [p1], setActive: projectSetActive });
  useBoxesStore.setState({ openBox });
  useI18nStore.setState({ lang: "en" });
});

describe("jumpToTab", () => {
  it("reveals in the scope's own layout and leaves a scope already up alone", () => {
    revealTabInScope.mockReturnValue(true);
    jumpToTab("p1", "tab-a");
    expect(revealTabInScope).toHaveBeenCalledWith("p1", "tab-a");
    expect(tabSetActive).not.toHaveBeenCalled();
    expect(projectSetActive).not.toHaveBeenCalled();
    expect(openBox).not.toHaveBeenCalled();
  });

  it("falls back to setActive when this store owns no layout for the scope it shows (popout)", () => {
    revealTabInScope.mockReturnValue(false);
    jumpToTab("p1", "tab-a");
    expect(tabSetActive).toHaveBeenCalledWith("tab-a");
  });

  it("still switches to the scope when the tab is not in its visible tree", () => {
    revealTabInScope.mockReturnValue(false);
    jumpToTab("p2", "tab-b");
    // Not the scope on show, so `setActive` here would hit the wrong layout.
    expect(tabSetActive).not.toHaveBeenCalled();
    expect(projectSetActive).toHaveBeenCalledWith("p2");
  });

  it("opens a root tab in the Root view and never switches the workspace to the root scope", async () => {
    // Root is a window over the workspace, not a place to switch to: the jump
    // used to end in `setActive(null)` and swap the project out from under the user.
    useTabsStore.setState({ tabsByScope: { root: [{ key: "root-shell", label: "sh", cmd: "", cwd: "/r", kind: "shell" }] } });
    useRootOverlayStore.setState({ open: false, view: "now" });
    jumpToTab("root", "root-shell");
    await Promise.resolve();
    expect(revealTabInScope).toHaveBeenCalledWith("root", "root-shell");
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "root" });
    expect(projectSetActive).not.toHaveBeenCalled();
    expect(tabSetActive).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().activeId).toBe("p1");
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("keeps the old path for a root tab inside a popout (no console there)", () => {
    const off = installDetachedWindowContext({ label: "w", scope: "root", groupId: "g" } as never);
    try {
      revealTabInScope.mockReturnValue(false);
      useTabsStore.setState({ scope: "root" });
      useRootOverlayStore.setState({ open: false, view: "root" });
      jumpToTab("root", "root-shell");
      expect(useRootOverlayStore.getState().open).toBe(false);
      expect(tabSetActive).toHaveBeenCalledWith("root-shell");
    } finally {
      off();
    }
  });


  it("brings a box up through the boxes store, never the project switcher", () => {
    revealTabInScope.mockReturnValue(true);
    jumpToTab("box:b1", "tab-c");
    expect(openBox).toHaveBeenCalledWith("b1");
    expect(projectSetActive).not.toHaveBeenCalled();
    openBox.mockClear();
    useTabsStore.setState({ scope: "box:b1" });
    jumpToTab("box:b1", "tab-c");
    expect(openBox).not.toHaveBeenCalled();
  });
});

describe("openPromptChartTab", () => {
  it("switches scope first, then adds the chart tab with the project's directory", async () => {
    useTabsStore.setState({ scope: "root" });
    useProjectsStore.setState({ activeId: null });
    await openPromptChartTab("p1");
    expect(projectSetActive).toHaveBeenCalledWith("p1");
    expect(ensureTab).toHaveBeenCalledTimes(1);
    const [tab, matches] = ensureTab.mock.calls[0] as [
      { label: string; cmd: string; cwd: string; kind: string },
      (t: { kind: string }) => boolean,
    ];
    expect(tab).toEqual({
      label: translate("en", "promptChart.heading"),
      cmd: PROMPTCHART_TAB_CMD,
      cwd: `/home/u/${BRAND.slug}/projects/one`,
      kind: "promptchart",
    });
    // One chart per scope: the matcher finds an existing chart tab by kind.
    expect(matches({ kind: "promptchart" })).toBe(true);
    expect(matches({ kind: "shell" })).toBe(false);
  });

  it("opens root's chart in the Root view and never switches the workspace to root", async () => {
    const added: Array<{ cwd: string; kind: string }> = [];
    const addTabToScope = vi.fn((_scope: string, spec: { cwd: string; kind: string }) => {
      added.push(spec);
      return { key: "pc-1", label: "", cmd: "", cwd: spec.cwd, kind: "promptchart" } as never;
    });
    useTabsStore.setState({ scope: "p1", addTabToScope, tabsByScope: { p1: [], root: [] } });
    useRootOverlayStore.setState({ open: false, view: "now" });
    await openPromptChartTab("root");
    expect(projectSetActive).not.toHaveBeenCalled();
    expect(useTabsStore.getState().scope).toBe("p1");
    expect(useProjectsStore.getState().activeId).toBe("p1");
    // Added to root's own layout (empty cwd for the backend to resolve) ...
    expect(addTabToScope).toHaveBeenCalledWith("root", expect.objectContaining({ cwd: "", kind: "promptchart" }));
    expect(ensureTab).not.toHaveBeenCalled();
    // ... and shown in the Root view of the window, in front.
    expect(revealTabInScope).toHaveBeenCalledWith("root", "pc-1");
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "root" });
  });

  it("focuses root's chart when it already has one instead of adding a second", async () => {
    const addTabToScope = vi.fn();
    useTabsStore.setState({
      scope: "p1",
      addTabToScope,
      tabsByScope: { p1: [], root: [{ key: "pc-7", label: "", cmd: PROMPTCHART_TAB_CMD, cwd: "", kind: "promptchart" }] },
    });
    await openPromptChartTab("root");
    expect(addTabToScope).not.toHaveBeenCalled();
    expect(revealTabInScope).toHaveBeenCalledWith("root", "pc-7");
    expect(projectSetActive).not.toHaveBeenCalled();
  });

  it("in a popout root's chart takes the old forwarded path", async () => {
    const off = installDetachedWindowContext({ label: "w", scope: "root", groupId: "g" } as never);
    try {
      useTabsStore.setState({ scope: "p1" });
      await openPromptChartTab("root");
      expect(projectSetActive).toHaveBeenCalledWith(null);
    } finally {
      off();
    }
  });

  it("adds nothing when the switch did not land this store on the scope (popout)", async () => {
    projectSetActive.mockImplementationOnce(async () => {
      // Forwarded to the main window; this store's scope stays as it was.
    });
    useTabsStore.setState({ scope: "p1" });
    await openPromptChartTab("p2");
    expect(projectSetActive).toHaveBeenCalledWith("p2");
    expect(ensureTab).not.toHaveBeenCalled();
  });
});
