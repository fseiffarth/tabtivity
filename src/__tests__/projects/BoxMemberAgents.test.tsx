/**
 * A box pill's status strip counts the agents of the box's member projects as
 * well as the ones in the box's own scope: a pill that read idle while a member
 * worked would say "nothing is running there". Each bar opens its own tab.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
const { jumpToTab } = vi.hoisted(() => ({ jumpToTab: vi.fn() }));
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab }));

import { ProjectSwitcher } from "../../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useActivityStore } from "../../stores/activity";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { resetBoxSlice } from "../../stores/boxSlice";

const proj = (id: string): ProjectEntry => ({ id, name: id, status: "active", position: 1, local_file: `/p/${id}/project.json` });
const box = (id: string, members: string[]): ProjectBox => ({ id, name: id, member_ids: members, position: 1 });

beforeEach(() => {
  resetBoxSlice();
  jumpToTab.mockClear();
  useHeaderHoverMenuStore.getState().close("box-scope-chip");
  useProjectsStore.setState({ projects: [proj("alpha"), proj("beta"), proj("gamma")], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [box("thesis", ["alpha", "beta"])], loaded: true });
  useActivityStore.setState({
    statusTabsByScope: {
      "box:thesis": [{ key: "own", state: "working" }],
      alpha: [{ key: "a1", state: "needs-decision" }],
      beta: [{ key: "b1", state: "working" }],
      // Not a member: never counted.
      gamma: [{ key: "g1", state: "working" }],
    },
  });
});

describe("box pill status strip", () => {
  it("counts the box's own agents and its members', not other projects'", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open={true} />));
    });
    const pill = container.querySelector(".box-scope-pill") as HTMLElement;
    expect(pill).toBeTruthy();
    const bars = [...pill.querySelectorAll("button.pill-status-bar")] as HTMLElement[];
    expect(bars).toHaveLength(3);
    // Working first, then waiting: the strip's urgency order across scopes.
    expect(bars.map((b) => b.className)).toEqual([
      expect.stringContaining("working"),
      expect.stringContaining("working"),
      expect.stringContaining("needs-decision"),
    ]);

    // A member's bar opens the member's own tab.
    await act(async () => {
      fireEvent.click(bars[2]);
    });
    expect(jumpToTab).toHaveBeenCalledWith("alpha", "a1");
  });

  it("shows the box's own bar alone when it has no member working", async () => {
    useActivityStore.setState({ statusTabsByScope: { "box:thesis": [{ key: "own", state: "working" }] } });
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open={true} />));
    });
    expect(container.querySelectorAll(".box-scope-pill button.pill-status-bar")).toHaveLength(1);
  });
});
