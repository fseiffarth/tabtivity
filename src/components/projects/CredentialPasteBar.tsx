import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UntestedTag } from "../common/UntestedTag";
import { useT, type TranslationKey } from "../../lib/i18n";
import { writePtyInput } from "../../lib/terminal/terminalInput";
import type { LoginTarget } from "../../lib/remote/loginTarget";
import { needsSeparateKeyPassphrase, type VpnAuthNeeds } from "../../types";
import { useSavedCredential } from "../../lib/projects/useSavedCredential";

/**
 * "Paste it for me" for a **login terminal** — the row of buttons above the embedded
 * terminal that types a *known* login name, and a *saved* password, at the cursor.
 *
 * It exists because the non-headless login and a saved credential are not the
 * contradiction they look like. Non-headless means Tabtivity does not *handle* the
 * password — the host asks its own questions in a terminal the user is watching, and
 * the answers go straight to it. It has never meant the keychain is empty: a user who
 * saved an SSH password from a headless connect, or a VPN password from the header
 * menu, and then works in this mode (or flips "Sign in in a terminal" for one host
 * that wants a challenge code) has the credential sitting there, unreachable, and
 * retypes it into every login.
 *
 * The secret does **not** travel through the frontend to get there. A password button
 * calls `credential_paste_to_pty`, which reads the keychain and writes the bytes into
 * the PTY inside the backend — no field, no component state, no event payload. Only
 * the non-secrets (an SSH login name, a VPN auth username the dialog already shows in
 * a plain text input) are pasted from here, via the ordinary `pty_write` any keystroke
 * uses.
 *
 * Nothing is submitted: the credential lands at the cursor and the user presses Enter.
 * A paste is not a login, and a wrong one should be correctable on the line rather than
 * committed on the user's behalf — the same reason the login itself runs in a visible
 * terminal instead of behind it.
 *
 * The backend takes a paste only into a **login terminal** (`TerminalView`'s `login`
 * prop / `TabEntry.login`) whose login is still running: the PTY's program is the
 * ssh/OpenVPN login it built from the target, so a saved secret never lands in a
 * shell, and once the login exits the paste is refused (shown here as the note).
 */

/** A saved credential, named by *what it is* — the keychain account spelling stays
 *  the backend's (see `commands::credentials::PasteCredential`). */
export type PasteCredentialRef =
  | { kind: "ssh-password"; user?: string | null; host: string; port?: number | null }
  | { kind: "vpn-password"; config: string }
  | { kind: "vpn-key-passphrase"; config: string }
  | { kind: "vpn-username"; config: string };

export type PasteEntry = {
  /** Button label, e.g. `"Paste password"`. */
  label: string;
  title: string;
  /** A plain, non-secret value the caller already has on screen. */
  text?: string;
  /** A secret only the backend may read. Ignored when `text` is given. */
  credential?: PasteCredentialRef;
};

const ENCODER = new TextEncoder();

export function CredentialPasteBar({
  ptyId,
  entries,
  className,
  children,
}: {
  ptyId: string;
  /** Entries with neither a non-empty `text` nor a `credential` are dropped, so a
   *  caller can list every field it *might* have and let this decide. */
  entries: PasteEntry[];
  /** A modifier for where the bar sits (a root login tab's pane). */
  className?: string;
  /** The call site's own untested pill, in place of the bar's generic one. */
  children?: ReactNode;
}) {
  const t = useT();
  const [note, setNote] = useState("");
  const noteTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    },
    [],
  );
  const flash = (msg: string) => {
    setNote(msg);
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(""), 4000);
  };

  const usable = entries.filter((e) => (e.text ?? "").trim() !== "" || e.credential);
  if (!ptyId || usable.length === 0) return null;

  const paste = async (entry: PasteEntry) => {
    try {
      if (entry.text) {
        await writePtyInput(ptyId, ENCODER.encode(entry.text));
        flash(t("credentialPasteBar.pastedFlash"));
        return;
      }
      const pasted = await invoke<boolean>("credential_paste_to_pty", {
        pty: ptyId,
        target: entry.credential,
      });
      // `false` is the keychain answering "nothing here" — which on Linux is also how
      // a *locked* collection answers, hence the second half of the message rather
      // than a flat "nothing saved" the user knows to be untrue.
      flash(pasted ? t("credentialPasteBar.pastedFlash") : t("credentialPasteBar.nothingSavedFlash"));
    } catch (e) {
      flash(String(e));
    }
  };

  return (
    <div className={className ? `credential-paste-bar ${className}` : "credential-paste-bar"}>
      <span className="ssh-optional-hint">{t("credentialPasteBar.typeItForMe")}</span>
      {usable.map((entry) => (
        <button
          key={entry.label}
          type="button"
          className="credential-paste-btn"
          title={entry.title}
          // Never take the focus: the terminal below is where the next keystroke —
          // the Enter this deliberately does not send — has to land, and a button
          // that steals it turns one click into three (paste, click back, Enter).
          // `focused` is a static prop on these embedded terminals, so nothing would
          // hand the focus back on its own.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void paste(entry)}
        >
          {entry.label}
        </button>
      ))}
      {children ?? <UntestedTag id="credentialPasteBar.1" />}
      {note && <span className="ssh-optional-hint credential-paste-note">{note}</span>}
    </div>
  );
}

/**
 * The same bar above a **root-console login tab** (`TabEntry.login`, opened by
 * `openConnectionInRoot` when connections are not headless): the backend takes a
 * paste into that PTY exactly as into a dialog's embedded login, so the only thing
 * missing was the bar. It shows only when the tab's target has a credential saved —
 * there is no on-screen login name here to offer on its own — and asks the
 * keychain the dialogs' way: `useSavedCredential` for SSH, `vpn_has_saved_password`
 * plus `openvpn_auth_needs` for OpenVPN, built into the same entries by
 * `sshPasteEntries` / `vpnPasteEntries`.
 *
 * The read is gated on `visible`: every tab stays mounted in the keep-alive layer
 * (and again, attach-only, in the root console), and a hidden pane must not make
 * keychain round trips. Re-asked on every show, so a password saved meanwhile
 * shows up the next time the tab is looked at.
 */
export function LoginTabPasteBar({
  ptyId,
  login,
  visible,
}: {
  ptyId: string;
  login: LoginTarget;
  visible: boolean;
}) {
  const t = useT();
  const ssh = login.kind === "ssh" ? login : null;
  const config = login.kind === "vpn" ? login.config : "";
  const sshCredential = useSavedCredential(
    ssh ? { user: ssh.user, host: ssh.host, port: ssh.port } : null,
    { enabled: visible && !!ssh },
  );
  const [vpnSaved, setVpnSaved] = useState(false);
  const [vpnNeeds, setVpnNeeds] = useState<VpnAuthNeeds>({ username: false, keyPassphrase: false });
  useEffect(() => {
    if (!config || !visible) return;
    let cancelled = false;
    void invoke<boolean>("vpn_has_saved_password", { config })
      .then((v) => !cancelled && setVpnSaved(v === true))
      .catch(() => {});
    void invoke<VpnAuthNeeds>("openvpn_auth_needs", { config })
      .then((v) => !cancelled && v && setVpnNeeds(v))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [config, visible]);

  const saved = ssh ? sshCredential.saved : vpnSaved;
  if (!saved) return null;
  const entries = ssh
    ? sshPasteEntries(t, { user: ssh.user, host: ssh.host, port: ssh.port, saved })
    : vpnPasteEntries(t, {
        config,
        saved,
        needsUsername: vpnNeeds.username,
        needsKeyPassphrase: needsSeparateKeyPassphrase(vpnNeeds),
      });
  return (
    <CredentialPasteBar ptyId={ptyId} entries={entries} className="credential-paste-bar-tab">
      <UntestedTag id="credentialPasteBar.rootLogin" />
    </CredentialPasteBar>
  );
}

/**
 * What an **SSH** login terminal offers to paste, built once for every dialog that
 * has one — so the Connect modal, the new/extend-project dialog and the add-machine
 * form can't drift into three different sets of buttons for one login.
 *
 * The password target carries the login name **being typed into the terminal**, not
 * whichever one is persisted: the keychain is keyed per login, so that is the account
 * this paste has to match. A name with nothing saved under it reports "nothing saved
 * for this login" — the truth a `saved` flag asked about a *different* name cannot
 * tell on its own.
 */
export function sshPasteEntries(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  opts: {
    user?: string | null;
    host?: string;
    port?: number | null;
    /** A password is known to be in the keychain for this target. */
    saved: boolean;
  },
): PasteEntry[] {
  const user = (opts.user ?? "").trim();
  return [
    {
      label: t("credentialPasteBar.pasteUsername"),
      title: t("credentialPasteBar.pasteUsernameTitle", { user }),
      text: user,
    },
    ...(opts.saved && opts.host
      ? [
          {
            label: t("credentialPasteBar.pastePassword"),
            title: t("credentialPasteBar.pastePasswordTitle"),
            credential: {
              kind: "ssh-password" as const,
              user: user || null,
              host: opts.host,
              port: opts.port ?? null,
            },
          },
        ]
      : []),
  ];
}

/** The OpenVPN twin of [`sshPasteEntries`]. A config with an `auth-user-pass`
 *  account *and* an encrypted key has two independent secrets, and OpenVPN prompts
 *  for them separately — so they get a button each, in the order it asks. */
export function vpnPasteEntries(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  opts: {
    config: string;
    username?: string;
    saved: boolean;
    needsUsername: boolean;
    needsKeyPassphrase: boolean;
  },
): PasteEntry[] {
  const { config, saved, needsKeyPassphrase } = opts;
  const username = (opts.username ?? "").trim();
  if (!config) return [];
  return [
    // The username is offered even when this dialog has none on screen: for a tunnel
    // with no project behind it the saved one is the only copy there is.
    ...(opts.needsUsername && (username || saved)
      ? [
          {
            label: t("credentialPasteBar.pasteUsername"),
            title: t("credentialPasteBar.pasteVpnUsernameTitle"),
            text: username,
            credential: { kind: "vpn-username" as const, config },
          },
        ]
      : []),
    ...(saved
      ? [
          {
            label: needsKeyPassphrase ? t("credentialPasteBar.pastePassword") : t("credentialPasteBar.pastePassphrase"),
            title: t("credentialPasteBar.pasteVpnSecretTitle"),
            credential: { kind: "vpn-password" as const, config },
          },
        ]
      : []),
    ...(saved && needsKeyPassphrase
      ? [
          {
            label: t("credentialPasteBar.pasteKeyPassphrase"),
            title: t("credentialPasteBar.pasteKeyPassphraseTitle"),
            credential: { kind: "vpn-key-passphrase" as const, config },
          },
        ]
      : []),
  ];
}
