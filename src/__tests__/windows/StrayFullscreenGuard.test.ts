/**
 * Native Wayland places a popout by fullscreening it on its screen from the
 * backend and leaving fullscreen once the compositor has placed it. The popout's
 * own stray-fullscreen guard (mount, settled resize, focus regain) used to clear
 * that fullscreen at once, so the compositor placed it by the pointer instead.
 * The guard must stay off there and keep running on X11 / Windows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setFullscreen = vi.fn(() => Promise.resolve());
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFullscreen }),
}));

type Handler = (ev: { payload: unknown }) => void;

function fakeWindow() {
  const resized = new Set<Handler>();
  const focus = new Set<Handler>();
  return {
    resized,
    focus,
    win: {
      onResized: (h: Handler) => {
        resized.add(h);
        return Promise.resolve(() => resized.delete(h));
      },
      onFocusChanged: (h: Handler) => {
        focus.add(h);
        return Promise.resolve(() => focus.delete(h));
      },
    },
  };
}

/** Let the capability probe and the listener registrations settle. */
async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

async function load(coordinates: boolean | "error") {
  vi.resetModules();
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "desktop_coordinates_supported"
      ? coordinates === "error"
        ? Promise.reject(new Error("unknown command"))
        : Promise.resolve(coordinates)
      : Promise.resolve(undefined),
  );
  return import("../../lib/window/strayFullscreen");
}

describe("the popout stray-fullscreen guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setFullscreen.mockClear();
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays off on native Wayland: no mount clear, no resize or focus listener", async () => {
    const { startStrayFullscreenGuard } = await load(false);
    const { win, resized, focus } = fakeWindow();
    const stop = startStrayFullscreenGuard(win as never);
    await settle();
    expect(setFullscreen).not.toHaveBeenCalled();
    expect(resized.size).toBe(0);
    expect(focus.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(setFullscreen).not.toHaveBeenCalled();
    stop();
  });

  it("stays off when the backend cannot say (an older build)", async () => {
    const { startStrayFullscreenGuard } = await load("error");
    const { win, resized } = fakeWindow();
    startStrayFullscreenGuard(win as never)();
    await settle();
    expect(setFullscreen).not.toHaveBeenCalled();
    expect(resized.size).toBe(0);
  });

  it("keeps the X11 / Windows rescue: clears at mount, after a settled resize, on focus", async () => {
    const { startStrayFullscreenGuard } = await load(true);
    const { win, resized, focus } = fakeWindow();
    const stop = startStrayFullscreenGuard(win as never);
    await settle();
    expect(setFullscreen).toHaveBeenCalledTimes(1);
    expect(setFullscreen).toHaveBeenLastCalledWith(false);

    for (const h of resized) h({ payload: { width: 3840, height: 2160 } });
    await vi.advanceTimersByTimeAsync(249);
    expect(setFullscreen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(setFullscreen).toHaveBeenCalledTimes(2);

    for (const h of focus) h({ payload: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(setFullscreen).toHaveBeenCalledTimes(3);

    stop();
    expect(resized.size).toBe(0);
    expect(focus.size).toBe(0);
  });

  it("a guard disposed before the probe answers never arms", async () => {
    const { startStrayFullscreenGuard } = await load(true);
    const { win, resized } = fakeWindow();
    startStrayFullscreenGuard(win as never)();
    await settle();
    expect(setFullscreen).not.toHaveBeenCalled();
    expect(resized.size).toBe(0);
  });
});

describe("sizeFillsScreen", () => {
  it("recognises a monitor-sized physical rect at any scale", async () => {
    const { sizeFillsScreen } = await load(true);
    expect(sizeFillsScreen({ w: 3840, h: 2160 }, 1, { w: 3840, h: 2160 })).toBe(true);
    expect(sizeFillsScreen({ w: 3840, h: 2160 }, 2, { w: 1920, h: 1080 })).toBe(true);
    expect(sizeFillsScreen({ w: 3840, h: 2160 }, 1.5, { w: 2560, h: 1440 })).toBe(true);
  });

  it("does not take an ordinary popout for one", async () => {
    const { sizeFillsScreen } = await load(true);
    expect(sizeFillsScreen({ w: 1800, h: 1200 }, 2, { w: 1920, h: 1080 })).toBe(false);
    expect(sizeFillsScreen({ w: 900, h: 640 }, 1, { w: 3840, h: 2160 })).toBe(false);
    expect(sizeFillsScreen({ w: 900, h: 640 }, 1, { w: 0, h: 0 })).toBe(false);
  });
});
