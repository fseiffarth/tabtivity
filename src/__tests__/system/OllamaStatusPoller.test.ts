/**
 * The shared Ollama status poller (`lib/ollamaStatus`).
 *
 * `ollama_status` is a `GET /api/ps` round trip that used to run on one timer
 * per subscriber — per editable viewer tab, so the request rate grew with the
 * number of open tabs. These pin the replacement's shape: one timer however
 * many subscribers, run at the shortest cadence asked for, gone when the last
 * subscriber leaves; a tick during an in-flight request is skipped, not
 * queued; and a late subscriber is seated from the last observation instead
 * of flashing `stopped`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { DEFAULT_INTERVAL_MS, resetOllamaStatusPoller, useOllamaStatus } from "../../lib/ollamaStatus";
import { usePowerStore } from "../../stores/power";

const flush = () => act(async () => {});
const tick = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue("idle");
  resetOllamaStatusPoller();
  usePowerStore.setState({ blurred: false });
});

afterEach(() => {
  resetOllamaStatusPoller();
  vi.useRealTimers();
});

describe("useOllamaStatus", () => {
  it("asks straight away on mount and reports what the backend said", async () => {
    invokeMock.mockResolvedValue("loaded");
    const { result } = renderHook(() => useOllamaStatus());
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("ollama_status");
    expect(result.current).toBe("loaded");
  });

  it("runs ONE timer for two subscribers", async () => {
    const a = renderHook(() => useOllamaStatus());
    const b = renderHook(() => useOllamaStatus());
    await flush();
    invokeMock.mockClear();

    await tick(DEFAULT_INTERVAL_MS);
    // One `/api/ps` per tick, not one per component.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
  });

  it("runs at the shortest interval any subscriber wants, and re-times when it leaves", async () => {
    const slow = renderHook(() => useOllamaStatus(true, 5000));
    const fast = renderHook(() => useOllamaStatus(true, 1000));
    await flush();
    invokeMock.mockClear();

    await tick(1000);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    fast.unmount();
    invokeMock.mockClear();
    await tick(1000);
    expect(invokeMock).not.toHaveBeenCalled();
    await tick(4000);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    slow.unmount();
  });

  it("skips ticks while a request is still in flight", async () => {
    invokeMock.mockReturnValue(new Promise(() => {})); // a wedged Ollama
    const { unmount } = renderHook(() => useOllamaStatus());
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await tick(DEFAULT_INTERVAL_MS * 3);
    // No backlog of retries builds up behind the stuck one.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("seats a late subscriber from the last observation instead of `stopped`", async () => {
    invokeMock.mockResolvedValue("loaded");
    const first = renderHook(() => useOllamaStatus());
    await flush();
    expect(first.result.current).toBe("loaded");

    // The second mount's own poll is skipped (the first's tick may be in flight)
    // or pending — either way its FIRST render must already say "loaded".
    invokeMock.mockReturnValue(new Promise(() => {}));
    const second = renderHook(() => useOllamaStatus());
    expect(second.result.current).toBe("loaded");
    first.unmount();
    second.unmount();
  });

  it("reports stopped, and polls nothing, while disabled", async () => {
    const { result, unmount } = renderHook(() => useOllamaStatus(false));
    await flush();
    await tick(DEFAULT_INTERVAL_MS * 2);
    expect(result.current).toBe("stopped");
    expect(invokeMock).not.toHaveBeenCalled();
    unmount();
  });

  it("stops the timer when the last subscriber leaves", async () => {
    const { unmount } = renderHook(() => useOllamaStatus());
    await flush();
    unmount();
    invokeMock.mockClear();
    await tick(DEFAULT_INTERVAL_MS * 10);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reads an unreachable backend as stopped", async () => {
    invokeMock.mockResolvedValue("loaded");
    const { result, unmount } = renderHook(() => useOllamaStatus());
    await flush();
    expect(result.current).toBe("loaded");
    invokeMock.mockRejectedValue(new Error("no backend"));
    await tick(DEFAULT_INTERVAL_MS);
    expect(result.current).toBe("stopped");
    unmount();
  });

  it("asks nothing while the window is blurred and catches up on return (perf plan §3.3)", async () => {
    const { unmount } = renderHook(() => useOllamaStatus());
    await flush();
    invokeMock.mockClear();
    act(() => usePowerStore.setState({ blurred: true }));
    await tick(DEFAULT_INTERVAL_MS * 4);
    expect(invokeMock).not.toHaveBeenCalled();
    act(() => usePowerStore.setState({ blurred: false }));
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    unmount();
  });
});
