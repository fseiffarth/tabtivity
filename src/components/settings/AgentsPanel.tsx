import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { SettingsCard, SettingsHeader, SettingsList } from "../layout/settingsUi";
import { UntestedTag } from "../common/UntestedTag";
import { Dropdown } from "../common/Dropdown";
import { useSettingsStore } from "../../stores/settings";
import { AgentScheduleMcpSettings } from "../agents/AgentScheduleMcpSettings";
import { GitPushMcpSettings } from "../agents/GitPushMcp";
import { MarkupMcpSettings } from "../agents/MarkupMcpSettings";
import { cliInstallsByAdmin } from "../../lib/transport/linkState";
import { runInstallInTab } from "../../lib/installCommand";
import type { CustomAgent } from "../../types";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useT } from "../../lib/i18n";
import { notifyAgentRegistryChanged } from "../../lib/agents/agentRegistry";
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
import {
  AGENT_TAB_ACTIONS,
  chordLabel,
  modifierLabel,
  resolveChord,
} from "../../lib/shortcuts/shortcuts";
import { useShortcutOverrides } from "../../lib/shortcuts/shortcutHint";
import { NAMES } from "../../lib/brand";
import { runWithProgress } from "../../lib/runWithProgress";
import type { SubPanelProps } from "./subPanelProps";
import type {
  AgentVersionStale,
  AgentVersionReport,
  AgentUpdateReport,
  AgentInfo,
} from "./agentTypes";
import { AgentsHelp, AgentsStatus, AgentsFold, AgentsGroup } from "./agentsUi";
import {
  CodexHookNotice,
  ClaudeRemoteControlNotice,
  NODE_ENGINE_FAILURE,
  useNodeRuntimeStatus,
  NodeRuntimeNotice,
} from "./agentNotices";
import type { AgentLogin } from "./AgentLoginsRows";
import { CodexAutoReviewToggle, AgentAccounts } from "./AgentAccounts";
import { AgentFenceCard } from "./AgentFenceCard";
import { AgentCronSection } from "./AgentCronSection";
import { AgentComposerCard } from "./AgentComposerCard";

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
