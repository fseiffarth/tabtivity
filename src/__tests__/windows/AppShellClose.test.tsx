/**
 * Tests that the AppShell onCloseRequested handler:
 *  1. Prevents the default OS close
 *  2. Flushes the timer
 *  3. Calls win.destroy() to actually close the window
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

// vi.hoisted runs before vi.mock factories, so the shared state is ready when factories execute.
const shared = vi.hoisted(() => ({
  flush: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>,
  destroy: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>,
  handler: null as ((e: { preventDefault: () => void }) => Promise<void>) | null,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setFullscreen: vi.fn().mockResolvedValue(undefined),
    destroy: shared.destroy,
    onCloseRequested: vi.fn().mockImplementation(async (h) => {
      shared.handler = h;
      return () => {};
    }),
    // AppShell installs a WebKitGTK onResized→DOM-resize bridge; the mock must
    // provide it (returns an unlisten) or the effect throws at mount.
    onResized: vi.fn().mockResolvedValue(() => {}),
    onScaleChanged: vi.fn().mockResolvedValue(() => {}),
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn().mockResolvedValue(undefined) }));

// Paths below are relative to this test file (src/__tests__/), matching the
// resolved module IDs that AppShell uses (src/stores/ and src/components/layout/).
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
    // The close handler reads the store imperatively (getState) to flush the
    // active scope's tab layout, so the mock must carry it alongside the hook.
    useProjectsStore: Object.assign(
      vi.fn((sel: (s: object) => unknown) => sel(state)),
      { getState: () => state },
    ),
    // AppShell subscribes to runtime-switch events on mount; provide a no-op.
    listenProjectRuntimeSwitched: vi.fn().mockResolvedValue(() => {}),
  };
});
vi.mock("../../stores/settings", () => {
  // The auto-reconnect sweep reads settings imperatively (getState) to skip
  // HPC-tagged machines, so the mock must carry getState alongside the hook.
  // It also awaits whenSettingsLoaded before the machine sweep; the mock store
  // never loads, so resolve that immediately and let the `machines_enabled`
  // gate stop the sweep — an unmocked export throws out of an unawaited
  // promise, i.e. an unhandled error this test can neither see nor catch.
  // `loaded` stays false on purpose: the other launch-time hosts (the stats
  // recap) gate on it, and flipping it would run them against this same
  // deliberately-minimal mock.
  // `subscribe` is here for the experimental-tab sweep, which re-runs whenever
  // settings change (a flag can go off without the Settings panel being open).
  // With `settings: null` it withdraws nothing, so the no-op unsubscribe is all
  // this test needs from it.
  const state = { load: vi.fn(), settings: null, loaded: false };
  return {
    useSettingsStore: Object.assign(
      vi.fn((sel: (s: object) => unknown) => sel(state)),
      { getState: () => state, subscribe: () => () => {} },
    ),
    whenSettingsLoaded: () => Promise.resolve(),
    // Group B #226: the shell subscribes every window's settings store to
    // writes made in any window. Nothing is written here, so a no-op unlisten
    // is all this test needs.
    listenSettingsChanged: () => Promise.resolve(() => {}),
  };
});
// AppShell loads boxes once projects are loaded; provide a no-op so the effect
// doesn't reach into the (mocked) projects store's setState.
vi.mock("../../stores/boxes", () => ({
  useBoxesStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ load: vi.fn().mockResolvedValue(undefined) }),
  ),
  BOX_SCOPE_PREFIX: "box:",
  // The app overlays' docked-agent hook reads the root "+" menu's data.
  boxMembersOfScope: () => [],
}));
vi.mock("../../stores/timer", () => ({
  useTimerStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ init: vi.fn().mockResolvedValue(undefined), flush: shared.flush }),
  ),
}));

// Stub heavy child components to avoid bootstrapping terminals / xterm / etc.
vi.mock("../../components/layout/HeaderBar", () => ({ HeaderBar: () => null }));
vi.mock("../../components/layout/CenterPanel", () => ({ CenterPanel: () => null }));
vi.mock("../../components/layout/ProjectSwitcher", () => ({ ProjectSwitcher: () => null }));
vi.mock("../../components/layout/SidePanel", () => ({ SidePanel: () => null }));
vi.mock("../../hooks/useKeyboard", () => ({ useKeyboard: vi.fn() }));

import { AppShell } from "../../components/layout/AppShell";
import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";

describe("AppShell close handler", () => {
  beforeEach(() => {
    shared.flush.mockClear();
    shared.destroy.mockClear();
    shared.handler = null;
    (invoke as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null);
    (message as ReturnType<typeof vi.fn>).mockClear();
  });

  it("prevents default, flushes timer, then destroys the window", async () => {
    render(<AppShell />);

    expect(shared.handler, "onCloseRequested handler should be registered").not.toBeNull();

    const preventDefault = vi.fn();
    await act(async () => {
      await shared.handler!({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(shared.flush).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("local_tmux_kill_app_sessions");
    expect(shared.destroy).toHaveBeenCalledOnce();
  });

  it("still destroys the window even when timer flush rejects", async () => {
    shared.flush.mockRejectedValueOnce(new Error("flush failed"));

    render(<AppShell />);

    expect(shared.handler).not.toBeNull();

    await act(async () => {
      await shared.handler!({ preventDefault: vi.fn() });
    });

    expect(shared.destroy).toHaveBeenCalledOnce();
  });

  it("warns but still destroys the window when the VPN teardown is declined", async () => {
    // A dismissed pkexec prompt makes `openvpn_disconnect_all_on_quit` reject —
    // the quit must warn, not abort (the backend already recorded the decline so
    // RunEvent::Exit won't re-prompt with the window gone).
    (invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) =>
      cmd === "openvpn_disconnect_all_on_quit"
        ? Promise.reject(new Error("openvpn teardown was not authorized"))
        : Promise.resolve(null),
    );

    render(<AppShell />);
    expect(shared.handler).not.toBeNull();

    await act(async () => {
      await shared.handler!({ preventDefault: vi.fn() });
    });

    expect(message).toHaveBeenCalledOnce();
    expect(shared.destroy).toHaveBeenCalledOnce();
  });
});
