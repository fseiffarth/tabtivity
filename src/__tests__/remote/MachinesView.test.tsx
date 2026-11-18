/**
 * The Machines view of the console window (`header/MachinesView` framing
 * `header/MachinesIndicator` with `surface="view"`): the room a click on the
 * header's Machines button opens. Locked in here:
 *
 *  - its machines are one list sorted by state then name, each row with its
 *    target, its state in words, its actions and a ⋯ menu; off machines no
 *    project uses fold into an idle strip whose names open the same menu;
 *  - the header button's click opens the view and puts the hover dropdown away;
 *    the dropdown's ⤢ door does the same; a click while it is shown closes the
 *    window;
 *  - it never takes over the header's status report: unmounting it leaves the
 *    `machines` key the header's own instance published;
 *  - a hand Check made in it is the header's answer too (shared checks);
 *  - handing a machine to a project opens that project's window ON TOP of it:
 *    the view stays open to come back to.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor, within } from "@testing-library/react";

// The view's own meters read the machine and GPU snapshots.
const { base } = vi.hoisted(() => ({
  base: (cmd: string): unknown =>
    cmd === "gpu_memory_snapshot" ? [] : cmd === "machine_load_snapshot" ? { supported: false } : null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn((cmd: string) => Promise.resolve(base(cmd))) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { MachinesIndicator, MachinesView } from "../../components/header/MachinesIndicator";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useSettingsStore } from "../../stores/settings";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useHeaderStatusStore } from "../../stores/headerStatus";
import { useHostBusyStore } from "../../stores/remote/hostBusy";
import { targetKey } from "../../lib/remote/machineSync";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import type { ProjectEntry } from "../../types";

const invokeMock = vi.mocked(invoke);

const MACHINES = [
  { id: "m1", user: "ada", host: "gpu1.example.org", label: "GPU box" },
  { id: "m2", host: "build.example.org", port: 2222 },
];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(((cmd: string) => Promise.resolve(base(cmd))) as never);
  useSettingsStore.setState({ settings: { machines_enabled: true } as never, loaded: true });
  useGlobalMachinesStore.setState({
    machines: MACHINES,
    status: { m1: "connected" },
    reachable: {},
    errors: {},
    loaded: true,
    load: vi.fn(async () => {}),
    probeAll: vi.fn(async () => {}),
  });
  useRootOverlayStore.setState({ open: false, view: "root" });
  useHeaderHoverMenuStore.setState({ openId: null });
  useHeaderStatusStore.setState({ reports: {} });
  useHostBusyStore.setState({ readings: {}, inFlight: {}, probeGlobal: vi.fn(async () => {}) });
});

afterEach(() => {
  cleanup();
});

const dialog = () => document.querySelector<HTMLElement>(".app-view-machines")!;

describe("Machines view", () => {
  it("lists every machine with its target, state and actions; an unused off one folds into the idle strip", async () => {
    const { container } = render(<MachinesView />);
    await act(async () => {});
    const rows = container.querySelectorAll<HTMLElement>(".machines-table-item");
    expect(rows).toHaveLength(1);
    const first = within(rows[0]);
    expect(first.getByText("GPU box")).toBeTruthy();
    expect(first.getByText("ada@gpu1.example.org")).toBeTruthy();
    expect(first.getByText("Connected")).toBeTruthy();
    // A connected machine with nothing else to connect offers Disconnect.
    expect(first.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(first.getByRole("button", { name: "System monitor for GPU box" })).toBeTruthy();
    expect(rows[0].querySelector(".machines-row-grip")).toBeNull();

    const idle = container.querySelector<HTMLElement>(".machines-idle-strip")!;
    const tag = within(idle).getByRole("button", { name: "build.example.org" });
    expect(tag.getAttribute("title")).toBe("build.example.org:2222");
    fireEvent.click(tag);
    expect(screen.getByRole("menuitem", { name: "Check now" })).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: /HPC cluster/ })).toBeTruthy();
  });

  it("sorts by state, then by name", async () => {
    useGlobalMachinesStore.setState({
      machines: [
        { id: "a", host: "zeta.example.org" },
        { id: "b", host: "alpha.example.org" },
        { id: "c", host: "mid.example.org" },
        { id: "d", host: "beta.example.org" },
      ],
      status: { a: "connected", b: "error", c: "connected" },
      reachable: { d: true },
    });
    const { container } = render(<MachinesView />);
    await act(async () => {});
    const names = [...container.querySelectorAll(".machines-table-item")].map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["mid.example.org", "zeta.example.org", "alpha.example.org", "beta.example.org"]);
    const heads = [...container.querySelectorAll(".machines-table-group-head > span:first-child")].map((el) => el.textContent);
    expect(heads).toEqual(["Connected", "Needs attention", "Up, not connected"]);
  });

  it("narrows the list with the filter box", async () => {
    const { container } = render(<MachinesView />);
    await act(async () => {});
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter machines" }), { target: { value: "build" } });
    expect(container.querySelectorAll(".machines-table-item")).toHaveLength(0);
    expect(within(container.querySelector<HTMLElement>(".machines-idle-strip")!).getByText("build.example.org")).toBeTruthy();
  });

  it.each(["menu", "view"] as const)("puts creation controls and the add form before machines in the %s", (surface) => {
    useHeaderHoverMenuStore.setState({ openId: surface === "menu" ? "machines" : null });
    const { container } = render(surface === "view" ? <MachinesView /> : <MachinesIndicator />);
    const firstMachine = container.querySelector(surface === "view" ? ".machines-table-item" : ".machines-indicator-row")!;
    const add = screen.getByRole("button", { name: "Add machine…" });
    const controls =
      surface === "view"
        ? [add, screen.getByRole("button", { name: "Import, export and all machines" })]
        : [add, screen.getByRole("button", { name: "Import…" }), screen.getByRole("button", { name: "Export…" })];
    for (const control of controls) {
      expect(control.compareDocumentPosition(firstMachine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    fireEvent.click(add);
    const address = screen.getByRole("textbox", { name: "SSH address" });
    expect(address.compareDocumentPosition(firstMachine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe(address);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "SSH address" })).toBeNull();
  });

  it("keeps import and export in the view's ⋯", () => {
    render(<MachinesView />);
    fireEvent.click(screen.getByRole("button", { name: "Import, export and all machines" }));
    expect(screen.getByRole("menuitem", { name: "Import…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Export…" }));
    expect(document.querySelector(".machines-view-form .machines-io-panel")).not.toBeNull();
  });

  it.each([1, 4])("summarizes %i running sessions without filling the card with session names", (count) => {
    const names = Array.from({ length: count }, (_, i) => `session-${i}-${"long-id-".repeat(30)}`);
    useHostBusyStore.setState({
      readings: { [targetKey(MACHINES[0])]: { sessions: count, names, at: Date.now() } },
    });
    render(<MachinesView />);
    const summary = dialog().querySelector(".machines-table-sessions")!;
    expect(summary.textContent).toBe(`${count} session${count === 1 ? "" : "s"} running`);
    expect(summary.getAttribute("title")).toContain(names.join(", "));
  });

  it("opens from the header button's click and from the dropdown's door", () => {
    render(<MachinesIndicator />);
    const button = screen.getByRole("button", { name: /Global machines — click/ });
    vi.useFakeTimers();
    fireEvent.mouseEnter(button.parentElement!);
    // A pointer that rests on the button (`HOVER_INTENT_MS`), not one passing by.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    vi.useRealTimers();
    expect(useHeaderHoverMenuStore.getState().openId).toBe("machines");
    fireEvent.click(button);
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "machines" });
    expect(useHeaderHoverMenuStore.getState().openId).toBeNull();

    act(() => {
      useRootOverlayStore.setState({ open: false, view: "root" });
      useHeaderHoverMenuStore.setState({ openId: "machines" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Open the Machines overview" }));
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "machines" });
    expect(useHeaderHoverMenuStore.getState().openId).toBeNull();
  });

  it("closes the window on a click on the header button while the view is shown", () => {
    render(<MachinesIndicator />);
    act(() => useRootOverlayStore.getState().openView("machines"));
    fireEvent.click(screen.getByRole("button", { name: /Global machines — click/ }));
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("leaves the header's status report alone", () => {
    render(<MachinesIndicator />);
    const view = render(<MachinesView />);
    expect(useHeaderStatusStore.getState().reports.machines).toBeDefined();
    view.unmount();
    expect(useHeaderStatusStore.getState().reports.machines).toBeDefined();
  });

  it("shares a hand Check with the header's lamps", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "ssh_probe" ? { ok: true, error: "" } : base(cmd)) as never,
    );
    render(
      <>
        <MachinesIndicator />
        <MachinesView />
      </>,
    );
    fireEvent.click(within(dialog()).getByRole("button", { name: "build.example.org" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Check now" }));
    });
    // The second machine now reads "up" (reachable, no session) in the header
    // too: its grey lamp's tooltip names the state the hand check found.
    const header = document.querySelector(".machines-indicator-btn")!;
    const labels = [...header.querySelectorAll("[aria-label], [title]")]
      .map((el) => el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "")
      .join("\n");
    expect(labels).toMatch(/up, not connected — build\.example\.org/);
    expect(labels).not.toMatch(/not checked/i);
  });

  it("keeps a tagged cluster's hand Check through a sweep that skipped it", async () => {
    // Ids of their own: the sweep's brake is per machine and outlives a test.
    const open = { id: "sweep-open", host: "open.example.org" };
    const cluster = { id: "sweep-cluster", host: "login.example.org" };
    let landSweep = () => {};
    const probeAll = vi.fn(() => new Promise<void>((resolve) => { landSweep = resolve; }));
    useSettingsStore.setState({
      settings: { machines_enabled: true, hpc_hosts: { [targetKey(cluster)]: true } } as never,
      loaded: true,
    });
    useGlobalMachinesStore.setState({ machines: [open, cluster], status: {}, probeAll });
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "ssh_probe" ? { ok: true, error: "" } : base(cmd)) as never,
    );
    render(
      <>
        <MachinesIndicator />
        <MachinesView />
      </>,
    );
    // The sweep is out when the Check is pressed, and lands after its answer.
    await waitFor(() => expect(probeAll).toHaveBeenCalled());
    fireEvent.click(within(dialog()).getByRole("button", { name: "login.example.org" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Check now" }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      landSweep();
    });
    const header = document.querySelector(".machines-indicator-btn")!;
    const labels = [...header.querySelectorAll("[aria-label], [title]")]
      .map((el) => el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "")
      .join("\n");
    expect(labels).toMatch(/up, not connected — login\.example\.org/);
  });

  it("stays put when a machine is handed to a project", () => {
    useProjectsStore.setState({
      projects: [
        {
          id: "p1",
          name: "Proj",
          status: "current",
          position: 0,
          remote: { host: "login.example.org", user: "ada", remote_path: "/work/proj" },
        } as unknown as ProjectEntry,
      ],
      activeId: "p1",
    });
    useRemoteMachinesStore.setState({ projectId: null, pendingDrop: null, extendTarget: null });
    render(<MachinesView />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for GPU box" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to a project…" }));
    const row = within(dialog().querySelector<HTMLElement>(".machines-table-item")!);
    fireEvent.click(row.getByRole("button", { name: /Proj/ }));
    expect(useRemoteMachinesStore.getState().projectId).toBe("p1");
    expect(useRemoteMachinesStore.getState().pendingDrop?.id).toBe("m1");
  });
});
