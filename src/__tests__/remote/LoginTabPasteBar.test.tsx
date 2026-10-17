/**
 * "Type it for me" above a **root-console login tab** (screen 2026-10-15
 * follow-up F-c): the dialogs' `CredentialPasteBar`, shown by `TabPane` over a
 * tab carrying `TabEntry.login` when that target has a saved credential.
 *
 * Locked in here:
 *  - the bar is the dialogs' component, aimed at the tab's own PTY id, and its
 *    password button still only *names* the secret (`credential_paste_to_pty`);
 *  - it shows only when the keychain says a credential is saved — nothing for an
 *    unsaved target, and nothing on an ordinary shell tab;
 *  - a hidden pane asks the keychain nothing (every tab stays mounted);
 *  - an OpenVPN login gets the dialogs' VPN entries (the saved username too).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../components/terminal/TerminalView", () => ({
  TerminalView: ({ id }: { id: string }) => <div data-testid={`term-${id}`} />,
}));

import { TabPane } from "../../components/tabs/TabPane";
import { sshLogin, vpnLogin, type LoginTarget } from "../../lib/remote/loginTarget";
import type { TabEntry } from "../../stores/tabs";

const invokeMock = vi.mocked(invoke);

/** The keychain as these tests set it up. */
let sshSaved = true;
let vpnSaved = true;
let vpnNeeds = { username: false, keyPassphrase: false };

beforeEach(() => {
  sshSaved = true;
  vpnSaved = true;
  vpnNeeds = { username: false, keyPassphrase: false };
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "remote_saved_password_state":
        return { saved: sshSaved, keyring: "unlocked" };
      case "vpn_has_saved_password":
        return vpnSaved;
      case "openvpn_auth_needs":
        return vpnNeeds;
      case "credential_paste_to_pty":
        return true;
      default:
        return null;
    }
  });
});

const loginTab = (key: string, login?: LoginTarget): TabEntry => ({
  key,
  scope: "root",
  label: key,
  cmd: "",
  cwd: "/",
  kind: "shell",
  ...(login ? { login } : {}),
});

const renderPane = (tab: TabEntry, visible = true) =>
  render(<TabPane tab={tab} scope="root" visible={visible} focused={visible} filesProjectDir="/" terminalCwd="/" attachOnly />);

describe("the paste bar above a root login tab", () => {
  it("pastes the saved ssh password into the tab's own login PTY, by name only", async () => {
    renderPane(loginTab("t1", sshLogin("alice", "h.example", 2222)));
    const btn = await screen.findByRole("button", { name: /paste password/i });
    expect(invokeMock).toHaveBeenCalledWith("remote_saved_password_state", {
      user: "alice",
      host: "h.example",
      port: 2222,
    });
    await userEvent.click(btn);
    expect(invokeMock).toHaveBeenCalledWith("credential_paste_to_pty", {
      pty: "root:t1",
      target: { kind: "ssh-password", user: "alice", host: "h.example", port: 2222 },
    });
    // The login name is offered too, typed as a keystroke like in the dialogs.
    expect(screen.getByRole("button", { name: /paste username/i })).toBeTruthy();
    // It sits in the pane after the terminal host, drawn above it by `order`.
    const term = screen.getByTestId("term-root:t1");
    expect(term.nextElementSibling?.classList.contains("credential-paste-bar-tab")).toBe(true);
  });

  it("shows nothing when the target has no saved credential", async () => {
    sshSaved = false;
    const { container } = renderPane(loginTab("t2", sshLogin("alice", "h.example", null)));
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("remote_saved_password_state", expect.anything()),
    );
    // Let the answer land before looking.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector(".credential-paste-bar")).toBeNull();
  });

  it("never asks the keychain for a hidden pane, nor for a plain shell tab", async () => {
    const { container } = renderPane(loginTab("t3", sshLogin("alice", "h.example", null)), false);
    renderPane(loginTab("t4"));
    await new Promise((r) => setTimeout(r, 400));
    expect(invokeMock).not.toHaveBeenCalledWith("remote_saved_password_state", expect.anything());
    expect(container.querySelector(".credential-paste-bar")).toBeNull();
  });

  it("gives an OpenVPN login the dialogs' entries, the saved username included", async () => {
    vpnNeeds = { username: true, keyPassphrase: false };
    renderPane(loginTab("t5", vpnLogin("/store/office.ovpn")));
    const user = await screen.findByRole("button", { name: /paste username/i });
    await userEvent.click(user);
    expect(invokeMock).toHaveBeenCalledWith("credential_paste_to_pty", {
      pty: "root:t5",
      target: { kind: "vpn-username", config: "/store/office.ovpn" },
    });
    await userEvent.click(screen.getByRole("button", { name: /paste passphrase|paste password/i }));
    expect(invokeMock).toHaveBeenCalledWith("credential_paste_to_pty", {
      pty: "root:t5",
      target: { kind: "vpn-password", config: "/store/office.ovpn" },
    });
  });

  it("shows nothing for a tunnel with no saved secret", async () => {
    vpnSaved = false;
    const { container } = renderPane(loginTab("t6", vpnLogin("/store/office.ovpn")));
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("vpn_has_saved_password", { config: "/store/office.ovpn" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector(".credential-paste-bar")).toBeNull();
  });
});
