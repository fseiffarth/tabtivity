import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ConnLamp } from "../common/ConnLamp";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { isVpnTerminalHandoff, useVpnPromptStore } from "../../stores/remote/vpn/vpnPrompt";
import { anyVpnLive, disconnectVpnTunnel, useVpnStatusStore } from "../../stores/remote/vpn/vpnStatus";
import { canConnectVpnSilently, connectVpnSilently } from "../../lib/remote/vpn/vpnConnect";
import {
  fileOf,
  isVpnCredentialSaved,
  openVpnLoginInTerminal,
  setVpnAutoConnect,
  setVpnCredentialSaved,
  syncVpnCredentialSaved,
  vpnUsernameFor,
} from "../../lib/remote/vpn/vpnAutoConnect";
import { keyringState, unlockKeyring, type KeyringState } from "../../lib/keyring";
import type { StoredVpnConfig } from "../../types";
import { useT } from "../../lib/i18n";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useHeaderStatusReport } from "../../stores/headerStatus";
import { ErrorNote } from "../common/ErrorNote";
import { VpnGlyph } from "./HeaderGlyphs";

const MENU_ID = "vpn";

/**
 * Bound a backend call so it can never strand the connect at amber. The silent-connect
 * probe (`vpn_can_connect_silently`) reads the OS keychain, and a Secret Service
 * collection that is *locked* makes that read block on an unlock that, headless, never
 * comes — so the very first `await` in `connect` hangs, the lamp sits "connecting"
 * forever, and the password modal (which is only reached *after* this probe) is never
 * shown. On timeout we take `fallback` and move on; here that is "not silent", so the
 * connect drops straight to the modal instead of waiting on the keyring.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (v: T) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => done(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        done(v);
      },
      () => {
        clearTimeout(timer);
        done(fallback);
      },
    );
  });
}

/** Stable empty list for the `vpn_saved_configs` selector — a fresh `[]` per render
 *  would make the zustand subscription fire on every store change. */
const NO_SAVED: string[] = [];

/**
 * The machine's OpenVPN control, in the header — where a machine-level thing belongs.
 *
 * Every other VPN surface in Tabtivity hangs off a project: the toggle is in that
 * project's Connect dialog, the lamp is on its pill, and both vanish the moment you
 * switch away. The tunnel does not vanish. It runs as root, Tabtivity passes it no
 * routing flags, and a typical `.ovpn` pushes `redirect-gateway` — so while it is
 * up, *this computer's* traffic goes through it, browser and all, whether or not
 * the project that asked for it is still on screen.
 *
 * So it is always here, whether or not a tunnel is up: dim when nothing is running,
 * lit when something is. It lists every stored config and can bring one **up** as
 * well as down — a VPN is a thing you use, not only a precondition for an SSH
 * project, and requiring one to own a project just to reach the tunnel was backwards.
 * A tunnel started here has no holder; it is simply up (see `vpnStatus`).
 */
export function VpnIndicator() {
  const t = useT();
  const byConfig = useVpnStatusStore((s) => s.byConfig);
  const holders = useVpnStatusStore((s) => s.holders);
  const refresh = useVpnStatusStore((s) => s.refresh);
  const setVpnState = useVpnStatusStore((s) => s.setState);
  const projects = useProjectsStore((s) => s.projects);
  const requestPassword = useVpnPromptStore((s) => s.request);

  const armed = useSettingsStore((s) => s.settings?.vpn_auto_connect ?? null);
  // Which configs the user asked us to remember. Read reactively so the save toggle
  // reflects a click immediately, and from *settings* rather than the keychain for
  // the reason `isVpnCredentialSaved` documents: a locked keychain would report every
  // one of them as unsaved. `NO_SAVED` keeps the selector identity-stable.
  const savedConfigs = useSettingsStore((s) => s.settings?.vpn_saved_configs ?? NO_SAVED);
  const headless = useSettingsStore((s) => s.settings?.connections_headless ?? true);
  // Off by default (Settings' "Remote features") — most projects are local-only,
  // so this machine-wide tunnel control stays out of the header until asked for.
  const enabled = useSettingsStore((s) => s.settings?.vpn_enabled ?? false);

  // Shared across every header hover-menu (stores/headerHoverMenu) so switching
  // straight from another one closes it instantly instead of racing its own
  // close-grace timer. `setOpen` mirrors the old local-state setter's boolean
  // signature so the rest of this component reads unchanged.
  const open = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const setOpen = useCallback(
    (v: boolean) => (v ? openMenu(MENU_ID) : closeMenu(MENU_ID)),
    [openMenu, closeMenu],
  );
  const [configs, setConfigs] = useState<StoredVpnConfig[]>([]);
  const [error, setError] = useState("");
  // Per config: can it be brought up with no prompt at all? Only then may it be armed
  // to connect on launch, since auto-connect promises never to prompt. Refreshed each
  // time the menu opens — the credentials can be saved or forgotten between openings.
  const [silent, setSilent] = useState<Record<string, boolean>>({});
  // Whether the OS credential store can be read at all. A **locked** one answers every
  // "is a password saved?" with "no", so without this the menu would report every
  // saved credential as missing and quietly go back to prompting — the bug this whole
  // block exists for. `unlocking` guards the (system-modal) unlock click.
  const [keyring, setKeyring] = useState<KeyringState>("unlocked");
  const [unlocking, setUnlocking] = useState(false);
  // Config path whose Remove is awaiting its second, confirming click. Removal
  // also forgets the config's saved credentials, and those are not recoverable
  // by re-browsing the file — hence armed, not single-click.
  const [removeArm, setRemoveArm] = useState<string | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  // Configs whose in-flight connect the user has hit Stop on. The connect runs
  // async across several awaits (a silent attempt blocks up to the backend's 45 s
  // handshake timeout), and `refresh` preserves a `connecting` entry forever, so a
  // wedged attempt needs an explicit escape hatch — this flag is it. A connect
  // checks it after each await and stands down instead of flipping the lamp green.
  const abortedRef = useRef<Set<string>>(new Set());

  // Seat from the backend on mount, and re-seat when the window regains focus: a
  // tunnel can outlive the renderer (a reload, a crash, a previous run of the app),
  // and the routing it owns doesn't care that the UI forgot about it.
  //
  // Also re-seat on a timer, because the traffic goes the other way too: a tunnel
  // can **die** while the window sits focused and untouched, and mount+focus alone
  // never look again — the indicator stayed green over a tunnel that had been dead
  // for minutes. That is not just a stale lamp: `refresh` is what detects the drop
  // and gates the SSH/SFTP probes belonging to the projects riding it (see
  // `stores/remote/vpn/vpnStatus`'s `onTunnelDropped`), so until something reconciles, every
  // one of those probes blocks ~45 s against a peer that will never answer. This
  // indicator is always mounted in the header, so it is the one place that poll is
  // guaranteed to run. It is a local IPC call against an in-memory registry, so a
  // 10 s cadence is cheap.
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const id = window.setInterval(() => void refresh(), 10_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, [refresh, enabled]);

  /**
   * Re-ask the two credential questions for `list`: is the store readable, and can
   * each config connect with no prompt at all?
   *
   * Both are re-asked together because the second is meaningless without the first —
   * a locked store makes every `canConnectVpnSilently` answer `false`, and reading
   * that as "nothing saved" is what the whole locked-keyring path is here to stop. A
   * reading taken while the store *is* readable is also the only trustworthy input to
   * `syncVpnCredentialSaved`, so the reconcile happens here and nowhere else.
   */
  const probeCredentials = useCallback(async (list: StoredVpnConfig[]) => {
    const state = await withTimeout(keyringState(), 4000, "locked" as KeyringState);
    setKeyring(state);
    const checks = await Promise.all(
      list.map(
        async (c) =>
          [c.path, await canConnectVpnSilently(c.path, vpnUsernameFor(c.path))] as const,
      ),
    );
    setSilent(Object.fromEntries(checks));
    if (state === "unlocked") {
      // Only now is a "no" trustworthy: fold it back into the recorded intent so a
      // credential forgotten elsewhere stops claiming to be saved here.
      for (const [config, ok] of checks) void syncVpnCredentialSaved(config, ok).catch(() => {});
    }
  }, []);

  // The stored `.ovpn` list is only needed once the menu is open — and with it, which
  // of those configs could connect with no prompt (the gate on arming auto-connect).
  useEffect(() => {
    if (!open) return;
    setRemoveArm(null);
    let cancelled = false;
    void invoke<StoredVpnConfig[]>("openvpn_list_configs")
      .then(async (list) => {
        const stored = Array.isArray(list) ? list : [];
        if (cancelled) return;
        setConfigs(stored);
        if (!cancelled) await probeCredentials(stored);
      })
      .catch(() => {
        if (!cancelled) setConfigs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, probeCredentials]);

  /**
   * Unlock the OS credential store, then re-probe.
   *
   * This is the one action that turns "it forgot my password" back into "it
   * remembers": the credential was never gone, only unreadable. The dialog it raises
   * is the system's own, and it is only ever reached from a click.
   */
  const unlock = useCallback(async () => {
    setUnlocking(true);
    setError("");
    const ok = await unlockKeyring();
    setUnlocking(false);
    if (!ok) {
      setError(t("vpnIndicator.keyringStayedLocked"));
      setKeyring(await withTimeout(keyringState(), 4000, "locked" as KeyringState));
      return;
    }
    await probeCredentials(configs);
  }, [configs, probeCredentials, t]);

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 250);
  };

  /**
   * Bring a tunnel up from the header, with no project behind it. Takes the silent
   * path only when the backend confirms it would *succeed* silently, and otherwise
   * goes straight to the shared password modal, which owns the retry loop.
   *
   * Asking first is the whole point. `pkexec` authenticates the user before OpenVPN
   * so much as reads the config, so an attempt that was always going to be rejected
   * still costs a system password dialog — and the modal that opens afterwards to
   * collect what was missing costs a second one. That is exactly what this menu used
   * to do to an `auth-user-pass` config with no project behind it: nothing here knew
   * the username, so every connect burned two polkit prompts. Now the backend keeps
   * the username beside the saved password, and `canConnectVpnSilently` says whether
   * the whole set is there — one prompt, one elevation, either way.
   */
  const connect = useCallback(
    async (config: string) => {
      setError("");
      abortedRef.current.delete(config);
      setVpnState(config, "connecting");
      // A project on this config may already know the (non-secret) auth-user-pass
      // username — reuse it rather than making the user retype it. Absent that, the
      // backend falls back to the one saved beside the password.
      const username = vpnUsernameFor(config);
      // Why we are about to ask for a password we were supposed to already have. It
      // travels into the modal, because "it prompted me again anyway" with no reason
      // given is the failure a saved credential exists to prevent.
      let reason = "";

      // Ask the credentials themselves first, and only interpret a **lock** if they say
      // no. A lock is no longer proof that the silent path is dead: the backend keeps a
      // kernel-keyring cache in front of the Secret Service, so a credential read once
      // this boot still answers while the collection is locked. Unlocking up front would
      // therefore put a system password dialog in front of a connect that needed none.
      //
      // Bounded (4s): this read sits *before* the modal, and an unbounded await here is
      // the "amber forever, never asks" trap. If it can't answer in time, treat it as
      // "not silent" and prompt.
      let silent = await withTimeout(canConnectVpnSilently(config, username), 4000, false);
      let store: KeyringState = "unlocked";

      // Only a *failed* check earns the unlock. A locked store is not "nothing saved",
      // so for a config the user asked us to remember this is the one thing that can
      // still rescue the connect before it drops to a prompt the user already dealt
      // with. Only for a remembered config: a system unlock dialog in front of someone
      // who never saved anything would be a prompt for nothing.
      if (!silent) {
        store = await withTimeout(keyringState(), 4000, "locked" as KeyringState);
        if (store === "locked" && isVpnCredentialSaved(config)) {
          if (await unlockKeyring()) {
            store = "unlocked";
            setKeyring("unlocked");
            if (abortedRef.current.has(config)) return;
            silent = await withTimeout(canConnectVpnSilently(config, username), 4000, false);
          } else {
            reason = t("vpnIndicator.keyringLockedConnectReason");
          }
          if (abortedRef.current.has(config)) return;
        }
      }
      if (silent) {
        if (abortedRef.current.has(config)) return;
        try {
          await connectVpnSilently(config, username);
          if (abortedRef.current.has(config)) {
            // Stopped mid-connect, but the silent attempt brought the tunnel up
            // anyway — bring it back down so the machine isn't left rerouted.
            void invoke("openvpn_disconnect", { config }).catch(() => {});
            setVpnState(config, "off");
            return;
          }
          setVpnState(config, "connected");
          return;
        } catch (e) {
          if (abortedRef.current.has(config)) return;
          // Surface *why* the saved-credential connect failed instead of silently
          // dropping to a blank password prompt. The backend reason — a rejected
          // passphrase, a TLS/handshake failure, an unreachable server, an options
          // error — is exactly what the user needs to see, and swallowing it here is
          // what made a failed connect look like "nothing happened, still amber".
          // We still fall through to the prompt (the passphrase may just be stale).
          reason = t("vpnIndicator.savedCredentialsDidntWork", { error: String(e) });
          setError(String(e));
        }
      } else if (!reason) {
        reason =
          store === "unavailable"
            ? t("vpnIndicator.noCredentialStore")
            : t("vpnIndicator.noSavedCredentialsYet");
      }

      // Non-headless: Tabtivity handles no passwords in this mode, so a modal is the
      // wrong ask entirely — the connect command goes to the root terminal and the
      // user authenticates there. (The saved-credential path above still applies:
      // credentials the user explicitly handed over via the save toggle are used, and
      // that is the only way this mode ever connects without a terminal.)
      if (!headless) {
        if (abortedRef.current.has(config)) return;
        try {
          await openVpnLoginInTerminal(config);
          if (abortedRef.current.has(config)) return;
          setError(reason);
        } catch (e) {
          setVpnState(config, "off");
          setError(String(e));
        }
        setOpen(false);
        return;
      }

      try {
        await requestPassword(config, fileOf(config), null, username, { reason });
        // The prompt store marks the tunnel connected on success.
      } catch (e) {
        // A Stop already reset the lamp (and cancelled the prompt); don't fight it.
        if (abortedRef.current.has(config)) return;
        // The user switched this connect to the terminal instead: the tunnel is coming
        // up in a root tab with the lamp already amber and a poll behind it, so this
        // rejection is a handoff, not a failure — clearing the lamp here would blank a
        // login that is still in progress.
        if (isVpnTerminalHandoff(e)) {
          setOpen(false);
          return;
        }
        setVpnState(config, "off");
        // A cancel is not an error worth shouting about; a failure is.
        const msg = String(e);
        if (!/cancel|superseded/i.test(msg)) setError(msg);
      }
    },
    [headless, requestPassword, setOpen, setVpnState, t],
  );

  /**
   * "Save login credentials", per config — the toggle that makes every later connect
   * silent, and the only place a **non-headless** user can hand Tabtivity a VPN secret
   * at all (that mode has no password fields anywhere else, by design).
   *
   * Turning it **on** cannot just flip a flag: there is no secret to save yet, so it
   * opens the password prompt with the save box pre-ticked — the backend writes the
   * credential to the keychain only once the tunnel actually comes up, so a wrong
   * passphrase is never stored. Turning it **off** is an immediate, explicit delete.
   */
  const setSaveCredentials = useCallback(
    async (config: string, save: boolean) => {
      setError("");
      if (!save) {
        await setVpnCredentialSaved(config, false);
        try {
          await invoke("vpn_forget_password", { config });
        } catch (e) {
          setError(String(e));
        }
        setSilent((prev) => ({ ...prev, [config]: false }));
        // A tunnel that can no longer connect without a prompt must not stay armed to
        // connect on launch — auto-connect's promise is that it never prompts.
        if (armed === config && headless) void setVpnAutoConnect(config, false);
        return;
      }
      // Record the intent first: the connect below may be cancelled, but the user has
      // said what they want, and the record is what survives a locked keyring.
      await setVpnCredentialSaved(config, true);
      try {
        await requestPassword(config, fileOf(config), null, vpnUsernameFor(config), {
          remember: true,
          reason: t("vpnIndicator.enterCredentialsOnce"),
        });
      } catch (e) {
        const msg = String(e);
        // A terminal handoff saves nothing either (Tabtivity never sees that password), so
        // it lands in the same place as a cancel: drop the intent, say nothing.
        if (!isVpnTerminalHandoff(e) && !/cancel|superseded/i.test(msg)) setError(msg);
        // Nothing was stored (the backend only saves after a tunnel comes up), so the
        // intent must not outlive the attempt — it would claim a credential exists.
        await setVpnCredentialSaved(config, false);
        return;
      }
      await probeCredentials(configs);
    },
    [armed, configs, headless, probeCredentials, requestPassword, t],
  );

  /**
   * Abort an in-flight connect from the header, restoring normal routing.
   *
   * This is the escape hatch a wedged `connecting` lamp never had: the row's only
   * control used to be "Disconnect tunnel", disabled while connecting, and
   * `vpnStatus.refresh` keeps a `connecting` entry alive indefinitely — so a connect
   * that stalled (a dead handshake, a dismissed prompt, a backend that never
   * answered) parked the lamp amber with no way out. Stop flags the attempt so the
   * in-flight `connect` won't turn the lamp green when it finally settles, cancels an
   * open password prompt for this config, tears down any half-open tunnel, and clears
   * the lamp.
   */
  const stopConnect = useCallback(
    (config: string) => {
      abortedRef.current.add(config);
      const prompt = useVpnPromptStore.getState();
      if (prompt.pending?.config === config) prompt.cancel();
      void invoke("openvpn_disconnect", { config }).catch(() => {});
      setVpnState(config, "off");
      setError("");
    },
    [setVpnState],
  );

  /**
   * Add a config without connecting: browse for a `.ovpn`, copy it into Tabtivity's store
   * (`openvpn_store_config`, the same import the Connect dialog uses), and list it —
   * then the user connects it explicitly from its row, which is the path that shows the
   * password modal. Adding and connecting used to be one button ("Connect…"), which
   * meant a freshly-picked config went straight into a connect attempt: confusing (the
   * file browser *is* the connect) and, if that attempt went silent, it never prompted.
   */
  const browseAndAdd = useCallback(async () => {
    setError("");
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "OpenVPN config", extensions: ["ovpn", "conf"] }],
    }).catch(() => null);
    if (typeof picked !== "string") return;
    let stored: string;
    try {
      stored = await invoke<string>("openvpn_store_config", { config: picked });
    } catch (e) {
      setError(String(e));
      return;
    }
    setConfigs((prev) =>
      prev.some((c) => c.path === stored)
        ? prev
        : [...prev, { path: stored, name: fileOf(stored) }],
    );
  }, []);

  /**
   * Remove a stored config: delete Tabtivity's copy and forget its saved
   * credentials (the backend does both, in that order — a refused removal
   * leaves the credentials alone). Only offered on idle rows; a live tunnel's
   * config can't be removed, only disconnected first. A removed config can't
   * stay armed to connect on launch — an armed path with no file behind it
   * would silently fail at every startup.
   */
  const remove = useCallback(
    async (config: string) => {
      setError("");
      // Update the UI *first*. `openvpn_remove_config` forgets the saved password and
      // username too (a `spawn_blocking` keychain write over D-Bus), which can take a
      // beat — awaiting it before touching the list made the click look dead until the
      // menu was reopened. Drop the row and disarm now; restore it only if the backend
      // actually refuses. The backend deletes the config file *and* the credentials.
      const removed = configs.find((c) => c.path === config);
      setConfigs((prev) => prev.filter((c) => c.path !== config));
      setRemoveArm(null);
      if (armed === config) void setVpnAutoConnect(config, false);
      // The credentials go with the config (the backend forgets them), so the record
      // that says they exist has to go too — a leftover would keep claiming a saved
      // credential for a config that no longer exists, and offer to unlock for it.
      void setVpnCredentialSaved(config, false);
      try {
        await invoke("openvpn_remove_config", { config });
      } catch (e) {
        setError(String(e));
        if (removed) setConfigs((prev) => (prev.some((c) => c.path === config) ? prev : [...prev, removed]));
      }
    },
    [armed, configs],
  );

  const live = Object.entries(byConfig).filter(
    ([, state]) => state === "connected" || state === "connecting",
  );
  const connecting = live.some(([, state]) => state === "connecting");
  const lamp: "off" | "connecting" | "connected" = !anyVpnLive(byConfig)
    ? "off"
    : connecting
      ? "connecting"
      : "connected";
  // Mid-connect is the one VPN state worth turning a collapsed header's summary
  // lamp amber for: it is transient, it is what a user is waiting on, and it is
  // where a failure shows up. A tunnel that is simply *up* reports `ok` — the
  // summary lamp goes green for it, and its own line rides the tooltip.
  useHeaderStatusReport(
    "vpn",
    !enabled
      ? null
      : {
          tone: lamp === "connecting" ? "attention" : lamp === "connected" ? "ok" : "off",
          label: `OpenVPN: ${lamp}`,
        },
  );

  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  // Configs that are up are listed as tunnels above; don't offer them again below.
  const idle = configs.filter((c) => !(c.path in byConfig));

  /**
   * "Connect on launch", per config. Offered only when the promise can be kept — the
   * connect would raise no prompt (headless: every credential saved) or raises no
   * *modal* by design (non-headless: it opens in the root terminal, where the user
   * types the password anyway). An armed-but-no-longer-eligible config can still be
   * switched off, or a stale opt-in would be unreachable.
   *
   * Arming is exclusive by construction: one config is stored, so turning this on for
   * a second tunnel turns it off for the first. That is not a limitation to work
   * around — two tunnels would be two claims on one machine's routing.
   */
  const autoConnectRow = (config: string) => {
    const on = armed === config;
    const saved = savedConfigs.includes(config);
    // A locked store makes `silent` read false for every config, so without the
    // recorded intent an armed tunnel would look ineligible and offer to disarm
    // itself after every restart. The credential is there; it is just unreadable.
    const promptless = silent[config] === true || (keyring === "locked" && saved);
    const eligible = !headless || promptless;
    return (
      <>
        <label className="vpn-indicator-auto">
          <Toggle
            size="sm"
            checked={saved}
            disabled={keyring === "unavailable"}
            onChange={(e) => void setSaveCredentials(config, e.target.checked)}
            aria-label={t("vpnIndicator.saveCredentialsAria", { file: fileOf(config) })}
            title={
              keyring === "unavailable"
                ? t("vpnIndicator.saveCredsUnavailableTitle")
                : saved
                  ? t("vpnIndicator.saveCredsSavedTitle")
                  : t("vpnIndicator.saveCredsNotSavedTitle")
            }
          />
          <span>
            {t("vpnIndicator.saveLoginCredentialsLabel")} <UntestedTag id="vpnIndicator.saveLoginCredentialsLabel" />
          </span>
        </label>
        {saved && keyring === "locked" && (
          <div className="vpn-indicator-hint">
            {t("vpnIndicator.savedButLocked")}
          </div>
        )}
        <label className="vpn-indicator-auto">
          <Toggle
            size="sm"
            checked={on}
            disabled={!eligible && !on}
            onChange={(e) => void setVpnAutoConnect(config, e.target.checked)}
            aria-label={t("vpnIndicator.connectOnLaunchAria", { file: fileOf(config) })}
            title={
              headless
                ? t("vpnIndicator.connectOnLaunchHeadlessTitle")
                : t("vpnIndicator.connectOnLaunchInteractiveTitle")
            }
          />
          <span>{t("vpnIndicator.connectOnLaunchLabel")}</span>
        </label>
        {!eligible && !on && (
          <div className="vpn-indicator-hint">
            {t("vpnIndicator.needSaveCredsFirstHintPre")} <b>{t("vpnIndicator.saveLoginCredentialsLabel")}</b> {t("vpnIndicator.needSaveCredsFirstHintPost")}
          </div>
        )}
        {on && armed !== null && (
          <div className="vpn-indicator-hint">
            {t("vpnIndicator.startsWithApp")}{headless ? "" : t("vpnIndicator.waitsInRootTerminal")}.
          </div>
        )}
      </>
    );
  };

  if (!enabled) return null;

  return (
    <div className="global-apps-menu header-status-menu-anchor no-drag" onMouseEnter={reveal} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="global-apps-menu-btn vpn-indicator-btn"
        aria-label={t("vpnIndicator.mainAriaLabel")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          lamp === "off"
            ? t("vpnIndicator.titleOff")
            : lamp === "connecting"
              ? t("vpnIndicator.titleConnecting")
              : t("vpnIndicator.titleConnected")
        }
        // Hover-opened, like its sibling header menus (SettingsMenu,
        // LocalModelMenu). Click focuses rather than toggling: a click also fires
        // mouseenter, so a toggle here would open on enter and immediately shut.
        onClick={reveal}
        onFocus={reveal}
      >
        <ConnLamp status={lamp} label="OpenVPN" />
        <VpnGlyph className="header-status-glyph" />
      </button>
      {open && (
        <div className="tab-new-menu vpn-indicator-menu" role="menu">
          {/* Pinned title; the region below it scrolls so the scrollbar starts
              beneath the header (unified `.menu-scroll-region` shape). The × mirrors
              the other menus — a hover menu can be surprisingly hard to dismiss on
              purpose (moving to a control re-reveals it), so an explicit close helps. */}
          <div className="tab-new-menu-group-label vpn-indicator-title">
            <span>OpenVPN</span>
            <button
              type="button"
              className="vpn-indicator-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="menu-scroll-region">
          <div className="vpn-indicator-note">
            {t("vpnIndicator.note")} <strong>{t("vpnIndicator.noteStrong")}</strong>{" "}
            {t("vpnIndicator.notePost")}
          </div>

          {/* The locked-keyring banner. It is the difference between "Tabtivity forgot my
              password" and "your keyring is locked": a locked Secret Service answers
              every read as though nothing were saved, so without saying so the app
              silently un-remembers every credential on each restart. Only shown when
              something is actually behind the lock — otherwise it is noise. */}
          {keyring === "locked" && savedConfigs.length > 0 && (
            <div className="vpn-indicator-locked" role="status">
              <div>
                {t("vpnIndicator.lockedBannerPre")} <strong>{t("vpnIndicator.lockedBannerStrong")}</strong>
                {t("vpnIndicator.lockedBannerPost")}
              </div>
              <button
                type="button"
                className="vpn-indicator-connect"
                disabled={unlocking}
                title={t("vpnIndicator.unlockTitle")}
                onClick={() => void unlock()}
              >
                {unlocking ? t("vpnIndicator.unlocking") : t("vpnIndicator.unlockKeyring")} <UntestedTag id="vpnIndicator.unlockKeyring" />
              </button>
            </div>
          )}

          {live.map(([config, state]) => {
            const held = holders[config] ?? [];
            return (
              <div key={config} className="vpn-indicator-row">
                <div className="vpn-indicator-head">
                  <ConnLamp status={state} label={`OpenVPN · ${fileOf(config)}`} />
                  <span className="vpn-indicator-config" title={config}>
                    {fileOf(config)}
                  </span>
                </div>
                {held.length > 0 && (
                  <div className="vpn-indicator-holders">
                    {`${t("vpnIndicator.heldForPrefix")} ${held.map(nameOf).join(", ")}`}
                  </div>
                )}
                {state === "connecting" ? (
                  <button
                    type="button"
                    className="vpn-indicator-disconnect"
                    title={t("vpnIndicator.stopConnectingTitle")}
                    onClick={() => stopConnect(config)}
                  >
                    {t("vpnIndicator.stopConnecting")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="vpn-indicator-disconnect"
                    title={t("vpnIndicator.disconnectTunnelTitle")}
                    onClick={() => {
                      disconnectVpnTunnel(config);
                      setOpen(false);
                    }}
                  >
                    {t("vpnIndicator.disconnectTunnel")}
                  </button>
                )}
                {autoConnectRow(config)}
              </div>
            );
          })}

          {idle.length > 0 && (
            <>
              <div className="tab-new-menu-group-label">{t("vpnIndicator.connectGroupLabel")}</div>
              {idle.map((c) => {
                const usedBy = projects
                  .filter((p) => p.remote?.openvpn?.config === c.path)
                  .map((p) => p.name);
                return (
                  <div key={c.path} className="vpn-indicator-row">
                    <div className="vpn-indicator-head">
                      <ConnLamp status="off" label={`OpenVPN · ${c.name}`} />
                      <span className="vpn-indicator-config" title={c.path}>
                        {c.name}
                      </span>
                    </div>
                    {removeArm === c.path ? (
                      // Armed remove: the second click is destructive (the saved
                      // credentials go with the config and can't be re-browsed
                      // back), so it is spelled out and separately cancellable.
                      <>
                        <div className="vpn-indicator-hint">
                          {t("vpnIndicator.removeConfigHint")}
                          {usedBy.length > 0 && (
                            <>
                              {" "}
                              {t("vpnIndicator.usedByPre")} <b>{usedBy.join(", ")}</b>{" "}
                              {t("vpnIndicator.usedByPost")}
                            </>
                          )}
                        </div>
                        <div className="vpn-indicator-actions">
                          <button
                            type="button"
                            className="vpn-indicator-remove"
                            onClick={() => void remove(c.path)}
                          >
                            {t("vpnIndicator.removeConfigBtn")}
                          </button>
                          <button
                            type="button"
                            className="vpn-indicator-connect"
                            onClick={() => setRemoveArm(null)}
                          >
                            {t("vpnIndicator.keepBtn")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="vpn-indicator-actions">
                        <button
                          type="button"
                          className="vpn-indicator-connect"
                          title={t("vpnIndicator.connectTunnelTitle")}
                          onClick={() => void connect(c.path)}
                        >
                          {t("common.connect")}
                        </button>
                        <button
                          type="button"
                          className="vpn-indicator-remove"
                          title={t("vpnIndicator.removeConfigTitle")}
                          onClick={() => setRemoveArm(c.path)}
                        >
                          {t("remoteMachines.remove")}
                        </button>
                      </div>
                    )}
                    {autoConnectRow(c.path)}
                  </div>
                );
              })}
            </>
          )}

          {live.length === 0 && idle.length === 0 ? (
            <div className="vpn-indicator-row">
              <div className="vpn-indicator-empty">
                {t("vpnIndicator.emptyStatePre")} <code>.ovpn</code> {t("vpnIndicator.emptyStatePost")}
              </div>
              <button
                type="button"
                className="vpn-indicator-connect"
                title={t("vpnIndicator.addFirstConfigTitle")}
                onClick={() => void browseAndAdd()}
              >
                {t("vpnIndicator.addConfigBtn")}
              </button>
            </div>
          ) : (
            // Configs already exist, but you may want to add another. Adding only
            // stores it and lists it; connecting (with its password prompt) is an
            // explicit click on the row. A cancelled browse changes nothing.
            <div className="vpn-indicator-row vpn-indicator-browse">
              <button
                type="button"
                className="vpn-indicator-connect"
                title={t("vpnIndicator.addAnotherConfigTitle")}
                onClick={() => void browseAndAdd()}
              >
                {t("vpnIndicator.addConfigBtn")}
              </button>
            </div>
          )}
          {error && <ErrorNote className="vpn-indicator-error" error={error} />}
          </div>
        </div>
      )}
    </div>
  );
}
