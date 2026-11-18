/**
 * "Start in…" (box redesign, plan step 11): the one `openInMember` helper, the
 * fly-out entries it feeds, and the popout's `NewTabMenu` building the same
 * menu from its seed — same header, same fly-outs, same landing folders, with
 * the kinds that have no launch directory staying on the box folder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { NewTabMenu } from "../../components/tabs/NewTabMenu";
import { AGENT_ITEMS } from "../../lib/tabs/newTabItems";
import { openInMember, startInFlyout, startInSpec, targetHeading } from "../../components/tabs/startIn";
import { memberTableOf } from "../../components/tabs/TabMemberChip";
import { memberColor, boxColor } from "../../lib/theme/boxColor";
import { newTabTarget } from "../../stores/boxes";
import { useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import type { TabEntry } from "../../stores/tabs";
import type { ProjectBox, ProjectEntry } from "../../types";

const proj = (id: string): ProjectEntry =>
  ({ id, name: id, status: "active", position: 1, local_file: `/w/${id}/project.json`, directory: `/w/${id}` }) as ProjectEntry;
const projects = [proj("api"), proj("paper")];
const box: ProjectBox = { id: "b1", name: "thesis", member_ids: ["api", "paper"], position: 1, folder: "/boxes/thesis" };
const table = memberTableOf("box:b1", [box], projects)!;
const t = (key: string, vars?: Record<string, string>) =>
  `${key}${vars ? JSON.stringify(vars) : ""}`;
const CLAUDE = AGENT_ITEMS.find((i) => i.cmd === "claude")!;
const api = table.members.find((m) => m.id === "api")!;

describe("startInSpec", () => {
  it("roots the item at the member, or at the box folder for the whole box", () => {
    expect(startInSpec("agent", CLAUDE, api, table, t)).toMatchObject({ kind: "agent", cmd: "claude", cwd: "/w/api" });
    expect(startInSpec("shell", { label: "Shell", cmd: "", kind: "shell" }, null, table, t)).toMatchObject({
      kind: "shell",
      cwd: "/boxes/thesis",
    });
  });

  it("opens a member's Files as the project-files tab, the box's as the plain one", () => {
    expect(startInSpec("files", undefined, api, table, t)).toMatchObject({ kind: "projectfiles", cwd: "/w/api" });
    expect(startInSpec("files", undefined, null, table, t)).toMatchObject({ kind: "files", cwd: "/boxes/thesis" });
  });

  it("has nothing to start in for a box without a folder", () => {
    const fresh = { ...table, boxFolder: "" };
    expect(startInSpec("agent", CLAUDE, null, fresh, t)).toBeNull();
    expect(startInSpec("files", undefined, null, fresh, t)).toBeNull();
  });
});

describe("openInMember", () => {
  const ctx = () => ({
    viaRow: vi.fn(),
    add: vi.fn(),
    addUnique: vi.fn(),
  });

  it("sends an agent or shell for the folder the plain row targets through that row", () => {
    const c = ctx();
    openInMember({ kind: "agent", member: api, item: CLAUDE, table, launchCwd: "/w/api", t, ...c });
    expect(c.viaRow).toHaveBeenCalledWith(CLAUDE);
    expect(c.add).not.toHaveBeenCalled();
  });

  it("adds a new tab for any other folder, and Files as the unique pane", () => {
    const c = ctx();
    openInMember({ kind: "agent", member: api, item: CLAUDE, table, launchCwd: "/boxes/thesis", t, ...c });
    expect(c.add).toHaveBeenCalledTimes(1);
    expect((c.add.mock.calls[0][0] as TabEntry).cwd).toBe("/w/api");
    openInMember({ kind: "files", member: null, table, launchCwd: "/w/api", t, ...c });
    expect(c.addUnique).toHaveBeenCalledTimes(1);
    expect((c.addUnique.mock.calls[0][0] as TabEntry).cwd).toBe("/boxes/thesis");
  });
});

describe("startInFlyout", () => {
  it("lists the whole box first, then each member, with full searchable labels", () => {
    const open = vi.fn();
    const fly = startInFlyout({ what: "Claude", table, open, t });
    expect(fly.machineEntries?.map((e) => e.key)).toEqual(["Claude@box", "Claude@api", "Claude@paper"]);
    expect(fly.machineEntries?.every((e) => e.searchable)).toBe(true);
    expect(fly.machineEntries?.[1].color).toBe(memberColor("api"));
    expect(fly.machineEntries?.[0].color).toBe(boxColor(box));
    fly.machineEntries?.[2].onPick();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "paper" }));
  });

  it("is empty outside a box and with a single place to go", () => {
    expect(startInFlyout({ what: "Claude", table: null, open: vi.fn(), t })).toEqual({});
    const lone = memberTableOf("box:b2", [{ id: "b2", name: "x", member_ids: ["api"], position: 1 }], projects)!;
    expect(startInFlyout({ what: "Claude", table: lone, open: vi.fn(), t })).toEqual({});
  });
});

describe("targetHeading", () => {
  it("names the member with a dot, the box with a square", () => {
    expect(targetHeading(api, table, t)).toMatchObject({ color: memberColor("api"), box: false });
    expect(targetHeading(null, table, t)).toMatchObject({ color: boxColor(box), box: true });
  });
});

describe("the popout's NewTabMenu in a box", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_agents") return Promise.resolve([{ id: "claude", bin: "claude", installed: true }]);
      if (cmd === "git_worktree_list") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    // The popout's stores are inert: nothing but its seed knows the box.
    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  });
  afterEach(() => cleanup());

  const labelOf = (el: Element) => el.querySelector(".tab-new-menu-dot")?.nextSibling?.textContent ?? "";
  const rowOf = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".tab-new-menu-item")].find((el) => labelOf(el) === label)!;

  async function renderMenu(activeCwd: string | undefined) {
    const onPick = vi.fn();
    const target = newTabTarget("box:b1", activeCwd, [box], projects);
    await act(async () => {
      render(
        <NewTabMenu
          scope="box:b1"
          projectCwd={target?.cwd ?? ""}
          target={target}
          boxSeed={{ box, members: projects }}
          projectName=""
          anchor={{ x: 0, y: 0 }}
          onPick={onPick}
          onClose={vi.fn()}
          onManageAgents={vi.fn()}
        />,
      );
    });
    return onPick;
  }

  it("names the active tab's member and lists Start in… from the seed", async () => {
    await renderMenu("/w/paper/src");
    expect(document.querySelector(".tab-new-menu-target")?.textContent).toContain("New tab in paper");
    expect(document.body.textContent).not.toContain("Box members");
    const caret = rowOf("Shell").parentElement!.querySelector<HTMLButtonElement>(".tab-new-menu-split-caret")!;
    await act(async () => {
      fireEvent.click(caret);
    });
    expect([...document.querySelectorAll(".tab-new-menu-more .tab-new-menu-item")].map(labelOf)).toEqual([
      "Shell in the whole box",
      "Shell in api",
      "Shell in paper",
    ]);
  });

  it("starts a plain pick in the member, another member from the fly-out, and fixed kinds in the box folder", async () => {
    const onPick = await renderMenu("/w/paper/src");
    await act(async () => {
      fireEvent.click(rowOf("Shell"));
    });
    await vi.waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(onPick.mock.calls[0][0]).toMatchObject({ kind: "shell", cwd: "/w/paper", label: "Shell" });
    cleanup();
    const second = await renderMenu("/w/paper/src");
    const caret = rowOf("Claude").parentElement!.querySelector<HTMLButtonElement>(".tab-new-menu-split-caret")!;
    await act(async () => {
      fireEvent.click(caret);
    });
    await act(async () => {
      fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".tab-new-menu-more .tab-new-menu-item")].find((el) => labelOf(el) === "Claude in api")!);
    });
    expect(second.mock.calls[0][0]).toMatchObject({ kind: "agent", cmd: "claude", cwd: "/w/api", label: "Claude" });
    cleanup();
    const third = await renderMenu("/w/paper/src");
    await act(async () => {
      fireEvent.click(rowOf("System Monitor"));
    });
    expect(third.mock.calls[0][0]).toMatchObject({ kind: "monitor", cwd: "/boxes/thesis" });
  });

  it("opens a member's Files as the project-files tab", async () => {
    const onPick = await renderMenu("/w/api");
    await act(async () => {
      fireEvent.click(rowOf("Files"));
    });
    expect(onPick.mock.calls[0][0]).toMatchObject({ kind: "projectfiles", cwd: "/w/api" });
  });

  it("shows no first line and no fly-out outside a box", async () => {
    const onPick = vi.fn();
    await act(async () => {
      render(
        <NewTabMenu scope="p1" projectCwd="/w/api" projectName="" anchor={{ x: 0, y: 0 }} onPick={onPick} onClose={vi.fn()} onManageAgents={vi.fn()} />,
      );
    });
    expect(document.querySelector(".tab-new-menu-target")).toBeNull();
    expect(document.querySelector(".tab-new-menu-split")).toBeNull();
  });
});
