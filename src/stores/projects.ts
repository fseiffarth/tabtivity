import { invoke } from "@tauri-apps/api/core";
import { invokeTrusted } from "../lib/execTrust";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  formatRemoteTarget,
  resolveLocalMirror,
  resolveProjectDirectory,
  type ComputeHost,
  type GitHostingInfo,
  type GitProvider,
  type GitPushMcpLevel,
  type GitPushMcpPolicy,
  type ProjectEntry,
  type PublishFrom,
  type RemoteSpec,
  type SandboxSourceDecision,
  type SandboxSpec,
  type SandboxToggleOutcome,
  type SshProbe,
} from "../types";
import {
  cmdToKind,
  effectiveTabLocation,
  hydrateScopeFromDisk,
  isPtyTabKind,
  isRestorableTab,
  isRelaunchableLocalTab,
  isResumableAgentTab,
  isSavedWhileLive,
  remoteHostIdOf,
  ROOT_SCOPE,
  toSavedTabEntry,
  useTabsStore,
  type LocalLaunch,
  type SavedLayoutTree,
  type TabKind,
  type TabLocation,
  type TabEntry,
  type ViewerState,
} from "./tabs";
import { useRunHostPrefStore } from "./remote/runHostPref";
import { useTimerStore } from "./timer";
import { useSettingsStore, whenSettingsLoaded } from "./settings";
import { mayAutoTouch, targetOfSpec } from "../lib/remote/hpc/hpcHost";
import { PRIMARY_HOST, useRemoteStatusStore } from "./remote/remoteStatus";
import { markVpnConnected, markVpnConnecting, markVpnError, releaseVpn } from "./remote/vpn/vpnStatus";
import { useConnectDialogStore } from "./remote/connectDialog";
import { connectionStillOpen, openConnectionInRoot } from "../lib/remote/remoteConnect";
import { describeScaffoldRepair, type ProjectScaffoldRepair } from "../components/projects/scaffold";
import type { SavedPasswordState } from "../components/projects/useSavedCredential";
import { IS_WINDOWS } from "../lib/platform";
import { shouldPersistLocalTab, shouldPersistTab } from "../lib/terminal/tmuxSession";
import { translate, useI18nStore } from "../lib/i18n";
import { MOBILE_ACCESS_KEY, MOBILE_DEVICES_KEY } from "../lib/brand";

function connectionsHeadless(): boolean {
  return useSettingsStore.getState().settings?.connections_headless ?? true;
}

/**
 * Toast text for a tunnel that just came up. It names the scope on purpose: a
 * bare "VPN connected · <project>" reads as though the tunnel belongs to the
 * project, when what actually happened is that the whole machine's routing (and
 * usually its DNS) moved — browser and all. That is worth one sentence, especially
 * on the auto-connect path, where this toast is the *only* thing the user sees.
 */
function vpnToast(name: string): string {
  return `VPN up · ${name} — this computer's traffic now routes through the tunnel`;
}

/**
 * The password a create/extend dialog authenticated its SSH session with, handed
 * over for that project's **first** pooled connect and forgotten the moment it is
 * used (or the connect gives up). Never persisted — persisting is what the dialog's
 * "Save password" toggle is for, and a user who declined it must not have the
 * secret written anywhere.
 *
 * Without this, the first `remote_connect` for a just-created remote project ran
 * with `password: null` and only succeeded because the dialog's ControlMaster was
 * still up. Two things came out wrong: the pool depended on a master it doesn't own,
 * and the backend — which reads "no password given, none saved" as *key* auth —
 * recorded `key_auth: true` on a host that in fact needs a password, so the project
 * then advertised itself as auto-connect-eligible and the auto-connect failed on the
 * next launch.
 *
 * **Currently write-only.** The reader was `ensureRemotePool`, reachable only from
 * `reconnectRemote`, which nothing has called for some time; both were deleted with
 * the auto-connect audit rather than left as an ungated retry loop waiting to be
 * re-wired. The dialogs still stash, so the hand-over is one call away — but until a
 * caller exists, a just-created project's first pooled connect gets its credential
 * from the keychain or the dialog's own master, exactly as it did before.
 */
const pendingRemotePassword = new Map<string, string>();
const deactivatingProjects = new Set<string>();

/** Hand `projectId`'s first pooled connect the password the dialog just used. */
export function stashRemotePassword(projectId: string, password: string): void {
  if (password) pendingRemotePassword.set(projectId, password);
}

/**
 * Projects whose first pooled connect will be riding a **login terminal's**
 * ControlMaster rather than a credential of its own.
 *
 * Normally that is implied by the mode — `connections_headless: false` means every
 * login is a terminal. But the dialogs now offer "Sign in in a terminal" for a single
 * connect *while headless*, and in that case there is no password to stash and the
 * mode says the opposite of what happened. Without this, that connect succeeds
 * credential-less and `record_key_auth` (commands/remote.rs) reads it as key auth —
 * stamping `key_auth: true` onto a password host, which then advertises a promptless
 * auto-connect that fails on every launch. The frontend is the only side that knows,
 * so it has to say.
 */
const pendingViaLogin = new Set<string>();

/** Mark `projectId`'s first pooled connect as riding a login terminal's master. */
export function stashRemoteViaLogin(projectId: string): void {
  pendingViaLogin.add(projectId);
}

/** Projects with an auto-connect attempt in flight, so a switch away and back
 *  (or a launch racing an activation) can't start a second one. */
const autoConnecting = new Set<string>();

/** The SSH coordinates of one host, as every auto-connect command wants them. */
type SshArgs = { user: string | null; host: string; port: number | null };

/**
 * Say why an armed auto-connect did nothing.
 *
 * The opt-in is re-checked against the backend on every attempt — a saved password
 * can be forgotten, a keyring can be locked — and until now that check failing was
 * completely silent: no lamp (the project simply never leaves "off"), no toast, not
 * even a `console.warn`. From the outside that is indistinguishable from "the
 * toggle is broken", which is precisely how it got reported. The one path that
 * deliberately does nothing now says so, naming the project, the login, and the
 * thing that would fix it.
 */
function autoConnectIneligible(scope: string, sshArgs: SshArgs, state: SavedPasswordState): void {
  const target = `${sshArgs.user ? `${sshArgs.user}@` : ""}${sshArgs.host}`;
  // The two fixes are opposites, so the two cases must not share a sentence. A
  // **locked** (or unreachable) store answers every lookup exactly like an empty one
  // (`lib/keyring.ts`), so `saved: false` alone would tell a user whose password is
  // sitting on the ring to go save it again — the one instruction that cannot help.
  // Same split, and deliberately the same wording, as the machine-wide VPN twin in
  // `lib/remote/vpn/vpnAutoConnect`: one feature, one explanation.
  const lang = useI18nStore.getState().lang;
  const reason = translate(
    lang,
    state.keyring === "unlocked"
      ? "autoConnect.reasonNoSavedPassword"
      : "autoConnect.reasonKeyringLocked",
    { target },
  );
  console.warn(`auto-connect skipped · ${scope}: ${reason}`);
  useProjectsStore.setState({
    connToast: translate(lang, "autoConnect.skippedToast", { scope, reason }),
  });
}

/** The saved-password answer every eligibility check asks for, with the one failure
 *  that keeps the decision safe: an unanswered read is never a confident "saved". */
async function savedPasswordState(sshArgs: SshArgs): Promise<SavedPasswordState> {
  return invoke<SavedPasswordState>("remote_saved_password_state", sshArgs).catch(
    () => ({ saved: false, keyring: "unavailable" }) as SavedPasswordState,
  );
}

/**
 * Auto-connect **without headless credentials** (`connections_headless` off), for one
 * host.
 *
 * In that mode Tabtivity handles no passwords at all — there is nothing in the keychain
 * to re-check and `remote_has_saved_password` is always false — so the headless
 * eligibility gate (a saved password, or a `key_auth` host) rejected *every* project
 * and auto-connect silently did nothing at all. This is the same substitution the
 * machine-wide VPN toggle already makes (`lib/remote/vpn/vpnAutoConnect`): "connect on launch"
 * means *the connect command is waiting in the root terminal*, where the user types
 * the password into a visible shell, rather than a connect Tabtivity completes by itself.
 *
 * So the promise the toggle keeps is unchanged in substance — it never opens a
 * **modal** — but it is kept differently: one root-terminal login, deduped, then the
 * pooled connection rides the ControlMaster that login leaves behind, exactly as the
 * Connect dialog's non-headless path does (`useRemoteReconnect`'s `pollSshReady`).
 *
 * A key/agent host still needs no terminal at all: the probe authenticates, and we go
 * straight to the pool.
 */
async function autoConnectInteractive(
  projectId: string,
  sshArgs: SshArgs,
  hostId?: string,
  /** A probe the caller already ran (the primary probes first to decide the VPN). */
  probed?: SshProbe,
): Promise<void> {
  const status = () => useRemoteStatusStore.getState();
  const stillActive = () => useProjectsStore.getState().activeId === projectId;
  const probe =
    probed ??
    (await invoke<SshProbe>("ssh_probe", sshArgs).catch(
      () => ({ ok: false, unreachable: false, error: "probe failed" }) as SshProbe,
    ));
  if (!stillActive()) return abandonAutoConnect(projectId, hostId);
  if (!probe.ok) {
    // Password host (or one whose key auth just failed): hand the login to the root
    // terminal and wait for its master. Deduped by target, so a login the Connect
    // dialog or a previous activation already opened is reused, never duplicated.
    const command = await invoke<string>("remote_login_command", sshArgs);
    const target = `${sshArgs.user ? `${sshArgs.user}@` : ""}${sshArgs.host}`;
    const dedupeKey = `ssh:${target}:${sshArgs.port ?? ""}`;
    openConnectionInRoot({ label: `ssh · ${target}`, command, dedupeKey });
    const ready = await pollRootLoginReady(projectId, sshArgs, dedupeKey);
    if (!stillActive()) return abandonAutoConnect(projectId, hostId);
    if (ready === "closed") {
      // The user closed the login tab: that is "not now", not a failure. Back to
      // *disconnected* rather than red, which is the difference between a project the
      // next activation will offer the login for again and one wedged shut until the
      // pill's lamp is clicked (the re-attempt guard only fires from "off").
      status().setSsh(projectId, "off", hostId);
      return;
    }
    if (ready === "timeout") {
      // Never authenticated within the window. Red lamp, no retry loop — the user
      // finishes the login and connects from the pill's lamp (the tab is still
      // sitting there with the command in it).
      status().setSsh(projectId, "error", hostId);
      return;
    }
  }
  // `viaLogin`: this path only runs non-headless, where a credential-less connect
  // rides the login terminal's master — it is not evidence of key auth, and recording
  // it as such is what used to leave a password host permanently claiming a
  // promptless connect it can't deliver (`record_key_auth`).
  await invoke("remote_connect", {
    projectId,
    hostId: hostId ?? null,
    password: null,
    viaLogin: true,
  });
  if (!stillActive()) return abandonAutoConnect(projectId, hostId);
  status().setSsh(projectId, "connected", hostId);
}

/**
 * Poll for the root-terminal login's ControlMaster to come up: a credential-less
 * `ssh_connect` rides the master the moment it is live. Bounded (~2 min at a 3s
 * cadence) so a login the user never authenticates stops polling; bails early if the
 * project is switched away from. Mirrors `useRemoteReconnect`'s `pollSshReady` — the
 * Connect dialog's version of the same wait.
 *
 * `"closed"` is its own outcome because the tab *is* the connection here: once the
 * user closes it there is nothing left to authenticate into, and waiting out the
 * remaining two minutes only to paint the lamp red misreads a deliberate dismissal
 * as a failed connect.
 */
async function pollRootLoginReady(
  projectId: string,
  sshArgs: SshArgs,
  dedupeKey: string,
): Promise<"ready" | "timeout" | "closed"> {
  const maxAttempts = 40; // ~2 min at 3s cadence
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (useProjectsStore.getState().activeId !== projectId) return "timeout";
    if (!connectionStillOpen(dedupeKey)) return "closed";
    // `password: null` and nothing saved → this only ever succeeds by riding the
    // master the interactive login established (or on a key/agent host).
    const ok = await invoke<void>("ssh_connect", { ...sshArgs, password: null })
      .then(() => true)
      .catch(() => false);
    if (ok) return "ready";
  }
  return "timeout";
}

/** Hand a lamp we ourselves turned "connecting" back to "disconnected" when we give
 *  up on a connect (the user switched away mid-attempt). Never touches a lamp in any
 *  other state — that one belongs to whoever set it. */
function abandonAutoConnect(projectId: string, hostId?: string): void {
  const status = useRemoteStatusStore.getState();
  const current = hostId
    ? status.byHost[projectId]?.[hostId]?.ssh
    : status.byProject[projectId]?.ssh;
  if (current === "connecting") status.setSsh(projectId, "off", hostId);
}

/**
 * Connect a remote project that has opted into **auto-connect** (launch and
 * activation), and do it *silently* — this path never prompts. That is the whole
 * contract of the toggle: it is only offered once the connection can complete with
 * no user input (a saved SSH password, or a host recorded as `key_auth`), so an
 * automatic connect can never ambush the user with a modal. Everything else keeps
 * the old default: the project surfaces disconnected and the user brings it up from
 * the pill's connection lamp.
 *
 * The tricky part is the VPN, because the *same* project is often reachable
 * directly on one network and only through the tunnel on another — so whether the
 * tunnel is needed is a property of the current network, not of the project, and
 * can't be stored. We therefore probe rather than assume:
 *
 *  1. `ssh_probe` the host (read-only; it reuses the saved credential but, unlike
 *     `ssh_connect`, never rewrites the keychain).
 *  2. Reachable → open the pooled connection (`remote_connect`, which falls back to
 *     the keychain itself). The tunnel is left alone — on the network that doesn't
 *     need it, it is never brought up.
 *  3. *Unreachable* (not "credential rejected" — see the backend's `ssh_unreachable`;
 *     no tunnel fixes a wrong password) and the project has an `.ovpn` whose
 *     passphrase is saved → bring the tunnel up from the keychain and re-probe.
 *  4. Anything else → red lamp and stop. No prompt, no retry loop.
 *
 * Fire-and-forget: it never blocks a switch. Local tabs restore and work on the
 * mirror regardless, and remote panes stay held until the pool is actually up.
 */
async function autoConnectPrimary(projectId: string): Promise<void> {
  const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
  const remote = project?.remote;
  if (!remote?.auto_connect) return;
  // Never silently, on a machine tagged HPC (`lib/remote/hpc/hpcHost.ts`). A connect is not
  // free on a cluster login node — it opens an SSH master, and Tabtivity's own
  // session machinery may raise a tmux server behind it — and "silently, because
  // the app happened to start" is precisely the shape of unattended presence a
  // shared login node's rules ask you not to leave lying around. Connecting by
  // hand still works and is one click away; only the automatic path is off.
  // `mayAutoTouch` is the shared authority, and it also fails closed while settings
  // are unloaded — `load()` waits for them before firing this, so a launch can no
  // longer sail past the gate simply by being early.
  if (!mayAutoTouch(useSettingsStore.getState().settings, targetOfSpec(remote))) return;
  // Skip unless the lamp is disconnected: never fight an in-flight attempt, never
  // re-attack a host that already failed this session (switching back and forth
  // would otherwise re-probe an unreachable host every time), and never re-connect
  // a live pool.
  const state = useRemoteStatusStore.getState().byProject[projectId];
  if ((state?.ssh ?? "off") !== "off" || autoConnecting.has(projectId)) return;
  // Claim the project BEFORE the first await: the lamp only turns "connecting" once
  // the eligibility round-trip is back, so two rapid activations (switch away and
  // straight back) would otherwise both sail past the guard above.
  autoConnecting.add(projectId);

  const stillActive = () => useProjectsStore.getState().activeId === projectId;
  const status = () => useRemoteStatusStore.getState();
  // Hand the lamp back to "disconnected" when we abandon a connect we started (the
  // user switched away mid-probe). A lamp left stuck on "connecting" would lie in
  // the header *and* wedge the project shut: the guard above only re-attempts from
  // "off". Only ever resets our own "connecting" — never a lamp someone else owns.
  const abandon = () => {
    if (status().byProject[projectId]?.ssh === "connecting") status().setSsh(projectId, "off");
  };
  try {
    const sshArgs: SshArgs = {
      user: remote.user ?? null,
      host: remote.host,
      port: remote.port ?? null,
    };

    // ── Non-headless (`connections_headless` off) ───────────────────────────────
    // Tabtivity holds no credentials in this mode, so the eligibility gate below can
    // never pass and auto-connect used to do *nothing at all* here. Connect the way
    // this mode connects instead: the tunnel and the login go to the root terminal
    // for the user to authenticate, and the pool rides what they leave behind.
    if (!connectionsHeadless()) {
      status().setSsh(projectId, "connecting");
      // The VPN decision is unchanged and stays the *network's*, not the project's:
      // probe first, escalate only on genuinely unreachable. A credential-less probe
      // can't authenticate a password host, but it can still tell "the host said no"
      // (reachable — no tunnel needed, and none would help) from "nothing answered".
      const probe = await invoke<SshProbe>("ssh_probe", sshArgs).catch(
        () => ({ ok: false, unreachable: false, error: "probe failed" }) as SshProbe,
      );
      if (!stillActive()) return abandon();
      const config = remote.openvpn?.config;
      if (!probe.ok && probe.unreachable && config) {
        // Host needs a route this network doesn't have. In non-headless mode Tabtivity
        // holds no passphrase, so the tunnel is the *user's* to authenticate — surface
        // its login in the root terminal (deduped; a tunnel already up isn't opened
        // again) and stop there.
        //
        // Crucially we do NOT mark the machine-wide tunnel "connecting" or poll it
        // from here. That is exactly what wedged the header: a tunnel is machine-wide,
        // its lamp is shared, and an *unattended* project poll that resolves late (or
        // not at all, on a switch-away) strands it on a phantom "connecting" — which
        // the header's Disconnect button refuses to touch (it's disabled while
        // connecting) and the Connect dialog reads as "a tunnel is already up". The
        // lamp instead belongs to the one owner that can't strand it: `VpnIndicator`'s
        // 10s `refresh` reconcile, driven by the backend's real tunnel set. When it
        // flips the tunnel to "connected" it fires `retryAutoConnectAfterVpn`, which
        // resets the red SSH lamp below and re-runs this connect — now reachable.
        const up = await invoke<boolean>("openvpn_status", { config }).catch(() => false);
        if (!up) {
          try {
            const command = await invoke<string>("openvpn_login_command", { config });
            openConnectionInRoot({
              label: `OpenVPN · ${project!.name}`,
              command,
              dedupeKey: `vpn:${config}`,
            });
          } catch (error) {
            console.warn("auto-connect: VPN root-terminal login failed", error);
          }
        }
        if (!stillActive()) return abandon();
        // Red, not "connecting": the host is unreachable until the tunnel is up, and a
        // red lamp is precisely what `retryAutoConnectAfterVpn` clears and re-attempts
        // the instant the reconcile sees the tunnel connected. Leaving it "connecting"
        // would wedge *this* lamp the same way (the re-attempt guard only fires from
        // "off", which only the reset from "error" produces).
        status().setSsh(projectId, "error");
        return;
      }
      await autoConnectInteractive(projectId, sshArgs, undefined, probe);
      return;
    }

    // Re-check eligibility against the backend rather than trusting the toggle: the
    // saved password may have been forgotten since it was ticked, and a stale opt-in
    // must degrade to "stay disconnected", never to a prompt.
    // A key host needs no credential at all, so it never pays the keychain read.
    const saved = remote.key_auth === true ? null : await savedPasswordState(sshArgs);
    if (saved && !saved.saved) {
      autoConnectIneligible(project!.name, sshArgs, saved);
      return;
    }
    if (!stillActive()) return;

    status().setSsh(projectId, "connecting");
    let probe = await invoke<SshProbe>("ssh_probe", sshArgs);

    const config = remote.openvpn?.config;
    if (!probe.ok && probe.unreachable && config && stillActive()) {
      const vpnSaved = await invoke<boolean>("vpn_has_saved_password", { config }).catch(
        () => false,
      );
      if (vpnSaved) {
        markVpnConnecting(projectId, config);
        try {
          await invoke("openvpn_connect", {
            config,
            username: remote.openvpn?.username ?? null,
            password: null,
            keyPassphrase: null,
            // No checkbox behind an auto-connect: authenticate from the keychain,
            // and leave it exactly as we found it.
            remember: null,
          });
          markVpnConnected(projectId, config);
          // The only disclosure on this path: auto-connect never prompts, so this
          // toast (and the header indicator it lights) is the whole of what the user
          // is told before their machine's routing changes under them.
          useProjectsStore.setState({ connToast: vpnToast(project!.name) });
          probe = await invoke<SshProbe>("ssh_probe", sshArgs);
        } catch (error) {
          markVpnError(projectId, config);
          console.warn("auto-connect: VPN tunnel failed", error);
        }
      }
    }

    if (!stillActive()) return abandon();
    if (!probe.ok) {
      console.warn("auto-connect: host not reachable/authenticating", probe.error);
      status().setSsh(projectId, "error");
      return;
    }
    await invoke("remote_connect", { projectId, password: null });
    if (!stillActive()) return abandon();
    status().setSsh(projectId, "connected");
  } catch (error) {
    console.warn("auto-connect failed", error);
    if (stillActive()) status().setSsh(projectId, "error");
    else abandon();
  } finally {
    autoConnecting.delete(projectId);
  }
}

/**
 * Auto-connect a remote project on launch/activation: the primary first, then any
 * worker (`compute_hosts`) that opted in. The primary is awaited before the
 * workers fire so a VPN it brings up (the tunnel is machine-wide) is already there
 * when a worker reachable only through it is probed. Fire-and-forget per host —
 * one worker being unreachable never blocks the others or the primary.
 */
async function autoConnectRemote(projectId: string): Promise<void> {
  await autoConnectPrimary(projectId);
  const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
  for (const host of project?.compute_hosts ?? []) {
    if (host.auto_connect) void autoConnectWorker(projectId, host);
  }
}

/**
 * The worker twin of `autoConnectPrimary`: connect one opted-in worker host with no
 * prompt. Simpler than the primary — a worker has no VPN escalation of its own (the
 * tunnel is machine-wide, so the primary or the header owns it) — but it keeps the
 * same guards: only from an "off" lamp, only when eligible (`key_auth` or a saved
 * password, re-checked against the backend so a stale opt-in degrades to
 * "stay disconnected"), and it abandons its own "connecting" lamp if the user
 * switches away mid-probe. Keyed in `autoConnecting` by `project:host` so it never
 * collides with the primary's per-project claim.
 */
async function autoConnectWorker(projectId: string, host: ComputeHost): Promise<void> {
  const hostId = host.id;
  // Same rule as the primary's: a tagged cluster is never dialled by itself.
  if (!mayAutoTouch(useSettingsStore.getState().settings, targetOfSpec(host))) return;
  const claim = `${projectId}:${hostId}`;
  const state = useRemoteStatusStore.getState().byHost[projectId]?.[hostId];
  if ((state?.ssh ?? "off") !== "off" || autoConnecting.has(claim)) return;
  autoConnecting.add(claim);

  const stillActive = () => useProjectsStore.getState().activeId === projectId;
  const status = () => useRemoteStatusStore.getState();
  const abandon = () => {
    if (status().byHost[projectId]?.[hostId]?.ssh === "connecting")
      status().setSsh(projectId, "off", hostId);
  };
  try {
    const sshArgs: SshArgs = {
      user: host.user ?? null,
      host: host.host,
      port: host.port ?? null,
    };

    // Non-headless: no keychain to be eligible against — the login goes to the root
    // terminal and the pool rides its master (see `autoConnectInteractive`). No VPN
    // step: the tunnel is machine-wide, so the primary (or the header) owns it, and
    // the primary is awaited before any worker fires.
    if (!connectionsHeadless()) {
      status().setSsh(projectId, "connecting", hostId);
      await autoConnectInteractive(projectId, sshArgs, hostId);
      return;
    }

    const saved = host.key_auth === true ? null : await savedPasswordState(sshArgs);
    if (saved && !saved.saved) {
      // Named down to the machine: a project can arm four workers, and "auto-connect
      // did nothing" is useless if it doesn't say which one.
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
      autoConnectIneligible(
        `${project?.name ?? projectId} · ${host.label || host.host}`,
        sshArgs,
        saved,
      );
      return;
    }
    if (!stillActive()) return;

    status().setSsh(projectId, "connecting", hostId);
    const probe = await invoke<SshProbe>("ssh_probe", sshArgs);
    if (!stillActive()) return abandon();
    if (!probe.ok) {
      console.warn("worker auto-connect: host not reachable/authenticating", probe.error);
      status().setSsh(projectId, "error", hostId);
      return;
    }
    await invoke("remote_connect", { projectId, hostId, password: null });
    if (!stillActive()) return abandon();
    status().setSsh(projectId, "connected", hostId);
  } catch (error) {
    console.warn("worker auto-connect failed", error);
    if (stillActive()) status().setSsh(projectId, "error", hostId);
    else abandon();
  } finally {
    autoConnecting.delete(claim);
  }
}

/**
 * Silently retry a background pooled connection the AppShell reconciler found
 * dead (`remote_connected_targets` no longer lists it — the ssh child exited on
 * its own: a keepalive kill after a dropped VPN/network, a laptop sleep, or an
 * HPC job's long queue wait past `ControlPersist`). Without this, a project the
 * store still marks "connected" is corrected to "error" and STAYS there
 * indefinitely — nothing ever moves an `error` lamp back except the user
 * clicking reconnect, even though `services::remote::connect_host`'s own
 * liveness check means the very next tab opened on that host reconnects the
 * pool anyway. This closes that gap for the lamp itself.
 *
 * Deliberately does NOT gate on `stillActive()` like `autoConnectPrimary`/
 * `autoConnectWorker` do: those guard an activation-time attempt the user might
 * have already switched away from, but a dead background connection can belong
 * to a project that isn't active at all (e.g. an HPC project a long `squeue`
 * watch tab keeps running in) and must keep working regardless of which
 * project is on screen.
 *
 * **Everything else about the eligibility bar it now genuinely shares** with
 * `autoConnectPrimary`/`autoConnectWorker` — which its own comment used to claim
 * while applying neither of the two gates that matter. It ran on any host the
 * reconciler found dead, so a project whose `auto_connect` the user had never
 * ticked, on a machine tagged HPC, was re-dialled unattended every time the master
 * expired — and each success re-armed the lamp for the next `ControlPersist`
 * timeout, a loop with no end and no surface. A connection the user never asked to
 * be automatic ends at a red lamp they click, which is what it did before this
 * function existed. The three gates are therefore: headless mode, the host's own
 * `auto_connect`, and `mayAutoTouch`; then, as before, key/agent auth or a saved
 * password.
 */
export async function silentReconnectDeadHost(projectId: string, hostId: string): Promise<void> {
  const status = () => useRemoteStatusStore.getState();
  // Every early-out below falls back to the pre-existing behavior (a plain
  // "error" lamp) rather than silently leaving the store's stale "connected"
  // in place — only the eligible-but-still-unreachable case in the try block
  // is a genuine "we tried and it didn't work" that also lands here.
  const markError = () => status().setSsh(projectId, "error", hostId);
  if (!connectionsHeadless()) return markError();
  const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
  if (!project?.remote) return markError();
  const target =
    hostId === PRIMARY_HOST
      ? {
          user: project.remote.user ?? null,
          host: project.remote.host,
          port: project.remote.port ?? null,
          keyAuth: project.remote.key_auth === true,
          autoConnect: project.remote.auto_connect === true,
        }
      : (() => {
          const host = project.compute_hosts?.find((h) => h.id === hostId);
          return host
            ? {
                user: host.user ?? null,
                host: host.host,
                port: host.port ?? null,
                keyAuth: host.key_auth === true,
                autoConnect: host.auto_connect === true,
              }
            : null;
        })();
  if (!target) return markError();
  // The opt-in is per host and it means "reconnect me without asking" — a host that
  // never opted in has no automatic reconnect to inherit just because it once got
  // connected by hand and then dropped.
  if (!target.autoConnect) return markError();
  // And never a tagged cluster, on the same terms as the two auto-connect paths: a
  // background re-dial of a login node is the definition of unattended presence, and
  // this one isn't even tied to the project being on screen.
  if (
    !mayAutoTouch(useSettingsStore.getState().settings, {
      user: target.user ?? undefined,
      host: target.host,
      port: target.port ?? undefined,
    })
  )
    return markError();

  const claim = hostId === PRIMARY_HOST ? projectId : `${projectId}:${hostId}`;
  if (autoConnecting.has(claim)) return; // an activation-time auto-connect already owns this host — let it finish
  autoConnecting.add(claim);
  try {
    const sshArgs: SshArgs = { user: target.user, host: target.host, port: target.port };
    const eligible =
      target.keyAuth || (await invoke<boolean>("remote_has_saved_password", sshArgs).catch(() => false));
    if (!eligible) return markError(); // nothing silent left to try

    status().setSsh(projectId, "connecting", hostId);
    const probe = await invoke<SshProbe>("ssh_probe", sshArgs).catch(
      () => ({ ok: false, unreachable: false, error: "probe failed" }) as SshProbe,
    );
    if (!probe.ok) {
      status().setSsh(projectId, "error", hostId);
      return;
    }
    await invoke("remote_connect", { projectId, hostId, password: null });
    status().setSsh(projectId, "connected", hostId);
  } catch (error) {
    console.warn("silent reconnect of dead host failed", error);
    status().setSsh(projectId, "error", hostId);
  } finally {
    autoConnecting.delete(claim);
  }
}

/**
 * Re-attempt auto-connect for the **active** remote project after a VPN tunnel has
 * just come up (the machine-wide event `lib/remote/remoteAutoReconnect` subscribes to).
 *
 * A first auto-connect at launch may have run *before* the armed tunnel was up: the
 * probe found the host unreachable and left the lamp red (`autoConnectPrimary` step
 * 4 — no retry loop of its own). Now the routing exists, so we reset that red lamp
 * (primary and each opted-in worker) back to "off" and fire `autoConnectRemote`
 * again — the guard there only re-attempts from "off", so without this reset the
 * fresh tunnel would go unused until the user connected by hand. Only ever clears an
 * `error` lamp: a `connecting`/`connected` lamp is a live or winning attempt and is
 * left strictly alone. No-op unless the active project is a remote that opted in.
 */
export function retryAutoConnectAfterVpn(): void {
  const { activeId, projects } = useProjectsStore.getState();
  if (!activeId) return;
  const project = projects.find((p) => p.id === activeId);
  if (!project?.remote?.auto_connect) return;
  const status = useRemoteStatusStore.getState();
  if ((status.byProject[activeId]?.ssh ?? "off") === "error") status.setSsh(activeId, "off");
  for (const host of project.compute_hosts ?? []) {
    if (host.auto_connect && (status.byHost[activeId]?.[host.id]?.ssh ?? "off") === "error")
      status.setSsh(activeId, "off", host.id);
  }
  void autoConnectRemote(activeId);
}

/** Tear down a remote project's pooled connection on deactivation — the primary
 *  AND every worker host (multi-host remote). Best-effort. */
function dropRemotePool(projectId: string): void {
  useRemoteStatusStore.getState().clear(projectId);
  void invoke("remote_disconnect_all_hosts", { projectId }).catch(() => {});
}

interface ProjectTmuxTarget {
  session: string;
  hostId: string | null;
}

/** Persistent sessions that the currently-loaded project tabs actually use. */
export function projectTmuxTargets(
  project: ProjectEntry,
  tabs: TabEntry[],
  localPersistenceEnabled: boolean,
): ProjectTmuxTarget[] {
  const targets = new Map<string, ProjectTmuxTarget>();
  for (const tab of tabs) {
    if (!isPtyTabKind(tab.kind)) continue;
    let hostId = remoteHostIdOf(
      effectiveTabLocation(tab, { vmProject: !!project.vm?.enabled }),
    );
    if (
      hostId &&
      hostId !== "primary" &&
      !project.compute_hosts?.some((host) => host.id === hostId)
    ) {
      hostId = "primary";
    }
    const localRunning = !project.remote || hostId === null;
    const persistent =
      !!tab.tmuxSession &&
      (shouldPersistTab(tab.kind, hostId, project.remote, tab.ephemeral) ||
        shouldPersistLocalTab(
          tab.kind,
          project.id,
          localRunning,
          localPersistenceEnabled,
          !!project[MOBILE_ACCESS_KEY],
          isResumableAgentTab(tab) || isRelaunchableLocalTab(tab) || isSavedWhileLive(tab),
        ));
    const session = tab.tmuxAttach ?? (persistent ? tab.tmuxSession : undefined);
    if (!session) continue;
    const targetHost = localRunning ? null : (hostId ?? "primary");
    targets.set(`${targetHost ?? "local"}\0${session}`, {
      session,
      hostId: targetHost,
    });
  }
  return [...targets.values()];
}

/** Tear a remote project's connection down on demand (header lamp menu): drop the
 *  pooled SSH/SFTP connection and reset its lamps to disconnected. The restored
 *  tabs stay open (their sessions just go dead) until the user reconnects. */
export function disconnectRemote(projectId: string): void {
  dropRemotePool(projectId);
}

/**
 * One-click log out of a *connected* remote project (the pill's logout button):
 * drop the pooled SSH/SFTP connection and release its claim on the OpenVPN tunnel,
 * without routing through the Connect modal. The modal's Disconnect does the same
 * plus cancels an in-flight connect via `useRemoteReconnect`'s generation counters
 * — unreachable from here, and unnecessary: this button only shows once SSH is
 * `connected`, so there is no attempt left to abandon.
 *
 * *Release*, not disconnect: the tunnel is machine-wide and shared by config path,
 * so it only actually comes down if no other project is still holding it (see
 * `releaseVpn`). To bring a tunnel down regardless, the header's VPN indicator is
 * the place — that acts on the tunnel, not on a project.
 */
export function logoutRemote(project: ProjectEntry): void {
  releaseVpn(project.id, project.remote?.openvpn?.config);
  dropRemotePool(project.id);
}

interface ProjectRuntimeSwitchedPayload {
  projectId: string | null;
  tabLayout: Array<{
    key: string;
    label: string;
    cmd: string;
    cwd: string;
    kind?: TabKind;
    sessionId?: string;
    env?: Record<string, string>;
    embedPath?: string;
    embedExec?: string;
    viewer?: "pdf" | "image" | "markdown" | "text";
    viewerState?: ViewerState;
    location?: "local" | "remote";
    /** A "projectfiles" tab's browsed folder (see TabEntry.folder). */
    folder?: string;
    /** A "browser" tab's committed address (see TabEntry.url). */
    url?: string;
    /** A restart-resumable custom agent's resume flag (see TabEntry.resumeArgs). */
    resumeArgs?: string[];
    /** The stable tmux session name / Sessions-view attach target — carried
     *  through a switch so `loadFromLayout` REATTACHES rather than forking a
     *  second remote session (see TabEntry.tmuxSession/tmuxAttach). */
    tmuxSession?: string;
    tmuxAttach?: string;
    /** A relaunchable local-model tab's launch line (see TabEntry.localLaunch),
     *  re-validated by the backend like the rest of the layout. */
    localLaunch?: LocalLaunch;
    /** Host-bound container-exemption marker (see TabEntry.hostBoundUid, #150). */
    hostBoundUid?: string;
    /** The "never tmux-wrap this tab" marker (see TabEntry.ephemeral). */
    ephemeral?: boolean;
  }>;
  // Opaque split/group layout tree (camelCased by the backend's serde rename);
  // absent → restored as a single group.
  tabGroups: SavedLayoutTree | null;
  activeTabIndex: number;
  fileTabs: unknown[];
  sidePanelFolder: string | null;
  openedWindowIds: string[];
}

interface ProjectsStore {
  projects: ProjectEntry[];
  activeId: string | null;
  loaded: boolean;
  rootDir: string | null;
  switchToast: string | null;
  /** A transient one-off action notice (e.g. "VPN connected · proj", a scaffold
   *  repair summary). Kept separate from `switchToast` so a project switch
   *  doesn't clobber it (and vice-versa). */
  connToast: string | null;
  sidePanelFolderByProject: Record<string, string>;
  /** Incremented only on explicit setActive calls, never by load(). */
  switchGeneration: number;
  load: () => Promise<void>;
  setActive: (id: string | null) => Promise<void>;
  reorderProjects: (fromId: string, toId: string) => Promise<void>;
  setSidePanelFolder: (projectId: string, folder: string) => void;
  clearSwitchToast: () => void;
  clearConnToast: () => void;
  addProject: (project: ProjectEntry) => Promise<void>;
  activateProject: (id: string) => Promise<void>;
  deactivateProject: (id: string) => Promise<void>;
  /** Delete a project: tear down all its Tabtivity-side connections/state and move
   * it into the archive (`~/tabtivity/archive/<id>/`). Reversible from Settings; the
   * remote host tree of an SSH project is never touched. */
  archiveProject: (id: string) => Promise<void>;
  /** Remove a project from Tabtivity and leave its folder exactly where it is:
   *  only the registry entry and Tabtivity's state dirs about it go — nothing
   *  inside the tree is touched. For a botched import that should be redone. */
  forgetProject: (id: string) => Promise<void>;
  updateProjectDescription: (id: string, description: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  /** Rename a local project's folder to `<same parent>/<leaf>`. The backend
   * refuses an existing target and an open project, so an open one is closed
   * first (its stop prompt may be cancelled → throws) and reopened after. */
  renameProjectFolder: (id: string, leaf: string) => Promise<void>;
  /** Relocate a remote (SSH) project's local mirror folder into `parentDir`
   * (the folder is moved to `<parentDir>/<name>`). Returns the new mirror path. */
  moveRemoteMirror: (id: string, name: string, parentDir: string) => Promise<string>;
  /** Attach a remote (SSH) spec to an existing local project. The project's
   * current local directory becomes its local mirror in place (no data upload);
   * the empty remote root is created on the host. Returns the updated entry,
   * which is a disconnected remote project (user reconnects via the pill lamp). */
  extendProjectToRemote: (id: string, remote: RemoteSpec) => Promise<void>;
  /** O#143: an in-repo Dockerfile/devcontainer image is never adopted silently.
   *  Call with no `sourceDecision` first; a `needs_confirmation` outcome means
   *  nothing was written yet — show the caller's own confirm dialog naming the
   *  risk, then call again with `{hash: source.hash, adopt}`. Only an `applied`
   *  outcome updates local state. */
  setProjectSandbox: (
    id: string,
    enabled: boolean,
    sourceDecision?: SandboxSourceDecision,
  ) => Promise<SandboxToggleOutcome>;
  /** Replace a project's container spec (the Container settings dialog's save).
   *  Backend normalizes blank fields away and stores it in both projects.json
   *  and project.json; the stored spec is mirrored into local state. */
  setProjectSandboxSpec: (id: string, spec: SandboxSpec) => Promise<void>;
  /** Pin the project's Python interpreter, or `null` to restore auto-detect (#87). */
  setProjectPython: (id: string, interpreter: string | null) => Promise<void>;
  /** O#59: force this project's Claude agent tabs' remote-control flag on/off
   *  (`true`/`false`), or clear the override (`null`) to inherit the global
   *  `agent_remote_control` setting. */
  setProjectRemoteControl: (id: string, remoteControl: boolean | null) => Promise<void>;
  setProjectScheduleMcp: (id: string, level: "off" | "propose" | "apply") => Promise<void>;
  /** The agent-push policy (`services::git_push_mcp`): level and protected
   *  branches; an omitted argument leaves that field alone. */
  setProjectGitPushMcp: (id: string, level?: GitPushMcpLevel, protectedBranches?: string[]) => Promise<void>;
  /** Opt a remote project in/out of auto-connect (connect it silently on launch
   *  and activation). Only offered once the connect can complete with no prompt —
   *  a saved SSH password, or a host recorded as `key_auth`; `autoConnectRemote`
   *  re-checks that, so a stale opt-in degrades to staying disconnected. */
  setProjectAutoConnect: (id: string, enabled: boolean) => Promise<void>;
  /** Opt a remote project in/out of persistent (tmux) sessions (TODO #85). Default
   *  ON, so this only records an opt-out; re-enabling clears the field. */
  setProjectPersistSessions: (id: string, enabled: boolean) => Promise<void>;
  /** Switch a project's Mobile access. `devices` is the per-phone list: `null`
   *  reaches every paired phone, a list only those. A caller re-enabling or
   *  refreshing must pass the project's current list — `null` widens it. */
  setProjectMobileAccess: (id: string, enabled: boolean, devices: string[] | null) => Promise<void>;
  /** Set (or clear, on blank) the display name for a remote project's PRIMARY
   *  machine — the counterpart of a worker's `label` (`patch_compute_host`).
   *  Distinct from the project name: this labels the host, shown wherever a
   *  project's hosts are listed side by side (System Monitor, pill lamps). */
  setProjectRemoteLabel: (id: string, label: string) => Promise<void>;
  /** Set (or clear, on blank) the **SSH login name** a remote project's primary
   *  host is reached as. The address is fixed at creation, so this is the only way
   *  to correct a project created without a user (ssh then authenticates as the
   *  local account name) or with the wrong one. Clears `key_auth` with it — that
   *  was recorded for the account being replaced. */
  setProjectRemoteUser: (id: string, user: string) => Promise<void>;
  /** Attach (or clear) an OpenVPN config on a remote project's SSH spec, so a
   *  project created without a VPN can gain one later when reconnecting from a
   *  VPN-gated network. `config = null`/"" clears it. Mirrors the stored path
   *  into local state so the Connect dialog picks it up immediately. */
  setProjectOpenvpn: (id: string, config: string | null, username?: string | null) => Promise<void>;
  /** Replace a project's category tags (color/group it in the cloud + pills).
   * Backend cleans + dedupes; mirrors the cleaned list into local state. */
  setProjectCategories: (id: string, categories: string[]) => Promise<void>;
  /** Disable (delete .git → git_type "none") or re-enable (git init → "local")
   * git for an existing project. Destructive when disabling. */
  setProjectGitDisabled: (id: string, disabled: boolean) => Promise<void>;
  /** Fill in any scaffold file/`.gitignore` pattern this project is missing
   * relative to current defaults (e.g. it predates that default). Additive
   * only — never overwrites existing content. Surfaces the result as a
   * transient toast. */
  repairProjectScaffold: (id: string) => Promise<ProjectScaffoldRepair>;
  /** `publishFrom` picks the side for a work-remote project: `"local"` (the
   * default — the lockstep mirror, using this machine's `gh`/`glab` login) or
   * `"remote"` (the host's own login). Ignored for a local project. */
  publishProject: (
    id: string,
    provider: GitProvider,
    visibility: "public" | "private",
    publishFrom?: PublishFrom,
  ) => Promise<string>;
  /** Detach a remote (SSH) project back to a plain local project: its mirror
   * becomes the project directory in place. The host's files are never touched. */
  detachProjectFromRemote: (id: string) => Promise<void>;
  /** Forget a published project's push target without deleting the hosted repo
   * or local history: removes `origin`, resets git_type → "local". */
  unpublishProject: (id: string) => Promise<void>;
  /** Flip a published project's visibility (public ↔ private) in place via the
   * provider's `repo edit`. Returns the CLI stdout. */
  setProjectVisibility: (id: string, visibility: "public" | "private") => Promise<string>;
  /** Migrate a published project to the other provider (old repo left intact as
   * `origin-old`). Returns the create CLI stdout (new repo URL). */
  switchProjectProvider: (
    id: string,
    provider: GitProvider,
    visibility: "public" | "private",
    publishFrom?: PublishFrom,
  ) => Promise<string>;
  getProjectGitHosting: (id: string) => Promise<GitHostingInfo>;
  setProjectGitHosting: (
    id: string,
    args: { profileUrl?: string | null; token?: string | null; clearToken?: boolean },
  ) => Promise<GitHostingInfo>;
}

/**
 * Restore ONE project's saved tabs into its own scope **without making it
 * current**. The scope key is the project id, so the tabs land in
 * `tabsByScope[id]` and `CenterPanel`'s flat pane layer mounts them hidden:
 * PTYs spawn, tmux sessions reattach, resumable agent tabs come back with
 * their `--resume` — exactly what happens the moment the user switches to that
 * project, minus the switch.
 *
 * Guards, in order, and each of them load-bearing:
 *  - a project with no `local_file` isn't ready to restore yet;
 *  - a scope already in `tabsByScope` was initialized this session, so its
 *    in-memory state wins — re-reading disk would resurrect tabs the user
 *    deliberately closed;
 *  - a layout with nothing restorable in it creates NO key, because an absent
 *    key is exactly what tells `persistScope` "this scope was never hydrated"
 *    (its `hydrated` guard), which is what keeps an unvisited project's saved
 *    layout from being erased by a later empty save.
 * The in-memory guard is re-checked after the read: the user can switch to the
 * project — or Mobile can hydrate it — while the IPC is in flight.
 *
 * The layout comes from `<state_dir>/sessions/<id>/`, never from the project's
 * own `project.json` (see AGENTS.md "Persistence"): everything restored here
 * becomes a `pty_spawn`.
 */
export async function restoreProjectScope(project: ProjectEntry): Promise<void> {
  const scope = project.id;
  if (!project.local_file) return;
  if (scope in useTabsStore.getState().tabsByScope) return;
  // Two concurrent restores of the SAME scope would both clear the guard above
  // (neither has written the key yet) and both call `loadFromLayout` — every tab
  // twice, each with its own freshly minted key, i.e. two PTYs per tab. The
  // switch-driven restore and this startup pass genuinely can overlap: clicking a
  // pill during launch is exactly that. The claim closes the window the in-flight
  // read leaves open; the synchronous restore in `listenProjectRuntimeSwitched`
  // needs no claim, since it writes the key before it can yield.
  if (restoringScopes.has(scope)) return;
  restoringScopes.add(scope);
  try {
    // A failed read restores nothing (and seeds nothing): the layout may still
    // be there on the next attempt. `hydrateScopeFromDisk` owns the guards this
    // doc comment describes (in-memory state wins; nothing restorable creates
    // NO key).
    await hydrateScopeFromDisk(scope, resolveProjectDirectory(project)).catch(() => {});
  } finally {
    restoringScopes.delete(scope);
  }
}

/** In-flight `restoreProjectScope` calls, keyed by scope. */
const restoringScopes = new Set<string>();

/** Project scopes this session has already tried to restore in the background.
 *  Tried, not restored: a project whose saved layout held nothing restorable
 *  creates no `tabsByScope` key (see `restoreProjectScope`), so without this it
 *  would be re-read from disk on every projects-list change. */
const backgroundRestored = new Set<string>();

/**
 * Restore every **active** project's tabs, current or not.
 *
 * "Active" is not a decoration: `deactivateProject` is the gesture that *stops*
 * a project's terminals (it confirms, kills the PTYs and the tmux sessions, and
 * only then writes `inactive`), so a project that survived a quit as "active"
 * is one whose terminals the user never stopped. Restoring them lazily — on the
 * first switch to each pill — meant a relaunch came back with only the current
 * project running and every other pill's work suspended until it was clicked,
 * which is what this pass fixes.
 *
 * Sequential on purpose: each entry is one `load_tab_session` IPC followed by a
 * burst of `pty_spawn`s, and launch is already the busiest moment in the app.
 * Fire-and-forget everywhere it is called — nothing waits on a background
 * project's tabs.
 *
 * NOT included, deliberately: remote auto-connect (`autoConnectRemote` is
 * current-project-scoped and abandons its lamp when the user switches away), so
 * an active remote project restores its tabs with the remote panes held until
 * its pool comes up, exactly as it does on a switch today.
 */
export async function restoreActiveProjectScopes(): Promise<void> {
  for (const project of useProjectsStore.getState().projects) {
    if (project.status !== "active") continue;
    if (backgroundRestored.has(project.id)) continue;
    backgroundRestored.add(project.id);
    await restoreProjectScope(project).catch(() => {});
  }
}

/** §9.5: the ONE "patch one project entry in local state" helper behind every
 *  per-field setter — invoke the backend, then mirror its answer through this,
 *  instead of ~15 hand-rolled `set(state => ({projects: state.projects.map(…)}))`
 *  bodies that drift. Untouched entries keep their identity, so unrelated
 *  pill/selector subscribers don't re-render. */
function patchProject(id: string, patch: (project: ProjectEntry) => ProjectEntry): void {
  useProjectsStore.setState((state) => ({
    projects: state.projects.map((project) => (project.id === id ? patch(project) : project)),
  }));
}

/** [`patchProject`] scoped to the remote (SSH) spec — a no-op for a project
 *  that has none, which is what every remote-field setter wants: the backend
 *  already refused the write for a non-remote project. */
function patchProjectRemote(id: string, patch: (remote: RemoteSpec) => RemoteSpec): void {
  useProjectsStore.setState((state) => ({
    projects: state.projects.map((project) =>
      project.id === id && project.remote
        ? { ...project, remote: patch(project.remote) }
        : project,
    ),
  }));
}

/**
 * The one "take a project out of Tabtivity" sequence behind `archiveProject` and
 * `forgetProject`: tear down every Tabtivity-side connection and in-memory state
 * the project holds, run the backend verb that drops it from `projects.json`
 * (and moves or purges its state — that is the only part the two differ in),
 * then remove the pill and re-focus if it was the current project. The teardown
 * runs BEFORE the backend call so a pooled SSH master or a running PTY never
 * outlives its registry entry.
 */
async function removeProjectVia(id: string, unregister: () => Promise<unknown>): Promise<void> {
  const { projects, setActive } = useProjectsStore.getState();
  const entry = projects.find((p) => p.id === id);
  if (!entry) return;

  // ── Tear down all Tabtivity-side connections/state for this project ──────────
  // Drop the pooled SSH/SFTP ControlMaster + reset its lamps (remote only).
  if (entry.remote) dropRemotePool(id);
  // Close its Connect modal if it happens to be targeting this project.
  if (useConnectDialogStore.getState().projectId === id) {
    useConnectDialogStore.getState().close();
  }
  // Release its claim on the OpenVPN tunnel — which comes down only if no other
  // project is still holding it. (This used to scan the project list for another
  // project *configured* with the same config, which is a different question: it
  // kept the tunnel up for projects that weren't even connected. `releaseVpn`
  // counts actual holders.)
  releaseVpn(id, entry.remote?.openvpn?.config);
  // Drop its tabs/PTYs/sessions (in memory; the backend discards the file).
  useTabsStore.getState().closeAllTabs(id);
  backgroundRestored.delete(id);
  // Remove it from every box holding it (membership is N:M — the boxes
  // themselves survive; a box left with one or zero members still renders).
  {
    const { useBoxesStore } = await import("./boxes");
    const boxesStore = useBoxesStore.getState();
    const holding = boxesStore.boxes.filter((b) => b.member_ids.includes(id));
    for (const b of holding) {
      await boxesStore.removeFromBox(id, b.id);
    }
  }

  // ── Drop it from projects.json (archive moves its folders; forget does not) ─
  await unregister();

  // ── Update the store: remove the pill, re-focus if it was active ──────────
  let nextActiveId: string | null = null;
  useProjectsStore.setState((state) => {
    const remaining = state.projects.filter((p) => p.id !== id);
    nextActiveId =
      state.activeId === id
        ? (remaining.find((p) => p.status === "active") ?? remaining[0])?.id ?? null
        : state.activeId;
    return { projects: remaining };
  });
  if (useProjectsStore.getState().activeId !== nextActiveId) {
    await setActive(nextActiveId);
  }
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  activeId: null,
  loaded: false,
  rootDir: null,
  switchToast: null,
  connToast: null,
  sidePanelFolderByProject: {},
  switchGeneration: 0,

  load: async () => {
    const [raw, rootDir] = await Promise.all([
      invoke<ProjectEntry[]>("get_projects"),
      invoke<string>("root_work_dir").catch(() => null),
    ]);
    const projects = [...raw].sort((a, b) => a.position - b.position);
    // NO project marked "current" means the root scope was open when the app was
    // last closed — that is exactly how `setActive(null)` records it (the root
    // terminal is the absence of a current project, and the demotion to "active"
    // is persisted by the `save_projects` in that same call). So the answer here
    // is `null`, i.e. the root scope, and never "then open the first pill":
    // that fallback made a session ended at the root terminal come back inside
    // whichever project happened to sort first, with the root's own restored
    // tabs sitting one click away and looking lost. It also fired for a list
    // whose projects are ALL inactive, where `projects[0]` is a project with no
    // pill in the strip at all. A fresh install has no projects and lands on the
    // root scope by the same rule rather than by a special case.
    const activeId = projects.find((p) => p.status === "current")?.id ?? null;
    // Restore the active project's side-panel subfolder before any component
    // mounts, so the file tree opens straight to the saved folder on startup.
    // (Switching projects already restores via switch_project_runtime; this
    // covers the initially-active project, which never triggers a switch.)
    const sidePanelFolderByProject: Record<string, string> = {};
    const activeLocalFile = activeId
      ? projects.find((p) => p.id === activeId)?.local_file
      : undefined;
    if (activeId && activeLocalFile) {
      const folder = await invoke<string | null>("load_side_panel_folder", {
        localFile: activeLocalFile,
      }).catch(() => null);
      if (folder) sidePanelFolderByProject[activeId] = folder;
    }
    set({
      projects,
      loaded: true,
      rootDir,
      activeId,
      sidePanelFolderByProject,
    });
    // Re-hydrate the run-host preference (which machine shells run on) from each
    // project's persisted `run_host`, so a choice made in a previous session still
    // sends this session's Run/Debug and "+" shells to that machine. Merge-only, so
    // a change made this session before a reload is never clobbered.
    useRunHostPrefStore.getState().seed(
      projects.map((p) => ({
        projectId: p.id,
        location: p.run_host as TabLocation | undefined,
      })),
    );
    // Fire-and-forget: sniff each local repo's `origin` host so pills can badge
    // a hosting provider (GitHub/GitLab) and the hover can show the git address,
    // even when the repo was pushed outside Tabtivity's Publish flow. Host-only, no
    // network — must not block the list.
    void invoke<Record<string, { provider: string; url: string }>>("detect_git_providers")
      .then((map) =>
        set((state) => ({
          projects: state.projects.map((p) => {
            const hit = map[p.id];
            if (hit?.provider === "github" || hit?.provider === "gitlab") {
              return { ...p, detected_provider: hit.provider as GitProvider, git_origin_url: hit.url };
            }
            return p;
          }),
        })),
      )
      .catch(() => {});
    // The initially-active remote project is NOT connected on launch unless it opted
    // into auto-connect. Its saved tabs DO restore either way (local tabs run on the
    // mirror offline), but any REMOTE pane is held until the pool is up — without the
    // opt-in it starts DISCONNECTED (no status entry → "off" lamp) and the user brings
    // it up from the pill's connection lamp (the `RemoteConnectDialog` modal).
    //
    // Waits for settings first. The HPC gate reads them and `mayAutoTouch` fails
    // closed on an unloaded store — which is the safe direction, but it means firing
    // here against a half-booted store would skip a perfectly eligible project purely
    // because `AppShell` starts both loads in parallel and this one won the race. (It
    // is also the window in which the gate could once fail *open*.) Fire-and-forget
    // still: nothing about the project list waits on a connect.
    if (activeId) void whenSettingsLoaded().then(() => autoConnectRemote(activeId));
    // Bring the OTHER active projects' tabs back too — the pills that are not the
    // current one. Their terminals were never stopped (that is what "inactive"
    // means and what `deactivateProject` does), so a relaunch must resume them
    // rather than wait for a click on each pill. CenterPanel restores the CURRENT
    // scope on its own; this pass covers every scope no switch will ever visit.
    //
    // Waits for settings for the same reason the auto-connect above does, plus one
    // of its own: `loadFromLayout` asks `withdrawnTabKinds` which experimental tab
    // kinds to drop, and an unloaded settings store answers "drop nothing" — firing
    // before that read lands would restore tabs belonging to a switched-off flag.
    void whenSettingsLoaded().then(() => restoreActiveProjectScopes());
  },

  setActive: async (id) => {
    const previousId = get().activeId;
    // ── Snapshot the OUTGOING project's tabs SYNCHRONOUSLY ───────────────────
    // This MUST run before the set() / awaits below. Those yield to the event
    // loop, letting React re-render from the activeId change and CenterPanel's
    // effect call setScope(id) — which moves the tabs store to the NEW scope.
    // Reading tabs after that point snapshots the NEW project's tabs and would
    // persist them into the PREVIOUS project's project.json (a cross-project
    // leak). We therefore read straight from the scope-keyed maps for the
    // PREVIOUS scope (authoritative; never the drift-prone flat mirror) and drop
    // any tab not owned by that scope, so a foreign tab can NEVER be written
    // into the wrong file (#55 save-side enforcement; mirrors writeScope).
    // Ask the tabs store for the persist-ready snapshot of the OUTGOING scope.
    // This keeps the tab-tree walking + #55 ownership filter + restorable filter
    // + detached re-dock + prune behind a single tabs-store method, so this store
    // no longer reaches into the tabs store's internal maps / tree helpers
    // (Struct #3 decoupling; the walk also collapses per Eff #13).
    const prevScopeKey = previousId ?? ROOT_SCOPE;
    const { tabs, tabGroups, activeTabIndex, workspaceVersion } =
      useTabsStore.getState().snapshotScopeForSwitch(prevScopeKey);
    // Leaving the ROOT scope saves its layout HERE, because the switch cannot.
    // `switch_project_runtime` writes the outgoing scope's layout from the
    // snapshot below, but only for a scope it can resolve a `local_file` for —
    // and the root has none and never will (it has no `project.json`). Its
    // layout therefore rode entirely on `CenterPanel`'s 300 ms debounced
    // `persistScope`, whose timer this very switch CANCELS: the effect's cleanup
    // clears it and re-schedules for the scope being switched TO. So a tab
    // opened, closed or moved at the root terminal and followed within 300 ms by
    // a click on a project pill was simply never written. `persistScope` is
    // scope-addressed (it reads `tabsByScope[scope]`, not the live scope), so
    // calling it here is safe however far the switch has progressed; it is
    // fire-and-forget for the same reason the switch is — nothing about
    // activating a project waits on the outgoing scope's bookkeeping.
    if (previousId === null) {
      void useTabsStore.getState().persistScope(ROOT_SCOPE, "").catch(() => {});
    }

    let nextProjects: ProjectEntry[] = [];
    set((state) => {
      nextProjects = state.projects.map((project) => {
        const status =
          id === null
            ? project.status === "current"
              ? "active"
              : project.status
            : project.id === id
              ? "current"
              : project.status === "current"
                ? "active"
                : project.status;
        return status === project.status ? project : { ...project, status };
      });
      let toastPath: string | null = null;
      if (id === null) {
        toastPath = state.rootDir ?? "root";
      } else {
        const proj = state.projects.find((p) => p.id === id);
        if (proj) {
          if (proj.remote) {
            // A remote (SSH) project lives in two places — show both: the
            // paired local working copy ("mirror", ~/tabtivity/projects/ssh/…) and
            // the remote target (user@host:remote_path). Rendered as two lines
            // (AppShell adds a `multiline` class when it sees the newline).
            const local =
              resolveLocalMirror(proj) || resolveProjectDirectory(proj) || proj.name;
            toastPath = `local   ${local}\nremote  ${formatRemoteTarget(proj.remote)}`;
          } else {
            toastPath = resolveProjectDirectory(proj) || proj.name;
          }
        }
      }
      return {
        projects: nextProjects,
        activeId: id,
        switchToast: toastPath,
        switchGeneration: state.switchGeneration + 1,
      };
    });
    await invoke<void>("save_projects", { projects: nextProjects });
    void useTimerStore.getState().setProject(id);
    // Switching TO a remote project does NOT bring it up by default: it surfaces
    // disconnected (local tabs restore and work on the mirror; remote panes are held
    // until the pool is up) and the user connects it from the pill's connection lamp.
    // The one exception is a project that opted into auto-connect, which is connected
    // here silently — see `autoConnectRemote`. Fire-and-forget; never blocks the switch.
    const activated = nextProjects.find((p) => p.id === id);
    if (activated?.remote) void autoConnectRemote(activated.id);
    // Fire-and-forget: the switch runs on a backend worker thread and returns
    // immediately. The resulting tab layout / side-panel folder arrives via the
    // `project-runtime-switched` event, handled by listenProjectRuntimeSwitched.
    invoke("switch_project_runtime", {
      projectId: id,
      previousProjectId: previousId,
      previousSnapshot: {
        // This snapshot OVERWRITES the previous project's project.json on
        // switch, so any field dropped here is lost even though the debounced
        // save wrote it — which is how a Files (Project) tab's browsed `folder`
        // (and a viewer's scroll position / an agent's plan-mode / the tmux
        // session names) each went missing while the shape was maintained
        // field-for-field in two places. `toSavedTabEntry` is now the ONE
        // enumeration of the persisted shape, shared with `persistScope`.
        tabLayout: tabs.map(toSavedTabEntry),
        tabGroups,
        activeTabIndex,
        // The version this window last saw for the outgoing scope: the switch
        // save goes through the workspace service like the debounced one.
        workspaceVersion,
        fileTabs: [],
        sidePanelFolder: previousId ? get().sidePanelFolderByProject[previousId] ?? null : null,
        activeLayoutMetadata: null,
        flushSecs: 0.0,
      },
    }).catch((error) => {
      console.warn("switch_project_runtime failed", error);
    });
  },

  reorderProjects: async (fromId, toId) => {
    if (fromId === toId) return;
    const byPosition = (a: ProjectEntry, b: ProjectEntry) => a.position - b.position;
    let nextProjects: ProjectEntry[] = [];
    let changed = false;
    set((state) => {
      const active = state.projects
        .filter((p) => p.status !== "inactive")
        .sort(byPosition);
      const inactive = state.projects
        .filter((p) => p.status === "inactive")
        .sort(byPosition);
      const fromIdx = active.findIndex((p) => p.id === fromId);
      const toIdx = active.findIndex((p) => p.id === toId);
      if (fromIdx < 0 || toIdx < 0) return {};
      const reordered = [...active];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      // Renumber every project with gap-spaced positions so values stay unique:
      // active pills in their new drag order first, inactive ones after.
      const positionById = new Map(
        [...reordered, ...inactive].map((p, i) => [p.id, (i + 1) * 10]),
      );
      nextProjects = state.projects.map((p) => {
        const position = positionById.get(p.id);
        return position !== undefined && position !== p.position
          ? { ...p, position }
          : p;
      });
      changed = true;
      return { projects: nextProjects };
    });
    if (changed) {
      await invoke<void>("save_projects", { projects: nextProjects });
    }
  },

  setSidePanelFolder: (projectId, folder) => {
    set((state) => ({
      sidePanelFolderByProject: {
        ...state.sidePanelFolderByProject,
        [projectId]: folder,
      },
    }));
    // Persist immediately so the panel view survives a restart even if the user
    // quits without switching projects. Re-saving the same value on restore or
    // project switch is harmless and idempotent.
    const localFile = get().projects.find((p) => p.id === projectId)?.local_file;
    if (localFile) {
      void invoke("save_side_panel_folder", { localFile, folder }).catch(() => {});
    }
  },

  clearSwitchToast: () => set({ switchToast: null }),

  clearConnToast: () => set({ connToast: null }),

  addProject: async (project) => {
    let nextProjects: ProjectEntry[] = [];
    set((state) => {
      nextProjects = [...state.projects, project].sort((a, b) => a.position - b.position);
      return { projects: nextProjects };
    });
    await useProjectsStore.getState().setActive(project.id);
  },

  activateProject: async (id) => {
    // Promote an inactive project to "active" (available, but NOT the current
    // focused project). Leaves activeId/scope untouched — opening (making it
    // current) is a separate, explicit action via setActive.
    let nextProjects: ProjectEntry[] = [];
    let changed = false;
    set((state) => {
      nextProjects = state.projects.map((project) => {
        if (project.id === id && project.status === "inactive") {
          changed = true;
          return { ...project, status: "active" };
        }
        return project;
      });
      return changed ? { projects: nextProjects } : {};
    });
    if (changed) {
      await invoke<void>("save_projects", { projects: nextProjects });
    }
    // Activating is the inverse of `deactivateProject`, which STOPS this project's
    // terminals — so it starts them: restore the saved tabs into the project's own
    // scope, hidden, without touching activeId. That is also what makes an
    // activated-from-Mobile project report its agent tabs (`agentStatuses` reads
    // `tabsByScope[id]`) before anyone opens it on the desktop.
    const activated = get().projects.find((p) => p.id === id);
    if (activated?.status === "active" && !backgroundRestored.has(id)) {
      backgroundRestored.add(id);
      void restoreProjectScope(activated).catch(() => {});
    }
  },

  deactivateProject: async (id) => {
    if (deactivatingProjects.has(id)) return;
    deactivatingProjects.add(id);
    try {
      const state = get();
      const project = state.projects.find((entry) => entry.id === id);
      if (!project || project.status === "inactive") return;

      const tabsStore = useTabsStore.getState();
      const loaded = Object.prototype.hasOwnProperty.call(tabsStore.tabsByScope, id);
      const tabs = tabsStore.tabsByScope[id] ?? [];
      const ptyTabs = tabs.filter((tab) => isPtyTabKind(tab.kind));
      const localPersistenceEnabled =
        !IS_WINDOWS &&
        useSettingsStore.getState().settings?.persist_local_sessions !== false;
      const tmuxTargets = projectTmuxTargets(project, tabs, localPersistenceEnabled);
      // Closing a project stops what runs HERE. A persistent session on a remote
      // host is left running: surviving the desktop going away is what it is for,
      // and the host may well be unreachable at this moment (VPN down, laptop
      // offline) — an SSH failure must never veto closing the project. Remote
      // sessions are killed only on purpose, from the project's Sessions view
      // (`remote_tmux_kill`); the dialog says so.
      const localTargets = tmuxTargets.filter((target) => target.hostId === null);
      const remoteSessions = tmuxTargets.length - localTargets.length;

      if (ptyTabs.length > 0 || tmuxTargets.length > 0) {
        // Tabtivity's own dialog, not the platform's: it wears the theme, and it
        // lists the tabs instead of counting them (stores/stopProjectPrompt).
        const { useStopProjectStore } = await import("./stopProjectPrompt");
        const ok = await useStopProjectStore.getState().request(
          project.name,
          ptyTabs.map((tab) => ({
            key: tab.key,
            label: tab.label,
            kind: tab.kind,
            location: effectiveTabLocation(tab, { vmProject: !!project.vm?.enabled }),
          })),
          localTargets.length,
          remoteSessions,
        );
        if (!ok) return;
      }

      // Saving is a precondition for destructive teardown. Autosaves are allowed
      // to fail quietly; this one is not, because the stopped tabs must restore.
      if (loaded) {
        await tabsStore.persistScopeStrict(id, project.local_file);
      }

      // Kill only LOCAL sessions named by this project's tabs. Never use tmux
      // kill-server: the local tmux server is shared with other projects and with
      // sessions created outside Tabtivity.
      const kills = await Promise.allSettled(
        localTargets.map((target) => invoke<void>("local_tmux_kill", { session: target.session })),
      );
      const failures = kills.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${localTargets[index].session}: ${String(result.reason)}`]
          : [],
      );
      if (failures.length > 0) {
        throw new Error(`Could not stop every persistent session:\n${failures.join("\n")}`);
      }

      // Belt-and-suspenders cleanup catches hidden, detached, and orphaned views,
      // and reaps each PTY's whole child subtree.
      await invoke<string[]>("pty_kill_scope", { scope: id });

      const currentProjects = get().projects;
      const currentActiveId = get().activeId;
      const nextProjects = currentProjects.map((entry) =>
        entry.id === id ? { ...entry, status: "inactive" } : entry,
      );
      // The successor is the first remaining open project.
      const nextActiveId =
        currentActiveId === id
          ? (nextProjects.find((entry) => entry.status === "active") ??
              nextProjects.find((entry) => entry.status !== "inactive"))?.id ?? null
          : currentActiveId;

      // Persist status before exposing it in the UI. If this fails, the project
      // remains active (with its deliberately stopped terminals) and can be
      // retried; it never becomes an inactive project with leaked processes.
      await invoke<void>("save_projects", { projects: nextProjects });
      set({ projects: nextProjects });
      if (currentActiveId !== nextActiveId) {
        await useProjectsStore.getState().setActive(nextActiveId);
      }
      // setActive must snapshot the old scope while its saved tabs still exist;
      // only then may we remove the scope's in-memory maps and native popouts.
      await tabsStore.unloadScope(id);
      // The scope is unloaded, so a later re-activation must be free to restore it
      // again — leaving the id marked would make that second activation a no-op.
      backgroundRestored.delete(id);
      if (project.remote) dropRemotePool(id);
    } catch (error) {
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message(String(error), {
        title: translate(
          useI18nStore.getState().lang,
          "projectSwitcher.stopError",
        ),
        kind: "error",
      });
    } finally {
      deactivatingProjects.delete(id);
    }
  },

  archiveProject: async (id) => {
    // Move it into the archive + drop it from projects.json.
    await removeProjectVia(id, () =>
      invoke("archive_project", { projectId: id, archivedAt: new Date().toISOString() }),
    );
  },

  forgetProject: async (id) => {
    // Drop it from projects.json + Tabtivity's state dirs; the folder stays put.
    await removeProjectVia(id, () => invoke("forget_project", { projectId: id }));
  },

  updateProjectDescription: async (id, description) => {
    // Backend cleans (trims, empties → null) and writes projects.json +
    // project.json; mirror the cleaned value into local state.
    const cleaned = await invoke<string | null>("set_project_description", {
      projectId: id,
      description,
    });
    patchProject(id, (project) => ({ ...project, description: cleaned ?? undefined }));
  },

  renameProject: async (id, name) => {
    // Backend trims, rejects blank, and writes projects.json + project.json;
    // mirror the cleaned name into local state so the pill updates immediately.
    const cleaned = await invoke<string>("set_project_name", {
      projectId: id,
      name,
    });
    patchProject(id, (project) => ({ ...project, name: cleaned }));
  },

  renameProjectFolder: async (id, leaf) => {
    const before = get().projects.find((project) => project.id === id);
    if (!before) return;
    const wasOpen = before.status !== "inactive";
    const wasCurrent = get().activeId === id;
    // Open shells and agents hold the old path and would write back into a
    // folder that no longer exists, so the folder only moves while closed.
    if (wasOpen) {
      await get().deactivateProject(id);
      if (get().projects.find((project) => project.id === id)?.status !== "inactive") {
        throw new Error(
          translate(useI18nStore.getState().lang, "pill.folderRenameStillOpen"),
        );
      }
    }
    try {
      // The backend re-points `directory`/`local_file` and the saved layout, so
      // the reopen below restores the tabs under the new folder.
      const updated = await invoke<ProjectEntry>("rename_project_dir", { projectId: id, leaf });
      patchProject(id, (project) => ({ ...project, ...updated }));
    } finally {
      if (wasOpen) {
        await get().activateProject(id);
        if (wasCurrent) await get().setActive(id);
      }
    }
  },

  moveRemoteMirror: async (id, name, parentDir) => {
    // Backend moves the mirror folder + its bytes to `<parentDir>/<name>` and
    // persists the new pointer (projects.json `extra["mirror"]`). The mirror IS
    // held on the entry (flattened `mirror`, read by resolveLocalMirror), so patch
    // it in memory too — otherwise the switch toast, the disconnected file-browser
    // pane, and local tab titles keep the old path until the next reload.
    const newPath = await invoke<string>("move_remote_mirror", { projectId: id, name, parentDir });
    patchProject(id, (project) => ({ ...project, mirror: newPath }));
    return newPath;
  },

  extendProjectToRemote: async (id, remote) => {
    // Backend attaches the remote spec, creates the empty host root, and moves
    // the project into the mount-free remote layout (its old local dir becomes
    // the mirror). No data is uploaded — the returned entry is a disconnected
    // remote project. Replace the whole entry so `remote`/`mirror`/`directory`
    // (and thus the pill lamp + file tree) update immediately.
    const updated = await invoke<ProjectEntry>("extend_project_to_remote", {
      req: { projectId: id, remote },
    });
    patchProject(id, () => updated);
  },

  setProjectSandbox: async (id, enabled, sourceDecision) => {
    // Backend flips `enabled` on the stored spec (preserving hand-tuned
    // image/network/… fields). O#143: an in-repo Dockerfile/devcontainer image
    // is never adopted silently — a `needs_confirmation` outcome writes
    // nothing, so local state (and the spawn-time gate in CenterPanel) is only
    // updated on `applied`. The caller is responsible for re-invoking with a
    // `sourceDecision` after showing its own confirm dialog.
    const outcome = await invoke<SandboxToggleOutcome>("set_project_sandbox", {
      projectId: id,
      enabled,
      sourceDecision: sourceDecision ?? null,
    });
    if (outcome.outcome === "applied") {
      patchProject(id, (project) => ({ ...project, sandbox: outcome.spec }));
    }
    return outcome;
  },

  setProjectSandboxSpec: async (id, spec) => {
    const saved = await invoke<SandboxSpec>("set_project_sandbox_spec", {
      projectId: id,
      spec,
    });
    patchProject(id, (project) => ({ ...project, sandbox: saved }));
  },

  setProjectPython: async (id, interpreter) => {
    // Backend writes both stores (projects.json mirror + project.json) and returns
    // what it stored — null when cleared back to auto-detect.
    const saved = await invoke<string | null>("set_project_python", {
      projectId: id,
      interpreter,
    });
    patchProject(id, (project) => ({ ...project, python_interpreter: saved ?? undefined }));
  },

  setProjectRemoteControl: async (id, remoteControl) => {
    // Backend writes both stores (projects.json mirror + project.json) and
    // returns what it stored — null when cleared back to inheriting the
    // global setting.
    const saved = await invoke<boolean | null>("set_project_remote_control", {
      projectId: id,
      remoteControl,
    });
    patchProject(id, (project) => ({ ...project, remote_control: saved ?? undefined }));
  },

  setProjectScheduleMcp: async (id, level) => {
    await invoke("set_project_schedule_mcp", { projectId: id, level });
    patchProject(id, (project) => ({ ...project, schedule_mcp: level }));
  },

  setProjectGitPushMcp: async (id, level, protectedBranches) => {
    const policy = await invoke<GitPushMcpPolicy>("set_project_git_push_mcp", { projectId: id, level: level ?? null, protected: protectedBranches ?? null });
    patchProject(id, (project) => ({ ...project, git_push_mcp: policy }));
  },

  setProjectAutoConnect: async (id, enabled) => {
    // Backend patches `auto_connect` on the remote spec in both projects.json and
    // project.json and returns the resulting state; mirror it into local state so
    // both surfaces (pill menu + Connect dialog) reflect it at once.
    const result = await invoke<boolean>("set_project_auto_connect", {
      projectId: id,
      enabled,
    });
    patchProjectRemote(id, (remote) => ({ ...remote, auto_connect: result || undefined }));
  },

  setProjectPersistSessions: async (id, enabled) => {
    // TODO #85: persistent (tmux) sessions are DEFAULT ON for a remote project, so
    // the backend stores only an explicit opt-out (`persist_sessions: false`) and
    // clears the field when re-enabled. Mirror the resulting state into local state
    // as `persist_sessions: enabled ? undefined : false` so the pill reflects it.
    const result = await invoke<boolean>("set_project_persist_sessions", {
      projectId: id,
      enabled,
    });
    patchProjectRemote(id, (remote) => ({
      ...remote,
      persist_sessions: result ? undefined : false,
    }));
  },

  setProjectMobileAccess: async (id, enabled, devices) => {
    // The backend answers what it stored: the switch, and the per-phone list
    // (`null` = every phone) after dropping phones no longer paired.
    const result = await invoke<{ enabled: boolean; devices: string[] | null }>(
      "set_project_mobile_access",
      { projectId: id, enabled, devices: enabled ? devices : null },
    );
    patchProject(id, (project) => ({
      ...project,
      [MOBILE_ACCESS_KEY]: result.enabled || undefined,
      [MOBILE_DEVICES_KEY]: result.devices ?? undefined,
    }));
  },

  setProjectRemoteLabel: async (id, label) => {
    const result = await invoke<string | null>("set_project_remote_label", {
      projectId: id,
      label,
    });
    patchProjectRemote(id, (remote) => ({ ...remote, label: result ?? undefined }));
  },

  setProjectRemoteUser: async (id, user) => {
    const result = await invoke<string | null>("set_project_remote_user", {
      projectId: id,
      user,
    });
    patchProjectRemote(id, (remote) => ({
      ...remote,
      user: result ?? undefined,
      // The backend drops `key_auth` with the login name; mirror that
      // rather than leave a stale "this host needs no password" claim
      // driving the Auto-connect toggle for an account that never proved it.
      key_auth: undefined,
    }));
  },

  setProjectOpenvpn: async (id, config, username) => {
    // Backend patches the `openvpn` field on the remote spec in both projects.json
    // and project.json and returns the stored config path (""=cleared); mirror it
    // into the entry's `remote.openvpn` so the Connect dialog reflects it at once.
    // `username` (for `auth-user-pass` configs) is stored alongside; undefined
    // leaves it untouched here by re-sending the current value.
    const cleanUser = username?.trim() || undefined;
    const stored = await invoke<string>("set_project_openvpn", {
      projectId: id,
      config: config && config.trim() ? config : null,
      username: cleanUser ?? null,
    });
    patchProjectRemote(id, (remote) => ({
      ...remote,
      openvpn: stored ? { config: stored, username: cleanUser } : undefined,
    }));
  },

  setProjectCategories: async (id, categories) => {
    // Backend trims/dedupes and writes projects.json + project.json, returning
    // the cleaned list; mirror it so the pill bar and project cloud recolor
    // immediately.
    const cleaned = await invoke<string[]>("set_project_categories", {
      projectId: id,
      categories,
    });
    patchProject(id, (project) => ({
      ...project,
      categories: cleaned.length > 0 ? cleaned : undefined,
    }));
  },

  setProjectGitDisabled: async (id, disabled) => {
    // Backend deletes/inits .git, writes projects.json + project.json, and
    // returns the resulting git_type ("none" or "local"); mirror it so the pill
    // label and context-menu state update immediately.
    const gitType = await invoke<string>("set_project_git_disabled", {
      projectId: id,
      disabled,
    });
    patchProject(id, (project) => ({ ...project, git_type: gitType }));
  },

  repairProjectScaffold: async (id) => {
    const repair = await invoke<ProjectScaffoldRepair>("repair_project_scaffold", { projectId: id });
    useProjectsStore.setState({ connToast: describeScaffoldRepair(repair) });
    return repair;
  },

  publishProject: async (id, provider, visibility, publishFrom = "local") => {
    // Backend runs the provider CLI (`gh`/`glab` repo create … then push) and
    // writes the new push target + provider into projects.json + project.json;
    // mirror it into local state. For a work-remote project `publishFrom`
    // chooses the side — the local mirror by default, because the provider
    // login is this machine's. Returns the CLI's stdout (repo URL).
    const output = await invokeTrusted<string>("publish_project", {
      projectId: id,
      provider,
      visibility,
      publishFrom,
    });
    const gitType = `remote-${visibility}`;
    patchProject(id, (project) => ({ ...project, git_type: gitType, git_provider: provider }));
    return output;
  },

  detachProjectFromRemote: async (id) => {
    // Backend promotes the local mirror back to the project directory and drops
    // the remote/mirror pointers (host files untouched), returning the updated
    // local entry. Replace the whole entry so the pill lamp + file tree update.
    const oldDir = get().projects.find((p) => p.id === id)?.directory ?? "";
    const updated = await invoke<ProjectEntry>("detach_project_from_remote", { projectId: id });
    patchProject(id, () => updated);

    // Re-point the tabs. `directory` just changed out from under them: it was the remote
    // state dir, and it is now the promoted mirror. Every tab still holds the old one as
    // its cwd — harmless while the project was remote (localTabCwd rewrote it at render),
    // instantly wrong the moment it isn't, because that override is gated on the project
    // BEING remote. Left alone, agents relaunch inside the state dir this detach just
    // emptied, and Claude — which keys its session history by cwd — can no longer find the
    // conversation to `--resume`. See `detachScopeFromRemote`.
    if (oldDir && updated.directory) {
      useTabsStore.getState().detachScopeFromRemote(id, oldDir, updated.directory);
    }

    // The SSH/VPN lamp lives in its own store, keyed by project — nothing about replacing
    // the project entry clears it, so a detached project would keep showing a connection
    // to a host it no longer has.
    useRemoteStatusStore.getState().clear(id);
  },

  unpublishProject: async (id) => {
    // Backend removes the `origin` remote (locally or over ssh) and resets the
    // push target to local, leaving history + the hosted repo intact. Mirror the
    // git_type/provider reset into local state.
    await invoke("unpublish_project", { projectId: id });
    patchProject(id, (project) => ({ ...project, git_type: "local", git_provider: undefined }));
  },

  setProjectVisibility: async (id, visibility) => {
    // Backend flips visibility in place via the provider CLI (`gh/glab repo
    // edit`), locally or over ssh, and writes the new remote-<vis> git_type.
    const output = await invoke<string>("set_project_visibility", { projectId: id, visibility });
    patchProject(id, (project) => ({ ...project, git_type: `remote-${visibility}` }));
    return output;
  },

  switchProjectProvider: async (id, provider, visibility, publishFrom = "local") => {
    // Backend moves the old origin aside (old repo left intact, on whichever side
    // holds it) and re-publishes to the new provider, writing the new git_type +
    // git_provider. Returns the create CLI stdout (new repo URL); mirror the new
    // provider/type into state.
    const output = await invokeTrusted<string>("switch_project_provider", {
      projectId: id,
      provider,
      visibility,
      publishFrom,
    });
    patchProject(id, (project) => ({
      ...project,
      git_type: `remote-${visibility}`,
      git_provider: provider,
    }));
    return output;
  },

  getProjectGitHosting: async (id) => {
    return invoke<GitHostingInfo>("get_project_git_hosting", { projectId: id });
  },

  setProjectGitHosting: async (id, args) => {
    // Backend writes the profile URL to project.json + projects.json and the
    // token to the OS keyring, then returns the resulting (token-free) info.
    // Mirror the profile URL into local pill state so it's visible immediately.
    const info = await invoke<GitHostingInfo>("set_project_git_hosting", {
      projectId: id,
      profileUrl: args.profileUrl ?? null,
      token: args.token ?? null,
      clearToken: args.clearToken ?? false,
    });
    patchProject(id, (project) => ({ ...project, git_profile_url: info.profile_url ?? undefined }));
    return info;
  },
}));

/// Listen for the backend's `project-runtime-switched` event and apply the
/// restored tab layout + side-panel folder. The switch runs on a backend
/// worker thread (see `switch_project_runtime`), so its result arrives here
/// asynchronously rather than as the return value of the invoke in setActive.
/// Register once at app startup; returns an unlisten function.
export function listenProjectRuntimeSwitched(): Promise<() => void> {
  return listen<ProjectRuntimeSwitchedPayload>("project-runtime-switched", (ev) => {
    const payload = ev.payload;
    const scopeKey = payload.projectId ?? ROOT_SCOPE;
    const tabsStore = useTabsStore.getState();
    // Keep shell/files/network tabs, resumable agent tabs (Claude with a sessionId), and
    // in-app file-viewer embeds; other agent tabs (and external-app embeds) are
    // dropped (no session to restore). Newer snapshots carry `kind`/`sessionId`;
    // fall back to deriving the kind from the command. The saved groups tree
    // self-heals — loadFromLayout drops any tree key absent from the (filtered)
    // tab list.
    const restorable = payload.tabLayout.filter((t) =>
      isRestorableTab({
        kind: t.kind ?? cmdToKind(t.cmd),
        cmd: t.cmd,
        sessionId: t.sessionId,
        // A custom agent is restorable only via `resumeArgs?.length` — omitting
        // it here dropped such tabs on a runtime switch (the same drift the
        // root/box restore copies had before `hydrateScopeFromDisk`).
        resumeArgs: t.resumeArgs,
        viewer: t.viewer,
        localLaunch: t.localLaunch,
      }),
    );
    // Mount-free remote: defer restoring a remote project's tabs until its pooled
    // SSH/SFTP connection is up. Restoring them while disconnected spawns `ssh -tt`
    // PTYs and SFTP listings that block on the dead pool (the "hang"). The
    // CenterPanel restore effect — gated on the SSH status reaching "connected" —
    // performs the restore once the user reconnects via the header lamp.
    const switchedProject = payload.projectId
      ? useProjectsStore.getState().projects.find((p) => p.id === payload.projectId) ?? null
      : null;
    if (
      switchedProject?.remote &&
      useRemoteStatusStore.getState().byProject[payload.projectId ?? ""]?.ssh !== "connected"
    ) {
      return;
    }
    // Only restore from disk if this scope was never initialized this session.
    // An existing (possibly empty) entry means the user's in-memory tabs win.
    if (restorable.length > 0 && !(scopeKey in tabsStore.tabsByScope)) {
      const project = switchedProject;
      tabsStore.loadFromLayout(
        restorable,
        resolveProjectDirectory(project),
        scopeKey,
        payload.tabGroups ?? undefined,
      );
    }
    if (payload.projectId && payload.sidePanelFolder !== null) {
      useProjectsStore.getState().setSidePanelFolder(payload.projectId, payload.sidePanelFolder);
    }
  });
}
