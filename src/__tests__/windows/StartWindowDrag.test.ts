/**
 * The logo drag in the user's fullscreen mode: a fullscreen window is one the WM
 * refuses to move, so a press that has travelled leaves fullscreen first, puts
 * the restored window back under the pointer and only then hands the pointer to
 * the OS move loop. A bare press (the header's empty-bar drag) never leaves it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({
  startDragging: vi.fn(async () => {}),
  setFullscreen: vi.fn(async (_on: boolean) => {}),
  setPosition: vi.fn(async (_p: { x: number; y: number }) => {}),
  scaleFactor: vi.fn(async () => 2),
  innerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
  outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
  resizedTo: { width: 2800, height: 1800 } as { width: number; height: number } | null,
  onResized: vi.fn(),
}));
const platform = vi.hoisted(() => ({ value: "linux" }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
  cursorPosition: async () => ({ x: 1000, y: 40 }),
  PhysicalPosition: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
}));
vi.mock("../../lib/window/dragPlatform", () => ({
  get PLATFORM() {
    return platform.value;
  },
}));
vi.mock("../../stores/drag/windowMove", () => ({ trackWindowMove: vi.fn() }));

import { startWindowDrag } from "../../lib/window/startWindowDrag";
import { useFullscreenMode } from "../../lib/window/fullscreenMode";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("startWindowDrag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.value = "linux";
    win.resizedTo = { width: 2800, height: 1800 };
    win.onResized.mockImplementation(
      async (cb: (e: { payload: { width: number; height: number } }) => void) => {
        if (win.resizedTo) {
          const payload = win.resizedTo;
          setTimeout(() => cb({ payload }), 0);
        }
        return () => {};
      },
    );
    useFullscreenMode.setState({ on: false });
    Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
  });

  it("moves a windowed window straight away", () => {
    startWindowDrag({ x: 30, y: 10 });
    expect(win.setFullscreen).not.toHaveBeenCalled();
    expect(win.startDragging).toHaveBeenCalledTimes(1);
  });

  it("a travelled press in fullscreen mode leaves it, re-centres the grab and then moves", async () => {
    useFullscreenMode.setState({ on: true });
    startWindowDrag({ x: 30, y: 10 });
    expect(win.startDragging).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) await settle();
    expect(win.setFullscreen).toHaveBeenCalledWith(false);
    expect(useFullscreenMode.getState().on).toBe(false);
    // Cursor (1000, 40) minus the grab point at scale 2.
    expect(win.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 940, y: 20 }));
    expect(win.startDragging).toHaveBeenCalledTimes(1);
    expect(win.setPosition.mock.invocationCallOrder[0]).toBeLessThan(
      win.startDragging.mock.invocationCallOrder[0],
    );
  });

  it("a grab point past the restored width keeps its fraction of the width", async () => {
    useFullscreenMode.setState({ on: true });
    // 2800 physical px at scale 2 = 1400 CSS px restored, from 1920 fullscreen.
    startWindowDrag({ x: 1600, y: 10 });
    for (let i = 0; i < 5; i++) await settle();
    const x = Math.round(1000 - ((1600 * 1400) / 1920) * 2);
    expect(win.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x }));
  });

  it("a release during the exit starts no move", async () => {
    useFullscreenMode.setState({ on: true });
    startWindowDrag({ x: 30, y: 10 });
    window.dispatchEvent(new MouseEvent("mouseup"));
    for (let i = 0; i < 5; i++) await settle();
    expect(win.setFullscreen).toHaveBeenCalledWith(false);
    expect(win.startDragging).not.toHaveBeenCalled();
  });

  it("a bare press never leaves fullscreen mode", () => {
    useFullscreenMode.setState({ on: true });
    startWindowDrag();
    expect(win.setFullscreen).not.toHaveBeenCalled();
    expect(useFullscreenMode.getState().on).toBe(true);
  });

  it("macOS keeps its fullscreen Space", () => {
    platform.value = "macos";
    useFullscreenMode.setState({ on: true });
    startWindowDrag({ x: 30, y: 10 });
    expect(win.setFullscreen).not.toHaveBeenCalled();
  });

  it("a refused exit keeps the record and starts no move", async () => {
    useFullscreenMode.setState({ on: true });
    win.setFullscreen.mockRejectedValueOnce(new Error("no"));
    startWindowDrag({ x: 30, y: 10 });
    for (let i = 0; i < 5; i++) await settle();
    expect(useFullscreenMode.getState().on).toBe(true);
    expect(win.startDragging).not.toHaveBeenCalled();
  });
});
