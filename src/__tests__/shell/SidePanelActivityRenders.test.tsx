/**
 * The side panel listens to agent activity only for the tabs it shows status
 * for — the ones parked in hidden subwindows.
 *
 * It used to subscribe to the whole `busyByTab` / `attentionByTab` maps, which
 * move on every agent's every turn edge in every project; each move re-rendered
 * the panel and, under it, the entire (unmemoized) file view. These tests pin
 * that an unrelated tab's activity costs the panel no render, while a hidden
 * tab's still lights its chip.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const { mockInvoke, fileViewRenders } = vi.hoisted(() => ({
  mockInvoke: vi.fn(() => Promise.resolve(null)),
  fileViewRenders: { count: 0 },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/projects", () => ({ useProjectsStore: vi.fn() }));
vi.mock("../../stores/settings", () => {
  const state = { settings: null, updateSettings: async () => {} };
  return {
    useSettingsStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});
// The file view is the expensive child whose re-renders this is about; a
// counting stub stands in for it, drawing only the hidden-subwindows slot the
// panel hands it.
vi.mock("../../components/files/ProjectFilesView", () => ({
  ProjectFilesView: ({ hidden }: { hidden?: unknown }) => {
    fileViewRenders.count += 1;
    return <>{hidden as never}</>;
  },
}));

import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useActivityStore } from "../../stores/activity";
import { SidePanel } from "../../components/layout/SidePanel";

const SCOPE = "proj-1";

function setProjects() {
  const state = {
    projects: [
      {
        id: SCOPE,
        name: "TestProject",
        status: "active",
        position: 0,
        local_file: "/tmp/test-project/project.json",
      },
    ],
    activeId: SCOPE,
    sidePanelFolderByProject: {},
    setSidePanelFolder: vi.fn(),
  } as unknown as ReturnType<typeof useProjectsStore>;
  vi.mocked(useProjectsStore).mockImplementation(((selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state) as typeof useProjectsStore);
}

function setTabs() {
  const tabs = [
    { key: "live", kind: "agent", label: "Live agent" },
    { key: "parked", kind: "agent", label: "Parked agent" },
  ] as unknown as TabEntry[];
  useTabsStore.setState({
    scope: SCOPE,
    tabsByScope: { [SCOPE]: tabs },
    hiddenGroupsByScope: {
      [SCOPE]: [
        {
          id: "g-hidden",
          label: "hidden",
          subtree: { type: "group", id: "g-hidden", tabKeys: ["parked"], activeKey: "parked" },
        },
      ],
    },
  } as never);
}

describe("side panel activity subscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileViewRenders.count = 0;
    setProjects();
    setTabs();
    useActivityStore.setState({ busyByTab: {}, busyKindByTab: {}, attentionByTab: {} });
  });

  it("does not re-render for a tab it shows nothing about", async () => {
    render(<SidePanel open={true} />);
    await act(async () => {});
    const before = fileViewRenders.count;
    expect(before).toBeGreaterThan(0);

    // A live (not hidden) tab — and one in another project — going busy and
    // finishing: the maps move, the panel has nothing to show for it.
    act(() => {
      useActivityStore.setState({
        busyByTab: { [`${SCOPE}:live`]: true, "other:tab": true },
        busyKindByTab: { [`${SCOPE}:live`]: "agent", "other:tab": "agent" },
      });
    });
    act(() => {
      useActivityStore.setState({
        busyByTab: {},
        busyKindByTab: {},
        attentionByTab: { [`${SCOPE}:live`]: "done" },
      });
    });
    expect(fileViewRenders.count).toBe(before);
  });

  it("still lights a hidden tab's chip when that tab works or waits", async () => {
    render(<SidePanel open={true} />);
    await act(async () => {});
    const chip = () => screen.getByText("Parked agent");
    expect(chip().className).not.toContain("working");

    act(() => {
      useActivityStore.setState({
        busyByTab: { [`${SCOPE}:parked`]: true },
        busyKindByTab: { [`${SCOPE}:parked`]: "shell" },
      });
    });
    expect(chip().className).toContain("working");
    expect(chip().className).toContain("shell");

    act(() => {
      useActivityStore.setState({
        busyByTab: {},
        busyKindByTab: {},
        attentionByTab: { [`${SCOPE}:parked`]: "decision" },
      });
    });
    expect(chip().className).toContain("needs-decision");
  });
});
