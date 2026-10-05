/**
 * "Type it for me" above a login terminal (`CredentialPasteBar`).
 *
 * The point of the feature is that a *saved* credential is reachable from a
 * *terminal* login — the mode in which Tabtivity deliberately handles no passwords —
 * without the secret ever entering the frontend. So the two things worth locking in
 * are exactly the two that could regress into a leak or into uselessness:
 *
 *  1. **A secret is never fetched into JS.** The password button calls
 *     `credential_paste_to_pty` (backend reads the keychain, backend writes the PTY)
 *     and nothing else — in particular nothing that *returns* a password.
 *  2. **A non-secret is typed as a keystroke.** The login name is already on screen,
 *     so it goes through the ordinary `pty_write`, with no trailing newline: a paste
 *     is not a login, and the user presses Enter.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(true)) }));

import {
  CredentialPasteBar,
  sshPasteEntries,
  vpnPasteEntries,
} from "../../components/projects/CredentialPasteBar";
import { translate, type TranslationKey } from "../../lib/i18n";

const t = (key: TranslationKey, params?: Record<string, string | number>) =>
  translate("en", key, params);

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(true));
});

describe("CredentialPasteBar", () => {
  it("types the login name straight into the PTY, with no newline", async () => {
    render(
      <CredentialPasteBar
        ptyId="pty-1"
        entries={sshPasteEntries(t, { user: "alice", host: "host.example", saved: false })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /paste username/i }));
    const [cmd, args] = invokeMock.mock.calls[0] as [string, { id: string; data: Uint8Array }];
    expect(cmd).toBe("pty_write");
    expect(args.id).toBe("pty-1");
    expect(new TextDecoder().decode(args.data)).toBe("alice");
  });

  it("pastes a saved password through the backend, never fetching it", async () => {
    render(
      <CredentialPasteBar
        ptyId="pty-1"
        entries={sshPasteEntries(t, { user: "alice", host: "host.example", port: 2222, saved: true })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /paste password/i }));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("credential_paste_to_pty", {
      pty: "pty-1",
      // The login name being typed into *this* terminal keys the credential.
      target: { kind: "ssh-password", user: "alice", host: "host.example", port: 2222 },
    });
  });

  it("offers no password button when nothing is saved for the target", () => {
    render(
      <CredentialPasteBar
        ptyId="pty-1"
        entries={sshPasteEntries(t, { user: "alice", host: "host.example", saved: false })}
      />,
    );
    expect(screen.queryByRole("button", { name: /paste password/i })).toBeNull();
  });

  it("says so when the keychain answers empty, rather than pasting nothing", async () => {
    invokeMock.mockImplementation(() => Promise.resolve(false));
    render(
      <CredentialPasteBar
        ptyId="pty-1"
        entries={sshPasteEntries(t, { user: "bob", host: "host.example", saved: true })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /paste password/i }));
    expect(await screen.findByText(/nothing saved/i)).toBeTruthy();
  });

  it("gives an auth-user-pass + encrypted-key tunnel a button per secret", () => {
    const entries = vpnPasteEntries(t, {
      config: "/store/office.ovpn",
      username: "alice",
      saved: true,
      needsUsername: true,
      needsKeyPassphrase: true,
    });
    expect(entries.map((e) => e.label)).toEqual([
      "Paste username",
      "Paste password",
      "Paste key passphrase",
    ]);
  });

  it("renders nothing for a tunnel with no config and no saved secret", () => {
    const { container } = render(
      <CredentialPasteBar
        ptyId="pty-1"
        entries={vpnPasteEntries(t, {
          config: "",
          saved: false,
          needsUsername: false,
          needsKeyPassphrase: false,
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
