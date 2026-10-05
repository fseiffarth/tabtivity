/**
 * The file tree's folder sizes must never be able to freeze the app.
 *
 * They are a display aid — the tree renders fine without them — but for a remote
 * project each one is a `du` over SSH, and the tree fires one per visible folder
 * at once. When the network under the project goes away (a dropped VPN tunnel,
 * a suspended laptop) those calls do not *fail*: a black-holed socket returns no
 * error, so each blocks until ssh's keepalive gives up ~45s later, holding a
 * backend blocking-pool thread the whole time. Opening one folder of thirty
 * subfolders then meant thirty stalled threads and a frozen UI.
 *
 * These lock the three limits that prevent that, and — just as importantly — the
 * cases where the guard must stay out of the way.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  DirSizeUnavailable,
  FAILURES_TO_OPEN,
  MAX_CONCURRENT,
  OPEN_MS,
  TIMEOUT_MS,
  guardedDirSize,
  isHostTimeout,
  resetDirSizeGuard,
} from "../../lib/projects/dirSizeGuard";
import { BRAND } from "../../lib/brand";

const PROJECT = `/home/u/${BRAND.slug}/projects/demo`;

/** A call that never settles — what a black-holed SSH round trip looks like. */
const hangs = () => new Promise<number>(() => {});

beforeEach(() => {
  resetDirSizeGuard();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetDirSizeGuard();
});

describe("timeout", () => {
  it("gives up on a call that never answers instead of hanging forever", async () => {
    const settled = vi.fn();
    const p = guardedDirSize(PROJECT, hangs).then(settled, settled);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(settled).toHaveBeenCalledOnce();
    expect(isHostTimeout(settled.mock.calls[0][0])).toBe(true);
  });

  it("passes a prompt answer straight through", async () => {
    await expect(guardedDirSize(PROJECT, () => Promise.resolve(4096))).resolves.toBe(4096);
  });
});

describe("concurrency cap", () => {
  it("holds calls beyond the cap back rather than dispatching them all at once", async () => {
    const started = vi.fn();
    for (let i = 0; i < MAX_CONCURRENT + 3; i += 1) {
      void guardedDirSize(PROJECT, () => {
        started();
        return hangs();
      }).catch(() => {});
    }
    await vi.advanceTimersByTimeAsync(0);
    // The point: a wide folder must not fire one call per subfolder into a
    // network that isn't answering.
    expect(started).toHaveBeenCalledTimes(MAX_CONCURRENT);
  });

  it("hands a freed slot to the next waiter", async () => {
    const started = vi.fn();
    for (let i = 0; i < MAX_CONCURRENT + 1; i += 1) {
      void guardedDirSize(PROJECT, () => {
        started();
        return hangs();
      }).catch(() => {});
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveBeenCalledTimes(MAX_CONCURRENT);
    // First in flight times out → its slot goes to the queued call.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    expect(started).toHaveBeenCalledTimes(MAX_CONCURRENT + 1);
  });
});

describe("circuit breaker", () => {
  /** Time out `n` calls back to back. */
  async function timeOut(n: number) {
    for (let i = 0; i < n; i += 1) {
      const p = guardedDirSize(PROJECT, hangs).catch((e) => e);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
      await p;
    }
  }

  it("refuses instantly once the host has repeatedly failed to answer", async () => {
    await timeOut(FAILURES_TO_OPEN);
    // This is the whole point: the 30th folder costs nothing at all, instead of
    // each one paying the timeout in turn.
    const run = vi.fn(hangs);
    await expect(guardedDirSize(PROJECT, run)).rejects.toBeInstanceOf(DirSizeUnavailable);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not open on failures that are not timeouts", async () => {
    // An unreadable folder answered fine — it says nothing about the host, so it
    // must not push the project toward a trip.
    for (let i = 0; i < FAILURES_TO_OPEN + 2; i += 1) {
      await guardedDirSize(PROJECT, () => Promise.reject(new Error("permission denied"))).catch(
        () => {},
      );
    }
    await expect(guardedDirSize(PROJECT, () => Promise.resolve(7))).resolves.toBe(7);
  });

  it("lets a retry through once the open window elapses", async () => {
    await timeOut(FAILURES_TO_OPEN);
    await vi.advanceTimersByTimeAsync(OPEN_MS + 1);
    await expect(guardedDirSize(PROJECT, () => Promise.resolve(11))).resolves.toBe(11);
  });

  it("closes again on the first success, so one good answer restores the tree", async () => {
    await timeOut(FAILURES_TO_OPEN - 1);
    await expect(guardedDirSize(PROJECT, () => Promise.resolve(1))).resolves.toBe(1);
    // The earlier timeouts are forgiven — the next timeout starts a fresh count
    // rather than tripping the breaker immediately.
    const p = guardedDirSize(PROJECT, hangs).catch((e) => e);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    await p;
    const run = vi.fn(() => Promise.resolve(2));
    await expect(guardedDirSize(PROJECT, run)).resolves.toBe(2);
    expect(run).toHaveBeenCalledOnce();
  });

  it("is per project — one dead host does not stop another project's tree", async () => {
    await timeOut(FAILURES_TO_OPEN);
    await expect(guardedDirSize(PROJECT, hangs)).rejects.toBeInstanceOf(DirSizeUnavailable);
    await expect(guardedDirSize("/home/u/other", () => Promise.resolve(99))).resolves.toBe(99);
  });
});
