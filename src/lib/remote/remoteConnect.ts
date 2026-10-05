import { openTabInRootConsole } from "../../stores/rootOverlay";
import { invoke } from "@tauri-apps/api/core";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";

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
 * SSH/OpenVPN password itself, the actual connecting command is launched as an
 * interactive shell tab in the Tabtivity **root** scope, where the user types the
 * password directly into the live terminal. Tabtivity never sees or stores it.
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
 * it. Without that, closing the login tab left the key claimed for the rest of the
 * session and every later request — an activation, an auto-connect — silently opened
 * nothing and then waited on a master that was never coming.
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
 * Open `command` as an interactive shell tab in the **root** scope. `command` is
 * typed into the freshly-spawned shell via the tab's `initialInput` (see
 * TerminalView), so a password prompt it raises is answered in that visible
 * terminal — Tabtivity never handles the password.
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
  command: string;
  dedupeKey?: string | null;
}): void {
  const { label, command, dedupeKey } = opts;
  if (dedupeKey != null && connectionStillOpen(dedupeKey)) return;
  const rootDir = useProjectsStore.getState().rootDir ?? "";
  // Claimed before the tab exists: root may have to be restored first, and a
  // second request landing in that gap must not open a second login.
  if (dedupeKey != null) openedConnections.set(dedupeKey, null);
  // Surface it without stealing the active project: a transient toast (auto-clears
  // in AppShell) tells the user the connection is waiting in the root terminal.
  useProjectsStore.setState({ switchToast: `${label} — authenticate in root terminal` });
  // …and put the prompt in front of them: the root console floats over the
  // project, so a login that needs a password no longer waits behind a scope
  // switch the user has to go and make.
  openTabInRootConsole(
    {
      label,
      cmd: "", // empty → backend default_shell()
      cwd: rootDir, // empty resolves to ~/tabtivity/root on the backend
      kind: "shell",
      initialInput: command,
    },
    (tab) => {
      if (dedupeKey != null) openedConnections.set(dedupeKey, tab.key);
    },
  );
}
