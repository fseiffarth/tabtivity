/**
 * A global machine armed for auto-connect counts as the opt-in (gate 2) of the
 * project host that is the same SSH login — and the project's own path is then the
 * one that reconnects it: on activation and launch, on a dead pool, and after a
 * tunnel-up / machine sweep. Everything else about that path still holds: the HPC
 * gate, the probe, and never a prompt (no modal, no login tab for a machine-only
 * opt-in). A machine that is merely *connected*, armed for another login, or
 * behind the switched-off Machines feature changes nothing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { invoke } from "@tauri-apps/api/core";
import {
  retryAutoConnectAfterVpn,
  silentReconnectDeadHost,
  useProjectsStore,
} from "../../stores/projects";
import { useConnectDialogStore } from "../../stores/remote/connectDialog";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { GlobalMachine, ProjectEntry, Settings, SshProbe } from "../../types";

const invokeMock = vi.mocked(invoke);

const REACHABLE: SshProbe = { ok: true, unreachable: false, error: "" };
const REJECTED: SshProbe = {
  ok: false,
  unreachable: false,
  error: "ada@gpu1.example.org: Permission denied (publickey,password).",
};

const ARMED: GlobalMachine = { id: "m1", user: "ada", host: "GPU1.example.org", auto_connect: true };

const remoteProject = {
  id: "p1",
  name: "Remote",
  directory: "/local/p1",
  status: "active",
  position: 0,
  // Port 22 spelled out and the host in lower case: still the same login as ARMED.
  remote: { host: "gpu1.example.org", user: "ada", port: 22, remote_path: "/work" },
} as unknown as ProjectEntry;

const localProject = {
  id: "p2",
  name: "Local",
  directory: "/local/p2",
  status: "active",
  position: 1,
  compute_hosts: [{ id: "w1", host: "gpu1.example.org", user: "ada", remote_path: "/w" }],
} as unknown as ProjectEntry;

let probe: SshProbe = REACHABLE;

const settle = () => new Promise((r) => setTimeout(r, 0));
const connects = () => invokeMock.mock.calls.filter(([c]) => c === "remote_connect");
const lamp = (projectId: string, hostId?: string) =>
  hostId
    ? useRemoteStatusStore.getState().byHost[projectId]?.[hostId]?.ssh
    : useRemoteStatusStore.getState().byProject[projectId]?.ssh;

function settings(extra: Partial<Settings> = {}): void {
  useSettingsStore.setState({
    settings: { machines_enabled: true, ...extra } as Settings,
    loaded: true,
  });
}

beforeEach(() => {
  probe = REACHABLE;
  invokeMock.mockReset();
  invokeMock.mockImplementation(((cmd: string) => {
    if (cmd === "ssh_probe") return Promise.resolve(probe);
    // Nothing saved: a machine-only opt-in must not depend on (or report) this.
    if (cmd === "remote_saved_password_state")
      return Promise.resolve({ saved: false, keyring: "unlocked" });
    if (cmd === "remote_has_saved_password") return Promise.resolve(false);
    return Promise.resolve();
  }) as never);
  settings();
  useGlobalMachinesStore.setState({ machines: [ARMED], status: {} });
  useProjectsStore.setState({ projects: [remoteProject, localProject], activeId: null, connToast: null });
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
  useConnectDialogStore.setState({ projectId: null });
  useTabsStore.setState({ tabsByScope: {}, layoutByScope: {} });
});

describe("an armed machine opts the project host in", () => {
  it("connects a remote project on activation, silently and via the machine's login", async () => {
    await useProjectsStore.getState().setActive("p1");
    await settle();

    expect(connects()).toHaveLength(1);
    expect(connects()[0][1]).toEqual({ projectId: "p1", password: null, viaLogin: true });
    expect(lamp("p1")).toBe("connected");
    // The probe was the eligibility check — no "nothing saved" toast, no modal.
    expect(useProjectsStore.getState().connToast).toBeNull();
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("connects a local project's worker on activation", async () => {
    await useProjectsStore.getState().setActive("p2");
    await settle();

    expect(connects()).toHaveLength(1);
    expect(connects()[0][1]).toEqual({
      projectId: "p2",
      hostId: "w1",
      password: null,
      viaLogin: true,
    });
    expect(lamp("p2", "w1")).toBe("connected");
  });

  it("connects the initially-active project on launch", async () => {
    invokeMock.mockImplementation(((cmd: string) => {
      if (cmd === "get_projects") return Promise.resolve([{ ...remoteProject, status: "current" }]);
      if (cmd === "ssh_probe") return Promise.resolve(REACHABLE);
      return Promise.resolve();
    }) as never);

    await useProjectsStore.getState().load();
    await settle();

    expect(connects()[0]?.[1]).toMatchObject({ projectId: "p1", viaLogin: true });
    expect(lamp("p1")).toBe("connected");
  });

  it("re-opens a dead pool, primary and local worker alike", async () => {
    useProjectsStore.setState({ activeId: "p1" });
    useRemoteStatusStore.setState({
      byProject: { p1: { ssh: "connected", vpn: "off" } },
      byHost: { p2: { w1: { ssh: "connected", vpn: "off" } } },
    });

    await silentReconnectDeadHost("p1", "primary");
    await silentReconnectDeadHost("p2", "w1"); // not active — the dead-host path doesn't care

    expect(connects().map(([, a]) => a)).toEqual([
      { projectId: "p1", hostId: "primary", password: null, viaLogin: true },
      { projectId: "p2", hostId: "w1", password: null, viaLogin: true },
    ]);
    expect(lamp("p1")).toBe("connected");
    expect(lamp("p2", "w1")).toBe("connected");
  });

  it("resets a red lamp and retries after a tunnel-up / machine sweep", async () => {
    useProjectsStore.setState({ activeId: "p2" });
    useRemoteStatusStore.setState({
      byProject: {},
      byHost: { p2: { w1: { ssh: "error", vpn: "off" } } },
    });

    retryAutoConnectAfterVpn();
    await settle();

    expect(connects()).toHaveLength(1);
    expect(lamp("p2", "w1")).toBe("connected");
  });

  it("goes red without a prompt when the probe fails", async () => {
    probe = REJECTED;
    await useProjectsStore.getState().setActive("p1");
    await settle();

    expect(connects()).toHaveLength(0);
    expect(lamp("p1")).toBe("error");
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("opens no login tab with connections_headless off", async () => {
    settings({ connections_headless: false });
    probe = REJECTED;
    await useProjectsStore.getState().setActive("p1");
    await settle();

    expect(useTabsStore.getState().tabsByScope.root ?? []).toHaveLength(0);
    expect(connects()).toHaveLength(0);
    expect(lamp("p1")).toBe("error");
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("still connects non-headless when the probe rides the machine's master", async () => {
    settings({ connections_headless: false });
    await useProjectsStore.getState().setActive("p2");
    await settle();

    expect(connects()[0]?.[1]).toMatchObject({ projectId: "p2", hostId: "w1", viaLogin: true });
    expect(lamp("p2", "w1")).toBe("connected");
  });
});

describe("no opt-in, no change", () => {
  it("leaves a host tagged HPC alone on every path", async () => {
    settings({ hpc_hosts: { "ada@gpu1.example.org:22": true } } as Partial<Settings>);

    await useProjectsStore.getState().setActive("p1");
    await settle();
    expect(connects()).toHaveLength(0);
    expect(lamp("p1")).toBeUndefined();

    useRemoteStatusStore.setState({ byProject: { p1: { ssh: "error", vpn: "off" } }, byHost: {} });
    retryAutoConnectAfterVpn();
    await settle();
    // Not reset either: only a host that will be re-attempted loses its red lamp.
    expect(lamp("p1")).toBe("error");

    useRemoteStatusStore.setState({ byProject: { p1: { ssh: "connected", vpn: "off" } }, byHost: {} });
    await silentReconnectDeadHost("p1", "primary");
    expect(connects()).toHaveLength(0);
    expect(lamp("p1")).toBe("error");
    expect(invokeMock).not.toHaveBeenCalledWith("ssh_probe", expect.anything());
  });

  it("ignores a machine that is only connected, not armed", async () => {
    useGlobalMachinesStore.setState({
      machines: [{ ...ARMED, auto_connect: false }],
      status: { m1: "connected" },
    });

    await useProjectsStore.getState().setActive("p1");
    await settle();
    expect(connects()).toHaveLength(0);

    useRemoteStatusStore.setState({ byProject: { p1: { ssh: "connected", vpn: "off" } }, byHost: {} });
    await silentReconnectDeadHost("p1", "primary");
    expect(connects()).toHaveLength(0);
    expect(lamp("p1")).toBe("error");
  });

  it("ignores an armed machine for another login", async () => {
    useGlobalMachinesStore.setState({ machines: [{ ...ARMED, user: "bob" }], status: {} });

    await useProjectsStore.getState().setActive("p1");
    await settle();
    expect(connects()).toHaveLength(0);
    expect(lamp("p1")).toBeUndefined();
  });

  it("ignores armed machines while the Machines feature is off", async () => {
    settings({ machines_enabled: false });

    await useProjectsStore.getState().setActive("p2");
    await settle();
    expect(connects()).toHaveLength(0);

    useRemoteStatusStore.setState({ byProject: {}, byHost: { p2: { w1: { ssh: "error", vpn: "off" } } } });
    retryAutoConnectAfterVpn();
    await settle();
    expect(lamp("p2", "w1")).toBe("error");
    expect(connects()).toHaveLength(0);
  });
});
