/**
 * `lib/coalescedRun` (perf plan §3.4): a burst of `fs-change` triggers runs
 * the refresh once per window, a steady stream still runs every window, and a
 * trigger during a run becomes one follow-up instead of a second concurrent run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coalescedRun } from "../../lib/coalescedRun";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("coalescedRun", () => {
  it("runs a burst once, after the window", async () => {
    const run = vi.fn();
    const c = coalescedRun(run, 1_000);
    for (let i = 0; i < 20; i += 1) c.request();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps running once a window under a steady stream (a debounce never would)", async () => {
    const run = vi.fn();
    const c = coalescedRun(run, 1_000);
    for (let t = 0; t < 5_000; t += 300) {
      c.request();
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(run.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("never overlaps runs: a trigger during one becomes a single follow-up", async () => {
    let finish: () => void = () => {};
    let running = 0;
    let maxRunning = 0;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          finish = () => {
            running -= 1;
            resolve();
          };
        }),
    );
    const c = coalescedRun(run, 1_000);
    c.request();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    c.request();
    c.request();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
  });

  it("survives a failing run and stops for good on cancel", async () => {
    const run = vi.fn(() => Promise.reject(new Error("git refused")));
    const c = coalescedRun(run, 100);
    c.request();
    await vi.advanceTimersByTimeAsync(100);
    c.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    c.request();
    c.cancel();
    c.request();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
