/**
 * The phone's git dots are the desktop pill's: the list reads what the pills
 * probed, the project screen re-probes at most every MOBILE_GIT_PROBE_MS.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { freshGitDot, gitDotRows, MOBILE_GIT_PROBE_MS, resetMobileGitProbes } from "../../lib/mobileGitDots";
import { useGitDirtyStore } from "../../stores/gitDirty";
import type { ProjectEntry } from "../../types";

const project = (id: string, extra: Partial<ProjectEntry> = {}): ProjectEntry => ({
  id,
  name: `Project ${id}`,
  status: "active",
  position: 0,
  local_file: `/tmp/${id}/project.json`,
  directory: `/tmp/${id}`,
  ...extra,
});

const probe = (staged: number, unstaged: number, unpushed: number) => ({
  status: { staged, unstaged, untracked: 0, has_remote: true, is_repo: true },
  unpushed,
});

beforeEach(() => {
  invoke.mockReset();
  resetMobileGitProbes();
  useGitDirtyStore.setState({ byId: {} });
});

describe("mobile git dots", () => {
  it("lists every pending level and leaves clean, unknown or unprobed projects out", () => {
    useGitDirtyStore.setState({ byId: { a: "dirty", b: "staged", c: "unpushed", d: "clean", e: "broken", g: "unknown" } });
    const rows = gitDotRows(["a", "b", "c", "d", "e", "f", "g"].map((id) => project(id)));
    expect(rows).toEqual([
      { project_id: "a", state: "dirty" },
      { project_id: "b", state: "staged" },
      { project_id: "c", state: "unpushed" },
      { project_id: "e", state: "broken" },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("re-probes the viewed project, but not on every poll", async () => {
    invoke.mockResolvedValueOnce(probe(1, 0, 0));
    expect(await freshGitDot(project("a"), 1_000_000)).toBe("staged");
    expect(invoke).toHaveBeenCalledWith("git_dirty_probe", { projectDir: "/tmp/a" });

    invoke.mockResolvedValueOnce(probe(0, 0, 2));
    // Within the window: the stored dot, no git.
    expect(await freshGitDot(project("a"), 1_000_000 + MOBILE_GIT_PROBE_MS - 1)).toBe("staged");
    expect(invoke).toHaveBeenCalledTimes(1);
    // Past it: probed again, and a clean tree after the push reads as no dot.
    expect(await freshGitDot(project("a"), 1_000_000 + MOBILE_GIT_PROBE_MS)).toBe("unpushed");
    invoke.mockResolvedValueOnce(probe(0, 0, 0));
    expect(await freshGitDot(project("a"), 1_000_000 + 2 * MOBILE_GIT_PROBE_MS)).toBeUndefined();
  });

  it("never runs git over a remote project's mount", async () => {
    useGitDirtyStore.setState({ byId: { r: "dirty" } });
    expect(await freshGitDot(project("r", { remote: { host: "example.invalid" } as ProjectEntry["remote"] }))).toBe("dirty");
    expect(invoke).not.toHaveBeenCalled();
  });
});
