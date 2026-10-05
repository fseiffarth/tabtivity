/**
 * The phone icon is the door into Tabtivity Mobile before it exists.
 *
 * While Mobile is off the header indicator used to render nothing at all, so
 * the only way in was the Mobile section of the settings scroll — which nobody
 * who has not already heard of the feature ever opens. The icon is therefore
 * shown dimmed, and clicking it opens the step-by-step setup overlay: the same
 * six steps as the settings fold, with the two Tabtivity can perform (run the
 * `tailscale serve` command, land on the Mobile section) as buttons.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { MobileIndicator } from "../../components/header/MobileIndicator";
import { useHeaderStatusStore } from "../../stores/headerStatus";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { Settings } from "../../types";
import { BRAND, MOBILE_HOST_KEY } from "../../lib/brand";

const settingsWith = (host?: Settings[typeof MOBILE_HOST_KEY]) =>
  ({ [MOBILE_HOST_KEY]: host } as Settings);

describe(`${BRAND.display} Mobile setup guide`, () => {
  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    useSettingsStore.setState({ settings: settingsWith(undefined), loaded: true });
    useProjectsStore.setState({ projects: [], activeId: "p1", loaded: true, rootDir: `/home/u/${BRAND.slug}/root` });
    // Root already restored this session — the unhydrated path is
    // `InstallInRootConsole.test.tsx`'s.
    useTabsStore.setState({ scope: "project:p1", tabsByScope: { root: [] } });
    useRootOverlayStore.setState({ open: false });
    useHeaderStatusStore.setState({ reports: {} });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(invoke).mockReset();
    useSettingsStore.setState({ settings: null, loaded: false });
    useRootOverlayStore.setState({ open: false });
    useHeaderStatusStore.setState({ reports: {} });
  });

  it("offers the icon while Mobile is off and opens the steps on a click", async () => {
    const user = userEvent.setup();
    render(<MobileIndicator />);

    // Nothing is probed for a host that was never configured.
    expect(invoke).not.toHaveBeenCalled();
    const icon = screen.getByRole("button", { name: `${BRAND.display} Mobile is not set up` });
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(icon);
    const dialog = screen.getByRole("dialog", { name: `Set up ${BRAND.display} Mobile` });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("Install Tailscale on this computer")).toBeTruthy();
    expect(screen.getByText("Pair the phone")).toBeTruthy();
    // Six steps, in the order they are performed.
    expect(dialog.querySelectorAll(".how-to-start-step")).toHaveLength(6);
  });

  it("is hidden entirely when the header widget is switched off", () => {
    useSettingsStore.setState({ settings: { mobile_indicator: false } as Settings, loaded: true });
    render(<MobileIndicator />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(useHeaderStatusStore.getState().reports.mobile).toBeUndefined();
  });

  it("names the port Mobile will actually listen on and runs the command in a root terminal", async () => {
    useSettingsStore.setState({
      settings: settingsWith({ enabled: false, port: 9001 }),
      loaded: true,
    });
    const user = userEvent.setup();
    render(<MobileIndicator />);
    await user.click(screen.getByRole("button", { name: `${BRAND.display} Mobile is not set up` }));

    expect(screen.getByText("tailscale serve --bg http://127.0.0.1:9001")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Set up in terminal" }));

    const rootTabs = useTabsStore.getState().tabsByScope.root ?? [];
    expect(rootTabs).toHaveLength(1);
    expect(rootTabs[0].initialInput).toBe("tailscale serve --bg http://127.0.0.1:9001");
    expect(useRootOverlayStore.getState().open).toBe(true);
    // The guide steps aside for the terminal it just opened.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("deep-links Settings to the Mobile section", async () => {
    const opened = vi.fn();
    window.addEventListener("app:open-settings", opened);
    const user = userEvent.setup();
    render(<MobileIndicator />);
    await user.click(screen.getByRole("button", { name: `${BRAND.display} Mobile is not set up` }));
    await user.click(screen.getByRole("button", { name: "Open Mobile settings" }));

    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      panel: "main",
      anchor: "settings-anchor-mobile",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    window.removeEventListener("app:open-settings", opened);
  });
});
