import { useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  needsSeparateKeyPassphrase,
  type ComputeHost,
  type ProjectEntry,
  type StoredVpnConfig,
  type VpnAuthNeeds,
} from "../../types";
import { IS_WINDOWS } from "../../lib/platform";
import { forgetConnection, markConnectionOpened } from "../../lib/remote/remoteConnect";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useRemoteStatusStore, type ConnState } from "../../stores/remote/remoteStatus";
import { isHpcHost, targetOfSpec } from "../../lib/remote/hpc/hpcHost";
import { autoConnectEligibility } from "./autoConnectEligibility";
import { useSavedCredential, type SshConnectOutcome } from "./useSavedCredential";
import {
  markVpnConnected,
  markVpnConnecting,
  markVpnError,
  releaseVpn,
} from "../../stores/remote/vpn/vpnStatus";
import type { LogLine } from "../common/ConnectionLog";
import { withHostKeyConfirm } from "../../lib/remote/hostKey";

// OpenVPN prints this once the tunnel is fully up (mirrors the backend's
// READY_MARKER in services/openvpn.rs). The embedded VPN login terminal is
// watched for it to flip the lamp green — identical to the new-project dialog
// (see useRemoteSession).
const VPN_READY_MARKER = "Initialization Sequence Completed";

// Shape of the `terminal-output` event payload (PTY id + raw output chunk).
interface TerminalOutput {
  id: string;
  data: string;
}

// Monotonic id source for the reconnect-panel embedded terminals. The id has no
// ":" so it never collides with a tab PTY id (`<scope>:<key>`) or trips the
// detached-PTY check. Module scope so it survives re-renders, and a distinct
// "reconnect-" prefix so it never collides with the dialog's "dialog-" ids.
let reconnectTermSeq = 0;
const nextReconnectTermId = (kind: string) => `reconnect-${kind}-${++reconnectTermSeq}`;

/** An embedded interactive login terminal: `{ id, command, key }` for a
 *  `TerminalView` that runs `command`, plus the activation dedupe `key` it
 *  pre-marked so the matching stop forgets exactly that key. `adopted` marks a
 *  terminal this hook instance did *not* spawn — it inherited a still-running one
 *  (see `liveTerms`), so it must re-attach rather than spawn a second PTY. */
type LoginTerm = { id: string; command: string; key: string; adopted?: boolean };

/**
 * Login terminals outlive the Connect dialog: their PTYs are spawned
 * `persistOnUnmount`, so an authenticated tunnel/login keeps running once the
 * modal closes. Holding them only in refs meant a *reopened* dialog no longer knew
 * their PTY ids — it could neither show them nor re-attach to them.
 *
 * (The VPN tunnel itself no longer depends on this for teardown: interactive tunnels
 * are armed with a `--writepid` the backend owns, so `openvpn_disconnect` reaches
 * the root daemon directly. It once didn't, and killing the PTY was the only — and
 * unreliable — way down.)
 *
 * So park them per project here (module scope, surviving the remount) and re-adopt
 * on mount. Re-adopted terminals render `attachOnly`, which skips `pty_spawn` — a
 * duplicate spawn on the same id would start a *second* `pkexec openvpn` — and, with
 * no spawn, no `terminal-ready` fires, so the login command isn't re-typed either.
 */
const liveTerms = new Map<string, { vpn?: LoginTerm; ssh?: LoginTerm }>();

const rememberTerm = (projectId: string, kind: "vpn" | "ssh", term: LoginTerm) => {
  const entry = liveTerms.get(projectId) ?? {};
  entry[kind] = term;
  liveTerms.set(projectId, entry);
};

const dropTerm = (projectId: string, kind: "vpn" | "ssh") => {
  const entry = liveTerms.get(projectId);
  if (!entry) return;
  delete entry[kind];
  if (!entry.vpn && !entry.ssh) liveTerms.delete(projectId);
};

/** Re-adopt a parked terminal for a fresh hook instance: same PTY, attach-only. */
const adoptTerm = (term: LoginTerm | undefined): LoginTerm | null =>
  term ? { ...term, adopted: true } : null;

/**
 * Reconnect lifecycle for an *existing* remote project, providing the same
 * embedded-login parts the new-project dialog has (`useRemoteSession`) but
 * driven by the project's already-known `remote` spec rather than fresh-entered
 * address / config + folder browse:
 *
 *  - an embedded OpenVPN login terminal (the user types the passphrase there;
 *    Tabtivity never handles it; the VPN lamp flips green on the ready marker), and
 *  - an embedded SSH login terminal that establishes the ControlMaster; once a
 *    credential-less `ssh_connect` rides it, the pooled SSH/SFTP connection is
 *    opened (`remote_connect`) and the SSH lamp goes green — which un-gates the
 *    CenterPanel tab restore exactly as the headline Reconnect button does.
 *
 * Status is published to `useRemoteStatusStore` (keyed by project id) so the
 * header lamps and the restore gate observe the same state this panel drives.
 */
export function useRemoteReconnect(project: ProjectEntry, host?: ComputeHost) {
  const projectId = project.id;
  // Multi-host remote (`docs/multi_host_remote_plan.md`): the dialog can target the
  // primary remote or an extra "worker" host. `hostId` keys the pool + lamp state;
  // `remote` is the spec to connect (the worker's own, or the primary's). A worker
  // connect kicks its one-way code fan-out (backend `remote_connect`), never the
  // primary's git-lockstep / byte-sync.
  const hostId = host?.id ?? "primary";
  const remote = host ?? project.remote;
  // The project's OpenVPN config path. Stateful (not just `remote.openvpn.config`)
  // because a project may have been created/extended on a no-VPN network with no
  // config, then need one attached here when reconnecting from a VPN-gated network
  // (see selectVpnConfig/browseVpnConfig, which also persist it to the project).
  // Seeded from the stored spec; the dialog is keyed by project id so this resets
  // per project rather than leaking a picked config across projects.
  const [vpnConfig, setVpnConfig] = useState(remote?.openvpn?.config ?? "");
  // Previously-stored `.ovpn` configs (newest first) offered for reuse when the
  // project carries none yet. Loaded on mount.
  const [vpnConfigs, setVpnConfigs] = useState<StoredVpnConfig[]>([]);
  // Auth username for `auth-user-pass` configs (see the backend's
  // `config_requires_userpass`). Seeded from the stored spec; `vpnNeeds` (queried
  // when the config changes) says which fields must be shown and filled — leave
  // one out and OpenVPN prompts for it on stdin, which is closed, so the handshake
  // hangs until it times out.
  const [vpnUsername, setVpnUsername] = useState(remote?.openvpn?.username ?? "");
  const [vpnNeeds, setVpnNeeds] = useState<VpnAuthNeeds>({
    username: false,
    keyPassphrase: false,
  });
  useEffect(() => {
    if (!vpnConfig) {
      setVpnNeeds({ username: false, keyPassphrase: false });
      return;
    }
    let cancelled = false;
    void invoke<VpnAuthNeeds>("openvpn_auth_needs", { config: vpnConfig })
      .then((v) => !cancelled && setVpnNeeds(v))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [vpnConfig]);

  // ── The SSH login name ───────────────────────────────────────────────────────
  // Editable here, and it has to be: the address is fixed when the project is
  // created (`user@host` in the new/extend dialog), so a project created with no
  // user — or the wrong one — had no surface that could correct it. That is not a
  // headless-only gap, and it fails differently on each side. In **headless** mode
  // there was simply no field, so Tabtivity authenticated as the local account name and
  // no password could ever be right. In **non-headless** the same wrong name is typed
  // into the login terminal (`initialInput` submits it on the user's behalf) and the
  // host rejects it in plain view — and the obvious recovery, retyping
  // `ssh right@host` by hand in that same terminal, does not help either: the
  // ControlMaster socket is `cm-%C`, whose hash covers the remote **user** as well as
  // host and port, so `pollSshReady`'s probe — still built from the *stored* name —
  // looks for a master that account never opened, finds none, and paints the lamp red
  // two minutes after a login that visibly succeeded on screen.
  //
  // So it is a draft, committed to the spec (blur/Enter, and defensively before
  // every connect) rather than passed loose: the pooled `remote_connect` and the
  // backend's tmux/git/sftp legs all re-read the *persisted* spec, so a user that
  // lived only in this component would connect the probe as one account and
  // everything after it as another.
  const [sshUser, setSshUser] = useState(remote?.user ?? "");
  useEffect(() => setSshUser(remote?.user ?? ""), [remote?.user]);
  // Mirrored into a ref so an in-flight poll/connect closure reads the current
  // value instead of the one captured when it started.
  const sshUserRef = useRef(sshUser);
  sshUserRef.current = sshUser;
  /** The login name as ssh should receive it: `null` = "unset, use ssh's default". */
  const effectiveUser = (): string | null => sshUserRef.current.trim() || null;

  const status = useRemoteStatusStore((s) =>
    hostId === "primary" ? s.byProject[projectId] : s.byHost[projectId]?.[hostId],
  );
  const sshStatus: ConnState = status?.ssh ?? "off";
  const vpnStatus: ConnState = status?.vpn ?? "off";
  const setSsh = useRemoteStatusStore((s) => s.setSsh);
  const setVpn = useRemoteStatusStore((s) => s.setVpn);

  // Deliberately NOT mirroring a machine-wide tunnel that merely matches this
  // project's stored config path into this project's own vpn status: that used to
  // "surface it here too" by marking this project connected and acquiring it as a
  // holder purely off a path match, even when the tunnel was actually brought up
  // by the header or another project. Two things followed from that, both wrong:
  // the OpenVPN section rendered its own "connected" card instead of collapsing to
  // `VpnTunnelUpNotice` like every other remote dialog does for a tunnel that
  // isn't its own (see `useVpnSectionVisible`) — and logging out of *this* project
  // then called `releaseVpn` on a holder slot it never earned, which could drop
  // the tunnel out from under whoever actually started it. `vpnStatus` is now only
  // ever set by an action this hook itself took (`connectVpnHeadless`,
  // `startVpnTerm`'s ready-marker watcher), so `showVpnSection`'s `ownTunnelBusy`
  // means what it says.

  // Windows has no ssh ControlMaster socket, so an interactive login can't be
  // ridden for the pooled connection — fall back to the headline (key-auth)
  // Reconnect there rather than offering the SSH login terminal.
  const winManual = IS_WINDOWS;

  // Headless-path error strings (surfaced under the password fields in the
  // Connect modal). The lamps carry the coarse state; these carry the reason.
  const [sshError, setSshError] = useState("");
  const [vpnError, setVpnError] = useState("");
  // Live OpenVPN handshake log for the headless connect (fed by the backend's
  // `openvpn-progress` event, same as the new-project dialog). Capped so a
  // chatty handshake can't grow unbounded.
  const [vpnLog, setVpnLog] = useState<LogLine[]>([]);
  const vpnLogSeq = useRef(0);

  // Whether a password is already saved in the OS keychain for this project's SSH
  // host, so the Connect modal can pre-check the "Save password" box. The shared
  // hook, not a local boolean: its answer is a **tri-state**, because a locked
  // keychain answers a lookup exactly like an empty one and reading that as
  // "nothing saved" is what unticked the box and let the next connect delete the
  // credential it had just authenticated with (`useSavedCredential`).
  const sshCredential = useSavedCredential(
    remote ? { user: remote.user ?? null, host: remote.host, port: remote.port ?? null } : null,
  );
  const sshSaved = sshCredential.saved;
  // The VPN half has no equivalent state command yet, so it stays a plain
  // boolean — its untick path is an explicit forget either way.
  const [vpnSaved, setVpnSaved] = useState(false);
  useEffect(() => {
    if (!vpnConfig) return;
    let cancelled = false;
    void invoke<boolean>("vpn_has_saved_password", { config: vpnConfig })
      .then((v) => !cancelled && setVpnSaved(v))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [vpnConfig]);

  // Auto-connect opt-in: connect this project silently on launch/activation. Only
  // offerable once the connect needs no input — a saved SSH password, or a host the
  // backend recorded as key/agent auth (`key_auth`, which is how a passwordless host
  // proves itself: it has nothing in the keychain to look for). `sshSaved` flips the
  // moment a "Save password" connect succeeds, so the checkbox comes alive right
  // there without a reopen.
  const autoConnect = remote?.auto_connect ?? false;
  // Key/agent auth (a passwordless connect) also makes auto-connect eligible, but a
  // passwordless host has nothing in the keychain, so `key_auth` is recorded by the
  // backend on a successful connect rather than known up front. Seed it from the
  // stored spec and flip it live the moment a credential-less connect succeeds
  // (mirroring how `sshSaved` comes alive), so the toggle un-greys right here
  // without waiting for the project to reload. This is what a worker relied on:
  // its `key_auth` was never recorded at all (the connect returned early), so its
  // toggle stayed disabled forever — see `record_worker_key_auth`.
  //
  // Only the **headless** connect may set it. A connect that rode an interactive
  // login's ControlMaster is credential-less for a completely different reason, and
  // reading that as key auth is what used to mark password hosts auto-connect-
  // eligible and then fail on every launch (`record_key_auth`, backend). Which is
  // why this gate is headless-only in the first place: the non-headless branch
  // renders its own ungated toggle, since there "auto-connect" means the login
  // opening in the root terminal, not a connect Tabtivity completes by itself.
  const [keyAuth, setKeyAuth] = useState(remote?.key_auth === true);
  useEffect(() => setKeyAuth(remote?.key_auth === true), [remote?.key_auth]);
  // One formula for all four surfaces (`autoConnectEligibility`), which is also
  // what finally brings the **HPC tag** into this dialog: `stores/projects`
  // refuses to dial a tagged host unattended, so a switch armed here was
  // guaranteed to do nothing and said nothing about why. `savedPassword` is the
  // *known*-saved half deliberately — an unreadable keychain can't feed a silent
  // connect, so it must not qualify one.
  const settings = useSettingsStore((s) => s.settings);
  const headless = settings?.connections_headless ?? true;
  const autoConnectHpc = isHpcHost(settings, targetOfSpec(remote));
  const autoConnectState = autoConnectEligibility({
    headless,
    keyAuth,
    savedPassword: sshSaved,
    hpc: autoConnectHpc,
  });
  const autoConnectEligible = autoConnectState.eligible;
  // A worker's toggles/label live on its `compute_hosts` entry (not the project's
  // primary remote). `patch_compute_host` returns the full updated list — apply it
  // back to the store so anything derived from `host` (the auto-connect toggle, the
  // dialog title's name) reflects the change at once; without this the UI wouldn't
  // visibly stick until a reload.
  const applyPatchedHosts = (hosts: ComputeHost[]) =>
    useProjectsStore.setState((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, compute_hosts: hosts } : p,
      ),
    }));

  const setAutoConnect = (enabled: boolean) => {
    if (host) {
      void invoke<ComputeHost[]>("patch_compute_host", { projectId, hostId, autoConnect: enabled })
        .then(applyPatchedHosts)
        .catch((e) => setSshError(String(e)));
      return;
    }
    void useProjectsStore
      .getState()
      .setProjectAutoConnect(projectId, enabled)
      .catch((e) => setSshError(String(e)));
  };

  // Rename this host's machine label (worker `label`, or the primary's own
  // `remote.label`) — distinct from the project name, which is edited elsewhere.
  // A blank name clears the label, so the display falls back to the bare host
  // (both backend commands trim and treat empty as "no label").
  const setWorkerLabel = (label: string) => {
    if (host) {
      void invoke<ComputeHost[]>("patch_compute_host", { projectId, hostId, label })
        .then(applyPatchedHosts)
        .catch((e) => setSshError(String(e)));
      return;
    }
    void useProjectsStore
      .getState()
      .setProjectRemoteLabel(projectId, label)
      .catch((e) => setSshError(String(e)));
  };

  /**
   * Write the edited login name onto this host's spec (the primary's `remote.user`,
   * or the worker's). Called on blur/Enter *and* at the top of every connect, so a
   * user who typed a name and hit Connect without leaving the field still connects
   * as that account rather than the stale one.
   *
   * A no-op when unchanged, so an ordinary connect costs no write. Returns the
   * committed value (`null` = cleared) so the caller can use it directly instead of
   * waiting for the store round-trip to reach `remote`.
   */
  const commitSshUser = async (): Promise<string | null> => {
    const next = effectiveUser();
    const current = remote?.user ?? null;
    if (next === current) return current;
    try {
      if (host) {
        const hosts = await invoke<ComputeHost[]>("patch_compute_host", {
          projectId,
          hostId,
          user: next ?? "",
        });
        applyPatchedHosts(hosts);
      } else {
        await useProjectsStore.getState().setProjectRemoteUser(projectId, next ?? "");
      }
    } catch (e) {
      setSshError(String(e));
    }
    return next;
  };

  // Load the recently-used OpenVPN configs so a project that carries none yet can
  // reuse one without re-browsing. Best-effort.
  const refreshVpnConfigs = () => {
    invoke<StoredVpnConfig[]>("openvpn_list_configs")
      .then(setVpnConfigs)
      .catch(() => setVpnConfigs([]));
  };
  useEffect(refreshVpnConfigs, []);

  // Persist the chosen config onto the project's remote spec (best-effort) so a
  // VPN attached here from a VPN-gated network is remembered for next time. The
  // opt-in toggle stays default-off, so remembering the config never forces the
  // tunnel on the networks that don't need it.
  const persistVpnConfig = (path: string) => {
    void useProjectsStore
      .getState()
      .setProjectOpenvpn(projectId, path, vpnUsername || null)
      .catch((e) => console.warn("persist openvpn config failed", e));
  };

  // Select a previously-stored config (its path is already a Tabtivity-stored copy).
  const selectVpnConfig = (path: string) => {
    setVpnConfig(path);
    setVpnError("");
    setVpnLog([]);
    persistVpnConfig(path);
  };

  // Pick a `.ovpn` file and copy it into Tabtivity's store, then adopt it. Joins the
  // recents list for future reuse.
  const browseVpnConfig = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "OpenVPN config", extensions: ["ovpn", "conf"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const stored = await invoke<string>("openvpn_store_config", { config: picked });
      setVpnConfig(stored);
      setVpnError("");
      setVpnLog([]);
      persistVpnConfig(stored);
      refreshVpnConfigs();
    } catch (e) {
      setVpnError(String(e));
    }
  };

  // Seeded from the parked terminals, so reopening the dialog re-adopts a login /
  // tunnel that is still running rather than losing its handle (see `liveTerms`).
  const vpnTermRef = useRef<LoginTerm | null>(adoptTerm(liveTerms.get(projectId)?.vpn));
  const sshTermRef = useRef<LoginTerm | null>(adoptTerm(liveTerms.get(projectId)?.ssh));
  // Bump to force a re-render when a ref-held terminal is opened/closed (the
  // terminals themselves live in refs so the readiness effects can read the
  // current one without re-subscribing on every status change).
  const [, force] = useReducer((n: number) => n + 1, 0);

  // Readiness poll timer for the SSH login's ControlMaster (see startSshTerm).
  const sshPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSshPoll = () => {
    if (sshPollTimer.current) {
      clearTimeout(sshPollTimer.current);
      sshPollTimer.current = null;
    }
  };

  // Per-channel connect "generation". A connect (headless invoke or ControlMaster
  // poll) captures the current value and only writes its outcome back if it still
  // matches — so `stopSsh`/`stopVpn` can bump the counter to *abandon* an in-flight
  // attempt whose backend call can't itself be cancelled (the ssh probe self-times
  // out at ConnectTimeout=10s; the OpenVPN handshake at CONNECT_TIMEOUT=45s). This
  // is what makes the Stop button actually resolve a frozen "connecting…" lamp:
  // without it the stale invoke would later flip the lamp back to error/connected.
  const sshGen = useRef(0);
  const vpnGen = useRef(0);

  // Tear everything down when the panel unmounts (project switch / reconnect
  // succeeded and the panel is replaced by the restored tabs). The PTYs are NOT
  // killed here — they `persistOnUnmount`, so an authenticated login/tunnel keeps
  // running for the now-connected project; only the poll timer is cleared.
  useEffect(() => clearSshPoll, []);

  // Flip the VPN lamp green once the interactive tunnel comes up. The embedded
  // login spawns `pkexec openvpn` in its own PTY, so the tunnel is not in the
  // backend's registry — watch the terminal's own output for the ready marker
  // (a small rolling buffer in case it straddles two chunks), mirroring the
  // dialog's watcher.
  useEffect(() => {
    const term = vpnTermRef.current;
    if (!term) return;
    const termId = term.id;
    let cancelled = false;
    let un: (() => void) | undefined;
    let buf = "";
    // Visible-only streaming: a hidden pane's PTY stops emitting
    // terminal-output entirely, and this panel's terminal can be hidden while
    // the tunnel comes up — the watch keeps its raw stream flowing so the
    // marker scan below still sees it.
    void invoke("pty_watch", { id: termId }).catch(() => {});
    void listen<TerminalOutput>("terminal-output", (ev) => {
      if (ev.payload.id !== termId) return;
      buf = (buf + ev.payload.data).slice(-512);
      // The marker is the fastest signal the tunnel is up (the backend also knows,
      // via the pidfile its `--writepid` arming recorded — but only once OpenVPN
      // gets around to writing it).
      if (buf.includes(VPN_READY_MARKER) && vpnConfig) {
        markVpnConnected(projectId, vpnConfig);
      }
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
      void invoke("pty_unwatch", { id: termId }).catch(() => {});
    };
    // vpnTerm is ref-held; re-run when its identity changes via the force tick.
  }, [vpnTermRef.current?.id, projectId, vpnConfig]);

  // Bring the OpenVPN tunnel up in an embedded terminal. The connect command
  // runs interactively so the user types the passphrase in that visible terminal
  // — Tabtivity never handles it. The PTY persists past this panel so the tunnel
  // stays up for the reconnected project; we pre-mark the dedupe key so any later
  // activation root-terminal fallback is suppressed.
  const startVpnTerm = async () => {
    if (!vpnConfig || vpnTermRef.current) return;
    try {
      const command = await invoke<string>("openvpn_login_command", { config: vpnConfig });
      const key = `vpn:${vpnConfig}`;
      markConnectionOpened(key);
      const term = { id: nextReconnectTermId("vpn"), command, key };
      vpnTermRef.current = term;
      rememberTerm(projectId, "vpn", term);
      markVpnConnecting(projectId, vpnConfig);
      force();
    } catch {
      markVpnError(projectId, vpnConfig);
    }
  };

  // Stop the OpenVPN channel: cancel any in-flight connect (headless invoke or the
  // embedded login terminal) and reset the lamp to off. Bumping the generation
  // abandons a frozen headless connect; killing the PTY + dropping the dedupe mark
  // tears down an interactive tunnel; `releaseVpn` drops this project's claim on a
  // tunnel that had already come up. Used by both the terminal Disconnect and the
  // headless Stop button.
  //
  // *Releases*, not disconnects: this button is scoped to one project, but the
  // tunnel is machine-wide and shared by config path, so it only actually comes
  // down if no other project is still holding it — otherwise stopping the VPN here
  // would pull the routing out from under that project and the rest of the OS. The
  // header's VPN indicator is where a tunnel is killed outright.
  const stopVpn = () => {
    vpnGen.current++;
    const term = vpnTermRef.current;
    if (term) {
      // Close the login terminal. This is no longer the *teardown* — the interactive
      // tunnel is armed with a `--writepid` the backend owns, so `releaseVpn` below
      // signals the root daemon properly rather than hoping a dead PTY takes it with
      // it (it didn't: the daemon is root and outlived the terminal).
      void invoke("pty_kill", { id: term.id }).catch(() => {});
      forgetConnection(term.key);
      vpnTermRef.current = null;
      dropTerm(projectId, "vpn");
    }
    releaseVpn(projectId, vpnConfig);
    setVpn(projectId, "off", hostId);
    force();
  };

  // Poll for the embedded login's ControlMaster to come up: a credential-less
  // ssh_connect rides the master once it is live (and on key-auth hosts succeeds
  // immediately). On the first success we open the pooled SSH/SFTP connection
  // (`remote_connect`) and mark SSH connected — which un-gates the CenterPanel
  // tab restore. Bounded (~2 min) so a never-authenticated login eventually
  // stops; never hard-errors while the terminal is up (the login may just not be
  // authenticated yet).
  const pollSshReady = (attempt = 0, gen = sshGen.current) => {
    if (!remote || gen !== sshGen.current) return; // stopped mid-poll
    const maxAttempts = 40; // ~2 min at 3s cadence
    void invoke<void>("ssh_connect", {
      // The *live* login name, not the one captured when the poll started. The
      // ControlMaster socket is hashed over (user, host, port), so probing as a
      // different account than the login terminal authenticated as finds no master
      // and polls out — a red lamp behind a login that visibly succeeded.
      user: effectiveUser(),
      host: remote.host,
      port: remote.port ?? null,
      password: null,
      // A credential-less probe is ambiguous to the dial policy — it looks exactly
      // like a background sweep — but this one is waiting on a master the user
      // just authenticated in the terminal above. Say so, or a host tagged HPC
      // refuses every attempt and the poll times out behind a visibly-good login.
      background: false,
    })
      .then(async () => {
        if (gen !== sshGen.current) return; // stopped while the probe ran
        clearSshPoll();
        // Master is up; bring the pool up so every later channel rides it.
        try {
          // `viaLogin`: this connect rode the master the login terminal above just
          // established, so its credential-less success says nothing about how the
          // host authenticates — the backend must not read it as key auth. It used
          // to (and this hook used to mirror that reading into `keyAuth`), which
          // stamped `key_auth: true` onto password hosts and made them advertise a
          // promptless auto-connect that failed on every launch. In this mode the
          // toggle needs no such evidence: it is offered unconditionally, because
          // "auto-connect" here *means* this same login opening by itself.
          // `background: false` — a person opened this login and is waiting on it;
          // `remote_connect` now defaults to background, which a tagged HPC host
          // refuses outright.
          await invoke("remote_connect", {
            projectId,
            hostId,
            password: null,
            viaLogin: true,
            background: false,
          });
          if (gen !== sshGen.current) return;
          setSsh(projectId, "connected", hostId);
        } catch {
          if (gen !== sshGen.current) return;
          setSsh(projectId, "error", hostId);
        }
      })
      .catch(() => {
        if (gen !== sshGen.current) return; // stopped while the probe ran
        if (attempt + 1 >= maxAttempts) {
          clearSshPoll();
          setSsh(projectId, "error", hostId);
          return;
        }
        sshPollTimer.current = setTimeout(() => pollSshReady(attempt + 1, gen), 3000);
      });
  };

  // Open the interactive SSH login in an embedded terminal. It establishes the
  // ControlMaster the pooled connection then rides, so reconnect completes
  // without Tabtivity ever handling the password. Persisted past the panel; the
  // dedupe mark suppresses any activation root-terminal login.
  const startSshTerm = async () => {
    if (!remote || sshTermRef.current || winManual) return;
    try {
      // Commit the edited login name FIRST: it is what the command types, what the
      // readiness probe rides the resulting master with, and what the pooled
      // `remote_connect` re-reads from the spec. All three must agree.
      const user = await commitSshUser();
      const command = await invoke<string>("remote_login_command", {
        user,
        host: remote.host,
        port: remote.port ?? null,
      });
      const target = `${user ? `${user}@` : ""}${remote.host}`;
      const key = `ssh:${target}:${remote.port ?? ""}`;
      markConnectionOpened(key);
      const term = { id: nextReconnectTermId("ssh"), command, key };
      sshTermRef.current = term;
      rememberTerm(projectId, "ssh", term);
      const gen = ++sshGen.current;
      setSsh(projectId, "connecting", hostId);
      force();
      pollSshReady(0, gen);
    } catch {
      setSsh(projectId, "error", hostId);
    }
  };

  // Manual re-arm of the readiness poll ("I've logged in — connect"), for when
  // the user authenticates after the auto-poll gave up, or wants to retry sooner.
  const tryConnectNow = () => {
    if (!sshTermRef.current) return;
    clearSshPoll();
    const gen = ++sshGen.current;
    setSsh(projectId, "connecting", hostId);
    pollSshReady(0, gen);
  };

  // ── Headless connect path (Connect modal, `connections_headless` ON) ─────────
  // Tabtivity feeds the password to the backend itself (no visible login terminal);
  // the OpenVPN handshake streams into `vpnLog` as a read-only progress view.

  // Stream the live OpenVPN handshake into `vpnLog` (only lines for this
  // project's config; the backend tags each line with its config path).
  useEffect(() => {
    if (!vpnConfig) return;
    let cancelled = false;
    let un: (() => void) | undefined;
    void listen<{ config: string; line: string }>("openvpn-progress", (ev) => {
      if (ev.payload.config !== vpnConfig) return;
      setVpnLog((prev) => [...prev, { id: vpnLogSeq.current++, text: ev.payload.line }].slice(-500));
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [vpnConfig]);

  // Bring the OpenVPN tunnel up with the supplied secrets. `keyPassphrase` is only
  // a distinct secret for a config that has an encrypted key *and* an
  // `auth-user-pass` account (see `needsSeparateKeyPassphrase`); otherwise
  // `password` already is the key passphrase and this is empty. Blocks until the
  // backend reports the tunnel ready (or fails). Mirrors `useRemoteSession`'s
  // headless `connectVpn`.
  //
  // `remember` follows the same `true | null`, never-`false` rule the SSH connect
  // does, and for the identical reason: `openvpn_connect` also resolves
  // `typed || saved` before calling `remember_secret`, so a `false` on a
  // *successful* connect clears the passphrase (and username, and key passphrase)
  // it just authenticated with. Unticking deletes via `forgetVpnPassword`.
  const connectVpnHeadless = async (
    password: string,
    keyPassphrase = "",
    remember: true | null = null,
  ) => {
    if (!vpnConfig) return;
    const gen = ++vpnGen.current;
    markVpnConnecting(projectId, vpnConfig);
    setVpnError("");
    setVpnLog([]);
    try {
      await invoke("openvpn_connect", {
        config: vpnConfig,
        username: vpnUsername || null,
        // Blank means "use the saved passphrase", never "authenticate with the empty
        // string" — send null so the backend falls back to the keychain.
        password: password || null,
        keyPassphrase: keyPassphrase || null,
        remember,
      });
      if (gen !== vpnGen.current) {
        // Stopped mid-connect — but the tunnel came up anyway: `stopVpn`'s teardown
        // raced ahead of the handshake it was trying to cancel. Leaving it would
        // strand the machine's routing on a tunnel nobody asked for and nothing in
        // the UI claims. Release again now that it's real (a no-op if some *other*
        // project is holding this config).
        releaseVpn(projectId, vpnConfig);
        return;
      }
      // Persist the (non-secret) username so a later silent activation can reuse
      // it from the keychained password with no prompt.
      if (vpnNeeds.username && vpnUsername) persistVpnConfig(vpnConfig);
      setVpnSaved(remember === true);
      markVpnConnected(projectId, vpnConfig);
    } catch (e) {
      if (gen !== vpnGen.current) return; // stopped — ignore the stale failure
      markVpnError(projectId, vpnConfig);
      setVpnError(String(e));
    }
  };

  // Open the pooled SSH/SFTP connection with the supplied password. On success
  // the pool is up and the SSH lamp goes green — which lets the CenterPanel's
  // held remote panes mount and spawn. Mirrors `pollSshReady`'s success branch
  // but with a user-typed password rather than riding an existing ControlMaster.
  //
  // `remember` is `true` ("save it") or `null`/`undefined` ("leave the keychain
  // alone") and **never** `false`: `false` is `Remember::Clear`, and since
  // `ssh_connect` resolves `typed || saved` before it writes, a successful connect
  // carrying it deletes the very password it authenticated with. Callers build the
  // value with `rememberArg`; deleting is the explicit forget's job alone.
  const connectSshHeadless = async (password: string, remember?: true | null) => {
    if (!remote) return;
    const gen = ++sshGen.current;
    setSsh(projectId, "connecting", hostId);
    setSshError("");
    // A blank field means "use what's saved" (the secret itself never comes back to
    // the UI, so a saved password can't be pre-filled — the user just leaves it
    // empty). Send null, not "": both legs read null as "nothing given" and fall
    // back to the keychain, where `""` would be taken as the password itself.
    const secret = password || null;
    try {
      // Commit the edited login name before either leg runs: `remote_connect` reads
      // the *persisted* spec, so a name that lived only in this component would
      // authenticate the probe as one account and the pool as another.
      const user = await commitSshUser();
      // First contact: if this host's key has never been accepted here, show its
      // fingerprint before the password goes anywhere, and retry once if accepted.
      const outcome = await withHostKeyConfirm(() =>
        invoke<SshConnectOutcome>("ssh_connect", {
        user,
        host: remote.host,
        port: remote.port ?? null,
        password: secret,
        // The checkbox, or `null` when there isn't one (the Windows key-auth
        // Connect button): `false` means "the user unticked it" and clears the
        // saved password — never say that on the user's behalf.
        remember: remember ?? null,
        // A typed password already reads as a gesture backend-side, but a blank
        // field riding a saved credential does not — and this is a Connect click
        // either way.
        background: false,
        }),
      );
      if (gen !== sshGen.current) return; // stopped mid-connect
      // The password must be handed to `remote_connect` too, not just the probe.
      // `ssh_connect` authenticates a throwaway process with `ControlMaster=no`
      // (reuse-only — it never *creates* a master), so a successful probe leaves
      // nothing behind for the pool to ride. `remote_connect` is what opens the
      // master-owning pooled session, and with a null password it drops to
      // key/agent auth — which a password-auth host rejects. It falls back to a
      // *saved* password, so this only ever worked with "Save password" ticked.
      await withHostKeyConfirm(() =>
        invoke("remote_connect", { projectId, hostId, password: secret, background: false }),
      );
      if (gen !== sshGen.current) return;
      // What is saved is what the backend **did**, not what the request asked for:
      // a locked keyring refuses the write and reports why, and a ticked box over
      // an empty keychain is exactly the state that resurfaces at the next launch
      // as an unexplained password prompt.
      sshCredential.applyOutcome(outcome);
      // No password given, none saved, and the connect still succeeded → the host
      // authenticated via key/agent auth (the backend records the same). Flip the
      // eligibility flag so the Auto-connect toggle comes alive here, no reload.
      if (secret === null && !sshSaved && !remember) setKeyAuth(true);
      setSsh(projectId, "connected", hostId);
    } catch (e) {
      if (gen !== sshGen.current) return; // stopped — ignore the stale failure
      setSsh(projectId, "error", hostId);
      setSshError(String(e));
    }
  };

  // Delete this project's saved SSH password from the OS keychain. Used by both
  // "Forget saved password" and by unticking "Save password" — unticking is a
  // request to not have the secret stored, and deferring that to the next connect
  // would leave it sitting in the keychain for a session that may never reconnect.
  // The live connection is untouched: forgetting a credential and dropping the pool
  // are separate acts; the caller pairs them for a full log-out.
  const forgetSshPassword = async () => {
    if (!remote) return;
    try {
      await sshCredential.forget();
      // Auto-connect leaned on that password: with it gone (and no key auth to fall
      // back on) the opt-in can no longer fire, so clear it rather than leave a
      // ticked toggle that silently does nothing. `autoConnectRemote` re-checks
      // eligibility anyway — this just keeps the UI honest.
      if (remote.auto_connect && remote.key_auth !== true) setAutoConnect(false);
    } catch (e) {
      setSshError(String(e));
    }
  };

  // Same for the VPN passphrase (and, for a config with both, its key passphrase —
  // `vpn_forget_password` clears both accounts).
  const forgetVpnPassword = async () => {
    if (!vpnConfig) return;
    try {
      await invoke("vpn_forget_password", { config: vpnConfig });
      setVpnSaved(false);
    } catch (e) {
      setVpnError(String(e));
    }
  };

  // "Forget saved password": drop every credential this project has stored.
  const forgetPasswords = async () => {
    await forgetSshPassword();
    await forgetVpnPassword();
  };

  // Stop the SSH channel: cancel any in-flight connect (headless invoke or the
  // ControlMaster poll), tear down an embedded login terminal, best-effort drop a
  // half-open pool, and reset the lamp to off. Mirror of `stopVpn`; used by both
  // the terminal Disconnect and the headless Stop button.
  const stopSsh = () => {
    sshGen.current++;
    clearSshPoll();
    const term = sshTermRef.current;
    if (term) {
      void invoke("pty_kill", { id: term.id }).catch(() => {});
      forgetConnection(term.key);
      sshTermRef.current = null;
      dropTerm(projectId, "ssh");
    }
    void invoke("remote_disconnect", { projectId, hostId }).catch(() => {});
    setSsh(projectId, "off", hostId);
    force();
  };

  return {
    sshStatus,
    vpnStatus,
    // The SSH login name, editable in both modes (see `commitSshUser`).
    sshUser,
    setSshUser,
    commitSshUser,
    vpnConfig,
    vpnConfigs,
    vpnUsername,
    setVpnUsername,
    vpnNeeds,
    // A second field is only warranted when the key passphrase is a *different*
    // secret from the password — see `needsSeparateKeyPassphrase`.
    vpnNeedsKeyPassphrase: needsSeparateKeyPassphrase(vpnNeeds),
    selectVpnConfig,
    browseVpnConfig,
    winManual,
    vpnTerm: vpnTermRef.current,
    sshTerm: sshTermRef.current,
    startVpnTerm,
    stopVpn,
    startSshTerm,
    stopSsh,
    tryConnectNow,
    // Headless connect path
    sshError,
    vpnError,
    vpnLog,
    sshSaved,
    // The tri-state behind `sshSaved`, for the shared "Save password" row: it is
    // what lets a locked keychain say so instead of proposing a delete.
    sshCredential,
    vpnSaved,
    autoConnect,
    autoConnectEligible,
    // Which wall an ineligible switch hit — the two have different remedies.
    autoConnectBlock: autoConnectState.reason,
    setAutoConnect,
    setWorkerLabel,
    connectVpnHeadless,
    connectSshHeadless,
    forgetPasswords,
    forgetSshPassword,
    forgetVpnPassword,
  };
}
