import { envName } from "../brand";

/**
 * The login a login terminal runs — mirrors the backend's
 * `commands::credentials::LoginTarget`, the payload of `PtyOptions.login`.
 *
 * A terminal spawned with one runs that login (`ssh …` / `openvpn …`) as its PTY's
 * own program, built by the backend from this target — no shell before or after
 * it, no caller-chosen command line. That PTY, and only while its login runs, is
 * what a saved credential may be pasted into (`credential_paste_to_pty`); when
 * ssh/openvpn exits the tab shows its ordinary exited state.
 */
export type LoginTarget =
  | { kind: "ssh"; user: string | null; host: string; port: number | null }
  | { kind: "vpn"; config: string };

/** An interactive ssh login to `user@host:port`. A blank user is "none". */
export function sshLogin(
  user: string | null | undefined,
  host: string,
  port: number | null | undefined,
): LoginTarget {
  return { kind: "ssh", user: user || null, host, port: port ?? null };
}

/** An interactive OpenVPN connect for the client config at `config`. */
export function vpnLogin(config: string): LoginTarget {
  return { kind: "vpn", config };
}

/** The connection dedupe key (`lib/remote/remoteConnect`) a login satisfies:
 *  `ssh:<user@>host:<port>` / `vpn:<config>` — the one spelling every login
 *  flow pre-marks and every activation looks up. */
export function loginDedupeKey(login: LoginTarget): string {
  if (login.kind === "vpn") return `vpn:${login.config}`;
  return `ssh:${login.user ? `${login.user}@` : ""}${login.host}:${login.port ?? ""}`;
}

/** The marker a browser client's refused ssh login carries when the host was
 *  stored by a non-admin browser account and nobody approved it yet. Mirrors
 *  `commands::credentials::SSH_LOGIN_UNAPPROVED`. */
export const SSH_LOGIN_UNAPPROVED = envName("SSH_LOGIN_UNAPPROVED");

/** Whether a `pty_spawn` error is that refusal — said in the user's language,
 *  naming the approval, rather than printed as it is. */
export function loginHostUnapproved(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return text.includes(SSH_LOGIN_UNAPPROVED);
}
