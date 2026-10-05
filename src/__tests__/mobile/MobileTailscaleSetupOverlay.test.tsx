/**
 * "Set up in terminal" in Mobile settings is a one-click install like every
 * other install-via-command flow: the `tailscale serve` command runs in a root
 * terminal tab that the root console floats over Settings with that tab in
 * front, so the user watches it (and answers Tailscale's approval prompt)
 * without leaving the project. It used to switch the whole window to the root
 * scope instead.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileSettings } from "../../components/mobile/MobileSettings";
import { useBoxesStore } from "../../stores/boxes";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { Settings } from "../../types";
import { BRAND } from "../../lib/brand";

describe("Mobile settings — Set up Tailscale Serve in terminal", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "mobile_host_status") return Promise.resolve({ configured: false, running: false, update_available: false });
      if (command === "mobile_tailscale_serve_status") return Promise.resolve({ installed: false });
      if (command === "mobile_admin") return Promise.resolve({ status: "devices", devices: [] });
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [], activeId: "p1", loaded: true, rootDir: `/home/u/${BRAND.slug}/root` });
    useBoxesStore.setState({ boxes: [], loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    // Root already restored this session — the unhydrated path is
    // `InstallInRootConsole.test.tsx`'s.
    useTabsStore.setState({ scope: "project:p1", tabsByScope: { root: [] } });
    useRootOverlayStore.setState({ open: false });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(invoke).mockReset();
    useSettingsStore.setState({ settings: null, loaded: false });
    useRootOverlayStore.setState({ open: false });
  });

  it("opens the root console on a root tab running the serve command, without leaving the current scope", async () => {
    const user = userEvent.setup();
    render(<MobileSettings />);
    await user.click(screen.getByRole("button", { name: "Set up in terminal" }));

    const rootTabs = useTabsStore.getState().tabsByScope.root ?? [];
    expect(rootTabs).toHaveLength(1);
    expect(rootTabs[0].initialInput).toMatch(/^tailscale serve --bg http:\/\/127\.0\.0\.1:\d+$/);
    expect(rootTabs[0].label).toBe("Set up Tailscale Serve");
    expect(useRootOverlayStore.getState().open).toBe(true);
    // The panel stays where it is — the console is the window onto the install.
    expect(useTabsStore.getState().scope).toBe("project:p1");
  });

  it("does nothing when the confirmation is declined", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const user = userEvent.setup();
    render(<MobileSettings />);
    await user.click(screen.getByRole("button", { name: "Set up in terminal" }));
    expect(useTabsStore.getState().tabsByScope.root ?? []).toHaveLength(0);
    expect(useRootOverlayStore.getState().open).toBe(false);
  });
});
