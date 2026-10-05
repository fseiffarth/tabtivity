/**
 * The machine-level VPN auto-connect, and the rule that makes it safe to have.
 *
 * A tunnel is not a project's: it reroutes the whole computer for as long as it is
 * up. So "connect on launch" is armed on the *config*, in the header's VPN menu, and
 * it carries the same promise the project-side opt-in does — **it never prompts**.
 * The opt-in is re-checked at launch rather than trusted, so credentials forgotten
 * since it was ticked leave the tunnel down instead of ambushing the user with a
 * modal during startup.
 *
 * The load-bearing detail is *why the check comes first*. Bringing a tunnel up is
 * elevated (`pkexec openvpn`), and polkit authenticates the user before OpenVPN has
 * looked at the config at all — so an attempt that was always going to be rejected
 * does not fail cheaply, it costs a system password dialog. Trying and falling back
 * to the modal therefore cost *two* system prompts for one tunnel, which is exactly
 * what the header's connect did to any `auth-user-pass` config with no project behind
 * it: the username lived only on a project's spec. Never elevate on a connect that
 * cannot succeed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }),
}));

import type { Settings } from "../../types";

const invokeMock = vi.mocked(invoke);

const CONFIG = "/store/office.ovpn";

/** Drive the mocked backend: `silent` is what `vpn_can_connect_silently` answers,
 *  `active` what `openvpn_active` reports as already up, and `connect` whether an
 *  actual `openvpn_connect` succeeds. */
const backend = (opts: { silent?: boolean; active?: string[]; connect?: "ok" | "fail" }) => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "vpn_can_connect_silently":
        return Promise.resolve(opts.silent ?? false);
      case "openvpn_active":
        return Promise.resolve(opts.active ?? []);
      case "openvpn_connect":
        return opts.connect === "fail"
          ? Promise.reject(new Error("AUTH_FAILED"))
          : Promise.resolve();
      default:
        return Promise.resolve();
    }
  });
};

/**
 * One launch, in a pristine module graph: `autoConnectVpnOnLaunch` is
 * once-per-process by design (a re-mount must not re-connect), so each test needs its
 * own instance of it — and, since the module closes over the stores it imports, its
 * own instance of *those*. Seeding must therefore happen inside this graph, not
 * outside it. Returns the store the assertions read.
 */
async function launch(seed: Partial<Settings>) {
  vi.resetModules();
  const [{ autoConnectVpnOnLaunch }, { useSettingsStore }, { useVpnStatusStore }] =
    await Promise.all([
      import("../../lib/remote/vpn/vpnAutoConnect"),
      import("../../stores/settings"),
      import("../../stores/remote/vpn/vpnStatus"),
    ]);
  useSettingsStore.setState({ settings: seed as Settings, loaded: true });
  await autoConnectVpnOnLaunch();
  return useVpnStatusStore.getState().byConfig;
}

const calls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

describe("VPN auto-connect (machine-level)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("does nothing at all when no config is armed", async () => {
    backend({ silent: true });
    const byConfig = await launch({});
    expect(calls("openvpn_connect")).toHaveLength(0);
    expect(byConfig).toEqual({});
  });

  it("brings the armed tunnel up silently on launch", async () => {
    backend({ silent: true });
    const byConfig = await launch({ vpn_auto_connect: CONFIG });

    expect(calls("openvpn_connect")).toHaveLength(1);
    // No checkbox behind a silent connect: the keychain must be left as found, or the
    // connect deletes the very credentials it just authenticated with.
    expect(calls("openvpn_connect")[0][1]).toMatchObject({
      config: CONFIG,
      password: null,
      remember: null,
    });
    expect(byConfig[CONFIG]).toBe("connected");
  });

  /** The promise: a stale opt-in degrades to staying down — no modal, and (because a
   *  `pkexec` attempt IS the polkit prompt) no elevation either. */
  it("stays down, and never elevates, when the credentials no longer allow a silent connect", async () => {
    backend({ silent: false });
    const byConfig = await launch({ vpn_auto_connect: CONFIG });

    expect(calls("openvpn_connect")).toHaveLength(0);
    expect(byConfig[CONFIG]).toBeUndefined();
  });

  it("leaves a tunnel that outlived the last run alone", async () => {
    backend({ silent: true, active: [CONFIG] });
    const byConfig = await launch({ vpn_auto_connect: CONFIG });

    expect(calls("openvpn_connect")).toHaveLength(0);
    expect(byConfig[CONFIG]).toBe("connected");
  });

  it("goes dark rather than half-lit when the connect fails", async () => {
    backend({ silent: true, connect: "fail" });
    const byConfig = await launch({ vpn_auto_connect: CONFIG });

    // A tunnel that never came up is rerouting nothing; the header must not claim it is.
    expect(byConfig[CONFIG]).toBeUndefined();
  });

  /** Non-headless: Tabtivity handles no passwords, so "connect on launch" can only mean
   *  "the connect command is waiting in the root terminal" — never a silent connect. */
  it("opens the connect command in the root terminal when headless connections are off", async () => {
    backend({ silent: true });
    const byConfig = await launch({ vpn_auto_connect: CONFIG, connections_headless: false });

    expect(calls("openvpn_connect")).toHaveLength(0);
    expect(calls("openvpn_login_command")).toHaveLength(1);
    expect(byConfig[CONFIG]).toBe("connecting");
  });
});
