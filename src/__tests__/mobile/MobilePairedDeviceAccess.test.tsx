import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { PairedDeviceAccess, scopeReaches, withDevice, withoutDevice } from "../../components/mobile/PairedDeviceAccess";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import type { ProjectBox, ProjectEntry } from "../../types";
import { MOBILE_ACCESS_KEY, MOBILE_DEVICES_KEY } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

/** Device ids as the sidecar mints them: 27 chars of base64url. */
const PIXEL = "pixelpixelpixelpixelpixel01";
const IPAD = "ipadipadipadipadipadipad_02";
const PAIRED = [PIXEL, IPAD];

const entry = (id: string, name: string, extra: Partial<ProjectEntry> = {}): ProjectEntry => ({
  id,
  name,
  status: "active",
  position: 1,
  local_file: `/projects/${id}/project.json`,
  ...extra,
});

describe("one phone's side of the per-phone access lists", () => {
  it("reads the lists as the sidecar does", () => {
    expect(scopeReaches({ enabled: false, devices: undefined }, PIXEL)).toBe(false);
    expect(scopeReaches({ enabled: true, devices: undefined }, PIXEL)).toBe(true);
    expect(scopeReaches({ enabled: true, devices: [IPAD] }, PIXEL)).toBe(false);
    expect(scopeReaches({ enabled: true, devices: "garbage" }, PIXEL)).toBe(false);
  });

  it("disconnects a phone from every-phone access by naming the others, and turns off with none left", () => {
    expect(withoutDevice({ devices: undefined }, PIXEL, PAIRED)).toEqual({ enabled: true, devices: [IPAD] });
    expect(withoutDevice({ devices: [PIXEL, IPAD] }, IPAD, PAIRED)).toEqual({ enabled: true, devices: [PIXEL] });
    expect(withoutDevice({ devices: [PIXEL] }, PIXEL, PAIRED)).toEqual({ enabled: false, devices: null });
    expect(withoutDevice({ devices: undefined }, PIXEL, [PIXEL])).toEqual({ enabled: false, devices: null });
  });

  it("adds a phone: an off scope opens for it alone, a list gains it", () => {
    expect(withDevice({ enabled: false, devices: [IPAD] }, PIXEL, PAIRED)).toEqual({ enabled: true, devices: [PIXEL] });
    expect(withDevice({ enabled: true, devices: [IPAD, "gonegonegonegonegonegonego"] }, PIXEL, PAIRED))
      .toEqual({ enabled: true, devices: [IPAD, PIXEL] });
  });
});

describe("Settings → Mobile, a paired phone's access", () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      const a = args as { enabled: boolean; devices: string[] | null; boxId?: string };
      if (command === "set_project_mobile_access") return Promise.resolve({ enabled: a.enabled, devices: a.devices });
      if (command === "set_box_mobile_access") {
        const box = useBoxesStore.getState().boxes.find((b) => b.id === a.boxId);
        return Promise.resolve({ ...box, [MOBILE_ACCESS_KEY]: a.enabled || undefined, [MOBILE_DEVICES_KEY]: a.devices ?? undefined });
      }
      if (command === "mobile_admin") return Promise.resolve({ status: "ok" });
      return Promise.resolve(null);
    });
    useProjectsStore.setState({
      projects: [
        entry("everyone", "Everyone", { [MOBILE_ACCESS_KEY]: true }),
        entry("ipad-only", "iPad only", { [MOBILE_ACCESS_KEY]: true, [MOBILE_DEVICES_KEY]: [IPAD] }),
        entry("off", "Off project"),
        entry("remote", "Remote project"),
      ],
      loaded: true,
    });
    useBoxesStore.setState({
      boxes: [{ id: "box1", name: "Thesis box", [MOBILE_ACCESS_KEY]: true, [MOBILE_DEVICES_KEY]: [PIXEL] } as unknown as ProjectBox],
    });
  });

  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
  });

  function renderPixel(hidden: string[] = [], onChanged = vi.fn()) {
    render(
      <PairedDeviceAccess
        device={{ id: PIXEL, name: "Pixel", created_at: 1_790_000_000, hidden_sections: hidden }}
        pairedIds={PAIRED}
        eligibleProjectIds={new Set(["everyone", "ipad-only", "off"])}
        onChanged={onChanged}
      />,
    );
    return onChanged;
  }

  it("lists what reaches the phone, each with Disconnect", () => {
    renderPixel();
    expect(screen.getByText("Everyone")).toBeTruthy();
    expect(screen.getByText("Thesis box")).toBeTruthy();
    expect(screen.queryByText("iPad only")).toBeNull();
    expect(screen.queryByText("Off project")).toBeNull();
    expect(screen.queryByText("Remote project")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Disconnect" })).toHaveLength(2);
  });

  it("hides a section for this phone through the sidecar, keeping the others", async () => {
    const user = userEvent.setup();
    const onChanged = renderPixel(["mail"]);
    expect(screen.getByRole("button", { name: "Mail" }).getAttribute("aria-pressed")).toBe("false");
    await user.click(screen.getByRole("button", { name: "To-do" }));
    expect(invokeMock).toHaveBeenCalledWith("mobile_admin", {
      request: { type: "set_hidden_sections", device_id: PIXEL, sections: ["todo", "mail"] },
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("disconnecting from an every-phone project keeps it on the other phones", async () => {
    const user = userEvent.setup();
    renderPixel();
    await user.click(screen.getAllByRole("button", { name: "Disconnect" })[0]);
    expect(invokeMock).toHaveBeenCalledWith("set_project_mobile_access", { projectId: "everyone", enabled: true, devices: [IPAD] });
    await waitFor(() => expect(screen.queryByText("Everyone")).toBeNull());
  });

  it("disconnecting the last phone of a box turns its access off", async () => {
    const user = userEvent.setup();
    renderPixel();
    await user.click(screen.getAllByRole("button", { name: "Disconnect" })[1]);
    expect(invokeMock).toHaveBeenCalledWith("set_box_mobile_access", { boxId: "box1", enabled: false, devices: null });
  });

  it("adds a project from the menu: a list gains the phone, an off project opens for it alone", async () => {
    const user = userEvent.setup();
    renderPixel();
    await user.click(screen.getByRole("button", { name: /Add project/ }));
    expect(screen.queryByRole("button", { name: /Remote project/ })).toBeNull();
    await user.click(await screen.findByRole("button", { name: /iPad only/ }));
    expect(invokeMock).toHaveBeenCalledWith("set_project_mobile_access", { projectId: "ipad-only", enabled: true, devices: [IPAD, PIXEL] });

    await user.click(screen.getByRole("button", { name: /Add project/ }));
    await user.click(await screen.findByRole("button", { name: /Off project/ }));
    expect(invokeMock).toHaveBeenCalledWith("set_project_mobile_access", { projectId: "off", enabled: true, devices: [PIXEL] });
    await waitFor(() => expect(screen.getByText("Off project")).toBeTruthy());
  });
});
