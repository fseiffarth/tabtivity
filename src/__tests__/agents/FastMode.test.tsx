/**
 * Fast mode (`lib/agents/fastMode`).
 *
 * Three things are worth locking in, and each has a plausible-looking wrong
 * version:
 *
 *  1. **It is never inferred.** Unset is off and `false` is off. A `??`-shaped
 *     default anywhere in the resolver would turn "not chosen" into a mode that
 *     silently removes features from an install that never asked for it — the
 *     inverse of the `time_format_24h` trap, where unset genuinely does mean
 *     "derive it".
 *  2. **A withdrawal is a real withdrawal.** The point is the work not done, so
 *     hiding a readout while its timer keeps polling would be the one outcome
 *     that looks right and buys nothing.
 *  3. **It comes back.** Turning it off restores the surface in place, with no
 *     relaunch and no remount — which is what makes it safe to try.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { applyFastModeAttribute, fastModeActive } from "../../lib/agents/fastMode";
import { useSettingsStore } from "../../stores/settings";
import { usePowerStore } from "../../stores/power";
import { AppResourceDisplay } from "../../components/header/AppResourceDisplay";
import type { Settings } from "../../types";

const invokeMock = vi.mocked(invoke);

/** Seed the settings store directly — `load` would go through the backend. */
function setSettings(patch: Partial<Settings>) {
  act(() => {
    useSettingsStore.setState({ settings: patch as Settings, loaded: true });
  });
}

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
  applyFastModeAttribute(false);
  usePowerStore.setState({ onBattery: false, blurred: false });
  setSettings({});
});

afterEach(() => {
  applyFastModeAttribute(false);
});

describe("the fast-mode gate", () => {
  it("is off when the key is unset — the mode is never inferred", () => {
    setSettings({});
    expect(fastModeActive()).toBe(false);
  });

  it("is off for an explicit false", () => {
    setSettings({ fast_mode: false });
    expect(fastModeActive()).toBe(false);
  });

  it("is on only for an explicit true", () => {
    setSettings({ fast_mode: true });
    expect(fastModeActive()).toBe(true);
  });

  it("is off while settings have not loaded at all", () => {
    act(() => {
      useSettingsStore.setState({ settings: null, loaded: false });
    });
    // A launch must not flicker through a withdrawn interface on its way to a
    // loaded store — the failure `whenSettingsLoaded` exists for, inverted.
    expect(fastModeActive()).toBe(false);
  });
});

describe("the document attribute", () => {
  it("publishes and withdraws `data-fast-mode`", () => {
    applyFastModeAttribute(true);
    expect(document.documentElement.dataset.fastMode).toBe("on");
    applyFastModeAttribute(false);
    expect(document.documentElement.dataset.fastMode).toBeUndefined();
  });
});

describe("a withdrawn surface (the header resource readout)", () => {
  it("renders its figures and polls for them when fast mode is off", async () => {
    setSettings({ fast_mode: false });
    render(<AppResourceDisplay />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("debug_app_resource_usage", { gpu: true });
    });
    await screen.findByText(/12/);
  });

  it("asks for no GPU reading while the GPU row is hidden", async () => {
    // The backend skips its Ollama/GPU reads on `gpu: false`; a readout that
    // never shows the row must not pay for them every 2.5 s.
    setSettings({ fast_mode: false, show_gpu_usage: false });
    render(<AppResourceDisplay />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("debug_app_resource_usage", { gpu: false });
    });
  });

  it("renders nothing AND asks the backend nothing when fast mode is on", async () => {
    setSettings({ fast_mode: true });
    const { container } = render(<AppResourceDisplay />);
    // The cost is the poll, not the pixels: a version that merely hid the row
    // would pass an "is it visible" assertion and buy nothing at all.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it("comes back in place when fast mode is switched off", async () => {
    setSettings({ fast_mode: true });
    const { container } = render(<AppResourceDisplay />);
    expect(container.firstChild).toBeNull();

    setSettings({ fast_mode: false });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("debug_app_resource_usage", { gpu: true });
    });
    await screen.findByText(/12/);
  });
});
