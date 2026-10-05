import { describe, expect, it } from "vitest";
import { nextWindowState, sameWindowState } from "../../lib/window/windowState";
import type { WindowState } from "../../types";

const floating: WindowState = { x: 2200, y: 100, w: 1400, h: 900, maximized: false };

describe("nextWindowState", () => {
  it("records a moved window's new rect", () => {
    expect(nextWindowState(floating, { x: 300, y: 50, w: 1400, h: 900 }, false)).toEqual({
      x: 300,
      y: 50,
      w: 1400,
      h: 900,
      maximized: false,
    });
  });

  it("skips the write when nothing actually moved", () => {
    // A drag emits a storm of events that mostly settle back on the same place;
    // each one would otherwise be a settings.json write.
    expect(nextWindowState(floating, { x: 2200, y: 100, w: 1400, h: 900 }, false)).toBeNull();
  });

  it("keeps the last floating rect when the window is maximized", () => {
    // THE subtle rule. While maximized the outer rect IS the monitor, so storing
    // it would leave the window with no known "normal" size — un-maximizing after
    // a restart would then appear to do nothing.
    const got = nextWindowState(floating, { x: 1920, y: 0, w: 1920, h: 1080 }, true);
    expect(got).toEqual({ ...floating, maximized: true });
  });

  it("records the maximized rect on first run, when there is no floating rect yet", () => {
    // Tabtivity opens maximized and the user may never un-maximize it. Storing nothing
    // would mean never learning which monitor it is on — the whole point of the
    // feature. The maximized rect is at least a correct monitor hint.
    const got = nextWindowState(undefined, { x: 1920, y: 0, w: 1920, h: 1080 }, true);
    expect(got).toEqual({ x: 1920, y: 0, w: 1920, h: 1080, maximized: true });
  });

  it("self-corrects to a real restore rect the first time the user un-maximizes", () => {
    const firstRun = nextWindowState(undefined, { x: 1920, y: 0, w: 1920, h: 1080 }, true)!;
    const restored = nextWindowState(firstRun, { x: 2100, y: 80, w: 1400, h: 900 }, false);
    expect(restored).toEqual({ x: 2100, y: 80, w: 1400, h: 900, maximized: false });
  });

  it("still flips the maximized flag even though the rect is held", () => {
    const got = nextWindowState({ ...floating, maximized: true }, { x: 0, y: 0, w: 1920, h: 1080 }, false);
    expect(got).toEqual({ x: 0, y: 0, w: 1920, h: 1080, maximized: false });
  });

  it("refuses a degenerate rect", () => {
    // Querying mid-map (or a minimized window on some WMs) reports 0x0; persisting
    // it would produce an invisible window next launch.
    expect(nextWindowState(undefined, { x: 0, y: 0, w: 0, h: 900 }, false)).toBeNull();
    expect(nextWindowState(undefined, { x: 0, y: 0, w: 1400, h: 0 }, false)).toBeNull();
  });
});

describe("sameWindowState", () => {
  it("compares every field, maximized included", () => {
    expect(sameWindowState(floating, { ...floating })).toBe(true);
    expect(sameWindowState(floating, { ...floating, maximized: true })).toBe(false);
    expect(sameWindowState(floating, { ...floating, x: 1 })).toBe(false);
  });
});
