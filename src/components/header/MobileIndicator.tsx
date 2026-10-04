import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { MobileSetupGuide } from "../mobile/MobileSetupGuide";
import { PairedDeviceDialog } from "../mobile/PairedDeviceDialog";
import { useSettingsStore } from "../../stores/settings";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useHeaderStatusReport } from "../../stores/headerStatus";
import { translate, useI18nStore, useT } from "../../lib/i18n";
import { ErrorNote } from "../common/ErrorNote";
import { MOBILE_HOST_KEY } from "../../lib/brand";
import { UntestedTag } from "../common/UntestedTag";

/** `translate` at the live language, for the async callbacks below (component
 *  `t` inside them would churn their identity on a language switch). */
function tr(
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
): string {
  return translate(useI18nStore.getState().lang, key, params);
}

const MENU_ID = "mobile";
const POLL_MS = 15_000;
/** How often the open menu re-reads the device list: a phone signing in or
 * locking should show while somebody is looking at the list. One admin-socket
 * call, and only while the menu is open. */
const DEVICES_POLL_MS = 5_000;
// `systemctl --user restart` acknowledges the job before the replacement
// sidecar has necessarily rebound its admin socket. A short bounded wait keeps
// that expected hand-off from being rendered as a failed reconnect.
const RECONNECT_READY_ATTEMPTS = 20;
const RECONNECT_RETRY_MS = 250;

interface RuntimeStatus {
  configured: boolean;
  running: boolean;
  port?: number;
  origin?: string;
  error?: string;
  installed_version?: string;
  update_available: boolean;
}

interface AdminResponse {
  status: string;
  code?: string;
  expires_at?: number;
  message?: string;
}

/** A paired device as the sidecar's admin socket lists it. `online` is absent
 * from a sidecar older than this window. */
interface PairedDevice {
  id: string;
  name: string;
  created_at: number;
  last_seen_at?: number | null;
  online?: boolean;
}

const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

type StatusTone = "connected" | "connecting" | "off" | "error";

function statusTone(status: RuntimeStatus | null, refreshing: boolean): StatusTone {
  if (refreshing) return "connecting";
  if (status?.running) return "connected";
  return status?.error ? "error" : "off";
}

function MobileIcon({ tone }: { tone: StatusTone }) {
  return (
    <svg
      className={`mobile-indicator-icon ${tone}`}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="4.1" y="1.5" width="7.8" height="13" rx="1.6" stroke="currentColor" strokeWidth="1.15" />
      <path d="M6.7 3.6H9.3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <circle cx="8" cy="12.3" r="0.7" fill="currentColor" />
      <circle className="mobile-indicator-icon-dot" cx="12.6" cy="3.4" r="2.25" fill="currentColor" />
    </svg>
  );
}

/**
 * Tabtivity Mobile is a machine-wide companion host, so its status belongs beside
 * the battery and VPN controls rather than in a project pill. The sidecar is
 * the authority: a green phone means its authenticated admin socket replied,
 * not merely that the setting says it ought to be running.
 *
 * The icon is also there *before* Mobile is set up — dimmed, with no status to
 * poll — and clicking it opens `MobileSetupGuide`. A feature nobody has turned
 * on is a feature nobody goes hunting for in the settings scroll, so the phone
 * icon is the door to it; "Show Mobile connection in header" still hides the
 * widget outright for anyone who wants neither.
 */
export function MobileIndicator() {
  const t = useT();
  const mobileHost = useSettingsStore((s) => s.settings?.[MOBILE_HOST_KEY]);
  const mobileEnabled = useSettingsStore((s) => s.settings?.[MOBILE_HOST_KEY]?.enabled ?? false);
  const visible = useSettingsStore((s) => s.settings?.mobile_indicator ?? true);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const open = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [restarting, setRestarting] = useState<"reconnect" | "update" | null>(null);
  const [pairing, setPairing] = useState(false);
  // The code is only good for `PAIR_TTL` (five minutes), so it is held with its
  // own expiry and dropped when that passes: a code still on screen after it
  // stopped working is worse than no code at all.
  const [pairCode, setPairCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [lockingDown, setLockingDown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  /** The paired phone whose own access (sections, projects) is open in
   *  `PairedDeviceDialog` — the same block as under its Settings row. */
  const [accessFor, setAccessFor] = useState<string | null>(null);
  const closeAccess = useCallback(() => setAccessFor(null), []);
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  /** The device whose Disconnect was clicked once and now asks again. */
  const [armed, setArmed] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const lang = useI18nStore((s) => s.lang);
  const closeTimer = useRef<number | undefined>(undefined);
  const statusRequest = useRef(0);
  const reconnectingRef = useRef(false);

  const refresh = useCallback(async (waitForHost = false) => {
    if (!waitForHost && reconnectingRef.current) return;
    const request = ++statusRequest.current;
    setRefreshing(true);
    setError(null);
    try {
      let next: RuntimeStatus | null = null;
      for (let attempt = 0; attempt < (waitForHost ? RECONNECT_READY_ATTEMPTS : 1); attempt += 1) {
        next = await invoke<RuntimeStatus>("mobile_host_status");
        if (next.running || !waitForHost || attempt === RECONNECT_READY_ATTEMPTS - 1) break;
        await pause(RECONNECT_RETRY_MS);
      }
      if (request === statusRequest.current) setStatus(next);
    } catch (reason) {
      if (request === statusRequest.current) {
        setStatus(null);
        setError(String(reason));
      }
    } finally {
      if (request === statusRequest.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!mobileEnabled || !visible) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [mobileEnabled, visible, refresh]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!mobileEnabled || !visible) closeMenu(MENU_ID);
  }, [mobileEnabled, visible, closeMenu]);

  useEffect(() => {
    if (!pairCode) return;
    const remaining = pairCode.expiresAt * 1000 - Date.now();
    if (remaining <= 0) {
      setPairCode(null);
      return;
    }
    const timer = window.setTimeout(() => setPairCode(null), remaining);
    return () => window.clearTimeout(timer);
  }, [pairCode]);

  const running = status?.running ?? false;
  const loadDevices = useCallback(async () => {
    try {
      const response = await invoke<{ status: string; devices?: PairedDevice[]; message?: string }>(
        "mobile_admin",
        { request: { type: "devices" } },
      );
      if (response.status !== "devices") throw new Error(response.message ?? response.status);
      setDevices(response.devices ?? []);
    } catch {
      // The host's own status line already says why it cannot be asked.
      setDevices(null);
    }
  }, []);

  useEffect(() => {
    if (!open || !running) return;
    void loadDevices();
    const interval = window.setInterval(() => void loadDevices(), DEVICES_POLL_MS);
    return () => window.clearInterval(interval);
  }, [open, running, loadDevices]);

  // A half-made Disconnect is forgotten when the menu closes.
  useEffect(() => {
    if (!open) setArmed(null);
  }, [open]);

  const disconnect = async (device: PairedDevice) => {
    setArmed(null);
    setDisconnecting(device.id);
    setError(null);
    try {
      const response = await invoke<AdminResponse>("mobile_admin", { request: { type: "revoke", device_id: device.id } });
      if (response.status === "error") throw new Error(response.message);
    } catch (reason) {
      setError(tr("mobile.indDisconnectError", { name: device.name, reason: String(reason) }));
    } finally {
      setDisconnecting(null);
      await loadDevices();
    }
  };

  const deviceCaption = (device: PairedDevice) =>
    device.online
      ? t("mobile.indDeviceOnline")
      : device.last_seen_at
        ? t("mobile.indDeviceLastSeen", {
          when: new Date(device.last_seen_at * 1000).toLocaleString(lang, { dateStyle: "short", timeStyle: "short" }),
        })
        : t("mobile.indDeviceNeverSeen");

  const reveal = () => openMenu(MENU_ID);
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => closeMenu(MENU_ID), 250);
  };

  // Reconnect and Update are one step: reinstall the sidecar from this window's
  // image and restart it. Tabtivity Mobile is a PWA embedded in that sidecar, so
  // the phone then picks up fresh assets through its service-worker update
  // path. Update is offered only while the installed host is behind this
  // window (`update_available`, the same test as Settings' "Update mobile
  // host"); Tabtivity's own start already replaces an older host.
  const restartHost = async (kind: "reconnect" | "update") => {
    // Ignore an earlier focus/interval probe while restart replaces the socket.
    // Without this generation bump, that old `ECONNREFUSED` can land after the
    // successful probe below and repaint the menu red.
    reconnectingRef.current = true;
    statusRequest.current += 1;
    setRestarting(kind);
    setError(null);
    setUpdateNotice(null);
    try {
      await invoke("mobile_host_apply", { enabled: true });
      await refresh(true);
      if (kind === "update") setUpdateNotice(tr("mobile.indUpdateReady"));
    } catch (reason) {
      setError(kind === "update" ? tr("mobile.indUpdateError", { reason: String(reason) }) : String(reason));
    } finally {
      reconnectingRef.current = false;
      setRestarting(null);
    }
  };

  const createPairingCode = async () => {
    // Pairing is the sidecar's own business, so the running host is asked again
    // here rather than trusted from the last poll: the button is enabled off a
    // status that may be up to POLL_MS old.
    setPairing(true);
    setError(null);
    setPairCode(null);
    try {
      const current = await invoke<RuntimeStatus>("mobile_host_status");
      setStatus(current);
      if (!current.running) throw new Error(tr("mobile.errStartHostFirst"));
      const response = await invoke<AdminResponse>("mobile_admin", { request: { type: "pairing_code" } });
      if (response.status !== "pairing_code" || !response.code) {
        throw new Error(response.message ?? tr("mobile.errPairingUnavailable"));
      }
      setPairCode({ code: response.code, expiresAt: response.expires_at ?? Math.floor(Date.now() / 1000) + 300 });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPairing(false);
    }
  };

  const lockDownNow = async () => {
    if (!mobileHost) return;
    if (!window.confirm(tr("mobile.lockdownConfirm"))) return;
    setLockingDown(true);
    setError(null);
    try {
      const response = await invoke<{ status: string; message?: string }>("mobile_admin", { request: { type: "forget_all" } });
      if (response.status === "error") throw new Error(response.message ?? tr("mobile.indRevokeError"));
      await updateSettings({ [MOBILE_HOST_KEY]: { ...mobileHost, enabled: false } });
      await invoke("mobile_host_apply", { enabled: false });
      setPairCode(null);
      closeMenu(MENU_ID);
    } catch (reason) {
      setError(tr("mobile.lockdownPartial", { reason: String(reason) }));
    } finally {
      setLockingDown(false);
    }
  };

  // Above the early return, because the header's status cluster has to be told
  // this widget renders nothing (a hook cannot hide behind a `return null`, and
  // an unreported member is silently not counted rather than folded).
  const busy = refreshing || restarting !== null || pairing || lockingDown;
  const tone = statusTone(status, refreshing || restarting !== null);
  const title = tone === "connected"
    ? t("mobile.indConnectedTitle")
    : tone === "connecting"
      ? t("mobile.indCheckingTitle")
      : tone === "error"
        ? t("mobile.indErrorTitle")
        : t("mobile.indStoppedTitle");

  // "Checking" is every poll of an ordinary healthy host, so only a real error
  // reddens a collapsed header's summary lamp. Not set up is `off`: present,
  // dormant, and never a colour on that lamp.
  useHeaderStatusReport(
    "mobile",
    !visible
      ? null
      : !mobileEnabled
        ? { tone: "off", label: t("mobile.indSetUpTitle") }
        : { tone: tone === "error" ? "alert" : tone === "connected" ? "ok" : "off", label: title },
  );

  if (!visible) return null;

  // Rendered from both branches so switching Mobile on from inside the guide
  // cannot yank the guide out from under the click that did it.
  const setupGuide = showSetup
    ? createPortal(<MobileSetupGuide onClose={() => setShowSetup(false)} />, document.body)
    : null;

  if (!mobileEnabled) {
    return (
      <div className="global-apps-menu header-status-menu-anchor no-drag">
        <button
          type="button"
          className="global-apps-menu-btn mobile-indicator-btn"
          aria-label={t("mobile.indSetUpTitle")}
          title={t("mobile.indSetUpTitle")}
          onClick={() => setShowSetup(true)}
        >
          <MobileIcon tone="off" />
        </button>
        {setupGuide}
      </div>
    );
  }

  return (
    <div
      className="global-apps-menu header-status-menu-anchor no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn mobile-indicator-btn"
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={reveal}
        onFocus={reveal}
      >
        <MobileIcon tone={tone} />
      </button>
      {open && (
        <div className="tab-new-menu mobile-indicator-menu" role="menu">
          <div className="tab-new-menu-group-label vpn-indicator-title">
            <span>{t("mobile.title")}</span>
            <button
              type="button"
              className="vpn-indicator-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={() => closeMenu(MENU_ID)}
            >
              ×
            </button>
          </div>
          <div className="mobile-indicator-body">
            <div className="mobile-indicator-status" aria-live="polite">
              <MobileIcon tone={tone} />
              <div>
                <strong>
                  {tone === "connected" ? t("mobile.indConnected") : tone === "connecting" ? t("mobile.indChecking") : t("mobile.indDisconnected")}
                </strong>
                <span>
                  {tone === "connecting"
                    ? t("mobile.indStarting")
                    : status?.running
                    ? t("mobile.indListening", { port: status.port ?? "?" })
                    : status?.error ?? t("mobile.indNotRunning")}
                </span>
              </div>
            </div>
            {status?.origin && <div className="mobile-indicator-origin">{status.origin}</div>}
            {error && <ErrorNote className="mobile-indicator-error" error={error} />}
            {updateNotice && <div className="mobile-indicator-notice" role="status">{updateNotice}</div>}
            {pairCode && (
              <div className="mobile-indicator-paircode" role="status">
                <code>{pairCode.code}</code>
                <span>{t("mobile.pairCodeValidity")}</span>
              </div>
            )}
            {running && devices && (
              <div className="mobile-indicator-devices">
                <div className="mobile-indicator-devices-label">
                  {t("mobile.pairedDevices")} <UntestedTag id="mobile.indDevices" />
                </div>
                {devices.length === 0 && <span className="mobile-indicator-devices-empty">{t("mobile.indDevicesNone")}</span>}
                {[...devices]
                  .sort((a, b) => Number(b.online ?? false) - Number(a.online ?? false))
                  .map((device) => (
                    <div key={device.id} className="mobile-indicator-device">
                      <span className={"mobile-indicator-device-lamp" + (device.online ? " online" : "")} aria-hidden="true" />
                      <span className="mobile-indicator-device-text">
                        <strong>{device.name}</strong>
                        <span>{deviceCaption(device)}</span>
                      </span>
                      <button
                        type="button"
                        className="inbox-menu-delete mobile-indicator-device-access"
                        title={t("mobile.indDeviceAccessHint", { name: device.name })}
                        aria-label={`${t("mobile.indDeviceAccess")} ${device.name}`}
                        onClick={() => {
                          closeMenu(MENU_ID);
                          setAccessFor(device.id);
                        }}
                      >
                        {t("mobile.indDeviceAccess")} <UntestedTag id="mobile.indDeviceAccess" />
                      </button>
                      <button
                        type="button"
                        className={"inbox-menu-delete mobile-indicator-device-disconnect" + (armed === device.id ? " armed" : "")}
                        title={t("mobile.indDisconnectHint")}
                        aria-label={`${t("mobile.indDisconnect")} ${device.name}`}
                        disabled={disconnecting !== null || lockingDown}
                        onClick={() => (armed === device.id ? void disconnect(device) : setArmed(device.id))}
                      >
                        {armed === device.id ? t("mobile.indDisconnectConfirm") : t("mobile.indDisconnect")}
                      </button>
                    </div>
                  ))}
              </div>
            )}
            <div className="mobile-indicator-actions">
              <button type="button" className="vpn-indicator-connect" disabled={busy} onClick={() => void restartHost("reconnect")}>
                {restarting === "reconnect" ? t("mobile.indReconnecting") : t("mobile.indReconnect")}
              </button>
              <button type="button" className="vpn-indicator-connect" disabled={busy || !status?.running} onClick={() => void createPairingCode()}>
                {pairing ? t("mobile.creatingCode") : t("mobile.newPairingCode")}
              </button>
              {(status?.update_available || restarting === "update") && (
                <button
                  type="button"
                  className="vpn-indicator-connect"
                  disabled={busy}
                  onClick={() => void restartHost("update")}
                >
                  {restarting === "update" ? t("mobile.indUpdating") : t("mobile.indUpdate")}
                </button>
              )}
              <button type="button" className="vpn-indicator-connect mobile-indicator-lockdown" disabled={busy || !status?.running} onClick={() => void lockDownNow()}>
                {lockingDown ? t("mobile.indLocking") : t("mobile.indLock")}
              </button>
            </div>
          </div>
        </div>
      )}
      {setupGuide}
      {accessFor && createPortal(<PairedDeviceDialog deviceId={accessFor} onClose={closeAccess} />, document.body)}
    </div>
  );
}
