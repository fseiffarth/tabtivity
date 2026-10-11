/**
 * Regression test for the renderer spin: a lamp write that changes nothing must
 * not notify.
 *
 * `setStatus` and `probeAll` rebuilt `status` unconditionally, and zustand
 * notifies on identity — so writing a machine the state it was already in woke
 * every subscriber of this store. `MachinesIndicator` alone holds fourteen
 * selectors against it, so one no-op re-ran all fourteen and re-rendered the
 * header, which re-rendered the project pills, the file panel and the tree under
 * them.
 *
 * Measured in the running app, idle, via the perf probe:
 *
 *              before                     after
 *   commits    150 per 10s                33 per 10s
 *   gm writes  66 per 10s (64 = status)   0
 *   stalls     1 x 263ms per 10s          0
 *
 * That is the whole of the "WebKit renderer pegged, window unresponsive" report:
 * the main thread was re-rendering the entire chrome ~14 times a second for no
 * state change at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
// Pulled in by the store's connect/disconnect paths; irrelevant here.
vi.mock("../../lib/remote/machineSync", () => ({
  syncGlobalConnected: vi.fn(),
  syncGlobalDisconnected: vi.fn(),
}));

import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const MACHINES = [
  { id: "m1", host: "a.example", user: "u" },
  { id: "m2", host: "b.example", user: "u" },
];

describe("globalMachines — a no-op status write must not notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGlobalMachinesStore.setState({
      machines: MACHINES as never,
      status: { m1: "connected", m2: "connected" },
      reachable: { m1: true, m2: true },
      // A probe error an earlier test left would be cleared by the sweep — a
      // real change that notifies.
      errors: {},
      loaded: true,
    });
    // `probeAll` skips HPC-tagged machines via `mayAutoTouch`, which fails closed on
    // an unloaded settings store — without this it would sweep nothing at all.
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
  });

  it("setStatus does not notify when the lamp already holds that value", () => {
    const seen = vi.fn();
    const unsub = useGlobalMachinesStore.subscribe(seen);

    useGlobalMachinesStore.getState().setStatus("m1", "connected");
    expect(seen).not.toHaveBeenCalled();

    // A real transition must still get through — the fix must not make the lamp
    // stop working, which would be a far worse bug than the one it cures.
    useGlobalMachinesStore.getState().setStatus("m1", "error");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(useGlobalMachinesStore.getState().status.m1).toBe("error");

    unsub();
  });

  it("probeAll does not notify when every machine is already in the probed state", async () => {
    // Both already reachable, and both probe ok → nothing changed.
    mockInvoke.mockResolvedValue({ ok: true, unreachable: false, error: "" });
    const seen = vi.fn();
    const unsub = useGlobalMachinesStore.subscribe(seen);

    await useGlobalMachinesStore.getState().probeAll();
    // This is the valuable half: `probeAll` writes EVERY machine at once, so on a
    // fleet of N an unchanged sweep used to invalidate the whole list at once.
    expect(seen).not.toHaveBeenCalled();

    unsub();
  });

  // The Pi bug: a password-only host that ANSWERS but rejects our credential-less
  // probe (nothing saved, no key, no master to ride) is `ok:false` but NOT
  // `unreachable`. Scoring it `reachable:false` painted the connected session
  // `stale` (red) in `MachinesIndicator` — a machine the user is logged into in a
  // terminal, shown red. A probe that only means "we hold no credential to check
  // with" must leave `reachable` (and the session lamp) exactly as they were.
  it("probeAll leaves a reachable-but-unauthenticated host alone, never stale", async () => {
    // m2 is held as a session with no prior probe answer — the shape after a
    // password connect that saved nothing.
    useGlobalMachinesStore.setState({ reachable: { m1: true } });
    mockInvoke.mockImplementation((_cmd: string, args: { host?: string }) =>
      args?.host === "b.example"
        ? Promise.resolve({ ok: false, unreachable: false, error: "Permission denied (publickey,password)." })
        : Promise.resolve({ ok: true, unreachable: false, error: "" }),
    );
    const seen = vi.fn();
    const unsub = useGlobalMachinesStore.subscribe(seen);

    await useGlobalMachinesStore.getState().probeAll();

    // m2's reachability stays absent — "not checked", never `false` — so its
    // connected lamp stays green rather than flipping to stale/red; and no
    // "Permission denied" error is pinned under that green lamp.
    expect(useGlobalMachinesStore.getState().reachable).toEqual({ m1: true });
    expect(useGlobalMachinesStore.getState().errors.m2).toBeUndefined();
    expect(useGlobalMachinesStore.getState().status.m2).toBe("connected");

    unsub();
  });

  // The expectation moved from `status` to `reachable` on purpose. A probe answers
  // "did the host answer", which is NOT "does this app hold a session on it" — and
  // `status` means the second, because `lib/remote/machineSync` propagates it onto any
  // project holding the same host and opens that project's pool. Letting a hover-time
  // sweep write `status` is what lit a machine green with no session behind it while
  // the project stayed unconnected. The idempotence guarantee this file exists for is
  // unchanged; only the field it guards moved.
  it("probeAll still notifies, once, when a machine actually changed — on `reachable`", async () => {
    // b.example is genuinely off the network (`unreachable: true`), the one lane
    // that still scores a host `reachable: false`.
    mockInvoke.mockImplementation((_cmd: string, args: { host?: string }) =>
      args?.host === "b.example"
        ? Promise.resolve({ ok: false, unreachable: true, error: "Connection timed out" })
        : Promise.resolve({ ok: true, unreachable: false, error: "" }),
    );
    const seen = vi.fn();
    const unsub = useGlobalMachinesStore.subscribe(seen);

    await useGlobalMachinesStore.getState().probeAll();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(useGlobalMachinesStore.getState().reachable).toEqual({ m1: true, m2: false });
    // …and the session lamps are left exactly as they were: nothing about a probe
    // opens or ends a session.
    expect(useGlobalMachinesStore.getState().status).toEqual({
      m1: "connected",
      m2: "connected",
    });

    unsub();
  });
});
