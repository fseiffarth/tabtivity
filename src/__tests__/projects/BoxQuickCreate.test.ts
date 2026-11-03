/**
 * Groundwork of the box redesign (AS1): the name rules the frontend repeats
 * from the backend, `createBoxQuick`, the diffed `saveBox`, and the fallbacks
 * for a running backend from before `create_box(memberIds, color)` and
 * `patch_box{name, addMembers, removeMembers}` (`src/` hot-reloads, `src-tauri/`
 * does not).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectBox } from "../../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import {
  BoxNameError,
  boxNameProblem,
  defaultBoxName,
  diffBoxMembers,
  MAX_BOX_NAME_CHARS,
  useBoxesStore,
} from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { useBoxEditorStore } from "../../stores/boxEditor";

function box(id: string, members: string[] = [], name = id, extra: Partial<ProjectBox> = {}): ProjectBox {
  return { id, name, member_ids: members, position: 10, ...extra };
}

const boxLabel = (n: number) => `Box ${n}`;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  useBoxesStore.setState({ boxes: [], loaded: true });
  useProjectsStore.setState({ projects: [], switchToast: null });
});

describe("box names", () => {
  it("refuses empty, over-long, control-character and taken names, case-insensitively", () => {
    const boxes = [box("a", [], "Thesis"), box("b", [], "  Lab ")];
    expect(boxNameProblem("  ", boxes)).toBe("empty");
    expect(boxNameProblem("x".repeat(MAX_BOX_NAME_CHARS + 1), boxes)).toBe("tooLong");
    expect(boxNameProblem("x".repeat(MAX_BOX_NAME_CHARS), boxes)).toBeNull();
    expect(boxNameProblem("\u00e9".repeat(MAX_BOX_NAME_CHARS), boxes)).toBeNull();
    expect(boxNameProblem("a\nb", boxes)).toBe("invalid");
    expect(boxNameProblem("THESIS", boxes)).toBe("taken");
    expect(boxNameProblem(" lab", boxes)).toBe("taken");
    expect(boxNameProblem("Paper", boxes)).toBeNull();
  });

  it("lets a box keep (or respell) its own name", () => {
    const boxes = [box("a", [], "Thesis"), box("b", [], "Lab")];
    expect(boxNameProblem("Thesis", boxes, "a")).toBeNull();
    expect(boxNameProblem("THESIS", boxes, "a")).toBeNull();
    expect(boxNameProblem("lab", boxes, "a")).toBe("taken");
  });

  it("defaultBoxName is the first free Box N, ignoring case", () => {
    expect(defaultBoxName([], boxLabel)).toBe("Box 1");
    expect(defaultBoxName([box("a", [], "Box 1"), box("b", [], "box 2")], boxLabel)).toBe("Box 3");
    expect(defaultBoxName([box("a", [], "Box 2")], boxLabel)).toBe("Box 1");
    expect(defaultBoxName([box("a", [], "Thesis")], (n) => `Caja ${n}`)).toBe("Caja 1");
  });

  it("diffBoxMembers names only what the draft changed against what it loaded", () => {
    expect(diffBoxMembers(["a", "b", "c"], ["b", "d", "a", "d"])).toEqual({ addMembers: ["d"], removeMembers: ["c"] });
    expect(diffBoxMembers([], [])).toEqual({ addMembers: [], removeMembers: [] });
    expect(diffBoxMembers(["a"], ["a"])).toEqual({ addMembers: [], removeMembers: [] });
  });
});

describe("createBoxQuick", () => {
  it("sends the name, members and colour in one create_box and shows the answer", async () => {
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "create_box"
        ? Promise.resolve(box("n1", args?.memberIds as string[], args?.name as string, { color: args?.color as string, rev: 1 }))
        : Promise.resolve(undefined),
    );
    const made = await useBoxesStore.getState().createBoxQuick({ name: "  Paper ", memberIds: ["p1", "p2", "p1"], color: "#ABCDEF" });
    expect(invoke).toHaveBeenCalledWith("create_box", { name: "Paper", memberIds: ["p1", "p2"], color: "#abcdef" });
    expect(made).toMatchObject({ id: "n1", name: "Paper", member_ids: ["p1", "p2"], color: "#abcdef" });
    expect(useBoxesStore.getState().boxes).toEqual([made]);
    // Nothing to top up: no further calls beyond the create.
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["create_box"]);
  });

  it("sends only the name when nothing else is asked (the old call shape)", async () => {
    invoke.mockResolvedValueOnce(box("n1", [], "Plain"));
    await useBoxesStore.getState().createBoxQuick({ name: "Plain" });
    expect(invoke).toHaveBeenCalledWith("create_box", { name: "Plain" });
  });

  it("refuses a bad name before sending anything", async () => {
    useBoxesStore.setState({ boxes: [box("a", [], "Thesis")] });
    await expect(useBoxesStore.getState().createBoxQuick({ name: "thesis" })).rejects.toMatchObject({ problem: "taken" });
    await expect(useBoxesStore.getState().createBoxQuick({ name: " " })).rejects.toBeInstanceOf(BoxNameError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("against an older backend that ignores memberIds and color, tops them up with the older calls", async () => {
    const disk = new Map<string, ProjectBox>();
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "create_box") {
        const made = box("old1", [], args?.name as string, { rev: 1 }); // memberIds/color ignored
        disk.set(made.id, made);
        return Promise.resolve({ ...made });
      }
      if (cmd === "patch_box") {
        const held = disk.get(args?.boxId as string)!;
        const patch = args?.patch as { addMember?: string; color?: string };
        const next: ProjectBox = { ...held, member_ids: [...held.member_ids], rev: (held.rev ?? 0) + 1 };
        if (patch.addMember) next.member_ids.push(patch.addMember);
        if (patch.color) next.color = patch.color;
        disk.set(next.id, next);
        return Promise.resolve({ ...next });
      }
      return Promise.resolve(undefined);
    });
    const made = await useBoxesStore.getState().createBoxQuick({ name: "Pair", memberIds: ["p1", "p2"], color: "#112233" });
    expect(made).toMatchObject({ member_ids: ["p1", "p2"], color: "#112233", rev: 4 });
    expect(useBoxesStore.getState().boxes[0]).toEqual(made);
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "old1", patch: { addMember: "p1" } });
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "old1", patch: { addMember: "p2" } });
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "old1", patch: { color: "#112233" } });
    expect(invoke).not.toHaveBeenCalledWith("set_box_members", expect.anything());
  });

  it("a top-up that is refused leaves the created box without that member and says why", async () => {
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "create_box") return Promise.resolve(box("old1", [], args?.name as string));
      if (cmd === "patch_box") return Promise.reject(new Error("no thanks"));
      return Promise.resolve(undefined);
    });
    const made = await useBoxesStore.getState().createBoxQuick({ name: "Pair", memberIds: ["p1"] });
    expect(made.member_ids).toEqual([]);
    expect(useProjectsStore.getState().switchToast).toBe("no thanks");
  });
});

describe("saveBox (the diffed save)", () => {
  it("is one patch_box carrying the name and only the members that changed", async () => {
    useBoxesStore.setState({ boxes: [box("a", ["p1", "p2"], "Alpha", { rev: 3, folder: "/b/a" })] });
    invoke.mockImplementation((cmd: string) =>
      cmd === "patch_box" ? Promise.resolve(box("a", ["p1", "late", "p3"], "Alpha 2", { rev: 4, folder: "/b/a" })) : Promise.resolve(undefined),
    );
    const saved = await useBoxesStore.getState().saveBox("a", { name: " Alpha 2 ", addMembers: ["p3"], removeMembers: ["p2"] });
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "a", patch: { name: "Alpha 2", addMembers: ["p3"], removeMembers: ["p2"] } });
    expect(invoke).not.toHaveBeenCalledWith("set_box_members", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("rename_box", expect.anything());
    // The file's box replaces the store's: the member another window added survives.
    expect(saved.member_ids).toEqual(["p1", "late", "p3"]);
    expect(useBoxesStore.getState().boxes[0]).toEqual(saved);
    expect(invoke).toHaveBeenCalledWith("refresh_box_agent_docs", { boxId: "a" });
  });

  it("omits what did not change, and an empty diff sends nothing", async () => {
    useBoxesStore.setState({ boxes: [box("a", ["p1"], "Alpha")] });
    invoke.mockResolvedValue(box("a", ["p1", "p2"], "Alpha"));
    await useBoxesStore.getState().saveBox("a", { name: "Alpha", addMembers: ["p2"], removeMembers: [] });
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "a", patch: { addMembers: ["p2"] } });
    invoke.mockClear();
    const same = await useBoxesStore.getState().saveBox("a", { name: "Alpha" });
    expect(invoke).not.toHaveBeenCalled();
    expect(same.id).toBe("a");
  });

  it("refuses a changed name the rules refuse, but not an unchanged legacy duplicate", async () => {
    useBoxesStore.setState({ boxes: [box("a", [], "Same"), box("b", [], "Same"), box("c", [], "Other")] });
    await expect(useBoxesStore.getState().saveBox("a", { name: "other" })).rejects.toMatchObject({ problem: "taken" });
    await expect(useBoxesStore.getState().saveBox("a", { name: "  " })).rejects.toMatchObject({ problem: "empty" });
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce(box("a", ["p9"], "Same"));
    await useBoxesStore.getState().saveBox("a", { name: "Same", addMembers: ["p9"] });
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "a", patch: { addMembers: ["p9"] } });
  });

  it("passes a backend refusal on, leaving the store alone", async () => {
    useBoxesStore.setState({ boxes: [box("a", ["p1"], "Alpha")] });
    invoke.mockRejectedValue(new Error("disk full"));
    await expect(useBoxesStore.getState().saveBox("a", { addMembers: ["p2"] })).rejects.toThrow("disk full");
    expect(useBoxesStore.getState().boxes[0].member_ids).toEqual(["p1"]);
  });

  it("falls back to rename_box + singular patches when the backend refuses the new fields", async () => {
    useBoxesStore.setState({ boxes: [box("a", ["p1", "p2"], "Alpha", { rev: 1 })] });
    const disk = { ...box("a", ["p1", "p2"], "Alpha", { rev: 1 }) };
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "patch_box") {
        const patch = args?.patch as Record<string, string>;
        if ("name" in patch || "addMembers" in patch || "removeMembers" in patch) {
          return Promise.reject(new Error("invalid args `patch` for command `patch_box`: unknown field `addMembers`, expected one of `addMember`, `removeMember`, `color`, `hidePill`"));
        }
        if (patch.addMember) disk.member_ids = [...disk.member_ids, patch.addMember];
        if (patch.removeMember) disk.member_ids = disk.member_ids.filter((m) => m !== patch.removeMember);
        disk.rev = (disk.rev ?? 0) + 1;
        return Promise.resolve({ ...disk });
      }
      if (cmd === "rename_box") {
        disk.name = args?.name as string;
        disk.rev = (disk.rev ?? 0) + 1;
        return Promise.resolve({ ...disk });
      }
      return Promise.resolve(undefined);
    });
    const saved = await useBoxesStore.getState().saveBox("a", { name: "Beta", addMembers: ["p3", "p4"], removeMembers: ["p1"] });
    expect(invoke).toHaveBeenCalledWith("rename_box", { boxId: "a", name: "Beta" });
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "a", patch: { addMember: "p3" } });
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "a", patch: { addMember: "p4" } });
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "a", patch: { removeMember: "p1" } });
    expect(saved).toMatchObject({ name: "Beta", member_ids: ["p2", "p3", "p4"], rev: 5 });
    expect(useBoxesStore.getState().boxes[0]).toEqual(saved);
  });
});

describe("boxEditor.renamingId", () => {
  it("is set and cleared by startRename / stopRename, apart from the editor's open state", () => {
    const s = useBoxEditorStore.getState();
    expect(s.renamingId).toBeNull();
    s.startRename("b1");
    expect(useBoxEditorStore.getState().renamingId).toBe("b1");
    useBoxEditorStore.getState().openEditor("b2");
    useBoxEditorStore.getState().close();
    expect(useBoxEditorStore.getState().renamingId).toBe("b1");
    useBoxEditorStore.getState().stopRename();
    expect(useBoxEditorStore.getState().renamingId).toBeNull();
  });
});
