/**
 * Ctrl+Shift+S — `openProjectShellInRootConsole`: the root console with a
 * shell at the active project's root on this machine. A second press brings
 * the same shell back instead of spawning another; a remote project uses its
 * local mirror; with no local folder the console just opens.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { allGroups, useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { openProjectShellInRootConsole, useRootOverlayStore } from "../../stores/rootOverlay";
import type { ProjectEntry } from "../../types";
import { BRAND } from "../../lib/brand";

const rootTabs = () => useTabsStore.getState().tabsByScope.root ?? [];

function project(extra: Partial<ProjectEntry>): ProjectEntry {
  return {
    id: "p1",
    name: "Alpha",
    status: "active",
    position: 0,
    local_file: `/home/u/${BRAND.slug}/projects/alpha/project.json`,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({});
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { root: [] },
    layoutByScope: { root: null },
    focusedGroupByScope: { root: null },
  });
  useProjectsStore.setState({ activeId: "p1", projects: [project({})], switchToast: null });
  useRootOverlayStore.setState({ open: false });
});

describe("openProjectShellInRootConsole", () => {
  it("opens a root shell at the project root, in front, leaving the project active", () => {
    openProjectShellInRootConsole();

    expect(rootTabs()).toHaveLength(1);
    const shell = rootTabs()[0];
    expect(shell).toMatchObject({ kind: "shell", cmd: "", cwd: `/home/u/${BRAND.slug}/projects/alpha`, label: "Alpha" });
    expect(useRootOverlayStore.getState().open).toBe(true);
    const groups = allGroups(useTabsStore.getState().layoutByScope.root ?? null);
    expect(groups.some((g) => g.activeKey === shell.key)).toBe(true);
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("brings the existing shell back instead of spawning a second", () => {
    openProjectShellInRootConsole();
    const first = rootTabs()[0];
    const other = useTabsStore
      .getState()
      .addTabToScope("root", { label: "Other", cmd: "", cwd: "/r", kind: "shell" });
    useRootOverlayStore.setState({ open: false });

    openProjectShellInRootConsole();

    expect(rootTabs().map((tab) => tab.key)).toEqual([first.key, other.key]);
    expect(useRootOverlayStore.getState().open).toBe(true);
    const groups = allGroups(useTabsStore.getState().layoutByScope.root ?? null);
    expect(groups.some((g) => g.activeKey === first.key)).toBe(true);
  });

  it("uses a remote project's local mirror", () => {
    useProjectsStore.setState({
      projects: [
        project({
          directory: "/srv/alpha",
          remote: { host: "203.0.113.5", remote_path: "/srv/alpha" } as ProjectEntry["remote"],
          mirror: `/home/u/${BRAND.slug}/mirrors/alpha`,
        }),
      ],
    });

    openProjectShellInRootConsole();

    expect(rootTabs()[0]?.cwd).toBe(`/home/u/${BRAND.slug}/mirrors/alpha`);
  });

  it("just opens the console when there is no local folder", () => {
    useProjectsStore.setState({
      projects: [
        project({ remote: { host: "203.0.113.5", remote_path: "/srv/alpha" } as ProjectEntry["remote"] }),
      ],
    });

    openProjectShellInRootConsole();

    expect(rootTabs()).toHaveLength(0);
    expect(useRootOverlayStore.getState().open).toBe(true);
  });
});
