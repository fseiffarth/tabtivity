import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { SettingsCard, SettingsList, ToggleRow } from "../layout/settingsUi";
import { UntestedTag } from "../common/UntestedTag";
import { IS_WINDOWS } from "../../lib/platform";
import { runInstallInTab } from "../../lib/installCommand";
import { translate, useI18nStore, useT } from "../../lib/i18n";
import { ErrorNote } from "../common/ErrorNote";
import { MOBILE_ACCESS_KEY, MOBILE_DEVICES_KEY, MOBILE_HOST_KEY } from "../../lib/brand";
import { MobileAccessPicker, phoneReachLabel } from "./MobileAccessPicker";
import { phoneReach, usePairedPhones, type PairedPhone } from "./usePairedPhones";

/** `translate` at the live language, for code that runs outside a render: the
 *  module-level parser below and the async callbacks, whose `useCallback`
 *  identity must not churn on a language switch (their effect re-invokes). */
function tr(
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
): string {
  return translate(useI18nStore.getState().lang, key, params);
}

interface RuntimeStatus {
  configured: boolean;
  running: boolean;
  port?: number;
  origin?: string;
  error?: string;
  installed_version?: string;
  update_available: boolean;
}
interface ServeStatus {
  installed: boolean;
  error?: string;
  json?: unknown;
  detected?: {
    display_name: string;
    port: number;
    origin: string;
  };
  detection_error?: string;
}
interface ServeVerification {
  verified: boolean;
  error?: string;
}
type Device = PairedPhone;
type AdminResponse =
  | { status: "pairing_code"; code: string; expires_at: number }
  | { status: "devices"; devices: Device[] }
  | { status: "ok" }
  | { status: "error"; message: string };

interface DetectedServeSettings {
  display_name: string;
  port: number;
  origin: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// Compatibility for a live backend built before it returned `detected`. The
// result is still passed through mobile_verify_tailscale_serve before use, so
// this parser cannot weaken the backend's exact-origin/Funnel checks.
function detectServeSettingsFromJson(value: unknown): DetectedServeSettings {
  const status = record(value);
  const web = record(status?.Web);
  const tcp = record(status?.TCP);
  const funnel = record(status?.AllowFunnel);
  const candidates: DetectedServeSettings[] = [];

  for (const [authority, rawServer] of Object.entries(web ?? {})) {
    const server = record(rawServer);
    const handlers = record(server?.Handlers);
    const root = record(handlers?.["/"]);
    if (typeof root?.Proxy !== "string") continue;
    try {
      const target = new URL(root.Proxy);
      const publicUrl = new URL(`https://${authority}`);
      const port = Number(target.port);
      const publicPort = publicUrl.port || "443";
      const listener = record(tcp?.[publicPort]);
      if (
        target.protocol !== "http:"
        || target.hostname !== "127.0.0.1"
        || target.username !== ""
        || target.password !== ""
        || target.pathname !== "/"
        || target.search !== ""
        || target.hash !== ""
        || !Number.isInteger(port)
        || port < 1024
        || port > 65535
        || listener?.HTTPS !== true
        || funnel?.[authority] === true
      ) continue;
      const displayName = publicUrl.hostname.split(".")[0];
      if (!displayName || displayName.length > 64) continue;
      candidates.push({
        display_name: displayName,
        port,
        origin: publicUrl.origin,
      });
    } catch {
      // Ignore malformed/non-URL handlers; they are not eligible mappings.
    }
  }

  const unique = [...new Map(candidates.map((candidate) => [
    `${candidate.origin}\0${candidate.port}`,
    candidate,
  ])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.length === 0) {
    throw new Error(tr("mobile.errNoServeMapping"));
  }
  throw new Error(tr("mobile.errMultiServeMappings"));
}

export function MobileSettings() {
  const t = useT();
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const projects = useProjectsStore((state) => state.projects);
  const boxes = useBoxesStore((state) => state.boxes);
  const setBoxMobileAccess = useBoxesStore((state) => state.setBoxMobileAccess);
  const rootDir = useProjectsStore((state) => state.rootDir);
  const setProjectMobileAccess = useProjectsStore((state) => state.setProjectMobileAccess);
  const stored = settings?.[MOBILE_HOST_KEY];
  // The sidecar's `discovery::root_open`, repeated so the switch can say why
  // root is missing from the phone while it is on.
  const [reviewEnforced, setReviewEnforced] = useState(true);
  const rootSwitchedOn = stored?.root_access === true;
  useEffect(() => {
    if (!rootSwitchedOn) return;
    let live = true;
    void invoke<{ review_enforced?: boolean }>("root_mcp_status")
      .then((status) => { if (live) setReviewEnforced(status.review_enforced === true); })
      .catch(() => {});
    return () => { live = false; };
  }, [rootSwitchedOn]);
  const rootReview = settings?.root_mcp_review;
  const rootGateClosed = settings?.root_mcp !== false
    && (rootReview === "destructive" || rootReview === "off" || !reviewEnforced);
  const [displayName, setDisplayName] = useState(stored?.display_name ?? "Workstation");
  const [port, setPort] = useState(String(stored?.port ?? 8742));
  const [origin, setOrigin] = useState(stored?.serve_origin ?? "");
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [serveStatus, setServeStatus] = useState<ServeStatus | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  // The paired phones off the device file (host up or down), for the access
  // rows' "N phones" counts; re-read whenever the list below is refreshed
  // (a revoke or Forget all changes what a list still reaches).
  const { phones: pairedPhones } = usePairedPhones(devices);
  const [phonePicker, setPhonePicker] = useState<
    { kind: "project" | "box"; id: string; x: number; y: number } | null
  >(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [detectingServe, setDetectingServe] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [serveVerification, setServeVerification] = useState<ServeVerification | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const initialFieldsHydrated = useRef(false);
  const refreshSequence = useRef(0);
  const originRef = useRef(origin);
  const portRef = useRef(port);
  originRef.current = origin;
  portRef.current = port;
  const parsedGuidePort = Number(port);
  const guidePort = Number.isInteger(parsedGuidePort) && parsedGuidePort >= 1024 && parsedGuidePort <= 65535
    ? parsedGuidePort
    : 8742;

  useEffect(() => {
    if (!settings || initialFieldsHydrated.current) return;
    initialFieldsHydrated.current = true;
    const hydratedPort = String(stored?.port ?? 8742);
    const hydratedOrigin = stored?.serve_origin ?? "";
    setDisplayName(stored?.display_name ?? "Workstation");
    setPort(hydratedPort);
    setOrigin(hydratedOrigin);
    // The initial refresh effect runs in the same commit. Update its refs now,
    // before React schedules the state-driven render, so it verifies the saved
    // values instead of the empty pre-settings form defaults.
    portRef.current = hydratedPort;
    originRef.current = hydratedOrigin;
  }, [settings, stored?.display_name, stored?.port, stored?.serve_origin]);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setRefreshing(true);
    setRefreshError(null);

    const [runtimeResult, serveResult, devicesResult] = await Promise.allSettled([
      invoke<RuntimeStatus>("mobile_host_status"),
      invoke<ServeStatus>("mobile_tailscale_serve_status"),
      invoke<AdminResponse>("mobile_admin", { request: { type: "devices" } }),
    ]);
    if (sequence !== refreshSequence.current) return;

    const nextStatus = runtimeResult.status === "fulfilled" ? runtimeResult.value : null;
    const nextServeStatus = serveResult.status === "fulfilled" ? serveResult.value : null;
    setStatus(nextStatus);
    setServeStatus(nextServeStatus);
    setDevices(
      devicesResult.status === "fulfilled" && devicesResult.value.status === "devices"
        ? devicesResult.value.devices
        : [],
    );

    const failures: string[] = [];
    const statusReasons = [runtimeResult, serveResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => String(result.reason));
    if (statusReasons.some((reason) => /command .* not found/i.test(reason))) {
      failures.push(tr("mobile.errBackendOld"));
    } else {
      if (runtimeResult.status === "rejected") failures.push(tr("mobile.errHostStatus", { reason: String(runtimeResult.reason) }));
      if (serveResult.status === "rejected") failures.push(tr("mobile.errTailscaleStatus", { reason: String(serveResult.reason) }));
    }

    const enteredOrigin = originRef.current.trim();
    const enteredPort = Number(portRef.current);
    if (
      nextServeStatus?.installed
      && !nextServeStatus.error
      && enteredOrigin.startsWith("https://")
      && Number.isInteger(enteredPort)
      && enteredPort >= 1024
      && enteredPort <= 65535
    ) {
      try {
        await invoke("mobile_verify_tailscale_serve", {
          origin: enteredOrigin,
          port: enteredPort,
        });
        if (sequence !== refreshSequence.current) return;
        setServeVerification({ verified: true });
      } catch (reason) {
        if (sequence !== refreshSequence.current) return;
        setServeVerification({ verified: false, error: String(reason) });
      }
    } else {
      setServeVerification(null);
    }

    setRefreshError(failures.length > 0 ? failures.join(" ") : null);
    setRefreshing(false);
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      refreshSequence.current += 1;
    };
  }, [refresh]);

  /** The two phone-side mail writes. Each is its own switch, default off, and
   * read by the desktop bridge alone — the sidecar never sees mail settings.
   * They ride on the stored host settings untouched otherwise, so flipping one
   * never re-verifies Serve or restarts the host. */
  const setMailGate = async (gate: "mail_read" | "mail_actions" | "mail_reply" | "root_access" | "project_files" | "stay_after_quit" | "shell_tabs", on: boolean) => {
    setError(null);
    try {
      await updateSettings({
        [MOBILE_HOST_KEY]: {
          ...(stored ?? { enabled: false }),
          // `mail_read` defaults on, so only its "off" is stored; the writes
          // default off, so only their "on" is.
          [gate]: gate === "mail_read" ? (on ? undefined : false) : on || undefined,
        },
      });
    } catch (reason) {
      setError(String(reason));
    }
  };

  const apply = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const parsedPort = Number(port);
      if (enabled && (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535)) {
        throw new Error(tr("mobile.errPortRange"));
      }
      if (enabled && !origin.startsWith("https://")) {
        throw new Error(tr("mobile.errOriginFirst"));
      }
      if (enabled) {
        await invoke("mobile_verify_tailscale_serve", {
          origin: origin.trim(),
          port: parsedPort,
        });
      }
      await updateSettings({
        [MOBILE_HOST_KEY]: {
          enabled,
          display_name: displayName.trim() || "Workstation",
          port: parsedPort || 8742,
          serve_origin: origin.trim() || undefined,
          mail_read: stored?.mail_read,
          mail_actions: stored?.mail_actions,
          mail_reply: stored?.mail_reply,
          root_access: stored?.root_access,
          project_files: stored?.project_files,
          stay_after_quit: stored?.stay_after_quit,
          shell_tabs: stored?.shell_tabs,
        },
      });
      await invoke("mobile_host_apply", { enabled });
      setPairCode(null);
      refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  // Same one-click shape as every other install-via-command flow: the command
  // runs in a root terminal tab, watched in the root console floating over
  // Settings — never a scope switch away from the panel.
  /** The compact "All phones ▾" / "2 phones ▾" / "No phones ▾" button beside
   *  a row whose access is on: opens the per-phone picker for it. */
  const phoneScopeButton = (
    kind: "project" | "box",
    id: string,
    name: string,
    enabled: boolean,
    list: unknown,
  ) => {
    // `null`, not `undefined`: the row keeps its shape while off (ToggleRow).
    if (!enabled) return null;
    const reach = phoneReach(true, list, pairedPhones);
    return (
      <button
        type="button"
        className={`settings-btn sm${reach.kind === "none" ? " warning" : ""}`}
        aria-haspopup="menu"
        title={t("mobile.phones.buttonTitle", { name })}
        onClick={(event) => {
          const r = event.currentTarget.getBoundingClientRect();
          setPhonePicker({ kind, id, x: r.left, y: r.bottom + 2 });
        }}
      >
        {phoneReachLabel(reach, t)} ▾
      </button>
    );
  };

  const setUpInTerminal = () => {
    const command = `tailscale serve --bg http://127.0.0.1:${guidePort}`;
    if (!window.confirm(tr("mobile.setUpConfirm", { command }))) return;
    runInstallInTab(tr("mobile.guideSummary"), command, "default");
  };

  const installOnPhone = async () => {
    setError(null);
    try {
      // The backend materializes its embedded source so a packaged Tabtivity has
      // the same handoff script as a checkout. It answers with the script's
      // path because the state dir differs per OS (XDG on Linux, Application
      // Support on macOS) and must not be re-derived here.
      const scriptPath = await invoke<string>("mobile_prepare_phone_install_script");
      const tabs = useTabsStore.getState();
      // The backend hands back a PowerShell script on Windows (no bash/jq in
      // a Windows root terminal) and a POSIX one elsewhere; run each with its
      // own interpreter in the OS default shell.
      tabs.addTabToScope(ROOT_SCOPE, {
        label: tr("mobile.phoneInstallTab"),
        cmd: IS_WINDOWS ? "" : "/bin/bash",
        cwd: rootDir ?? "",
        kind: "shell",
        initialInput: IS_WINDOWS
          ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
          : `bash "${scriptPath.replace(/(["\\$`])/g, "\\$1")}"`,
      });
      useProjectsStore.setState({
        switchToast: tr("mobile.phoneInstallToast"),
      });
    } catch (reason) {
      setError(tr("mobile.phoneInstallError", { reason: String(reason) }));
    }
  };

  const detectServeSettings = async () => {
    setDetectingServe(true);
    setError(null);
    setRefreshError(null);
    try {
      const result = await invoke<ServeStatus>("mobile_tailscale_serve_status");
      setServeStatus(result);
      if (!result.installed) throw new Error(tr("mobile.errNoTailscale"));
      if (result.error) throw new Error(result.error);
      const detected = result.detected ?? detectServeSettingsFromJson(result.json);
      await invoke("mobile_verify_tailscale_serve", {
        origin: detected.origin,
        port: detected.port,
      });
      setDisplayName(detected.display_name);
      setPort(String(detected.port));
      setOrigin(detected.origin);
      setServeVerification({ verified: true });
      await updateSettings({
        [MOBILE_HOST_KEY]: {
          enabled: stored?.enabled ?? false,
          display_name: detected.display_name,
          port: detected.port,
          serve_origin: detected.origin,
          mail_read: stored?.mail_read,
          mail_actions: stored?.mail_actions,
          mail_reply: stored?.mail_reply,
          root_access: stored?.root_access,
          project_files: stored?.project_files,
          stay_after_quit: stored?.stay_after_quit,
          shell_tabs: stored?.shell_tabs,
        },
      });
    } catch (reason) {
      setServeVerification(null);
      setError(String(reason));
    } finally {
      setDetectingServe(false);
    }
  };

  const createPairing = async () => {
    setPairingBusy(true);
    setError(null);
    try {
      const currentStatus = await invoke<RuntimeStatus>("mobile_host_status");
      setStatus(currentStatus);
      if (!currentStatus.running) {
        throw new Error(tr("mobile.errStartHostFirst"));
      }
      const response = await invoke<AdminResponse>("mobile_admin", {
        request: { type: "pairing_code" },
      });
      if (response.status !== "pairing_code") throw new Error(response.status === "error" ? response.message : tr("mobile.errPairingUnavailable"));
      setPairCode(response.code);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPairingBusy(false);
    }
  };

  const lockDownNow = async () => {
    if (!window.confirm(tr("mobile.lockdownConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const response = await invoke<AdminResponse>("mobile_admin", { request: { type: "forget_all" } });
      if (response.status === "error") throw new Error(response.message);
      await updateSettings({
        [MOBILE_HOST_KEY]: {
          enabled: false,
          display_name: displayName.trim() || "Workstation",
          port: Number(port) || 8742,
          serve_origin: origin.trim() || undefined,
          mail_read: stored?.mail_read,
          mail_actions: stored?.mail_actions,
          mail_reply: stored?.mail_reply,
          root_access: stored?.root_access,
          project_files: stored?.project_files,
          stay_after_quit: stored?.stay_after_quit,
          shell_tabs: stored?.shell_tabs,
        },
      });
      await invoke("mobile_host_apply", { enabled: false });
      setPairCode(null);
      await refresh();
    } catch (reason) {
      setError(tr("mobile.lockdownPartial", { reason: String(reason) }));
    } finally {
      setBusy(false);
    }
  };

  const eligible = projects.filter((project) => !project.remote && !project.sandbox?.enabled && !project.vm?.enabled);
  const normalizedProjectSearch = projectSearch.trim().toLocaleLowerCase();
  const matchingEligible = normalizedProjectSearch
    ? eligible.filter((project) => project.name.toLocaleLowerCase().includes(normalizedProjectSearch))
    : eligible;
  // Boxes ride under the same search box: every box is eligible (a box's tabs
  // run locally whatever its members are), so the list is the box list.
  const matchingBoxes = normalizedProjectSearch
    ? boxes.filter((box) => box.name.toLocaleLowerCase().includes(normalizedProjectSearch))
    : boxes;
  const securityHealth = !stored?.enabled
    ? { tone: "off", title: t("mobile.healthOffTitle"), detail: t("mobile.healthOffDetail") }
    : !status?.running
      ? { tone: "danger", title: t("mobile.healthStoppedTitle"), detail: t("mobile.healthStoppedDetail") }
      : !serveVerification?.verified
        ? { tone: "danger", title: t("mobile.healthServeTitle"), detail: t("mobile.healthServeDetail") }
        : { tone: "good", title: t("mobile.healthGoodTitle"), detail: t("mobile.healthGoodDetail") };

  return (
    <SettingsCard>
      <ToggleRow
        label={t("mobile.title")}
        checked={stored?.enabled ?? false}
        disabled={busy}
        onChange={(event) => void apply(event.target.checked)}
      />
      <p className="settings-help">
        {t("mobile.settingsHelp")}
      </p>
      <div className={`mobile-security-health ${securityHealth.tone}`} role="status">
        <div>
          <strong>{securityHealth.title}</strong>
          <p>{securityHealth.detail}</p>
        </div>
        <button
          type="button"
          className="settings-btn sm danger"
          disabled={busy || !status?.running}
          title={status?.running ? t("mobile.lockdownTitle") : t("mobile.lockdownTitleStopped")}
          onClick={() => void lockDownNow()}
        >{t("mobile.lockdownNow")}</button>
      </div>
      <p className="settings-help">
        {t("mobile.scopeHelp")}
      </p>
      {IS_WINDOWS && (
        <p className="settings-help">
          {t("mobile.windowsTerminalsNote")} <UntestedTag id="mobile.windowsTerminalsNote" />
        </p>
      )}
      {/* The handoff script has a PowerShell twin on Windows, so the QR flow
          is offered on every desktop. */}
      <div className="mobile-phone-install">
        <div>
          <strong>{t("mobile.phoneInstallTitle")}</strong>
          <p>
            {t("mobile.phoneInstallHelp")}
          </p>
        </div>
        <button type="button" className="settings-btn sm primary mobile-phone-install-button" onClick={() => void installOnPhone()}>
          {t("mobile.phoneInstallButton")}
        </button>
      </div>
      <details className="mobile-settings-guide" open>
        <summary>{t("mobile.guideSummary")}</summary>
        <div className="mobile-settings-guide-body">
          <p>
            {t("mobile.guideIntro")}
          </p>
          <ol>
            <li>
              {t("mobile.guideStep1a")} <code>tailscale serve status</code>{t("mobile.guideStep1b")}
            </li>
            <li>
              {t("mobile.guideStep2a")}
              <code className="mobile-settings-guide-command">tailscale serve --bg http://127.0.0.1:{guidePort}</code>
              {t("mobile.guideStep2b")}
            </li>
            <li>
              {t("mobile.guideStep3a")} <code>tailscale serve status</code> {t("mobile.guideStep3b")}{" "}
              <em>{t("mobile.detectServe")}</em> {t("mobile.guideStep3c")}
            </li>
            <li>
              {t("mobile.guideStep4a")} <code>http://127.0.0.1:{guidePort}</code>{t("mobile.guideStep4b")}{" "}
              <em>{t("mobile.refreshStatus")}</em> {t("mobile.guideStep4c")}
            </li>
            <li>
              {t("mobile.guideStep5")}
            </li>
          </ol>
          <p>
            {t("mobile.guideOutro")}
          </p>
          <div className="mobile-settings-guide-actions">
            <button type="button" className="settings-btn sm" onClick={setUpInTerminal}>{t("mobile.setUpInTerminal")}</button>
            <span>{t("mobile.setUpInTerminalHelp")}</span>
          </div>
          <a href="https://tailscale.com/docs/features/tailscale-serve" target="_blank" rel="noreferrer">{t("mobile.serveDocs")}</a>
        </div>
      </details>
      <div className="settings-card-row">
        <label className="settings-card-label" htmlFor="mobile-display-name">{t("mobile.displayName")}</label>
        <input
          id="mobile-display-name"
          value={displayName}
          maxLength={64}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      <div className="settings-card-row">
        <label className="settings-card-label" htmlFor="mobile-loopback-port">{t("mobile.loopbackPort")}</label>
        <input
          id="mobile-loopback-port"
          value={port}
          inputMode="numeric"
          onChange={(event) => {
            setPort(event.target.value);
            setServeVerification(null);
          }}
        />
      </div>
      <div className="settings-card-row">
        <label className="settings-card-label" htmlFor="mobile-serve-origin">{t("mobile.serveOrigin")}</label>
        <input
          id="mobile-serve-origin"
          value={origin}
          placeholder="https://workstation.example.ts.net"
          onChange={(event) => {
            setOrigin(event.target.value);
            setServeVerification(null);
          }}
        />
      </div>
      <div className="settings-link-row">
        <button type="button" className="settings-btn sm" disabled={busy || detectingServe} onClick={() => void detectServeSettings()}>
          {detectingServe ? t("mobile.detecting") : t("mobile.detectServe")}
        </button>
        <button type="button" className="settings-btn sm" disabled={busy || pairingBusy} onClick={() => void createPairing()}>
          {pairingBusy ? t("mobile.creatingCode") : t("mobile.newPairingCode")}
        </button>
        {stored?.enabled && !status?.running && <button type="button" className="settings-btn sm" disabled={busy} onClick={() => void apply(true)}>{t("mobile.startHost")}</button>}
        {status?.update_available && <button type="button" className="settings-btn sm" disabled={busy} onClick={() => void apply(true)}>{t("mobile.updateHost")}</button>}
        <button type="button" className="settings-btn sm" disabled={busy || refreshing} onClick={() => void refresh()}>
          {refreshing ? t("mobile.refreshing") : t("mobile.refreshStatus")}
        </button>
      </div>
      <p className="settings-help" aria-live="polite">
        {status?.running ? t("mobile.statusRunning", { port: status.port ?? "?" }) : t("mobile.statusStopped")}
        {status?.installed_version ? ` ${t("mobile.statusSidecar", { version: status.installed_version })}` : ""}
        {serveVerification?.verified
          ? ` ${t("mobile.statusServeVerified", { port })}`
          : serveStatus?.installed
            ? ` ${t("mobile.statusServeReadable")}`
            : ` ${t("mobile.statusServeUnavailable")}`}
        {serveStatus?.error ? ` ${serveStatus.error}` : ""}
        {serveVerification && !serveVerification.verified ? ` ${serveVerification.error}` : ""}
        {pairCode ? ` ${t("mobile.statusPairCode", { code: pairCode })}` : ""}
      </p>
      {refreshError && <ErrorNote className="project-dialog-error" error={refreshError} />}
      {error && <ErrorNote className="project-dialog-error" error={error} />}

      <div className="settings-subheader">{t("mobile.stayAfterQuitHeader")}</div>
      <ToggleRow
        label={<>{t("mobile.stayAfterQuit")} <UntestedTag id="mobile.stayAfterQuit" /></>}
        checked={stored?.stay_after_quit ?? false}
        disabled={busy}
        onChange={(event) => void setMailGate("stay_after_quit", event.target.checked)}
      />
      <p className="settings-help">{t("mobile.stayAfterQuitHelp")}</p>

      <div className="settings-subheader">{t("mobile.mailWrites")}</div>
      <ToggleRow
        label={<>{t("mobile.mailRead")} <UntestedTag id="mobile.mailRead" /></>}
        checked={stored?.mail_read !== false}
        disabled={busy}
        onChange={(event) => void setMailGate("mail_read", event.target.checked)}
      />
      <p className="settings-help">{t("mobile.mailReadHelp")}</p>
      <ToggleRow
        label={<>{t("mobile.mailActions")} <UntestedTag id="mobile.mailActions" /></>}
        checked={stored?.mail_actions ?? false}
        disabled={busy}
        onChange={(event) => void setMailGate("mail_actions", event.target.checked)}
      />
      <p className="settings-help">{t("mobile.mailActionsHelp")}</p>
      <ToggleRow
        label={<>{t("mobile.mailReply")} <UntestedTag id="mobile.mailReply" /></>}
        checked={stored?.mail_reply ?? false}
        disabled={busy}
        onChange={(event) => void setMailGate("mail_reply", event.target.checked)}
      />
      <p className="settings-help">{t("mobile.mailReplyHelp")}</p>

      <div className="settings-subheader">{t("mobile.rootAccessHeader")}</div>
      <ToggleRow
        label={<>{t("mobile.rootAccess")} <UntestedTag id="mobile.rootAccess" /></>}
        checked={stored?.root_access ?? false}
        disabled={busy}
        onChange={(event) => void setMailGate("root_access", event.target.checked)}
      />
      <p className="settings-help">{t("mobile.rootAccessHelp")}</p>
      {stored?.root_access && rootGateClosed && (
        <div className="project-dialog-error">{t("mobile.rootAccessClosed")}</div>
      )}

      <div className="settings-subheader">{t("mobile.projectAccess")}</div>
      <p className="settings-help">
        {t("mobile.projectAccessHelp")}
      </p>
      <ToggleRow
        label={<>{t("mobile.projectFiles")} <UntestedTag id="mobile.projectFiles" /></>}
        checked={stored?.project_files ?? false}
        disabled={busy}
        onChange={(event) => void setMailGate("project_files", event.target.checked)}
      />
      <p className="settings-help">{t("mobile.projectFilesHelp")}</p>
      <ToggleRow
        label={<>{t("mobile.noShells")} <UntestedTag id="mobile.noShells" /></>}
        checked={stored?.shell_tabs !== true}
        disabled={busy}
        onChange={(event) => void setMailGate("shell_tabs", !event.target.checked)}
      />
      <p className="settings-help">{t("mobile.noShellsHelp")}</p>
      {eligible.length > 0 && <input
        className="mobile-project-access-search"
        value={projectSearch}
        placeholder={t("mobile.searchProjects")}
        aria-label={t("mobile.searchProjectsAria")}
        onChange={(event) => setProjectSearch(event.target.value)}
      />}
      <div className="mobile-project-access-list">
        {matchingEligible.map((project) => (
          <ToggleRow
            key={project.id}
            label={project.name}
            checked={project[MOBILE_ACCESS_KEY] ?? false}
            onChange={(event) => {
              setError(null);
              // One click on = every phone; narrowing is the ▾ button's job.
              void setProjectMobileAccess(project.id, event.target.checked, null).catch((reason) => setError(String(reason)));
            }}
            aside={phoneScopeButton("project", project.id, project.name, project[MOBILE_ACCESS_KEY] ?? false, project[MOBILE_DEVICES_KEY])}
          />
        ))}
        {eligible.length === 0 && <p className="settings-help">{t("mobile.noEligibleProjects")}</p>}
        {eligible.length > 0 && matchingEligible.length === 0 && <p className="settings-help">{t("mobile.noProjectsMatch", { query: projectSearch.trim() })}</p>}
      </div>

      {boxes.length > 0 && <>
        <div className="settings-subheader">{t("mobile.boxAccess")} <UntestedTag id="mobile.boxAccess" /></div>
        <p className="settings-help">{t("mobile.boxAccessHelp")}</p>
        <div className="mobile-project-access-list">
          {matchingBoxes.map((box) => (
            <ToggleRow
              key={box.id}
              label={box.name}
              checked={box[MOBILE_ACCESS_KEY] ?? false}
              onChange={(event) => {
                setError(null);
                void setBoxMobileAccess(box.id, event.target.checked, null).catch((reason) => setError(String(reason)));
              }}
              aside={phoneScopeButton("box", box.id, box.name, box[MOBILE_ACCESS_KEY] ?? false, box[MOBILE_DEVICES_KEY])}
            />
          ))}
          {matchingBoxes.length === 0 && <p className="settings-help">{t("mobile.noBoxesMatch", { query: projectSearch.trim() })}</p>}
        </div>
      </>}

      {phonePicker && (() => {
        const target = phonePicker.kind === "project"
          ? projects.find((p) => p.id === phonePicker.id)
          : boxes.find((b) => b.id === phonePicker.id);
        if (!target) return null;
        return (
          <MobileAccessPicker
            x={phonePicker.x}
            y={phonePicker.y}
            kind={phonePicker.kind}
            enabled={target[MOBILE_ACCESS_KEY] ?? false}
            devices={target[MOBILE_DEVICES_KEY]}
            onApply={(enabled, list) => phonePicker.kind === "project"
              ? setProjectMobileAccess(phonePicker.id, enabled, list)
              : setBoxMobileAccess(phonePicker.id, enabled, list)}
            onClose={() => setPhonePicker(null)}
          />
        );
      })()}

      {devices.length > 0 && <div className="settings-subheader">{t("mobile.pairedDevices")}</div>}
      {devices.length > 0 && (
        <SettingsList boxed>
          {devices.map((device) => (
            <div key={device.id} className="settings-row">
              <span className="settings-list-label">{device.name}</span>
              <button
                type="button"
                className="settings-btn sm danger"
                onClick={() => void invoke<AdminResponse>("mobile_admin", { request: { type: "revoke", device_id: device.id } }).then(refresh)}
              >{t("mobile.revoke")}</button>
            </div>
          ))}
        </SettingsList>
      )}
      {devices.length > 0 && <button
        type="button"
        className="settings-btn sm danger"
        onClick={() => {
          if (!window.confirm(tr("mobile.forgetAllConfirm"))) return;
          void invoke<AdminResponse>("mobile_admin", { request: { type: "forget_all" } })
            .then((response) => {
              if (response.status === "error") throw new Error(response.message);
              setPairCode(null);
              refresh();
            })
            .catch((reason) => setError(String(reason)));
        }}
      >{t("mobile.forgetAll")}</button>}
    </SettingsCard>
  );
}
