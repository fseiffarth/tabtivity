/**
 * The load → migrate wiring in AppShell (tab cost plan step 3).
 *
 * `migrateExperimentalOnce` (`lib/experimental`) moves a profile onto explicit
 * experimental ticks, and it may only run against settings that actually
 * arrived: before `loadSettings()` resolves the store is empty, and a patch
 * computed from it would be a guess. These pin the one call site — it runs
 * after the load, never before, and under StrictMode's doubled effect it still
 * writes once. The migration itself is the real one; only the store is mocked.
 */
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

const shared = vi.hoisted(() => ({
  loads: [] as Array<() => void>,
  updateSettings: vi.fn<(patch: Record<string, unknown>) => Promise<void>>(),
  state: {} as {
    settings: Record<string, unknown> | null;
    loaded: boolean;
    load: () => Promise<void>;
    updateSettings: (patch: Record<string, unknown>) => Promise<void>;
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setFullscreen: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    onResized: vi.fn().mockResolvedValue(() => {}),
    onScaleChanged: vi.fn().mockResolvedValue(() => {}),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../../stores/projects", () => {
  const state = {
    load: vi.fn(),
    loaded: true,
    activeId: null,
    switchToast: null,
    clearSwitchToast: vi.fn(),
    projects: [],
  };
  return {
    useProjectsStore: Object.assign(
      vi.fn((sel: (s: object) => unknown) => sel(state)),
      { getState: () => state },
    ),
    listenProjectRuntimeSwitched: vi.fn().mockResolvedValue(() => {}),
  };
});
vi.mock("../../stores/settings", () => {
  // Each `load()` stays pending until the test resolves it, and then lands a
  // fresh, unmarked Debug-mode snapshot — what `get_settings` returns for a
  // profile that predates the marker (a StrictMode second load included).
  const state = shared.state;
  state.settings = null;
  state.loaded = false;
  state.load = () =>
    new Promise<void>((resolve) => {
      shared.loads.push(() => {
        state.settings = { debug: true };
        state.loaded = true;
        resolve();
      });
    });
  state.updateSettings = (patch) => shared.updateSettings(patch);
  return {
    useSettingsStore: Object.assign(
      vi.fn((sel: (s: object) => unknown) => sel(state)),
      { getState: () => state, subscribe: () => () => {} },
    ),
    whenSettingsLoaded: () => Promise.resolve(),
    listenSettingsChanged: () => Promise.resolve(() => {}),
  };
});
vi.mock("../../stores/boxes", () => ({
  useBoxesStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ load: vi.fn().mockResolvedValue(undefined) }),
  ),
  BOX_SCOPE_PREFIX: "box:",
  boxMembersOfScope: () => [],
}));
vi.mock("../../stores/timer", () => ({
  useTimerStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ init: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined) }),
  ),
}));

vi.mock("../../components/layout/HeaderBar", () => ({ HeaderBar: () => null }));
vi.mock("../../components/layout/CenterPanel", () => ({ CenterPanel: () => null }));
vi.mock("../../components/layout/ProjectSwitcher", () => ({ ProjectSwitcher: () => null }));
vi.mock("../../components/layout/SidePanel", () => ({ SidePanel: () => null }));
vi.mock("../../hooks/useKeyboard", () => ({ useKeyboard: vi.fn() }));

import { AppShell } from "../../components/layout/AppShell";

/** Let the `.then` chains after a resolved load run. */
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

describe("AppShell load → experimental migration", () => {
  beforeEach(() => {
    shared.loads.length = 0;
    shared.state.settings = null;
    shared.state.loaded = false;
    shared.updateSettings.mockReset().mockResolvedValue(undefined);
  });

  it("migrates once, only after settings have loaded", async () => {
    render(<AppShell />);
    await settle();
    expect(shared.loads).toHaveLength(1);
    // Nothing is written while the load is still in flight.
    expect(shared.updateSettings).not.toHaveBeenCalled();

    shared.loads[0]();
    await settle();
    expect(shared.updateSettings).toHaveBeenCalledOnce();
    const patch = shared.updateSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.experimental_explicit).toBe(true);
    expect(patch.web_browser).toBe(true);
    expect(patch).not.toHaveProperty("terminal_webgl");
  });

  it("writes once under StrictMode's doubled load effect", async () => {
    // The write stays in flight while the second (stale, unmarked) load lands,
    // which is the window the in-flight guard has to cover.
    let finish!: () => void;
    shared.updateSettings.mockImplementation(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    render(
      <StrictMode>
        <AppShell />
      </StrictMode>,
    );
    await settle();
    expect(shared.loads).toHaveLength(2);
    expect(shared.updateSettings).not.toHaveBeenCalled();

    shared.loads[0]();
    await settle();
    shared.loads[1]();
    await settle();
    expect(shared.updateSettings).toHaveBeenCalledOnce();
    finish();
    await settle();
    expect(shared.updateSettings).toHaveBeenCalledOnce();
  });
});
