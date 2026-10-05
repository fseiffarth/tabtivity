/**
 * The VPN gate for network accounts (`lib/remote/vpn/vpnGate.ts`): a `require_vpn` account
 * is skipped while no tunnel Tabtivity knows about is up, and the hook the
 * schedulers use for their catch-up says *nothing* — `null` — until the store
 * has reconciled against the backend once, so a tunnel that was up all along is
 * never mistaken for one that just came up.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { useVpnStatusStore } from "../../stores/remote/vpn/vpnStatus";
import { anyTunnelUp, useVpnTunnelUp, vpnGateAllows, vpnTunnelUp } from "../../lib/remote/vpn/vpnGate";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  useVpnStatusStore.setState({ byConfig: {}, holders: {}, reconciled: false });
  invokeMock.mockReset();
});

describe("vpnGate", () => {
  it("only a connected tunnel counts as up", () => {
    expect(anyTunnelUp({})).toBe(false);
    expect(anyTunnelUp({ "/a.ovpn": "connecting" })).toBe(false);
    expect(anyTunnelUp({ "/a.ovpn": "error" })).toBe(false);
    expect(anyTunnelUp({ "/a.ovpn": "error", "/b.ovpn": "connected" })).toBe(true);
  });

  it("an ungated account may always connect; a gated one only while a tunnel is up", () => {
    expect(vpnGateAllows({}, false)).toBe(true);
    expect(vpnGateAllows({ require_vpn: false }, false)).toBe(true);
    expect(vpnGateAllows({ require_vpn: true }, false)).toBe(false);
    expect(vpnGateAllows({ require_vpn: true }, true)).toBe(true);
  });

  it("the live read follows the store", () => {
    expect(vpnTunnelUp()).toBe(false);
    useVpnStatusStore.getState().setState("/a.ovpn", "connected");
    expect(vpnTunnelUp()).toBe(true);
    useVpnStatusStore.getState().setState("/a.ovpn", "off");
    expect(vpnTunnelUp()).toBe(false);
  });

  it("the hook says null until the first reconcile, then the real answer", async () => {
    const { result } = renderHook(() => useVpnTunnelUp());
    expect(result.current).toBeNull();

    // A tunnel found up by the first reconcile is `null → true`: not a rise.
    invokeMock.mockResolvedValueOnce(["/a.ovpn"]);
    await act(async () => {
      await useVpnStatusStore.getState().refresh();
    });
    expect(result.current).toBe(true);

    // It dying, then coming back, is the `false → true` the schedulers act on.
    invokeMock.mockResolvedValueOnce([]);
    await act(async () => {
      await useVpnStatusStore.getState().refresh();
    });
    expect(result.current).toBe(false);
    invokeMock.mockResolvedValueOnce(["/a.ovpn"]);
    await act(async () => {
      await useVpnStatusStore.getState().refresh();
    });
    expect(result.current).toBe(true);
  });

  it("a failed reconcile leaves the store unreconciled", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no backend"));
    await useVpnStatusStore.getState().refresh();
    expect(useVpnStatusStore.getState().reconciled).toBe(false);
  });
});
