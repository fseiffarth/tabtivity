/**
 * The Machines view's project hosts (`header/MachinesTable`, drawn by
 * `MachinesView`): one row per machine from the stores' lamps, project hosts and
 * global machines merged by host name, offering one Connect for the projects
 * that are not connected — without probing anything.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    Promise.resolve(cmd === "gpu_memory_snapshot" ? [] : cmd === "machine_load_snapshot" ? { supported: false } : []),
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
import { MachinesView } from "../../components/header/MachinesIndicator";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { useSettingsStore } from "../../stores/settings";
import type { ProjectEntry } from "../../types";

const remoteProject = (id: string, host: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, status: "active", position: 1, local_file: `/${id}/p.json`, remote: { host }, ...extra }) as unknown as ProjectEntry;

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useSettingsStore.setState({ settings: { machines_enabled: true } as never, loaded: true });
  useProjectsStore.setState({ projects: [{ ...remoteProject("r1", "gpu-box"), name: "Cluster" } as ProjectEntry] });
  useRemoteStatusStore.setState({ byProject: { r1: { ssh: "off", vpn: "off" } }, byHost: {} });
  useGlobalMachinesStore.setState({
    machines: [],
    status: {},
    reachable: {},
    errors: {},
    loaded: true,
    load: vi.fn(async () => {}),
    probeAll: vi.fn(async () => {}),
  });
});
afterEach(() => cleanup());

describe("Machines view · project hosts", () => {
  it("offers Connect for a host that is off, probing nothing", async () => {
    render(<MachinesView />);
    await act(async () => {});
    const calls = vi.mocked(invoke).mock.calls.map(([command]) => command);
    expect(calls.some((c) => /ssh|probe|connect/.test(String(c)))).toBe(false);
    expect(screen.getByRole("listitem", { name: "gpu-box" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect…" })).toBeTruthy();
  });

  it("opens the one project's connection hub directly from Connect", async () => {
    const open = vi.fn();
    useRemoteMachinesStore.setState({ open });
    render(<MachinesView />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    expect(open).toHaveBeenCalledWith("r1");
  });

  it("merges two projects and a global machine on one host into one row; Connect then picks a project", async () => {
    const open = vi.fn();
    useRemoteMachinesStore.setState({ open });
    useProjectsStore.setState({ projects: [remoteProject("r1", "gpu-box"), remoteProject("r2", "GPU-BOX")] });
    useRemoteStatusStore.setState({ byProject: { r1: { ssh: "off", vpn: "off" }, r2: { ssh: "connected", vpn: "off" } }, byHost: {} });
    useGlobalMachinesStore.setState({ machines: [{ id: "g1", host: "gpu-box", label: "GPU box" }], status: { g1: "connected" } });
    render(<MachinesView />);
    await act(async () => {});
    expect(screen.getAllByRole("listitem", { name: "GPU box" })).toHaveLength(1);
    // Only r1 is not connected: one project, so no menu.
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    expect(open).toHaveBeenCalledWith("r1");
    // r2 goes off too: two projects, a menu names them.
    act(() => {
      useRemoteStatusStore.setState({ byProject: { r1: { ssh: "off", vpn: "off" }, r2: { ssh: "off", vpn: "off" } }, byHost: {} });
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "r2" }));
    expect(open).toHaveBeenLastCalledWith("r2");
  });

  it("names a compute host as the run host instead of printing its location", async () => {
    useProjectsStore.setState({
      projects: [remoteProject("r1", "gpu-box", { run_host: "host:56bc0dda-1", compute_hosts: [{ id: "56bc0dda-1", host: "big.example", label: "Big box" }] })],
    });
    render(<MachinesView />);
    await act(async () => {});
    expect(document.body.textContent).toContain("→ Big box");
    expect(document.querySelector('[title="r1 — runs on Big box"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("56bc0dda");
  });
});
