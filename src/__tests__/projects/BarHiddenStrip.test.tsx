/**
 * The "All projects" strip leaves out projects hidden from it — one by one or
 * as a box's members (`lib/projects/barHidden`) — but never the project in
 * scope, and a box's slice ignores the lists. The trailing "N hidden" chip
 * is the way back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import type { ProjectBox, ProjectEntry, Settings } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("../../lib/window/startWindowDrag", () => ({ startWindowDrag: vi.fn() }));

import { ProjectSwitcher } from "../../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../../stores/projects";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../../stores/boxes";
import { resetBoxSlice } from "../../stores/boxSlice";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";

function proj(id: string, position: number): ProjectEntry {
  return { id, name: id, status: "active", position, local_file: `/p/${id}/project.json` };
}

function box(id: string, members: string[]): ProjectBox {
  return { id, name: id, member_ids: members, position: 5 };
}

function pillNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".project-pill .project-pill-label")].map((el) => el.textContent ?? "");
}

const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
  const cur = useSettingsStore.getState().settings;
  useSettingsStore.setState({ settings: { ...cur, ...patch } as Settings });
});

beforeEach(() => {
  // The box slice is a store now (it outlives a remount): start every test unsliced.
  resetBoxSlice();
  updateSettings.mockClear();
  useProjectsStore.setState({
    projects: [proj("p1", 10), proj("p2", 20), proj("p3", 30), proj("p4", 40)],
    activeId: null,
    loaded: true,
  });
  useBoxesStore.setState({ boxes: [box("boxA", ["p3", "p4"])], loaded: true });
  useTabsStore.setState({ scope: "root" });
  useSettingsStore.setState({
    settings: { bar_hidden_projects: ["p1"], bar_hidden_boxes: ["boxA"] } as Settings,
    updateSettings,
  });
});

async function renderSwitcher() {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open={true} />));
  });
  return container;
}

describe("hiding projects from All projects", () => {
  it("leaves out hidden projects and a hidden box's members, and counts them", async () => {
    const container = await renderSwitcher();
    expect(pillNames(container)).toEqual(["p2"]);
    const chip = container.querySelector(".bar-hidden-chip") as HTMLElement;
    expect(chip.textContent).toContain("3 hidden");
  });

  it("keeps the project in scope on the strip", async () => {
    useTabsStore.setState({ scope: "p3" });
    const container = await renderSwitcher();
    expect(pillNames(container)).toEqual(["p2", "p3"]);
  });

  it("a box's slice still shows every member", async () => {
    useTabsStore.setState({ scope: `${BOX_SCOPE_PREFIX}boxA` });
    const container = await renderSwitcher();
    expect(pillNames(container)).toEqual(["p3", "p4"]);
    expect(container.querySelector(".bar-hidden-chip")).toBeNull();
  });

  it("the chip's menu shows a project, or a box's projects, again", async () => {
    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.click(container.querySelector(".bar-hidden-chip") as HTMLElement);
    });
    const menu = document.querySelector(".bar-hidden-menu") as HTMLElement;
    const shows = [...menu.querySelectorAll<HTMLElement>(".bar-hidden-show")];
    expect(shows).toHaveLength(2);
    await act(async () => {
      fireEvent.click(shows[0]);
    });
    expect(updateSettings).toHaveBeenLastCalledWith({ bar_hidden_projects: undefined });
    await act(async () => {
      fireEvent.click(shows[1]);
    });
    expect(updateSettings).toHaveBeenLastCalledWith({ bar_hidden_boxes: undefined });
    expect(pillNames(container)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(container.querySelector(".bar-hidden-chip")).toBeNull();
  });
});
