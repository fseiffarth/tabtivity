/**
 * Renaming a paired phone: Settings → Mobile → Paired devices has a Rename
 * button on each row that asks for a name and sends `rename_device` to the
 * sidecar's admin plane, then reloads the list.
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
import { MOBILE_HOST_KEY } from "../../lib/brand";

const PIXEL = "a".repeat(27);

function renames() {
  return vi.mocked(invoke).mock.calls
    .filter(([command, args]) => command === "mobile_admin" && (args as { request: { type: string } }).request.type === "rename_device")
    .map(([, args]) => (args as { request: unknown }).request);
}

describe("Mobile settings — rename a paired phone", () => {
  let name = "Pixel";
  beforeEach(() => {
    name = "Pixel";
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "mobile_host_status") return Promise.resolve({ configured: true, running: true, update_available: false });
      if (command === "mobile_tailscale_serve_status") return Promise.resolve({ installed: false });
      if (command === "mobile_paired_devices") return Promise.resolve([]);
      if (command === "mobile_admin") {
        const request = (args as { request: { type: string; name?: string } }).request;
        if (request.type === "rename_device") {
          name = request.name ?? name;
          return Promise.resolve({ status: "ok" });
        }
        return Promise.resolve({
          status: "devices",
          devices: [{ id: PIXEL, name, created_at: 1, last_seen_at: null, online: false }],
        });
      }
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
    useBoxesStore.setState({ boxes: [], loaded: true });
    useSettingsStore.setState({
      settings: { [MOBILE_HOST_KEY]: { enabled: true, display_name: "Desk", port: 8742, serve_origin: "https://desk.example.ts.net" } } as Settings,
      loaded: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    useSettingsStore.setState({ settings: null, loaded: false });
  });

  it("sends the trimmed new name and lists the phone under it", async () => {
    const user = userEvent.setup();
    render(<MobileSettings />);
    expect(await screen.findByText("Pixel")).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: /^Rename/ }));
    const field = await screen.findByRole("textbox", { name: "Phone name" });
    await user.clear(field);
    await user.type(field, "  Kitchen phone ");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(renames()).toEqual([{ type: "rename_device", device_id: PIXEL, name: "Kitchen phone" }]));
    expect(await screen.findByText("Kitchen phone")).toBeTruthy();
  });
});
