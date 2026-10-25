/** A failed `global_machines_list` keeps the machines on screen and says why; a stale answer is ignored. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";

const machine = (id: string) => ({ id, host: `${id}.example.org`, user: "u", port: 22, label: id });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  invoke.mockReset();
  useGlobalMachinesStore.setState({ machines: [], loaded: false, loadError: null });
});

describe("global machines load failure", () => {
  it("keeps the machines and records the error", async () => {
    invoke.mockResolvedValueOnce([machine("a")]);
    await useGlobalMachinesStore.getState().load();
    invoke.mockRejectedValueOnce(new Error("file locked"));
    await useGlobalMachinesStore.getState().load();
    const state = useGlobalMachinesStore.getState();
    expect(state.machines.map((m) => m.id)).toEqual(["a"]);
    expect(state.loadError).toContain("file locked");
  });

  it("stays unloaded after a failed first load and recovers on the next", async () => {
    invoke.mockRejectedValueOnce("x");
    await useGlobalMachinesStore.getState().load();
    expect(useGlobalMachinesStore.getState().loaded).toBe(false);
    invoke.mockResolvedValueOnce([machine("a")]);
    await useGlobalMachinesStore.getState().load();
    expect(useGlobalMachinesStore.getState()).toMatchObject({ loaded: true, loadError: null });
  });

  it("ignores a stale answer that arrives after a newer one", async () => {
    const slow = deferred<unknown>();
    invoke.mockReturnValueOnce(slow.promise).mockResolvedValueOnce([machine("new")]);
    const first = useGlobalMachinesStore.getState().load();
    await useGlobalMachinesStore.getState().load();
    slow.resolve([machine("old")]);
    await first;
    expect(useGlobalMachinesStore.getState().machines.map((m) => m.id)).toEqual(["new"]);
  });
});
