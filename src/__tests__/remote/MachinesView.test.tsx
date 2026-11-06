/**
 * The Machines view of the console window (`header/MachinesView` framing
 * `header/MachinesIndicator` with `surface="view"`): the room a click on the
 * header's Machines button opens. Locked in here:
 *
 *  - its machines are tiles in one grid, each with its target, its state in
 *    words, its actions and its details (no ▸ fold, but the drag grip: tiles
 *    reorder across the grid), under this machine's meters;
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
  it("lays every machine out as a tile with its target, state and actions", async () => {
    const { container } = render(<MachinesView />);
    await act(async () => {});
    const grid = container.querySelector(".machines-grid");
    expect(grid).not.toBeNull();
    const tiles = grid!.querySelectorAll(".machines-tile.models-tile");
    expect(tiles).toHaveLength(2);

    const first = within(tiles[0] as HTMLElement);
    expect(first.getByText("GPU box")).toBeTruthy();
    expect(first.getByText("ada@gpu1.example.org")).toBeTruthy();
    // A connected machine offers disconnect; details are open without a fold.
    expect(first.getByRole("button", { name: /disconnect/i })).toBeTruthy();
    expect(first.getByRole("button", { name: /system monitor/i })).toBeTruthy();
    expect(tiles[0].querySelector(".machines-row-expand-btn")).toBeNull();
    expect(tiles[0].querySelector(".machines-row-grip")).not.toBeNull();
    // The actions sit at the tile's foot, after the details — not in the head.
    expect(tiles[0].querySelector(".vpn-indicator-head .machines-row-actions")).toBeNull();
    expect(tiles[0].lastElementChild?.classList.contains("machines-row-actions")).toBe(true);

    expect(within(tiles[1] as HTMLElement).getByText("build.example.org:2222")).toBeTruthy();
  });

  it.each(["menu", "view"] as const)("puts creation controls and the add form before machines in the %s", (surface) => {
    useHeaderHoverMenuStore.setState({ openId: surface === "menu" ? "machines" : null });
    const { container } = render(surface === "view" ? <MachinesView /> : <MachinesIndicator />);
    const firstMachine = container.querySelector(".machines-indicator-row")!;
    const add = screen.getByRole("button", { name: "Add machine…" });
    for (const control of [add, screen.getByRole("button", { name: "Import…" }), screen.getByRole("button", { name: "Export…" })]) {
      expect(control.compareDocumentPosition(firstMachine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    fireEvent.click(add);
    const address = screen.getByRole("textbox", { name: "SSH address" });
    expect(address.compareDocumentPosition(firstMachine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe(address);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Add machine…" })).toBeTruthy();
  });

  it.each([1, 4])("summarizes %i running sessions without filling the card with session names", (count) => {
    const names = Array.from({ length: count }, (_, i) => `session-${i}-${"long-id-".repeat(30)}`);
    useHostBusyStore.setState({
      readings: { [targetKey(MACHINES[0])]: { sessions: count, names, at: Date.now() } },
    });
    render(<MachinesView />);
    const summary = dialog().querySelector(".machines-tile-busy")!;
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
    const tile = within(dialog().querySelectorAll<HTMLElement>(".machines-tile")[1]);
    await act(async () => {
      fireEvent.click(tile.getByRole("button", { name: /check/i }));
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
    const tile = within(dialog().querySelectorAll<HTMLElement>(".machines-tile")[1]);
    await act(async () => {
      fireEvent.click(tile.getByRole("button", { name: /check/i }));
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
    const tile = within(dialog().querySelectorAll<HTMLElement>(".machines-tile")[0]);
    fireEvent.click(tile.getByRole("button", { name: "Add this machine to a project" }));
    fireEvent.click(tile.getByRole("button", { name: /Proj/ }));
    expect(useRemoteMachinesStore.getState().projectId).toBe("p1");
    expect(useRemoteMachinesStore.getState().pendingDrop?.id).toBe("m1");
  });
});

describe("reordering tiles in the view", () => {
  const rect = (left: number, top: number) =>
    ({ left, top, right: left + 100, bottom: top + 100, width: 100, height: 100, x: left, y: top }) as DOMRect;
  const ptr = (el: Element, type: string, x: number, y: number) =>
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
    });

  it("drags a tile across the grid into another slot and persists the new order", async () => {
    const reorder = vi.fn(async () => {});
    useGlobalMachinesStore.setState({ reorder });
    const { container } = render(<MachinesView />);
    await act(async () => {});
    const tiles = [...container.querySelectorAll(".machines-tile")] as HTMLElement[];
    // Two tiles side by side: m1 at x 0–100, m2 at x 200–300.
    tiles[0].getBoundingClientRect = () => rect(0, 0);
    tiles[1].getBoundingClientRect = () => rect(200, 0);
    const grip = tiles[0].querySelector(".machines-row-grip") as HTMLElement;
    grip.setPointerCapture = () => {};

    ptr(grip, "pointerdown", 50, 50);
    ptr(grip, "pointermove", 250, 50);
    // The dragged tile follows the pointer; the other steps into the freed slot.
    expect(tiles[0].style.transform).toBe("translate(200px, 0px)");
    expect(tiles[1].style.transform).toBe("translate(-200px, 0px)");
    ptr(grip, "pointerup", 250, 50);
    expect(reorder).toHaveBeenCalledWith(["m2", "m1"]);
  });

  it("nudges a tile with the arrow keys from its grip", async () => {
    const reorder = vi.fn(async () => {});
    useGlobalMachinesStore.setState({ reorder });
    const { container } = render(<MachinesView />);
    await act(async () => {});
    const grip = container.querySelector(".machines-tile .machines-row-grip") as HTMLElement;
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(reorder).toHaveBeenCalledWith(["m2", "m1"]);
  });
});
