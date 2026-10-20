/**
 * `lib/usePoll` — the one quiesce-aware UI poll (performance plan §3.3).
 *
 * What it promises: no run while the window is blurred/hidden, the pane is
 * hidden or the caller's gate is off; one immediate catch-up when the window
 * comes back after a run fell due; nothing after unmount/stop; never two runs
 * at once; Energy Saver widens rather than stops.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { useCallback } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { startPoll, usePoll } from "../../lib/usePoll";
import { usePowerStore } from "../../stores/power";
import { useSettingsStore } from "../../stores/settings";
import { PaneVisibleContext } from "../../components/embed/fileAccess";
import type { Settings } from "../../types";

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  usePowerStore.setState({ onBattery: false, blurred: false });
  useSettingsStore.setState({ settings: { energy_saver: "battery" } as unknown as Settings });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
});

const blur = () => usePowerStore.setState({ blurred: true });
const focus = () => {
  usePowerStore.setState({ blurred: false });
  window.dispatchEvent(new Event("focus"));
};

describe("startPoll", () => {
  it("runs at once, then every interval", async () => {
    const run = vi.fn();
    const poll = startPoll(run, 1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(4);
    poll.stop();
  });

  it("immediate: false waits one interval for the first run", async () => {
    const run = vi.fn();
    const poll = startPoll(run, 1000, { immediate: false });
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it("makes no call while the window is blurred, and one catch-up on focus", async () => {
    const run = vi.fn();
    const poll = startPoll(run, 1000);
    expect(run).toHaveBeenCalledTimes(1);
    blur();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    focus();
    // The catch-up is synchronous with the return, and only one.
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    poll.stop();
  });

  it("a quick blur and return inside the interval keeps the cadence (no extra run)", async () => {
    const run = vi.fn();
    const poll = startPoll(run, 1000);
    await vi.advanceTimersByTimeAsync(300);
    blur();
    await vi.advanceTimersByTimeAsync(200);
    focus();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("catchUpAfterMs: 0 re-reads on every return to the window", async () => {
    const run = vi.fn();
    const poll = startPoll(run, 15_000, { catchUpAfterMs: 0 });
    await vi.advanceTimersByTimeAsync(10);
    window.dispatchEvent(new Event("focus"));
    expect(run).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("does not start in a hidden window; showing it runs the catch-up", async () => {
    visibility = "hidden";
    const run = vi.fn();
    const poll = startPoll(run, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(run).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it("quiesce: false keeps running while blurred", async () => {
    const run = vi.fn();
    const poll = startPoll(run, 1000, { quiesce: false });
    blur();
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(4);
    poll.stop();
  });

  it('onBlur: "widen" runs at the Energy Saver cadence while blurred, still pauses when hidden', async () => {
    const run = vi.fn();
    const poll = startPoll(run, 1000, { onBlur: "widen" });
    expect(run).toHaveBeenCalledTimes(1);
    blur();
    await vi.advanceTimersByTimeAsync(2999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    // Back in focus with a run due at the normal cadence: the catch-up, once.
    await vi.advanceTimersByTimeAsync(1500);
    focus();
    expect(run).toHaveBeenCalledTimes(3);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(3);
    poll.stop();
  });

  it("never overlaps: a slow run delays the next until it settles", async () => {
    let resolve: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const poll = startPoll(run, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    // A focus while it is in flight starts nothing either.
    window.dispatchEvent(new Event("focus"));
    expect(run).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    // The ticks it covered are skipped, not made up back to back: the next
    // run is on the cadence (t = 6 s), then the one after.
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
    resolve();
    poll.stop();
  });

  it("a rejected or throwing run keeps the poll going", async () => {
    const run = vi.fn()
      .mockImplementationOnce(() => { throw new Error("boom"); })
      .mockImplementationOnce(() => Promise.reject(new Error("nope")))
      .mockImplementation(() => undefined);
    const poll = startPoll(run, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(3);
    poll.stop();
  });

  it("stop ends it, even with a run in flight", async () => {
    let resolve: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const poll = startPoll(run, 1000);
    poll.stop();
    resolve();
    await vi.advanceTimersByTimeAsync(5000);
    focus();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("tells a run that lands after stop that it is stale", async () => {
    let resolve: () => void = () => {};
    const seen: boolean[] = [];
    const poll = startPoll(async (p) => {
      await new Promise<void>((r) => { resolve = r; });
      seen.push(p.stopped);
    }, 1000);
    poll.stop();
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([true]);
  });

  it("Energy Saver widens the interval ×3 instead of stopping", async () => {
    useSettingsStore.setState({ settings: { energy_saver: "always" } as unknown as Settings });
    const run = vi.fn();
    const poll = startPoll(run, 1000);
    await vi.advanceTimersByTimeAsync(2999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    // Turning it off re-times from the last run.
    useSettingsStore.setState({ settings: { energy_saver: "off" } as unknown as Settings });
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
    poll.stop();
  });

  it("setIntervalMs re-times from the last run", async () => {
    const run = vi.fn();
    const poll = startPoll(run, 10_000);
    await vi.advanceTimersByTimeAsync(2000);
    poll.setIntervalMs(1000);
    // On the new cadence counted from the last run (t = 0): next at t = 3 s.
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("lastRunAt: a reading taken elsewhere pushes the catch-up and the next tick", async () => {
    let elsewhere = 0;
    const run = vi.fn();
    const poll = startPoll(run, 20_000, { immediate: false, catchUpAfterMs: 5000, lastRunAt: () => elsewhere });
    blur();
    await vi.advanceTimersByTimeAsync(30_000);
    elsewhere = Date.now();
    await vi.advanceTimersByTimeAsync(2000);
    focus();
    expect(run).not.toHaveBeenCalled();
    blur();
    await vi.advanceTimersByTimeAsync(4000);
    focus();
    expect(run).toHaveBeenCalledTimes(1);
    poll.stop();
  });
});

function Poller({ run, ms, enabled }: { run: () => void; ms: number; enabled?: boolean }) {
  const stable = useCallback(() => run(), [run]);
  usePoll(stable, ms, { enabled });
  return null;
}

describe("usePoll", () => {
  it("runs while mounted and makes no call after unmount", async () => {
    const run = vi.fn();
    const view = render(<Poller run={run} ms={1000} />);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    view.unmount();
    await vi.advanceTimersByTimeAsync(5000);
    focus();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a hidden pane makes no call; showing it runs at once", async () => {
    const run = vi.fn();
    const view = render(
      <PaneVisibleContext.Provider value={false}>
        <Poller run={run} ms={1000} />
      </PaneVisibleContext.Provider>,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
    view.rerender(
      <PaneVisibleContext.Provider value={true}>
        <Poller run={run} ms={1000} />
      </PaneVisibleContext.Provider>,
    );
    expect(run).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("enabled: false makes no call; turning it on starts afresh", async () => {
    const run = vi.fn();
    const view = render(<Poller run={run} ms={1000} enabled={false} />);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
    view.rerender(<Poller run={run} ms={1000} enabled />);
    expect(run).toHaveBeenCalledTimes(1);
    view.rerender(<Poller run={run} ms={1000} enabled={false} />);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("a blurred window stops the hook's poll and focus catches up once", async () => {
    const run = vi.fn();
    const view = render(<Poller run={run} ms={1000} />);
    blur();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    focus();
    expect(run).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});
