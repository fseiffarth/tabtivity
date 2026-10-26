/**
 * Settings → Layout says so when the desktop cannot hide other apps' windows on
 * a project switch (the `null` / `kde-wayland` workspace backends), and says
 * nothing otherwise — including when the backend predates the command, which
 * is routine here (`src/` hot-reloads ahead of `src-tauri/`), and on the
 * browser client, whose adapter answers `{}`. The answer comes through
 * `lib/workspaceCaps` (one fetch per session).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { WorkspaceParkingNote } from "../../components/layout/SettingsPanel";
import { resetWorkspaceCaps } from "../../lib/workspaceCaps";

async function mount() {
  const view = render(<WorkspaceParkingNote />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return view;
}

describe("WorkspaceParkingNote", () => {
  beforeEach(() => {
    cleanup();
    invoke.mockReset();
    resetWorkspaceCaps();
  });

  it("explains a desktop that cannot park windows", async () => {
    invoke.mockResolvedValue({ backend: "null", can_park: false, wayland_session: false });
    const { container } = await mount();
    expect(invoke).toHaveBeenCalledWith("workspace_capabilities");
    expect(container.textContent).toContain("can't hide other apps' windows");
    // The reworded limit names where parking does work, GNOME included.
    expect(container.textContent).toContain("GNOME");
  });

  it("explains it for a backend that predates wayland_session too", async () => {
    invoke.mockResolvedValue({ backend: "null", can_park: false });
    const { container } = await mount();
    expect(container.textContent).toContain("can't hide other apps' windows");
  });

  it("says nothing where windows are parked", async () => {
    invoke.mockResolvedValue({ backend: "x11", can_park: true, wayland_session: true });
    const { container } = await mount();
    expect(container.textContent).toBe("");
  });

  it("says nothing when the backend has no such command", async () => {
    invoke.mockRejectedValue(new Error("command workspace_capabilities not found"));
    const { container } = await mount();
    expect(container.textContent).toBe("");
  });

  it("says nothing on the browser client's empty answer", async () => {
    invoke.mockResolvedValue({});
    const { container } = await mount();
    expect(container.textContent).toBe("");
  });

  it("fetches once per session, however many readers mount", async () => {
    invoke.mockResolvedValue({ backend: "null", can_park: false, wayland_session: false });
    await mount();
    cleanup();
    const { container } = await mount();
    expect(container.textContent).toContain("can't hide other apps' windows");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
