/**
 * The shared membership checklist (BoxMemberChecklist): the projects of a box,
 * and the boxes of a project. It toggles through one additive patch per click
 * (never a whole member list), lists closed projects with a label, keeps the
 * order it opened with, and grows a filter past 8 rows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { BoxMemberChecklist, CHECKLIST_FILTER_FROM } from "../../components/projects/BoxMemberChecklist";
import { useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";

function proj(id: string, position: number, status: ProjectEntry["status"] = "active"): ProjectEntry {
  return { id, name: id, status, position, local_file: `/p/${id}/project.json` };
}
function box(id: string, members: string[], position = 5): ProjectBox {
  return { id, name: id, member_ids: members, position };
}
/** The menu hands the checklist the box from the store, so it follows edits. */
function Live({ id }: { id: string }) {
  const held = useBoxesStore((s) => s.boxes.find((b) => b.id === id))!;
  return <BoxMemberChecklist box={held} />;
}
const names = (c: HTMLElement) => [...c.querySelectorAll(".box-member-name")].map((e) => e.textContent);

beforeEach(() => {
  invoke.mockReset();
  // The backend's answer to a patch: the stored box with the one change applied.
  invoke.mockImplementation((cmd: string, args?: { boxId: string; patch: { addMember?: string; removeMember?: string } }) => {
    if (cmd !== "patch_box" || !args) return Promise.resolve(undefined);
    const held = useBoxesStore.getState().boxes.find((b) => b.id === args.boxId)!;
    const { addMember, removeMember } = args.patch;
    const ids = held.member_ids.filter((id) => id !== removeMember);
    return Promise.resolve({ ...held, member_ids: addMember && !ids.includes(addMember) ? [...ids, addMember] : ids });
  });
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
});

describe("BoxMemberChecklist", () => {
  it("toggles through one singular patch_box per click, never a whole member list", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({ projects: [proj("p1", 1), proj("p2", 2), proj("gone", 3, "inactive")] });
    const { container } = render(<Live id="boxA" />);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-member-id="gone"]')!);
    });
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "boxA", patch: { addMember: "gone" } });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-member-id="p1"]')!);
    });
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "boxA", patch: { removeMember: "p1" } });
    expect(invoke).not.toHaveBeenCalledWith("set_box_members", expect.anything());
  });

  it("labels closed projects, members first, and keeps that order after a toggle", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p2"])] });
    useProjectsStore.setState({ projects: [proj("p1", 1), proj("p2", 2, "inactive"), proj("p3", 3)] });
    const { container } = render(<Live id="boxA" />);
    expect(names(container)).toEqual(["p2", "p1", "p3"]);
    expect(container.querySelector('[data-member-id="p2"]')!.textContent).toContain("closed");
    expect(container.querySelector('[data-member-id="p1"]')!.textContent).not.toContain("closed");
    expect(container.querySelector('[data-member-id="p2"]')!.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      useBoxesStore.setState({ boxes: [box("boxA", ["p2", "p3"])] });
    });
    expect(names(container)).toEqual(["p2", "p1", "p3"]);
    expect(container.querySelector('[data-member-id="p3"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a filter only past the threshold", () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => proj(`p${i}`, i));
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    useProjectsStore.setState({ projects: make(CHECKLIST_FILTER_FROM) });
    const first = render(<Live id="boxA" />);
    expect(first.container.querySelector(".box-member-filter")).toBeNull();
    first.unmount();
    useProjectsStore.setState({ projects: make(CHECKLIST_FILTER_FROM + 1) });
    const second = render(<Live id="boxA" />);
    expect(second.container.querySelector(".box-member-filter")).toBeTruthy();
    expect(names(second.container)).toHaveLength(CHECKLIST_FILTER_FROM + 1);
  });

  it("lists the boxes of a project with their swatch and toggles that project", async () => {
    const project = proj("p1", 1);
    useProjectsStore.setState({ projects: [project] });
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"], 1), box("boxB", [], 2)] });
    const { container } = render(<BoxMemberChecklist project={project} />);
    expect(names(container)).toEqual(["boxA", "boxB"]);
    expect(container.querySelectorAll(".context-menu-box-swatch")).toHaveLength(2);
    expect(container.querySelector('[data-row-id="boxA"]')!.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(container.querySelector('[data-row-id="boxB"]')!);
    });
    expect(invoke).toHaveBeenCalledWith("patch_box", { boxId: "boxB", patch: { addMember: "p1" } });
  });

  it("says so when nothing matches, and when there are no projects", () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    const empty = render(<Live id="boxA" />);
    expect(empty.container.textContent).toContain("No projects yet");
    empty.unmount();

    useProjectsStore.setState({ projects: Array.from({ length: 10 }, (_, i) => proj(`p${i}`, i)) });
    const { container } = render(<Live id="boxA" />);
    fireEvent.change(container.querySelector(".box-member-filter")!, { target: { value: "zzz" } });
    expect(container.textContent).toContain("Nothing matches");
  });
});
