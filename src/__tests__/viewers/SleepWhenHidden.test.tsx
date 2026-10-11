/**
 * The sleep/wake seam (`lib/sleepWhenHidden.ts`, performance plan §4.3): a pane
 * sleeps after `afterMs` hidden, a hold cancels the countdown and restarts it
 * when lifted, and showing the pane wakes it in the same render.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSleepWhenHidden } from "../../lib/sleepWhenHidden";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useSleepWhenHidden", () => {
  it("sleeps after the window and wakes in the render that shows it", () => {
    const hook = renderHook(
      ({ hidden }: { hidden: boolean }) => useSleepWhenHidden({ hidden, afterMs: 1000 }),
      { initialProps: { hidden: false } },
    );
    expect(hook.result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    hook.rerender({ hidden: true });
    act(() => vi.advanceTimersByTime(999));
    expect(hook.result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current).toBe(true);
    hook.rerender({ hidden: false });
    expect(hook.result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is held off by a hold and starts over when the hold lifts", () => {
    const hook = renderHook(
      ({ hold }: { hold: boolean }) => useSleepWhenHidden({ hidden: true, afterMs: 1000, hold }),
      { initialProps: { hold: false } },
    );
    act(() => vi.advanceTimersByTime(900));
    hook.rerender({ hold: true });
    act(() => vi.advanceTimersByTime(5000));
    expect(hook.result.current).toBe(false);
    hook.rerender({ hold: false });
    act(() => vi.advanceTimersByTime(999));
    expect(hook.result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current).toBe(true);
  });

  it("stays asleep when a hold is raised after the fact", () => {
    const hook = renderHook(
      ({ hold }: { hold: boolean }) => useSleepWhenHidden({ hidden: true, afterMs: 1000, hold }),
      { initialProps: { hold: false } },
    );
    act(() => vi.advanceTimersByTime(1000));
    expect(hook.result.current).toBe(true);
    hook.rerender({ hold: true });
    expect(hook.result.current).toBe(true);
  });
});
