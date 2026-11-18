import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(new Error("Not available in this test")) }));
import { SettingsDialog } from "../../components/layout/SettingsPanel";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

// Settings → Power & performance → the three stop-agent-tab rows: a stored
// value that is not one of the menu's choices (written by hand, or by an
// older build's list) is what the sweep applies, so the row shows it as its
// own option rather than a blank dropdown.

describe("stop-agent-tab rows", () => {
  it("show a stored value outside the choices as its own option", async () => {
    useSettingsStore.setState({
      settings: { stop_agent_tabs_cap: 25, stop_agent_tabs_idle_min: 90, stop_agent_tabs_min_free_mb: 3072 } as Settings,
      updateSettings: vi.fn(),
    } as never);
    await act(async () => {
      render(<SettingsDialog onClose={() => {}} />);
    });
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    await act(async () => {
      fireEvent.click(within(nav).getByRole("button", { name: "Power & performance" }));
    });
    expect(screen.getByText("25 running")).toBeTruthy();
    expect(screen.getByText("1.5 h")).toBeTruthy();
    expect(screen.getByText("3 GiB")).toBeTruthy();
  });
});
