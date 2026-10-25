// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVisiblePoll, useVisiblePoll } from "../../../mobile-web/src/visiblePoll";

let state: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState) {
  state = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  state = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startVisiblePoll", () => {
  it("runs at once, then every interval, and not at all after stop", () => {
    const run = vi.fn();
    const poll = startVisiblePoll(run, 1000);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2500);
    expect(run).toHaveBeenCalledTimes(3);
    poll.stop();
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("skips a tick while the page is hidden and catches up when it is shown again", () => {
    const run = vi.fn();
    const poll = startVisiblePoll(run, 1000);
    setVisibility("hidden");
    vi.advanceTimersByTime(3000);
    expect(run).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(run).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("honours immediate: false and catchUp: false", () => {
    const run = vi.fn();
    const poll = startVisiblePoll(run, 1000, { immediate: false, catchUp: false });
    expect(run).not.toHaveBeenCalled();
    setVisibility("hidden");
    setVisibility("visible");
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it("aborts a run still in flight when the next one starts, and when stopped", () => {
    const signals: AbortSignal[] = [];
    const poll = startVisiblePoll((signal) => { signals.push(signal); return new Promise(() => {}); }, 1000);
    vi.advanceTimersByTime(1000);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    poll.stop();
    expect(signals[1].aborted).toBe(true);
  });

  it("swallows a rejected or throwing run and keeps polling", async () => {
    let calls = 0;
    const poll = startVisiblePoll(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("offline"));
      throw new Error("boom");
    }, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(3);
    poll.stop();
  });

  it("now() reads at once, but not while hidden", () => {
    const run = vi.fn();
    const poll = startVisiblePoll(run, 60_000, { immediate: false });
    poll.now();
    expect(run).toHaveBeenCalledTimes(1);
    state = "hidden";
    poll.now();
    expect(run).toHaveBeenCalledTimes(1);
    poll.stop();
  });
});

describe("useVisiblePoll", () => {
  it("polls only while enabled and reads the latest closure", () => {
    const seen: number[] = [];
    const { rerender, unmount } = renderHook(
      ({ value, enabled }) => useVisiblePoll(() => { seen.push(value); }, 1000, { enabled }),
      { initialProps: { value: 1, enabled: false } },
    );
    vi.advanceTimersByTime(3000);
    expect(seen).toEqual([]);
    rerender({ value: 2, enabled: true });
    expect(seen).toEqual([2]);
    rerender({ value: 3, enabled: true });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(seen).toEqual([2, 3]);
    unmount();
    vi.advanceTimersByTime(3000);
    expect(seen).toEqual([2, 3]);
  });

  it("restarts when a dep changes and returns a read-now", () => {
    const run = vi.fn();
    const { result, rerender } = renderHook(({ key }) => useVisiblePoll(run, 60_000, {}, [key]), { initialProps: { key: "a" } });
    expect(run).toHaveBeenCalledTimes(1);
    rerender({ key: "b" });
    expect(run).toHaveBeenCalledTimes(2);
    act(() => result.current());
    expect(run).toHaveBeenCalledTimes(3);
  });
});
