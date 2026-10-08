/**
 * `stores/mobileHostStatus`: the header's Mobile indicator and every Files
 * view's phone toggle share ONE `mobile_host_status` poll (perf plan §3.3).
 * Two surfaces cost one read per tick, the poll stops with the last surface,
 * and a slow answer is never stacked under the next tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  MOBILE_HOST_POLL_MS,
  __resetMobileHostStatusForTests,
  useMobileHostStatus,
  useMobileHostStatusStore,
} from "../../stores/mobileHostStatus";

const invokeMock = vi.mocked(invoke);
const running = { configured: true, running: true, update_available: false };
const statusCalls = () => invokeMock.mock.calls.filter(([c]) => c === "mobile_host_status").length;

function Probe({ enabled = true }: { enabled?: boolean }) {
  const status = useMobileHostStatus(enabled);
  return <span>{status?.running ? "up" : "down"}</span>;
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetMobileHostStatusForTests();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(running));
});

afterEach(() => {
  cleanup();
  __resetMobileHostStatusForTests();
  vi.useRealTimers();
});

describe("shared Mobile host status poll", () => {
  it("reads once per tick however many surfaces watch", async () => {
    const view = render(
      <>
        <Probe />
        <Probe />
        <Probe />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusCalls()).toBe(1);
    expect(view.getAllByText("up")).toHaveLength(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOBILE_HOST_POLL_MS * 2);
    });
    // Two ticks, one read each — not one per surface (was 3 × 2).
    expect(statusCalls()).toBe(3);
  });

  it("stops polling when the last surface leaves, and forgets the reading", async () => {
    const view = render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useMobileHostStatusStore.getState().status?.running).toBe(true);
    view.unmount();
    expect(useMobileHostStatusStore.getState().status).toBeNull();
    const before = statusCalls();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOBILE_HOST_POLL_MS * 4);
    });
    window.dispatchEvent(new Event("focus"));
    expect(statusCalls()).toBe(before);
  });

  it("a disabled surface neither polls nor keeps the poll alive", async () => {
    render(<Probe enabled={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOBILE_HOST_POLL_MS * 2);
    });
    expect(statusCalls()).toBe(0);
  });

  it("does not stack a read on one still in flight", async () => {
    let answer: (v: typeof running) => void = () => {};
    invokeMock.mockImplementation(
      () => new Promise((resolve) => {
        answer = resolve as typeof answer;
      }),
    );
    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOBILE_HOST_POLL_MS * 3);
    });
    window.dispatchEvent(new Event("focus"));
    expect(statusCalls()).toBe(1);
    await act(async () => {
      answer(running);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useMobileHostStatusStore.getState().refreshing).toBe(false);
  });

  it("a surface that leaves and returns while a read is in flight gets a fresh read", async () => {
    // React StrictMode's mount → cleanup → mount, or a Files view toggling
    // `active` quickly: the first read is superseded by the last release, so
    // the returning surface must not sit on "no reading" for a whole poll.
    const answers: Array<(v: typeof running) => void> = [];
    invokeMock.mockImplementation(
      () => new Promise((resolve) => {
        answers.push(resolve as (v: typeof running) => void);
      }),
    );
    const first = render(<Probe />);
    first.unmount();
    const view = render(<Probe />);
    expect(statusCalls()).toBe(2);
    await act(async () => {
      answers.forEach((answer) => answer(running));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.getByText("up")).toBeTruthy();
    expect(useMobileHostStatusStore.getState().refreshing).toBe(false);
  });

  it("drops a read that was in flight when a restart began", async () => {
    const refused = { ...running, running: false, error: "refused" };
    let answer: (v: typeof refused) => void = () => {};
    invokeMock.mockImplementation(
      () => new Promise((resolve) => {
        answer = resolve as typeof answer;
      }),
    );
    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const store = useMobileHostStatusStore.getState();
    store.beginRestart();
    store.publish(running);
    await act(async () => {
      answer(refused);
      await vi.advanceTimersByTimeAsync(0);
    });
    store.endRestart();
    expect(useMobileHostStatusStore.getState().status?.running).toBe(true);
  });
});
