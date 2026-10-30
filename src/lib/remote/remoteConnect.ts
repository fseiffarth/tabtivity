import { openTabInRootConsole } from "../../stores/rootOverlay";
import { invoke } from "@tauri-apps/api/core";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { onTerminalExit } from "../terminal/terminalBus";
import { onTerminalSpawnFailed } from "../terminal/terminalSpawnFailed";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { withHostKeyConfirm } from "./hostKey";
import type { LoginTarget } from "./loginTarget";
import { translateNow } from "../i18n";

/**
 * The directory a fresh connect/browse should open in for `host`: the standard
 * path set in Settings' "Remote Connections" panel if there is one, else the
 * SSH-reported home directory. Best-effort — either lookup failing just falls
 * through to the next, never blocking a connect that already succeeded.
 *
 * Shared by every remote connect+browse flow (`useRemoteSession` for the
 * new/extend-project dialog, `RemoteMachinesWindow` for add-worker-machine) so
 * they resolve the starting folder identically.
 */
export async function resolveRemoteStartDir(
  user: string | null | undefined,
  host: string,
  port: number | null | undefined,
  password: string | null,
): Promise<string> {
  const configured = await invoke<string | null>("remote_get_default_path", { host }).catch(
    () => null,
  );
  if (configured) return configured;
  return invoke<string>("ssh_default_dir", { user, host, port, password }).catch(() => "");
}

/**
 * Non-headless remote-connection support: instead of Tabtivity handling the
 * SSH/OpenVPN password itself, the login runs in a terminal tab in the Tabtivity
 * **root** scope, where the user types the password directly into the live
 * terminal. Tabtivity never sees it (a saved one can be pasted in from the
 * keychain by the backend — `credential_paste_to_pty`).
 *
 * Gated by the `connections_headless` setting (default ON = old headless flow).
 */

/**
 * Configs/targets we've already opened a connection tab for this session, so a
 * project that is re-activated several times doesn't spawn a duplicate tab each
 * time. Keyed by an opaque caller-supplied string (the .ovpn path or the SSH
 * target). Session-only — cleared on reload like other transient state.
 *
 * The value is the **root tab** carrying that connection, or `null` for a
 * connection some other surface owns (`markConnectionOpened` — the Connect dialog's
 * embedded terminal). That distinction is what makes the dedupe self-healing rather
 * than sticky: a tab the user closed is not a connection, so the mark expires with
 * it — as it does when its login ends (ssh/openvpn exited: the tab only shows its
 * exited state, with nothing left to authenticate in). Without that, closing the
 * login tab left the key claimed for the rest of the session and every later
 * request — an activation, an auto-connect — silently opened nothing and then
 * waited on a master that was never coming.
 */
const openedConnections = new Map<string, string | null>();

/** Reset the dedupe entry (e.g. when a connection is torn down). */
export function forgetConnection(dedupeKey: string): void {
  openedConnections.delete(dedupeKey);
}

/** Whether this connection's terminal is still around to authenticate in. A tab
 *  owned elsewhere (`null`) is that surface's business, not ours. Exported because a
 *  caller waiting on the user to log in (`pollRootLoginReady`) needs to know when
 *  they closed the tab instead — that is a "never mind", not a failure. */
export function connectionStillOpen(dedupeKey: string): boolean {
  if (!openedConnections.has(dedupeKey)) return false;
  const tabKey = openedConnections.get(dedupeKey);
  if (tabKey == null) return true;
  return (useTabsStore.getState().tabsByScope.root ?? []).some((t) => t.key === tabKey);
}

/**
 * Mark a connection as already opened WITHOUT spawning a root tab. The
 * non-headless project dialog uses this when it brings a VPN tunnel / SSH login
 * up in its own embedded terminal: pre-marking the same `dedupeKey` that
 * activation would use makes the later `openConnectionInRoot` call a no-op, so
 * the connection the user already authenticated in the dialog isn't duplicated
 * as a root-terminal tab.
 */
export function markConnectionOpened(dedupeKey: string): void {
  openedConnections.set(dedupeKey, null);
}

/**
 * Open a login terminal for `login` in the **root** scope: a tab whose PTY runs
 * the ssh/OpenVPN login itself as its program, built by the backend from the
 * target (`TabEntry.login`) — no shell before or after it, and no command line
 * typed into one. A password prompt it raises is answered in that visible
 * terminal (or by the paste bar, which only a login PTY accepts).
 *
 * The active project is deliberately NOT changed (this is called mid-activation,
 * where switching scope would undo the activation in progress); instead a brief
 * toast points the user at the root terminal. The user switches to root to
 * authenticate when ready; downstream sshfs mounts retry and ride the shared
 * master once it is up.
 *
 * `dedupeKey` suppresses a duplicate tab when the same connection is requested
 * again within the session — but only while that tab is still there to type into
 * (see `connectionStillOpen`); pass `null` to always open a new tab.
 */
export function openConnectionInRoot(opts: {
  label: string;
  login: LoginTarget;
  dedupeKey?: string | null;
}): void {
  const { label, login, dedupeKey } = opts;
  if (dedupeKey != null && connectionStillOpen(dedupeKey)) return;
  const rootDir = useProjectsStore.getState().rootDir ?? "";
  // Claimed before the tab exists: root may have to be restored first, and a
  // second request landing in that gap must not open a second login.
  if (dedupeKey != null) openedConnections.set(dedupeKey, null);
  // Surface it without stealing the active project: a transient toast (auto-clears
  // in AppShell) tells the user the connection is waiting in the root terminal.
  useProjectsStore.setState({
    switchToast: translateNow("remoteConnect.authInRootToast", { label }),
  });
  // …and put the prompt in front of them: the root console floats over the
  // project, so a login that needs a password no longer waits behind a scope
  // switch the user has to go and make.
  openTabInRootConsole(
    {
      label,
      // Ignored by the backend for a login tab (it runs the login's own argv in
      // the root work dir); kept so the tab reads like any other root shell.
      cmd: "",
      cwd: rootDir,
      kind: "shell",
      login,
    },
    (tab) => {
      if (dedupeKey == null) return;
      openedConnections.set(dedupeKey, tab.key);
      // The login ending (ssh/openvpn exited — a failed or a logged-out session)
      // ends the connection this key stands for: the tab stays, showing its
      // exited state, but a new request must open a fresh login rather than
      // point at a dead one. So does a login that never started (its spawn
      // refused or failed — the tab shows `[spawn error: …]`, and no exit ever
      // comes for a PTY that never was). Only while the key still maps to THIS tab.
      const ptyId = `root:${tab.key}`;
      const release = () => {
        offExit();
        offSpawnFailed();
        if (openedConnections.get(dedupeKey) === tab.key) openedConnections.delete(dedupeKey);
      };
      const offExit = onTerminalExit(ptyId, release);
      const offSpawnFailed = onTerminalSpawnFailed(ptyId, release);
    },
  );
}

/**
 * The first pooled connect of a remote project a create dialog just made — opened by
 * the dialog, the way `ExtendToRemoteDialog` carries its session over.
 *
 * Reaching "Create" took a live, authenticated session (the folder was browsed or
 * made over it), so the new project comes up connected rather than on a Connect
 * prompt. And this connect says **how** it authenticated, which only the dialog
 * knows: the password it was typed (handed over, never stored — saving is the "Save
 * password" toggle's job), or, with none, that it rides the master the dialog's
 * login terminal left up (`viaLogin`). Without that flag a credential-less connect
 * reads backend-side as key auth and stamps `key_auth: true` onto a password host
 * (`record_key_auth`), which then advertises a promptless auto-connect it cannot
 * deliver. (A key host created without a password is sent `viaLogin` too: that only
 * records nothing, and its next connect from the lamp records the key auth.)
 *
 * Fire-and-forget for the dialog; never fights a lamp already moving. A failure with
 * a typed password is red; one with none (no master to ride — e.g. Windows, which
 * has no control socket) leaves the project disconnected, as it was before.
 *
 * Resolves to `null` once the project is connected (or a connect was already
 * under way), else to the failure's text — a remote-only creation awaits it,
 * because its host setup needs the pooled connection.
 */
export async function connectCreatedRemoteProject(
  projectId: string,
  password: string | null | undefined,
): Promise<string | null> {
  const status = () => useRemoteStatusStore.getState();
  const current = status().byProject[projectId]?.ssh ?? "off";
  if (current === "connected" || current === "connecting") return null;
  const typed = password || null;
  status().setSsh(projectId, "connecting");
  try {
    await withHostKeyConfirm(() =>
      invoke("remote_connect", {
        projectId,
        password: typed,
        viaLogin: typed === null,
        // The user clicked Create and is watching the lamp; `remote_connect`
        // defaults to background, which a host tagged HPC refuses.
        background: false,
      }),
    );
    status().setSsh(projectId, "connected");
    return null;
  } catch (error) {
    console.warn("first connect of the new remote project failed", error);
    status().setSsh(projectId, typed === null ? "off" : "error");
    return String(error);
  }
}
