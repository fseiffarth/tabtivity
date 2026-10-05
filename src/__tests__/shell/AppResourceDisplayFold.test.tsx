/**
 * The header CPU/RAM/GPU readout while the status cluster is folded: it is
 * `display: none` and never tones the summary lamp, so it takes no readings of
 * its own — only one per `peek` (the pointer reaching the fold toggle), and that
 * one skips the GPU/Ollama reads the tooltip never shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { AppResourceDisplay } from "../../components/header/AppResourceDisplay";
import { useHeaderStatusStore } from "../../stores/headerStatus";
import { usePowerStore } from "../../stores/power";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const invokeMock = vi.mocked(invoke);

const usage = {
  cpu_percent: 12,
  rss_bytes: 400 * 1024 * 1024,
  process_count: 3,
  vram_bytes: 0,
  gpus: [],
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(usage));
  usePowerStore.setState({ onBattery: false, blurred: false });
  useHeaderStatusStore.setState({ reports: {} });
  act(() => {
    useSettingsStore.setState({ settings: { fast_mode: false } as Settings, loaded: true });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe("AppResourceDisplay folded", () => {
  it("asks the backend nothing and arms no timer while folded", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    render(<AppResourceDisplay folded peek={0} />);
    await flush();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("samples once per peek, without the GPU reads", async () => {
    const { rerender } = render(<AppResourceDisplay folded peek={0} />);
    rerender(<AppResourceDisplay folded peek={1} />);
    await waitFor(() => expect(useHeaderStatusStore.getState().reports.resources?.label).toContain("12.0%"));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("debug_app_resource_usage", { gpu: false });
  });

  it("stops polling on fold but keeps its last reading, and resumes on unfold", async () => {
    const { rerender } = render(<AppResourceDisplay folded={false} peek={0} />);
    await screen.findByText(/12/);
    expect(invokeMock).toHaveBeenCalledWith("debug_app_resource_usage", { gpu: true });

    const clearSpy = vi.spyOn(window, "clearInterval");
    rerender(<AppResourceDisplay folded peek={0} />);
    expect(clearSpy).toHaveBeenCalled();
    // The cluster counts this member by its report; folding must not drop it.
    expect(useHeaderStatusStore.getState().reports.resources).toBeTruthy();

    invokeMock.mockClear();
    rerender(<AppResourceDisplay folded={false} peek={0} />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("debug_app_resource_usage", { gpu: true }),
    );
  });
});
