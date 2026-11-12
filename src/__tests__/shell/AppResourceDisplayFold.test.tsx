/**
 * The header CPU/RAM/GPU readout while the status cluster is folded: it is
 * `display: none` and never tones the summary lamp, so it takes no readings of
 * its own — only one per `peek` (the pointer reaching the fold toggle), and that
 * one skips the GPU/Ollama reads the tooltip never shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { AppResourceDisplay, RESOURCE_POLL_MS } from "../../components/header/AppResourceDisplay";
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
  vi.useFakeTimers();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(usage));
  usePowerStore.setState({ onBattery: false, blurred: false });
  useHeaderStatusStore.setState({ reports: {} });
  act(() => {
    // The rows are off by default; these tests are about a shown readout.
    useSettingsStore.setState({
      settings: { fast_mode: false, show_cpu_usage: true, show_ram_usage: true, show_gpu_usage: true } as Settings,
      loaded: true,
    });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = () => act(async () => { await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("AppResourceDisplay folded", () => {
  it("asks the backend nothing and arms no timer while folded", async () => {
    render(<AppResourceDisplay folded peek={0} />);
    await flush();
    expect(invokeMock).not.toHaveBeenCalled();
    await advance(60_000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("samples once per peek, without the GPU reads", async () => {
    const { rerender } = render(<AppResourceDisplay folded peek={0} />);
    rerender(<AppResourceDisplay folded peek={1} />);
    await flush();
    expect(useHeaderStatusStore.getState().reports.resources?.label).toContain("12.0%");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("debug_app_resource_usage", { gpu: false });
  });

  it("stops polling on fold but keeps its last reading, and resumes on unfold", async () => {
    const { rerender } = render(<AppResourceDisplay folded={false} peek={0} />);
    await flush();
    expect(screen.getByText(/12/)).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("debug_app_resource_usage", { gpu: true });

    rerender(<AppResourceDisplay folded peek={0} />);
    const callsBeforeFold = invokeMock.mock.calls.length;
    await advance(60_000);
    expect(invokeMock).toHaveBeenCalledTimes(callsBeforeFold);
    // The cluster counts this member by its report; folding must not drop it.
    expect(useHeaderStatusStore.getState().reports.resources).toBeTruthy();

    invokeMock.mockClear();
    rerender(<AppResourceDisplay folded={false} peek={0} />);
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("debug_app_resource_usage", { gpu: true });
  });
});

describe("AppResourceDisplay cadence", () => {
  it("keeps focus transitions on cadence and widens while blurred", async () => {
    render(<AppResourceDisplay />);
    await flush();
    expect(RESOURCE_POLL_MS).toBe(5_000);
    await advance(1_000);
    act(() => usePowerStore.setState({ blurred: true }));
    act(() => usePowerStore.setState({ blurred: false }));
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await advance(4_000);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    act(() => usePowerStore.setState({ blurred: true }));
    await advance(14_999);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("pauses when hidden and catches up on show", async () => {
    render(<AppResourceDisplay />);
    await flush();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(60_000);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("waits for slow reads without overlapping on ticks or focus", async () => {
    let resolve!: (value: typeof usage) => void;
    invokeMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<AppResourceDisplay />);
    await advance(20_000);
    act(() => usePowerStore.setState({ blurred: true }));
    act(() => usePowerStore.setState({ blurred: false }));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(usage));
    await advance(4_999);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
