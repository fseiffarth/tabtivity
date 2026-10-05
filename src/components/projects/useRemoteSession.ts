import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  needsSeparateKeyPassphrase,
  type SshTooling,
  type StoredVpnConfig,
  type VpnAuthNeeds,
} from "../../types";
import { joinRemotePath, parseSshAddress, type ParsedSshAddress } from "./scaffold";
import { useRemoteBrowse } from "./useRemoteBrowse";
import { rememberArg, useSavedCredential } from "./useSavedCredential";
import { useVpnStatusStore } from "../../stores/remote/vpn/vpnStatus";
import { IS_WINDOWS } from "../../lib/platform";
import {
  forgetConnection,
  markConnectionOpened,
  resolveRemoteStartDir,
} from "../../lib/remote/remoteConnect";
import { useSettingsStore } from "../../stores/settings";
import { useT, type TranslationKey } from "../../lib/i18n";
import type { LogLine } from "../common/ConnectionLog";

type ConnStatus = "idle" | "connecting" | "connected" | "error";

// OpenVPN prints this once the tunnel is fully up (mirrors the backend's
// READY_MARKER in services/openvpn.rs). The embedded VPN login terminal is
// watched for it to flip the lamp green (see the readiness watcher below).
const VPN_READY_MARKER = "Initialization Sequence Completed";

// What the bounded ControlMaster poll says when it runs out. A give-up has to be
// *stated*: the lamp is the only thing the user can see, and an amber one that
// never resolves is indistinguishable from one still trying. Translated where the
// sentence is produced, rather than in `RemoteProjectSection`, which renders these
// alongside raw backend errors it has no key for.
const POLL_GAVE_UP: TranslationKey = "remoteSession.pollGaveUp";

// Shape of the `terminal-output` event payload (PTY id + a raw output chunk),
// matching the backend emit and TerminalView's own listener.
interface TerminalOutput {
  id: string;
  data: string;
}

/** Steps of the remote-project flow: connect (SSH + VPN) → browse a remote
 *  folder → fill in name/details. Local projects bypass these entirely. */
export type RemoteStep = "connect" | "browse" | "details";

// Monotonic id source for the dialog-embedded connection terminals. The id has
// no ":" so it never collides with a tab PTY id (`<scope>:<key>`) or trips the
// detached-PTY check. (Module scope so the counter survives re-renders.)
let dialogTermSeq = 0;

const nextDialogTermId = (kind: string) => `dialog-${kind}-${++dialogTermSeq}`;

/**
 * Owns the optional SSH + OpenVPN connection lifecycle for the new/import
 * project dialog: tooling probe, connect/disconnect, the live remote folder
 * browser, and the OpenVPN tunnel. Extracted from `ProjectDialog` so the dialog
 * stays a single cohesive form component; behavior is unchanged.
 */
export function useRemoteSession({ kind }: { kind: "new" | "import" }) {
  const t = useT();
  // Mirrors the global `connections_headless` setting (default ON): headless →
  // the password/passphrase is typed into Tabtivity's own fields and the backend
  // connects directly (`connectSsh`/`connectVpn`), same as activation's
  // `ensureVpnIfNeeded`. Off → the integrated login terminal is used instead, so
  // the user types the secret into a visible terminal embedded right here and
  // Tabtivity never handles it.
  const headless = useSettingsStore((s) => s.settings?.connections_headless ?? true);
  // Whether this is a remote (SSH) project. The whole SSH section — address,
  // password, connect, and the remote browser — only appears when this is on.
  const [isRemoteProject, setIsRemoteProject] = useState(false);
  // Availability of password-auth/openvpn tooling, fetched the first time the
  // remote checkbox is enabled so missing tools are flagged up front rather than
  // only after a connect fails. `null` until probed.
  const [sshTooling, setSshTooling] = useState<SshTooling | null>(null);
  const [sshAddress, setSshAddress] = useState("");
  // Previously-used SSH addresses (newest first), offered for reuse so a host
  // need only be typed once. Loaded when the remote section opens and refreshed
  // after a successful connect remembers the address (see rememberSshAddress).
  const [sshAddresses, setSshAddresses] = useState<string[]>([]);
  const [sshPassword, setSshPassword] = useState("");
  const [sshStatus, setSshStatus] = useState<ConnStatus>("idle");
  const [sshError, setSshError] = useState("");
  // "Save password" opt-in (default OFF), identical in mechanism to the Connect
  // modal's: the secret goes to the OS keychain **after** a successful auth, keyed
  // by the *host target* — not by the project, which doesn't exist yet here. That
  // is what lets the credential typed while creating/extending a project be the one
  // its later reconnects (and auto-connect) authenticate with, instead of being
  // thrown away the moment this dialog closes.
  const [sshRemember, setSshRemember] = useState(false);
  // The connect-and-browse mechanism (frozen (host, password) session + live SFTP
  // listing + navigation) is the SHARED one every remote-login dialog uses — see
  // `useRemoteBrowse`. This flow keeps its own fields/steps/VPN around it; the
  // browser state below is just re-exposed under the names the rest of this hook
  // and `RemoteProjectSection` already read.
  const browse = useRemoteBrowse();
  // The SSH address that was successfully connected (frozen at connect time so
  // edits to the input don't silently change which host we browse/submit to).
  const remoteConn = browse.conn;
  // The password that was used for the successful connect, frozen so the remote
  // listing always reuses the same credential the connection was made with.
  const remotePassword = browse.password;
  const remoteBrowsePath = browse.path;
  const remoteEntries = browse.entries;
  const remoteListBusy = browse.busy;
  const remoteListError = browse.error;
  // The remote folder the user committed to via "Use this folder".
  const [remoteChosenPath, setRemoteChosenPath] = useState("");
  // Previously-used remote paths for the current host (newest first), offered
  // for reuse so a project location need only be browsed/typed once per host.
  // Refreshed whenever the resolved host changes; see the effect below.
  const [remotePaths, setRemotePaths] = useState<string[]>([]);
  // --- Optional OpenVPN tunnel for VPN-gated remote hosts ---
  // "Connect via OpenVPN" opt-in, default OFF. Most hosts are reached directly
  // when you're already on the right network, so the VPN section stays collapsed
  // (and no config is stored on the project) until the user turns this on.
  const [vpnEnabled, setVpnEnabled] = useState(false);
  // `vpnConfig` holds the Tabtivity-stored `.ovpn` path (the picked file is copied
  // into Tabtivity on selection). The password is transient — never persisted.
  // A tunnel is "used" only when the toggle is on AND a config is selected.
  const [vpnConfig, setVpnConfig] = useState("");
  // Auth username for `auth-user-pass` configs (server-side username+password
  // auth). `vpnNeeds` (queried when the config changes) decides which fields are
  // shown and required; the username is persisted onto the new project's
  // OpenVpnSpec (it is not a secret). See `config_requires_userpass`.
  const [vpnUsername, setVpnUsername] = useState("");
  const [vpnNeeds, setVpnNeeds] = useState<VpnAuthNeeds>({
    username: false,
    keyPassphrase: false,
  });
  const [vpnPassword, setVpnPassword] = useState("");
  // Second secret, only for a config with an encrypted key *and* an
  // `auth-user-pass` account — OpenVPN prompts for those independently. Without an
  // account, `vpnPassword` already is the key passphrase (see
  // `needsSeparateKeyPassphrase`), so no second field is shown.
  const [vpnKeyPassphrase, setVpnKeyPassphrase] = useState("");
  const [vpnStatus, setVpnStatus] = useState<ConnStatus>("idle");
  const [vpnError, setVpnError] = useState("");
  // The VPN twin of `sshRemember`/`sshSaved`, keyed by config path. One toggle for
  // the whole tunnel (password + key passphrase + username), as in the Connect
  // modal — the backend saves or clears the set together.
  const [vpnRemember, setVpnRemember] = useState(false);
  const [vpnSaved, setVpnSaved] = useState(false);
  // Live OpenVPN handshake output for the headless connect, streamed from the
  // backend (`openvpn-progress`) and shown in a read-only log so the connect
  // isn't an opaque spinner. Reset at the start of each connect attempt.
  const [vpnLog, setVpnLog] = useState<LogLine[]>([]);
  // Monotonic id source for `vpnLog` lines. A dedicated counter (never reset on
  // slice) gives each pushed line a stable React key so the `.slice(-500)` cap
  // trims only the head without re-creating surviving line nodes.
  const vpnLogSeq = useRef(0);
  // Previously-used `.ovpn` configs (newest first), offered for reuse so a
  // config need only be browsed for once. Refreshed when the VPN section opens
  // and after a new config is stored.
  const [vpnConfigs, setVpnConfigs] = useState<StoredVpnConfig[]>([]);
  // --- Non-headless in-dialog connection terminals ---
  // In non-headless mode the OpenVPN tunnel and SSH login are interactive: the
  // user types the passphrase/password into a live terminal. Rather than
  // deferring those to a root-terminal tab at activation (the old flow), we
  // embed the live terminal right here in the dialog. Each holds `{ id, command }`
  // for an embedded `TerminalView` that runs `command` in a shell. The PTY is
  // spawned with `persistOnUnmount`, so closing the dialog leaves the
  // tunnel/login up for the new project to use; we also pre-mark the activation
  // dedupe key (see `markConnectionOpened`) so the root-tab flow is skipped.
  // Each holds the activation dedupe `key` it pre-marked (see `markConnectionOpened`)
  // so the matching `stopX` forgets *that* key — not one rebuilt from current
  // render state, which may have drifted (e.g. the config/address changed while
  // the terminal was up), leaving a stale mark that suppresses the real connect.
  const [vpnTerm, setVpnTerm] = useState<{ id: string; command: string; key: string } | null>(
    null,
  );
  const [sshTerm, setSshTerm] = useState<{ id: string; command: string; key: string } | null>(
    null,
  );

  // Per-connect "sign in in a terminal" (see `TerminalSignInToggle`): in headless
  // mode these swap the password fields for the same embedded login terminal the
  // non-headless mode uses, for this one connect. Default off — headless is the mode;
  // this is only the escape hatch for a host or tunnel that asks something the fields
  // cannot answer (a challenge code, a second prompt).
  const [sshViaTerminal, setSshViaTerminal] = useState(false);
  const [vpnViaTerminal, setVpnViaTerminal] = useState(false);

  const isRemote = sshStatus === "connected" && remoteConn !== null;

  // Windows has no ssh ControlMaster socket, so a non-headless login can't be
  // ridden for SFTP browsing — that mode falls back to typing the remote path.
  const winManual = IS_WINDOWS && !headless;

  // Which step of the remote flow we're on. Local projects ignore this (the
  // dialog renders its single form whenever the project isn't remote).
  const [step, setStep] = useState<RemoteStep>("connect");

  // Timer for the non-headless browse-readiness poll (see startSshTerm): once the
  // embedded interactive login authenticates, the shared ControlMaster comes up
  // and an otherwise-credential-less ssh_connect starts succeeding, at which point
  // we flip to the same connected/browse state headless reaches via connectSsh.
  const sshPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSshPoll = () => {
    if (sshPollTimer.current) {
      clearTimeout(sshPollTimer.current);
      sshPollTimer.current = null;
    }
  };
  useEffect(() => clearSshPoll, []);

  // Advance to the browser the moment the SSH session goes live (either mode),
  // so the user sees the lamp turn green and lands on the folder picker.
  useEffect(() => {
    if (isRemote) setStep((s) => (s === "connect" ? "browse" : s));
  }, [isRemote]);

  // Drop any live remote session back to the disconnected state. Called when
  // the user edits a credential (address/password) or unchecks "remote".
  const resetSshSession = () => {
    clearSshPoll();
    setSshStatus("idle");
    setSshError("");
    browse.reset();
    setRemoteChosenPath("");
    setStep("connect");
  };

  // Toggle remote mode. Turning it off tears down the SSH session and clears the
  // entered credentials so the dialog falls back to the local create/import flow.
  const toggleRemoteProject = (checked: boolean) => {
    setIsRemoteProject(checked);
    if (checked) {
      // Probe the remote tooling once so we can warn about anything missing
      // before the user fills in an address and hits Connect/Create.
      if (sshTooling === null) {
        invoke<SshTooling>("ssh_tooling_status").then(setSshTooling).catch(() => {});
      }
    }
    if (!checked) {
      setSshAddress("");
      setSshPassword("");
      resetSshSession();
      stopSshTerm();
      setVpnConfig("");
      setVpnPassword("");
      setVpnKeyPassphrase("");
      setVpnStatus("idle");
      setVpnError("");
      stopVpnTerm();
    }
  };

  // Load the list of previously-stored configs (newest first). Best-effort.
  const refreshVpnConfigs = () => {
    invoke<StoredVpnConfig[]>("openvpn_list_configs")
      .then(setVpnConfigs)
      .catch(() => setVpnConfigs([]));
  };

  // Load the recently-used SSH addresses (newest first). Best-effort.
  const refreshSshAddresses = () => {
    invoke<string[]>("ssh_list_addresses")
      .then(setSshAddresses)
      .catch(() => setSshAddresses([]));
  };

  // Persist `addr` as the most-recently-used SSH address and refresh the local
  // list so it surfaces immediately in the dropdown. Best-effort — a store
  // failure must never block the connection that just succeeded.
  const rememberSshAddress = (addr: string) => {
    const trimmed = addr.trim();
    if (!trimmed) return;
    invoke("ssh_remember_address", { address: trimmed })
      .then(refreshSshAddresses)
      .catch(() => {});
  };

  // Fetch the recent-configs and recent-addresses lists when the remote section
  // opens so a previously-used config/host can be picked without re-entering it.
  useEffect(() => {
    if (isRemoteProject) {
      refreshVpnConfigs();
      refreshSshAddresses();
    }
  }, [isRemoteProject]);

  // ── Saved credentials (OS keychain) ─────────────────────────────────────────
  // Both toggles mirror the Connect modal exactly, because they write the *same*
  // entries: the keychain is keyed by host target / config path, so there is one
  // saved credential per host and per tunnel, whichever menu put it there.

  // Does this host target already have a saved password? Re-asked as the typed
  // address changes, so the toggle always reflects the target being connected.
  // The shared tri-state hook, not a boolean: a locked keychain answers a lookup
  // exactly like an empty one, and taking that as "nothing saved" is what unticked
  // the box — which, before `remember` stopped being able to carry `false`, made
  // the next successful connect *delete* the credential it had authenticated with.
  const sshTarget = isRemoteProject ? parseSshAddress(sshAddress) : null;
  const sshCredential = useSavedCredential(
    sshTarget
      ? { user: sshTarget.user ?? null, host: sshTarget.host, port: sshTarget.port ?? null }
      : null,
  );
  const sshSaved = sshCredential.saved;
  // Pre-tick only on a *known*-saved credential; "checking"/"unreadable" leave the
  // box off, and an off box now means "leave the keychain alone", not "clear it".
  useEffect(() => setSshRemember(sshSaved), [sshSaved]);

  // Same question for the selected `.ovpn` (all of its secrets, so a config that
  // needs two and has one saved reports "not saved" — a silent connect would fail).
  useEffect(() => {
    if (!vpnConfig) {
      setVpnSaved(false);
      return;
    }
    let cancelled = false;
    invoke<boolean>("vpn_has_saved_password", { config: vpnConfig })
      .then((saved) => !cancelled && setVpnSaved(saved))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [vpnConfig]);
  useEffect(() => setVpnRemember(vpnSaved), [vpnSaved]);

  // Unticking a *saved* toggle is a request to drop the secret now — not at the
  // next connect, which may never come (the user may be about to abandon this
  // dialog). Same semantics as the Connect modal's toggles.
  const forgetSshPassword = async () => {
    await sshCredential.forget();
    setSshRemember(false);
  };

  const forgetVpnPassword = async () => {
    if (!vpnConfig) return;
    await invoke("vpn_forget_password", { config: vpnConfig }).catch(() => {});
    setVpnSaved(false);
    setVpnRemember(false);
  };

  // Load the recently-used remote paths for `host` (newest first). Best-effort;
  // an empty/unresolved host just clears the list.
  const refreshRemotePaths = (host: string) => {
    if (!host) {
      setRemotePaths([]);
      return;
    }
    invoke<string[]>("remote_list_paths", { host })
      .then(setRemotePaths)
      .catch(() => setRemotePaths([]));
  };

  // Persist `path` as the most-recently-used remote path for `host` and refresh
  // the local list. Best-effort — a store failure must never block project
  // creation, which already succeeded by the time this is called.
  const rememberRemotePath = (host: string, path: string) => {
    const trimmed = path.trim();
    if (!host || !trimmed) return;
    invoke("remote_remember_path", { host, path: trimmed })
      .then(() => refreshRemotePaths(host))
      .catch(() => {});
  };

  // The host path suggestions are scoped to: the live-connected host (browse
  // mode), or the address as currently typed (Windows manual-path mode, which
  // never opens a live session before submit).
  const suggestionHost = remoteConn?.host ?? (winManual ? parseSshAddress(sshAddress)?.host : undefined);

  // Refresh the path suggestions whenever the resolved host changes.
  useEffect(() => {
    refreshRemotePaths(suggestionHost ?? "");
  }, [suggestionHost]);

  // Remember a chosen remote path against the resolved host so it's offered in
  // the "Recently used…" lists on the next SSH project for the same host. Called
  // both when a browsed folder is committed ("Use this folder") and right before
  // a remote project is actually created/imported (see `buildRemoteSpec`'s call
  // site). `path` defaults to the committed `remoteChosenPath`; the browse commit
  // passes the just-browsed path explicitly, since the `remoteChosenPath` state
  // update from the same click isn't visible yet.
  const rememberChosenPath = (path?: string) => {
    const target = (path ?? remoteChosenPath).trim();
    if (!suggestionHost || !target) return;
    rememberRemotePath(suggestionHost, target);
  };

  // Stream the live OpenVPN handshake into `vpnLog` while the VPN section is
  // open. The backend tags each line with the config it belongs to, so we keep
  // only lines for the config currently selected here (the dialog connects one
  // tunnel at a time). Capped so a chatty handshake can't grow unbounded.
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

  // Which secrets does the chosen config need (an `auth-user-pass` account, an
  // encrypted key's passphrase, or both)? Drives which fields are shown/required —
  // a field OpenVPN wants but we don't supply becomes an unanswered stdin prompt
  // and hangs the handshake.
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

  // Select one of the previously-stored configs (its path is already an
  // Tabtivity-stored copy, so it's used as-is — no re-copy needed).
  const selectVpnConfig = (path: string) => {
    setVpnConfig(path);
    setVpnStatus("idle");
    setVpnError("");
    setVpnLog([]); // drop the previous config's handshake output
  };

  // Pick a `.ovpn` config and copy it into Tabtivity so the project no longer
  // depends on the original file's location (stored on first use). The new copy
  // joins the recent-configs list for future reuse.
  const browseVpnConfig = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "OpenVPN config", extensions: ["ovpn", "conf"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const stored = await invoke<string>("openvpn_store_config", { config: picked });
      setVpnConfig(stored);
      setVpnStatus("idle");
      setVpnError("");
      setVpnLog([]); // drop the previous config's handshake output
      refreshVpnConfigs();
    } catch (e) {
      setVpnError(String(e));
    }
  };

  // Bring the tunnel up now so a VPN-gated host becomes reachable for browsing.
  //
  // This is the *creation* dialog, so there is no project id yet and nobody can be
  // recorded as a holder — the tunnel comes up unclaimed. It is still machine-wide
  // and still rerouting everything, so it is registered machine-level regardless:
  // the header indicator shows it (and can bring it down) even if the user abandons
  // the dialog without ever creating the project.
  //
  // **Why not the `markVpn*` helpers.** They do two things: light the *project's*
  // lamp and keep the machine-level entry (plus the holder refcount `releaseVpn`
  // depends on) in step. Here the first half has no subject — the project id
  // genuinely does not exist yet — and inventing one would be worse than skipping
  // it: a holder nothing can ever call `releaseVpn` for is a tunnel nothing can
  // ever bring down. So the holder is a **deliberate no-op**, said out loud here so
  // the next reader doesn't "fix" the asymmetry by minting an id. The machine-level
  // half below is exactly what the helpers would have written.
  const connectVpn = async () => {
    if (!vpnConfig) return;
    setVpnStatus("connecting");
    setVpnError("");
    setVpnLog([]);
    useVpnStatusStore.getState().setState(vpnConfig, "connecting");
    try {
      await invoke("openvpn_connect", {
        config: vpnConfig,
        username: vpnUsername || null,
        // Blank + a saved credential = "use the saved one" (the backend falls back
        // to the keychain), the same contract the Connect modal's blank field has.
        password: vpnPassword,
        keyPassphrase: vpnKeyPassphrase || null,
        // `true` or `null`, never `false`: `openvpn_connect` resolves
        // `typed || saved` before it writes, so a `false` on a *successful*
        // connect clears the passphrase it just authenticated with — the same
        // shape as the SSH bug. Unticking deletes via `forgetVpnPassword`.
        remember: rememberArg(vpnRemember),
      });
      setVpnStatus("connected");
      setVpnSaved(vpnRemember);
      useVpnStatusStore.getState().setState(vpnConfig, "connected");
    } catch (e) {
      setVpnStatus("error");
      setVpnError(String(e));
      // `error`, not `off`. `markVpnError` may forget the machine-level entry
      // because the project's own red lamp carries the failure — and here there is
      // no project lamp, so a bare "off" is indistinguishable from never having
      // tried. The header is the only surface that can report it. `refresh` (every
      // 10 s, off the backend's live tunnel set) clears it again by itself, and
      // `anyVpnLive` ignores `error`, so nothing treats it as a live tunnel.
      useVpnStatusStore.getState().setState(vpnConfig, "error");
    }
  };

  // Non-headless: bring the OpenVPN tunnel up in a terminal embedded in the
  // dialog. The connect command (`pkexec openvpn … --auth-nocache`) runs
  // interactively so the user types the passphrase in that visible terminal —
  // Tabtivity never handles it. The PTY persists past the dialog so the tunnel
  // stays up for the new project; we pre-mark the dedupe key so activation's
  // root-terminal fallback (`ensureVpnIfNeeded`) is suppressed.
  const startVpnTerm = async () => {
    if (!vpnConfig || vpnTerm) return;
    try {
      const command = await invoke<string>("openvpn_login_command", { config: vpnConfig });
      const key = `vpn:${vpnConfig}`;
      markConnectionOpened(key);
      setVpnTerm({ id: nextDialogTermId("vpn"), command, key });
      // The handshake is now in flight in the terminal below — light the lamp
      // orange until the readiness watcher (below) sees the ready marker.
      setVpnStatus("connecting");
      setVpnError("");
      // And tell the MACHINE, not just this dialog. An interactive tunnel reroutes
      // the whole computer exactly as a headless one does, so the header indicator
      // has to show it coming up — the headless path above already says so, and
      // `useRemoteReconnect`'s terminal path does too. Without this the one place
      // a tunnel could be brought back down stayed dark while it came up.
      useVpnStatusStore.getState().setState(vpnConfig, "connecting");
    } catch (e) {
      setVpnStatus("error");
      setVpnError(String(e));
      useVpnStatusStore.getState().setState(vpnConfig, "error");
    }
  };

  // Flip the VPN lamp green once the interactive tunnel comes up. The embedded
  // login spawns `pkexec openvpn` inside its own PTY, so the tunnel is *not* in
  // the backend's tunnel registry — `openvpn_status` can't see it. Instead we
  // watch that terminal's own output for OpenVPN's ready marker (the same string
  // the headless backend waits on). Output arrives in chunks, so we keep a small
  // rolling buffer in case the marker straddles two `terminal-output` events.
  useEffect(() => {
    if (!vpnTerm) return;
    const termId = vpnTerm.id;
    let cancelled = false;
    let un: (() => void) | undefined;
    let buf = "";
    // Visible-only streaming: a hidden pane's PTY stops emitting
    // terminal-output entirely, and this dialog terminal can be hidden while
    // the tunnel comes up — the watch keeps its raw stream flowing so the
    // marker scan below still sees it.
    void invoke("pty_watch", { id: termId }).catch(() => {});
    void listen<TerminalOutput>("terminal-output", (ev) => {
      if (ev.payload.id !== termId) return;
      buf = (buf + ev.payload.data).slice(-512);
      if (buf.includes(VPN_READY_MARKER)) {
        setVpnStatus("connected");
        // Same reason as `startVpnTerm`'s "connecting": the tunnel is up and the
        // machine is rerouted, so the header must say so.
        useVpnStatusStore.getState().setState(vpnConfig, "connected");
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
  }, [vpnTerm, vpnConfig]);

  // Tear the embedded VPN terminal down (explicit disconnect / config change /
  // leaving remote mode). Kills the PTY and drops the dedupe mark so a later
  // activation can re-open the connection if still needed.
  const stopVpnTerm = () => {
    if (!vpnTerm) return;
    void invoke("pty_kill", { id: vpnTerm.id }).catch(() => {});
    forgetConnection(vpnTerm.key);
    setVpnTerm(null);
    setVpnStatus("idle");
    // Symmetric with the machine-level state `startVpnTerm` now sets. If the root
    // daemon actually outlived the PTY, `refresh` re-seats it from the backend's
    // live tunnel set within 10 s — so this can understate a tunnel briefly, never
    // claim one that isn't there.
    if (vpnConfig) useVpnStatusStore.getState().setState(vpnConfig, "off");
  };

  // Non-headless: open the interactive SSH login in a dialog-embedded terminal.
  // It establishes the ControlMaster socket the sshfs mount later rides, so the
  // new project activates without a second prompt. Persisted past the dialog;
  // the dedupe mark suppresses activation's root-terminal login.
  // Poll for the embedded login's ControlMaster to come up: a credential-less
  // ssh_connect rides the master once it's live (and on key-auth hosts succeeds
  // immediately). On the first success we mirror connectSsh's connected state so
  // both modes converge on the same `isRemote` browser. Bounded (~2 min) so a
  // never-authenticated login eventually stops; the user can re-arm it with the
  // "I've logged in — browse" button (tryBrowseNow). Never hard-errors while the
  // terminal is up — the login may just not be authenticated yet.
  //
  // NOTE: there are **four** copies of this loop (`useRemoteReconnect`,
  // `RemoteMachinesWindow`, `MachinesIndicator`, and here) — same 40 × 3 s bound,
  // same credential-less probe, same `openSession`-on-success. Consolidating them
  // is deliberately out of scope for this pass; what has been fixed is the part
  // that differed: all of them now *state* their give-up instead of two of them
  // going quiet and leaving an amber lamp with no way out.
  const pollSshReady = (parsed: ParsedSshAddress, attempt = 0) => {
    const maxAttempts = 40; // ~2 min at 3s cadence
    void invoke<void>("ssh_connect", {
      user: parsed.user,
      host: parsed.host,
      port: parsed.port,
      password: null,
      // Credential-less, so the dial policy can't tell this from a background
      // sweep — but it is waiting on a master the user just authenticated in the
      // terminal below. Unsaid, a host tagged HPC refuses every attempt and the
      // poll times out behind a login that visibly worked.
      background: false,
    })
      .then(async () => {
        clearSshPoll();
        const startDir = await resolveRemoteStartDir(parsed.user, parsed.host, parsed.port, null);
        // Freeze the session the login terminal already authenticated — empty
        // password → null → rides its ControlMaster in the listing effect.
        browse.openSession(parsed, "", startDir);
        setSshStatus("connected");
      })
      .catch(() => {
        if (attempt + 1 >= maxAttempts) {
          clearSshPoll();
          // Say so. Giving up silently left the lamp amber forever with nothing on
          // screen to act on — the user is watching a terminal that looks fine and
          // a dialog that will never advance. `tryBrowseNow` re-arms it.
          setSshStatus("error");
          setSshError(t(POLL_GAVE_UP));
          return;
        }
        sshPollTimer.current = setTimeout(() => pollSshReady(parsed, attempt + 1), 3000);
      });
  };

  // Manual re-arm of the readiness poll (the "I've logged in — browse" button),
  // for when the user authenticates after the auto-poll gave up, or wants to
  // retry sooner.
  const tryBrowseNow = () => {
    const parsed = parseSshAddress(sshAddress);
    if (!parsed) return;
    clearSshPoll();
    setSshStatus("connecting");
    setSshError("");
    pollSshReady(parsed);
  };

  const startSshTerm = async () => {
    if (sshTerm) return;
    const parsed = parseSshAddress(sshAddress);
    if (!parsed) {
      setSshStatus("error");
      setSshError(t("remoteSession.addressHint"));
      return;
    }
    try {
      const command = await invoke<string>("remote_login_command", {
        user: parsed.user ?? null,
        host: parsed.host,
        port: parsed.port ?? null,
      });
      const target = `${parsed.user ? `${parsed.user}@` : ""}${parsed.host}`;
      const key = `ssh:${target}:${parsed.port ?? ""}`;
      markConnectionOpened(key);
      setSshTerm({ id: nextDialogTermId("ssh"), command, key });
      setSshError("");
      // The user committed to this host by opening its login — remember it so it
      // shows up in the recents dropdown next time (covers non-headless + winManual).
      rememberSshAddress(sshAddress);
      // Outside Windows, ride the login's ControlMaster to SFTP-browse — no stored
      // password. (Windows has no control socket, so it keeps the manual path input.)
      if (!winManual) {
        setSshStatus("connecting");
        pollSshReady(parsed);
      }
    } catch (e) {
      setSshStatus("error");
      setSshError(String(e));
    }
  };

  const stopSshTerm = () => {
    if (!sshTerm) return;
    void invoke("pty_kill", { id: sshTerm.id }).catch(() => {});
    // Drop the dedupe mark (symmetric with stopVpnTerm) so a later activation can
    // re-open the SSH login; otherwise the key lingers in openedConnections and
    // ensureRootSshLoginIfNeeded silently skips the real login.
    forgetConnection(sshTerm.key);
    setSshTerm(null);
    // Killing the login drops the ControlMaster the browse rode, so stop the
    // readiness poll and return to the disconnected state.
    clearSshPoll();
    setSshStatus("idle");
    browse.reset();
    setStep("connect");
  };

  // Disconnect/reset the remote session when the user edits the SSH address.
  const onSshAddressChange = (value: string) => {
    setSshAddress(value);
    if (sshStatus !== "idle") resetSshSession();
    // A live login is bound to the old target — drop it so a re-connect uses
    // the new address.
    stopSshTerm();
  };

  // Editing the password also invalidates a live session — the next connect
  // must re-authenticate with the new credential.
  const onSshPasswordChange = (value: string) => {
    setSshPassword(value);
    if (sshStatus !== "idle") resetSshSession();
  };

  const connectSsh = async () => {
    const parsed = parseSshAddress(sshAddress);
    if (!parsed) {
      setSshStatus("error");
      setSshError(t("remoteSession.addressHint"));
      return;
    }
    // Empty password → the backend falls back to a saved one for this host, then to
    // key/agent auth (Option<String> None). So a blank field is "use what you have",
    // exactly as in the Connect modal — not "authenticate with nothing".
    const password = sshPassword ? sshPassword : null;
    setSshStatus("connecting");
    setSshError("");
    setRemoteChosenPath("");
    try {
      // The shared connect: ssh_connect (remembering the working password only on
      // success, so a rejected credential is never stored) → freeze the session →
      // open its start dir. The listing then refreshes itself.
      const outcome = await browse.connect({
        target: parsed,
        password,
        remember: rememberArg(sshRemember),
      });
      setSshStatus("connected");
      // From what the backend DID, not from the checkbox: a locked keyring refuses
      // the write and returns `save_error`, and a ticked box over an empty keychain
      // is exactly what resurfaces at the next launch as an unexplained prompt.
      sshCredential.applyOutcome(outcome);
      // Connection succeeded — remember the address for the recents dropdown.
      rememberSshAddress(sshAddress);
    } catch (err) {
      setSshStatus("error");
      setSshError(String(err));
      browse.reset();
    }
  };

  // The live SFTP listing + folder navigation all come from the shared browser;
  // re-exposed here under the names `RemoteProjectSection` already reads.
  const enterRemoteFolder = browse.enter;
  const jumpToRemotePath = browse.jump;
  const remoteGoUp = browse.goUp;
  const createRemoteFolder = browse.mkdir;

  // Build the `remote` spec for the create/import request, or undefined when this
  // isn't a usable remote project. NEW: name becomes a subdir under the chosen
  // path. IMPORT: the chosen path IS the project root.
  //
  // Headless: requires a live, browsed SSH session (`isRemote`). Non-headless:
  // no in-dialog connection is made (the live login happens in the root terminal
  // at activation), so the spec is built straight from the typed address + the
  // manually-entered remote path.
  const buildRemoteSpec = (safeName: string) => {
    if (!isRemoteProject) return undefined;
    const openvpn =
      vpnEnabled && vpnConfig
        ? { config: vpnConfig, username: vpnUsername.trim() || undefined }
        : undefined;
    // Both modes now browse to a real folder over a live session (headless via
    // connectSsh, non-headless by riding the embedded login's ControlMaster), so a
    // committed remoteConn + chosen path is the single source of truth.
    if (remoteConn && remoteChosenPath.trim()) {
      return {
        user: remoteConn.user ?? undefined,
        host: remoteConn.host,
        port: remoteConn.port ?? undefined,
        remote_path:
          kind === "new" ? joinRemotePath(remoteChosenPath, safeName) : remoteChosenPath,
        openvpn,
      };
    }
    // Windows non-headless can't browse (no control socket) — fall back to the
    // typed address + manually-entered path.
    if (winManual) {
      const parsed = parseSshAddress(sshAddress);
      const path = remoteChosenPath.trim();
      if (!parsed || !path) return undefined;
      return {
        user: parsed.user ?? undefined,
        host: parsed.host,
        port: parsed.port ?? undefined,
        remote_path: kind === "new" ? joinRemotePath(path, safeName) : path,
        openvpn,
      };
    }
    return undefined;
  };

  // Ready to submit: a chosen remote folder over a live session, or (Windows
  // non-headless) a typed path. Drives the dialog's submit gating + step machine.
  const remoteReady =
    isRemoteProject &&
    (winManual ? remoteChosenPath.trim() !== "" : isRemote && remoteChosenPath.trim() !== "");

  return {
    isRemoteProject,
    isRemote,
    // The live-connected host, frozen at connect time (`{ user, host, port }`),
    // so a caller can register it elsewhere — e.g. the HPC wizard surfacing the
    // cluster in the header's global-machines list once the login goes live.
    remoteConn,
    headless,
    winManual,
    sshViaTerminal,
    setSshViaTerminal,
    vpnViaTerminal,
    setVpnViaTerminal,
    remoteReady,
    step,
    setStep,
    tryBrowseNow,
    sshTooling,
    sshAddress,
    sshAddresses,
    sshPassword,
    sshStatus,
    sshError,
    sshRemember,
    setSshRemember,
    sshSaved,
    // The tri-state behind `sshSaved`, for the shared "Save password" row.
    sshCredential,
    forgetSshPassword,
    // The credential the live session actually authenticated with, so the caller can
    // hand it to the project's first *pooled* connect (`remote_connect`) instead of
    // letting that leg rely on the ControlMaster this dialog happens to have left up.
    remotePassword,
    remoteBrowsePath,
    remoteEntries,
    remoteListBusy,
    remoteListError,
    remoteChosenPath,
    setRemoteChosenPath,
    remotePaths,
    rememberChosenPath,
    vpnEnabled,
    setVpnEnabled,
    vpnConfig,
    vpnConfigs,
    vpnUsername,
    setVpnUsername,
    vpnNeeds,
    // A second field is only warranted when the key passphrase is a *different*
    // secret from the password — see `needsSeparateKeyPassphrase`.
    vpnNeedsKeyPassphrase: needsSeparateKeyPassphrase(vpnNeeds),
    selectVpnConfig,
    vpnPassword,
    setVpnPassword,
    vpnKeyPassphrase,
    setVpnKeyPassphrase,
    vpnStatus,
    setVpnStatus,
    vpnError,
    setVpnError,
    vpnRemember,
    setVpnRemember,
    vpnSaved,
    forgetVpnPassword,
    vpnLog,
    vpnTerm,
    startVpnTerm,
    stopVpnTerm,
    sshTerm,
    startSshTerm,
    stopSshTerm,
    toggleRemoteProject,
    browseVpnConfig,
    connectVpn,
    onSshAddressChange,
    onSshPasswordChange,
    connectSsh,
    enterRemoteFolder,
    jumpToRemotePath,
    remoteGoUp,
    createRemoteFolder,
    buildRemoteSpec,
  };
}
