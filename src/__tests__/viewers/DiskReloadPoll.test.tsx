/**
 * `lib/useDiskReloadPoll` — the file viewers' one mtime poll (screen
 * 2026-10-15, M7), replacing eight hand-copied `setInterval`s.
 *
 * What it promises: the baseline is seeded per file whether the pane is on
 * screen or not; a changed mtime (either direction) calls `onChange` once and
 * moves the baseline; nothing runs while the pane is hidden, and re-showing
 * it checks at once; an unfocused window widens the cadence (×3) instead of
 * stopping it, a hidden window stops it; unmount stops it; `seed: false`
 * reports nothing until the caller recorded a baseline; `immediate: false`
 * waits one interval.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import { type ReactNode } from "react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import { DISK_RELOAD_POLL_MS, useDiskReloadPoll, type DiskReloadPollOptions } from "../../lib/useDiskReloadPoll";
import { PaneVisibleContext } from "../../components/embed/fileAccess";
import { usePowerStore } from "../../stores/power";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

let mtime = 100;
let visibility: DocumentVisibilityState = "visible";
const statCount = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === "file_mtime").length;

beforeEach(() => {
  vi.useFakeTimers();
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) =>
    cmd === "file_mtime" ? Promise.resolve(mtime) : Promise.resolve(null),
  );
  mtime = 100;
  usePowerStore.setState({ onBattery: false, blurred: false });
  useSettingsStore.setState({ settings: { energy_saver: "battery" } as unknown as Settings });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
});

function mount(onChange: (m: number) => void, options: DiskReloadPollOptions = {}, visible = true) {
  let paneVisible = visible;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PaneVisibleContext.Provider value={paneVisible}>{children}</PaneVisibleContext.Provider>
  );
  const hook = renderHook(
    (props: { options: DiskReloadPollOptions }) => useDiskReloadPoll("/p/a.txt", "proj", onChange, props.options),
    { wrapper, initialProps: { options } },
  );
  return {
    ...hook,
    setPaneVisible: (v: boolean) => {
      paneVisible = v;
      hook.rerender({ options });
    },
  };
}

/** Let the stat promises settle without moving the clock. */
const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});
const tick = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

describe("useDiskReloadPoll", () => {
  it("reports a changed mtime once, and moves its baseline to it", async () => {
    const onChange = vi.fn();
    const { result, unmount } = mount(onChange);
    await settle();
    expect(result.current.current).toBe(100);
    await tick(DISK_RELOAD_POLL_MS * 2);
    expect(onChange).not.toHaveBeenCalled();

    mtime = 200;
    await tick(DISK_RELOAD_POLL_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(200);
    expect(result.current.current).toBe(200);
    await tick(DISK_RELOAD_POLL_MS * 3);
    expect(onChange).toHaveBeenCalledTimes(1);

    // An older mtime (a pull that kept the host's) is a change too.
    mtime = 150;
    await tick(DISK_RELOAD_POLL_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("does not poll a hidden pane, seeds it anyway, and checks at once when shown", async () => {
    const onChange = vi.fn();
    const hook = mount(onChange, {}, false);
    await settle();
    // The seed only.
    expect(statCount()).toBe(1);
    expect(hook.result.current.current).toBe(100);
    mtime = 300;
    await tick(DISK_RELOAD_POLL_MS * 5);
    expect(statCount()).toBe(1);
    expect(onChange).not.toHaveBeenCalled();

    hook.setPaneVisible(true);
    await settle();
    expect(onChange).toHaveBeenCalledWith(300);
    hook.unmount();
  });

  it("widens rather than stops while the window is unfocused; a hidden window stops it", async () => {
    const onChange = vi.fn();
    const { unmount } = mount(onChange);
    await settle();
    const base = statCount();
    act(() => usePowerStore.setState({ blurred: true }));
    await tick(DISK_RELOAD_POLL_MS * 3);
    // One run per widened (×3) interval, not three.
    expect(statCount()).toBe(base + 1);

    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(DISK_RELOAD_POLL_MS * 10);
    expect(statCount()).toBe(base + 1);

    mtime = 400;
    visibility = "visible";
    act(() => {
      usePowerStore.setState({ blurred: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(onChange).toHaveBeenCalledWith(400);
    unmount();
  });

  it("stops on unmount", async () => {
    const onChange = vi.fn();
    const { unmount } = mount(onChange);
    await settle();
    unmount();
    const base = statCount();
    mtime = 500;
    await tick(DISK_RELOAD_POLL_MS * 5);
    expect(statCount()).toBe(base);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops while the caller's gate is off", async () => {
    const onChange = vi.fn();
    const { rerender, unmount } = mount(onChange, { enabled: false });
    await settle();
    expect(statCount()).toBe(1); // the seed
    mtime = 600;
    await tick(DISK_RELOAD_POLL_MS * 4);
    expect(statCount()).toBe(1);
    rerender({ options: { enabled: true } });
    await settle();
    expect(onChange).toHaveBeenCalledWith(600);
    unmount();
  });

  it("seed: false reports nothing until the caller records a baseline", async () => {
    const onChange = vi.fn();
    const { result, unmount } = mount(onChange, { seed: false });
    await settle();
    expect(result.current.current).toBeNull();
    mtime = 700;
    await tick(DISK_RELOAD_POLL_MS * 3);
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.current).toBeNull();

    result.current.current = 700; // the caller's own read
    mtime = 800;
    await tick(DISK_RELOAD_POLL_MS);
    expect(onChange).toHaveBeenCalledWith(800);
    unmount();
  });

  it("a caller-owned baseline is the one compared and moved", async () => {
    const onChange = vi.fn();
    const baseline = { current: 50 as number | null };
    const { unmount } = mount(onChange, { baseline, seed: false });
    await settle();
    expect(onChange).toHaveBeenCalledWith(100);
    expect(baseline.current).toBe(100);
    unmount();
  });

  it("immediate: false waits one interval for the first stat", async () => {
    const onChange = vi.fn();
    const { unmount } = mount(onChange, { seed: false, immediate: false });
    await settle();
    expect(statCount()).toBe(0);
    await tick(DISK_RELOAD_POLL_MS);
    expect(statCount()).toBe(1);
    unmount();
  });

  it("a new onChange closure does not restart the poll", async () => {
    let calls = 0;
    function Probe({ n }: { n: number }) {
      useDiskReloadPoll("/p/a.txt", "proj", () => {
        calls += n;
      });
      return null;
    }
    const { rerender, unmount } = render(<Probe n={1} />);
    await settle();
    const base = statCount();
    rerender(<Probe n={10} />);
    await settle();
    expect(statCount()).toBe(base);
    mtime = 900;
    await tick(DISK_RELOAD_POLL_MS);
    // The latest closure ran.
    expect(calls).toBe(10);
    unmount();
  });
});
