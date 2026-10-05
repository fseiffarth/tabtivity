import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { SidePanel } from "../../components/layout/SidePanel";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";
import { BRAND, MOBILE_ACCESS_KEY, MOBILE_DEVICES_KEY, MOBILE_HOST_KEY } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

/** Device ids as the sidecar mints them: 27 chars of base64url. */
const PIXEL = "pixelpixelpixelpixelpixel01";
const IPAD = "ipadipadipadipadipadipad_02";
const REVOKED = "revokedrevokedrevokedrevo03";
let paired: { id: string; name: string; created_at: number; online?: boolean }[] = [];

/** Everything but the access command, as the side panel needs it answered. */
function backend(command: string): Promise<unknown> {
  if (command === "mobile_host_status") return Promise.resolve({ running: true });
  if (command === "mobile_paired_devices") return Promise.resolve(paired);
  if (command === "git_status") return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
  if (command === "git_repo_root") return Promise.resolve(null);
  if (command === "project_scaffold_missing") return Promise.resolve(false);
  return Promise.resolve([]);
}

const project: ProjectEntry = {
  id: "mobile-project",
  name: "Mobile project",
  status: "active",
  position: 1,
  local_file: "/projects/mobile-project/project.json",
};

describe("Mobile project access in the file viewer", () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string) =>
      command === "set_project_mobile_access"
        ? Promise.resolve({ enabled: true, devices: null })
        : backend(command));
    paired = [
      { id: PIXEL, name: "Pixel", created_at: 1_790_000_000 },
      { id: IPAD, name: "iPad", created_at: 1_790_000_000 },
    ];
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

  function phoneButton(pressed = false) {
    return screen.findByRole("button", {
      name: `${BRAND.display} Mobile access for ${project.name}`,
      pressed,
    });
  }

  function withAccess(devices?: string[]) {
    useProjectsStore.setState({
      projects: [{ ...project, [MOBILE_ACCESS_KEY]: true, ...(devices === undefined ? {} : { [MOBILE_DEVICES_KEY]: devices }) }],
    });
  }

  it("opens the phone picker instead of toggling, and All phones turns access on for every phone", async () => {
    const user = userEvent.setup();
    render(<SidePanel open />);

    await user.click(await phoneButton());
    // Opening the picker writes nothing.
    expect(invokeMock).not.toHaveBeenCalledWith("set_project_mobile_access", expect.anything());
    expect(screen.getByRole("menuitemradio", { name: "Only these phones" })).toBeTruthy();

    await user.click(screen.getByRole("menuitemradio", { name: "All phones" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_project_mobile_access", {
        projectId: project.id,
        enabled: true,
        devices: null,
      });
    });
  });

  it("lists the paired phones under Only these phones and writes the ticked ids", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      if (command === "set_project_mobile_access") {
        const { devices } = args as { devices: string[] | null };
        return Promise.resolve({ enabled: true, devices });
      }
      return backend(command);
    });
    render(<SidePanel open />);

    await user.click(await phoneButton());
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Only these phones" })).toHaveProperty("disabled", false));
    await user.click(screen.getByRole("menuitemradio", { name: "Only these phones" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "iPad" })).toBeTruthy();
    // Choosing the mode alone writes nothing: an empty list is never stored.
    expect(invokeMock).not.toHaveBeenCalledWith("set_project_mobile_access", expect.anything());

    await user.click(screen.getByRole("menuitemcheckbox", { name: "Pixel" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_project_mobile_access", {
        projectId: project.id,
        enabled: true,
        devices: [PIXEL],
      });
    });
    expect(useProjectsStore.getState().projects[0]).toMatchObject({
      [MOBILE_ACCESS_KEY]: true,
      [MOBILE_DEVICES_KEY]: [PIXEL],
    });
    // The last ticked phone cannot be unticked.
    await waitFor(() => expect(screen.getByRole("menuitemcheckbox", { name: "Pixel" })).toHaveProperty("disabled", true));
    expect(screen.getByText(/One phone stays ticked/)).toBeTruthy();
  });

  it("keeps the current list when another phone is ticked, and never drops it", async () => {
    const user = userEvent.setup();
    withAccess([PIXEL]);
    render(<SidePanel open />);

    await user.click(await phoneButton(true));
    const pixel = await screen.findByRole("menuitemcheckbox", { name: "Pixel" });
    expect(pixel.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Only these phones" }).getAttribute("aria-checked")).toBe("true");

    await user.click(screen.getByRole("menuitemcheckbox", { name: "iPad" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_project_mobile_access", {
        projectId: project.id,
        enabled: true,
        devices: [PIXEL, IPAD],
      });
    });
  });

  it("names the reach in the button's title, counting only phones still paired", async () => {
    withAccess([PIXEL, REVOKED]);
    const { unmount } = render(<SidePanel open />);
    await waitFor(async () => expect((await phoneButton(true)).getAttribute("title")).toContain("1 phone can open"));
    unmount();

    withAccess([REVOKED]);
    const second = render(<SidePanel open />);
    await waitFor(async () => expect((await phoneButton(true)).getAttribute("title")).toContain("no phone reaches it"));
    second.unmount();

    withAccess();
    render(<SidePanel open />);
    expect((await phoneButton(true)).getAttribute("title")).toContain("every paired phone");
  });

  it("offers only All phones while no phone is paired", async () => {
    const user = userEvent.setup();
    paired = [];
    render(<SidePanel open />);

    await user.click(await phoneButton());
    await screen.findByText("Phones appear here once paired.");
    expect(screen.getByRole("menuitemradio", { name: "Only these phones" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("menuitemradio", { name: "All phones" })).toHaveProperty("disabled", false);
  });

  it("offers no write that drops a stored list while the paired phones cannot be read", async () => {
    const user = userEvent.setup();
    withAccess([PIXEL]);
    invokeMock.mockImplementation((command: string) => {
      if (command === "mobile_paired_devices" || command === "mobile_admin") return Promise.reject("unreadable");
      if (command === "set_project_mobile_access") return Promise.resolve({ enabled: true, devices: null });
      return backend(command);
    });
    render(<SidePanel open />);

    await user.click(await phoneButton(true));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("mobile_paired_devices"));
    const only = screen.getByRole("menuitemradio", { name: "Only these phones" });
    expect(only.getAttribute("aria-checked")).toBe("true");
    expect(only).toHaveProperty("disabled", true);
    expect(screen.queryAllByRole("menuitemcheckbox")).toHaveLength(0);
    // Clicking the selected mode again writes nothing either.
    await user.click(only);
    expect(invokeMock).not.toHaveBeenCalledWith("set_project_mobile_access", expect.anything());
    // Only an explicit All phones widens it.
    await user.click(screen.getByRole("menuitemradio", { name: "All phones" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_project_mobile_access", {
        projectId: project.id,
        enabled: true,
        devices: null,
      });
    });
  });

  it("turns access off from the picker", async () => {
    const user = userEvent.setup();
    withAccess([PIXEL]);
    invokeMock.mockImplementation((command: string) => {
      if (command === "set_project_mobile_access") return Promise.resolve({ enabled: false, devices: null });
      return backend(command);
    });
    render(<SidePanel open />);

    await user.click(await phoneButton(true));
    const picker = document.querySelector(".mobile-access-picker") as HTMLElement;
    await user.click(within(picker).getByRole("button", { name: "Turn off Mobile access" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_project_mobile_access", {
        projectId: project.id,
        enabled: false,
        devices: null,
      });
    });
    await waitFor(() => expect(document.querySelector(".mobile-access-picker")).toBeNull());
    expect(useProjectsStore.getState().projects[0][MOBILE_DEVICES_KEY]).toBeUndefined();
  });
});
