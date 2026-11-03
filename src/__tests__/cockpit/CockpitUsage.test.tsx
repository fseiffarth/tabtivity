/**
 * The Usage view (C6): it hosts the side panel's CLIs body (one read of
 * `agent_overview` on show) and lists remote hosts from the stores' lamps,
 * offering Connect for one that is not connected — without probing it.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
// The CLIs body's poll runs once on show here (its cadence is usePoll's own,
// tested there; under jsdom its focus/visibility wait never settles).
vi.mock("../../lib/usePoll", async () => {
  const { useEffect } = await import("react");
  return {
    usePoll: (fn: (poll: { stopped: boolean }) => unknown, _ms: number, opts?: { enabled?: boolean }) => {
      useEffect(() => {
        if (opts?.enabled !== false) void fn({ stopped: false });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
  };
});
// The models hub is its own surface's, tested there; here it only has to be there.
vi.mock("../../components/models/useModelsHub", () => ({
  useMachineMeters: () => ({ gpus: [], machine: null }),
  useModelsHub: () => ({ models: [] }),
}));

import { CockpitUsage } from "../../components/cockpit/CockpitUsage";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import type { ProjectEntry } from "../../types";

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useProjectsStore.setState({
    projects: [{ id: "r1", name: "Cluster", status: "active", position: 1, local_file: "/r/p.json", remote: { host: "gpu-box" } } as unknown as ProjectEntry],
  });
  useRemoteStatusStore.setState({ byProject: { r1: { ssh: "off", vpn: "off" } }, byHost: {} });
  useGlobalMachinesStore.setState({ machines: [], status: {}, loaded: true });
});
afterEach(() => cleanup());

describe("CockpitUsage", () => {
  it("reads the CLI overview once on show and offers Connect for a host that is off", async () => {
    render(<CockpitUsage />);
    await act(async () => {});
    const calls = vi.mocked(invoke).mock.calls.map(([command]) => command);
    expect(calls.filter((c) => c === "agent_overview")).toHaveLength(1);
    expect(calls.some((c) => /ssh|probe|connect/.test(String(c)))).toBe(false);
    expect(screen.getByText("gpu-box")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect…" })).toBeTruthy();
  });
});
