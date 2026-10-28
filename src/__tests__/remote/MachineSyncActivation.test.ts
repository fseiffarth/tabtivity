/**
 * `syncConnectedMachinesInto`: activating a project opens the pool of each host a
 * connected global machine already holds. Without it a tab on that host stayed
 * behind "Not connected" while the machine sat green in the header — the
 * machine's `→ connected` edge only reaches the project active at that moment,
 * and switching away drops the project's pools.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { invoke } from "@tauri-apps/api/core";
import { syncConnectedMachinesInto, targetKey } from "../../lib/remote/machineSync";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore, hostStateOf } from "../../stores/remote/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import type { ProjectEntry, Settings } from "../../types";

function project(): ProjectEntry {
  return {
    id: "p1",
    name: "walk",
    status: "active",
    position: 1,
    local_file: "/p/p1/project.json",
    remote: { user: "alice", host: "main.example.org", remote_path: "/home/alice/walk" },
    compute_hosts: [
      { id: "w-gpu", host: "gpu.example.org", user: "alice", remote_path: "/home/alice/walk" },
      { id: "w-cpu", host: "cpu.example.org", user: "alice", remote_path: "/home/alice/walk" },
    ],
  };
}

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useProjectsStore.setState({ projects: [project()], activeId: "p1" });
  useSettingsStore.setState({ settings: {} as Settings, loaded: true });
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
  useGlobalMachinesStore.setState({
    machines: [
      { id: "m-gpu", host: "gpu.example.org", user: "alice" },
      { id: "m-cpu", host: "cpu.example.org", user: "alice" },
    ],
    status: { "m-gpu": "connected", "m-cpu": "off" },
  });
});

describe("syncConnectedMachinesInto", () => {
  it("opens only the host whose machine is connected, riding its master", async () => {
    syncConnectedMachinesInto("p1");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("remote_connect", {
      projectId: "p1",
      hostId: "w-gpu",
      password: null,
      viaLogin: true,
    });
    await vi.waitFor(() =>
      expect(hostStateOf(useRemoteStatusStore.getState(), "p1", "w-gpu").ssh).toBe("connected"),
    );
    expect(hostStateOf(useRemoteStatusStore.getState(), "p1", "w-cpu").ssh).toBe("off");
  });

  it("leaves a host that already failed this session alone", () => {
    useRemoteStatusStore.getState().setSsh("p1", "error", "w-gpu");
    syncConnectedMachinesInto("p1");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never opens a pool on a host tagged HPC", () => {
    useSettingsStore.setState({
      settings: { hpc_hosts: { [targetKey({ user: "alice", host: "gpu.example.org" })]: true } } as Settings,
      loaded: true,
    });
    syncConnectedMachinesInto("p1");
    expect(invoke).not.toHaveBeenCalled();
  });
});
