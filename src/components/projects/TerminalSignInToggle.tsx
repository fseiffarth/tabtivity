import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { IS_WINDOWS } from "../../lib/platform";
import { useT } from "../../lib/i18n";

/**
 * "Sign in in a terminal" — the **non-headless login, switched on per connect**.
 *
 * Headless mode is the default and normally the better one: Tabtivity feeds the secret
 * to the backend and the dialog stays a dialog. But it can only ask what it has
 * fields for — an SSH password, an OpenVPN password and key passphrase — and a host
 * or a tunnel is free to ask something else: a keyboard-interactive challenge, a
 * one-time code, a second prompt, an expired-password change. None of those reach
 * these fields, so the login cannot succeed however many times it is retried. That is
 * the loop this exists to end.
 *
 * So the toggle is present in **every** headless login section, defaulted **off** —
 * the ordinary path is untouched, and the escape hatch is one click away instead of
 * being a settings trip. Flipping it on swaps the password fields for the same
 * embedded login terminal `connections_headless: false` uses, where the server asks
 * its own questions and the user answers them directly (Tabtivity still never sees the
 * secret). It is per connect: the global setting is never written, because a mode is
 * the user's statement about how Tabtivity should behave, not something one host's
 * handshake gets to decide for them.
 *
 * Not offered on **Windows**, where it would be a promise Tabtivity can't keep: there is
 * no ssh ControlMaster socket to ride, so a terminal login authenticates a session
 * nothing else can reuse (the same reason `winManual` exists).
 *
 * `failed` turns the hint from an option into a suggestion — after a login has
 * actually failed, "the password may not be what it is asking for" stops being
 * hypothetical.
 */
export function TerminalSignInToggle({
  channel,
  checked,
  onChange,
  busy,
  failed,
}: {
  /** Which login this switches — only the wording differs. */
  channel: "ssh" | "vpn";
  checked: boolean;
  onChange: (on: boolean) => void;
  /** A login terminal is already open: flipping back now would orphan it, so the
   *  switch waits for its Disconnect. */
  busy?: boolean;
  /** The last headless attempt on this channel failed. */
  failed?: boolean;
}) {
  const t = useT();
  if (IS_WINDOWS) return null;
  const what = channel === "ssh" ? t("terminalSignIn.sshHostWord") : t("terminalSignIn.vpnTunnelWord");
  return (
    <label
      className="remote-connect-remember terminal-signin-toggle"
      title={
        busy
          ? t("terminalSignIn.busyTitle")
          : t("terminalSignIn.titleTemplate", { what })
      }
    >
      <Toggle size="sm" checked={checked} disabled={busy} onChange={(e) => onChange(e.target.checked)} />
      {t("terminalSignIn.label")} <UntestedTag id="terminalSignIn.label" />
      <span className={`ssh-optional-hint${failed ? " terminal-signin-suggest" : ""}`}>
        {failed
          ? t("terminalSignIn.failedHint", { what })
          : t("terminalSignIn.defaultHint")}
      </span>
    </label>
  );
}
