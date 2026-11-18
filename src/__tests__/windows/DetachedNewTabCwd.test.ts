/**
 * The folder a popout's "+" menu opens a tab in (`detachedNewTabCwd`) is the
 * one the main window's `newTabCwd` resolves — box folder, else project
 * directory — never the active tab's cwd. A viewer tab's cwd is its FILE's
 * folder, so a Claude tab opened beside `talk/main.pdf` used to start in
 * `talk/` from a popout and in the project root from the main window.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { detachedNewTabCwd, detachedNewTabTarget } from "../../stores/detached";
import type { ProjectBox, ProjectEntry } from "../../types";

const project = {
  id: "p1",
  name: "Paper",
  local_file: "/work/Paper/project.json",
  directory: "/work/Paper",
} as ProjectEntry;

describe("detachedNewTabCwd", () => {
  it("uses the project directory, not the active viewer tab's folder", () => {
    expect(detachedNewTabCwd("p1", { project }, ["/work/Paper/talk", "/work/Paper"])).toBe(
      "/work/Paper",
    );
  });

  it("derives the directory from project.json when the entry has none", () => {
    const legacy = { ...project, directory: undefined } as unknown as ProjectEntry;
    expect(detachedNewTabCwd("p1", { project: legacy }, ["/work/Paper/talk"])).toBe("/work/Paper");
  });

  it("uses the box folder for a box scope", () => {
    const box = { id: "b1", name: "Box", folder: "/work/Box", member_ids: [] } as unknown as ProjectBox;
    expect(detachedNewTabCwd("box:b1", { box, boxMembers: [] }, ["/work/Box/sub"])).toBe("/work/Box");
  });

  it("falls back to the first tab cwd only without project context", () => {
    expect(detachedNewTabCwd("root", undefined, [undefined, "/somewhere"])).toBe("/somewhere");
    expect(detachedNewTabCwd("root", undefined, [])).toBe("");
  });
});

// Decision 3: a box popout's "+" starts in the active tab's member (the seed's
// `boxMembers`; the popout's stores are inert), else the box folder.
describe("detachedNewTabCwd in a box popout", () => {
  const member = (id: string): ProjectEntry =>
    ({ id, name: id, local_file: `/w/${id}/project.json`, directory: `/w/${id}` }) as ProjectEntry;
  const box = { id: "b1", name: "Box", folder: "/work/Box", member_ids: ["api", "paper"] } as unknown as ProjectBox;
  const info = { box, boxMembers: [member("api"), member("paper")] };

  it("follows the member root of the active tab, never the tab's own folder", () => {
    expect(detachedNewTabCwd("box:b1", info, ["/w/api", "/w/paper"])).toBe("/w/api");
    // A viewer deep inside a member: its root, not the file's folder.
    expect(detachedNewTabCwd("box:b1", info, ["/w/paper/chapters/one"])).toBe("/w/paper");
    expect(detachedNewTabTarget("box:b1", info, ["/w/paper/chapters/one"])?.member?.id).toBe("paper");
  });

  it("uses the box folder after a tab in the box folder, in an unknown folder and in an empty group", () => {
    expect(detachedNewTabCwd("box:b1", info, ["/work/Box/notes"])).toBe("/work/Box");
    expect(detachedNewTabCwd("box:b1", info, ["/elsewhere"])).toBe("/work/Box");
    expect(detachedNewTabCwd("box:b1", info, [])).toBe("/work/Box");
    expect(detachedNewTabTarget("box:b1", info, [undefined])).toMatchObject({ cwd: "/work/Box", member: null });
  });

  it("has no target outside a box popout", () => {
    expect(detachedNewTabTarget("p1", { project: member("p1") }, ["/w/p1"])).toBeNull();
    expect(detachedNewTabTarget("root", undefined, [])).toBeNull();
  });
});
