/**
 * Settings → Mobile → Linked desktops (`docs/phone_multi_desktop_plan.md`,
 * Phase 2): the add check mirrors the sidecar's `linked.rs`, the list is one
 * whole-block write that keeps the block's other fields, and the block's
 * other writers (host on/off, Serve detection, Lock down) carry it.
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
import { MAX_LINKED_DESKTOPS, canLink, validateLinkedOrigin } from "../../lib/linkedDesktops";

type Host = NonNullable<Settings[typeof MOBILE_HOST_KEY]>;

const OWN = "https://desk.example.ts.net";
const LAPTOP = "https://laptop.example.ts.net";

describe("validateLinkedOrigin (mirrors linked.rs)", () => {
  it("takes only a machine of this desktop's own tailnet, normalized", () => {
    expect(validateLinkedOrigin(OWN, LAPTOP, [])).toEqual({ ok: true, origin: LAPTOP });
    expect(validateLinkedOrigin(OWN, " https://Laptop.EXAMPLE.ts.net/ ", [])).toEqual({ ok: true, origin: LAPTOP });
    // Another instance on this machine, on Serve's third port.
    expect(validateLinkedOrigin(OWN, `${OWN}:10000`, [])).toEqual({ ok: true, origin: `${OWN}:10000` });
    expect(validateLinkedOrigin(OWN, `${OWN}:443`, [])).toEqual({ ok: false, reason: "own_origin" });
    for (const other of [
      "https://laptop.other.ts.net",
      "https://laptop.c.ts.net",
      "https://laptop.example.c.ts.net",
      "https://example.ts.net",
      "https://a.laptop.example.ts.net",
      "https://laptop.example.com",
    ]) {
      expect(validateLinkedOrigin(OWN, other, []), other).toEqual({ ok: false, reason: "not_same_tailnet" });
    }
    for (const invalid of ["http://laptop.example.ts.net", `${LAPTOP}/x`, "https://u@laptop.example.ts.net", `${LAPTOP}/?`, `${LAPTOP}#`, "laptop", ""]) {
      expect(validateLinkedOrigin(OWN, invalid, []), invalid).toEqual({ ok: false, reason: "invalid_origin" });
    }
    expect(validateLinkedOrigin("https://desk.example.com", LAPTOP, [])).toEqual({ ok: false, reason: "not_same_tailnet" });
    expect(validateLinkedOrigin(undefined, LAPTOP, [])).toEqual({ ok: false, reason: "not_same_tailnet" });
  });

  it("refuses a duplicate and a ninth entry", () => {
    expect(validateLinkedOrigin(OWN, "https://LAPTOP.example.ts.net", [LAPTOP])).toEqual({ ok: false, reason: "already_linked" });
    const full = Array.from({ length: MAX_LINKED_DESKTOPS }, (_, n) => `https://m${n}.example.ts.net`);
    expect(validateLinkedOrigin(OWN, LAPTOP, full)).toEqual({ ok: false, reason: "limit" });
  });

  it("links only from a ts.net machine name", () => {
    expect(canLink(OWN)).toBe(true);
    expect(canLink(undefined)).toBe(false);
    expect(canLink("https://desk.example.com")).toBe(false);
    expect(canLink("https://desk.c.ts.net")).toBe(false);
  });
});

/** The host object of every settings write, in order. */
function hostWrites(): Partial<Host>[] {
  return vi.mocked(invoke).mock.calls
    .filter(([command]) => command === "patch_settings")
    .map(([, args]) => (args as { patch: Settings }).patch[MOBILE_HOST_KEY] as Partial<Host>);
}

describe("Mobile settings — linked desktops", () => {
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
    settings: { [MOBILE_HOST_KEY]: { enabled: true, display_name: "Desk", port: 8742, serve_origin: OWN, ...extra } } as Settings,
    loaded: true,
  });
  const addressInput = () => screen.findByRole("textbox", { name: /Address of another computer/ });

  it("refuses another tailnet with a reason and writes nothing", async () => {
    host();
    const user = userEvent.setup();
    render(<MobileSettings />);
    await user.type(await addressInput(), "https://laptop.other.ts.net");
    await user.click(screen.getByRole("button", { name: "Link" }));
    expect(await screen.findByText(/Only computers on this computer's own tailnet/)).toBeTruthy();
    expect(hostWrites()).toHaveLength(0);
  });

  it("adds and removes in whole-block writes that keep the other fields", async () => {
    host({ root_devices: ["phone-1"], local_models: false });
    const user = userEvent.setup();
    render(<MobileSettings />);
    expect(screen.getByText(OWN, { selector: "code" })).toBeTruthy();
    await user.type(await addressInput(), "https://Laptop.example.ts.net/{Enter}");
    await waitFor(() => expect(hostWrites()).toHaveLength(1));
    expect(hostWrites()[0]).toMatchObject({ enabled: true, root_devices: ["phone-1"], local_models: false, linked_desktops: [LAPTOP] });
    expect(((await addressInput()) as HTMLInputElement).value).toBe("");

    await user.click(await screen.findByRole("button", { name: `Remove the link to ${LAPTOP}` }));
    await waitFor(() => expect(hostWrites()).toHaveLength(2));
    expect(hostWrites()[1]).toMatchObject({ root_devices: ["phone-1"] });
    expect(JSON.parse(JSON.stringify(hostWrites()[1]))).not.toHaveProperty("linked_desktops");
  });

  it("keeps the list when the host is switched off", async () => {
    host({ linked_desktops: [LAPTOP] });
    const user = userEvent.setup();
    render(<MobileSettings />);
    await user.click(await screen.findByRole("checkbox", { name: `${BRAND.display} Mobile` }));
    await waitFor(() => expect(hostWrites()).toHaveLength(1));
    expect(hostWrites()[0]).toMatchObject({ enabled: false, linked_desktops: [LAPTOP] });
  });

  it("asks for a ts.net Serve address before offering to link", async () => {
    host({ serve_origin: "https://desk.example.com" });
    render(<MobileSettings />);
    expect(await screen.findByText(/Linking needs this computer's Tailscale Serve address/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /Address of another computer/ })).toBeNull();
  });
});
