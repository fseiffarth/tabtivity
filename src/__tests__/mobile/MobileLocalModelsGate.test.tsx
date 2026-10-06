/**
 * The host-wide "Local models from the phone" switch (#31by). Unset is on, so
 * only its "off" is stored — and the three places Mobile settings rebuild the
 * host object from an explicit field list must each carry it, or turning the
 * host off (or on, or detecting Serve) would quietly switch it back on.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileSettings } from "../../components/mobile/MobileSettings";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { BRAND, MOBILE_HOST_KEY } from "../../lib/brand";

type Host = NonNullable<Settings[typeof MOBILE_HOST_KEY]>;

/** The host object of every settings write, in order. */
function hostWrites(): Partial<Host>[] {
  return vi.mocked(invoke).mock.calls
    .filter(([command]) => command === "patch_settings")
    .map(([, args]) => (args as { patch: Settings }).patch[MOBILE_HOST_KEY] as Partial<Host>);
}

describe("Mobile settings — local models switch", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "mobile_host_status") return Promise.resolve({ configured: true, running: false, update_available: false });
      if (command === "mobile_tailscale_serve_status") return Promise.resolve({ installed: false });
      if (command === "mobile_admin") return Promise.resolve({ status: "devices", devices: [] });
      if (command === "patch_settings") {
        const { patch } = args as { patch: Partial<Settings> };
        return Promise.resolve({ ...useSettingsStore.getState().settings, ...patch });
      }
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
    useBoxesStore.setState({ boxes: [], loaded: true });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    useSettingsStore.setState({ settings: null, loaded: false });
  });

  const host = (extra: Partial<Host> = {}) => useSettingsStore.setState({
    settings: { [MOBILE_HOST_KEY]: { enabled: true, display_name: "Desk", port: 8742, serve_origin: "https://desk.example.ts.net", ...extra } } as Settings,
    loaded: true,
  });
  const toggle = async () => screen.findByRole("checkbox", { name: /Local models from the phone/ }) as Promise<HTMLInputElement>;

  it("is on while unset, stores only false, and clears the key when turned back on", async () => {
    host();
    const user = userEvent.setup();
    render(<MobileSettings />);
    expect((await toggle()).checked).toBe(true);

    await user.click(await toggle());
    await waitFor(() => expect(hostWrites()).toHaveLength(1));
    expect(hostWrites()[0]).toMatchObject({ enabled: true, local_models: false });
    await waitFor(async () => expect((await toggle()).checked).toBe(false));

    await user.click(await toggle());
    await waitFor(() => expect(hostWrites()).toHaveLength(2));
    expect(hostWrites()[1].local_models).toBeUndefined();
    expect(JSON.parse(JSON.stringify(hostWrites()[1]))).not.toHaveProperty("local_models");
    await waitFor(async () => expect((await toggle()).checked).toBe(true));
  });

  it("keeps the stored off when the host itself is switched off", async () => {
    host({ local_models: false });
    const user = userEvent.setup();
    render(<MobileSettings />);
    expect((await toggle()).checked).toBe(false);
    await user.click(await screen.findByRole("checkbox", { name: `${BRAND.display} Mobile` }));
    await waitFor(() => expect(hostWrites()).toHaveLength(1));
    expect(hostWrites()[0]).toMatchObject({ enabled: false, local_models: false });
  });
});
