/**
 * A tunnel that dies on its own must be *noticed*, and noticing it must gate the
 * SSH/SFTP work belonging to the projects that were riding it.
 *
 * This is the failure this exists for: OpenVPN exits (it used to do so
 * permanently after three failed reconnects — see `openvpn_args`), the machine's
 * routing is left pointing into a tunnel with nothing behind it, and every
 * pooled-SSH call a remote project makes now aims at a peer that will never
 * answer. Those calls are synchronous Tauri commands, and a black-holed socket
 * yields no error, so each blocks ~45s until ssh's keepalive gives up. The file
 * tree issues one per visible folder. The app froze.
 *
 * `refresh()` is the only thing that reconciles against the backend, so the drop
 * has to be detected *there* — and it has to be distinguishable from a
 * deliberate disconnect, which must not be reported as a drop.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { useVpnStatusStore, markVpnConnected, disconnectVpnTunnel } from "../../stores/remote/vpn/vpnStatus";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";

const invokeMock = vi.mocked(invoke);
const CONFIG = "/store/office.ovpn";
const PROJECT = "p-remote";

/** What the backend reports as live on the next reconcile. */
function backendReports(configs: string[]) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "openvpn_active") return Promise.resolve(configs);
    return Promise.resolve();
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  useVpnStatusStore.setState({ byConfig: {}, holders: {} });
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
});

describe("a tunnel that dies unasked", () => {
  beforeEach(() => {
    markVpnConnected(PROJECT, CONFIG);
    useRemoteStatusStore.getState().setSsh(PROJECT, "connected");
  });

  it("is detected by the reconcile and clears the holder's remote status", async () => {
    backendReports([]); // the tunnel is simply gone
    await useVpnStatusStore.getState().refresh();

    expect(useVpnStatusStore.getState().byConfig[CONFIG]).toBeUndefined();
    // The gate: with the project's status cleared, `useRemoteBlocked` stops the
    // SFTP/git probes being dispatched at all, rather than each paying ~45s.
    expect(useRemoteStatusStore.getState().byProject[PROJECT]).toBeUndefined();
  });

  it("releases the claims, so a later reconnect is not seen as already held", async () => {
    backendReports([]);
    await useVpnStatusStore.getState().refresh();
    expect(useVpnStatusStore.getState().holders[CONFIG]).toBeUndefined();
  });

  it("leaves a project that never claimed the tunnel alone", async () => {
    // It reaches its host by some other route; this tunnel is none of its business.
    useRemoteStatusStore.getState().setSsh("p-other", "connected");
    backendReports([]);
    await useVpnStatusStore.getState().refresh();
    expect(useRemoteStatusStore.getState().byProject["p-other"]?.ssh).toBe("connected");
  });
});

describe("everything that is not a drop", () => {
  it("does not fire for a tunnel that is still up", async () => {
    markVpnConnected(PROJECT, CONFIG);
    useRemoteStatusStore.getState().setSsh(PROJECT, "connected");
    backendReports([CONFIG]);
    await useVpnStatusStore.getState().refresh();
    expect(useRemoteStatusStore.getState().byProject[PROJECT]?.ssh).toBe("connected");
  });

  it("does not fire for a deliberate disconnect", async () => {
    markVpnConnected(PROJECT, CONFIG);
    useRemoteStatusStore.getState().setSsh(PROJECT, "connected");
    // A UI teardown forgets the config first, so the next reconcile sees neither
    // side and must not mistake it for a death.
    disconnectVpnTunnel(CONFIG);
    useRemoteStatusStore.getState().setSsh(PROJECT, "connected");
    backendReports([]);
    await useVpnStatusStore.getState().refresh();
    expect(useRemoteStatusStore.getState().byProject[PROJECT]?.ssh).toBe("connected");
  });

  it("does not fire for a tunnel still mid-handshake", async () => {
    useVpnStatusStore.getState().setState(CONFIG, "connecting");
    useVpnStatusStore.getState().acquire(CONFIG, PROJECT);
    useRemoteStatusStore.getState().setSsh(PROJECT, "connecting");
    backendReports([]); // not in the registry yet — that is normal, not a death
    await useVpnStatusStore.getState().refresh();
    expect(useVpnStatusStore.getState().byConfig[CONFIG]).toBe("connecting");
    expect(useRemoteStatusStore.getState().byProject[PROJECT]?.ssh).toBe("connecting");
  });

  it("does nothing when the backend cannot be reached at all", async () => {
    markVpnConnected(PROJECT, CONFIG);
    useRemoteStatusStore.getState().setSsh(PROJECT, "connected");
    invokeMock.mockImplementation(() => Promise.reject(new Error("backend gone")));
    await useVpnStatusStore.getState().refresh();
    // No answer is not evidence the tunnel died — the state must be left alone.
    expect(useVpnStatusStore.getState().byConfig[CONFIG]).toBe("connected");
    expect(useRemoteStatusStore.getState().byProject[PROJECT]?.ssh).toBe("connected");
  });
});

describe("a tunnel that dies unasked says why", () => {
  const backendEnds = (reason: unknown) =>
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "openvpn_active") return Promise.resolve([]);
      if (cmd === "openvpn_exit_reason") return Promise.resolve(reason);
      return Promise.resolve();
    });

  beforeEach(() => {
    useVpnStatusStore.setState({ ended: {} });
    markVpnConnected(PROJECT, CONFIG);
  });

  it("records the backend's reason, and a new connect clears it", async () => {
    backendEnds({ kind: "inactive", line: "SIGTERM[soft,inactive] received, process exiting" });
    await useVpnStatusStore.getState().refresh();

    expect(invokeMock).toHaveBeenCalledWith("openvpn_exit_reason", { config: CONFIG });
    expect(useVpnStatusStore.getState().ended[CONFIG]).toMatchObject({
      kind: "inactive",
      line: "SIGTERM[soft,inactive] received, process exiting",
    });

    // The tunnel coming up again is the end of "it ended".
    useVpnStatusStore.getState().setState(CONFIG, "connecting");
    expect(useVpnStatusStore.getState().ended[CONFIG]).toBeUndefined();
  });

  it("reads a kind it does not know, or no answer, as no reason given", async () => {
    backendEnds({ kind: "something_newer", line: "" });
    await useVpnStatusStore.getState().refresh();
    expect(useVpnStatusStore.getState().ended[CONFIG]).toMatchObject({ kind: "unknown", line: null });

    useVpnStatusStore.setState({ ended: {} });
    markVpnConnected(PROJECT, CONFIG);
    backendEnds(null);
    await useVpnStatusStore.getState().refresh();
    expect(useVpnStatusStore.getState().ended[CONFIG]).toMatchObject({ kind: "unknown", line: null });
  });

  it("is not recorded for a tunnel the user disconnected", async () => {
    backendEnds({ kind: "inactive", line: "x" });
    disconnectVpnTunnel(CONFIG);
    await useVpnStatusStore.getState().refresh();
    expect(useVpnStatusStore.getState().ended[CONFIG]).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalledWith("openvpn_exit_reason", { config: CONFIG });
  });
});
