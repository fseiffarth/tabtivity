/**
 * The single-client timer lease (headless owner plan, H2 interim): a window
 * fires its timers only on a confirmed grant and only until that grant would
 * lapse — a failed renewal extends nothing — and keeps firing, without
 * expiry, on a backend that has no lease at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { LEASE_TTL_MS, TIMER_LEASE_CLIENT, holdsTimerLease, useTimerLeaseStore } from "../../stores/timerLease";

const invokeMock = vi.mocked(invoke);
const T0 = new Date(2026, 9, 2, 9, 0, 0);
const grant = () => ({ held: true, holder: TIMER_LEASE_CLIENT, expiresAt: Math.floor(Date.now() / 1000) + 30 });
const probe = () => useTimerLeaseStore.getState().probe();

describe("the timer lease store", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    useTimerLeaseStore.setState(useTimerLeaseStore.getInitialState(), true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds nothing before the first grant arrives", async () => {
    expect(holdsTimerLease()).toBe(false);
    invokeMock.mockResolvedValueOnce(grant());
    await probe();
    expect(holdsTimerLease()).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("timer_lease_acquire", { clientId: TIMER_LEASE_CLIENT });
  });

  it("stops firing when the backend names another window, and resumes on a grant", async () => {
    invokeMock.mockResolvedValueOnce(grant());
    await probe();
    invokeMock.mockResolvedValueOnce({ held: false, holder: "other-window", expiresAt: 1 });
    await probe();
    expect(holdsTimerLease()).toBe(false);
    expect(useTimerLeaseStore.getState().holder).toBe("other-window");

    invokeMock.mockResolvedValueOnce(grant());
    await probe();
    expect(holdsTimerLease()).toBe(true);
    expect(useTimerLeaseStore.getState().holder).toBeUndefined();
  });

  it("lets a grant lapse when its renewal fails, instead of keeping the last answer", async () => {
    invokeMock.mockResolvedValueOnce(grant());
    await probe();

    // Still inside the lease: a failed renewal does not take away what holds.
    vi.advanceTimersByTime(10_000);
    invokeMock.mockRejectedValueOnce(new Error("lock /state/timer-lease.json: Resource temporarily unavailable"));
    await probe();
    expect(holdsTimerLease()).toBe(true);

    // The review's sequence: 31 s on, the lease is gone — another window can
    // hold it now — and the rejected renewal must not say otherwise.
    vi.advanceTimersByTime(21_000);
    expect(holdsTimerLease()).toBe(false);
    invokeMock.mockRejectedValueOnce(new Error("lock /state/timer-lease.json: Resource temporarily unavailable"));
    await probe();
    expect(holdsTimerLease()).toBe(false);
    expect(useTimerLeaseStore.getState().held).toBe(false);
  });

  it("extends the lease on each successful renewal, and only then", async () => {
    invokeMock.mockResolvedValueOnce(grant());
    await probe();
    vi.advanceTimersByTime(20_000);
    invokeMock.mockResolvedValueOnce(grant());
    await probe();

    vi.advanceTimersByTime(20_000);
    expect(holdsTimerLease()).toBe(true);
    // The second grant's TTL, measured from that renewal, runs out.
    vi.advanceTimersByTime(LEASE_TTL_MS - 20_000);
    expect(holdsTimerLease()).toBe(false);
  });

  it("counts the lease from when it was asked for, not from when the answer came", async () => {
    invokeMock.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(5_000);
      return grant();
    });
    await probe();
    vi.advanceTimersByTime(LEASE_TTL_MS - 5_000 - 1_000);
    expect(holdsTimerLease()).toBe(false);
  });

  it("does not take an empty answer for a grant", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await probe();
    expect(holdsTimerLease()).toBe(false);
  });

  it("fires without expiry on a backend that has no lease command", async () => {
    invokeMock.mockRejectedValueOnce(new Error("Command timer_lease_acquire not found"));
    await probe();
    expect(holdsTimerLease()).toBe(true);
    vi.advanceTimersByTime(60 * 60_000);
    expect(holdsTimerLease()).toBe(true);

    // A backend that gains the command hands the window an ordinary lease.
    invokeMock.mockResolvedValueOnce({ held: false, holder: "other-window", expiresAt: 1 });
    await probe();
    expect(holdsTimerLease()).toBe(false);
  });

  it("releases with this window's id, stops firing at once and never throws", async () => {
    invokeMock.mockResolvedValueOnce(grant());
    await probe();
    invokeMock.mockRejectedValueOnce(new Error("gone"));
    await expect(useTimerLeaseStore.getState().release()).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("timer_lease_release", { clientId: TIMER_LEASE_CLIENT });
    expect(holdsTimerLease()).toBe(false);
  });
});
