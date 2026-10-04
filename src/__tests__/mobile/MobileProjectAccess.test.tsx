import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { SidePanel } from "../../components/layout/SidePanel";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";
import { BRAND, MOBILE_HOST_KEY } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

const project: ProjectEntry = {
  id: "mobile-project",
  name: "Mobile project",
  status: "active",
  position: 1,
  local_file: "/projects/mobile-project/project.json",
};

describe("Mobile project access in the file viewer", () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "mobile_host_status") return Promise.resolve({ running: true });
      if (command === "set_project_mobile_access") return Promise.resolve({ enabled: true, devices: null });
      if (command === "git_status") return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
      if (command === "git_repo_root") return Promise.resolve(null);
      if (command === "project_scaffold_missing") return Promise.resolve(false);
      return Promise.resolve([]);
    });
    useProjectsStore.setState({ projects: [project], activeId: project.id, loaded: true });
    useSettingsStore.setState({
      settings: { [MOBILE_HOST_KEY]: { enabled: true } } as Settings,
      loaded: true,
    });
    useTabsStore.setState({ scope: project.id, tabsByScope: {} });
  });

  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
    useSettingsStore.setState({ settings: null, loaded: false });
  });

  it("offers the per-project toggle while the Mobile host is connected", async () => {
    const user = userEvent.setup();
    render(<SidePanel open />);

    // The opt-in is a tag chip, not a switch: an unpressed "Mobile · Off"
    // button that turns accent-filled once access is on.
    const toggle = await screen.findByRole("button", {
      name: `${BRAND.display} Mobile access for ${project.name}`,
      pressed: false,
    });
    await user.click(toggle);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_project_mobile_access", {
        projectId: project.id,
        enabled: true,
      });
    });
  });
});
