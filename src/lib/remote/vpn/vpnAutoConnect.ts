import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../../stores/projects";
import { useSettingsStore } from "../../../stores/settings";
import {
  markVpnConnected,
  markVpnConnecting,
  markVpnError,
  useVpnStatusStore,
} from "../../../stores/remote/vpn/vpnStatus";
import { canConnectVpnSilently, connectVpnSilently } from "./vpnConnect";
import { keyringState } from "../../keyring";
import { openConnectionInRoot } from "../remoteConnect";
import { translate, useI18nStore } from "../../i18n";

/**
 * "Connect this tunnel on launch" — the machine-level twin of a project's
 * `remote.auto_connect`, armed per config in the header's VPN menu.
 *
 * It is armed on the *tunnel*, not on a project, because that is what a tunnel is:
 * it reroutes the whole computer for as long as it is up, and a VPN you always want
 * up is a property of where you work, not of which project happens to be open. So it
 * can be armed for a config no project uses at all.
 *
 * Two promises, both inherited from the project-side rule (see `autoConnectRemote`):
 *
 *  1. **It never prompts.** The opt-in is only offered when it can be kept — the
 *     credentials are saved — and it is *re-checked* here at launch rather than
 *     trusted, so an opt-in that went stale (the password was forgotten meanwhile)
 *     degrades to leaving the tunnel down, never to ambushing the user with a modal
 *     during startup.
 *  2. **It never elevates twice.** `pkexec` raises its polkit dialog before OpenVPN
 *     validates anything, so a doomed attempt is not free (see `lib/remote/vpn/vpnConnect`).
 *
 * Non-headless mode is the deliberate exception to (1): with `connections_headless`
 * off, Tabtivity handles no passwords at all, so "connect on launch" can only mean
 * "open the connect command in the root terminal" — one tab, waiting for the user,
 * which is exactly what activating a VPN-gated project does in that mode.
 */

/**
 * Arm `config` to connect on launch, or disarm it. Arming is exclusive: a tunnel owns
 * the machine's routing, so two armed configs would just be two tunnels fighting over
 * it — arming one disarms the other by construction (a single stored path, not a set).
 */
export async function setVpnAutoConnect(config: string, enabled: boolean): Promise<void> {
  const current = useSettingsStore.getState().settings?.vpn_auto_connect ?? null;
  if (enabled) {
    if (current === config) return;
  } else if (current !== config) {
    return;
  }
  await useSettingsStore.getState().updateSettings({ vpn_auto_connect: enabled ? config : null });
}

/**
 * Whether the user asked Tabtivity to remember this config's credentials.
 *
 * Deliberately read from *settings*, not from the keychain. The keychain is the only
 * place the secret lives, but it cannot always be asked: a locked Secret Service
 * collection answers every read like an empty one, so `vpn_has_saved_password` says
 * "no" over a perfectly good saved password — which is what made the save toggle
 * appear to do nothing after a restart. This flag survives that, and is reconciled
 * back to the truth by [`syncVpnCredentialSaved`] whenever the keychain *is* readable.
 */
export function isVpnCredentialSaved(config: string): boolean {
  return (useSettingsStore.getState().settings?.vpn_saved_configs ?? []).includes(config);
}

/** Record (or drop) the "remember this config's credentials" intent. */
export async function setVpnCredentialSaved(config: string, saved: boolean): Promise<void> {
  const current = useSettingsStore.getState().settings?.vpn_saved_configs ?? [];
  const next = saved
    ? current.includes(config)
      ? current
      : [...current, config]
    : current.filter((c) => c !== config);
  if (next.length === current.length && next.every((c, i) => c === current[i])) return;
  await useSettingsStore.getState().updateSettings({ vpn_saved_configs: next });
}

/**
 * Reconcile the recorded intent against what the keychain actually holds. Call only
 * with a reading taken while the keychain was **readable** — feeding it the `false`
 * a locked keyring returns would erase exactly the record that exists to survive
 * that lock.
 */
export async function syncVpnCredentialSaved(config: string, actuallySaved: boolean): Promise<void> {
  if (actuallySaved === isVpnCredentialSaved(config)) return;
  await setVpnCredentialSaved(config, actuallySaved);
}

/**
 * The auth username for an `auth-user-pass` config, as far as the frontend knows one:
 * a project that uses this config carries it on its spec. It is not a secret, and the
 * backend also keeps a copy beside the saved password (which is the only way a
 * project-less tunnel can know it) — so `undefined` here is not "no username", it is
 * "none on this side"; the backend fills it in.
 */
export function vpnUsernameFor(config: string): string | undefined {
  return useProjectsStore
    .getState()
    .projects.find((p) => p.remote?.openvpn?.config === config)?.remote?.openvpn?.username;
}

/** Guards the launch connect against a second run (a re-mount, a second window). */
let launched = false;

/**
 * Bring the armed tunnel up, once, at startup. Call after settings and projects have
 * loaded (the username seed lives on a project's spec). Best-effort and silent: every
 * exit that isn't a live tunnel leaves the lamp dark and the machine's routing alone.
 */
export async function autoConnectVpnOnLaunch(): Promise<void> {
  if (launched) return;
  const settings = useSettingsStore.getState().settings;
  const config = settings?.vpn_auto_connect;
  if (!config) return;
  launched = true;

  const status = useVpnStatusStore.getState();
  // A tunnel can outlive the app (it is a root daemon, not our child), so the one we
  // are about to start may already be up from a previous run. Reconcile first.
  await status.refresh();
  if (useVpnStatusStore.getState().byConfig[config]) return;

  const username = vpnUsernameFor(config);

  // Non-headless: Tabtivity handles no password, so "auto-connect" means the connect
  // command is waiting in the root terminal for the user to authenticate. Building it
  // also arms the tunnel backend-side (`--writepid`), so it stays visible and killable.
  if (settings?.connections_headless === false) {
    try {
      await openVpnLoginInTerminal(config);
    } catch (error) {
      useVpnStatusStore.getState().setState(config, "off");
      console.warn("VPN auto-connect (root terminal) skipped", error);
    }
    return;
  }

  // Headless: re-check the promise rather than trusting the toggle. A saved password
  // that has since been forgotten must leave the tunnel down — never open a modal the
  // user did not ask for while the app is still starting up.
  if (!(await canConnectVpnSilently(config, username))) {
    // Distinguish the two ways that check fails, because only one of them is the
    // user's fault. A **locked** keyring reads exactly like "nothing saved", so the
    // tunnel that was armed to come up silently just... doesn't, with no explanation
    // anywhere — the single most confusing outcome this feature has. Unlocking would
    // mean prompting during startup, which auto-connect promises not to do, so say so
    // instead and leave the remedy one click away in the header.
    if (isVpnCredentialSaved(config) && (await keyringState()) === "locked") {
      useProjectsStore.setState({
        connToast: translate(useI18nStore.getState().lang, "vpnAutoConnect.keyringLockedToast", {
          config: fileOf(config),
        }),
      });
    }
    console.warn("VPN auto-connect skipped: credentials no longer allow a silent connect");
    return;
  }
  useVpnStatusStore.getState().setState(config, "connecting");
  try {
    await connectVpnSilently(config, username);
    useVpnStatusStore.getState().setState(config, "connected");
    useProjectsStore.setState({
      connToast: translate(useI18nStore.getState().lang, "vpnAutoConnect.upToast", {
        config: fileOf(config),
      }),
    });
  } catch (error) {
    useVpnStatusStore.getState().setState(config, "off");
    console.warn("VPN auto-connect failed", error);
  }
}

/**
 * **The** non-headless VPN login: hand `config` to an interactive root-terminal tab
 * and let OpenVPN itself ask for whatever it needs — the account password, a key
 * passphrase, a challenge/OTP — none of which Tabtivity ever sees or has to model.
 *
 * It is the one implementation of that handoff, shared by every caller that reaches
 * for it: the `connections_headless: false` paths (activation, auto-connect, the
 * header menu) which *always* go this way, and the headless paths that fall back to
 * it **per connect** when their own login failed (the modal's "Log in in terminal",
 * see `stores/remote/vpn/vpnPrompt`'s `useTerminal`). That fallback is deliberately a *local*
 * switch — one tunnel, one click — and never writes the global setting: a mode is
 * how the user wants Tabtivity to behave, not something a failed handshake gets to
 * decide for them.
 *
 * Building the command also **arms** the tunnel backend-side (the pidfile +
 * `--writepid` + management socket `interactive_connect_command` appends), so a
 * tunnel authenticated in the terminal is as visible and as killable as a headless
 * one — which is also what makes the `pollVpnUp` below able to observe it at all.
 *
 * Throws if the command can't be built; the lamp is only moved once it can, so a
 * failed handoff leaves no phantom "connecting" behind.
 */
export async function openVpnLoginInTerminal(
  config: string,
  opts?: { label?: string; projectId?: string | null },
): Promise<void> {
  const name = opts?.label ?? fileOf(config);
  const command = await invoke<string>("openvpn_login_command", { config });
  if (opts?.projectId) markVpnConnecting(opts.projectId, config);
  else useVpnStatusStore.getState().setState(config, "connecting");
  openConnectionInRoot({
    label: `OpenVPN · ${name}`,
    command,
    dedupeKey: `vpn:${config}`,
  });
  pollVpnUp(config, { projectId: opts?.projectId, name });
}

/**
 * Poll until the root-terminal tunnel is up (non-headless: the user authenticates in
 * that terminal, so `openvpn_status` is the only completion signal). Bounded, so a
 * tunnel that is never authenticated stops polling instead of spinning forever.
 *
 * With a `projectId` it also drives that project's pill lamp and takes its hold on
 * the tunnel, so a project-scoped handoff ends on the same marks a headless connect
 * would have left.
 *
 * It deliberately does **not** bail when the project is switched away from, and it
 * always runs to a *terminal* mark — connected, or off/error after the bound. The
 * tunnel is machine-wide; its coming up has nothing to do with which project is on
 * screen, and an early bail would strand the shared lamp mid-handshake: a phantom the
 * header's Disconnect won't touch (it is disabled while connecting) and every Connect
 * dialog reads as a live tunnel. Updating an inactive project's lamp on the way is
 * harmless; leaving the machine-wide one at "connecting" forever is not.
 */
export function pollVpnUp(
  config: string,
  opts?: { projectId?: string | null; name?: string },
): void {
  const projectId = opts?.projectId;
  let attempts = 0;
  const maxAttempts = 40; // ~60s at 1.5s cadence
  const succeed = () => {
    if (projectId) markVpnConnected(projectId, config);
    else useVpnStatusStore.getState().setState(config, "connected");
    useProjectsStore.setState({
      connToast: `VPN up · ${opts?.name ?? fileOf(config)} — this computer's traffic now routes through the tunnel`,
    });
  };
  const giveUp = () => {
    if (projectId) markVpnError(projectId, config);
    else useVpnStatusStore.getState().setState(config, "off");
  };
  const tick = () => {
    void invoke<boolean>("openvpn_status", { config })
      .then((up) => {
        if (up) {
          succeed();
          return;
        }
        if (++attempts >= maxAttempts) {
          giveUp();
          return;
        }
        setTimeout(tick, 1500);
      })
      .catch(() => {
        if (++attempts >= maxAttempts) giveUp();
        else setTimeout(tick, 1500);
      });
  };
  setTimeout(tick, 1500);
}

/** The config's file name — the whole path is a tooltip, not a label. */
export function fileOf(config: string): string {
  return config.split(/[\\/]/).pop() || config;
}
