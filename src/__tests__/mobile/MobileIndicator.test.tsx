import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { MobileIndicator } from "../../components/header/MobileIndicator";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { BRAND, MOBILE_HOST_KEY } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

const refused = {
  configured: true,
  running: false,
  port: 43173,
  origin: "https://mobile.example.test",
  error: "Connection refused (os error 111)",
  installed_version: null,
  update_available: false,
};

const connected = {
  ...refused,
  running: true,
  error: null,
};

describe("MobileIndicator reconnect", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        [MOBILE_HOST_KEY]: { enabled: true },
        mobile_indicator: true,
      } as Settings,
      loaded: true,
    });
    useHeaderHoverMenuStore.setState({ openId: null });
  });

  afterEach(() => {
    invokeMock.mockReset();
    useSettingsStore.setState({ settings: null, loaded: false });
    useHeaderHoverMenuStore.setState({ openId: null });
  });

  it("waits through the admin socket hand-off instead of leaving a refused error", async () => {
    let applied = false;
    let restartStatusChecks = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "mobile_host_apply") {
        applied = true;
        return Promise.resolve();
      }
      if (command === "mobile_host_status") {
        if (!applied) return Promise.resolve(refused);
        restartStatusChecks += 1;
        return Promise.resolve(restartStatusChecks === 1 ? refused : connected);
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();
    render(<MobileIndicator />);

    await screen.findByLabelText(`${BRAND.display} Mobile connection unavailable`);
    await user.click(screen.getByLabelText(`${BRAND.display} Mobile connection unavailable`));
    expect(await screen.findByText("Connection refused (os error 111)")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => {
      expect(screen.getByLabelText(`${BRAND.display} Mobile connected`)).toBeTruthy();
    });
    expect(restartStatusChecks).toBe(2);
  });

  it("offers no Refresh and no Update while the host is current", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "mobile_host_status") return Promise.resolve(connected);
      return Promise.resolve(null);
    });
    const user = userEvent.setup();
    render(<MobileIndicator />);

    await screen.findByLabelText(`${BRAND.display} Mobile connected`);
    await user.click(screen.getByLabelText(`${BRAND.display} Mobile connected`));

    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("updates the host only while it is behind this window", async () => {
    let applied = false;
    invokeMock.mockImplementation((command: string) => {
      if (command === "mobile_host_apply") {
        applied = true;
        return Promise.resolve();
      }
      if (command === "mobile_host_status") {
        return Promise.resolve(applied ? connected : { ...connected, update_available: true });
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();
    render(<MobileIndicator />);

    await screen.findByLabelText(`${BRAND.display} Mobile connected`);
    await user.click(screen.getByLabelText(`${BRAND.display} Mobile connected`));
    await user.click(await screen.findByRole("button", { name: "Update" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mobile_host_apply", { enabled: true });
    });
    expect(await screen.findByText(/Mobile host is up to date/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("lists paired devices and disconnects one only on the second click", async () => {
    let devices = [
      { id: "dev-a", name: "Pixel", created_at: 1, last_seen_at: 1_700_000_000, online: false },
      { id: "dev-b", name: "iPad", created_at: 2, last_seen_at: 1_700_000_100, online: true },
    ];
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      if (command === "mobile_host_status") return Promise.resolve(connected);
      if (command === "mobile_admin") {
        const request = (args as { request: { type: string; device_id?: string } }).request;
        if (request.type === "devices") return Promise.resolve({ status: "devices", devices });
        if (request.type === "revoke") {
          devices = devices.filter((device) => device.id !== request.device_id);
          return Promise.resolve({ status: "ok" });
        }
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();
    render(<MobileIndicator />);

    await screen.findByLabelText(`${BRAND.display} Mobile connected`);
    await user.click(screen.getByLabelText(`${BRAND.display} Mobile connected`));

    expect(await screen.findByText("iPad")).toBeTruthy();
    expect(screen.getByText("Pixel")).toBeTruthy();
    expect(screen.getByText("Connected now")).toBeTruthy();
    expect(screen.getByText(/^Last connected /)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Disconnect Pixel" }));
    expect(invokeMock).not.toHaveBeenCalledWith("mobile_admin", { request: { type: "revoke", device_id: "dev-a" } });
    expect(screen.getByRole("button", { name: "Disconnect Pixel" }).textContent).toBe("Disconnect?");

    await user.click(screen.getByRole("button", { name: "Disconnect Pixel" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mobile_admin", { request: { type: "revoke", device_id: "dev-a" } });
    });
    await waitFor(() => expect(screen.queryByText("Pixel")).toBeNull());
    expect(screen.getByText("iPad")).toBeTruthy();
  });
  it("opens a paired phone's own access dialog from its Access button", async () => {
    const devices = [
      { id: "dev-a", name: "Pixel", created_at: 1, last_seen_at: null, online: true, hidden_sections: ["mail"] },
    ];
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      if (command === "mobile_host_status") return Promise.resolve(connected);
      if (command === "mobile_paired_devices") return Promise.resolve(devices);
      if (command === "mobile_admin") {
        const request = (args as { request: { type: string } }).request;
        if (request.type === "devices") return Promise.resolve({ status: "devices", devices });
        if (request.type === "set_hidden_sections") return Promise.resolve({ status: "ok" });
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();
    render(<MobileIndicator />);

    await screen.findByLabelText(`${BRAND.display} Mobile connected`);
    await user.click(screen.getByLabelText(`${BRAND.display} Mobile connected`));
    await user.click(await screen.findByRole("button", { name: "Access Pixel" }));

    const dialog = await screen.findByRole("dialog", { name: "Pixel" });
    expect(useHeaderHoverMenuStore.getState().openId).toBeNull();
    expect(dialog.querySelector("[aria-pressed='false']")?.textContent).toBe("Mail");

    await user.click(screen.getByRole("button", { name: "Mail" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mobile_admin", {
        request: { type: "set_hidden_sections", device_id: "dev-a", sections: [] },
      });
    });

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
