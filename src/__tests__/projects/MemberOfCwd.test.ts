/**
 * Box redesign groundwork (AS1): which member a directory belongs to
 * (`memberOfCwd`), where a new tab of a box scope starts (`newTabTarget`),
 * the scope's display name and the member dot colour.
 */
import { describe, it, expect, vi } from "vitest";
import type { ProjectBox, ProjectEntry } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { memberOfCwd, memberOfCwdInScope, newTabTarget, scopeDisplayName, type BoxMemberDir } from "../../stores/boxes";
import { autoBoxColor, memberColor } from "../../lib/theme/boxColor";

const m = (id: string, dir: string): BoxMemberDir => ({ id, name: id.toUpperCase(), dir });

describe("memberOfCwd", () => {
  const members = [m("a", "/w/a"), m("ab", "/w/ab"), m("deep", "/w/a/sub/deep")];

  it("matches the member whose root contains the directory, on a path-component boundary", () => {
    expect(memberOfCwd("/w/a", members)?.id).toBe("a");
    expect(memberOfCwd("/w/a/src/x", members)?.id).toBe("a");
    expect(memberOfCwd("/w/ab/src", members)?.id).toBe("ab");
    expect(memberOfCwd("/w/abc", members)).toBeNull();
    expect(memberOfCwd("/w", members)).toBeNull();
  });

  it("the deepest member root wins when roots nest", () => {
    expect(memberOfCwd("/w/a/sub/deep/x", members)?.id).toBe("deep");
    expect(memberOfCwd("/w/a/sub", members)?.id).toBe("a");
  });

  it("the box folder and anything under it is the whole box", () => {
    expect(memberOfCwd("/boxes/t", members, "/boxes/t")).toBeNull();
    expect(memberOfCwd("/boxes/t/a-link/src", members, "/boxes/t")).toBeNull();
    expect(memberOfCwd("/w/a/src", members, "/boxes/t")?.id).toBe("a");
  });

  it("a member root that is an ancestor of the box folder does not claim the box folder", () => {
    const outer = [m("outer", "/w")];
    expect(memberOfCwd("/w/boxes/t", outer, "/w/boxes/t")).toBeNull();
    expect(memberOfCwd("/w/other", outer, "/w/boxes/t")?.id).toBe("outer");
    // ...but a member root deeper than the box folder still wins inside it.
    expect(memberOfCwd("/w/boxes/t/inner/x", [m("inner", "/w/boxes/t/inner")], "/w/boxes/t")?.id).toBe("inner");
  });

  it("is empty for an empty cwd and compares Windows paths by case and separator", () => {
    expect(memberOfCwd("", members)).toBeNull();
    const win = [m("w", "C:\\Work\\Paper")];
    expect(memberOfCwd("c:/work/paper/src", win)?.id).toBe("w");
    expect(memberOfCwd("C:\\Work\\PaperX", win)).toBeNull();
    expect(memberOfCwd("c:\\work\\paper", win, "C:\\Boxes\\t")?.id).toBe("w");
  });
});

describe("box scope helpers", () => {
  const proj = (id: string, dir: string, extra: Partial<ProjectEntry> = {}): ProjectEntry => ({
    id,
    name: `Project ${id}`,
    status: "active",
    position: 10,
    local_file: `${dir}/project.json`,
    ...extra,
  });
  const projects = [proj("p1", "/w/p1"), proj("p2", "/w/p2"), proj("lone", "/w/lone")];
  const boxes: ProjectBox[] = [{ id: "b1", name: "Thesis", member_ids: ["p1", "p2", "gone"], position: 1, folder: "/boxes/thesis" }];
  const t = ((key: string) => (key === "palette.scope.root" ? "Root" : key)) as never;

  it("memberOfCwdInScope reads the box's members and folder, and is null outside a box scope", () => {
    expect(memberOfCwdInScope("/w/p2/src", "box:b1", boxes, projects)?.id).toBe("p2");
    expect(memberOfCwdInScope("/boxes/thesis", "box:b1", boxes, projects)).toBeNull();
    expect(memberOfCwdInScope("/w/lone/x", "box:b1", boxes, projects)).toBeNull();
    expect(memberOfCwdInScope("/w/p2/src", "p1", boxes, projects)).toBeNull();
    expect(memberOfCwdInScope("/w/p2/src", "box:nope", boxes, projects)).toBeNull();
  });

  it("newTabTarget: the active tab's member root, never its own cwd; else the box folder", () => {
    expect(newTabTarget("box:b1", "/w/p2/src/deep", boxes, projects)).toMatchObject({ cwd: "/w/p2", member: { id: "p2" } });
    expect(newTabTarget("box:b1", "/boxes/thesis", boxes, projects)).toEqual({ cwd: "/boxes/thesis", member: null });
    expect(newTabTarget("box:b1", undefined, boxes, projects)).toEqual({ cwd: "/boxes/thesis", member: null });
    expect(newTabTarget("box:b1", "/elsewhere", boxes, projects)).toEqual({ cwd: "/boxes/thesis", member: null });
    // Outside a box scope the caller keeps its own target.
    expect(newTabTarget("p1", "/w/p1", boxes, projects)).toBeNull();
    expect(newTabTarget("root", undefined, boxes, projects)).toBeNull();
  });

  it("newTabTarget gives an empty cwd for a box with no folder yet", () => {
    const fresh: ProjectBox[] = [{ id: "b2", name: "New", member_ids: [], position: 2 }];
    expect(newTabTarget("box:b2", "/w/p1", fresh, projects)).toEqual({ cwd: "", member: null });
  });

  it("scopeDisplayName names root, a box and a project; null for anything else", () => {
    expect(scopeDisplayName("root", projects, boxes, t)).toBe("Root");
    expect(scopeDisplayName("box:b1", projects, boxes, t)).toBe("Thesis");
    expect(scopeDisplayName("p2", projects, boxes, t)).toBe("Project p2");
    expect(scopeDisplayName("box:nope", projects, boxes, t)).toBeNull();
    expect(scopeDisplayName("assistant", projects, boxes, t)).toBeNull();
  });
});

describe("memberColor", () => {
  it("is stable, derived from the project id in the boxes' hue space", () => {
    expect(memberColor("p1")).toBe(memberColor("p1"));
    expect(memberColor("p1")).toBe(autoBoxColor("p1"));
    expect(memberColor("p1")).not.toBe(memberColor("p2"));
    expect(memberColor("p1")).toMatch(/^hsl\(\d+ 62% 58%\)$/);
  });
});
