/**
 * The OpenVPN tunnel is a machine-level object, not a project's property.
 *
 * `pkexec openvpn --config …` runs as root with no routing flags from Tabtivity, so a
 * config that pushes `redirect-gateway` reroutes the *whole computer* — browser and
 * all — for as long as it is up. Two things follow, and both are locked here:
 *
 *  1. **It is shared.** Tunnels are keyed by config path, so two projects on the
 *     same `.ovpn` ride one tunnel. Logging out of one must not pull it out from
 *     under the other (and out from under the OS). That was the bug: `logoutRemote`
 *     and the Connect modal's Disconnect both called `openvpn_disconnect`
 *     unconditionally.
 *  2. **It outlives the project view.** A tunnel stays up when you switch away, so
 *     the header indicator — not the project pill — is where it has to be visible,
 *     and where it can be brought down.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  // Every settings write now broadcasts the whole object so the other windows'
  // stores follow it (Group B #226) — including this test's `setVpnAutoConnect`.
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(() => Promise.resolve(null)) }));

import { VpnIndicator } from "../../components/header/VpnIndicator";
import { useProjectsStore, logoutRemote } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { markVpnConnected, useVpnStatusStore } from "../../stores/remote/vpn/vpnStatus";
import { useVpnPromptStore } from "../../stores/remote/vpn/vpnPrompt";
import { useSettingsStore } from "../../stores/settings";
import type { ProjectEntry } from "../../types";

const invokeMock = vi.mocked(invoke);
const openDialogMock = vi.mocked(openDialog);

const CONFIG = "/store/office.ovpn";

const project = (id: string, name: string): ProjectEntry =>
  ({
    id,
    name,
    directory: `/local/state/${id}`,
    position: 0,
    status: "active",
    remote: {
      user: "alice",
      host: "host.example",
      remote_path: "/srv/work",
      openvpn: { config: CONFIG },
    },
  }) as unknown as ProjectEntry;

const A = project("p1", "alpha");
const B = project("p2", "beta");

const disconnects = () =>
  invokeMock.mock.calls.filter(([name]) => name === "openvpn_disconnect");

beforeEach(() => {
  invokeMock.mockReset();
  openDialogMock.mockReset();
  openDialogMock.mockResolvedValue(null);
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "openvpn_active") return Promise.resolve([]);
    return Promise.resolve();
  });
  useProjectsStore.setState({ projects: [A, B] } as never);
  useRemoteStatusStore.setState({ byProject: {} } as never);
  useVpnStatusStore.setState({ byConfig: {}, holders: {} });
  // The header indicator is off by default (Settings' "Remote features"); these
  // tests are specifically about that surface, so opt in.
  useSettingsStore.setState({ settings: { vpn_enabled: true } as never });
});

describe("a shared tunnel is refcounted by holder", () => {
  it("survives one holder logging out, and comes down with the last", () => {
    // Both projects are on the same .ovpn — one tunnel, two holders.
    markVpnConnected(A.id, CONFIG);
    markVpnConnected(B.id, CONFIG);
    expect(useVpnStatusStore.getState().holders[CONFIG]).toEqual([A.id, B.id]);

    // THE BUG: this used to fire openvpn_disconnect unconditionally, killing the
    // tunnel B is still riding — and the machine's routing with it.
    logoutRemote(A);
    expect(disconnects()).toEqual([]);
    expect(useVpnStatusStore.getState().byConfig[CONFIG]).toBe("connected");
    expect(useVpnStatusStore.getState().holders[CONFIG]).toEqual([B.id]);

    // Last one out turns off the lights.
    logoutRemote(B);
    expect(disconnects()).toEqual([["openvpn_disconnect", { config: CONFIG }]]);
    expect(useVpnStatusStore.getState().byConfig[CONFIG]).toBeUndefined();
  });

  it("brings the tunnel down for a lone holder", () => {
    markVpnConnected(A.id, CONFIG);
    logoutRemote(A);
    expect(disconnects()).toEqual([["openvpn_disconnect", { config: CONFIG }]]);
  });
});

/** Report the tunnel as live to the backend-reconcile (`refresh`) too, so the
 *  mount-time reseat doesn't drop a tunnel the test just brought up. */
const backendReports = (...configs: string[]) =>
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "openvpn_active") return Promise.resolve(configs);
    if (cmd === "openvpn_list_configs") return Promise.resolve([]);
    return Promise.resolve();
  });

describe("the header indicator is the tunnel's own surface", () => {
  it("appears whenever a tunnel is up — even with no project holding it", async () => {
    // The reload/crash case: the tunnel outlived the renderer, so nothing in the
    // frontend claims it. It is still rerouting the machine, so it is still shown.
    backendReports(CONFIG);
    render(<VpnIndicator />);

    const btn = await screen.findByRole("button", { name: /openvpn/i });
    await userEvent.hover(btn);
    expect(screen.getByText("office.ovpn")).toBeTruthy();
    // Nothing holds it, so the dropdown says nothing about holders at all.
    expect(screen.queryByText(/^for /i)).toBeNull();
  });

  it("names the holders and can bring the tunnel down for all of them", async () => {
    backendReports(CONFIG);
    markVpnConnected(A.id, CONFIG);
    markVpnConnected(B.id, CONFIG);
    render(<VpnIndicator />);

    await userEvent.hover(screen.getByRole("button", { name: /openvpn/i }));
    expect(screen.getByText(/for alpha, beta/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /disconnect tunnel/i }));
    await waitFor(() =>
      expect(disconnects()).toEqual([["openvpn_disconnect", { config: CONFIG }]]),
    );
    // Every claim dropped: the user acted on the tunnel, not on a project.
    expect(useVpnStatusStore.getState().holders[CONFIG]).toBeUndefined();
    expect(useVpnStatusStore.getState().byConfig[CONFIG]).toBeUndefined();
  });
});

describe("the tunnel state follows the backend", () => {
  it("reconciles away a tunnel the backend no longer reports", async () => {
    // The tunnel died (or was killed outside Tabtivity). The indicator must not keep
    // claiming the machine is being rerouted when it isn't.
    markVpnConnected(A.id, CONFIG);
    await useVpnStatusStore.getState().refresh();
    expect(useVpnStatusStore.getState().byConfig[CONFIG]).toBeUndefined();
  });

  it("keeps an in-flight tunnel the backend cannot see yet", async () => {
    // Mid-handshake: not in the backend registry until it comes up. Reconciling it
    // away would blank the indicator while the tunnel is actively being built.
    useVpnStatusStore.getState().setState(CONFIG, "connecting");
    await useVpnStatusStore.getState().refresh();
    expect(useVpnStatusStore.getState().byConfig[CONFIG]).toBe("connecting");
  });
});

describe("the header can bring a tunnel up, with no project behind it", () => {
  // A VPN is something you use, not only a precondition for an SSH project — and
  // requiring a project just to reach the tunnel was backwards.
  const STORED = [{ path: CONFIG, name: "office.ovpn" }];

  it("offers each stored config, and connects it from the saved passphrase", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "openvpn_active") return Promise.resolve([]);
      if (cmd === "openvpn_list_configs") return Promise.resolve(STORED);
      if (cmd === "vpn_can_connect_silently") return Promise.resolve(true);
      return Promise.resolve();
    });
    render(<VpnIndicator />);

    await userEvent.hover(screen.getByRole("button", { name: /openvpn/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^connect$/i }));

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([name]) => name === "openvpn_connect"),
      ).toHaveLength(1),
    );
    // Up, and held by nobody: it was not brought up on any project's behalf.
    await waitFor(() =>
      expect(useVpnStatusStore.getState().byConfig[CONFIG]).toBe("connected"),
    );
    expect(useVpnStatusStore.getState().holders[CONFIG]).toBeUndefined();
    // `remember: null` — no checkbox behind this call, so the keychain is untouched.
    const [, args] = invokeMock.mock.calls.find(([name]) => name === "openvpn_connect")!;
    expect((args as { remember: unknown }).remember).toBeNull();
  });

  /**
   * Elevation is not free, and a rejected login is not cheap.
   *
   * `pkexec` authenticates the *user* before OpenVPN so much as reads the config, so a
   * connect attempt that was always going to be rejected still costs a polkit dialog —
   * and the modal that then opens to collect what was missing costs a second one. That
   * is what this menu did to every `auth-user-pass` config with no project behind it:
   * the username lives on a project's spec, the header had none to give, so each
   * connect burned two system password prompts. The fix is to ask whether the connect
   * would be silent *before* making it, and go straight to the modal when it wouldn't.
   */
  it("never elevates on a connect it knows cannot succeed — it asks first", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "openvpn_active") return Promise.resolve([]);
      if (cmd === "openvpn_list_configs") return Promise.resolve(STORED);
      // Credentials incomplete (e.g. a username this side has never seen).
      if (cmd === "vpn_can_connect_silently") return Promise.resolve(false);
      return Promise.resolve();
    });
    render(<VpnIndicator />);

    await userEvent.hover(screen.getByRole("button", { name: /openvpn/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^connect$/i }));

    // The modal owns the connect from here. Crucially, no `openvpn_connect` was fired
    // on the way to it: that call *is* the polkit prompt.
    await waitFor(() => expect(useVpnPromptStore.getState().pending?.config).toBe(CONFIG));
    expect(invokeMock.mock.calls.filter(([name]) => name === "openvpn_connect")).toHaveLength(0);
  });

  /**
   * With nothing stored, the header used to be a dead end: it told you to go add a
   * config from some project's Connect dialog. A VPN with no project has no such
   * dialog. So the empty state now carries a Connect button that browses for a
   * `.ovpn`, stores it, and brings it straight up — no project required.
   */
  it("with no config stored, Add config browses for a .ovpn and stores it without dialling", async () => {
    const PICKED = "/home/alice/Downloads/office.ovpn";
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "openvpn_active") return Promise.resolve([]);
      if (cmd === "openvpn_list_configs") return Promise.resolve([]); // nothing stored yet
      if (cmd === "openvpn_store_config") return Promise.resolve(CONFIG); // copied into the store
      if (cmd === "vpn_can_connect_silently") return Promise.resolve(true);
      return Promise.resolve();
    });
    openDialogMock.mockResolvedValue(PICKED);
    render(<VpnIndicator />);

    await userEvent.hover(screen.getByRole("button", { name: /openvpn/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^add config…$/i }));

    // The picked file is copied into Tabtivity's store…
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([name]) => name === "openvpn_store_config"),
      ).toEqual([["openvpn_store_config", { config: PICKED }]]),
    );
    // …and then it is only *listed*, never auto-dialled: connecting is a separate,
    // explicit click on its row (where the password prompt lives).
    expect(invokeMock.mock.calls.filter(([name]) => name === "openvpn_connect")).toHaveLength(0);
    await waitFor(() => expect(screen.getByText("office.ovpn")).toBeTruthy());
    expect(useVpnStatusStore.getState().byConfig[CONFIG]).toBeUndefined();
  });

  it("cancelling the file browse adds nothing", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "openvpn_active") return Promise.resolve([]);
      if (cmd === "openvpn_list_configs") return Promise.resolve([]);
      return Promise.resolve();
    });
    openDialogMock.mockResolvedValue(null); // user hit Cancel
    render(<VpnIndicator />);

    await userEvent.hover(screen.getByRole("button", { name: /openvpn/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^add config…$/i }));

    expect(invokeMock.mock.calls.filter(([name]) => name === "openvpn_store_config")).toHaveLength(0);
    expect(invokeMock.mock.calls.filter(([name]) => name === "openvpn_connect")).toHaveLength(0);
  });

  /**
   * A VPN need not belong to a project, so adding another `.ovpn` can't require
   * opening some project's Connect dialog. Even with configs already listed, an
   * "Add config…" action stores + lists a new one — connecting stays an explicit
   * per-row click (with its password prompt), never an auto-dial.
   */
  it("with configs stored, Add config adds a different .ovpn without dialling it", async () => {
    const OTHER_STORED = "/store/other.ovpn";
    const PICKED = "/home/alice/Downloads/other.ovpn";
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "openvpn_active") return Promise.resolve([]);
      if (cmd === "openvpn_list_configs") return Promise.resolve(STORED); // office.ovpn already stored
      if (cmd === "openvpn_store_config") return Promise.resolve(OTHER_STORED);
      if (cmd === "vpn_can_connect_silently") return Promise.resolve(true);
      return Promise.resolve();
    });
    openDialogMock.mockResolvedValue(PICKED);
    render(<VpnIndicator />);

    await userEvent.hover(screen.getByRole("button", { name: /openvpn/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^add config…$/i }));

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([name]) => name === "openvpn_store_config"),
      ).toEqual([["openvpn_store_config", { config: PICKED }]]),
    );
    // Added and listed, not connected.
    expect(invokeMock.mock.calls.filter(([name]) => name === "openvpn_connect")).toHaveLength(0);
    await waitFor(() => expect(screen.getByText("other.ovpn")).toBeTruthy());
    expect(useVpnStatusStore.getState().byConfig[OTHER_STORED]).toBeUndefined();
  });

  it("is present even when nothing is up — that is how you find it", async () => {
    // It used to render null unless a tunnel was already running, which made the one
    // control for a machine-wide thing impossible to find until it was too late.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "openvpn_active") return Promise.resolve([]);
      if (cmd === "openvpn_list_configs") return Promise.resolve(STORED);
      return Promise.resolve();
    });
    const { container } = render(<VpnIndicator />);
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByRole("button", { name: /openvpn/i })).toBeTruthy();
  });
});

describe("a stored config can be removed, not only connected", () => {
  // Removal takes the saved credentials with it (they are keyed by the config
  // path and would otherwise be a stale half in the keychain), and *those* can't
  // be brought back by re-browsing the file — so it is a two-click action.
  const STORED = [{ path: CONFIG, name: "office.ovpn" }];

  const removals = () =>
    invokeMock.mock.calls.filter(([name]) => name === "openvpn_remove_config");

  const withStored = () =>
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "openvpn_active") return Promise.resolve([]);
      if (cmd === "openvpn_list_configs") return Promise.resolve(STORED);
      return Promise.resolve();
    });

  it("asks once more, then removes the config and its row", async () => {
    withStored();
    render(<VpnIndicator />);

    await userEvent.hover(screen.getByRole("button", { name: /openvpn/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^remove$/i }));

    // Armed, not done: nothing has been removed yet.
    expect(removals()).toHaveLength(0);
    expect(screen.getByText(/forgets its saved credentials/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^remove config$/i }));
    await waitFor(() =>
      expect(removals()).toEqual([["openvpn_remove_config", { config: CONFIG }]]),
    );
    // The row is gone without a re-list round-trip.
    await waitFor(() => expect(screen.queryByText("office.ovpn")).toBeNull());
  });

  it("Keep cancels the armed removal", async () => {
    withStored();
    render(<VpnIndicator />);

    await userEvent.hover(screen.getByRole("button", { name: /openvpn/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^remove$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^keep$/i }));

    expect(removals()).toHaveLength(0);
    expect(screen.getByText("office.ovpn")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^connect$/i })).toBeTruthy();
  });

  it("names the projects that use the config before removing it", async () => {
    // Both fixture projects ride CONFIG — the warning must say so, since their
    // next connect will have to ask for a config again.
    withStored();
    render(<VpnIndicator />);

    await userEvent.hover(screen.getByRole("button", { name: /openvpn/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^remove$/i }));
    expect(screen.getByText(/alpha, beta/)).toBeTruthy();
  });

  it("disarms connect-on-launch when the armed config is removed", async () => {
    // An armed path with no file behind it would silently fail at every startup.
    withStored();
    useSettingsStore.setState({ settings: { vpn_auto_connect: CONFIG, vpn_enabled: true } as never });
    render(<VpnIndicator />);

    await userEvent.hover(screen.getByRole("button", { name: /openvpn/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^remove$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove config$/i }));

    await waitFor(() =>
      expect(useSettingsStore.getState().settings?.vpn_auto_connect).toBeNull(),
    );
  });

  it("a refused removal keeps the row and shows the reason", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "openvpn_active") return Promise.resolve([]);
      if (cmd === "openvpn_list_configs") return Promise.resolve(STORED);
      if (cmd === "openvpn_remove_config")
        return Promise.reject(new Error("this tunnel is up — disconnect it first"));
      return Promise.resolve();
    });
    render(<VpnIndicator />);

    await userEvent.hover(screen.getByRole("button", { name: /openvpn/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^remove$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove config$/i }));

    await waitFor(() => expect(screen.getByText(/disconnect it first/i)).toBeTruthy());
    expect(screen.getByText("office.ovpn")).toBeTruthy();
  });
});
