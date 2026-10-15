/**
 * The escape hatch out of a headless VPN login that cannot work.
 *
 * Tabtivity's own login models exactly two secrets — an account password and a key
 * passphrase. A config whose server asks anything else (a challenge/OTP, a prompt of
 * its own) is unanswerable from the modal, and the symptom is a loop the user cannot
 * get out of: the saved credentials fail, the prompt opens, the password typed into
 * it fails too. So the prompt can hand *that one connect* to the non-headless flow —
 * a root-terminal login tab runs OpenVPN itself (`TabEntry.login`) and OpenVPN asks
 * its own questions there.
 *
 * Two things are load-bearing, and both are asserted here.
 *
 *  1. **It is a local switch.** `connections_headless` is the user's statement about
 *     how Tabtivity should behave; a failed handshake does not get to rewrite it.
 *  2. **The rejection is not a failure.** `request()` rejects (the tunnel is not up,
 *     so resolving would be a lie), but the attempt is alive — the lamp is amber and
 *     the poll owns the outcome. A caller reading it as "no tunnel" would paint a
 *     login the user is still typing red, which is why the sentinel exists.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }),
}));

const invokeMock = vi.mocked(invoke);

const CONFIG = "/store/office.ovpn";

/** The backend as the handoff sees it: it builds no command line any more (the
 *  login tab's PTY runs OpenVPN, built backend-side from the config at spawn). */
const backend = () => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "openvpn_status":
        return Promise.resolve(false);
      case "openvpn_active":
        return Promise.resolve([]);
      default:
        return Promise.resolve();
    }
  });
};

/** A pristine module graph per test: the stores are module singletons, and the
 *  handoff writes to three of them (prompt, tunnel state, tabs). */
async function graph() {
  vi.resetModules();
  const [prompt, vpnStatus, tabs, settings] = await Promise.all([
    import("../../stores/remote/vpn/vpnPrompt"),
    import("../../stores/remote/vpn/vpnStatus"),
    import("../../stores/tabs"),
    import("../../stores/settings"),
  ]);
  return { ...prompt, ...vpnStatus, useTabsStore: tabs.useTabsStore, ...settings };
}

const calls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

describe("VPN terminal handoff", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("opens the login in a root terminal and rejects the caller with the handoff sentinel", async () => {
    backend();
    const g = await graph();
    const store = g.useVpnPromptStore.getState();

    const request = store.request(CONFIG, "office", null);
    const rejected = request.catch((e) => e);
    await g.useVpnPromptStore.getState().handoffToTerminal();

    // A root login tab for the config — its PTY runs OpenVPN (the spawn is what
    // builds the argv and arms the tunnel backend-side); nothing is typed into a
    // shell. The tab lands once root has been restored (`openTabInRootConsole`): a
    // root never opened this session is hydrated before anything is added to it.
    await vi.waitFor(() => {
      const rootTabs = g.useTabsStore.getState().tabsByScope.root ?? [];
      expect(rootTabs[rootTabs.length - 1]).toMatchObject({
        kind: "shell",
        login: { kind: "vpn", config: CONFIG },
      });
    });
    const rootTabs = g.useTabsStore.getState().tabsByScope.root ?? [];
    expect(rootTabs[rootTabs.length - 1].initialInput).toBeUndefined();

    // The tunnel is coming up, not failed: amber, with the poll behind it.
    expect(g.useVpnStatusStore.getState().byConfig[CONFIG]).toBe("connecting");

    // The modal is gone and the caller was told *why* — a handoff, not a failure.
    expect(g.useVpnPromptStore.getState().pending).toBeNull();
    expect(g.isVpnTerminalHandoff(await rejected)).toBe(true);
  });

  /** The whole point of "locally": the setting is the user's statement about how
   *  Tabtivity should behave, and one config's broken handshake must not rewrite it. */
  it("never touches the global connections_headless setting", async () => {
    backend();
    const g = await graph();
    g.useSettingsStore.setState({ settings: { connections_headless: true } as never, loaded: true });

    void g.useVpnPromptStore.getState().request(CONFIG, "office", null).catch(() => {});
    await g.useVpnPromptStore.getState().handoffToTerminal();

    expect(g.useSettingsStore.getState().settings?.connections_headless).toBe(true);
    expect(calls("update_settings")).toHaveLength(0);
  });

  /** A headless attempt in flight would tear the terminal tunnel back down when it
   *  settles — `submit`'s superseded-guard disconnects *by config*, and both flavours
   *  register under the same one. So the handoff stands down instead. */
  it("does nothing while a headless attempt is still in flight", async () => {
    backend();
    const g = await graph();

    void g.useVpnPromptStore.getState().request(CONFIG, "office", null).catch(() => {});
    g.useVpnPromptStore.setState({ status: "connecting" });
    await g.useVpnPromptStore.getState().handoffToTerminal();

    // No login opened: the handoff moves the machine lamp before it opens the tab.
    expect(g.useVpnStatusStore.getState().byConfig[CONFIG]).toBeUndefined();
    expect(g.useTabsStore.getState().tabsByScope.root ?? []).toHaveLength(0);
    expect(g.useVpnPromptStore.getState().pending).not.toBeNull();
  });
});
