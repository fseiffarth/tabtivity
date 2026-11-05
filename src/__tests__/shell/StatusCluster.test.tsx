/**
 * `StatusCluster`'s fold: collapsed hides EVERY member, failing ones included —
 * the summary lamp carries the worst tone instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve("none")) }));
vi.mock("../../components/header/AlertsToggle", () => ({ AlertsToggle: () => <i data-testid="alerts" /> }));
vi.mock("../../components/header/MobileIndicator", () => ({ MobileIndicator: () => <i data-testid="mobile" /> }));
vi.mock("../../components/header/VpnIndicator", () => ({ VpnIndicator: () => <i data-testid="vpn" /> }));
const machinesLife = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock("../../components/header/MachinesIndicator", async () => {
  const { useEffect } = await import("react");
  return {
    MachinesIndicator: () => {
      useEffect(() => {
        machinesLife.mounts++;
        return () => {
          machinesLife.unmounts++;
        };
      }, []);
      return <i data-testid="machines" />;
    },
  };
});
vi.mock("../../components/header/AppResourceDisplay", () => ({
  AppResourceDisplay: ({ folded, peek }: { folded?: boolean; peek?: number }) => (
    <i data-testid="resources" data-folded-prop={String(!!folded)} data-peek={peek ?? 0} />
  ),
}));
vi.mock("../../components/header/DevBuildIndicator", () => ({
  DevBuildIndicator: () => <i data-testid="devBuild" />,
}));

import { StatusCluster } from "../../components/header/StatusCluster";
import { useHeaderStatusStore } from "../../stores/headerStatus";
import { usePowerStore } from "../../stores/power";
import { useSettingsStore } from "../../stores/settings";

const updateSettings = vi.fn(() => Promise.resolve());

function folded(testId: string): string | null {
  return screen.getByTestId(testId).parentElement!.getAttribute("data-folded");
}

beforeEach(() => {
  usePowerStore.setState({ supported: false });
  useHeaderStatusStore.setState({
    reports: {
      vpn: { tone: "alert", label: "VPN failed" },
      machines: { tone: "attention", label: "Machines connecting" },
      resources: { tone: "ok", label: "CPU 3%" },
    },
  });
  useSettingsStore.setState({
    // The Machines menu is lazily split and mounted only while its feature is on.
    settings: { header_status_expanded: false, machines_enabled: true } as never,
    updateSettings,
  } as never);
});

afterEach(() => {
  cleanup();
  updateSettings.mockClear();
});

describe("StatusCluster", () => {
  it("folds failing members too while collapsed, and says so on the summary lamp", async () => {
    // VPN and Machines are pinned by default; folded here, the failing VPN must
    // stay folded.
    useSettingsStore.setState({
      settings: {
        header_status_expanded: false,
        machines_enabled: true,
        header_pins: { vpn: false, machines: false },
      } as never,
    } as never);
    render(<StatusCluster />);
    await screen.findByTestId("machines");
    for (const id of ["vpn", "machines", "resources"]) expect(folded(id)).toBe("true");
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle.getAttribute("title")).toContain("VPN failed");
    expect(toggle.querySelector("[aria-label]")).toBeTruthy();
  });

  it("collapses in the bar's narrowest tier without touching the saved choice", async () => {
    const updateSettings = vi.fn();
    useSettingsStore.setState({
      settings: { header_status_expanded: true, machines_enabled: true, header_pins: { vpn: false } } as never,
      updateSettings,
    } as never);
    const { rerender } = render(<StatusCluster />);
    await screen.findByTestId("machines");
    expect(folded("vpn")).toBe("false");
    rerender(<StatusCluster narrow />);
    expect(folded("vpn")).toBe("true");
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(updateSettings).not.toHaveBeenCalled();
    rerender(<StatusCluster />);
    expect(folded("vpn")).toBe("false");
  });

  it("keeps VPN and Machines in the bar by default while the rest folds", async () => {
    render(<StatusCluster />);
    await screen.findByTestId("machines");
    for (const id of ["vpn", "machines"]) expect(folded(id)).toBe("false");
    expect(folded("resources")).toBe("true");
  });

  it("tells the resource readout it is folded, and asks it for a reading on hover", () => {
    // Folded, the readout stops polling; the toggle's tooltip is its only reader,
    // so reaching the toggle is what asks for a fresh figure.
    render(<StatusCluster />);
    const readout = screen.getByTestId("resources");
    expect(readout.getAttribute("data-folded-prop")).toBe("true");
    expect(readout.getAttribute("data-peek")).toBe("0");
    fireEvent.pointerEnter(screen.getByRole("button", { expanded: false }));
    expect(screen.getByTestId("resources").getAttribute("data-peek")).toBe("1");
  });

  it("shows every member once expanded", async () => {
    useSettingsStore.setState({
      settings: { header_status_expanded: true, machines_enabled: true } as never,
    } as never);
    render(<StatusCluster />);
    await screen.findByTestId("machines");
    for (const id of ["vpn", "machines", "resources"]) expect(folded(id)).toBe("false");
    expect(screen.getByTestId("resources").getAttribute("data-folded-prop")).toBe("false");
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(updateSettings).toHaveBeenCalledWith({ header_status_expanded: false });
  });

  it("asks no backend about this machine's link in the browser client", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { markServerClient, resetLinkStateForTests } = await import("../../lib/transport/linkState");
    vi.mocked(invoke).mockClear();
    markServerClient();
    try {
      render(<StatusCluster />);
      await screen.findByTestId("machines");
      const asked = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
      expect(asked).not.toContain("network_conn_type");
      expect(asked).not.toContain("network_wifi_ssid");
    } finally {
      resetLinkStateForTests();
    }
  });

  it("mounts no Machines menu while the feature is off (perf plan §6)", async () => {
    useSettingsStore.setState({
      settings: { header_status_expanded: true, machines_enabled: false } as never,
    } as never);
    render(<StatusCluster />);
    // The other members are eager: once they are on screen, a mounted lazy
    // member would have had its chance to resolve too.
    await screen.findByTestId("vpn");
    await Promise.resolve();
    expect(screen.queryByTestId("machines")).toBeNull();
  });

  it("keeps the Machines menu mounted once it was on, so a pending sign-in survives switching it off", async () => {
    machinesLife.mounts = 0;
    machinesLife.unmounts = 0;
    render(<StatusCluster />);
    await screen.findByTestId("machines");
    const setMachines = (on: boolean) =>
      act(() => {
        useSettingsStore.setState({
          settings: { header_status_expanded: false, machines_enabled: on } as never,
        } as never);
      });
    setMachines(false);
    // The member's own `!enabled` branch hides it; the cluster must not unmount
    // it, or a "sign in in a terminal" add/edit loses its poll and form.
    expect(screen.getByTestId("machines")).toBeTruthy();
    setMachines(true);
    expect(machinesLife).toEqual({ mounts: 1, unmounts: 0 });
  });
});
