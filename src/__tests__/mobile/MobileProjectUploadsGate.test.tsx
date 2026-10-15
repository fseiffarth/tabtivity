/**
 * The host-wide "Phone may add files to projects" switch (phone upload plan,
 * step 3). Unset is off, so only its "on" is stored; it is greyed out while
 * Project files is off; and the three places Mobile settings rebuild the host
 * object from an explicit field list (host on/off, Detect Serve, Lock down)
 * must each carry it — the first two carry Browser access too, which lockdown
 * leaves out on purpose.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

const ORIGIN = "https://desk.example.ts.net";

/** The host object of every settings write, in order. */
function hostWrites(): Partial<Host>[] {
  return vi.mocked(invoke).mock.calls
    .filter(([command]) => command === "patch_settings")
    .map(([, args]) => (args as { patch: Settings }).patch[MOBILE_HOST_KEY] as Partial<Host>);
}

describe("Mobile settings — phone uploads switch", () => {
  let running = false;

  beforeEach(() => {
    running = false;
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "mobile_host_status") return Promise.resolve({ configured: true, running, update_available: false });
      if (command === "mobile_tailscale_serve_status") {
        return Promise.resolve({ installed: true, detected: { display_name: "Desk", port: 8742, origin: ORIGIN } });
      }
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
    vi.restoreAllMocks();
    useSettingsStore.setState({ settings: null, loaded: false });
  });

  const host = (extra: Partial<Host> = {}) => useSettingsStore.setState({
    settings: { [MOBILE_HOST_KEY]: { enabled: true, display_name: "Desk", port: 8742, serve_origin: ORIGIN, ...extra } } as Settings,
    loaded: true,
  });
  const toggle = async () =>
    screen.findByRole("checkbox", { name: /Phone may add files to projects/ }) as Promise<HTMLInputElement>;

  it("is off and greyed out while Project files is off", async () => {
    host();
    render(<MobileSettings />);
    const box = await toggle();
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
  });

  it("stores only true, and clears the key when turned off again", async () => {
    host({ project_files: true });
    const user = userEvent.setup();
    render(<MobileSettings />);
    const box = await toggle();
    expect(box.disabled).toBe(false);

    await user.click(box);
    await waitFor(() => expect(hostWrites()).toHaveLength(1));
    expect(hostWrites()[0]).toMatchObject({ project_files: true, project_uploads: true });
    await waitFor(async () => expect((await toggle()).checked).toBe(true));

    await user.click(await toggle());
    await waitFor(() => expect(hostWrites()).toHaveLength(2));
    expect(JSON.parse(JSON.stringify(hostWrites()[1]))).not.toHaveProperty("project_uploads");
    await waitFor(async () => expect((await toggle()).checked).toBe(false));
  });

  it("survives switching the host off, with Browser access", async () => {
    host({ project_files: true, project_uploads: true, browser_client: true });
    const user = userEvent.setup();
    render(<MobileSettings />);
    expect((await toggle()).checked).toBe(true);
    await user.click(await screen.findByRole("checkbox", { name: `${BRAND.display} Mobile` }));
    await waitFor(() => expect(hostWrites()).toHaveLength(1));
    expect(hostWrites()[0]).toMatchObject({ enabled: false, project_uploads: true, browser_client: true });
  });

  it("survives Detect Serve settings, with Browser access", async () => {
    host({ project_files: true, project_uploads: true, browser_client: true });
    const user = userEvent.setup();
    render(<MobileSettings />);
    await user.click(await screen.findByRole("button", { name: "Detect Tailscale Serve settings" }));
    await waitFor(() => expect(hostWrites()).toHaveLength(1));
    expect(hostWrites()[0]).toMatchObject({ serve_origin: ORIGIN, project_uploads: true, browser_client: true });
  });

  it("survives Lock down now, which closes Browser access", async () => {
    running = true;
    host({ project_files: true, project_uploads: true, browser_client: true });
    const user = userEvent.setup();
    render(<MobileSettings />);
    const lock = await screen.findByRole("button", { name: "Lock down now" });
    await waitFor(() => expect((lock as HTMLButtonElement).disabled).toBe(false));
    await user.click(lock);
    const question = await screen.findByRole("dialog", { name: "Lock down now" });
    await user.click(within(question).getByRole("button", { name: "Lock down now" }));
    await waitFor(() => expect(hostWrites()).toHaveLength(1));
    expect(hostWrites()[0]).toMatchObject({ enabled: false, project_uploads: true });
    expect(JSON.parse(JSON.stringify(hostWrites()[0]))).not.toHaveProperty("browser_client");
  });
});
