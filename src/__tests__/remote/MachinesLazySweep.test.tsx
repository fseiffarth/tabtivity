/**
 * The Machines menu shows first and finds out second:
 *
 *  - the list is on screen from memory, with no host asked anything, until the
 *    surface has settled (`SWEEP_SETTLE_MS`);
 *  - a pointer that only crosses the header logs in nowhere;
 *  - each row takes its state when its OWN host answers, so one dead machine
 *    (a `ConnectTimeout` at least) holds up neither the other rows nor their
 *    busy readings; until then a row with no answer says "checking", one with an
 *    answer keeps it.
 *
 * Every test has machine ids of its own: `probeBrakes` stamps ids at module level.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { MachinesIndicator } from "../../components/header/MachinesIndicator";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useSettingsStore } from "../../stores/settings";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useHostBusyStore } from "../../stores/remote/hostBusy";

const invokeMock = vi.mocked(invoke);
const realProbeAll = useGlobalMachinesStore.getState().probeAll;
const SETTLE_MS = 150;

type Probe = { ok: boolean; unreachable: boolean; error: string };
const UP: Probe = { ok: true, unreachable: false, error: "" };
const DEAD: Probe = { ok: false, unreachable: true, error: "Connection timed out" };

function hover(container: HTMLElement) {
  fireEvent.mouseEnter(container.querySelector(".global-apps-menu")!);
}

const badges = (container: HTMLElement) =>
  [...container.querySelectorAll(".machines-indicator-row")].map(
    (row) => row.querySelector(".machines-state-badge")?.textContent ?? null,
  );

describe("Machines menu: list first, states after", () => {
  let probeBusy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve(null) as never);
    probeBusy = vi.fn(async () => {});
    useSettingsStore.setState({ settings: { machines_enabled: true } as never, loaded: true });
    useHeaderHoverMenuStore.setState({ openId: null });
    useHostBusyStore.setState({ readings: {}, inFlight: {}, probeGlobal: probeBusy as never });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function seed(ids: string[], status: Record<string, "connected"> = {}, reachable: Record<string, boolean> = {}) {
    useGlobalMachinesStore.setState({
      machines: ids.map((id) => ({ id, host: `${id}.example.org` })),
      status,
      reachable,
      errors: {},
      loaded: true,
      load: vi.fn(async () => {}),
      probeAll: realProbeAll,
    });
  }

  const probesSent = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "ssh_probe").length;

  it("shows the list at once and asks no host until it has settled", async () => {
    seed(["show-1", "show-2"]);
    invokeMock.mockImplementation(((cmd: string) =>
      Promise.resolve(cmd === "ssh_probe" ? UP : null)) as never);
    const { container } = render(<MachinesIndicator />);

    hover(container);
    expect(container.querySelectorAll(".machines-indicator-row")).toHaveLength(2);
    expect(probesSent()).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(SETTLE_MS - 1);
    });
    expect(probesSent()).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(probesSent()).toBe(2);
  });

  it("logs in nowhere for a pointer that only crosses the header", async () => {
    seed(["cross-1"]);
    const { container } = render(<MachinesIndicator />);

    hover(container);
    await act(async () => {
      vi.advanceTimersByTime(SETTLE_MS - 1);
      useHeaderHoverMenuStore.getState().close("machines");
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(probesSent()).toBe(0);
  });

  it("gives each row its state when its own host answers", async () => {
    seed(["live-1", "live-2", "live-3"], { "live-1": "connected" });
    let answerDead: (p: Probe) => void = () => {};
    invokeMock.mockImplementation(((cmd: string, args: { host: string }) => {
      if (cmd !== "ssh_probe") return Promise.resolve(null);
      if (args.host === "live-3.example.org") return new Promise<Probe>((r) => (answerDead = r));
      return Promise.resolve(UP);
    }) as never);
    const { container } = render(<MachinesIndicator />);

    hover(container);
    await act(async () => {
      vi.advanceTimersByTime(SETTLE_MS);
    });
    // Two have answered; the third is still on its way and says so. The session
    // on the first gets its busy reading without waiting for the dead host.
    expect(badges(container)).toEqual([null, "up", "checking…"]);
    expect(probeBusy).toHaveBeenCalledTimes(1);
    expect(probeBusy.mock.calls[0][0]).toMatchObject({ id: "live-1" });

    await act(async () => {
      answerDead(DEAD);
    });
    expect(badges(container)).toEqual([null, "up", "no answer"]);
    expect(useGlobalMachinesStore.getState().reachable).toEqual({
      "live-1": true,
      "live-2": true,
      "live-3": false,
    });
  });

  it("keeps a known answer on the row while the sweep re-asks", async () => {
    seed(["known-1"], {}, { "known-1": true });
    invokeMock.mockImplementation(((cmd: string) =>
      cmd === "ssh_probe" ? new Promise(() => {}) : Promise.resolve(null)) as never);
    const { container } = render(<MachinesIndicator />);

    hover(container);
    await act(async () => {
      vi.advanceTimersByTime(SETTLE_MS);
    });
    expect(probesSent()).toBe(1);
    expect(badges(container)).toEqual(["up"]);
  });
});
