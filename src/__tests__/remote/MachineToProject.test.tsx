/**
 * A global machine handed to a remote project from the header's Machines menu
 * ("Add to a project" → confirm the shared path in `RemoteMachinesWindow`).
 *
 * The confirm panel used to be drawn like an added worker card, wearing the
 * global machine's green lamp, so it was taken for "added" and closed: nothing
 * was saved, the pill's lamp count never moved, and the project stayed on offer.
 * Locked in here:
 *
 *  - the pending panel says it is not added yet and borrows no lamp;
 *  - pressing Add saves the worker and the pill's lamp counts it;
 *  - a project that already holds the machine is offered by neither the
 *    Machines menu's picker nor the panel, and the hub's typed form refuses it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { RemoteMachinesDialogHost } from "../../components/projects/RemoteMachinesWindow";
import { RemoteConnMenu } from "../../components/header/RemoteConnMenu";
import { MachinesOverlayHost } from "../../components/header/MachinesIndicator";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useMachinesOverlayStore } from "../../stores/machinesOverlay";
import { useHostBusyStore } from "../../stores/remote/hostBusy";
import { useSettingsStore } from "../../stores/settings";
import type { ComputeHost, ProjectEntry } from "../../types";

const invokeMock = vi.mocked(invoke);

const MACHINE = { id: "m1", user: "ada", host: "gpu1.example.org", label: "GPU box" };

const project = {
  id: "p1",
  name: "Proj",
  status: "current",
  position: 0,
  remote: { host: "login.example.org", user: "ada", remote_path: "/work/proj" },
} as unknown as ProjectEntry;

let stored: ComputeHost[] = [];

beforeEach(() => {
  stored = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(((cmd: string, args?: { host?: ComputeHost }) => {
    if (cmd === "add_compute_host") {
      stored = [...stored, { ...args!.host!, id: `w${stored.length + 1}` }];
      return Promise.resolve(stored);
    }
    return Promise.resolve(null);
  }) as never);
  useSettingsStore.setState({ settings: { machines_enabled: true } as never, loaded: true });
  useGlobalMachinesStore.setState({
    machines: [MACHINE],
    status: { m1: "connected" },
    reachable: {},
    errors: {},
    loaded: true,
    load: vi.fn(async () => {}),
    probeAll: vi.fn(async () => {}),
  });
  useHostBusyStore.setState({ readings: {}, inFlight: {}, probeGlobal: vi.fn(async () => {}) });
  useProjectsStore.setState({ projects: [project], activeId: "p1" });
  useRemoteStatusStore.setState({ byProject: { p1: { ssh: "connected", vpn: "off" } }, byHost: {} });
  useRemoteMachinesStore.setState({ projectId: null, pendingDrop: null, extendTarget: null });
  useMachinesOverlayStore.setState({ open: false });
});

afterEach(() => cleanup());

// jsdom has no layout.
Element.prototype.scrollIntoView = () => {};

function Pill() {
  const p = useProjectsStore((s) => s.projects.find((x) => x.id === "p1"))!;
  return <RemoteConnMenu project={p} compact />;
}

const panel = () => document.querySelector(".remote-machine-drop-panel") as HTMLElement | null;

describe("adding a global machine to a remote project", () => {
  it("shows a pending panel, not a connected card, until Add is pressed", async () => {
    render(<RemoteMachinesDialogHost />);
    act(() => useRemoteMachinesStore.getState().open("p1", MACHINE));
    expect(within(panel()!).getByText(/Add GPU box to this project\?/)).toBeTruthy();
    expect(within(panel()!).getByText(/Not added yet/)).toBeTruthy();
    expect(panel()!.querySelector(".conn-lamp, [class*='lamp']")).toBeNull();
  });

  it("counts it on the pill's lamp once it is added and connected", async () => {
    render(
      <>
        <Pill />
        <RemoteMachinesDialogHost />
      </>,
    );
    expect(document.querySelector(".conn-lamp-count-num")).toBeNull();
    act(() => useRemoteMachinesStore.getState().open("p1", MACHINE));
    await act(async () => {
      fireEvent.click(within(panel()!).getByRole("button", { name: /^Add machine$/ }));
    });
    expect(useProjectsStore.getState().projects[0].compute_hosts).toHaveLength(1);
    expect(document.querySelector(".conn-lamp-count-num")?.textContent).toBe("2");
    expect(panel()).toBeNull();
  });

  it("offers no second add once the project holds the machine", async () => {
    const worker = { ...MACHINE, id: "w1", remote_path: "/work/proj", shared_fs: true } as ComputeHost;
    useProjectsStore.setState({ projects: [{ ...project, compute_hosts: [worker] }] });

    // The Machines menu's picker: the project is there, but disabled.
    useMachinesOverlayStore.setState({ open: true });
    render(<MachinesOverlayHost />);
    fireEvent.click(screen.getByRole("button", { name: "Add this machine to a project" }));
    const pick = screen.getByRole("button", { name: /Proj/ }) as HTMLButtonElement;
    expect(pick.disabled).toBe(true);
    expect(within(pick).getByText(/Already added/)).toBeTruthy();
    cleanup();

    // The hub, handed the machine anyway: it says so and has no Add.
    render(<RemoteMachinesDialogHost />);
    act(() => useRemoteMachinesStore.getState().open("p1", MACHINE));
    expect(within(panel()!).queryByRole("button", { name: /^Add machine$/ })).toBeNull();
    expect(within(panel()!).getByText(/already this project's primary host or one of its workers/)).toBeTruthy();
    expect(invokeMock.mock.calls.some(([c]) => c === "add_compute_host")).toBe(false);
  });
});
