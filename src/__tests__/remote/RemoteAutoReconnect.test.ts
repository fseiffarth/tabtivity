/**
 * The event-driven half of remote auto-connect (`lib/remote/remoteAutoReconnect`):
 * a tunnel *rising* to connected re-tries the active remote project and sweeps
 * the armed global machines; the sweep is behind the Machines feature switch
 * and waits for settings to be **loaded** (an unloaded store reads as "off");
 * a second install is a no-op so one tunnel-up never fans out twice. The sweep
 * ends by re-running the active project's auto-connect, since an armed machine
 * counts as the opt-in of the project host that is the same login.
 *
 * `installed` is module state, so every test takes a fresh module graph.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../../stores/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../stores/projects")>()),
  retryAutoConnectAfterVpn: vi.fn(),
}));

/** Let the async sweep (`await whenSettingsLoaded()` → `await load()`) settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

async function fresh(opts: { machinesEnabled?: boolean; loaded?: boolean; gmLoaded?: boolean } = {}) {
  vi.resetModules();
  const { useSettingsStore } = await import("../../stores/settings");
  const { useGlobalMachinesStore } = await import("../../stores/remote/globalMachines");
  const { useVpnStatusStore } = await import("../../stores/remote/vpn/vpnStatus");
  const projects = await import("../../stores/projects");
  const retry = vi.mocked(projects.retryAutoConnectAfterVpn);
  const load = vi.fn(async () => {
    useGlobalMachinesStore.setState({ loaded: true });
  });
  const autoConnect = vi.fn(async () => {});
  useSettingsStore.setState({
    settings: opts.loaded === false ? null : { machines_enabled: opts.machinesEnabled ?? false },
    loaded: opts.loaded ?? true,
  });
  useGlobalMachinesStore.setState({ loaded: opts.gmLoaded ?? true, load, autoConnect });
  useVpnStatusStore.setState({ byConfig: {}, holders: {} });
  const { initRemoteAutoReconnect } = await import("../../lib/remote/remoteAutoReconnect");
  return { useSettingsStore, useGlobalMachinesStore, useVpnStatusStore, retry, load, autoConnect, initRemoteAutoReconnect };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("launch-time machine sweep", () => {
  it("connects nothing while the Machines feature is off", async () => {
    const f = await fresh({ machinesEnabled: false });
    f.initRemoteAutoReconnect();
    await settle();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.autoConnect).not.toHaveBeenCalled();
    // No sweep, so no project retry behind it either.
    expect(f.retry).not.toHaveBeenCalled();
  });

  it("loads the machine list once and sweeps it when the feature is on", async () => {
    const f = await fresh({ machinesEnabled: true, gmLoaded: false });
    f.initRemoteAutoReconnect();
    await settle();
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.autoConnect).toHaveBeenCalledTimes(1);
    // …then the active project, whose hosts an armed machine may opt in.
    expect(f.retry).toHaveBeenCalledTimes(1);
    expect(f.autoConnect.mock.invocationCallOrder[0]).toBeLessThan(
      f.retry.mock.invocationCallOrder[0],
    );
  });

  it("waits for settings to be loaded rather than reading an empty store as off", async () => {
    const f = await fresh({ loaded: false });
    f.initRemoteAutoReconnect();
    await settle();
    expect(f.autoConnect).not.toHaveBeenCalled();
    f.useSettingsStore.setState({ settings: { machines_enabled: true }, loaded: true });
    await settle();
    expect(f.autoConnect).toHaveBeenCalledTimes(1);
  });
});

describe("tunnel-up reaction", () => {
  it("retries the project and sweeps the machines on the exact → connected transition", async () => {
    const f = await fresh({ machinesEnabled: true });
    f.initRemoteAutoReconnect();
    await settle();
    f.autoConnect.mockClear();
    f.retry.mockClear();

    f.useVpnStatusStore.getState().setState("/lab.ovpn", "connecting");
    await settle();
    expect(f.retry).not.toHaveBeenCalled();
    expect(f.autoConnect).not.toHaveBeenCalled();

    f.useVpnStatusStore.getState().setState("/lab.ovpn", "connected");
    await settle();
    // Once at once (the tunnel's own reach), once after the machine sweep.
    expect(f.retry).toHaveBeenCalledTimes(2);
    expect(f.autoConnect).toHaveBeenCalledTimes(1);

    // A repeated "connected" collapses in the store; a drop is nobody's cue.
    f.useVpnStatusStore.getState().setState("/lab.ovpn", "connected");
    f.useVpnStatusStore.getState().setState("/lab.ovpn", "off");
    await settle();
    expect(f.retry).toHaveBeenCalledTimes(2);
    expect(f.autoConnect).toHaveBeenCalledTimes(1);
  });

  it("fires for a tunnel seated by refresh that prev had no entry for", async () => {
    const f = await fresh({ machinesEnabled: false });
    f.initRemoteAutoReconnect();
    await settle();
    // What `refresh()` does at launch for a tunnel that outlived a previous run.
    f.useVpnStatusStore.setState({ byConfig: { "/lab.ovpn": "connected" } });
    await settle();
    expect(f.retry).toHaveBeenCalledTimes(1);
    // …and the machine sweep still honours the feature switch on this path.
    expect(f.autoConnect).not.toHaveBeenCalled();
  });

  it("installs once — a second init does not double the fan-out", async () => {
    const f = await fresh({ machinesEnabled: true });
    f.initRemoteAutoReconnect();
    f.initRemoteAutoReconnect();
    await settle();
    expect(f.autoConnect).toHaveBeenCalledTimes(1);
    f.retry.mockClear();
    f.useVpnStatusStore.getState().setState("/lab.ovpn", "connected");
    await settle();
    expect(f.retry).toHaveBeenCalledTimes(2);
    expect(f.autoConnect).toHaveBeenCalledTimes(2);
  });
});
