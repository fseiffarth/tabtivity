/**
 * The side panel header's hide-mode switch (`ProjectFilesView`): the pill
 * menu's "Hide other projects" / "Show other projects" as a header button.
 * Toggles `bar_solo`, shows only for a project on the unsliced strip, and
 * switches to the panel's project first when turning the mode on elsewhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { ProjectFilesView } from "../../components/files/ProjectFilesView";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useBoxSliceStore } from "../../stores/boxSlice";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";
import type { ProjectEntry } from "../../types";

const project = { id: "p", name: "Project", status: "active", position: 10, local_file: "/p/project.json" } as ProjectEntry;
const updateSettings = vi.fn(async (patch: Record<string, unknown>) => {
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...patch } as typeof s.settings }));
});
const setActive = vi.fn(async () => {});

async function renderPanel() {
  await act(async () => {
    render(<ProjectFilesView scope="p" projectId="p" project={project} projectDir="/p"
      folder="" onFolderChange={() => {}} source="local" setSource={() => {}}
      active mountTree={false} containerClassName="test-view" view="files" />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearFileViewSnapshots();
  mockInvoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "git_repo_root" ? null : []));
  useProjectsStore.setState({ projects: [project], activeId: "p", loaded: true, setActive });
  useTabsStore.setState({ scope: "p", tabsByScope: {} });
  useBoxSliceStore.setState({ sliceBoxId: null });
  useSettingsStore.setState({ settings: {} as never, updateSettings } as never);
});

describe("side panel hide-mode switch", () => {
  it("turns hide mode on and off", async () => {
    const user = userEvent.setup();
    await renderPanel();
    await user.click(screen.getByRole("button", { name: "Hide other projects" }));
    expect(updateSettings).toHaveBeenLastCalledWith({ bar_solo: true });
    expect(setActive).not.toHaveBeenCalled();
    const off = await screen.findByRole("button", { name: "Show other projects" });
    expect(off.getAttribute("aria-pressed")).toBe("true");
    await user.click(off);
    expect(updateSettings).toHaveBeenLastCalledWith({ bar_solo: undefined });
  });

  it("switches to the panel's project first when the scope is elsewhere", async () => {
    useTabsStore.setState({ scope: "other" });
    const user = userEvent.setup();
    await renderPanel();
    await user.click(screen.getByRole("button", { name: "Hide other projects" }));
    expect(setActive).toHaveBeenCalledWith("p");
    expect(updateSettings).toHaveBeenLastCalledWith({ bar_solo: true });
  });

  it("is absent inside a box slice, which ignores hide mode", async () => {
    useBoxSliceStore.setState({ sliceBoxId: "b" });
    await renderPanel();
    expect(screen.queryByRole("button", { name: "Hide other projects" })).toBeNull();
  });
});
