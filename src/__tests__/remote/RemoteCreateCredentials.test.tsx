/**
 * The create/extend dialogs save credentials the same way the Connect modal does —
 * and hand the one they just used to the connection that follows.
 *
 * Two gaps this pins shut:
 *
 *  1. **No "Save password" in the create/extend flow.** The keychain is keyed by
 *     *host target* (and by config path for a tunnel), not by project — so there was
 *     never a reason the toggle couldn't live here too. Without it, a project set up
 *     with a typed password asked for it again on the very next activation, and
 *     auto-connect could not be offered at all.
 *  2. **The first pooled connect went out password-less.** It only worked because the
 *     dialog's ControlMaster was still up — and the backend reads "no password given,
 *     none saved" as *key* auth, so it recorded `key_auth: true` on a password host.
 *     The project then claimed to be auto-connect-eligible and failed on next launch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../components/terminal/TerminalView", () => ({ TerminalView: () => null }));

import { ExtendToRemoteDialog } from "../../components/projects/ExtendToRemoteDialog";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import { useVpnStatusStore } from "../../stores/remote/vpn/vpnStatus";
import type { ProjectEntry } from "../../types";
import { BRAND } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

const PROJECT = {
  id: "p1",
  name: "sshtest",
  directory: `/home/u/${BRAND.slug}/projects/sshtest`,
  position: 0,
  status: "active",
} as unknown as ProjectEntry;

/** Args of the last call to `cmd` (or undefined if it was never called). */
const lastArgs = (cmd: string) => {
  const calls = invokeMock.mock.calls.filter(([name]) => name === cmd);
  return calls[calls.length - 1]?.[1] as Record<string, unknown> | undefined;
};

/** Whether a password is already in the keychain for the host we type below. */
let sshPasswordSaved = false;

beforeEach(() => {
  // The VPN connect renders the live handshake log, which scrolls itself into view.
  // jsdom has no layout, hence no scrollIntoView.
  HTMLElement.prototype.scrollIntoView = vi.fn();
  sshPasswordSaved = false;
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    // Asked through the state command now: it reports whether the store was
    // *readable* as well, because a locked keyring answers a plain lookup exactly
    // like an empty one (see `useSavedCredential`).
    if (cmd === "remote_saved_password_state") {
      return Promise.resolve({ saved: sshPasswordSaved, keyring: "unlocked" });
    }
    if (cmd === "ssh_connect") {
      return Promise.resolve({ saved: sshPasswordSaved, save_error: null });
    }
    if (cmd === "vpn_has_saved_password") return Promise.resolve(false);
    if (cmd === "openvpn_list_configs") return Promise.resolve([]);
    if (cmd === "ssh_list_addresses" || cmd === "remote_list_paths") return Promise.resolve([]);
    if (cmd === "ssh_tooling_status") {
      return Promise.resolve({ password_auth: true, openvpn: true });
    }
    if (cmd === "ssh_default_dir") return Promise.resolve("/home/alice");
    if (cmd === "ssh_list_dir") return Promise.resolve([]);
    return Promise.resolve();
  });

  useSettingsStore.setState({ settings: { connections_headless: true } as never });
  useProjectsStore.setState({
    projects: [PROJECT],
    extendProjectToRemote: vi.fn(() => Promise.resolve()),
  } as never);
  useRemoteStatusStore.setState({ byProject: {} } as never);
  useVpnStatusStore.setState({ byConfig: {}, holders: {} });
});

/** Fill in the SSH address + password of the connect step. */
async function fillSsh(password: string) {
  await userEvent.type(await screen.findByPlaceholderText(/user@host/i), "alice@host.example");
  if (password) {
    await userEvent.type(screen.getByPlaceholderText(/key's passphrase/i), password);
  }
}

describe("the create/extend dialog can save the SSH password", () => {
  it("passes the ticked checkbox to the connect, so the working password is stored", async () => {
    render(<ExtendToRemoteDialog project={PROJECT} onClose={() => {}} />);
    await fillSsh("hunter2");

    await userEvent.click(screen.getByRole("checkbox", { name: /save password/i }));
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() =>
      expect(lastArgs("ssh_connect")).toMatchObject({ password: "hunter2", remember: true }),
    );
  });

  it("leaves it unticked by default — and an unticked box NEVER clears the keychain", async () => {
    // This expectation used to be `remember: false`, i.e. it asserted the
    // data-loss bug. `false` is not "don't save": it is `Remember::Clear`, and
    // since `ssh_connect` resolves `typed || saved` *before* it writes, a
    // *successful* connect carrying it deletes the password it just
    // authenticated with. That is how a real host's saved password was
    // destroyed by ordinary use.
    //
    // An unticked box now means "leave the keychain alone" — `null`. Deleting is
    // the explicit forget's job alone (the untick handler calls it directly, and
    // the test below locks that).
    render(<ExtendToRemoteDialog project={PROJECT} onClose={() => {}} />);
    await fillSsh("hunter2");

    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(lastArgs("ssh_connect")).toMatchObject({ remember: null }));
  });

  it("pre-ticks for a host that already has a saved password, and unticking deletes it", async () => {
    // Pre-ticked matters for more than looks: `remember: false` is an explicit
    // untick, so connecting with the box unticked would *clear* the credential
    // another project saved for this same host.
    sshPasswordSaved = true;
    render(<ExtendToRemoteDialog project={PROJECT} onClose={() => {}} />);
    await fillSsh("");

    const save = await screen.findByRole<HTMLInputElement>("checkbox", { name: /save password/i });
    await waitFor(() => expect(save.checked).toBe(true));
    // And the field says the saved one will be used — it can't be pre-filled.
    expect(screen.getByPlaceholderText(/using saved password/i)).toBeTruthy();

    await userEvent.click(save);
    await waitFor(() =>
      expect(lastArgs("remote_forget_password")).toMatchObject({ host: "host.example" }),
    );
    expect(save.checked).toBe(false);
  });
});

describe("the create/extend dialog can save the VPN passphrase", () => {
  const VPN_CONFIG = "/store/office.ovpn";

  it("passes the ticked checkbox to the tunnel's connect", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "openvpn_list_configs") {
        return Promise.resolve([{ path: VPN_CONFIG, name: "office.ovpn" }]);
      }
      if (cmd === "remote_saved_password_state") {
        return Promise.resolve({ saved: false, keyring: "unlocked" });
      }
      if (cmd === "ssh_connect") return Promise.resolve({ saved: false, save_error: null });
      if (cmd === "vpn_has_saved_password") return Promise.resolve(false);
      if (cmd === "ssh_list_addresses" || cmd === "remote_list_paths") return Promise.resolve([]);
      if (cmd === "ssh_tooling_status") {
        return Promise.resolve({ password_auth: true, openvpn: true });
      }
      if (cmd === "openvpn_auth_needs") {
        return Promise.resolve({ username: false, keyPassphrase: false });
      }
      return Promise.resolve();
    });

    render(<ExtendToRemoteDialog project={PROJECT} onClose={() => {}} />);

    await userEvent.click(
      await screen.findByRole("checkbox", { name: /connect via openvpn/i }),
    );
    // Pick the stored config from the recents dropdown.
    await userEvent.click(await screen.findByTitle(/reuse a previously-used openvpn config/i));
    await userEvent.click(await screen.findByRole("option", { name: /office\.ovpn/i }));

    await userEvent.type(await screen.findByPlaceholderText(/vpn passphrase/i), "s3cret");
    await userEvent.click(await screen.findByRole("checkbox", { name: /save passphrase/i }));
    await userEvent.click(screen.getByRole("button", { name: /connect vpn/i }));

    await waitFor(() =>
      expect(lastArgs("openvpn_connect")).toMatchObject({
        config: VPN_CONFIG,
        password: "s3cret",
        remember: true,
      }),
    );
  });
});

describe("the credential the dialog used is the one the project connects with", () => {
  it("hands the typed password to the pooled connect after extending", async () => {
    render(<ExtendToRemoteDialog project={PROJECT} onClose={() => {}} />);
    await fillSsh("hunter2");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    // Connected → the browse step opens on the remote home dir; take it as-is.
    await userEvent.click(await screen.findByRole("button", { name: /use this folder/i }));
    await userEvent.click(await screen.findByRole("button", { name: /extend to remote/i }));

    await waitFor(() =>
      expect(lastArgs("remote_connect")).toEqual({
        projectId: "p1",
        password: "hunter2",
        // A password was handed over, so the connect proves how the host
        // authenticates on its own — nothing is being ridden.
        viaLogin: false,
        // The user clicked "Extend to remote"; `remote_connect` defaults to
        // *background*, which a host tagged HPC refuses outright.
        background: false,
      }),
    );
    // A password-less connect here would have been recorded as key auth (it rides the
    // master the dialog left up), which is what made auto-connect lie.
    expect(useProjectsStore.getState().extendProjectToRemote).toHaveBeenCalled();
  });

  it("sends no password for a key-auth host — there is nothing to hand over", async () => {
    render(<ExtendToRemoteDialog project={PROJECT} onClose={() => {}} />);
    await fillSsh("");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await userEvent.click(await screen.findByRole("button", { name: /use this folder/i }));
    await userEvent.click(await screen.findByRole("button", { name: /extend to remote/i }));

    await waitFor(() =>
      expect(lastArgs("remote_connect")).toEqual({
        projectId: "p1",
        password: null,
        // Nothing to hand over means this connect can only be riding the master the
        // dialog's own login left up — so it must not be written down as key auth
        // (the backend's `record_key_auth` skips it). A genuinely key-auth host still
        // records itself on its next ordinary activation connect.
        viaLogin: true,
        background: false,
      }),
    );
  });
});
