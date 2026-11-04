/**
 * The box sheet (`BoxEditorDialog`, AS5b): one box, no target dropdown and no
 * create mode; Save is ONE diffed `saveBox` against what the sheet opened with
 * (a project added meanwhile survives); closed projects are listed and can be
 * ticked; rows carry kind badges and the swatches of the other boxes; a trust
 * line names the container/VM/remote members; the phone row keeps the box's
 * current device list; Dissolve leaves the box first and names the folder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen, within } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../../types";
import { MOBILE_ACCESS_KEY, MOBILE_DEVICES_KEY } from "../../lib/brand";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));

import { BoxEditorDialog, BoxEditorHost, dissolveBoxSpec } from "../../components/projects/BoxEditorDialog";
import { BoxEmptyLine } from "../../components/projects/BoxEmptyLine";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { resetBoxSlice, useBoxSliceStore } from "../../stores/boxSlice";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { setDetachedWindowContext } from "../../stores/detachedContext";

function proj(id: string, position: number, extra: Partial<ProjectEntry> = {}): ProjectEntry {
  return { id, name: id, status: "active", position, local_file: `/p/${id}/project.json`, ...extra };
}

function box(id: string, members: string[], extra: Partial<ProjectBox> = {}): ProjectBox {
  return { id, name: id, member_ids: members, position: 5, ...extra };
}

/** `patch_box` answers with the box as the file would hold it after the patch. */
function answerPatches(read: () => ProjectBox[]) {
  mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "patch_box") {
      const patch = args?.patch as {
        name?: string;
        addMembers?: string[];
        removeMembers?: string[];
        color?: string;
      };
      const held = read().find((b) => b.id === args?.boxId)!;
      const members = [...held.member_ids];
      for (const id of patch.addMembers ?? []) if (!members.includes(id)) members.push(id);
      const left = new Set(patch.removeMembers ?? []);
      return {
        ...held,
        name: patch.name ?? held.name,
        member_ids: members.filter((id) => !left.has(id)),
      };
    }
    return null;
  });
}

async function openSheet(boxId: string, onClose = vi.fn()) {
  useBoxEditorStore.getState().openEditor(boxId);
  await act(async () => {
    render(<BoxEditorDialog onClose={onClose} />);
  });
  return { dialog: document.querySelector(".box-editor") as HTMLElement, onClose };
}

function rowOf(dialog: HTMLElement, id: string): HTMLElement {
  return dialog.querySelector(`.box-editor-member-row[data-member-id="${id}"]`) as HTMLElement;
}

function button(dialog: HTMLElement, text: string): HTMLButtonElement {
  return [...dialog.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
  resetBoxSlice();
  useBoxEditorStore.getState().close();
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true, switchToast: null });
  useBoxesStore.setState({ boxes: [], loaded: true });
  useSettingsStore.setState({ settings: null } as never);
  useTabsStore.setState({ scope: "root" });
});

describe("one box, no create mode", () => {
  it("has no target dropdown and the store no way to create", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", []), box("boxB", [])] });
    const { dialog } = await openSheet("boxA");
    expect(dialog.querySelector(".box-editor-target")).toBeNull();
    expect(dialog.querySelector(".dropdown")).toBeNull();
    expect(dialog.getAttribute("aria-label")).toBe("Box: boxA");
    expect("openCreate" in useBoxEditorStore.getState()).toBe(false);
    expect("initialMemberIds" in useBoxEditorStore.getState()).toBe(false);
  });

  it("closes itself when the box is dissolved elsewhere", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    const { onClose } = await openSheet("boxA");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      useBoxesStore.setState({ boxes: [] });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("the host mounts the sheet only while open", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    await act(async () => {
      render(<BoxEditorHost />);
    });
    expect(document.querySelector(".box-editor")).toBeNull();
    await act(async () => {
      useBoxEditorStore.getState().openEditor("boxA");
    });
    expect(document.querySelector(".box-editor")).toBeTruthy();
  });
});

describe("diffed save", () => {
  it("sends one patch of what changed; a member added meanwhile survives", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"], { name: "Thesis" })] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20), proj("p3", 30)],
      activeId: null,
      loaded: true,
    });
    answerPatches(() => useBoxesStore.getState().boxes);
    const { dialog, onClose } = await openSheet("boxA");

    // Another window (the phone, an import) adds p3 while the sheet is open.
    await act(async () => {
      useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p3"], { name: "Thesis" })] });
    });

    fireEvent.click(rowOf(dialog, "p2").querySelector("input")!); // tick p2
    fireEvent.click(rowOf(dialog, "p1").querySelector("input")!); // untick p1
    await act(async () => {
      fireEvent.click(button(dialog, "Save"));
    });

    const patches = mockInvoke.mock.calls.filter(([cmd]) => cmd === "patch_box");
    expect(patches).toHaveLength(1);
    // Only what the sheet changed against what it loaded: p3 is neither added
    // nor removed by it, and no whole list is written.
    expect(patches[0][1]).toEqual({ boxId: "boxA", patch: { addMembers: ["p2"], removeMembers: ["p1"] } });
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "set_box_members" || cmd === "rename_box")).toBe(false);
    expect(useBoxesStore.getState().boxes[0].member_ids).toEqual(["p3", "p2"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("carries the new name and colour in the same patch, and nothing for an untouched name", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"], { name: "Thesis" })] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    answerPatches(() => useBoxesStore.getState().boxes);
    const { dialog } = await openSheet("boxA");

    fireEvent.change(dialog.querySelector('input[type="text"]')!, { target: { value: "  Dissertation " } });
    fireEvent.click(dialog.querySelectorAll(".tab-color-swatches .tab-color-swatch")[1]); // first palette colour
    await act(async () => {
      fireEvent.click(button(dialog, "Save"));
    });
    const [[, args]] = mockInvoke.mock.calls.filter(([cmd]) => cmd === "patch_box");
    expect((args as { patch: Record<string, unknown> }).patch.name).toBe("Dissertation");
    expect((args as { patch: { color?: string } }).patch.color).toMatch(/^#[0-9a-f]{6}$/);
    expect((args as { patch: Record<string, unknown> }).patch).not.toHaveProperty("addMembers");
  });

  it("an untouched sheet writes nothing", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    const { dialog, onClose } = await openSheet("boxA");
    await act(async () => {
      fireEvent.click(button(dialog, "Save"));
    });
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "patch_box")).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it("checks the name inline: a taken name blocks Save, a legacy duplicate left alone does not", async () => {
    useBoxesStore.setState({
      boxes: [box("boxA", [], { name: "Same" }), box("boxB", [], { name: "Same" }), box("boxC", [], { name: "Other" })],
    });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    answerPatches(() => useBoxesStore.getState().boxes);
    const { dialog } = await openSheet("boxA");
    const field = dialog.querySelector('input[type="text"]') as HTMLInputElement;
    // The loaded duplicate name is not a problem while it is left as it is.
    expect(dialog.querySelector(".box-editor-name-error")).toBeNull();
    expect(button(dialog, "Save").disabled).toBe(false);

    fireEvent.change(field, { target: { value: "other" } });
    expect(dialog.querySelector(".box-editor-name-error")?.textContent).toBe("A box with that name already exists.");
    expect(button(dialog, "Save").disabled).toBe(true);

    fireEvent.change(field, { target: { value: "   " } });
    expect(dialog.querySelector(".box-editor-name-error")?.textContent).toBe("Give the box a name.");
    expect(button(dialog, "Save").disabled).toBe(true);

    fireEvent.change(field, { target: { value: "Fresh" } });
    expect(dialog.querySelector(".box-editor-name-error")).toBeNull();
    expect(button(dialog, "Save").disabled).toBe(false);
  });

  it("a refused write keeps the sheet open and says why", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    mockInvoke.mockRejectedValue(new Error("disk full"));
    const { dialog, onClose } = await openSheet("boxA");
    fireEvent.click(rowOf(dialog, "p1").querySelector("input")!);
    await act(async () => {
      fireEvent.click(button(dialog, "Save"));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().switchToast).toBe("disk full");
    expect(button(dialog, "Save").disabled).toBe(false);
  });
});

describe("member list", () => {
  it("lists members first, then the rest, closed projects included, and filters", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p3"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20, { status: "inactive" }), proj("p3", 30)],
      activeId: null,
      loaded: true,
    });
    const { dialog } = await openSheet("boxA");
    const ids = () => [...dialog.querySelectorAll(".box-editor-member-row")].map((r) => r.getAttribute("data-member-id"));
    expect(ids()).toEqual(["p3", "p1", "p2"]);
    expect(dialog.querySelector(".box-editor-count")?.textContent).toBe("1 of 3");

    // Ticking does not move the row under the pointer.
    fireEvent.click(rowOf(dialog, "p2").querySelector("input")!);
    expect(ids()).toEqual(["p3", "p1", "p2"]);
    expect(dialog.querySelector(".box-editor-count")?.textContent).toBe("2 of 3");

    fireEvent.change(dialog.querySelector(".box-editor-filter")!, { target: { value: "P2" } });
    expect(ids()).toEqual(["p2"]);
  });

  it("a closed project is labelled, can be added, and can be removed again", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p2"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10, { status: "inactive" }), proj("p2", 20, { status: "inactive" })],
      activeId: null,
      loaded: true,
    });
    answerPatches(() => useBoxesStore.getState().boxes);
    const { dialog } = await openSheet("boxA");
    expect(rowOf(dialog, "p1").querySelector(".box-editor-badge.is-closed")?.textContent).toBe("closed");
    expect((rowOf(dialog, "p2").querySelector("input") as HTMLInputElement).checked).toBe(true);

    fireEvent.click(rowOf(dialog, "p1").querySelector("input")!);
    fireEvent.click(rowOf(dialog, "p2").querySelector("input")!);
    await act(async () => {
      fireEvent.click(button(dialog, "Save"));
    });
    const [[, args]] = mockInvoke.mock.calls.filter(([cmd]) => cmd === "patch_box");
    expect((args as { patch: unknown }).patch).toEqual({ addMembers: ["p1"], removeMembers: ["p2"] });
    // Closed stays closed: membership is the only thing the save touched.
    expect(useProjectsStore.getState().projects.map((p) => p.status)).toEqual(["inactive", "inactive"]);
    expect(mockInvoke.mock.calls.map(([cmd]) => cmd as string).filter((cmd) => /project/i.test(cmd))).toEqual([]);
  });

  it("badges a row by container, VM and remote, and shows the other boxes' swatches", async () => {
    useBoxesStore.setState({
      boxes: [
        box("boxA", ["c", "v", "r"]),
        box("boxB", ["c"], { name: "Review", color: "#aa3300" }),
        box("boxC", ["c", "plain"], { name: "Collab" }),
      ],
    });
    useProjectsStore.setState({
      projects: [
        proj("c", 10, { sandbox: { enabled: true } }),
        proj("v", 20, { vm: { enabled: true } }),
        proj("r", 30, { remote: { host: "h", user: "u", remote_path: "/srv" } as never }),
        proj("plain", 40),
      ],
      activeId: null,
      loaded: true,
    });
    const { dialog } = await openSheet("boxA");
    const badges = (id: string) => [...rowOf(dialog, id).querySelectorAll(".box-editor-badge")].map((b) => b.textContent);
    expect(badges("c")).toEqual(["container"]);
    expect(badges("v")).toEqual(["VM"]);
    expect(badges("r")).toEqual(["remote"]);
    expect(badges("plain")).toEqual([]);

    const also = rowOf(dialog, "c").querySelector(".box-editor-also")!;
    expect(also.getAttribute("title")).toBe("Also in: Review, Collab");
    expect(also.querySelectorAll(".box-swatch")).toHaveLength(2);
    // The box being edited is never listed as "also".
    expect(rowOf(dialog, "v").querySelector(".box-editor-also")).toBeNull();
    expect(rowOf(dialog, "plain").querySelector(".box-editor-also")?.getAttribute("title")).toBe("Also in: Collab");
  });

  it("the trust lines name the ticked container, VM and remote members", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["c"])] });
    useProjectsStore.setState({
      projects: [
        proj("c", 10, { sandbox: { enabled: true } }),
        proj("v", 20, { vm: { enabled: true } }),
        proj("r", 30, { remote: { host: "h", user: "u", remote_path: "/srv" } as never }),
        proj("plain", 40),
      ],
      activeId: null,
      loaded: true,
    });
    const { dialog } = await openSheet("boxA");
    const note = () => dialog.querySelector(".box-editor-trust-note")?.textContent ?? "";
    expect(note()).toContain("outside the container of: c.");
    expect(note()).not.toContain("VM of");
    fireEvent.click(rowOf(dialog, "v").querySelector("input")!);
    fireEvent.click(rowOf(dialog, "r").querySelector("input")!);
    expect(note()).toContain("outside the VM of: v.");
    expect(note()).toContain("connection, which has to be up for their files: r.");
    // Unticking the last guarded member removes the note.
    for (const id of ["c", "v", "r"]) fireEvent.click(rowOf(dialog, id).querySelector("input")!);
    expect(dialog.querySelector(".box-editor-trust-note")).toBeNull();
  });
});

describe("folder", () => {
  it("shows the path with an Open button and the rename note", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [], { folder: "/b/boxA" })] });
    const { dialog } = await openSheet("boxA");
    expect(dialog.querySelector(".box-editor-folder-path")?.textContent).toBe("/b/boxA");
    expect(dialog.textContent).toContain("Renaming the box does not move its folder.");
    await act(async () => {
      fireEvent.click(button(dialog, "Open"));
    });
    expect(mockInvoke).toHaveBeenCalledWith("open_in_file_manager", { path: "/b/boxA" });
  });

  it("says the folder comes with the first open when there is none yet", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    const { dialog } = await openSheet("boxA");
    expect(dialog.querySelector(".box-editor-folder-path")).toBeNull();
    expect(dialog.querySelector(".box-editor-folder-none")?.textContent).toContain("first time");
  });
});

describe("phone row", () => {
  it("passes the box's CURRENT device list, never null, when switching", async () => {
    const setBoxMobileAccess = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({
      boxes: [box("boxA", [], { [MOBILE_ACCESS_KEY]: true, [MOBILE_DEVICES_KEY]: ["d1", "d2"] } as never)],
      setBoxMobileAccess,
    });
    const { dialog } = await openSheet("boxA");
    const toggle = dialog.querySelector('.box-editor-phone input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    // The reach button names the list ("2 phones" once the phones are known).
    expect(dialog.querySelector(".box-editor-phone .settings-btn")).toBeTruthy();
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(setBoxMobileAccess).toHaveBeenCalledWith("boxA", false, ["d1", "d2"]);

    // Switching on a box that carries a list keeps it as well.
    await act(async () => {
      useBoxesStore.setState({
        boxes: [box("boxA", [], { [MOBILE_ACCESS_KEY]: false, [MOBILE_DEVICES_KEY]: ["d1"] } as never)],
      });
    });
    await act(async () => {
      fireEvent.click(dialog.querySelector('.box-editor-phone input[type="checkbox"]')!);
    });
    expect(setBoxMobileAccess).toHaveBeenLastCalledWith("boxA", true, ["d1"]);
  });

  it("with no list it asks for every phone (null), like Settings", async () => {
    const setBoxMobileAccess = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", [])], setBoxMobileAccess });
    const { dialog } = await openSheet("boxA");
    expect(dialog.querySelector(".box-editor-phone .settings-btn")).toBeNull();
    await act(async () => {
      fireEvent.click(dialog.querySelector('.box-editor-phone input[type="checkbox"]')!);
    });
    expect(setBoxMobileAccess).toHaveBeenCalledWith("boxA", true, null);
  });

  it("is hidden, with the reason, when persistent local sessions are off", async () => {
    useSettingsStore.setState({ settings: { persist_local_sessions: false } } as never);
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    const { dialog } = await openSheet("boxA");
    expect(dialog.querySelector(".box-editor-phone")).toBeNull();
    expect(dialog.textContent).toContain("needs persistent local sessions (tmux)");
  });
});

describe("phone access that is already on", () => {
  it("can still be switched off while persistent local sessions are off", async () => {
    useSettingsStore.setState({ settings: { persist_local_sessions: false } } as never);
    const setBoxMobileAccess = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({
      boxes: [box("boxA", [], { [MOBILE_ACCESS_KEY]: true, [MOBILE_DEVICES_KEY]: ["d1"] } as never)],
      setBoxMobileAccess,
    });
    const { dialog } = await openSheet("boxA");
    const toggle = dialog.querySelector('.box-editor-phone input[type="checkbox"]') as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(true);
    // The line says it is still on (not "off for now") and how to get it going.
    expect(dialog.textContent).toContain("still on");
    expect(dialog.textContent).not.toContain("off for now");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(setBoxMobileAccess).toHaveBeenCalledWith("boxA", false, ["d1"]);
  });
});

describe("dissolve", () => {
  it("states the folder path in the confirm", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [], { folder: "/b/boxA" })] });
    const { dialog } = await openSheet("boxA");
    await act(async () => {
      fireEvent.click(button(dialog, "Dissolve box…"));
    });
    const question = await screen.findByRole("dialog", { name: "Dissolve box" });
    expect(question.textContent).toContain("/b/boxA");
    expect(question.textContent).toContain("stay on disk");
  });

  it("leaves the box first when you are inside it, then deletes", async () => {
    const order: string[] = [];
    const leaveBox = vi.fn(async () => {
      order.push("leave");
    });
    const deleteBox = vi.fn(async () => {
      order.push("delete");
    });
    useBoxesStore.setState({ boxes: [box("boxA", [])], deleteBox });
    useBoxSliceStore.setState({ sliceBoxId: "boxA", leaveBox });
    const { dialog, onClose } = await openSheet("boxA");
    await act(async () => {
      fireEvent.click(button(dialog, "Dissolve box…"));
    });
    const question = await screen.findByRole("dialog", { name: "Dissolve box" });
    await act(async () => {
      fireEvent.click(within(question).getByRole("button", { name: "Dissolve box" }));
    });
    expect(order).toEqual(["leave", "delete"]);
    expect(deleteBox).toHaveBeenCalledWith("boxA");
    expect(onClose).toHaveBeenCalled();
  });

  it("is also left first when only the scope is the box's", async () => {
    const leaveBox = vi.fn(async () => {});
    const deleteBox = vi.fn(async () => {});
    useBoxesStore.setState({ boxes: [box("boxA", [])], deleteBox });
    useBoxSliceStore.setState({ sliceBoxId: null, leaveBox });
    useTabsStore.setState({ scope: "box:boxA" });
    const { dialog } = await openSheet("boxA");
    await act(async () => {
      fireEvent.click(button(dialog, "Dissolve box…"));
    });
    const question = await screen.findByRole("dialog", { name: "Dissolve box" });
    await act(async () => {
      fireEvent.click(within(question).getByRole("button", { name: "Dissolve box" }));
    });
    expect(leaveBox).toHaveBeenCalledTimes(1);
    expect(deleteBox).toHaveBeenCalledWith("boxA");
  });

  it("does not leave a box you are not in", async () => {
    const leaveBox = vi.fn(async () => {});
    const deleteBox = vi.fn(async () => {});
    useBoxesStore.setState({ boxes: [box("boxA", []), box("boxB", [])], deleteBox });
    useBoxSliceStore.setState({ sliceBoxId: "boxB", leaveBox });
    const { dialog } = await openSheet("boxA");
    await act(async () => {
      fireEvent.click(button(dialog, "Dissolve box…"));
    });
    const question = await screen.findByRole("dialog", { name: "Dissolve box" });
    await act(async () => {
      fireEvent.click(within(question).getByRole("button", { name: "Dissolve box" }));
    });
    expect(leaveBox).not.toHaveBeenCalled();
    expect(deleteBox).toHaveBeenCalledWith("boxA");
  });

  it("the spec without a folder keeps the plain wording", () => {
    const t = ((key: string, p?: Record<string, string>) => `${key}|${JSON.stringify(p ?? {})}`) as never;
    expect(dissolveBoxSpec(t, "X").body).toContain("boxEditor.dissolveConfirm|");
    expect(dissolveBoxSpec(t, "X", "/f").body).toContain("boxEditor.dissolveConfirmFolder|");
  });
});

describe("empty-box line", () => {
  it("says there are no projects and its button opens the sheet for that box", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<BoxEmptyLine boxId="boxA" />));
    });
    expect(container.textContent).toContain("No projects yet");
    await act(async () => {
      fireEvent.click(container.querySelector(".box-empty-add")!);
    });
    expect(useBoxEditorStore.getState().open).toBe(true);
    expect(useBoxEditorStore.getState().boxId).toBe("boxA");
  });

  it("has no button in a popout, where no sheet host is mounted", async () => {
    setDetachedWindowContext({ scope: "box:boxA" } as never);
    try {
      let container!: HTMLElement;
      await act(async () => {
        ({ container } = render(<BoxEmptyLine boxId="boxA" />));
      });
      expect(container.textContent).toContain("No projects yet");
      expect(container.querySelector(".box-empty-add")).toBeNull();
    } finally {
      setDetachedWindowContext(null);
    }
  });
});
