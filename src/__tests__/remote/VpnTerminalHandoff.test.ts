/**
 * The escape hatch out of a headless VPN login that cannot work.
 *
 * Tabtivity's own login models exactly two secrets — an account password and a key
 * passphrase. A config whose server asks anything else (a challenge/OTP, a prompt of
 * its own) is unanswerable from the modal, and the symptom is a loop the user cannot
 * get out of: the saved credentials fail, the prompt opens, the password typed into
 * it fails too. So the prompt can hand *that one connect* to the non-headless flow —
 * the connect command goes to a root-terminal tab and OpenVPN asks its own questions
 * there.
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
const COMMAND = "pkexec openvpn --config /store/office.ovpn";

/** A backend that can build the login command (the only call the handoff makes on
 *  its way to the terminal) — or, with `build: "fail"`, one that cannot. */
const backend = (opts: { build?: "ok" | "fail" } = {}) => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "openvpn_login_command":
        return opts.build === "fail"
          ? Promise.reject(new Error("no openvpn on PATH"))
          : Promise.resolve(COMMAND);
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

    // The command was built (which is also what arms the tunnel backend-side) and
    // typed into a freshly-spawned root tab.
    expect(calls("openvpn_login_command")).toHaveLength(1);
    // The tab lands once root has been restored (`openTabInRootConsole`): a root
    // never opened this session is hydrated before anything is added to it.
    await vi.waitFor(() => {
      const rootTabs = g.useTabsStore.getState().tabsByScope.root ?? [];
      expect(rootTabs[rootTabs.length - 1]).toMatchObject({ kind: "shell", initialInput: COMMAND });
    });

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

    expect(calls("openvpn_login_command")).toHaveLength(0);
    expect(g.useVpnPromptStore.getState().pending).not.toBeNull();
  });

  /** A handoff that could not even be built opened nothing and moved no lamp, so the
   *  modal must stay exactly where it was — the user still needs somewhere to be. */
  it("keeps the modal open when the login command can't be built", async () => {
    backend({ build: "fail" });
    const g = await graph();

    void g.useVpnPromptStore.getState().request(CONFIG, "office", null).catch(() => {});
    await g.useVpnPromptStore.getState().handoffToTerminal();

    expect(g.useVpnPromptStore.getState().pending).not.toBeNull();
    expect(g.useVpnPromptStore.getState().status).toBe("error");
    expect(g.useVpnStatusStore.getState().byConfig[CONFIG]).toBeUndefined();
    expect(g.useTabsStore.getState().tabsByScope.root ?? []).toHaveLength(0);
  });
});
