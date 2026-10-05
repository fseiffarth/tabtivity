/**
 * One rule for every remote menu that can start a tunnel: **if a tunnel is already
 * up machine-wide, don't offer another one.**
 *
 * A tunnel reroutes the whole computer, so it is not the project's to own twice. The
 * Connect modal already collapsed its OpenVPN block to a one-line notice in that
 * state; the section the new-project and extend-to-remote dialogs share still asked
 * "Connect via OpenVPN" — for routing that was already in place. Both now go through
 * `useVpnSectionVisible` / `VpnTunnelUpNotice`, and this pins that they agree.
 *
 * The exception the gate must preserve: a tunnel *this* dialog brought up keeps its
 * controls (handshake log, Stop/Disconnect) where the user started it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
// Neither dialog mounts a terminal on the headless path, but the import drags xterm
// into jsdom — stub it.
vi.mock("../../components/terminal/TerminalView", () => ({ TerminalView: () => null }));

import { ExtendToRemoteDialog } from "../../components/projects/ExtendToRemoteDialog";
import { RemoteConnectDialog } from "../../components/projects/RemoteConnectDialog";
import { useProjectsStore } from "../../stores/projects";
import { useConnectDialogStore } from "../../stores/remote/connectDialog";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import { useVpnStatusStore } from "../../stores/remote/vpn/vpnStatus";
import type { ProjectEntry } from "../../types";
import { BRAND } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

/** The tunnel someone else (the header, another project, connect-on-launch) put up. */
const OTHER_CONFIG = "/store/office.ovpn";

const LOCAL_PROJECT = {
  id: "p1",
  name: "sshtest",
  directory: `/home/u/${BRAND.slug}/projects/sshtest`,
  position: 0,
  status: "active",
} as unknown as ProjectEntry;

const REMOTE_PROJECT = {
  ...LOCAL_PROJECT,
  remote: { user: "alice", host: "host.example", remote_path: "/srv/work" },
} as unknown as ProjectEntry;

const vpnToggle = () => screen.queryByRole("checkbox", { name: /connect via openvpn/i });
const upNotice = () => screen.queryByText(/openvpn tunnel already up/i);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "remote_has_saved_password" || cmd === "vpn_has_saved_password") {
      return Promise.resolve(false);
    }
    if (cmd === "openvpn_list_configs") return Promise.resolve([]);
    if (cmd === "ssh_list_addresses" || cmd === "remote_list_paths") return Promise.resolve([]);
    if (cmd === "ssh_tooling_status") {
      return Promise.resolve({ password_auth: true, openvpn: true });
    }
    if (cmd === "openvpn_auth_needs") {
      return Promise.resolve({ username: false, keyPassphrase: false });
    }
    return Promise.resolve();
  });

  useSettingsStore.setState({ settings: { connections_headless: true } as never });
  useProjectsStore.setState({ projects: [REMOTE_PROJECT] } as never);
  useConnectDialogStore.setState({ projectId: REMOTE_PROJECT.id } as never);
  useRemoteStatusStore.setState({ byProject: {} } as never);
  useVpnStatusStore.setState({ byConfig: {}, holders: {} });
});

describe("extend-to-remote: the OpenVPN block yields to a live tunnel", () => {
  it("offers the tunnel when none is up", async () => {
    render(<ExtendToRemoteDialog project={LOCAL_PROJECT} onClose={() => {}} />);

    expect(await screen.findByRole("checkbox", { name: /connect via openvpn/i })).toBeTruthy();
    expect(upNotice()).toBeNull();
  });

  it("collapses to the already-up notice when a tunnel is live machine-wide", async () => {
    useVpnStatusStore.setState({ byConfig: { [OTHER_CONFIG]: "connected" }, holders: {} });

    render(<ExtendToRemoteDialog project={LOCAL_PROJECT} onClose={() => {}} />);

    // The SSH step still renders — it is only the redundant VPN offer that goes.
    expect(await screen.findByPlaceholderText(/user@host/i)).toBeTruthy();
    expect(upNotice()).toBeTruthy();
    expect(vpnToggle()).toBeNull();
  });

  it("still collapses while a tunnel is only coming up", async () => {
    useVpnStatusStore.setState({ byConfig: { [OTHER_CONFIG]: "connecting" }, holders: {} });

    render(<ExtendToRemoteDialog project={LOCAL_PROJECT} onClose={() => {}} />);

    expect(await screen.findByText(/openvpn tunnel already up/i)).toBeTruthy();
    expect(vpnToggle()).toBeNull();
  });
});

describe("the Connect modal answers the same question the same way", () => {
  it("collapses when another config's tunnel is up", async () => {
    useVpnStatusStore.setState({ byConfig: { [OTHER_CONFIG]: "connected" }, holders: {} });

    render(<RemoteConnectDialog />);

    expect(await screen.findByText(/openvpn tunnel already up/i)).toBeTruthy();
    expect(vpnToggle()).toBeNull();
  });

  it("keeps the section when the live tunnel is this project's own", async () => {
    // Its log and its Disconnect live here — hiding them would strand the tunnel the
    // user started from this very dialog.
    useProjectsStore.setState({
      projects: [
        {
          ...REMOTE_PROJECT,
          remote: { ...REMOTE_PROJECT.remote, openvpn: { config: OTHER_CONFIG } },
        },
      ],
    } as never);
    useRemoteStatusStore.setState({
      byProject: { p1: { ssh: "off", vpn: "connected" } },
    } as never);
    useVpnStatusStore.setState({ byConfig: { [OTHER_CONFIG]: "connected" }, holders: { [OTHER_CONFIG]: ["p1"] } });

    render(<RemoteConnectDialog />);

    expect(await screen.findByRole("button", { name: /disconnect vpn/i })).toBeTruthy();
    expect(upNotice()).toBeNull();
  });
});
