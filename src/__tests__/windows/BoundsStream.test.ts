/**
 * The popout's streamed geometry (`DETACHED_BOUNDS`). On native Wayland the
 * backend holds a popout fullscreen while it places it; that hold's resize
 * events carry the monitor's rect and must not reach the saved size.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

type Moved = (ev: { payload: { x: number; y: number } }) => void;
type Resized = (ev: { payload: { width: number; height: number } }) => void;

function fakeWindow(inner = { width: 900, height: 640 }) {
  let moved: Moved | undefined;
  let resized: Resized | undefined;
  return {
    resize: (width: number, height: number) => resized?.({ payload: { width, height } }),
    move: (x: number, y: number) => moved?.({ payload: { x, y } }),
    win: {
      innerSize: () => Promise.resolve(inner),
      isVisible: () => Promise.resolve(true),
      isMinimized: () => Promise.resolve(false),
      onMoved: (h: Moved) => {
        moved = h;
        return Promise.resolve(() => {});
      },
      onResized: (h: Resized) => {
        resized = h;
        return Promise.resolve(() => {});
      },
    },
  };
}

async function load(coordinates: boolean) {
  vi.resetModules();
  invokeMock.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "desktop_coordinates_supported" ? coordinates : false),
  );
  return import("../../lib/window/boundsStream");
}

describe("startBoundsStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    Object.defineProperty(window, "screen", { value: { width: 3840, height: 2160 }, configurable: true });
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams an ordinary resize", async () => {
    const { startBoundsStream } = await load(true);
    const emitted: unknown[] = [];
    const f = fakeWindow();
    startBoundsStream(f.win as never, (b) => emitted.push(b));
    await vi.advanceTimersByTimeAsync(0);
    f.move(10, 20);
    f.resize(1000, 700);
    await vi.advanceTimersByTimeAsync(400);
    expect(emitted).toEqual([{ x: 10, y: 20, w: 1000, h: 700 }]);
  });

  it("native Wayland: a monitor-sized rect from the placement hold is not streamed", async () => {
    const { startBoundsStream } = await load(false);
    const emitted: unknown[] = [];
    const f = fakeWindow();
    startBoundsStream(f.win as never, (b) => emitted.push(b));
    await vi.advanceTimersByTimeAsync(0);
    f.move(0, 0);
    f.resize(3840, 2160);
    await vi.advanceTimersByTimeAsync(400);
    expect(emitted).toEqual([]);
    // ...and the restore resize that ends the hold is.
    f.resize(1000, 700);
    await vi.advanceTimersByTimeAsync(400);
    expect(emitted).toEqual([{ x: 0, y: 0, w: 1000, h: 700 }]);
  });

  it("elsewhere a monitor-sized rect still streams (maximized popouts keep their size)", async () => {
    const { startBoundsStream } = await load(true);
    const emitted: unknown[] = [];
    const f = fakeWindow();
    startBoundsStream(f.win as never, (b) => emitted.push(b));
    await vi.advanceTimersByTimeAsync(0);
    f.move(0, 0);
    f.resize(3840, 2160);
    await vi.advanceTimersByTimeAsync(400);
    expect(emitted).toEqual([{ x: 0, y: 0, w: 3840, h: 2160 }]);
  });
});
