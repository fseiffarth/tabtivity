/**
 * The Machines menu on a fleet the sweep found off the network ("stale" rows):
 * a reconnect that works clears the stale mark, the toolbar refresh reaches
 * stale rows, a late connect answer never overwrites a newer action, remove
 * does not wait on a dead host, and the sweep's fan-out is bounded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../lib/remote/machineSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/remote/machineSync")>()),
  syncGlobalConnected: vi.fn(),
  syncGlobalDisconnected: vi.fn(),
}));
// A fingerprint confirm would need a dialog host; the wrapped call is all that matters.
vi.mock("../../lib/remote/hostKey", () => ({
  withHostKeyConfirm: <T,>(run: () => Promise<T>) => run(),
}));

import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const MACHINES = [
  { id: "m1", host: "a.example", user: "u" },
  { id: "m2", host: "b.example", user: "u" },
];

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("globalMachines — stale rows and late answers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGlobalMachinesStore.setState({
      machines: MACHINES as never,
      status: { m1: "connected", m2: "connected" },
      reachable: { m1: false, m2: false },
      errors: {},
      loaded: true,
    });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
  });

  it("a successful connect clears the stale mark", async () => {
    mockInvoke.mockResolvedValue({ saved: false, save_error: null });
    await useGlobalMachinesStore.getState().connect("m1");
    const s = useGlobalMachinesStore.getState();
    expect(s.status.m1).toBe("connected");
    expect(s.reachable.m1).toBe(true);
  });

  it("refresh-all reconnects stale rows, not live ones", async () => {
    useGlobalMachinesStore.setState({ reachable: { m1: false, m2: true } });
    mockInvoke.mockResolvedValue({ saved: false, save_error: null });
    await useGlobalMachinesStore.getState().retryAll();
    const hosts = mockInvoke.mock.calls.filter(([cmd]) => cmd === "ssh_connect").map(([, a]) => a.host);
    expect(hosts).toEqual(["a.example"]);
  });

  it("a probe the host answered drops an older off-the-network mark", async () => {
    mockInvoke.mockResolvedValue({ ok: false, unreachable: false, error: "Permission denied" });
    await useGlobalMachinesStore.getState().probeAll();
    expect(useGlobalMachinesStore.getState().reachable.m1).toBeUndefined();
  });

  it("a late connect failure does not overwrite a disconnect pressed meanwhile", async () => {
    const connect = deferred<unknown>();
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "ssh_connect" ? connect.promise : Promise.resolve(),
    );
    useGlobalMachinesStore.setState({ status: { m1: "off" } });
    const pending = useGlobalMachinesStore.getState().connect("m1");
    expect(useGlobalMachinesStore.getState().status.m1).toBe("connecting");
    await useGlobalMachinesStore.getState().disconnect("m1");
    connect.reject("ssh got no answer within 30 s");
    await pending;
    const s = useGlobalMachinesStore.getState();
    expect(s.status.m1).toBe("off");
    expect(s.errors.m1).toBeUndefined();
  });

  it("an older connect landing after a newer one does not win", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const queue = [first, second];
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "ssh_connect" ? queue.shift()!.promise : Promise.resolve(),
    );
    useGlobalMachinesStore.setState({ status: { m1: "off" } });
    const a = useGlobalMachinesStore.getState().connect("m1");
    const b = useGlobalMachinesStore.getState().connect("m1");
    second.resolve({ saved: false, save_error: null });
    await b;
    first.reject("timed out");
    await a;
    expect(useGlobalMachinesStore.getState().status.m1).toBe("connected");
  });

  it("remove deletes the row without waiting on the dead host's teardown", async () => {
    const kill = deferred<unknown>();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "remote_kill_all_jobs") return kill.promise;
      if (cmd === "global_machine_remove") return Promise.resolve([MACHINES[1]]);
      return Promise.resolve();
    });
    await useGlobalMachinesStore.getState().remove("m1");
    expect(useGlobalMachinesStore.getState().machines.map((m) => m.id)).toEqual(["m2"]);
    // Off the network: the master is closed before the doomed kill is tried.
    const order = mockInvoke.mock.calls.map(([cmd]) => cmd);
    expect(order.indexOf("ssh_close_master")).toBeLessThan(order.indexOf("remote_kill_all_jobs"));
    kill.resolve(undefined);
  });

  it("the sweep runs at most six probes at once", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `x${i}`, host: `h${i}.example`, user: "u" }));
    useGlobalMachinesStore.setState({ machines: many as never, status: {}, reachable: {} });
    let running = 0;
    let peak = 0;
    mockInvoke.mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return { ok: true, unreachable: false, error: "" };
    });
    await useGlobalMachinesStore.getState().probeAll();
    expect(peak).toBe(6);
    expect(Object.keys(useGlobalMachinesStore.getState().reachable)).toHaveLength(15);
  });
});
