import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { SettingsAdvanced, SettingsCard, SettingsHeader, SettingsList, SettingsSection, ToggleRow } from "./settingsUi";
import { formatBytes as fmtBytes } from "../../lib/formatBytes";
import { UntestedTag } from "../common/UntestedTag";
import { PasswordInput } from "../common/PasswordInput";
import type { UntestedId } from "../../lib/untested";
import { unlockKeyring } from "../../lib/keyring";
import { diffDefaultApps, patchDefaultApps } from "../../lib/defaultApps";
import { open } from "@tauri-apps/plugin-dialog";
import { Dropdown } from "../common/Dropdown";
import { useSettingsStore } from "../../stores/settings";
import { initLocalModelEvents, useOllamaActivityStore } from "../../stores/agents/ollamaActivity";
import { ollamaVersionStatus } from "../../lib/agents/localDrivers";
import { runOllamaUpdateCheck, upgradeOllamaInTab } from "../../lib/agents/ollamaUpdateActions";
import { AgentScheduleMcpSettings } from "../agents/AgentScheduleMcpSettings";
import { GitPushMcpSettings } from "../agents/GitPushMcp";
import { MarkupMcpSettings } from "../agents/MarkupMcpSettings";
import { HOST_OS } from "../../lib/platform";
import { cliInstallsByAdmin } from "../../lib/transport/linkState";
import {
  NODE_DOWNLOAD_URL,
  NODE_INSTALL,
  runInstallInTab,
  type InstallShellKind,
  type NodeRuntimeStatus,
} from "../../lib/installCommand";
import {
  codexHookNeedsTrust,
  openCodexHooksTab,
  type CodexHookState,
} from "../../lib/agents/codexHooks";
import type { CustomAgent, GlobalAppEntry } from "../../types";
import { parseSshAddress } from "../../lib/projects/scaffold";
import { useProjectsStore } from "../../stores/projects";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useT, type TranslationKey } from "../../lib/i18n";
import { notifyAgentRegistryChanged } from "../../lib/agents/agentRegistry";
import {
  DEFAULT_PREFACE_COMMANDS,
  MAX_PREFACE_COMMANDS,
  agentComposerKey,
  agentModelsFor,
  prefaceCommandsFor,
  sanitizePrefaceCommand,
} from "../../lib/agents/agentPrefaces";
import {
  AGENT_CRON_MESSAGE,
  addTime,
  agentCronTimes,
  allAgentsEnabled,
  nextAgentCronRun,
  normalizeTimes,
  removeTime,
  withAgentCronEnabled,
  withAgentCronTimes,
  withAllAgentsEnabled,
  withCronEnabled,
  withGlobalTimes,
  type AgentCron,
} from "../../lib/agents/agentCron";
import { formatTime } from "../../lib/calendar/calendarTime";
import { useUse24h } from "../../lib/timeFormat";
import { AGENT_FENCE_DEFAULT_PATHS, parseAgentFencePaths } from "../../lib/agents/agentFence";
import { loginIdForCmd } from "../../lib/agents/signInLaunch";
import { useAgentVersionNoticeStore } from "../../stores/agents/agentVersionNotice";
import {
  AGENT_ITEMS,
  agentShortcutSlots,
  effectiveAgentOrder,
  enabledInstalledAgentBins,
  moveInAgentOrder,
  sortByAgentOrder,
} from "../../lib/tabs/newTabItems";
import { AGENT_TAB_ACTIONS, chordLabel, modifierLabel, resolveChord } from "../../lib/shortcuts/shortcuts";
import { useShortcutOverrides } from "../../lib/shortcuts/shortcutHint";
import { ErrorNote } from "../common/ErrorNote";
import { NAMES } from "../../lib/brand";
import { runWithProgress } from "../../lib/runWithProgress";

interface OllamaModelInfo {
  name: string;
  size: number;
  parameter_size: string | null;
  quantization: string | null;
  family: string | null;
  running: boolean;
  size_vram: number;
}

/** How a chosen models-download location would be applied (mirrors backend
 *  `OllamaModelsDirPlan`). `service_cmd` is empty unless the running server is a
 *  systemd unit *and* the path is safe to embed in a drop-in. */
interface OllamaModelsDirPlan {
  default_dir: string;
  systemd_service: boolean;
  service_cmd: string;
  shell_kind: string;
}

/** One row from the live Ollama registry search (mirrors backend RegistryModel). */
interface RegistryModel {
  /** `gemma4`, or `<user>/<name>` for a community upload. */
  name: string;
  community: boolean;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  updated: string;
}

/** A tag's headline facts (mirrors backend RegistryDetails), fetched lazily so a
 *  row that carries no size badge on the search card can still show its
 *  parameters and download size. */
interface RegistryDetails {
  size_bytes: number;
  params: string | null;
  quant: string | null;
  cloud: boolean;
}
/** Cached per-tag details, "loading" while the two registry reads are in flight,
 *  "error" when they could not be reached. */
type TagInfo = RegistryDetails | "loading" | "error";

/** One page of registry search results (mirrors backend RegistrySearchPage). */
interface RegistrySearchPage {
  models: RegistryModel[];
  hasMore: boolean;
}

/** Capability filters, Ollama's `c=` search param: a model must have all chosen. */
const REGISTRY_TYPES = ["tools", "vision", "thinking", "embedding", "audio"] as const;

/** Where a model runs, also a `c=` value on ollama.com — one or neither. */
const REGISTRY_RUNS = ["local", "cloud"] as const;

/** Download-size caps, Ollama's `s=` search param (GB; "over64" is the top bucket). */
const REGISTRY_DOWNLOAD_SIZES = ["8", "16", "32", "64", "over64"] as const;

/** Sort options for the registry browser, Ollama's own `o=` orders: every
 *  lazy-loaded page arrives already in order. */
const SORT_OPTIONS = [
  { key: "popular", labelKey: "ollama.sort.popular" },
  { key: "newest", labelKey: "ollama.sort.newest" },
  { key: "name", labelKey: "ollama.sort.name" },
] as const satisfies { key: string; labelKey: TranslationKey }[];
type SortKey = (typeof SORT_OPTIONS)[number]["key"];

/** Every sub-panel takes the same two: `onBack` returns to the main settings
 *  panel, `onClose` dismisses the whole dialog. Both optional: the panels are
 *  also rendered standalone in tests, and the Models & agents overlay
 *  (`models/ModelsOverlay`) hosts the Agents and Ollama panels as tabs, where
 *  there is no settings page to go back to (`SettingsHeader` omits Back). */
export interface SubPanelProps {
  onBack?: () => void;
  onClose?: () => void;
}

/** The external programs a user can name here. `browser` is what PDF links
 *  open in (`lib/linkTarget`); the header launcher that once ran the rest is
 *  gone, but configured commands are kept in settings rather than dropped. */
const GLOBAL_APP_ROLES: Array<{ key: string; labelKey: TranslationKey; fallback: string }> = [
  { key: "browser", labelKey: "globalApp.role.browser", fallback: "◎" },
  { key: "password_manager", labelKey: "globalApp.role.password_manager", fallback: "⚿" },
  { key: "video_conf", labelKey: "globalApp.role.video_conf", fallback: "▣" },
  { key: "screenshot", labelKey: "globalApp.role.screenshot", fallback: "▤" },
  { key: "screen_recorder", labelKey: "globalApp.role.screen_recorder", fallback: "●" },
  { key: "chat", labelKey: "globalApp.role.chat", fallback: "☏" },
];

export function GlobalAppsSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [apps, setApps] = useState<Record<string, GlobalAppEntry>>(settings?.global_apps ?? {});

  useEffect(() => {
    setApps(settings?.global_apps ?? {});
  }, [settings?.global_apps]);

  const saveApps = (next: Record<string, GlobalAppEntry>) => {
    setApps(next);
    void updateSettings({ global_apps: next });
  };

  const updateRole = (role: string, patch: Partial<GlobalAppEntry>) => {
    const current = apps[role] ?? { exec: "", visible: true };
    saveApps({ ...apps, [role]: { ...current, ...patch } });
  };

  const chooseExecutable = async (role: string) => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") {
      updateRole(role, { exec: picked });
    }
  };

  return (
    <>
      <SettingsHeader title={t("globalApps.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("globalApps.help")}</p>
      <SettingsList boxed>
        {GLOBAL_APP_ROLES.map((role) => {
          const entry = apps[role.key] ?? { exec: "", visible: true };
          const roleLabel = t(role.labelKey);
          return (
            <div className="global-app-settings-row" key={role.key}>
              <span className="settings-role-icon" aria-hidden>{role.fallback}</span>
              <span className="settings-role-label">{roleLabel}</span>
              <input
                value={entry.exec}
                placeholder={t("globalApps.notFoundPlaceholder")}
                onChange={(e) => setApps({ ...apps, [role.key]: { ...entry, exec: e.target.value } })}
                onBlur={(e) => updateRole(role.key, { exec: e.target.value.trim() })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") updateRole(role.key, { exec: e.currentTarget.value.trim() });
                }}
              />
              <button
                type="button"
                className="settings-btn sm icon"
                title={t("globalApps.browseTitle", { role: roleLabel })}
                onClick={() => void chooseExecutable(role.key)}
              >
                …
              </button>
            </div>
          );
        })}
      </SettingsList>
      </div>
    </>
  );
}

export function FileTypeSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const [apps, setApps] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({ ext: "", app: "" });
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<Record<string, string>>("get_default_apps")
      .then(setApps)
      .catch((err) => setError(String(err)));
  }, []);

  const saveApps = (next: Record<string, string>) => {
    // Only the change, so a save from another window or the phone in between
    // is kept (headless owner plan, H1b); the answer is the map as stored.
    const patch = diffDefaultApps(apps, next);
    setApps(next);
    patchDefaultApps(patch, () => next)
      .then(setApps)
      .catch((err) => setError(String(err)));
  };

  const normalizeExt = (ext: string) => {
    const trimmed = ext.trim();
    if (!trimmed) return "";
    return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  };

  const chooseExecutable = async (ext: string) => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") {
      saveApps({ ...apps, [ext]: picked });
    }
  };

  const addEntry = () => {
    const ext = normalizeExt(draft.ext);
    const app = draft.app.trim();
    if (!ext || !app) return;
    saveApps({ ...apps, [ext]: app });
    setDraft({ ext: "", app: "" });
  };

  return (
    <>
      <SettingsHeader title={t("filetypes.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("filetypes.help")}</p>
      {error && <ErrorNote className="project-dialog-error" error={error} />}
      <SettingsList boxed>
        {Object.entries(apps).sort(([a], [b]) => a.localeCompare(b)).map(([ext, app]) => (
          <div className="filetype-settings-row" key={ext}>
            <input
              value={ext}
              onChange={(e) => {
                const nextExt = normalizeExt(e.target.value);
                const { [ext]: old, ...rest } = apps;
                if (nextExt) saveApps({ ...rest, [nextExt]: old });
              }}
            />
            <input
              value={app}
              onChange={(e) => setApps({ ...apps, [ext]: e.target.value })}
              onBlur={(e) => saveApps({ ...apps, [ext]: e.target.value.trim() })}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveApps({ ...apps, [ext]: e.currentTarget.value.trim() });
              }}
            />
            <button
              type="button"
              className="settings-btn sm icon"
              title={t("filetypes.browseTitle")}
              onClick={() => void chooseExecutable(ext)}
            >
              …
            </button>
            <button
              type="button"
              className="settings-btn sm icon danger"
              onClick={() => {
                const { [ext]: _removed, ...rest } = apps;
                saveApps(rest);
              }}
              title={t("common.remove")}
            >
              ×
            </button>
          </div>
        ))}
        <div className="filetype-settings-row">
          <input
            value={draft.ext}
            placeholder={t("filetypes.extPlaceholder")}
            onChange={(e) => setDraft({ ...draft, ext: e.target.value })}
          />
          <input
            value={draft.app}
            placeholder={t("filetypes.appPlaceholder")}
            onChange={(e) => setDraft({ ...draft, app: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") addEntry();
            }}
          />
          <button type="button" className="settings-btn sm primary" onClick={addEntry}>
            {t("common.add")}
          </button>
        </div>
      </SettingsList>
      </div>
    </>
  );
}

/**
 * "Remote Connections" settings panel: a standard/default remote path per SSH
 * host, set once here instead of re-browsing it every time. Consulted by
 * `useRemoteSession`'s `resolveStartDir` whenever a connect/browse flow would
 * otherwise fall back to the SSH-reported home directory — so a host with a
 * preferred working directory (e.g. a projects folder that isn't `$HOME`)
 * opens there every time, for both new remote projects and reconnects.
 *
 * Distinct from the auto-remembered "recently used paths" dropdown in the New
 * Project dialog (`remote_paths.json`): that list grows on its own from every
 * folder you browse to, while this is one explicit choice per host, edited
 * only here.
 */
export function RemoteHostsSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const [defaults, setDefaults] = useState<Record<string, string> | null>(null);
  const [draftHost, setDraftHost] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const [error, setError] = useState("");

  const refresh = () => {
    invoke<Record<string, string>>("remote_list_default_paths")
      .then(setDefaults)
      .catch((e) => setError(String(e)));
  };
  useEffect(refresh, []);

  // Hosts seen before (recent SSH addresses + any active remote project),
  // offered as suggestions when adding a new entry — typing the exact host is
  // still required (paths are host-specific and a typo would silently do
  // nothing), this just saves re-typing one you've already connected to.
  const knownHosts = useProjectsStore((s) => s.projects);
  const [hostSuggestions, setHostSuggestions] = useState<string[]>([]);
  useEffect(() => {
    invoke<string[]>("ssh_list_addresses")
      .then((addrs) => {
        const fromAddrs = addrs.map((a) => parseSshAddress(a)?.host).filter((h): h is string => !!h);
        const fromProjects = knownHosts.map((p) => p.remote?.host).filter((h): h is string => !!h);
        const seen = new Set<string>();
        const out: string[] = [];
        for (const h of [...fromAddrs, ...fromProjects]) {
          const key = h.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(h);
        }
        setHostSuggestions(out);
      })
      .catch(() => setHostSuggestions([]));
  }, [knownHosts]);

  const savePath = (host: string, path: string) => {
    setError("");
    invoke<void>("remote_set_default_path", { host, path })
      .then(refresh)
      .catch((e) => setError(String(e)));
  };

  const removeHost = (host: string) => savePath(host, "");

  const addEntry = () => {
    const host = draftHost.trim();
    const path = draftPath.trim();
    if (!host || !path) return;
    savePath(host, path);
    setDraftHost("");
    setDraftPath("");
  };

  const entries = defaults ? Object.entries(defaults).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <>
      <SettingsHeader title={t("nav.remoteHosts.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("remoteHosts.help")}</p>
      {error && <ErrorNote className="project-dialog-error" error={error} />}
      {/* One framed list holds the saved hosts, the empty state AND the add
          row — the same shape the File Type Apps panel uses. Before, the add
          row sat outside the frame and read as a stray strip below it. */}
      {defaults === null ? (
        <p className="settings-help">{t("common.loading")}</p>
      ) : (
        <SettingsList boxed>
          {entries.length === 0 && (
            <div className="settings-empty">{t("remoteHosts.empty")}</div>
          )}
          {entries.map(([host, path]) => (
            <div className="remote-host-settings-row" key={host}>
              <span className="settings-list-label" title={host}>{host}</span>
              <input
                value={path}
                onChange={(e) => setDefaults((d) => (d ? { ...d, [host]: e.target.value } : d))}
                onBlur={(e) => savePath(host, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") savePath(host, e.currentTarget.value);
                }}
              />
              <button
                type="button"
                className="settings-btn sm icon danger"
                onClick={() => removeHost(host)}
                title={t("common.remove")}
              >
                ×
              </button>
            </div>
          ))}
          <div className="remote-host-settings-row remote-host-settings-add">
            <input
              list="remote-host-suggestions"
              value={draftHost}
              placeholder={t("remoteHosts.hostPlaceholder")}
              onChange={(e) => setDraftHost(e.target.value)}
            />
            <datalist id="remote-host-suggestions">
              {hostSuggestions.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
            <input
              value={draftPath}
              placeholder={t("remoteHosts.pathPlaceholder")}
              onChange={(e) => setDraftPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addEntry();
              }}
            />
            <button type="button" className="settings-btn sm primary" onClick={addEntry}>
              {t("common.add")}
            </button>
          </div>
        </SettingsList>
      )}
      </div>
    </>
  );
}


/** Official, distro-agnostic install command — kept in sync with the backend. */
/** One agent CLI + its install status (mirrors backend `AgentInfo`). */
/** One recorded "verified against" check the installed release has moved away
 *  from (backend `services::agent_versions::StaleNote`). */
interface AgentVersionStale {
  version: string;
  surface: string;
  direction: "newer" | "older" | "different";
}

/** What one installed CLI answers `--version`, against the releases Tabtivity's
 *  flags and parsers were checked with. Reported, never enforced — see
 *  `services::agent_versions`. */
interface AgentVersionReport {
  agent: string;
  label: string;
  installed: boolean;
  /** Whether anyone has checked what this CLI answers to a version flag. */
  supported: boolean;
  version: string | null;
  /** The version line as the CLI printed it. */
  raw: string | null;
  state: "match" | "moved" | "unverified" | "unknown";
  /** Stale checks, weakest (oldest verified release) first. */
  stale: AgentVersionStale[];
  error: string | null;
  checkedAt: number;
  cached: boolean;
  dismissed: boolean;
}

/** One installed CLI against its newest published release (backend
 *  `check_agent_updates`, `services::agent_latest`). */
interface AgentUpdateReport {
  agent: string;
  /** The installed version, when it could be read. */
  current: string | null;
  latest: string | null;
  /** Both versions read and `latest` genuinely newer. */
  updateAvailable: boolean;
  /** Whether a registry is known for this CLI at all. */
  checkable: boolean;
  error: string | null;
}

interface AgentInfo {
  id: string;
  label: string;
  bin: string;
  /** Install command for the host OS; empty when no one-line installer exists. */
  install_cmd: string;
  /** Shell the command runs in: "bash", "PowerShell", or "PowerShell or Command Prompt". */
  shell: string;
  /** Machine-readable shell selection; display labels are not executable policy. */
  shell_kind: InstallShellKind;
  /** `npm uninstall -g <pkg>` for an npm-installed agent; empty otherwise. */
  uninstall_cmd: string;
  /** `install_cmd` prefixed with `sudo`; empty when that wouldn't apply
   *  (Windows, or a non-npm installer). See backend `sudo_variant`. */
  install_cmd_sudo: string;
  /** `uninstall_cmd` prefixed with `sudo`; same emptiness rule. */
  uninstall_cmd_sudo: string;
  docs: string;
  installed: boolean;
  /** Whether the scheduled warm-up can drive this CLI (it has a known one-shot
   *  print mode — backend `WARMUPS`). False greys the schedule toggle. */
  warmup: boolean;
}

/** A small "?" that carries a long explanation as a tooltip, so the page keeps
 *  a short line and the detail is one hover (or focus) away. Not a button: it
 *  has no border or fill and does nothing when clicked. */
function AgentsHelp({ text }: { text: string }) {
  return (
    <span className="agents-help" role="img" tabIndex={0} aria-label={text} title={text}>
      ?
    </span>
  );
}

/** A coloured dot and a word: a status, never a control (no border, no fill). */
function AgentsStatus({
  tone,
  children,
  title,
}: {
  tone: "ok" | "warn" | "off";
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`agents-status is-${tone}`} title={title}>
      <span className="agents-dot" aria-hidden="true" />
      <span className="agents-status-text">{children}</span>
    </span>
  );
}

/** An inline fold for detail most people never need: closed on every open,
 *  unmounted while closed. The lighter sibling of `AgentsGroup`, used inside a
 *  card or a group for one block of secondary content. */
function AgentsFold({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className={`agents-fold${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="agents-fold-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="agents-fold-chevron" aria-hidden="true">
          ›
        </span>
        {label}
      </button>
      {open && (
        <div id={bodyId} className="agents-fold-body">
          {children}
        </div>
      )}
    </div>
  );
}

/** One collapsible settings group of the Agents section: a title, a one-line
 *  summary of what is inside, and the controls themselves once opened. Closed
 *  on every open, body unmounted while closed. */
function AgentsGroup({
  title,
  summary,
  children,
}: {
  title: ReactNode;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className={`agents-group${open ? " open" : ""}`}>
      <button
        type="button"
        className="agents-group-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="agents-group-chevron" aria-hidden="true">
          ›
        </span>
        <span className="agents-group-title">{title}</span>
        <span className="agents-group-summary">{summary}</span>
      </button>
      {open && (
        <div id={bodyId} className="agents-group-body">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * "Codex won't run our session hook" notice for the Manage Agents panel.
 *
 * Codex gates user-level hooks behind a one-time trust approval, and an
 * untrusted one silently never fires — which is why Codex tabs used to restore
 * into a blank conversation. Tabtivity resumes them anyway now (it reconstructs the
 * session from Codex's rollout logs), but that is a heuristic: it can mix up two
 * Codex tabs open in the same directory. Enabling the hook makes it exact.
 *
 * The contextual hint says the same thing, but it is dismissible for good and is
 * suppressed outright when hints are off — so this is where a user who waved it
 * away can still find the fix.
 *
 * Rendered nested inside the Codex row of Manage Agents (not as a free-floating
 * top-of-panel notice) — the hook is Codex-specific, so it belongs with the
 * agent it's about, same as the Remove/Reinstall actions.
 */
function CodexHookNotice() {
  const t = useT();
  // null = still probing.
  const [state, setState] = useState<CodexHookState | null>(null);
  const [trusting, setTrusting] = useState(false);
  const [trustFailed, setTrustFailed] = useState(false);
  const recheck = () =>
    invoke<CodexHookState>("codex_hook_status").then(setState).catch(() => setState(null));
  useEffect(() => void recheck(), []);
  // Codex keeps the trust verdict per config file and every scope's agent home
  // has its own, so `/hooks` in one tab fixes one home. This writes the verdict
  // Codex would into all of them, for the app's own hooks only.
  const trustAll = () => {
    setTrusting(true);
    setTrustFailed(false);
    invoke<CodexHookState>("codex_hook_trust")
      .then((next) => {
        setState(next);
        setTrustFailed(codexHookNeedsTrust(next));
      })
      .catch(() => setTrustFailed(true))
      .finally(() => setTrusting(false));
  };

  // Healthy, absent, or still probing → nothing to say.
  if (!codexHookNeedsTrust(state)) return null;

  // The two states need two different instructions, and conflating them is what
  // made this notice useless: `disabled` means Codex ALREADY recorded a trust
  // verdict for the hook (its `trusted_hash` is in `config.toml`) and the row is
  // merely switched off, so telling that user to "trust it" sends them looking
  // for an action they already took. Only `untrusted` — no verdict at all — is
  // the review-and-approve case.
  const off = state === "disabled";

  return (
    <div className="agents-notice is-warn">
      <div className="agents-notice-head">
        <AgentsStatus tone="warn">
          {t("agents.codexHookLabel")}: {off ? t("agents.codexHookDisabled") : t("agents.codexHookNotTrusted")}
        </AgentsStatus>
      </div>
      <p className="settings-help">{off ? t("agents.codexHookCauseDisabled") : t("agents.codexHookCauseUntrusted")}</p>
      <div className="agents-actions">
        <button type="button" className="settings-btn sm primary" onClick={trustAll} disabled={trusting}>
          {trusting ? t("agents.codexHookTrusting") : t("agents.codexHookTrust")}
        </button>
        <UntestedTag id="agents.codexHookTrust" />
        <button type="button" className="settings-btn sm" onClick={openCodexHooksTab}>
          {t("agents.openInCodex")}
        </button>
        <button type="button" className="settings-btn sm" onClick={() => void recheck()}>
          {t("common.recheck")}
        </button>
      </div>
      {trustFailed && <p className="settings-help">{t("agents.codexHookTrustFailed")}</p>}
      <AgentsFold label={t("agents.howToFix")}>
        <p className="settings-help">{t("agents.codexHookFallback")}</p>
        <p className="settings-help">
          {t("agents.codexHookFindPre")} <code>/hooks</code>{" "}
          {t("agents.codexHookFindMid")} <strong>{NAMES.sessionHookSh.replace(/\.sh$/, "")}</strong>
          {off ? t("agents.codexHookActionDisabled") : t("agents.codexHookActionUntrusted")}
        </p>
      </AgentsFold>
    </div>
  );
}

/**
 * Claude's `--remote-control` toggle, moved here from the main Settings panel
 * (Group: nav "Manage Agents") since the flag only affects `claude` agent
 * tabs — it belongs with the agent it's about, same reasoning as
 * `CodexHookNotice`. Rendered nested inside the Claude row.
 */
function ClaudeRemoteControlNotice() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  return (
    <div className="agents-option">
      <ToggleRow
        label={t("settings.claudeRemote")}
        checked={settings?.agent_remote_control ?? true}
        onChange={(e) => void updateSettings({ agent_remote_control: e.target.checked })}
      />
      <p className="settings-help">
        {t("settings.claudeRemoteHelp1")} <code>--remote-control</code>{" "}
        {t("settings.claudeRemoteHelp2")}
      </p>
    </div>
  );
}

/** One row of `agent_logins` (`services::agent_auth`): a CLI's shared
 *  sign-in across every Tabtivity agent home. Never a token. */
interface AgentLogin {
  id: string;
  signed_in: boolean;
  account: string | null;
  importable: boolean;
  /** A tab's login the keeper refused: another account, a file that names a
   *  command where a credential belongs, or an entry or field a login file
   *  may not bring (`config`: OpenCode's `wellknown` entries and the like). */
  blocked: {
    account: string | null;
    stored: string | null;
    command: string | null;
    config?: string | null;
  } | null;
  /** OpenCode only: scopes whose own database took a `wellknown` source (it
   *  loads that origin's remote configuration at every start). */
  wellknown_homes?: { key: string; label: string | null; origins: string[] }[];
  shared: boolean;
  /** The API proxy serves this CLI: a server's administrator can offer a key. */
  admin_key_capable?: boolean;
  /** A hosted server's administrator offers a key for this CLI. */
  admin_key_offered?: boolean;
  /** This user's agents run on that key instead of their own login (chosen
   *  in the API keys section's "runs on" control, #2389). */
  uses_admin_key?: boolean;
  /** Switched on for a stored provider API key, and one is saved
   *  (`services::agent_api_keys`). */
  api_key?: boolean;
  /** That key's monthly budget is spent, or no limit is set: its keyed tabs
   *  are refused (`services::api_usage`). */
  api_budget_reached?: boolean;
}

/** The shared agent logins: one row per CLI whose login Tabtivity can share,
 *  with the one-click import from this computer and a way out. `refreshKey`
 *  re-reads them when the API keys below change. */
export function AgentLoginsRows({
  refreshKey = 0,
  onChange,
}: {
  refreshKey?: number;
  /** Called after an import or sign-out, so a view of the same logins (the
   *  Agents section's cards) can re-read them. */
  onChange?: () => void;
}) {
  const t = useT();
  const [logins, setLogins] = useState<AgentLogin[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    invoke<AgentLogin[]>("agent_logins")
      .then(setLogins)
      .catch(() => setLogins(null));
  };
  useEffect(refresh, [refreshKey]);
  const labels = useMemo(() => new Map(AGENT_ITEMS.map((a) => [a.cmd, a.label])), []);
  const registry = useMemo(
    () => new Map(AGENT_ITEMS.map((a) => [loginIdForCmd(a.cmd), a.label])),
    [],
  );
  if (!logins) return null;
  const rows = logins.filter((l) => l.shared);
  const run = (id: string, cmd: "agent_login_import" | "agent_login_sign_out") => {
    setError(null);
    setBusy(id);
    invoke(cmd, { id })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        setBusy(null);
        refresh();
        onChange?.();
      });
  };
  const signOutScope = (key: string) => {
    setError(null);
    setBusy(`scope:${key}`);
    invoke("agent_login_scope_sign_out", { scope: key })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        setBusy(null);
        refresh();
        onChange?.();
      });
  };
  return (
    <div className="agents-block">
      <div className="settings-subheader">
        {t("settings.agentLogins")} <UntestedTag id="settings.agentLogins" />
        <AgentsHelp text={t("settings.agentLoginsHelp")} />
      </div>
      {rows.map((l) => {
        const label = registry.get(l.id) ?? labels.get(l.id) ?? l.id;
        const login = l.signed_in
          ? l.account
            ? t("settings.agentLoginSignedInAs", { account: l.account })
            : t("settings.agentLoginSignedIn")
          : t("agents.loginNone");
        const keyLabel = l.api_budget_reached
          ? t("settings.agentLoginApiBudgetReached")
          : t("settings.agentLoginUsesApiKey");
        const own = !l.api_key ? login : l.signed_in ? `${login} · ${keyLabel}` : keyLabel;
        // A hosted server's administrator's key (plan §5.2): chosen per CLI
        // in the API keys section; here only what the login row runs on.
        const state = l.uses_admin_key
          ? l.admin_key_offered
            ? t("settings.agentLoginAdminKey")
            : t("settings.agentLoginAdminKeyGone")
          : own;
        const ok = l.uses_admin_key ? !!l.admin_key_offered : l.signed_in || (!!l.api_key && !l.api_budget_reached);
        return (
          <Fragment key={l.id}>
            <div className="agents-row">
              <div className="agents-row-main">
                <span className="agents-row-name">{label}</span>
                <AgentsStatus
                  tone={ok ? "ok" : "off"}
                  title={!l.signed_in && !l.api_key && !l.uses_admin_key ? t("settings.agentLoginNotSignedIn") : undefined}
                >
                  {state}
                </AgentsStatus>
                {l.blocked && (
                  <span className="agents-row-note is-warn">
                    {l.blocked.config
                      ? t("settings.agentLoginBlockedConfig", { field: l.blocked.config })
                      : l.blocked.command
                        ? t("settings.agentLoginBlockedCommand", { field: l.blocked.command })
                        : t("settings.agentLoginBlocked", { account: l.blocked.account ?? "", stored: l.blocked.stored ?? "" })}
                    {l.blocked.config && <UntestedTag id="settings.agentLoginWellknown" />}
                  </span>
                )}
              </div>
              <div className="agents-actions">
                {l.importable && (
                  <button
                    type="button"
                    className="settings-btn sm"
                    disabled={busy === l.id}
                    onClick={() => run(l.id, "agent_login_import")}
                  >
                    {t("settings.agentLoginImport")}
                  </button>
                )}
                {l.signed_in && (
                  <button
                    type="button"
                    className="settings-btn sm danger"
                    disabled={busy === l.id}
                    onClick={() => run(l.id, "agent_login_sign_out")}
                  >
                    {t("settings.agentLoginSignOut")}
                  </button>
                )}
              </div>
            </div>
            {(l.wellknown_homes ?? []).map((h) => (
              <div key={`wellknown:${h.key}`} className="agents-row">
                <div className="agents-row-main">
                  <span className="agents-row-note is-warn">
                    {t("settings.agentLoginWellknown", {
                      scope: h.label ?? (h.key === "host" ? t("settings.agentLoginWellknownHost") : h.key),
                      origins: h.origins.join(", "),
                    })}{" "}
                    <UntestedTag id="settings.agentLoginWellknown" />
                  </span>
                </div>
                <div className="agents-actions">
                  <button
                    type="button"
                    className="settings-btn sm danger"
                    disabled={busy === `scope:${h.key}`}
                    onClick={() => signOutScope(h.key)}
                  >
                    {t("settings.agentLoginWellknownSignOut")}
                  </button>
                </div>
              </div>
            ))}
          </Fragment>
        );
      })}
      {error && <p className="settings-help">{error}</p>}
    </div>
  );
}

/** `agent_api_keys_status` (`services::agent_api_keys`). Never a key. */
interface AgentApiKeyStatus {
  /** The keyring can be read now; while locked every `saved` reads false. */
  readable: boolean;
  /** `keychain` (a desktop's OS store) or `vault` (a server's sealed store,
   *  opened only by a paired device — nothing here can unlock it). */
  store?: "keychain" | "vault";
  providers: {
    id: string;
    saved: boolean;
    /** The monthly limit in billed tokens (`agent_api_token_limits`) as the
     *  backend reads it. */
    limitTokens?: number | null;
    /** Billed tokens this month: what the limit counts. */
    billed?: number;
    /** Their cost by the price table — an estimate, shown only. */
    spentUsd?: number;
    /** An older build's dollar limit while no token limit is set: a hint. */
    legacyLimitUsd?: number | null;
    /** `open`, `reached`, or `noLimit` (refused until a limit is set). */
    budget?: "open" | "reached" | "noLimit";
    /** Models priced at the provider's highest rate (not in the table). */
    unknownModels?: string[];
    /** This month by model, most billed first: input and output apart. */
    models?: {
      model: string;
      input: number;
      output: number;
      cacheWrite: number;
      cacheRead: number;
      requests: number;
      billed: number;
      usd: number;
    }[];
    /** The workspace a saved Anthropic key that is not scoped to one names. */
    workspace?: string | null;
  }[];
  clis: {
    id: string;
    enabled: boolean;
    providers: string[];
    ready: boolean;
    /** A hosted server's administrator offers this user a key for the CLI. */
    adminOffered?: boolean;
    /** This user runs the CLI on the administrator's key. */
    usesAdmin?: boolean;
    /** Through the server's key broker: this month's use and budget. */
    adminBroker?: { month: string; billed: number; budget?: number | null } | null;
  }[];
  /** UTC month counted (`YYYY-MM`) and the day the count restarts. */
  month?: string;
  resetsOn?: string;
  /** This month's count restarted: the ledger file could not be read. */
  ledgerRestarted?: string | null;
  /** When the price table was read off the vendors' pages. */
  pricesDate?: string;
}

/** `agent_api_key_set`'s answer: saved, or an Anthropic key that is not
 *  scoped to a workspace — saved only once one of `workspaces` is picked (an
 *  id typed in when the key could list none). */
type ApiKeySave = { kind: "saved" } | { kind: "pickWorkspace"; workspaces: { id: string; name: string }[] };

/** The monthly limit a new key's row proposes, in million billed tokens. */
export const DEFAULT_API_LIMIT_MTOK = 5;
/** The backend's `api_usage::MAX_LIMIT`, billed tokens. */
const MAX_API_LIMIT_TOKENS = 1_000_000_000_000;
const MILLION = 1_000_000;

/** A typed limit (million billed tokens) as whole billed tokens, or `null`
 *  when it is not a usable one. */
function parseApiLimit(text: string): number | null {
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(n)) return null;
  const tokens = Math.round(n * MILLION);
  return tokens > 0 && tokens <= MAX_API_LIMIT_TOKENS ? tokens : null;
}

/** Billed tokens as the limit field shows them: millions, no trailing zeros. */
const asMillions = (tokens: number) => String(Number((tokens / MILLION).toFixed(6)));

const usd = (n: number) => `$${n.toFixed(2)}`;
const tokenCount = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Provider names as their vendors spell them. */
const API_KEY_PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openai: "OpenAI",
};

/** What a CLI's agents run on: its own login, the user's own API key, or a
 *  hosted server administrator's key (#2389). */
type Credential = "login" | "key" | "admin";

/** The CLIs that can take a stored key through the API proxy (the backend's
 *  `CLI_ROUTES`: only CLIs the spawn alone can point at the proxy), each
 *  with its own pill — literal ids, which is what `scripts/untested.mjs` reads. */
const API_KEY_CLIS: { cli: string; untested: UntestedId }[] = [
  { cli: "claude", untested: "settings.agentApiKeys.claude" },
  { cli: "gemini", untested: "settings.agentApiKeys.gemini" },
  { cli: "codex", untested: "settings.agentApiKeys.codex" },
  { cli: "opencode", untested: "settings.agentApiKeys.opencode" },
];

/** Provider API keys for the agent CLIs: one key per provider, kept in the OS
 *  keyring only — typed here, saved, never read back — and a switch per CLI
 *  that should start on it (`agent_api_key_clis`, off by default). A keyed tab
 *  gets a proxy token, never the key (`services::api_proxy`). */
export function AgentApiKeysRows({ onChange }: { onChange?: () => void }) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [status, setStatus] = useState<AgentApiKeyStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A key waiting for its workspace: held here (never in the page) only
  // until the user picks one or cancels.
  const pendingKey = useRef<Record<string, string>>({});
  const [picking, setPicking] = useState<{ provider: string; workspaces: { id: string; name: string }[] } | null>(null);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const refresh = () => {
    invoke<AgentApiKeyStatus>("agent_api_keys_status")
      .then(setStatus)
      .catch(() => setStatus(null));
  };
  useEffect(refresh, []);
  const labels = useMemo(() => new Map(AGENT_ITEMS.map((a) => [a.cmd, a.label])), []);
  if (!status) return null;
  const saved = new Set(status.providers.filter((p) => p.saved).map((p) => p.id));
  const enabled = settings?.agent_api_key_clis ?? [];
  const limits = settings?.agent_api_token_limits ?? {};
  // A new key's row proposes the default; a saved key's shows its limit.
  const limitDraft = (id: string, current?: number | null) => {
    const tokens = current ?? limits[id];
    return limitDrafts[id] ?? (tokens != null ? asMillions(tokens) : String(DEFAULT_API_LIMIT_MTOK));
  };
  const writeLimit = (id: string, limit: number) =>
    updateSettings({ agent_api_token_limits: { ...limits, [id]: limit } });
  const act = (id: string, call: () => Promise<unknown>) => {
    setError(null);
    setBusy(id);
    call()
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        setBusy(null);
        refresh();
        onChange?.();
      });
  };
  const save = (id: string) => {
    const key = (drafts[id] ?? "").trim();
    // A key is only saved with a monthly limit: the limit goes first, so the
    // backend (which refuses a key without one) finds it.
    const limit = parseApiLimit(limitDraft(id));
    if (!key || limit === null) return;
    // Out of the page at once, saved or not: the key is never kept around.
    setDrafts((d) => ({ ...d, [id]: "" }));
    act(id, async () => {
      await writeLimit(id, limit);
      const answer = await invoke<ApiKeySave | null>("agent_api_key_set", { provider: id, key });
      if (answer?.kind === "pickWorkspace") {
        pendingKey.current[id] = key;
        setWorkspaceDraft(answer.workspaces[0]?.id ?? "");
        setPicking({ provider: id, workspaces: answer.workspaces });
      }
    });
  };
  const endPicking = (id: string) => {
    delete pendingKey.current[id];
    setPicking(null);
    setWorkspaceDraft("");
  };
  // Saved with the picked workspace; refused (one the key cannot use), the
  // picker stays for another choice.
  const saveWorkspace = (id: string) => {
    const key = pendingKey.current[id];
    const workspace = workspaceDraft.trim();
    if (!key || !workspace) return;
    act(id, async () => {
      await invoke("agent_api_key_set", { provider: id, key, workspace });
      endPicking(id);
    });
  };
  const setLimit = (id: string) => {
    const limit = parseApiLimit(limitDraft(id));
    if (limit === null) return;
    act(id, async () => {
      await writeLimit(id, limit);
      setLimitDrafts((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      });
    });
  };
  // The own-key switch lives in the shared settings; the administrator's key
  // is the user's choice on the server (`agent_login_use_admin_key`, which
  // also switches the own key off — written here first, so the settings
  // store never holds a stale switch).
  const setCredential = (cli: string, from: Credential, to: Credential) => {
    if (from === to) return;
    const others = enabled.filter((c) => c !== cli);
    act(cli, async () => {
      if (from === "admin") await invoke("agent_login_use_admin_key", { id: cli, on: false });
      if (from === "key") await updateSettings({ agent_api_key_clis: others });
      if (to === "key") await updateSettings({ agent_api_key_clis: [...others, cli] });
      if (to === "admin") await invoke("agent_login_use_admin_key", { id: cli, on: true });
    });
  };
  return (
    <div className="agents-block">
      <div className="settings-subheader">
        {t("settings.agentApiKeys")} <UntestedTag id="settings.agentApiKeys" />
      </div>
      <p className="settings-help">
        {t("settings.agentApiLimitHelp", { date: status.resetsOn ?? "", priced: status.pricesDate ?? "" })}{" "}
        <UntestedTag id="settings.agentApiKeys.limit" />
      </p>
      <AgentsFold label={t("agents.apiHowItWorks")}>
        <p className="settings-help">{t("settings.agentApiKeysHelp")}</p>
        <p className="settings-help">{t("settings.agentApiKeysWarning")}</p>
        <p className="settings-help">{t("settings.agentApiKeysDialogs")}</p>
        <p className="settings-help">{t("settings.agentApiKeysCodexHelp")}</p>
      </AgentsFold>
      {status.ledgerRestarted && (
        <p className="settings-help pill-fence-live-note">
          {t("settings.agentApiLedgerRestarted", { date: status.ledgerRestarted })}
        </p>
      )}
      {status.providers.map((p) => {
        const name = API_KEY_PROVIDERS[p.id] ?? p.id;
        const draft = drafts[p.id] ?? "";
        const limitText = limitDraft(p.id, p.limitTokens);
        const limitOk = parseApiLimit(limitText) !== null;
        const spent = tokenCount(p.billed ?? 0);
        const budget = !p.saved
          ? null
          : p.budget === "noLimit" || p.limitTokens == null
            ? t("settings.agentApiNoLimit")
            : p.budget === "reached"
              ? t("settings.agentApiBudgetReached", {
                  spent,
                  limit: tokenCount(p.limitTokens),
                  date: status.resetsOn ?? "",
                })
              : t("settings.agentApiSpent", {
                  spent,
                  limit: tokenCount(p.limitTokens),
                  left: tokenCount(Math.max(0, p.limitTokens - (p.billed ?? 0))),
                  usd: usd(p.spentUsd ?? 0),
                });
        const state = !status.readable
          ? t(status.store === "vault" ? "settings.agentApiKeyVaultLocked" : "settings.agentApiKeyLocked")
          : p.saved
            ? t("settings.agentApiKeySaved")
            : t("settings.agentApiKeyNotSaved");
        const limitInput = (
          <span className="agents-limit">
            <input
              type="number"
              className="agents-input agents-limit-input"
              min={0.000001}
              step="any"
              value={limitText}
              aria-label={t("settings.agentApiLimitLabel", { provider: name })}
              title={t("settings.agentApiLimitLabel", { provider: name })}
              disabled={busy === p.id}
              onChange={(e) => {
                const value = e.target.value;
                setLimitDrafts((d) => ({ ...d, [p.id]: value }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (p.saved ? setLimit : save)(p.id);
              }}
            />
            <span className="agents-limit-unit">{t("agents.apiLimitUnit")}</span>
          </span>
        );
        const blocked = p.saved && (p.budget === "reached" || p.budget === "noLimit");
        return (
          <Fragment key={p.id}>
            <div className="agents-row agents-key-row">
              <div className="agents-row-main">
                <span className="agents-row-name">{name}</span>
                <AgentsStatus tone={!status.readable ? "warn" : p.saved ? "ok" : "off"}>{state}</AgentsStatus>
                {budget && status.readable && (
                  <span className={`agents-row-note${blocked ? " is-warn" : ""}`}>{budget}</span>
                )}
                {p.saved && p.workspace && (
                  <span className="agents-row-note">{t("settings.agentApiWorkspace", { id: p.workspace })}</span>
                )}
              </div>
              <div className="agents-key-form">
                {status.readable && !p.saved && (
                  <PasswordInput
                    className="agents-input"
                    value={draft}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t("settings.agentApiKeyPlaceholder", { provider: name })}
                    aria-label={t("settings.agentApiKeyPlaceholder", { provider: name })}
                    disabled={busy === p.id}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDrafts((d) => ({ ...d, [p.id]: value }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") save(p.id);
                    }}
                  />
                )}
                {status.readable && limitInput}
                {status.readable && p.saved && (
                  <button
                    type="button"
                    className="settings-btn sm"
                    disabled={busy === p.id || !limitOk || parseApiLimit(limitText) === p.limitTokens}
                    onClick={() => setLimit(p.id)}
                  >
                    {t("settings.agentApiLimitSet")}
                  </button>
                )}
                {status.readable && !p.saved && (
                  <button
                    type="button"
                    className="settings-btn sm primary"
                    disabled={busy === p.id || !draft.trim() || !limitOk}
                    onClick={() => save(p.id)}
                  >
                    {t("settings.agentApiKeySave")}
                  </button>
                )}
                {status.readable && p.saved && (
                  <button
                    type="button"
                    className="settings-btn sm danger"
                    disabled={busy === p.id}
                    onClick={() => act(p.id, () => invoke("agent_api_key_clear", { provider: p.id }))}
                  >
                    {t("settings.agentApiKeyRemove")}
                  </button>
                )}
              </div>
            </div>
            {picking?.provider === p.id && !p.saved && (
              <div className="agents-row agents-key-row">
                <p className="settings-help">
                  {t(picking.workspaces.length > 0 ? "settings.agentApiWorkspacePick" : "settings.agentApiWorkspaceType")}{" "}
                  <UntestedTag id="settings.agentApiKeys.workspace" />
                </p>
                <div className="agents-key-form">
                  {picking.workspaces.length > 0 ? (
                    <Dropdown
                      title={t("settings.agentApiWorkspaceLabel")}
                      ariaLabel={t("settings.agentApiWorkspaceLabel")}
                      value={workspaceDraft}
                      disabled={busy === p.id}
                      options={picking.workspaces.map((w) => ({
                        value: w.id,
                        label: w.name === w.id ? w.id : `${w.name} (${w.id})`,
                      }))}
                      onChange={setWorkspaceDraft}
                    />
                  ) : (
                    <input
                      className="agents-input"
                      value={workspaceDraft}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="wrkspc_…"
                      aria-label={t("settings.agentApiWorkspaceLabel")}
                      disabled={busy === p.id}
                      onChange={(e) => setWorkspaceDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveWorkspace(p.id);
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className="settings-btn sm primary"
                    disabled={busy === p.id || !workspaceDraft.trim()}
                    onClick={() => saveWorkspace(p.id)}
                  >
                    {t("settings.agentApiKeySave")}
                  </button>
                  <button type="button" className="settings-btn sm" disabled={busy === p.id} onClick={() => endPicking(p.id)}>
                    {t("settings.agentApiWorkspaceCancel")}
                  </button>
                </div>
              </div>
            )}
            {p.saved && p.limitTokens == null && p.legacyLimitUsd != null && (
              <p className="settings-help pill-fence-live-note">
                {t("settings.agentApiOldUsdLimit", { usd: usd(p.legacyLimitUsd) })}
              </p>
            )}
            {status.readable &&
              (p.models ?? []).map((m) => (
                <p key={m.model} className="settings-help">
                  {[
                    t("settings.agentApiModelUsage", {
                      model: m.model,
                      input: tokenCount(m.input),
                      output: tokenCount(m.output),
                    }),
                    m.cacheRead > 0 && t("settings.agentApiModelCacheRead", { tokens: tokenCount(m.cacheRead) }),
                    m.cacheWrite > 0 && t("settings.agentApiModelCacheWrite", { tokens: tokenCount(m.cacheWrite) }),
                    `≈ ${usd(m.usd)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ))}
            {p.saved && (p.unknownModels?.length ?? 0) > 0 && (
              <p className="settings-help">
                {t("settings.agentApiUnknownModels", { provider: name, models: (p.unknownModels ?? []).join(", ") })}
              </p>
            )}
          </Fragment>
        );
      })}
      {!status.readable && status.store !== "vault" && (
        <div className="agents-actions">
          <button
            type="button"
            className="settings-btn sm primary"
            disabled={busy === "unlock"}
            onClick={() => act("unlock", unlockKeyring)}
          >
            {t("settings.agentApiKeyUnlock")}
          </button>
        </div>
      )}
      <div className="settings-subheader agents-subhead">{t("agents.credHeading")}</div>
      {API_KEY_CLIS.map(({ cli, untested }) => {
        const row = status.clis.find((c) => c.id === cli);
        if (!row) return null;
        const name = labels.get(cli) ?? cli;
        const keyed = row.providers.filter((p) => saved.has(p));
        const hasKey = keyed.length > 0;
        // One credential per CLI (#2389): its own login, the user's own API
        // key, or a hosted server administrator's key — never two at once.
        const current: Credential = row.usesAdmin ? "admin" : enabled.includes(cli) ? "key" : "login";
        const options = [
          { value: "login", label: t("settings.agentCredLogin") },
          ...(hasKey || current === "key"
            ? [
                {
                  value: "key",
                  label: t("settings.agentCredOwnKey", {
                    // Only the providers a key is saved for: the others
                    // stay on the CLI's own login (OpenCode).
                    providers: (hasKey ? keyed : row.providers).map((p) => API_KEY_PROVIDERS[p] ?? p).join(", "),
                  }),
                },
              ]
            : []),
          ...(row.adminOffered || current === "admin" ? [{ value: "admin", label: t("settings.agentCredAdminKey") }] : []),
        ];
        const broker = row.usesAdmin ? row.adminBroker : null;
        return (
          <Fragment key={cli}>
            <div className="agents-row">
              <div className="agents-row-main">
                <span className="agents-row-name">{t("settings.agentCredRunsOn", { cli: name })}</span>
                <UntestedTag id={untested} />
                {(row.adminOffered || row.usesAdmin) && <UntestedTag id="agents.adminKey" />}
                {broker && (
                  <span className="agents-row-note">
                    <UntestedTag id="server.agentKeys.broker" />{" "}
                    {broker.budget != null
                      ? t("settings.agentLoginBrokerUsage", {
                          billed: broker.billed.toLocaleString(),
                          budget: broker.budget.toLocaleString(),
                        })
                      : t("settings.agentLoginBrokerUsageNoCap", { billed: broker.billed.toLocaleString() })}
                  </span>
                )}
              </div>
              <Dropdown
                value={current}
                options={options}
                disabled={busy === cli || options.length < 2}
                ariaLabel={t("settings.agentCredRunsOn", { cli: name })}
                title={row.adminOffered && !row.usesAdmin ? t("settings.agentLoginAdminKeyHelp") : undefined}
                onChange={(next) => setCredential(cli, current, next as Credential)}
              />
            </div>
            {row.usesAdmin && !row.adminOffered && (
              <p className="settings-help pill-fence-live-note">{t("settings.agentLoginAdminKeyGone")}</p>
            )}
          </Fragment>
        );
      })}
      {error && <p className="settings-help">{error}</p>}
    </div>
  );
}

/** `agent_global_status` (`services::agent_global`). */
interface AgentGlobalLayer {
  dir: string;
  files: number;
  codexAutoReview: boolean;
}

/** The Tabtivity-wide agent config: the instructions, skills, hooks and MCP
 *  servers every agent home gets, filled from this computer in one click. */
function AgentGlobalRow() {
  const t = useT();
  const [layer, setLayer] = useState<AgentGlobalLayer | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => {
    invoke<AgentGlobalLayer>("agent_global_status")
      .then(setLayer)
      .catch(() => setLayer(null));
  };
  useEffect(refresh, []);
  const importNow = () => {
    setNote(null);
    setBusy(true);
    invoke<{ files: number; configs: number }>("agent_global_import")
      .then((r) => setNote(t("settings.agentGlobalImported", { files: r.files, configs: r.configs })))
      .catch((e: unknown) => setNote(String(e)))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };
  return (
    <div className="agents-block">
      <div className="settings-subheader">
        {t("settings.agentGlobal")} <UntestedTag id="settings.agentGlobal" />
        <AgentsHelp text={t("settings.agentGlobalHelp")} />
      </div>
      <div className="agents-row">
        <div className="agents-row-main">
          <AgentsStatus tone={layer && layer.files > 0 ? "ok" : "off"}>
            {layer && layer.files > 0
              ? t("settings.agentGlobalFiles", { count: layer.files })
              : t("settings.agentGlobalEmpty")}
          </AgentsStatus>
        </div>
        <div className="agents-actions">
          <button type="button" className="settings-btn sm" disabled={busy} onClick={importNow}>
            {t("settings.agentGlobalImport")}
          </button>
          <button
            type="button"
            className="settings-btn sm"
            onClick={() => void invoke("agent_global_open").catch((e: unknown) => setNote(String(e)))}
          >
            {t("settings.agentGlobalOpen")}
          </button>
        </div>
      </div>
      {note && <p className="settings-help">{note}</p>}
    </div>
  );
}

/** Codex auto-review (`approvals_reviewer` in the Tabtivity-wide layer's Codex
 *  config). On the Codex card, not under the fence settings: it is what makes
 *  fenced Codex usable, so it sits where a Codex user looks. */
function CodexAutoReviewToggle() {
  const t = useT();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => {
    invoke<AgentGlobalLayer>("agent_global_status")
      .then((l) => setOn(l.codexAutoReview))
      .catch(() => setOn(null));
  };
  useEffect(refresh, []);
  return (
    <div className="agents-option">
      <ToggleRow
        label={<>{t("settings.codexAutoReview")} <UntestedTag id="settings.codexAutoReview" /></>}
        checked={on ?? false}
        disabled={busy || on === null}
        onChange={(e) => {
          setNote(null);
          setBusy(true);
          invoke("agent_global_set_codex_auto_review", { enabled: e.target.checked })
            .catch((err: unknown) => setNote(String(err)))
            .finally(() => {
              setBusy(false);
              refresh();
            });
        }}
      />
      <p className="settings-help">{t("settings.codexAutoReviewHelp")}</p>
      {note && <p className="settings-help">{note}</p>}
    </div>
  );
}

/** `copilot_fence_auth_status`: the Copilot sign-in Tabtivity holds for fenced
 *  tabs (`services::copilot_auth`). Never carries the token itself. */
interface CopilotFenceAuth {
  supported: boolean;
  signedIn: boolean;
  login: string | null;
  valid: boolean | null;
}

/** Copilot sign-in for fenced tabs: who is signed in, and a way out. Hidden
 *  where the fence leaves the keyring reachable (everything but Linux). */
function CopilotFenceAuthRow() {
  const t = useT();
  const [auth, setAuth] = useState<CopilotFenceAuth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    invoke<CopilotFenceAuth>("copilot_fence_auth_status")
      .then(setAuth)
      .catch(() => setAuth(null));
  };
  useEffect(refresh, []);
  if (!auth?.supported) return null;

  const state = !auth.signedIn
    ? t("settings.copilotFenceAuthNone")
    : auth.valid === false
      ? t("settings.copilotFenceAuthExpired")
      : auth.login
        ? t("settings.copilotFenceAuthSignedIn", { login: auth.login })
        : t("settings.copilotFenceAuthSignedInOffline");

  return (
    <div className="agents-block">
      <div className="settings-subheader">
        {t("settings.copilotFenceAuth")} <UntestedTag id="settings.copilotFenceAuth" />
        <AgentsHelp text={t("settings.copilotFenceAuthHelp")} />
      </div>
      <div className="agents-row">
        <div className="agents-row-main">
          <AgentsStatus tone={auth.signedIn && auth.valid !== false ? "ok" : auth.signedIn ? "warn" : "off"}>
            {state}
          </AgentsStatus>
        </div>
        {auth.signedIn && (
          <div className="agents-actions">
            <button
              type="button"
              className="settings-btn sm danger"
              onClick={() => {
                setError(null);
                invoke("copilot_fence_sign_out")
                  .then(refresh)
                  .catch((e: unknown) => setError(String(e)));
              }}
            >
              {t("settings.copilotFenceAuthSignOut")}
            </button>
          </div>
        )}
      </div>
      {error && <p className="settings-help">{error}</p>}
    </div>
  );
}

/** The Accounts & keys group: every credential an agent can run on, and the
 *  config every agent home starts from. `onChange` tells the CLI cards that a
 *  login or key changed, so their sign-in line re-reads. */
function AgentAccounts({ onChange }: { onChange?: () => void }) {
  // Bumped by the API keys rows, so the logins re-read their "uses API key".
  const [apiKeysVersion, setApiKeysVersion] = useState(0);
  return (
    <div className="agents-stack">
      <AgentLoginsRows refreshKey={apiKeysVersion} onChange={onChange} />
      <AgentApiKeysRows
        onChange={() => {
          setApiKeysVersion((v) => v + 1);
          onChange?.();
        }}
      />
      <AgentGlobalRow />
      <CopilotFenceAuthRow />
    </div>
  );
}

/** The Agent sandbox group. There is no switch for the sandbox itself: what is
 *  here is what it may additionally reveal. */
function AgentFenceCard() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const stored = settings?.agent_fence_paths;
  const effective = stored ?? [...AGENT_FENCE_DEFAULT_PATHS];
  const [paths, setPaths] = useState(effective.join("\n"));
  useEffect(() => {
    setPaths((stored ?? [...AGENT_FENCE_DEFAULT_PATHS]).join("\n"));
  }, [stored]);
  const dirty = parseAgentFencePaths(paths).join("\n") !== effective.join("\n");

  const savePaths = () => {
    const next = parseAgentFencePaths(paths);
    setPaths(next.join("\n"));
    void updateSettings({ agent_fence_paths: next });
  };

  return (
    <div className="agents-stack">
      <p className="settings-help">{t("settings.agentFenceHelp")}</p>
      <AgentsFold label={t("agents.fenceLimits")}>
        <p className="settings-help">{t("settings.agentFenceLimits")}</p>
        <p className="settings-help">{t("settings.agentFenceSharedState")}</p>
      </AgentsFold>
      <div className="agents-option">
        <ToggleRow
          label={<>{t("settings.agentFenceCargoCredentials")} <UntestedTag id="settings.agentFenceCargoCredentials" /></>}
          checked={settings?.agent_fence_cargo_credentials ?? false}
          onChange={(e) => void updateSettings({ agent_fence_cargo_credentials: e.target.checked })}
        />
        <p className="settings-help">{t("settings.agentFenceCargoCredentialsHelp")}</p>
      </div>
      {settings?.agent_fence_platform_accepted && (
        // Only once given: the acceptance a fence-less platform (Windows) asks
        // for before the first agent tab. Switching it off asks again next time.
        <div className="agents-option">
          <ToggleRow
            label={<>{t("settings.agentFencePlatformAccepted")} <UntestedTag id="settings.agentFencePlatformAccepted" /></>}
            checked
            onChange={() => void updateSettings({ agent_fence_platform_accepted: false })}
          />
          <p className="settings-help">{t("settings.agentFencePlatformAcceptedHelp")}</p>
        </div>
      )}
      <div className="agents-option">
        <ToggleRow
          label={<>{t("settings.rootFenceProjects")} <UntestedTag id="settings.rootFenceProjects" /></>}
          checked={settings?.root_fence_projects_readable ?? false}
          onChange={(e) => void updateSettings({ root_fence_projects_readable: e.target.checked })}
        />
        <p className="settings-help">{t("settings.rootFenceProjectsHelp")}</p>
      </div>
      <div className="agents-block">
        <div className="settings-subheader">
          <label htmlFor="agent-fence-paths">{t("settings.agentFencePaths")}</label>
          <AgentsHelp text={t("settings.agentFencePathsHelp")} />
          {dirty && <AgentsStatus tone="warn">{t("agents.fenceUnsaved")}</AgentsStatus>}
        </div>
        <textarea
          id="agent-fence-paths"
          className="ollama-pull-input"
          rows={8}
          value={paths}
          spellCheck={false}
          onChange={(event) => setPaths(event.target.value)}
          onBlur={savePaths}
          aria-label={t("settings.agentFencePaths")}
        />
        <div className="agents-actions">
          <button
            type="button"
            className="settings-btn sm"
            onClick={() => {
              setPaths(AGENT_FENCE_DEFAULT_PATHS.join("\n"));
              void updateSettings({ agent_fence_paths: undefined });
            }}
          >
            {t("settings.agentFenceReset")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** npm's words for "this package wants a newer Node" — a warning it installs
 *  through anyway (the CLI then fails at start) or the error it stops on. */
const NODE_ENGINE_FAILURE = /EBADENGINE|Unsupported engine|engine "node" is incompatible/i;

/** The host's Node.js as `node_runtime_status` reports it; null while probing
 *  (or when the probe failed, which shows nothing). */
function useNodeRuntimeStatus() {
  const [status, setStatus] = useState<NodeRuntimeStatus | null>(null);
  const recheck = () =>
    void invoke<NodeRuntimeStatus>("node_runtime_status")
      .then(setStatus)
      .catch(() => setStatus(null));
  useEffect(() => recheck(), []);
  return { status, recheck };
}

/**
 * "Install Node/npm first" helper for the Manage Agents panel. Most agent CLIs
 * install through `npm`, so when `npm` isn't on the host's PATH — or the Node
 * that is there is older than the current LTS the CLIs require — this points
 * the user at the one-click, no-admin Node install for their OS. Follows
 * Tabtivity's install-via-terminal-tab policy. The panel owns the probe
 * ({@link useNodeRuntimeStatus}) because the two cases sit in different places:
 * a missing npm blocks every install and goes above the CLIs, while an old Node
 * is fine for most of them and shows only in the card of an install npm
 * refused for it ({@link NODE_ENGINE_FAILURE}).
 */
function NodeRuntimeNotice({
  status,
  onRecheck,
}: {
  status: NodeRuntimeStatus;
  onRecheck: () => void;
}) {
  const t = useT();
  const tooOld = status.npm && status.too_old;

  const { command, shellKey, shellKind } = NODE_INSTALL[HOST_OS];
  return (
    <div className="agents-notice is-warn">
      <div className="agents-notice-head">
        <span className="agents-notice-title">Node.js / npm</span>
        <AgentsStatus tone="warn">
          {tooOld
            ? t("agents.nodeTooOld", {
                // "v22.22.1" would read "V22.22.1" under the status text's
                // capitalised first letter.
                version: (status.version ?? "").replace(/^v/, ""),
                min: status.min_major,
              })
            : t("agents.nodeNotDetected")}
        </AgentsStatus>
        {tooOld && <UntestedTag id="settingsSubPanels.1" />}
      </div>
      {tooOld ? (
        <p className="settings-help">
          {t("agents.nodeTooOldHelpPre", { min: status.min_major })}{" "}
          <strong>{t(shellKey)}</strong> {t("agents.nodeTooOldHelpPost")}
        </p>
      ) : (
        <p className="settings-help">
          {t("agents.nodeHelpPre")} <code>npm</code> {t("agents.nodeHelpMid")}{" "}
          <strong>{t(shellKey)}</strong> {t("agents.nodeHelpPost")}
        </p>
      )}
      <div className="ollama-install-cmd-row">
        <code className="ollama-install-cmd">{command}</code>
        <button
          type="button"
          className="settings-btn sm primary"
          onClick={() => runInstallInTab(t("install.nodeTabLabel"), command, shellKind)}
        >
          {t("agents.runInTerminal")}
        </button>
        <button type="button" className="settings-btn sm" onClick={onRecheck}>
          {t("common.recheck")}
        </button>
      </div>
      <p className="settings-help">
        {t("agents.nodeManualPre")}{" "}
        <a href={NODE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
          {t("agents.nodeDownloads")}
        </a>
        .
      </p>
    </div>
  );
}

/**
 * A list of local times ("HH:MM"), edited as chips plus an hour/minute picker.
 *
 * The app's own {@link Dropdown} rather than a native `<select>` (WebKitGTK
 * draws that as an unthemed OS menu — the note on the remote-machine picker
 * above) and rather than an `<input type="time">`, which takes its 12-vs-24-hour
 * face from the process locale and ignores both the element's `lang` and
 * `Settings.time_format_24h` (`common/TimeField`'s header documents the probe).
 * Two lists of numbers have neither problem and nothing to mistype.
 *
 * Stored values are always 24-hour; only the chips are printed through the
 * user's clock setting, so the picker says the same thing the board and the
 * calendar do.
 */
function TimeListEditor({
  times,
  onChange,
  disabled,
  emptyLabel,
}: {
  times: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** What to show in place of the chips when the list is empty — "no times yet"
   *  for the global list, "follows the global times" for an agent's own. */
  emptyLabel: string;
}) {
  const t = useT();
  const use24h = useUse24h();
  const [hour, setHour] = useState("09");
  const [minute, setMinute] = useState("00");

  const hours = useMemo(
    () => Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((v) => ({ value: v, label: v })),
    [],
  );
  const minutes = useMemo(
    () => Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((v) => ({ value: v, label: v })),
    [],
  );
  const pending = `${hour}:${minute}`;

  return (
    <div className="agent-cron-times">
      <div className="agent-cron-chips">
        {times.length === 0 ? (
          <span className="agent-cron-empty">{emptyLabel}</span>
        ) : (
          times.map((time) => (
            <span key={time} className="agent-cron-chip">
              {formatTime(time, use24h)}
              <button
                type="button"
                className="agent-cron-chip-remove"
                title={t("agentCron.removeTime", { time })}
                aria-label={t("agentCron.removeTime", { time })}
                disabled={disabled}
                onClick={() => onChange(removeTime(times, time))}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      <div className="agent-cron-add">
        <Dropdown
          className="agent-cron-unit"
          title={t("agentCron.hourAria")}
          value={hour}
          options={hours}
          disabled={disabled}
          onChange={setHour}
        />
        <span className="agent-cron-colon">:</span>
        <Dropdown
          className="agent-cron-unit"
          title={t("agentCron.minuteAria")}
          value={minute}
          options={minutes}
          disabled={disabled}
          onChange={setMinute}
        />
        <button
          type="button"
          className="settings-btn sm"
          disabled={disabled || times.includes(pending)}
          onClick={() => onChange(addTime(times, pending))}
        >
          {t("agentCron.addTime")}
        </button>
      </div>
    </div>
  );
}

/** "Next: 06:00 tomorrow", or nothing when this agent is not scheduled. */
function NextRunLabel({ cron, cmd }: { cron: AgentCron | undefined; cmd: string }) {
  const t = useT();
  const use24h = useUse24h();
  // Read once per render rather than on a ticking clock: this is a settings
  // panel, and a readout that only refreshes when something is edited is the
  // honest cost of not running a timer behind a screen nobody is watching.
  const now = new Date();
  const next = nextAgentCronRun(cron, cmd, now);
  if (!next) return null;
  const time = formatTime(
    `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`,
    use24h,
  );
  const tomorrow = next.getDate() !== now.getDate();
  return (
    <span className="agent-cron-next">
      {t(tomorrow ? "agentCron.nextTomorrow" : "agentCron.nextToday", { time })}
    </span>
  );
}

/**
 * The scheduled warm-up's global half: the master switch and the time list every
 * participating agent follows unless it names its own.
 *
 * It sits at the top of this panel rather than in a settings section of its own
 * because the thing it schedules is *these* rows — participation is per agent,
 * ticked on the agent's own card a few lines below, and a global switch two
 * panels away from the per-agent one is how half a schedule ends up armed.
 */
/**
 * The prefix chips and model names the side panel's per-tab agent composer
 * offers, per agent.
 *
 * Editable rather than hardcoded because both lists date faster than the app
 * ships: a CLI adds a slash command in a point release and renames its models
 * more often than that. What is NOT offered here is a permission or plan mode —
 * an agent's authority is set through the agent's own CLI, and every entry in
 * these lists is literally typed into it (see `lib/agents/agentPrefaces`).
 *
 * An agent the user has never touched carries no stored entry at all and falls
 * back to the defaults; "Use defaults" deletes the key rather than writing the
 * defaults out, so a later change to them still reaches that agent. An
 * explicitly EMPTY list is kept, because "no chips for this one" is a decision.
 */
function AgentComposerCard({ agents }: { agents: AgentInfo[] | null }) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [agentId, setAgentId] = useState("claude");
  const [command, setCommand] = useState("");
  const [modelName, setModelName] = useState("");
  const [error, setError] = useState("");

  const installed = (agents ?? []).filter((agent) => agent.installed);
  // Fall back to the agents that have defaults, so the card is usable before
  // `list_agents` lands and on a machine with nothing installed yet.
  const options = installed.length > 0
    ? installed.map((agent) => ({ value: agent.id, label: agent.label }))
    : Object.keys(DEFAULT_PREFACE_COMMANDS).map((id) => ({ value: id, label: id }));
  const key = agentComposerKey(agentId);
  const commands = prefaceCommandsFor(agentId, settings?.agent_preface_commands);
  const models = agentModelsFor(agentId, settings?.agent_models);

  const writeCommands = (next: string[]) => {
    void updateSettings({
      agent_preface_commands: { ...(settings?.agent_preface_commands ?? {}), [key]: next },
    });
  };
  const writeModels = (next: string[]) => {
    void updateSettings({
      agent_models: { ...(settings?.agent_models ?? {}), [key]: next },
    });
  };
  const useDefaults = () => {
    const { [key]: _dropCommands, ...restCommands } = settings?.agent_preface_commands ?? {};
    const { [key]: _dropModels, ...restModels } = settings?.agent_models ?? {};
    void updateSettings({ agent_preface_commands: restCommands, agent_models: restModels });
    setError("");
  };

  const move = (list: string[], index: number, delta: number): string[] => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return list;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  };

  const addCommand = () => {
    const clean = sanitizePrefaceCommand(command);
    if (!clean) {
      setError(t("agents.composerInvalidCommand"));
      return;
    }
    if (commands.length >= MAX_PREFACE_COMMANDS) {
      setError(t("agents.composerLimit", { count: String(MAX_PREFACE_COMMANDS) }));
      return;
    }
    setError("");
    setCommand("");
    if (!commands.includes(clean)) writeCommands([...commands, clean]);
  };

  const addModel = () => {
    const clean = modelName.trim();
    if (!clean) return;
    setModelName("");
    if (!models.includes(clean)) writeModels([...models, clean]);
  };

  const listEditor = (
    entries: string[],
    write: (next: string[]) => void,
    emptyKey: TranslationKey,
  ) => (
    entries.length === 0 ? (
      <p className="settings-help">{t(emptyKey)}</p>
    ) : (
      <SettingsList boxed>
        {entries.map((entry, index) => (
          <div className="settings-row" key={entry}>
            <code style={{ flex: 1, minWidth: 0 }}>{entry}</code>
            <button
              type="button"
              className="settings-btn sm icon"
              title={t("agents.composerMoveUp")}
              disabled={index === 0}
              onClick={() => write(move(entries, index, -1))}
            >
              ↑
            </button>
            <button
              type="button"
              className="settings-btn sm icon"
              title={t("agents.composerMoveDown")}
              disabled={index === entries.length - 1}
              onClick={() => write(move(entries, index, 1))}
            >
              ↓
            </button>
            <button
              type="button"
              className="settings-btn sm icon danger"
              title={t("agents.composerRemove")}
              onClick={() => write(entries.filter((_, at) => at !== index))}
            >
              ✕
            </button>
          </div>
        ))}
      </SettingsList>
    )
  );

  return (
    <div className="agents-stack">
      <p className="settings-help">{t("agents.composerHelp")}</p>
      <div className="settings-card-row">
        <span>{t("agents.composerAgent")}</span>
        <Dropdown
          value={agentId}
          options={options}
          onChange={(value) => { setAgentId(value); setError(""); }}
          title={t("agents.composerAgent")}
        />
        <button type="button" className="settings-btn sm" onClick={useDefaults}>
          {t("agents.composerReset")}
        </button>
      </div>

      <div className="settings-subheader">{t("agents.composerCommands")}</div>
      {listEditor(commands, writeCommands, "agents.composerNoCommands")}
      <div className="ollama-install-cmd-row">
        <input
          type="text"
          className="ollama-pull-input"
          placeholder={t("agents.composerAddCommand")}
          aria-label={t("agents.composerAddCommand")}
          value={command}
          spellCheck={false}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") addCommand(); }}
        />
        <button type="button" className="settings-btn sm" onClick={addCommand}>
          {t("agents.composerAdd")}
        </button>
      </div>
      {error && <ErrorNote className="project-dialog-error" error={error} />}

      <div className="settings-subheader">{t("agents.composerModels")}</div>
      {listEditor(models, writeModels, "agents.composerNoModels")}
      <div className="ollama-install-cmd-row">
        <input
          type="text"
          className="ollama-pull-input"
          placeholder={t("agents.composerAddModel")}
          aria-label={t("agents.composerAddModel")}
          value={modelName}
          spellCheck={false}
          onChange={(event) => setModelName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") addModel(); }}
        />
        <button type="button" className="settings-btn sm" onClick={addModel}>
          {t("agents.composerAdd")}
        </button>
      </div>
    </div>
  );
}

function AgentCronSection({ agents }: { agents: AgentInfo[] | null }) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const cron = settings?.agent_cron;
  const enabled = cron?.enabled === true;
  const times = normalizeTimes(cron?.times);
  // Only an installed agent can be scheduled — a missing CLI would fail once a
  // day, silently, at six in the morning — and only one the backend has a
  // one-shot recipe for can be driven at all. The rest are still listed, greyed
  // with the reason, so "why isn't X here?" never has to be asked.
  const installed = (agents ?? []).filter((a) => a.installed);
  const capable = installed.filter((a) => a.warmup === true).map((a) => a.id);
  const all = allAgentsEnabled(cron, capable);

  return (
    <div className="agents-stack">
      <p className="settings-help">{t("agentCron.help", { message: AGENT_CRON_MESSAGE })}</p>
      <AgentsFold label={t("agents.cronWhenItRuns")}>
        <p className="settings-help">{t("agentCron.runningNote")}</p>
      </AgentsFold>
      <ToggleRow
        label={t("agentCron.enable")}
        checked={enabled}
        onChange={(e) => void updateSettings({ agent_cron: withCronEnabled(cron, e.target.checked) })}
      />
      <div className="agent-cron-block">
        <span className="agent-cron-label">{t("agentCron.globalTimes")}</span>
        <TimeListEditor
          times={times}
          disabled={!enabled}
          emptyLabel={t("agentCron.noTimes")}
          onChange={(next) => void updateSettings({ agent_cron: withGlobalTimes(cron, next) })}
        />
      </div>
      <p className="settings-help">{t("agentCron.globalTimesHelp")}</p>
      <div className="agent-cron-agents">
        <span className="agent-cron-label">{t("agentCron.agentsTitle")}</span>
        {/* One switch for everyone, default off: a bulk flip of the same
            per-agent flags the rows below write, so it reads as "all on" only
            when every capable agent is on, and turning one row off turns it
            back off — never a separate mode the rows would have to argue with. */}
        <ToggleRow
          label={t("agentCron.allAgents")}
          checked={all}
          disabled={!enabled || capable.length === 0}
          title={t("agentCron.allAgentsTitle")}
          onChange={(e) => void updateSettings({ agent_cron: withAllAgentsEnabled(cron, capable, e.target.checked) })}
        />
        {agents === null ? (
          <span className="agent-cron-empty">{t("agents.checkingInstalled")}</span>
        ) : installed.length === 0 ? (
          <span className="agent-cron-empty">{t("agentCron.noAgents")}</span>
        ) : (
          <>
            {/* The same button grid as Project Settings' file-hiding endings —
                one pressed/unpressed button per agent, so twenty CLIs read at
                a glance instead of twenty toggle rows. Muted is off. A CLI the
                backend cannot drive is disabled with the reason in its tip. */}
            <div className="settings-list project-ending-list agent-cron-grid">
              {installed.map((a) => {
                const headless = a.warmup === true;
                const on = headless && cron?.agents?.[a.id]?.enabled === true;
                return (
                  <button
                    type="button"
                    key={a.id}
                    className={`project-ending-toggle${on ? "" : " is-hidden"}`}
                    aria-pressed={on}
                    disabled={!enabled || !headless}
                    onClick={() => void updateSettings({ agent_cron: withAgentCronEnabled(cron, a.id, !on) })}
                    title={
                      !headless
                        ? t("agentCron.noHeadless", { label: a.label })
                        : t(on ? "agentCron.gridOff" : "agentCron.gridOn", { label: a.label, message: AGENT_CRON_MESSAGE })
                    }
                  >
                    {a.label}
                  </button>
                );
              })}
            </div>
            {/* Own times only for the agents that are on: the grid is the
                overview, and a time editor per switched-off agent would bury it. */}
            {installed
              .filter((a) => a.warmup === true && cron?.agents?.[a.id]?.enabled === true)
              .map((a) => (
                <AgentCronRow key={a.id} cmd={a.id} label={a.label} />
              ))}
          </>
        )}
      </div>
    </div>
  );
}

/** One switched-on agent's own times: the list it runs on when the global one
 *  is not what it wants, and when it fires next. Rendered under the grid only
 *  for agents that are on — participation itself is the grid button. */
function AgentCronRow({ cmd, label }: { cmd: string; label: string }) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const cron = settings?.agent_cron;
  const master = cron?.enabled === true;
  const own = normalizeTimes(cron?.agents?.[cmd]?.times);
  const effective = agentCronTimes(cron, cmd);

  return (
    <div className="agent-cron-row">
      <span className="agent-cron-name">{label}</span>
      <TimeListEditor
        times={own}
        disabled={!master}
        emptyLabel={t("agentCron.followsGlobal")}
        onChange={(next) => void updateSettings({ agent_cron: withAgentCronTimes(cron, cmd, next) })}
      />
      {/* An agent ticked on with no times anywhere is armed and can never
          fire — the one state the schedule cannot express as a "next run",
          and therefore the one that has to be said out loud. */}
      {effective.length === 0 ? (
        <span className="agent-cron-warn">{t("agentCron.needsTimes")}</span>
      ) : (
        <NextRunLabel cron={cron} cmd={cmd} />
      )}
    </div>
  );
}

const NO_CUSTOM_AGENTS: CustomAgent[] = [];

/**
 * "Manage Agents" panel: detect and one-click-install the AI coding-agent CLIs
 * Tabtivity can launch as agent tabs (Claude, Codex, Google Antigravity, Google
 * Gemini, Mistral/vibe, Aider, OpenCode, Cursor, Copilot, Grok, Qwen, OpenClaw).
 * The
 * registry lives in the backend (`commands::agents`); this just renders each
 * entry with an install button, a live install log, and a manual fallback.
 */
export function AgentsPanel({
  onBack,
  onClose,
  installedExtras,
}: SubPanelProps & {
  /** Rendered at the end of each **installed** card. The Models & agents
   *  overlay passes the dropdown's Default · + tab · Root · MCP chips
   *  (`AgentChips`); Settings passes nothing, so its cards are unchanged. */
  installedExtras?: (a: AgentInfo) => ReactNode;
}) {
  const t = useT();
  // A hosted server: the administrator installs CLIs (#2354).
  const adminInstalls = cliInstallsByAdmin();
  const { settings, updateSettings } = useSettingsStore();
  const remoteMachines = useGlobalMachinesStore((s) => s.machines);
  const remoteMachinesLoaded = useGlobalMachinesStore((s) => s.loaded);
  const loadRemoteMachines = useGlobalMachinesStore((s) => s.load);
  const disabledAgents = settings?.disabled_agents ?? [];
  const setAgentDisabled = (id: string, disabled: boolean) => {
    const next = disabled
      ? [...disabledAgents, id]
      : disabledAgents.filter((a) => a !== id);
    void updateSettings({ disabled_agents: next });
  };
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  // The agent id whose installer is currently running (only one at a time).
  const [installing, setInstalling] = useState<string | null>(null);
  // The agent id currently being removed (Remove, or the first half of
  // Reinstall) — disjoint from `installing` so the two actions never overlap.
  const [removing, setRemoving] = useState<string | null>(null);
  // Per-agent live install log, keyed by agent id.
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Per-agent target selection and failure for explicit installs on a global
  // remote machine. This is independent of local `installed`: each machine has
  // its own CLI state.
  const [remoteTargets, setRemoteTargets] = useState<Record<string, string>>({});
  const [remoteErrors, setRemoteErrors] = useState<Record<string, string>>({});
  // Per-agent installed version + drift verdict, keyed by agent id.
  const [versions, setVersions] = useState<Record<string, AgentVersionReport>>({});
  const [checkingVersions, setCheckingVersions] = useState(false);
  // Newest published release per installed CLI — only after a click.
  const [updates, setUpdates] = useState<Record<string, AgentUpdateReport>>({});
  /** The CLIs whose own "Check for update" is in flight. */
  const [checkingUpdates, setCheckingUpdates] = useState<Record<string, true>>({});
  // Filter over the *not installed* half only (see the two sections below).
  const [search, setSearch] = useState("");
  const node = useNodeRuntimeStatus();
  // The shared sign-in each installed card reports (`agent_logins`, read only;
  // the Accounts & keys group owns the import and sign-out). Re-read when that
  // group changes one.
  const [logins, setLogins] = useState<Map<string, AgentLogin>>(() => new Map());
  const [loginsVersion, setLoginsVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    invoke<AgentLogin[]>("agent_logins")
      .then((rows) => {
        if (!cancelled && Array.isArray(rows)) setLogins(new Map(rows.map((l) => [l.id, l])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loginsVersion]);
  const logRef = useRef<HTMLPreElement>(null);
  const shortcutOverrides = useShortcutOverrides();
  const customAgents = settings?.custom_agents ?? NO_CUSTOM_AGENTS;
  // Custom agents whose command is on PATH — the + menu's own probe, so a
  // missing one takes no number here either.
  const [installedCustom, setInstalledCustom] = useState<Set<string> | null>(null);
  const customCmdsKey = customAgents.map((ca) => ca.cmd).join("\n");
  useEffect(() => {
    const cmds = customCmdsKey ? customCmdsKey.split("\n") : [];
    if (cmds.length === 0) {
      setInstalledCustom(new Set());
      return;
    }
    invoke<string[]>("probe_binaries", { bins: cmds })
      .then((found) => setInstalledCustom(new Set(found)))
      .catch(() => setInstalledCustom(new Set()));
  }, [customCmdsKey]);

  const refresh = () => {
    invoke<AgentInfo[]>("list_agents").then(setAgents).catch(() => setAgents([]));
  };
  useEffect(refresh, []);
  // Version drift is read separately from the agent list on purpose: listing
  // agents is a PATH lookup, this spawns every installed CLI once. The backend
  // caches for a day while executables are unchanged; `true` means "ask them
  // again now".
  const loadVersions = (recheck: boolean) => {
    setCheckingVersions(true);
    invoke<AgentVersionReport[]>("agent_versions", { refresh: recheck })
      .then((rows) => {
        setVersions(Object.fromEntries(rows.map((row) => [row.agent, row])));
        useAgentVersionNoticeStore.getState().update(rows);
      })
      .catch(() => {})
      .finally(() => setCheckingVersions(false));
  };
  useEffect(() => loadVersions(false), []);
  useEffect(() => {
    if (!remoteMachinesLoaded) void loadRemoteMachines();
  }, [loadRemoteMachines, remoteMachinesLoaded]);

  // Keep the live install log pinned to its latest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, installing]);

  const appendAgentLog = (id: string, p: { id: string; line: string }) => {
    if (p.id !== id) return;
    setLogs((l) => ({ ...l, [id]: l[id] ? `${l[id]}\n${p.line}` : p.line }));
  };

  const installAgent = async (id: string) => {
    setInstalling(id);
    setErrors(({ [id]: _drop, ...rest }) => rest);
    setLogs((l) => ({ ...l, [id]: "" }));
    try {
      // Stream the installer's output, filtering to this agent's events.
      await runWithProgress<{ id: string; line: string }, string>(
        "agent-install-progress",
        (p) => appendAgentLog(id, p),
        () => invoke<string>("install_agent", { id }),
      );
      refresh();
      notifyAgentRegistryChanged();
      loadVersions(true);
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: String(err) }));
    } finally {
      setInstalling(null);
    }
  };

  // Ask one CLI's registry for its newest release — each card's own button, the
  // agent twin of the local-model "Check for Ollama updates" row, and like it
  // explicit only: one request, when clicked and at no other time. The backend
  // re-reads the installed versions first, so the version chips refresh too.
  const checkUpdate = (id: string) => {
    setCheckingUpdates((c) => ({ ...c, [id]: true }));
    invoke<AgentUpdateReport[]>("check_agent_updates", { id })
      .then((rows) => {
        setUpdates((u) => ({ ...u, ...Object.fromEntries(rows.map((row) => [row.agent, row])) }));
        loadVersions(false);
      })
      .catch(() =>
        setUpdates((u) => ({
          ...u,
          [id]: {
            agent: id,
            current: null,
            latest: null,
            updateAvailable: false,
            checkable: true,
            error: t("agents.updateCheckNoBackend"),
          },
        })),
      )
      .finally(() => setCheckingUpdates(({ [id]: _drop, ...rest }) => rest));
  };

  // Run the CLI's own installer again, which fetches the newest release (into
  // Tabtivity's install home, ahead of a host copy on PATH). Same live log as an
  // install; the card stays in the installed list throughout.
  const updateAgent = async (id: string) => {
    setInstalling(id);
    setErrors(({ [id]: _drop, ...rest }) => rest);
    setLogs((l) => ({ ...l, [id]: "" }));
    try {
      await runWithProgress<{ id: string; line: string }, string>(
        "agent-install-progress",
        (p) => appendAgentLog(id, p),
        () => invoke<string>("update_agent", { id }),
      );
      setUpdates(({ [id]: _drop, ...rest }) => rest);
      setLogs(({ [id]: _drop, ...rest }) => rest);
      refresh();
      notifyAgentRegistryChanged();
      loadVersions(true);
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: String(err) }));
    } finally {
      setInstalling(null);
    }
  };

  // Removes the detected binary (an npm-based agent goes through `npm
  // uninstall -g` instead, so the package doesn't linger — see `uninstall_agent`).
  // Returns whether it succeeded, so `reinstallAgent` knows whether to proceed.
  const removeAgent = async (id: string): Promise<boolean> => {
    setRemoving(id);
    setErrors(({ [id]: _drop, ...rest }) => rest);
    try {
      await invoke<string>("uninstall_agent", { id });
      refresh();
      notifyAgentRegistryChanged();
      loadVersions(true);
      return true;
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: String(err) }));
      return false;
    } finally {
      setRemoving(null);
    }
  };

  // Remove then immediately re-run the official installer — the one-click fix
  // for an install that half-succeeded (binary present but broken) or that
  // Tabtivity's stale detection missed (see paths.rs's Windows install-dir list).
  const reinstallAgent = async (id: string) => {
    if (await removeAgent(id)) await installAgent(id);
  };

  const recheck = (id: string) => {
    void invoke<boolean>("agent_is_installed", { id })
      .then((ok) => {
        setAgents((prev) =>
          prev?.map((a) => (a.id === id ? { ...a, installed: ok } : a)) ?? prev,
        );
        notifyAgentRegistryChanged();
        loadVersions(true);
        if (!ok) {
          setErrors((e) => ({
            ...e,
            [id]: t("agents.stillNotDetected"),
          }));
        }
      })
      .catch(() => {});
  };

  // Install a CLI on a remote machine, watched: the backend hands back an
  // `ssh -t` command line for the registry-owned install script, and
  // `runInstallInTab` types it into a root-terminal tab and brings the root
  // console up above this panel — so an npm install that takes minutes, an nvm
  // PATH that isn't there, or a prompt (sudo, a host key) is seen and
  // answerable, where a headless run reported one string only once it was over.
  // No spinner: the tab is the progress, and this call is over once it opens.
  // `machineId` comes from the card foot's one-click picker; the fold's
  // button passes none and uses the machine chosen in its own picker.
  const installAgentRemoteInTerminal = async (agent: AgentInfo, machineId = remoteTargets[agent.id]) => {
    const machine = remoteMachines.find((m) => m.id === machineId);
    if (!machine) return;
    setRemoteErrors(({ [agent.id]: _drop, ...rest }) => rest);
    try {
      const command = await invoke<string>("install_agent_remote_command", {
        agentId: agent.id,
        machineId: machine.id,
      });
      runInstallInTab(
        t("agents.installRemoteTabLabel", {
          label: agent.label,
          machine: machine.label || machine.host,
        }),
        command,
        "default",
      );
    } catch (err) {
      setRemoteErrors((prev) => ({ ...prev, [agent.id]: String(err) }));
    }
  };

  const dismissVersion = async (id: string, version: string) => {
    if (!version) return;
    try {
      await invoke("dismiss_agent_version", { agent: id, version });
      setVersions((prev) => ({ ...prev, [id]: { ...prev[id], dismissed: true } }));
      useAgentVersionNoticeStore.getState().noteDismissed(id, version);
    } catch {
      // A dismissal that did not stick costs one more notice, nothing else.
    }
  };

  // What this CLI reports as its version, and whether that release is still the
  // one Tabtivity's flags and parsers were verified against
  // (docs/third_party_update_checklist.md, as data in `agent_versions`).
  // Informational: drift is what explains an agent tab misreading an approval
  // prompt or a mode line, and it blocks nothing. Split in three so each lands
  // where it belongs on the card: `facts` are plain text in the meta line,
  // `update` is the one button that can become the card's primary action, and
  // `drift` is a warning block of its own.
  const versionParts = (a: AgentInfo) => {
    const report = versions[a.id];
    const update = updates[a.id];
    const current = report?.version ?? update?.current ?? null;
    const moved = !!report && report.state === "moved" && !report.dismissed;
    const busy = installing !== null || removing !== null;
    const staleLabel = (note: AgentVersionStale) =>
      t(
        note.direction === "newer"
          ? "agents.versionStaleNewer"
          : note.direction === "older"
            ? "agents.versionStaleOlder"
            : "agents.versionStaleDifferent",
        { version: note.version, surface: note.surface },
      );
    // After a check found a newer release the version pair reads `2.1.284 →
    // 2.1.287` and the card's primary button runs the installer for it.
    const hasUpdate = !!(update?.updateAvailable && current && update.latest);
    // Newest release known but the installed one unreadable: no claim of an
    // update, but the installer can still be run again for it.
    const unreadUpdate = !!(update && !update.updateAvailable && update.latest && !current);
    const facts = report ? (
      <>
        {current && (
          <span
            className="agents-version"
            title={t("agents.versionTitle", { label: a.label, raw: report.raw ?? current })}
          >
            {current}
          </span>
        )}
        {hasUpdate && update?.latest && (
          <>
            <span className="agents-version-arrow" aria-hidden="true">
              →
            </span>
            <span className="agents-version is-new">{update.latest}</span>
          </>
        )}
        {report.supported && (
          <button
            type="button"
            className="agents-icon-btn"
            disabled={checkingVersions}
            aria-label={t("agents.versionRecheck")}
            title={checkingVersions ? t("agents.versionChecking") : t("agents.versionRecheck")}
            onClick={() => loadVersions(true)}
          >
            <span className={checkingVersions ? "agents-spin" : undefined} aria-hidden="true">
              ↻
            </span>
          </button>
        )}
        {update && !update.updateAvailable && !update.error && update.latest && current && (
          <AgentsStatus tone="ok">{t("agents.updatesNone")}</AgentsStatus>
        )}
        {update?.error && (
          <span className="agents-note" title={update.error}>
            {t("agents.updateCouldntCheck")}
          </span>
        )}
        {update && !update.checkable && <span className="agents-note">{t("agents.updateNoRegistry")}</span>}
        {!report.supported && !current && <span className="agents-note">{t("agents.versionUnsupported")}</span>}
        {report.state === "unverified" && <span className="agents-note">{t("agents.versionUnverified")}</span>}
        {report.error && <span className="agents-note is-warn">{report.error}</span>}
      </>
    ) : null;
    const updateButton =
      !adminInstalls && update?.latest && (hasUpdate || unreadUpdate) ? (
        <button
          type="button"
          className="settings-btn sm primary"
          disabled={busy}
          title={
            hasUpdate && current
              ? t("agents.updateTitle", { label: a.label, current, latest: update.latest })
              : t("agents.updateUnreadTitle", { label: a.label, latest: update.latest })
          }
          onClick={() => void updateAgent(a.id)}
        >
          {installing === a.id ? t("agents.updating") : t("agents.updateToLatest", { latest: update.latest })}
        </button>
      ) : null;
    const drift =
      moved && report ? (
        <div className="agents-notice is-warn">
          <div className="agents-notice-head">
            <AgentsStatus tone="warn">{t("agents.versionDrift")}</AgentsStatus>
            <AgentsHelp text={t("agents.versionDriftHelp")} />
          </div>
          <ul className="agent-version-stale">
            {report.stale.map((note) => (
              <li key={`${note.version}:${note.surface}`}>{staleLabel(note)}</li>
            ))}
          </ul>
          <div className="agents-actions">
            <button
              type="button"
              className="settings-btn sm"
              title={t("agents.versionDismissTitle")}
              onClick={() => void dismissVersion(a.id, report.version ?? "")}
            >
              {t("agents.versionDismiss")}
            </button>
          </div>
        </div>
      ) : null;
    return { facts, updateButton, drift };
  };

  // The installed list's order is the + menu's, and so Ctrl+1–9's
  // (`agent_order`, row keys = binaries). Before anything was moved it is the
  // menu's own: the default agent first, then registry order.
  const installedList = (agents ?? []).filter((a) => a.installed);
  const defaultAgentCmd = settings?.default_agent_cmd || "claude";
  const defaultAgentBin =
    (agents ?? []).find((a) => a.id === defaultAgentCmd)?.bin ?? defaultAgentCmd;
  const builtinKeys = sortByAgentOrder(
    installedList,
    (a) => a.bin,
    AGENT_ITEMS.map((item) => item.cmd),
  ).map((a) => a.bin);
  const savedOrder = settings?.agent_order;
  const agentOrder = effectiveAgentOrder(
    [...builtinKeys, ...customAgents.map((ca) => `custom:${ca.id}`)],
    savedOrder,
    defaultAgentBin,
  );
  const chordSlots = agentShortcutSlots({
    installedBuiltins: enabledInstalledAgentBins(installedList, disabledAgents),
    installedCmds: installedCustom,
    customAgents,
    defaultAgentBin,
    agentOrder: savedOrder,
  });
  const chordFor = (bin: string) => {
    const slot = chordSlots.findIndex((s) => s?.key === bin);
    return slot < 0 ? null : chordLabel(resolveChord(AGENT_TAB_ACTIONS[slot], shortcutOverrides));
  };
  const visibleOrder = agentOrder.filter((key) => builtinKeys.includes(key));
  const moveAgent = (bin: string, delta: 1 | -1) => {
    // Keys of agents not installed right now keep their place in the saved
    // list, so a reinstall lands where it was.
    const kept = (savedOrder ?? []).filter((key) => !agentOrder.includes(key));
    void updateSettings({
      agent_order: moveInAgentOrder([...agentOrder, ...kept], bin, delta, builtinKeys),
    });
  };

  // The sign-in line on an installed card: read-only here (the group below
  // owns the import / sign-out buttons), and absent for a CLI whose login
  // Tabtivity cannot share, so no card claims "not signed in" it cannot know.
  const loginFacts = (a: AgentInfo) => {
    const l = logins.get(loginIdForCmd(a.id));
    if (!l?.shared) return null;
    if (l.uses_admin_key && l.admin_key_offered) {
      return <AgentsStatus tone="ok">{t("settings.agentLoginAdminKey")}</AgentsStatus>;
    }
    if (l.signed_in) {
      return (
        <AgentsStatus tone="ok">
          {l.account ? t("settings.agentLoginSignedInAs", { account: l.account }) : t("settings.agentLoginSignedIn")}
        </AgentsStatus>
      );
    }
    if (l.api_key) {
      return (
        <AgentsStatus tone={l.api_budget_reached ? "warn" : "ok"}>
          {l.api_budget_reached ? t("settings.agentLoginApiBudgetReached") : t("settings.agentLoginUsesApiKey")}
        </AgentsStatus>
      );
    }
    return (
      <AgentsStatus tone="off" title={t("settings.agentLoginNotSignedIn")}>
        {t("agents.loginNone")}
      </AgentsStatus>
    );
  };

  // The card for one CLI. One renderer for both sections below, so an
  // installed entry and one still to be installed cannot drift into two
  // designs — the only thing that differs is which list a card lands in.
  //
  // Hierarchy, top to bottom: name and status; the facts (version, sign-in,
  // shortcut) as plain text; what to do about it (warnings); how the CLI is
  // used; then the actions — at most one filled button (the install or the
  // update), the rest outlined, the destructive one in the danger colour.
  // Anything rare (another machine, a manual removal, per-CLI options) sits in
  // a fold, so a row of cards stays the same height and the same shape.
  const agentCard = (a: AgentInfo) => {
    const chord = a.installed ? chordFor(a.bin) : null;
    const hidden = disabledAgents.includes(a.id);
    const parts = a.installed ? versionParts(a) : null;
    const signIn = a.installed ? loginFacts(a) : null;
    const busy = installing !== null || removing !== null;
    const hasOptions = (a.id === "claude") || (a.id === "codex" && a.installed);
    // Install on a remote machine, one click from the foot: picking a machine
    // opens the watched install tab at once (the fold below is the same install
    // with the machine picked first). Only when a remote machine exists, so a local-only setup sees
    // no dead control on every card.
    const remotePicker = !adminInstalls && remoteMachines.length > 0 && (
      <>
        <Dropdown
          className="agent-remote-foot-picker"
          title={t("agents.installOnRemoteFootTitle", { label: a.label })}
          value=""
          placeholder={t("agents.installOnRemoteFoot")}
          options={remoteMachines.map((machine) => ({
            value: machine.id,
            label: machine.label || machine.host,
          }))}
          onChange={(v) => {
            setRemoteTargets((prev) => ({ ...prev, [a.id]: v }));
            void installAgentRemoteInTerminal(a, v);
          }}
        />
        <UntestedTag id="settingsSubPanels.remoteFoot" />
      </>
    );
    return (
    <SettingsCard key={a.id} className={`agents-card${a.installed ? "" : " is-available"}${hidden ? " is-hidden" : ""}`}>
      <div className="agents-card-head">
        <div className="agents-card-title">
          <span className="agents-card-name">{a.label}</span>
          {a.installed ? (
            <AgentsStatus tone="ok">{t("agents.installed")}</AgentsStatus>
          ) : (
            <AgentsStatus tone="off">{t("agents.notInstalled")}</AgentsStatus>
          )}
        </div>
        {a.installed && (
          <div className="agents-card-controls">
            <UntestedTag id="settingsSubPanels.agentOrder" />
            <span className="agents-reorder">
              <button
                type="button"
                className="agents-icon-btn"
                title={t("agents.moveUp", { modifier: modifierLabel() })}
                aria-label={t("agents.moveUpLabel", { label: a.label })}
                disabled={visibleOrder.indexOf(a.bin) <= 0}
                onClick={() => moveAgent(a.bin, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="agents-icon-btn"
                title={t("agents.moveDown", { modifier: modifierLabel() })}
                aria-label={t("agents.moveDownLabel", { label: a.label })}
                disabled={visibleOrder.indexOf(a.bin) >= visibleOrder.length - 1}
                onClick={() => moveAgent(a.bin, 1)}
              >
                ↓
              </button>
            </span>
            <label className="agent-disable-toggle" title={t("agents.disableToggleTitle")}>
              <Toggle
                checked={!hidden}
                onChange={(e) => setAgentDisabled(a.id, !e.target.checked)}
                size="sm"
                aria-label={t(hidden ? "agents.disableAriaEnable" : "agents.disableAriaDisable", { label: a.label })}
              />
              {hidden ? t("agents.disabled") : t("agents.enabled")}
            </label>
          </div>
        )}
      </div>
      {a.installed && (parts?.facts || signIn || chord) && (
        <div className="agents-card-meta">
          {parts?.facts}
          {signIn}
          {chord && (
            <kbd className="agent-chord-chip" title={t("agents.chordTitle", { label: a.label })}>
              {chord}
            </kbd>
          )}
        </div>
      )}
      {parts?.drift}
      {a.id === "codex" && <CodexHookNotice />}
      {a.installed && installedExtras && (
        <div className="agents-card-use">
          <span className="agents-card-use-label">
            {t("agents.useAs")}
            <AgentsHelp text={t("agents.useAsHelp")} />
          </span>
          {installedExtras(a)}
        </div>
      )}
      {remoteErrors[a.id] && <div className="project-dialog-error">{remoteErrors[a.id]}</div>}
      {logs[a.id] && (
        <pre className="ollama-install-log" ref={installing === a.id ? logRef : undefined}>
          {logs[a.id]}
        </pre>
      )}
      {errors[a.id] && <div className="project-dialog-error">{errors[a.id]}</div>}
      {node.status?.npm &&
        node.status.too_old &&
        NODE_ENGINE_FAILURE.test(`${logs[a.id] ?? ""}\n${errors[a.id] ?? ""}`) && (
          <NodeRuntimeNotice status={node.status} onRecheck={node.recheck} />
        )}
      {adminInstalls && (
        <p className="settings-help">
          {t(a.installed ? "agents.askAdminInstalled" : "agents.askAdminMissing", { label: a.label })}{" "}
          <code>{`sudo ${NAMES.serverAdminHelper} cli-install ${a.id}`}</code>{" "}
          <UntestedTag id="agents.askAdmin" />
        </p>
      )}
      {/* The actions sit on the card's foot (margin-top: auto), so a row of
          cards lines them up whatever the content above is. */}
      <div className="agents-card-foot">
        {a.installed && (
          <div className="agents-actions">
            {parts?.updateButton}
            <button
              type="button"
              className="settings-btn sm"
              disabled={!!checkingUpdates[a.id] || installing === a.id}
              title={t("agents.checkUpdatesTitle", { label: a.label })}
              onClick={() => checkUpdate(a.id)}
            >
              {checkingUpdates[a.id] ? t("agents.checkingUpdates") : t("agents.checkUpdates")}
            </button>
            <UntestedTag id="settingsSubPanels.agentUpdates" />
            <UntestedTag id="settingsSubPanels.3" />
            {remotePicker}
            {!adminInstalls && (
              <>
                <span className="agents-spacer" />
                <button
                  type="button"
                  className="settings-btn sm"
                  disabled={busy}
                  title={t("agents.reinstallTitle")}
                  onClick={() => void reinstallAgent(a.id)}
                >
                  {removing === a.id ? t("agents.reinstalling") : t("agents.reinstall")}
                </button>
                <button
                  type="button"
                  className="settings-btn sm danger"
                  disabled={busy}
                  title={t("agents.removeTitle")}
                  onClick={() => void removeAgent(a.id)}
                >
                  {removing === a.id ? t("agents.removing") : t("agents.remove")}
                </button>
              </>
            )}
          </div>
        )}
        {/* Auto-install runs the official installer via `sh` on Linux/macOS and
            via PowerShell/cmd on Windows. It is only hidden when this platform
            has no one-line installer at all (install_cmd empty — Windows-only
            case, see AgentInfo); the docs-link fallback below covers that. */}
        {!a.installed && !adminInstalls && a.install_cmd !== "" && (
          <div className="agents-actions">
            <button
              type="button"
              className="settings-btn sm primary"
              disabled={installing !== null}
              onClick={() => void installAgent(a.id)}
            >
              {installing === a.id ? t("agents.installing") : t("agents.installLabel", { label: a.label })}
            </button>
            {installing === a.id && <span className="agents-note">{t("agents.runningInstaller")}</span>}
            {remotePicker}
          </div>
        )}
        {!a.installed && !adminInstalls && a.install_cmd === "" && (
          <p className="settings-help">
            {t("agents.noWindowsInstallerPre")}{" "}
            <a href={a.docs} target="_blank" rel="noreferrer">
              {t("agents.installDocs")}
            </a>
            {t("agents.noWindowsInstallerPost")}{" "}
            <button
              type="button"
              className="settings-btn sm"
              disabled={installing !== null}
              onClick={() => recheck(a.id)}
            >
              {t("common.recheck")}
            </button>
            .
          </p>
        )}
      </div>
      {/* One fold per card, so a row of cards ends in the same single line:
          what is rare (another machine, a manual install or removal, a CLI's
          own options) is inside, as titled blocks. */}
      <AgentsFold label={t("agents.more")}>
        {hasOptions && (
          <div className="agents-block">
            <div className="settings-subheader">{t("agents.options")}</div>
            {a.id === "codex" && a.installed && <CodexAutoReviewToggle />}
            {a.id === "claude" && <ClaudeRemoteControlNotice />}
          </div>
        )}
        {!a.installed && !adminInstalls && a.install_cmd !== "" && (
          <div className="agents-block">
            <div className="settings-subheader">{t("agents.otherInstall")}</div>
            {/* Whenever install_cmd is non-empty the one-click button above is
                also shown, so this is always the "or". */}
            <p className="settings-help">
              {t("agents.orInstallInShellPre")} <strong>{a.shell}</strong> {t("agents.orInstallInShellPost")}
            </p>
            <div className="ollama-install-cmd-row">
              <code className="ollama-install-cmd">{a.install_cmd}</code>
              <button
                type="button"
                className="settings-btn sm"
                onClick={() =>
                  runInstallInTab(t("install.agentTabLabel", { label: a.label }), a.install_cmd, a.shell_kind)
                }
              >
                {t("agents.runInTerminal")}
              </button>
              {/* npm-based installers only (install_cmd_sudo empty otherwise —
                  Windows, or a curl/pip installer that targets the user's own
                  home directory): the actual EACCES fix when npm's global
                  directory is root-owned, the default on a non-nvm Linux/macOS
                  Node install. */}
              {a.install_cmd_sudo !== "" && (
                <button
                  type="button"
                  className="settings-btn sm"
                  title={t("agents.runWithSudoTitle")}
                  onClick={() =>
                    runInstallInTab(t("install.agentTabLabel", { label: a.label }), a.install_cmd_sudo, a.shell_kind)
                  }
                >
                  {t("agents.runWithSudo")}
                </button>
              )}
              <button
                type="button"
                className="settings-btn sm"
                disabled={installing !== null}
                onClick={() => recheck(a.id)}
              >
                {t("common.recheck")}
              </button>
            </div>
          </div>
        )}
        {a.installed && !adminInstalls && a.uninstall_cmd !== "" && (
          // npm-installed agents only (uninstall_cmd empty otherwise): npm's
          // global dir is root-owned on a system-wide Linux Node install, so
          // Remove can fail with EACCES — the same run-in-a-terminal escape
          // hatch the install flow offers, plus a one-click sudo-prefixed
          // variant for that exact case (uninstall_cmd_sudo, empty on Windows).
          <div className="agents-block">
            <div className="settings-subheader">{t("agents.removeManually")}</div>
            <p className="settings-help">
              {t("agents.permissionHelpPre")} <strong>{a.shell}</strong> {t("agents.permissionHelpPost")}{" "}
              <code>sudo</code> {t("agents.permissionHelpPost2")}
            </p>
            <div className="ollama-install-cmd-row">
              <code className="ollama-install-cmd">{a.uninstall_cmd}</code>
              <button
                type="button"
                className="settings-btn sm"
                onClick={() =>
                  runInstallInTab(t("install.removeTabLabel", { label: a.label }), a.uninstall_cmd, a.shell_kind)
                }
              >
                {t("agents.runInTerminal")}
              </button>
              {a.uninstall_cmd_sudo !== "" && (
                <button
                  type="button"
                  className="settings-btn sm"
                  title={t("agents.runWithSudoTitle")}
                  onClick={() =>
                    runInstallInTab(t("install.removeTabLabel", { label: a.label }), a.uninstall_cmd_sudo, a.shell_kind)
                  }
                >
                  {t("agents.runWithSudo")}
                </button>
              )}
            </div>
          </div>
        )}
        <div className="agents-block">
          <div className="settings-subheader">
            {t("agents.remoteFold")} <UntestedTag id="settingsSubPanels.4" />
          </div>
          <div className="agent-remote-install-row">
            {/* The app's own `Dropdown`, never a native <select>: WebKitGTK
                renders a <select> popup as a light OS menu that ignores the
                theme entirely — the reason every other picker in the app
                (the file-browser sort, the LaTeX engine, the catalog sort a
                few hundred lines below) already uses this one. */}
            <Dropdown
              className="agent-remote-machine-picker"
              title={t("agents.remoteMachineAria", { label: a.label })}
              value={remoteTargets[a.id] ?? ""}
              placeholder={
                !remoteMachinesLoaded
                  ? t("agents.remoteMachinesLoading")
                  : remoteMachines.length === 0
                    ? t("agents.noRemoteMachines")
                    : t("agents.chooseRemoteMachine")
              }
              disabled={!remoteMachinesLoaded || remoteMachines.length === 0}
              options={remoteMachines.map((machine) => ({
                value: machine.id,
                label: machine.label || machine.host,
              }))}
              onChange={(v) => setRemoteTargets((prev) => ({ ...prev, [a.id]: v }))}
            />
            <button
              type="button"
              className="settings-btn sm"
              title={t("agents.installOnRemoteTerminalTitle")}
              disabled={!remoteTargets[a.id]}
              onClick={() => void installAgentRemoteInTerminal(a)}
            >
              {t("agents.installOnRemote")}
            </button>
          </div>
        </div>
      </AgentsFold>
    </SettingsCard>
    );
  };

  const installedAgents = sortByAgentOrder(installedList, (a) => a.bin, agentOrder);
  const availableAgents = (agents ?? []).filter((a) => !a.installed);
  const query = search.trim().toLowerCase();
  // Matched on the label, the id and the binary name, because a CLI is looked
  // for by whichever of the three the user happens to know ("gemini", "vibe").
  const matches = query
    ? availableAgents.filter((a) =>
        [a.label, a.id, a.bin].some((s) => s.toLowerCase().includes(query)),
      )
    : availableAgents;

  return (
    <>
      <SettingsHeader title={t("nav.agents.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help agents-lead">{t("agents.lead")}</p>
      {node.status && !node.status.npm && (
        <NodeRuntimeNotice status={node.status} onRecheck={node.recheck} />
      )}
      {agents === null ? (
        <p className="settings-help">{t("agents.checkingInstalled")}</p>
      ) : (
        <>
          {/* Keep installed CLIs first, then reveal the searchable available catalog on request. */}
          <div className="agents-section-head" role="heading" aria-level={3}>
            {t("agents.installedGroup")}
            <span className="agents-count">{installedAgents.length}</span>
          </div>
          {installedAgents.length === 0 ? (
            <p className="settings-help">{t("agents.noneInstalled")}</p>
          ) : (
            <SettingsList className="agents-grid">{installedAgents.map(agentCard)}</SettingsList>
          )}
          <div className="agents-section-head" role="heading" aria-level={3}>
            {t("agents.availableGroup")}
            <UntestedTag id="settingsSubPanels.availableList" />
            <span className="agents-count">{availableAgents.length}</span>
            <AgentsHelp text={t("agents.googleCliChoice")} />
          </div>
          {availableAgents.length === 0 ? (
            <p className="settings-help">{t("agents.allInstalled")}</p>
          ) : (
            <AgentsFold label={t("agents.browseAvailable")}>
              <div className="agents-search">
                <input
                  type="text"
                  className="agents-input"
                  placeholder={t("agents.searchPlaceholder")}
                  value={search}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-label={t("agents.searchPlaceholder")}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {matches.length === 0 ? (
                <p className="settings-help">
                  {t("agents.noSearchMatch", { query: search.trim() })}
                </p>
              ) : (
                <SettingsList className="agents-grid">{matches.map(agentCard)}</SettingsList>
              )}
            </AgentsFold>
          )}
        </>
      )}
      {/* The sandbox, the accounts and keys, the warm-up schedule and the prompt
          composer are set once and then forgotten, and on top they pushed the
          CLIs this panel is named for below the fold. Each is one closed row
          with a line saying what is inside. */}
      <div className="agents-section-head" role="heading" aria-level={3}>
        {t("agents.settingsHeading")}
      </div>
      <div className="agents-groups">
        <AgentsGroup title={t("agents.groupAccounts")} summary={t("agents.sumAccounts")}>
          <AgentAccounts onChange={() => setLoginsVersion((v) => v + 1)} />
        </AgentsGroup>
        <AgentsGroup
          title={<>{t("settings.agentFenceTitle")} <UntestedTag id="settings.agentFenceTitle" /></>}
          summary={t("agents.sumSandbox")}
        >
          <AgentFenceCard />
        </AgentsGroup>
        <AgentsGroup
          title={<>{t("agentCron.title")} <UntestedTag id="agentCron.title" /></>}
          summary={t("agents.sumSchedule")}
        >
          <AgentCronSection agents={agents} />
        </AgentsGroup>
        <AgentsGroup title={t("agents.groupTools")} summary={t("agents.sumTools")}>
          <div className="agents-stack">
            <div className="agents-option">
              <AgentScheduleMcpSettings />
            </div>
            <div className="agents-option">
              <GitPushMcpSettings />
            </div>
            <div className="agents-option">
              <MarkupMcpSettings />
            </div>
          </div>
        </AgentsGroup>
        <AgentsGroup
          title={<>{t("agents.composerHeading")} <UntestedTag id="settingsSubPanels.2" /></>}
          summary={t("agents.sumComposer")}
        >
          <AgentComposerCard agents={agents} />
        </AgentsGroup>
      </div>
      </div>
    </>
  );
}

// Fallback install command shown before the OS-specific strategy loads from the
// backend. The real command comes from `ollama_install_strategy` (winget on
// Windows, the install script on Linux/macOS).
const OLLAMA_INSTALL_CMD_FALLBACK = "curl -fsSL https://ollama.com/install.sh | sh";
const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
// Fallback Vibe install command shown before the OS-specific strategy loads from
// the backend. The real command comes from `vibe_install_strategy` (a uv-based
// PowerShell command on Windows, the install script on Linux/macOS).
const VIBE_INSTALL_CMD = "curl -LsSf https://mistral.ai/vibe/install.sh | bash";

/** OS-dependent Vibe install guidance (mirrors backend `VibeInstallStrategy`). */
interface VibeInstallStrategy {
  os: string; // "windows" | "macos" | "linux" | "unknown"
  command: string;
  auto: boolean;
  docs: string;
}

/** OS-dependent Ollama install guidance (mirrors backend `OllamaInstallStrategy`). */
interface OllamaInstallStrategy {
  os: string; // "windows" | "macos" | "linux" | "unknown"
  command: string;
  auto: boolean;
  download_url: string;
}

export function OllamaPanel({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string | null>(null);
  // OS-dependent install strategy (command + whether one-click install works).
  const [strategy, setStrategy] = useState<OllamaInstallStrategy | null>(null);
  const installLogRef = useRef<HTMLPreElement>(null);
  // Vibe (local-model agent runtime) — required to launch Local Model tabs.
  const [vibeInstalled, setVibeInstalled] = useState<boolean | null>(null);
  // OS-dependent Vibe install command (uv/PowerShell on Windows, script elsewhere).
  const [vibeStrategy, setVibeStrategy] = useState<VibeInstallStrategy | null>(null);
  const [vibeInstalling, setVibeInstalling] = useState(false);
  const [vibeInstallLog, setVibeInstallLog] = useState<string | null>(null);
  const vibeInstallLogRef = useRef<HTMLPreElement>(null);
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [serverRunning, setServerRunning] = useState<boolean | null>(null);
  // The update check shared with the header dropdown (`lib/agents/
  // ollamaUpdateActions`): its verdicts live in the activity store, so a check
  // run there shows here and the other way round.
  const updateVerdicts = useOllamaActivityStore((s) => s.updates);
  const checkingUpdates = useOllamaActivityStore((s) => s.checkingUpdates);
  const checkResult = useOllamaActivityStore((s) => s.checkResult);
  const ollamaVersion = useOllamaActivityStore((s) => s.version);
  // Where Ollama downloads models (`settings.ollama_models_path`) and how the
  // chosen path would reach the running server. The plan is re-read whenever the
  // path changes — an empty path asks only for the default + systemd facts.
  const modelsPath = settings?.ollama_models_path ?? "";
  const [modelsDirPlan, setModelsDirPlan] = useState<OllamaModelsDirPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  // Models currently being loaded into memory, keyed by name. Driven by the
  // global `ollama-load-progress` events so a load started from the brain menu
  // shows here too; Ollama streams no load percentage, so it's indeterminate.
  // Live downloads and the session's paused pulls come from the same shared
  // store (`initLocalModelEvents` below), so a pull started or paused from the
  // 🧠 menu offers its Pause / Resume here too.
  const loads = useOllamaActivityStore((s) => s.loads);
  // Per-tag registry facts (size, parameters, quantization, cloud), fetched
  // lazily and cached. The parameter count and size are what the search card
  // omits for a model with no size badge, so it is fetched from the manifest.
  const [tagInfo, setTagInfo] = useState<Record<string, TagInfo>>({});
  // Which size/tag each registry card's picker shows (default: its first).
  const [variantPick, setVariantPick] = useState<Record<string, string>>({});
  // Live download progress per model ref, keyed by the exact ref passed to
  // `pull_ollama_model`. `pct` is null during non-download phases (manifest,
  // verify, write) where Ollama reports no byte totals.
  const pullProgress = useOllamaActivityStore((s) => s.downloads);
  // Model refs whose download was interrupted by a previous Tabtivity exit/crash,
  // persisted by the backend. Each can be resumed ("Continue") since Ollama
  // picks up a partially-fetched model where it left off.
  const [interrupted, setInterrupted] = useState<string[]>([]);
  // Model refs the user paused mid-download this session. A paused pull keeps its
  // partial blobs (so it can be resumed) and offers Resume / Delete.
  const paused = useOllamaActivityStore((s) => s.paused);
  // Orphaned partial layers in Ollama's blob cache with no recoverable model
  // name — surfaced only so the user can delete them to reclaim space.
  const [orphans, setOrphans] = useState<{ digest: string; size: number; path: string }[]>([]);
  // Live registry browser (ollama.com/search): query, filters, lazy-loaded pages.
  const [regQuery, setRegQuery] = useState("");
  const [regQueryLive, setRegQueryLive] = useState(""); // debounced
  const [regTypes, setRegTypes] = useState<Set<string>>(new Set()); // empty = any
  const [regRuns, setRegRuns] = useState(""); // "" = either, else a REGISTRY_RUNS value
  const [regDownload, setRegDownload] = useState(""); // "" = any, else a REGISTRY_DOWNLOAD_SIZES value
  const [sortBy, setSortBy] = useState<SortKey>("popular");
  const [regModels, setRegModels] = useState<RegistryModel[]>([]);
  const [regPage, setRegPage] = useState(0);
  const [regLoading, setRegLoading] = useState(false);
  const [regDone, setRegDone] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<() => void>(() => {});
  // Bumped by every registry fetch: an answer that is no longer the latest
  // request's (the query or a filter changed meanwhile) is dropped.
  const regSeq = useRef(0);

  // Fetch a tag's registry facts (size + parameters + quantization) once. Called
  // on hover for a tag button, and eagerly for a row with no size badge (below),
  // where the parameters and size would otherwise be invisible.
  const fetchTagInfo = (fullName: string) => {
    if (fullName in tagInfo) return;
    setTagInfo((p) => ({ ...p, [fullName]: "loading" }));
    invoke<RegistryDetails>("ollama_registry_details", { model: fullName })
      .then((d) => setTagInfo((p) => ({ ...p, [fullName]: d })))
      .catch(() => setTagInfo((p) => ({ ...p, [fullName]: "error" })));
  };

  // The " — 4.7 GB" suffix a tag button's tooltip carries once its size is known
  // (empty for a cloud model, which downloads nothing, and while still loading).
  const tagSizeSuffix = (info: TagInfo | undefined): string => {
    if (info === undefined) return "";
    if (info === "loading") return t("ollama.sizeLoadingSuffix");
    if (info === "error" || info.size_bytes <= 0) return "";
    return ` — ${fmtBytes(info.size_bytes)}`;
  };

  // The quiet "9.7B · Q4_K_M · 4.7 GB" line under a registry card's size picker —
  // what the selected tag is and whether it fits. A cloud model downloads
  // nothing, so it shows its parameter count only.
  const tagFactText = (info: TagInfo | undefined): string => {
    if (info === "loading") return "…";
    if (!info || info === "error") return "";
    return [info.params, info.quant, info.size_bytes > 0 ? fmtBytes(info.size_bytes) : ""]
      .filter(Boolean)
      .join(" · ");
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<OllamaModelInfo[]>("list_ollama_models_detailed");
      setModels(result);
      setServerRunning(true);
    } catch (e) {
      if (String(e).includes("not_running")) {
        setServerRunning(false);
        setModels([]);
      } else {
        setError(String(e));
      }
    } finally {
      setLoading(false);
    }
  };

  // Load installed/running models once Ollama itself is present. When it is
  // missing we show the install flow instead. The registry browser below loads
  // independently (it queries ollama.com, not the local server).
  const loadAfterInstall = () => {
    void refresh();
  };

  useEffect(() => {
    void (async () => {
      const ok = await invoke<boolean>("ollama_is_installed").catch(() => false);
      setInstalled(ok);
      if (ok) loadAfterInstall();
      else setLoading(false);
    })();
    // OS-dependent install command/wording for the install panel below.
    invoke<OllamaInstallStrategy>("ollama_install_strategy").then(setStrategy).catch(() => {});
    // Vibe is independent of Ollama; check it regardless so its status shows in
    // both the install-Ollama and main panels.
    invoke<boolean>("vibe_is_installed").then(setVibeInstalled).catch(() => setVibeInstalled(false));
    invoke<VibeInstallStrategy>("vibe_install_strategy").then(setVibeStrategy).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The installed Ollama version — a local read, no network (the registry half
  // only runs when the user presses "Check for updates").
  useEffect(() => {
    if (!installed) return;
    ollamaVersionStatus(false)
      .then((v) => useOllamaActivityStore.getState().mergeInstalledVersion(v))
      .catch(() => {});
  }, [installed]);

  // Live download progress and loads-into-memory, from any surface, in the shared
  // activity store. A paused pull stops streaming there and moves into `paused`,
  // so its row offers Resume / Delete.
  useEffect(() => initLocalModelEvents(), []);

  // A load that just finished: re-read the model list so the row flips to its
  // resident state. A model leaving `loads` is a success (an error stays in it).
  const prevLoads = useRef(loads);
  useEffect(() => {
    const finished = Object.keys(prevLoads.current).some((m) => prevLoads.current[m] === "loading" && !(m in loads));
    prevLoads.current = loads;
    if (finished) void refresh();
  }, [loads]);

  // Drop a model's progress once its pull settles (success or error).
  const clearPullProgress = (model: string) => useOllamaActivityStore.getState().dropDownload(model);

  // Live button label for an in-flight pull: a percentage when Ollama is
  // streaming byte totals, otherwise the caller's fallback (e.g. "Pulling…").
  const pullText = (model: string, busyFallback: string) => {
    const pct = pullProgress[model]?.pct;
    return pct != null ? `${pct}%` : busyFallback;
  };

  // Load the persisted interrupted-pull list + orphaned partial blobs once
  // Ollama is present.
  useEffect(() => {
    if (installed !== true) return;
    invoke<string[]>("list_pending_ollama_pulls").then(setInterrupted).catch(() => {});
    invoke<{ digest: string; size: number; path: string }[]>("list_orphan_partial_blobs")
      .then(setOrphans)
      .catch(() => {});
  }, [installed]);

  // Delete an orphaned partial layer to reclaim its disk space. The list is
  // re-read afterwards rather than trimmed optimistically: a delete the OS
  // refused (the system service's cache, authorization declined) must leave the
  // row in place next to its error, not vanish and reappear on the next open.
  const deleteOrphan = (path: string) => {
    setError("");
    void invoke("delete_partial_blob", { path })
      .catch((e) => setError(String(e)))
      .finally(() => {
        invoke<{ digest: string; size: number; path: string }[]>("list_orphan_partial_blobs")
          .then(setOrphans)
          .catch(() => {});
      });
  };

  // Reconcile interrupted entries against what's actually installed: any model
  // that completed before the crash (or has since finished) is dropped and its
  // stale record cleared on the backend.
  useEffect(() => {
    if (interrupted.length === 0) return;
    const names = new Set(models.map((m) => m.name));
    const done = interrupted.filter(
      (ref) => names.has(ref) || (!ref.includes(":") && names.has(`${ref}:latest`)),
    );
    if (done.length === 0) return;
    setInterrupted((p) => p.filter((m) => !done.includes(m)));
    done.forEach((m) => void invoke("clear_pending_ollama_pull", { model: m }));
  }, [models, interrupted]);

  // Resume an interrupted download — Ollama continues from the partial blobs.
  const continuePull = (model: string) => {
    setInterrupted((p) => p.filter((m) => m !== model));
    void withBusy(`${model}:pull`, () => invoke("pull_ollama_model", { model }));
  };

  // Forget an interrupted download without resuming it.
  const dismissPull = (model: string) => {
    setInterrupted((p) => p.filter((m) => m !== model));
    void invoke("clear_pending_ollama_pull", { model });
  };

  // Pause an in-flight download. The backend stops the stream at the next chunk,
  // keeps the partial blobs, and emits a "paused" progress event that flips the
  // row into the paused state (Resume / Delete).
  const pausePull = (model: string) => {
    void invoke("pause_ollama_pull", { model });
  };

  // Resume a paused download — re-pull, which Ollama continues from the partials.
  const resumePull = (model: string) => {
    useOllamaActivityStore.getState().clearPaused(model);
    void withBusy(`${model}:pull`, () => invoke("pull_ollama_model", { model }));
  };

  // Delete a paused download: drop its partial blobs and clear its pending record.
  const deletePausedPull = (model: string) => {
    useOllamaActivityStore.getState().clearPaused(model);
    setInterrupted((p) => p.filter((m) => m !== model));
    void invoke("delete_ollama_pull", { model })
      .then(() => refresh())
      .catch((e) => setError(String(e)));
  };

  const installVibe = async () => {
    setVibeInstalling(true);
    setVibeInstallLog("");
    try {
      await runWithProgress<{ line: string }, string>(
        "vibe-install-progress",
        (p) => setVibeInstallLog((prev) => (prev ? `${prev}\n${p.line}` : p.line)),
        () => invoke<string>("install_vibe"),
      );
      setVibeInstalled(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setVibeInstalling(false);
    }
  };

  // Keep the live Vibe install log pinned to the latest line.
  useEffect(() => {
    const el = vibeInstallLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [vibeInstallLog]);

  const installOllama = async () => {
    setInstalling(true);
    setError(null);
    setInstallLog("");
    try {
      // Stream the installer's output line-by-line so the user sees live progress.
      await runWithProgress<{ line: string }, string>(
        "ollama-install-progress",
        (p) => setInstallLog((prev) => (prev ? `${prev}\n${p.line}` : p.line)),
        () => invoke<string>("install_ollama"),
      );
      setInstalled(true);
      // Start the server and load the model catalog so the user can immediately
      // pick what to install next.
      loadAfterInstall();
      await startServer();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  // Keep the live install log pinned to the latest line.
  useEffect(() => {
    const el = installLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [installLog]);

  const startServer = async () => {
    setError(null);
    try {
      await invoke("ensure_ollama_running");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  // Read the download-location plan on mount and whenever the chosen path
  // changes, so the default placeholder and the systemd apply-to-service command
  // (which depends on the exact path) stay in step with the setting.
  useEffect(() => {
    let cancelled = false;
    invoke<OllamaModelsDirPlan>("ollama_models_dir_plan", { path: modelsPath || null })
      .then((p) => {
        if (!cancelled) setModelsDirPlan(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modelsPath]);

  const chooseModelsDir = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: modelsPath || undefined,
    });
    if (typeof picked === "string") {
      // Trailing slashes off so the stored value matches what the drop-in and
      // the placeholder show (mirrors the project-location picker).
      await updateSettings({ ollama_models_path: picked.replace(/\/+$/, "") });
    }
  };

  // Back to Ollama's own default — `null`, never `""`: the backend field is
  // skipped when absent, and a stored empty string would be a second spelling of
  // "unset" for every reader to special-case.
  const clearModelsDir = () => {
    void updateSettings({ ollama_models_path: null });
  };

  // Point the *running* server at the chosen folder (systemd drop-in), in a
  // visible terminal — it needs a root password and rewrites a service the user
  // is entitled to read first. The setting alone already covers a server Tabtivity
  // starts itself.
  const applyModelsDirToService = () => {
    if (!modelsDirPlan?.service_cmd) return;
    runInstallInTab(
      t("ollama.modelLocationApplyTabLabel"),
      modelsDirPlan.service_cmd,
      (modelsDirPlan.shell_kind || "bash") as InstallShellKind,
    );
  };

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy((prev) => ({ ...prev, [key]: true }));
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
      if (key.endsWith(":pull")) clearPullProgress(key.slice(0, -":pull".length));
    }
  };

  // Pull an arbitrary model ref typed into the registry search bar. Reuses the
  // same pull command as the catalog, so it accepts anything on the registry
  // (`name`, `name:tag`, `namespace/name:tag`) — not just the curated catalog.
  const pullTyped = async () => {
    const model = regQuery.trim();
    if (!model) return;
    const key = `${model}:pull`;
    setBusy((prev) => ({ ...prev, [key]: true }));
    setError(null);
    try {
      await invoke("pull_ollama_model", { model });
      setRegQuery(""); // clear only on success; errors keep the typed ref
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
      clearPullProgress(model);
    }
  };

  const installedNames = useMemo(() => new Set(models.map((m) => m.name)), [models]);

  // ── Live registry browser ────────────────────────────────────────────────
  // Filters and sort are ollama.com's own (see `search_ollama_registry`), so
  // every page arrives filtered and in order and scrolling just appends.
  const regCapabilities = [...regTypes, regRuns].filter(Boolean);
  const regFilterKey = `${regCapabilities.join(",")}|${regDownload}|${sortBy}`;

  // Fetch one page of ollama.com/search results. `reset` replaces the list
  // (new query/filter/sort); otherwise it appends, de-duping by name across
  // pages (a model published meanwhile shifts the pages by one).
  const loadRegistryPage = async (page: number, reset: boolean) => {
    const seq = ++regSeq.current;
    setRegLoading(true);
    setRegError(null);
    if (reset) {
      setRegModels([]);
      setRegPage(0);
      setRegDone(false);
    }
    try {
      const result = await invoke<RegistrySearchPage>("search_ollama_registry", {
        query: regQueryLive.trim(),
        capabilities: regCapabilities,
        size: regDownload,
        sort: sortBy,
        page,
      });
      if (seq !== regSeq.current) return;
      setRegPage(page);
      setRegDone(!result.hasMore);
      setRegModels((prev) => {
        if (reset) return result.models;
        const seen = new Set(prev.map((m) => m.name));
        return [...prev, ...result.models.filter((m) => !seen.has(m.name))];
      });
    } catch (e) {
      if (seq !== regSeq.current) return;
      setRegError(String(e));
      setRegDone(true);
    } finally {
      if (seq === regSeq.current) setRegLoading(false);
    }
  };

  // Debounce the query box so we don't hit ollama.com on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setRegQueryLive(regQuery), 350);
    return () => window.clearTimeout(id);
  }, [regQuery]);

  // (Re)load page 1 whenever the query, a filter or the sort changes.
  useEffect(() => {
    if (installed !== true) return;
    void loadRegistryPage(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regQueryLive, regFilterKey, installed]);

  // Load the next page while the sentinel under the list is in (or near) view,
  // once page 1 is in (that one is the effect's above). The observer is
  // re-armed after every page: observing fires once with the current state, so
  // a page that still leaves the sentinel visible (a short page, a tall window)
  // pulls the next one instead of stalling.
  const canLoadMore = !regLoading && !regDone && regPage > 0;
  loadMoreRef.current = () => {
    if (canLoadMore) void loadRegistryPage(regPage + 1, false);
  };
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !canLoadMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current();
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canLoadMore, regPage]);

  const toggleType = (key: string) =>
    setRegTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Rows with no size badge on their search card (cloud models, single-variant
  // models) carry their parameter count and size only in the registry manifest,
  // not the search HTML — so fetch those few eagerly, or the card would show a
  // bare "pull"/"cloud" button with no parameters and no size to judge fit by.
  useEffect(() => {
    for (const m of regModels) {
      if (m.sizes.length === 0) {
        fetchTagInfo(`${m.name}:${m.capabilities.includes("cloud") ? "cloud" : "latest"}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regModels]);

  // "Load on Tabtivity start" — which models `stores/agents/ollamaAutoload` warms into
  // memory at launch. Both controls write straight through: the per-model switch
  // on each downloaded card (the same setting the 🧠 menu's chip toggles, so the
  // two surfaces cannot disagree) and the Energy Saver opt-out, which flashes
  // "Saved" instead of hiding behind a Save button.
  const autoloadModels = settings?.ollama_autoload_models ?? [];
  const saverPref = settings?.ollama_autoload_in_energy_saver === true;
  const [saverSaved, setSaverSaved] = useState(false);
  const toggleAutoload = (name: string) => {
    const next = autoloadModels.includes(name)
      ? autoloadModels.filter((m) => m !== name)
      : [...autoloadModels, name];
    void updateSettings({ ollama_autoload_models: next });
  };
  const setSaverPref = (on: boolean) => {
    void updateSettings({ ollama_autoload_in_energy_saver: on }).then(() => {
      setSaverSaved(true);
      window.setTimeout(() => setSaverSaved(false), 2000);
    });
  };

  const runningModels = models.filter((m) => m.running);
  const loadedLabel =
    runningModels.length === 0
      ? serverRunning
        ? t("ollama.noModelLoaded")
        : t("ollama.noLoadedModel")
      : t("ollama.loadedModels", { names: runningModels.map((m) => m.name).join(", ") });

  // Vibe runtime — required to launch Local Model tabs. Its install steps (shown
  // only while it is missing) are shared by the install-Ollama page's card and
  // the running page's status card, where a ready runtime is a single line.
  const vibeInstallBlock = (
    <>
      <p className="settings-help">
        {t("ollama.vibeMissing1")} <code>vibe</code> {t("ollama.vibeMissing2")}
      </p>
      <div className="ollama-install-cmd-row">
        <button
          type="button"
          className="ollama-action-btn primary"
          disabled={vibeInstalling}
          onClick={() => void installVibe()}
        >
          {vibeInstalling ? t("ollama.installingEllipsis") : t("ollama.installVibe")}
        </button>
        {vibeInstalling && <span className="ollama-status-text">{t("ollama.runningInstaller")}</span>}
      </div>
      {vibeInstallLog !== null && (
        <pre className="ollama-install-log" ref={vibeInstallLogRef}>
          {vibeInstallLog || t("ollama.startingEllipsis")}
        </pre>
      )}
      <p className="settings-help">
        {t("ollama.orInstallInShellPre")} {vibeStrategy?.os === "windows" ? "PowerShell" : "terminal"}{" "}
        {t("ollama.orInstallInShellPost")}
      </p>
      <div className="ollama-install-cmd-row">
        <code className="ollama-install-cmd">{vibeStrategy?.command ?? VIBE_INSTALL_CMD}</code>
        <button
          type="button"
          className="ollama-action-btn primary"
          onClick={() =>
            runInstallInTab(
              t("install.vibeTabLabel"),
              vibeStrategy?.command ?? VIBE_INSTALL_CMD,
              vibeStrategy?.os === "windows" ? "powershell" : "bash",
            )
          }
        >
          {t("ollama.runInTerminal")}
        </button>
        <button
          type="button"
          className="ollama-action-btn"
          disabled={vibeInstalling}
          onClick={() =>
            void invoke<boolean>("vibe_is_installed")
              .then((ok) => {
                setVibeInstalled(ok);
                if (!ok)
                  setError(
                    vibeStrategy?.os === "windows"
                      ? t("ollama.vibeStillNotDetectedWindows")
                      : t("ollama.vibeStillNotDetectedOther"),
                  );
              })
              .catch(() => {})
          }
        >
          {t("common.recheck")}
        </button>
      </div>
    </>
  );

  // The install-Ollama page's runtime card.
  const vibeSection = (
    <SettingsCard className="ollama-vibe-section">
      <div className="settings-subheader">{t("ollama.vibeTitle")}</div>
      {vibeInstalled === null ? (
        <p className="settings-help">{t("ollama.vibeChecking")}</p>
      ) : vibeInstalled ? (
        <p className="settings-help">
          <span className="ollama-status-dot running" /> {t("ollama.vibeInstalled")}
        </p>
      ) : (
        vibeInstallBlock
      )}
    </SettingsCard>
  );

  // ── Not installed: show the (semi-)automated installer + manual steps ──────
  if (installed === false) {
    // OS-dependent install guidance from the backend (winget on Windows, the
    // install script on Linux/macOS); fall back to the script until it loads.
    const installCmd = strategy?.command ?? OLLAMA_INSTALL_CMD_FALLBACK;
    const downloadUrl = strategy?.download_url ?? OLLAMA_DOWNLOAD_URL;
    const isWindows = strategy?.os === "windows";
    return (
      <>
        <SettingsHeader title={t("ollama.installTitle")} onBack={onBack} onClose={onClose} />
        <div className="dialog-scroll">

        <p className="settings-help">{t("ollama.notInstalledHelp")}</p>

        <SettingsSection
          title={t("ollama.automaticInstall")}
          help={isWindows ? t("ollama.autoInstallHelpWindows") : t("ollama.autoInstallHelpOther")}
        />
        <div className="ollama-install-cmd-row">
          <button
            type="button"
            className="ollama-action-btn primary"
            disabled={installing}
            onClick={() => void installOllama()}
          >
            {installing ? t("ollama.installingEllipsis") : t("ollama.installBtn")}
          </button>
          {installing && <span className="ollama-status-text">{t("ollama.runningInstaller")}</span>}
        </div>

        {error && <ErrorNote className="project-dialog-error" error={error} />}
        {installLog !== null && (
          <pre className="ollama-install-log" ref={installLogRef}>
            {installLog || t("ollama.startingEllipsis")}
          </pre>
        )}

        <div className="settings-section-title">{t("ollama.installInTerminalTitle")}</div>
        <ol className="ollama-install-steps">
          <li>
            {t("ollama.runInstallerNewPre")}{" "}
            {isWindows ? "PowerShell" : "terminal"} {t("ollama.runInstallerNewPost")}
            <div className="ollama-install-cmd-row">
              <code className="ollama-install-cmd">{installCmd}</code>
              <button
                type="button"
                className="ollama-action-btn primary"
                onClick={() =>
                  runInstallInTab(t("install.ollamaTabLabel"), installCmd, isWindows ? "default" : "bash")
                }
              >
                {t("ollama.runInTerminal")}
              </button>
            </div>
            <span className="settings-help">
              {t("ollama.alsoDownloadFrom")}{" "}
              <code>{downloadUrl}</code>.
            </span>
          </li>
          <li>
            {isWindows ? t("ollama.approveUacPrompt") : t("ollama.enterPasswordSudo")}
          </li>
          <li>
            {t("ollama.onceFinishedClickPre")} <strong>{t("common.recheck")}</strong>{" "}
            {t("ollama.onceFinishedClickPost")}
          </li>
        </ol>
        <button
          type="button"
          className="ollama-action-btn"
          disabled={installing}
          onClick={() =>
            void (async () => {
              const ok = await invoke<boolean>("ollama_is_installed").catch(() => false);
              setInstalled(ok);
              if (ok) {
                loadAfterInstall();
                await startServer();
              } else {
                setError(t("ollama.stillNotDetected"));
              }
            })()
          }
        >
          {t("common.recheck")}
        </button>

        {vibeSection}
        </div>
      </>
    );
  }

  // A section's heading: sentence-case title, a quiet count, and room on the
  // right for that section's own controls.
  const sectionHead = (title: ReactNode, count?: number) => (
    <div className="ollama-section-head" role="heading" aria-level={3}>
      <span className="ollama-section-name">{title}</span>
      {count !== undefined && <span className="ollama-section-count">{count}</span>}
    </div>
  );

  // A typed query that is plainly a model reference (`name:tag`,
  // `namespace/name`, or an exact registry name) offers a direct pull beside
  // the search it is also feeding.
  const typedRef = regQuery.trim();
  const typedIsRef =
    typedRef !== "" &&
    !/\s/.test(typedRef) &&
    (/[:/]/.test(typedRef) || regModels.some((m) => m.name === typedRef));
  const typedBusy = !!busy[`${typedRef}:pull`];

  // One registry card: name, one-line description, capability badges, quiet
  // size/pulls text, and a real Pull button on the foot. A model with several
  // sizes gets a size picker; a bare "latest"/"cloud" model pulls directly.
  const registryCard = (m: RegistryModel) => {
    const isCloud = m.capabilities.includes("cloud");
    const hasSizes = m.sizes.length > 0;
    const picked = variantPick[m.name];
    const tag = hasSizes ? (picked && m.sizes.includes(picked) ? picked : m.sizes[0]) : isCloud ? "cloud" : "latest";
    const fullName = `${m.name}:${tag}`;
    const isInstalled = installedNames.has(fullName);
    const busyKey = `${fullName}:pull`;
    const info = tagInfo[fullName];
    const facts = tagFactText(info);
    const meta = [m.pulls && t("ollama.pullsSuffix", { pulls: m.pulls }), m.updated].filter(Boolean).join(" · ");
    // The registry page's badges are scraped as capabilities, and a cloud
    // model's pricing badge ("Medium usage $0.30 in · …") rides along: a
    // one-word capability stays a badge, anything longer is quiet text.
    const caps = m.capabilities.filter((c) => !/\s/.test(c));
    const notes = m.capabilities.filter((c) => /\s/.test(c));
    return (
      <div className="ollama-catalog-row" key={m.name}>
        <div className="ollama-catalog-header">
          <span className="ollama-model-name">{m.name}</span>
        </div>
        {meta && <div className="ollama-catalog-hint">{meta}</div>}
        {m.description && <div className="ollama-catalog-desc">{m.description}</div>}
        {(caps.length > 0 || m.community) && (
          <div className="ollama-caps">
            {m.community && (
              <span className="ollama-cap" title={t("ollama.communityTitle", { user: m.name.split("/")[0] })}>
                {t("ollama.communityBadge")}
              </span>
            )}
            {caps.map((c) => (
              <span className="ollama-cap" key={c}>
                {c}
              </span>
            ))}
          </div>
        )}
        {notes.map((n) => (
          <div className="ollama-catalog-hint" key={n}>
            {n}
          </div>
        ))}
        <div
          className="ollama-catalog-foot"
          onMouseEnter={() => fetchTagInfo(fullName)}
          onFocus={() => fetchTagInfo(fullName)}
        >
          <div className="ollama-catalog-pick">
            {hasSizes && (
              <Dropdown
                className="ollama-variant"
                value={tag}
                ariaLabel={t("ollama.variantLabel", { name: m.name })}
                onChange={(v) => {
                  setVariantPick((p) => ({ ...p, [m.name]: v }));
                  fetchTagInfo(`${m.name}:${v}`);
                }}
                options={m.sizes.map((s) => ({
                  value: s,
                  label: installedNames.has(`${m.name}:${s}`) ? `${s} ✓` : s,
                }))}
              />
            )}
            {facts && <span className="ollama-catalog-facts">{facts}</span>}
          </div>
          <button
            type="button"
            className={`ollama-action-btn${isInstalled ? "" : " primary"}`}
            disabled={!!busy[busyKey]}
            title={t(isInstalled ? "ollama.tagUpdateTitle" : "ollama.tagDownloadTitle", {
              name: fullName,
              size: tagSizeSuffix(info),
            })}
            onClick={() =>
              void withBusy(busyKey, () => invoke("pull_ollama_model", { model: fullName }))
            }
          >
            {busy[busyKey]
              ? pullText(fullName, t("ollama.pulling"))
              : isInstalled
                ? t("ollama.update")
                : t("ollama.pull")}
          </button>
        </div>
      </div>
    );
  };

  const filterGroup = (
    label: string,
    anyActive: boolean,
    onAny: () => void,
    items: { key: string; label: string; active: boolean; toggle: () => void }[],
  ) => (
    <div className="ollama-filter-group">
      <span className="ollama-filter-label">{label}</span>
      <div className="ollama-seg" role="group" aria-label={label}>
        <button type="button" className={anyActive ? "active" : ""} aria-pressed={anyActive} onClick={onAny}>
          {t("ollama.any")}
        </button>
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={it.active ? "active" : ""}
            aria-pressed={it.active}
            onClick={it.toggle}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <SettingsHeader title={t("ollama.modelsTitle")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">

      <div className={`ollama-status-card${serverRunning === false ? " down" : ""}`}>
        <div className="ollama-status-main">
          <span className={`ollama-status-dot ${serverRunning ? "running" : "stopped"}`} />
          <div className="ollama-status-copy">
            <div className="ollama-status-title">
              {serverRunning === null
                ? t("ollama.checkingEllipsis")
                : serverRunning
                  ? t("ollama.serverRunning")
                  : t("ollama.serverNotRunning")}
            </div>
            {serverRunning === true && <div className="ollama-status-sub">{loadedLabel}</div>}
          </div>
          {serverRunning === false && (
            <button type="button" className="ollama-action-btn primary" onClick={() => void startServer()}>
              {t("ollama.start")}
            </button>
          )}
          {serverRunning === true && (
            <button
              type="button"
              className="ollama-action-btn"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {loading ? "..." : t("ollama.refresh")}
            </button>
          )}
        </div>
        {installed && serverRunning === true && (
          <div className="ollama-runtime-row">
            <span className="ollama-runtime-name">
              {ollamaVersion?.current
                ? ollamaVersion.latest && !ollamaVersion.update_available
                  ? t("localModel.ollamaVersionCurrent", { current: ollamaVersion.current })
                  : t("localModel.ollamaVersion", { current: ollamaVersion.current })
                : "Ollama"}
            </span>
            <span className="lm-status-actions">
              {!checkingUpdates && checkResult && !(checkResult.ok && checkResult.updates > 0) && (
                <span className="lm-status-note">
                  {checkResult.ok ? t("localModel.updatesNone") : checkResult.reason}
                </span>
              )}
              {ollamaVersion?.update_available && (
                <button
                  type="button"
                  className="ollama-action-btn primary"
                  title={`${t("localModel.ollamaUpdateSentence", {
                    latest: ollamaVersion.latest,
                    current: ollamaVersion.current,
                  })} — ${t("localModel.ollamaUpgradeTitle", { latest: ollamaVersion.latest })}`}
                  onClick={() =>
                    upgradeOllamaInTab(
                      t,
                      ollamaVersion,
                      models.filter((m) => m.running).map((m) => m.name),
                    )
                  }
                >
                  {t("localModel.ov.upgradeTo", { latest: ollamaVersion.latest })}
                </button>
              )}
              {models.length > 0 && (
                <button
                  type="button"
                  className="ollama-action-btn"
                  disabled={checkingUpdates}
                  title={t("localModel.checkUpdatesTitle")}
                  onClick={() => runOllamaUpdateCheck(t)}
                >
                  {checkingUpdates ? t("localModel.checkingUpdates") : t("localModel.checkUpdates")}
                </button>
              )}
            </span>
          </div>
        )}
        <div className="ollama-runtime-row">
          <span className="ollama-runtime-name">{t("ollama.vibeTitle")}</span>
          <span className={`ollama-runtime-state${vibeInstalled ? " ok" : ""}`}>
            {vibeInstalled === null
              ? t("ollama.checkingEllipsis")
              : vibeInstalled
                ? t("ollama.vibeReady")
                : t("ollama.vibeNotInstalled")}
          </span>
        </div>
        {vibeInstalled === false && <div className="ollama-runtime-install">{vibeInstallBlock}</div>}
      </div>

      {error && <ErrorNote className="project-dialog-error" error={error} />}

      {(() => {
        // Interrupted entries not currently being (re)pulled — these get a
        // "Continue" action; live pulls show their streaming progress bar.
        const resumable = interrupted.filter((m) => !(m in pullProgress) && !paused.includes(m));
        if (
          Object.keys(pullProgress).length === 0 &&
          resumable.length === 0 &&
          paused.length === 0 &&
          orphans.length === 0
        )
          return null;
        return (
          <>
            {sectionHead(t("ollama.downloadingTitle"))}
            <div className="settings-list">
              {Object.entries(pullProgress).map(([model, pr]) => (
                <div className="ollama-model-row" key={model}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{model}</span>
                    <span className="ollama-model-size">
                      {pr.pct != null ? `${pr.pct}%` : "…"}
                    </span>
                  </div>
                  <div className="ollama-download-bar">
                    <div
                      className={`ollama-download-bar-fill${pr.pct == null ? " indeterminate" : ""}`}
                      style={pr.pct != null ? { width: `${pr.pct}%` } : undefined}
                    />
                  </div>
                  {pr.status && <div className="ollama-download-status">{pr.status}</div>}
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn"
                      title={t("ollama.pauseTitle")}
                      onClick={() => pausePull(model)}
                    >
                      {t("ollama.pause")}
                    </button>
                  </div>
                </div>
              ))}
              {paused.map((model) => (
                <div className="ollama-model-row" key={`paused:${model}`}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{model}</span>
                    <span className="ollama-model-size">{t("ollama.pausedBadge")}</span>
                  </div>
                  <div className="ollama-download-status">{t("ollama.downloadPaused")}</div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn primary"
                      onClick={() => resumePull(model)}
                    >
                      {t("ollama.resume")}
                    </button>
                    <button
                      type="button"
                      className="ollama-ghost-btn danger"
                      title={t("ollama.deletePartialTitle")}
                      onClick={() => deletePausedPull(model)}
                    >
                      {t("ollama.delete")}
                    </button>
                  </div>
                </div>
              ))}
              {resumable.map((model) => (
                <div className="ollama-model-row" key={`int:${model}`}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{model}</span>
                    <span className="ollama-model-size">{t("ollama.interruptedBadge")}</span>
                  </div>
                  <div className="ollama-download-status">{t("ollama.downloadInterrupted")}</div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn primary"
                      onClick={() => continuePull(model)}
                    >
                      {t("ollama.continueDownload")}
                    </button>
                    <button
                      type="button"
                      className="ollama-ghost-btn"
                      title={t("ollama.dismissTitle")}
                      onClick={() => dismissPull(model)}
                    >
                      {t("ollama.dismiss")}
                    </button>
                  </div>
                </div>
              ))}
              {orphans.length > 0 && (
                <div className="ollama-download-status">
                  {t(orphans.length === 1 ? "ollama.orphansSummaryOne" : "ollama.orphansSummaryMany", {
                    count: orphans.length,
                    size: fmtBytes(orphans.reduce((sum, o) => sum + o.size, 0)),
                  })}
                </div>
              )}
              {orphans.map((o) => (
                <div className="ollama-model-row" key={o.path}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{t("ollama.orphanLayer", { digest: o.digest })}</span>
                    <span className="ollama-model-size">{fmtBytes(o.size)}</span>
                  </div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-ghost-btn danger"
                      title={t("ollama.deleteLayerTitle")}
                      onClick={() => deleteOrphan(o.path)}
                    >
                      {t("ollama.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        );
      })()}

      {sectionHead(t("ollama.downloadedModelsTitle"), loading ? undefined : models.length)}
      {loading ? (
        <div className="ollama-empty">{t("common.loading")}</div>
      ) : models.length === 0 ? (
        <div className="ollama-empty">{t("ollama.noModelsDownloaded")}</div>
      ) : (
        <div className="settings-list">
          {models.map((m) => {
            const loadingNow = busy[`${m.name}:load`] || loads[m.name] === "loading";
            const meta = [fmtBytes(m.size), m.parameter_size, m.quantization, m.family]
              .filter(Boolean)
              .join(" · ");
            return (
              <div className={`ollama-model-row ollama-model-card${m.running ? " running" : ""}`} key={m.name}>
                <div className="ollama-model-header">
                  <span className="ollama-model-name">{m.name}</span>
                  {m.running && (
                    <span className={`ollama-live${m.size_vram > 0 ? " gpu" : ""}`}>
                      {t("ollama.inMemory")} · {m.size_vram > 0 ? `GPU ${fmtBytes(m.size_vram)}` : "CPU"}
                    </span>
                  )}
                </div>
                <div className="ollama-model-meta">{meta}</div>
                <div className="ollama-model-actions">
                  {m.running ? (
                    <button
                      type="button"
                      className="ollama-action-btn"
                      disabled={busy[`${m.name}:stop`]}
                      title={t("ollama.unloadTitle")}
                      onClick={() =>
                        void withBusy(`${m.name}:stop`, () =>
                          invoke("stop_ollama_model", { model: m.name }),
                        )
                      }
                    >
                      {busy[`${m.name}:stop`] ? "..." : t("ollama.unload")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ollama-action-btn primary"
                      disabled={loadingNow}
                      title={t("ollama.loadTitle")}
                      onClick={() =>
                        void withBusy(`${m.name}:load`, () =>
                          invoke("load_ollama_model", { model: m.name }),
                        )
                      }
                    >
                      {loadingNow ? t("ollama.loading") : t("ollama.load")}
                    </button>
                  )}
                  <span className="ollama-model-actions-end">
                    <button
                      type="button"
                      className={`ollama-ghost-btn${updateVerdicts[m.name]?.update_available ? " primary" : ""}`}
                      disabled={busy[`${m.name}:pull`]}
                      title={t("ollama.updateTitle")}
                      onClick={() =>
                        void withBusy(`${m.name}:pull`, () =>
                          invoke("pull_ollama_model", { model: m.name }),
                        )
                      }
                    >
                      {busy[`${m.name}:pull`] ? pullText(m.name, t("ollama.updating")) : t("ollama.update")}
                    </button>
                    <button
                      type="button"
                      className="ollama-ghost-btn danger"
                      disabled={busy[`${m.name}:del`]}
                      title={t("ollama.deleteModelTitle")}
                      onClick={() =>
                        void withBusy(`${m.name}:del`, () =>
                          invoke("delete_ollama_model", { model: m.name }),
                        )
                      }
                    >
                      {busy[`${m.name}:del`] ? "..." : t("ollama.delete")}
                    </button>
                  </span>
                </div>
                {loadingNow && (
                  <div className="ollama-load-progress" title={t("ollama.loadingIntoMemoryTitle")}>
                    <div className="ollama-download-bar">
                      <div className="ollama-download-bar-fill indeterminate" />
                    </div>
                    <span className="ollama-download-status">{t("ollama.loadingIntoMemory")}</span>
                  </div>
                )}
                <label className="ollama-model-autostart">
                  <span>{t("ollama.loadAtStart")}</span>
                  <Toggle
                    size="sm"
                    checked={autoloadModels.includes(m.name)}
                    onChange={() => toggleAutoload(m.name)}
                    title={t("ollama.autostartToggleTitle", { name: m.name })}
                  />
                </label>
              </div>
            );
          })}
        </div>
      )}

      {models.length > 0 && (
        <SettingsCard className="ollama-startup">
          <div className="settings-subheader">
            {t("ollama.autostartTitle")} <UntestedTag id="ollama.autostartTitle" />
          </div>
          <ToggleRow
            label={t("ollama.autostartInSaver")}
            checked={saverPref}
            onChange={(e) => setSaverPref(e.target.checked)}
            aside={saverSaved ? <span className="ollama-status-text">{t("ollama.autostartSaved")}</span> : null}
          />
          <p className="settings-help">{t("ollama.autostartInSaverHelp")}</p>
        </SettingsCard>
      )}

      <SettingsAdvanced title={t("ollama.storageTitle")}>
        <SettingsCard>
          <div className="settings-subheader">
            {t("ollama.modelLocationTitle")} <UntestedTag id="ollama.modelLocationTitle" />
          </div>
          <div className="ollama-path-row">
            <code className="ollama-path" title={modelsPath || modelsDirPlan?.default_dir}>
              {modelsPath || modelsDirPlan?.default_dir || "…"}
            </code>
            {!modelsPath && <span className="ollama-path-default">{t("common.default")}</span>}
            <button type="button" className="ollama-action-btn" onClick={() => void chooseModelsDir()}>
              {t("ollama.modelLocationBrowse")}
            </button>
            {modelsPath && (
              <button type="button" className="ollama-action-btn" onClick={clearModelsDir}>
                {t("ollama.modelLocationReset")}
              </button>
            )}
          </div>
          <p className="settings-help">{t("ollama.modelLocationHelp")}</p>
          {modelsDirPlan?.systemd_service && (
            <>
              <p className="settings-help">{t("ollama.modelLocationSystemdHelp")}</p>
              {modelsDirPlan.service_cmd && (
                <div className="ollama-install-cmd-row">
                  <button
                    type="button"
                    className="ollama-action-btn primary"
                    title={modelsDirPlan.service_cmd}
                    onClick={applyModelsDirToService}
                  >
                    {t("ollama.modelLocationApply")}
                  </button>
                </div>
              )}
            </>
          )}
        </SettingsCard>
      </SettingsAdvanced>

      {sectionHead(
        <>
          {t("ollama.browseRegistry")} <UntestedTag id="ollama.browseRegistry" />
        </>,
      )}

      <div className="ollama-browse-bar">
        <input
          type="text"
          className="ollama-search-input"
          placeholder={t("ollama.searchOrPullPlaceholder")}
          aria-label={t("ollama.searchOrPullPlaceholder")}
          value={regQuery}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={typedBusy}
          onChange={(e) => setRegQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typedIsRef) void pullTyped();
          }}
        />
        {typedIsRef && (
          <button
            type="button"
            className="ollama-action-btn primary ollama-pull-ref"
            disabled={typedBusy}
            title={typedRef}
            onClick={() => void pullTyped()}
          >
            {typedBusy ? pullText(typedRef, t("ollama.pulling")) : t("ollama.pullRef", { ref: typedRef })}
          </button>
        )}
      </div>

      <div className="ollama-filters">
        {filterGroup(
          t("ollama.filterType"),
          regTypes.size === 0,
          () => setRegTypes(new Set()),
          REGISTRY_TYPES.map((cap) => ({
            key: cap,
            label: t(`ollama.cap.${cap}` as TranslationKey),
            active: regTypes.has(cap),
            toggle: () => toggleType(cap),
          })),
        )}
        {filterGroup(
          t("ollama.filterRuns"),
          regRuns === "",
          () => setRegRuns(""),
          REGISTRY_RUNS.map((where) => ({
            key: where,
            label: t(`ollama.runs.${where}`),
            active: regRuns === where,
            toggle: () => setRegRuns((prev) => (prev === where ? "" : where)),
          })),
        )}
        {filterGroup(
          t("ollama.filterDownload"),
          regDownload === "",
          () => setRegDownload(""),
          REGISTRY_DOWNLOAD_SIZES.map((cap) => ({
            key: cap,
            label: cap === "over64" ? t("ollama.sizeOver", { gb: 64 }) : t("ollama.sizeUpTo", { gb: cap }),
            active: regDownload === cap,
            toggle: () => setRegDownload((prev) => (prev === cap ? "" : cap)),
          })),
        )}
        <label className="ollama-sort-label" title={t("ollama.sortBy")}>
          {t("ollama.sortBy")}
          <Dropdown
            className="ollama-catalog-sort"
            value={sortBy}
            onChange={(v) => setSortBy(v as SortKey)}
            options={SORT_OPTIONS.map((o) => ({ value: o.key, label: t(o.labelKey) }))}
          />
        </label>
      </div>

      {regError && (
        <div className="ollama-reg-error">
          <ErrorNote className="project-dialog-error" error={regError} />
          <button
            type="button"
            className="ollama-action-btn"
            disabled={regLoading}
            onClick={() => void loadRegistryPage(1, true)}
          >
            {t("ollama.refresh")}
          </button>
        </div>
      )}

      <div className="settings-list">
        {regModels.map(registryCard)}

        {/* Lazy-load sentinel + status line. */}
        {regLoading && <div className="ollama-empty">{t("common.loading")}</div>}
        {!regLoading && !regError && regModels.length === 0 && (
          <div className="ollama-empty">{t("ollama.noModelsFound")}</div>
        )}
        <div ref={sentinelRef} aria-hidden="true" />
        {regDone && regModels.length > 0 && (
          <div className="ollama-empty">{t("ollama.endOfResults")}</div>
        )}
      </div>
      </div>
    </>
  );
}
