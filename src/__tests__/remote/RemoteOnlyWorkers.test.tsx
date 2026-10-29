/**
 * Workers of a remote-only project (D4): a synced-copy worker is fed from the
 * local mirror (`worker_sync`), which such a project does not have. So the
 * Remote machines window offers shared-filesystem / no-sync machines only: the
 * add form's "Sync a copy" is disabled with the reason (and the form's request
 * reads it as off), and an existing shared worker cannot be switched to one. A
 * plain remote project keeps the choice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
// The add form's second step (after the login): a live session on the new machine.
vi.mock("../../components/projects/useRemoteBrowse", () => ({
  useRemoteBrowse: () => ({
    conn: { user: "ada", host: "gpu1.example.org", port: null },
    password: null,
    path: "/work/proj",
    entries: [],
    busy: false,
    error: "",
    setError: () => {},
    connect: async () => null,
    openSession: () => {},
    reset: () => {},
    enter: () => {},
    jump: () => {},
    goUp: () => {},
    mkdir: async () => {},
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { RemoteMachinesWindow } from "../../components/projects/RemoteMachinesWindow";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useHostBusyStore } from "../../stores/remote/hostBusy";
import { useSettingsStore } from "../../stores/settings";
import type { ComputeHost, ProjectEntry } from "../../types";

const invokeMock = vi.mocked(invoke);

const SHARED: ComputeHost = {
  id: "w1",
  host: "node2.example.org",
  remote_path: "/work/proj",
  shared_fs: true,
  sync_code: false,
};

function entry(remoteOnly: boolean): ProjectEntry {
  return {
    id: "p1",
    name: "Proj",
    status: "current",
    position: 0,
    local_file: "/state/remote-projects/p1/project.json",
    remote: {
      host: "login.example.org",
      user: "ada",
      remote_path: "/work/proj",
      ...(remoteOnly ? { remote_only: true } : {}),
    },
    compute_hosts: [SHARED],
  } as ProjectEntry;
}

/** The `Toggle` input inside the row labelled "Sync a copy of the code…". */
const syncToggles = () =>
  screen
    .getAllByText("Sync a copy of the code to this machine")
    .map((span) => span.closest("label")!.querySelector("input") as HTMLInputElement);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((() => Promise.resolve(null)) as never);
  useSettingsStore.setState({ settings: { machines_enabled: true } as never, loaded: true });
  useGlobalMachinesStore.setState({
    machines: [],
    status: {},
    reachable: {},
    errors: {},
    loaded: true,
    load: vi.fn(async () => {}),
    probeAll: vi.fn(async () => {}),
  });
  useHostBusyStore.setState({ readings: {}, inFlight: {}, probeGlobal: vi.fn(async () => {}) });
  useRemoteStatusStore.setState({ byProject: { p1: { ssh: "connected", vpn: "off" } }, byHost: {} });
});

afterEach(() => cleanup());

async function renderWindow(remoteOnly: boolean) {
  const project = entry(remoteOnly);
  useProjectsStore.setState({ projects: [project], activeId: "p1" });
  await act(async () => {
    render(<RemoteMachinesWindow project={project} onClose={() => {}} />);
  });
}

const REASON = /keeps no local copy, so no machine can get a synced copy/;

describe("Remote machines · a remote-only project", () => {
  it("disables Sync a copy, in the add form and on a shared worker, and says why", async () => {
    await renderWindow(true);
    const [worker, add] = syncToggles();
    expect(worker.disabled).toBe(true);
    expect(add.disabled).toBe(true);
    expect(screen.getAllByText(REASON)).toHaveLength(2);
  });

  it("keeps the choice on a plain remote project", async () => {
    await renderWindow(false);
    for (const toggle of syncToggles()) expect(toggle.disabled).toBe(false);
    expect(screen.queryByText(REASON)).toBeNull();
  });
});
