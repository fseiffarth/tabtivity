/**
 * The side panel in the ROOT scope: the scope that belongs to no project gets
 * the same file viewer, rooted at `~/tabtivity/root` (`rootDir`) — the staging area
 * for data that is only being looked at, or has no project to belong to yet.
 *
 * The two things worth pinning down are the ones a plain "no active project"
 * check would get wrong: the tree must be rooted at `rootDir` (not at the empty
 * string a box scope passes), and a BOX scope — which also has no active project
 * — must keep its own multi-root view instead of being re-rooted at the root dir.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { ProjectBox } from "../../types";

type InvokeArgs = Record<string, unknown> | undefined;
const invoke = vi.fn((cmd: string, _args?: InvokeArgs) =>
  Promise.resolve(cmd === "git_repo_root" ? null : []),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: InvokeArgs) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { SidePanel } from "../../components/layout/SidePanel";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useTabsStore, ROOT_SCOPE } from "../../stores/tabs";
import { BRAND } from "../../lib/brand";

const ROOT_DIR = `/home/u/${BRAND.slug}/root`;

/** Every `list_dir` the render dispatched, as (projectDir, relPath) pairs. */
function listedDirs(): Array<{ projectDir: string; relPath: string }> {
  return invoke.mock.calls
    .filter(([cmd]) => cmd === "list_dir")
    .map(([, args]) => (args ?? {}) as { projectDir: string; relPath: string });
}

beforeEach(() => {
  invoke.mockClear();
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true, rootDir: ROOT_DIR });
  useBoxesStore.setState({ boxes: [], loaded: true });
  useTabsStore.setState({ scope: ROOT_SCOPE });
});

describe("SidePanel at the root scope", () => {
  it("roots the tree at rootDir and names the scope", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    expect(listedDirs().map((a) => a.projectDir)).toContain(ROOT_DIR);
    expect(container.textContent).toContain("Root");
    // No project behind it, so no project-settings door.
    expect(container.querySelector('[title="Project settings"]')).toBeNull();
  });

  it("leaves a box scope on its multi-root view", async () => {
    const boxA: ProjectBox = { id: "boxA", name: "boxA", member_ids: [], position: 10, folder: "/b/boxA" };
    useBoxesStore.setState({ boxes: [boxA] });
    useTabsStore.setState({ scope: "box:boxA" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    expect(listedDirs().map((a) => a.projectDir)).not.toContain(ROOT_DIR);
    expect(container.querySelector(".file-root")).not.toBeNull();
  });
});
