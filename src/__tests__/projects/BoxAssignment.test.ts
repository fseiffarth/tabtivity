/**
 * Store-level tests for project boxes under NON-EXCLUSIVE (N:M) membership:
 * the box `member_ids` lists are the only membership record — the per-project
 * `box_id` denormalization is gone (stale persisted keys are stripped in-memory
 * on load). addToBox is additive (other memberships survive), removeFromBox
 * never dissolves (a 1/0-member box lives on), deleteBox touches no project,
 * and boxProjects is the multi-select commit (new box, or append to one).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectBox, ProjectEntry } from "../../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { boxMembership, useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";

function proj(id: string): ProjectEntry {
  return {
    id,
    name: id,
    status: "active",
    position: 10,
    local_file: `/p/${id}/project.json`,
  };
}

function box(id: string, members: string[], position = 10): ProjectBox {
  return { id, name: id, member_ids: members, position };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  useBoxesStore.setState({ boxes: [], loaded: false });
  useProjectsStore.setState({ projects: [] });
});

describe("boxMembership (pure N:M selector)", () => {
  it("maps each project to EVERY box holding it", () => {
    const boxes = [box("boxA", ["p1", "p2"]), box("boxB", ["p1"])];
    const m = boxMembership(boxes);
    expect(m.get("p1")).toEqual(["boxA", "boxB"]);
    expect(m.get("p2")).toEqual(["boxA"]);
    expect(m.get("p3")).toBeUndefined();
  });
});

describe("boxes store — load", () => {
  it("strips a stale persisted box_id in memory without persisting", async () => {
    useProjectsStore.setState({
      projects: [{ ...proj("p1"), box_id: "stale" } as ProjectEntry, proj("p2")],
    });
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_boxes" ? Promise.resolve([box("boxA", ["p1"])]) : Promise.resolve(undefined),
    );
    await useBoxesStore.getState().load();
    const p1 = useProjectsStore.getState().projects.find((p) => p.id === "p1")!;
    expect("box_id" in p1).toBe(false);
    // No save on load — the strip reaches disk on the next ordinary save_projects.
    expect(invoke).not.toHaveBeenCalledWith("save_projects", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("save_boxes", expect.anything());
  });
});

describe("boxes store — addToBox (additive)", () => {
  it("adds to member_ids and persists save_boxes; projects.json is untouched", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    useProjectsStore.setState({ projects: [proj("p1")] });

    await useBoxesStore.getState().addToBox("p1", "boxA");

    expect(useBoxesStore.getState().boxes[0].member_ids).toEqual(["p1"]);
    expect(invoke).toHaveBeenCalledWith("save_boxes", {
      boxes: [expect.objectContaining({ id: "boxA", member_ids: ["p1"] })],
    });
    expect(invoke).not.toHaveBeenCalledWith("save_projects", expect.anything());
  });

  it("keeps every OTHER membership: a project may be in several boxes at once", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"]), box("boxB", [])] });

    await useBoxesStore.getState().addToBox("p1", "boxB");

    const m = boxMembership(useBoxesStore.getState().boxes);
    expect(m.get("p1")).toEqual(["boxA", "boxB"]);
  });

  it("is idempotent — adding an existing member changes and persists nothing", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });

    await useBoxesStore.getState().addToBox("p1", "boxA");

    expect(useBoxesStore.getState().boxes[0].member_ids).toEqual(["p1"]);
    expect(invoke).not.toHaveBeenCalledWith("save_boxes", expect.anything());
  });

  it("refreshes the agent docs of a box that already has a folder", async () => {
    useBoxesStore.setState({ boxes: [{ ...box("boxA", []), folder: "/b/boxA" }] });

    await useBoxesStore.getState().addToBox("p1", "boxA");

    expect(invoke).toHaveBeenCalledWith("refresh_box_agent_docs", { boxId: "boxA" });
  });

  it("does NOT refresh docs for a box that has no folder yet", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });

    await useBoxesStore.getState().addToBox("p1", "boxA");

    expect(invoke).not.toHaveBeenCalledWith("refresh_box_agent_docs", expect.anything());
  });
});

describe("boxes store — removeFromBox (no silent dissolve)", () => {
  it("removes from ONE box only; a 1-member box survives", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])] });

    await useBoxesStore.getState().removeFromBox("p1", "boxA");

    const boxes = useBoxesStore.getState().boxes;
    expect(boxes).toHaveLength(1);
    expect(boxes[0].member_ids).toEqual(["p2"]);
    expect(invoke).toHaveBeenCalledWith("save_boxes", expect.anything());
  });

  it("a box emptied of its last member still survives", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });

    await useBoxesStore.getState().removeFromBox("p1", "boxA");

    expect(useBoxesStore.getState().boxes).toHaveLength(1);
    expect(useBoxesStore.getState().boxes[0].member_ids).toEqual([]);
  });

  it("other boxes holding the same project are untouched", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"]), box("boxB", ["p1"])] });

    await useBoxesStore.getState().removeFromBox("p1", "boxA");

    const m = boxMembership(useBoxesStore.getState().boxes);
    expect(m.get("p1")).toEqual(["boxB"]);
  });
});

describe("boxes store — boxProjects (multi-select commit)", () => {
  it("creates a new box holding the selection", async () => {
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "create_box") return Promise.resolve(box("boxNew", [], 20));
      if (cmd === "set_box_members") {
        return Promise.resolve(box("boxNew", args?.memberIds as string[], 20));
      }
      return Promise.resolve(undefined);
    });

    const created = await useBoxesStore.getState().boxProjects(["p1", "p2"], { name: "Pair" });

    expect(created?.member_ids).toEqual(["p1", "p2"]);
    expect(invoke).toHaveBeenCalledWith("create_box", { name: "Pair" });
    expect(invoke).toHaveBeenCalledWith("set_box_members", {
      boxId: "boxNew",
      memberIds: ["p1", "p2"],
    });
  });

  it("appends the selection to an existing box, deduplicated", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "set_box_members"
        ? Promise.resolve(box("boxA", args?.memberIds as string[]))
        : Promise.resolve(undefined),
    );

    await useBoxesStore.getState().boxProjects(["p1", "p3"], { boxId: "boxA" });

    expect(invoke).toHaveBeenCalledWith("set_box_members", {
      boxId: "boxA",
      memberIds: ["p1", "p3"],
    });
  });
});

describe("boxes store — deleteBox", () => {
  it("drops the box and touches no project record", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])] });
    useProjectsStore.setState({ projects: [proj("p1"), proj("p2")] });

    await useBoxesStore.getState().deleteBox("boxA");

    expect(useBoxesStore.getState().boxes).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("delete_box", { boxId: "boxA" });
    expect(invoke).not.toHaveBeenCalledWith("save_projects", expect.anything());
  });
});

describe("boxes store — createBox / renameBox", () => {
  it("createBox appends the command's box to the store", async () => {
    invoke.mockResolvedValueOnce(box("boxNew", [], 20));
    const created = await useBoxesStore.getState().createBox("New Box");
    expect(created.id).toBe("boxNew");
    expect(useBoxesStore.getState().boxes).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("create_box", { name: "New Box" });
  });

  it("renameBox updates the store from the command result and persists", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    invoke.mockResolvedValueOnce({ ...box("boxA", []), name: "Renamed" });
    await useBoxesStore.getState().renameBox("boxA", "Renamed");
    expect(useBoxesStore.getState().boxes[0].name).toBe("Renamed");
    expect(invoke).toHaveBeenCalledWith("rename_box", { boxId: "boxA", name: "Renamed" });
  });
});

/**
 * The store keeps each box's revision in step with the file. A whole-list
 * `save_boxes` is refused for a box whose revision moved on, and every write
 * stamps a new one on the boxes it changed — so a store that never took the
 * stamped numbers back had its SECOND box edit of a window session refused as
 * stale. A fake backend here does the compare-and-swap the real one does.
 */
describe("boxes store — revisions follow the backend's writes", () => {
  function fakeBackend(initial: ProjectBox[]) {
    const disk = new Map(initial.map((b) => [b.id, { ...b }]));
    const strip = ({ rev: _rev, ...rest }: ProjectBox) => JSON.stringify(rest);
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "save_boxes") {
        const incoming = (args?.boxes ?? []) as ProjectBox[];
        for (const b of incoming) {
          const held = disk.get(b.id);
          if (held && (held.rev ?? 0) !== (b.rev ?? 0)) {
            return Promise.reject("boxes changed on disk since they were loaded; reload and apply the edit again");
          }
        }
        const written = incoming.map((b) => {
          const held = disk.get(b.id);
          const rev = held && strip(held) === strip(b) ? held.rev : (held?.rev ?? 0) + 1;
          return { ...b, rev };
        });
        disk.clear();
        for (const b of written) disk.set(b.id, b);
        return Promise.resolve(written);
      }
      if (cmd === "ensure_box_folder") {
        const id = args?.boxId as string;
        const held = disk.get(id)!;
        if (!held.folder) disk.set(id, { ...held, folder: `/boxes/${id}`, rev: (held.rev ?? 0) + 1 });
        return Promise.resolve(disk.get(id));
      }
      return Promise.resolve(undefined);
    });
    return disk;
  }

  it("lands a second edit after the first one's save", async () => {
    const disk = fakeBackend([{ ...box("boxA", []), rev: 1 }]);
    useBoxesStore.setState({ boxes: [{ ...box("boxA", []), rev: 1 }] });

    await useBoxesStore.getState().addToBox("p1", "boxA");
    expect(useBoxesStore.getState().boxes[0].rev).toBe(2);
    // Before the fix this one was refused as stale.
    await useBoxesStore.getState().setBoxColor("boxA", "#336699");
    await useBoxesStore.getState().removeFromBox("p1", "boxA");

    expect(disk.get("boxA")).toMatchObject({ member_ids: [], color: "#336699", rev: 4 });
    expect(useBoxesStore.getState().boxes[0].rev).toBe(4);
  });

  it("adopts the revision a first open stamps when it resolves the box folder", async () => {
    const disk = fakeBackend([{ ...box("boxA", []), rev: 1 }]);
    useBoxesStore.setState({ boxes: [{ ...box("boxA", []), rev: 1 }] });

    await useBoxesStore.getState().openBox("boxA");
    expect(useBoxesStore.getState().boxes[0]).toMatchObject({ folder: "/boxes/boxA", rev: 2 });
    await useBoxesStore.getState().setBoxPillHidden("boxA", true);

    expect(disk.get("boxA")).toMatchObject({ hide_pill: true, folder: "/boxes/boxA", rev: 3 });
  });

  it("takes back only the revision, so an edit made while a save was in flight survives", async () => {
    fakeBackend([{ ...box("boxA", []), rev: 1 }, { ...box("boxB", []), rev: 1 }]);
    useBoxesStore.setState({
      boxes: [{ ...box("boxA", []), rev: 1 }, { ...box("boxB", []), rev: 1 }],
    });

    const saving = useBoxesStore.getState().addToBox("p1", "boxA");
    useBoxesStore.setState((s) => ({
      boxes: s.boxes.map((b) => (b.id === "boxB" ? { ...b, name: "renamed meanwhile" } : b)),
    }));
    await saving;

    const [a, b] = useBoxesStore.getState().boxes;
    expect(a).toMatchObject({ member_ids: ["p1"], rev: 2 });
    expect(b).toMatchObject({ name: "renamed meanwhile", rev: 1 });
  });

  it("keeps working against a backend that answers nothing", async () => {
    useBoxesStore.setState({ boxes: [{ ...box("boxA", []), rev: 1 }] });
    await useBoxesStore.getState().addToBox("p1", "boxA");
    expect(useBoxesStore.getState().boxes[0]).toMatchObject({ member_ids: ["p1"], rev: 1 });
  });
});
