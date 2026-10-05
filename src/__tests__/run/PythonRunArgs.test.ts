/**
 * Python Run/Debug arguments (#py) are kept PER FILE — keyed by absolute path in
 * global settings — not per tab, so every viewer of the same script shares one
 * set of args and they survive a Tabtivity restart (settings.json). These tests
 * lock the store action that owns that map: set, share-by-path, and clear-prunes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { useSettingsStore } from "../../stores/settings";

const invokeMock = vi.mocked(invoke);

function reset() {
  invokeMock.mockClear();
  useSettingsStore.setState({ settings: {}, loaded: true });
}

describe("setPythonRunArgs (per-file run args)", () => {
  beforeEach(reset);

  it("stores args keyed by the file's absolute path", async () => {
    await useSettingsStore.getState().setPythonRunArgs("/p/main.py", "--epochs 5 data.csv");
    expect(useSettingsStore.getState().settings?.python_run_args).toEqual({
      "/p/main.py": "--epochs 5 data.csv",
    });
    // Persisted through the ordinary settings write (settings.json, round-tripped
    // via the backend's `extra` catch-all — no bespoke command).
    const saved = invokeMock.mock.calls.find((c) => c[0] === "save_settings");
    expect(saved).toBeTruthy();
  });

  it("trims and keeps distinct files independent (shared only within one path)", async () => {
    await useSettingsStore.getState().setPythonRunArgs("/p/a.py", "  --x 1  ");
    await useSettingsStore.getState().setPythonRunArgs("/p/b.py", "--y 2");
    expect(useSettingsStore.getState().settings?.python_run_args).toEqual({
      "/p/a.py": "--x 1",
      "/p/b.py": "--y 2",
    });
  });

  it("clears an entry (empty string) by pruning it, not storing ''", async () => {
    await useSettingsStore.getState().setPythonRunArgs("/p/main.py", "--epochs 5");
    await useSettingsStore.getState().setPythonRunArgs("/p/main.py", "");
    expect(useSettingsStore.getState().settings?.python_run_args).toEqual({});
  });

  it("is a no-op when the args are unchanged (no redundant settings write)", async () => {
    await useSettingsStore.getState().setPythonRunArgs("/p/main.py", "--epochs 5");
    invokeMock.mockClear();
    await useSettingsStore.getState().setPythonRunArgs("/p/main.py", "--epochs 5");
    expect(invokeMock.mock.calls.some((c) => c[0] === "save_settings")).toBe(false);
  });
});
