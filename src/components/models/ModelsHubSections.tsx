import type { ReactNode } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useOllamaAutoloadStore } from "../../stores/agents/ollamaAutoload";
import { useOllamaUpgradeStore } from "../../stores/agents/ollamaUpgrade";
import type { LocalModelInfo } from "../../stores/agents/ollamaActivity";
import type { OllamaModelUpdate } from "../../lib/agents/localDrivers";
import { runInstallInTab, type InstallShellKind } from "../../lib/installCommand";
import {
  formatBytes,
  formatTempC,
  gpuAdapterTooltip,
  gpuBusy,
  gpuHottest,
  gpuPercent,
  gpuTone,
  gpuTotals,
} from "../../lib/gpu";
import { useT, type TranslationKey } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { DEFAULT_COMPACT_AGENT_IDS } from "../tabs/newTabItems";
import { useAutoloadNotice, type HubAgentInfo, type ModelsHub } from "./useModelsHub";

/**
 * The Models & agents sections, rendered by both surfaces: the header's hover
 * dropdown (`layout/LocalModelMenu`) and the overlay's tabs
 * (`models/ModelsOverlay`). Moved out of the dropdown verbatim — same markup,
 * same classes — so the dropdown stays pixel-identical and the overlay's rows
 * are the dropdown's rows, never a second design of them. The data and the
 * verbs come from `useModelsHub`; these only draw.
 */

/**
 * True only when Ollama positively said this model has no tool-calling support
 * — the thing that makes it unusable for Codex, Claude Code, OpenCode, Droid
 * and OpenClaw, all of which drive a model through tool calls. Everything else
 * (an empty list, an older backend that doesn't send the field) is *unknown*
 * and reads as fine, because a marker that appears when a probe fails teaches
 * the user to ignore it.
 */
function lacksTools(m: LocalModelInfo): boolean {
  const caps = m.capabilities;
  return !!caps && caps.length > 0 && !caps.includes("tools");
}

/**
 * Ollama says this model produces embeddings and cannot complete text at all.
 * Shown *instead of* the no-tools chip, never beside it: every embedding model
 * also lacks tools, so both would be true — but "no tools" understates this one
 * badly. It reads as "usable, just not for agent tabs", when in fact the model
 * cannot answer a prompt at all, and someone picking it as their default local
 * model would find nothing works rather than one thing missing.
 */
function isEmbeddingOnly(m: LocalModelInfo): boolean {
  const caps = m.capabilities;
  return !!caps && caps.includes("embedding") && !caps.includes("completion");
}

/**
 * A capability Ollama positively reported. Absence is *unknown*, never "no" —
 * the same rule `lacksTools` follows, and the reason these tags only ever
 * appear rather than being negated: an empty list means the probe failed (see
 * `LocalModelInfo.capabilities`), and a badge drawn from a failed probe is
 * worse than no badge.
 */
function hasCapability(m: LocalModelInfo, cap: string): boolean {
  return !!m.capabilities && m.capabilities.includes(cap);
}

/**
 * The tasks a loaded model can be tagged for. Each maps to a key under
 * `settings.ollama_roles`; a model wearing a tag is the one used for that task
 * (autocomplete in the editor, "Local Model" agent tabs), so several
 * resident models can each own a different job. A task with no tag falls back to
 * the default `ollama_model`. Mirrors the consumers in `FileViewerPane`/`TabBar`.
 *
 * `pending` marks a tag whose *consumer* does not exist yet — the tag is stored
 * and shown, and nothing reads it. It is offered anyway because the assignment
 * is the user's statement about which model a job may use, and it has to be
 * answerable before the job exists rather than after: `mail` is the model a
 * future mail task (importance scoring, summaries) will run on, and until that
 * lands the chip says so in its tooltip rather than quietly implying a feature.
 */
export const MODEL_ROLES: Array<{ key: string; labelKey: TranslationKey; pending?: boolean }> = [
  { key: "autocomplete", labelKey: "localModel.role.autocomplete" },
  // Plain text, Markdown and TeX ask for this one first (an instruct model suits
  // prose; a fill-in-the-middle coder model suits code) and fall back to the
  // `autocomplete` tag, so leaving it unset keeps one model for both.
  { key: "autocomplete_prose", labelKey: "localModel.role.autocompleteProse" },
  { key: "tabs", labelKey: "localModel.role.tabs" },
  // `mail` was `pending` until Group Q; the mail assistant (#204–#208) now reads
  // this role, so the chip is live — a resident model can be pinned to it and the
  // mail features run against it.
  { key: "mail", labelKey: "localModel.role.mail" },
];

/**
 * One row of the Machine group: a fixed label, the reading, a secondary fact,
 * and the meter under all three. The meter carries the tone (green/amber/red by
 * *ratio*, `gpuTone` — a pure percentage function despite the name), so the text
 * stays plain and one glance across three bars answers "will the next model fit"
 * without reading a single number.
 */
function StatMeter({
  label,
  value,
  note,
  detail,
  percent,
  title,
}: {
  label: string;
  value: string;
  /** A sensor reading beside the value (temperature, utilization); omitted when
      the driver won't report one, rather than shown as a zero. */
  note?: string | null;
  detail: string;
  /** 0–100; drives both the bar's width and its tone. */
  percent: number;
  title: string;
}) {
  const pct = Math.min(100, Math.max(0, percent));
  return (
    <div className="local-model-stat" title={title}>
      <div className="local-model-stat-head">
        <span className="local-model-stat-label">{label}</span>
        <span className="local-model-stat-value">{value}</span>
        {note && <span className="local-model-stat-note">{note}</span>}
        <span className="local-model-stat-detail">{detail}</span>
      </div>
      <div className="local-model-meter">
        <div
          className={`local-model-meter-fill ${gpuTone(pct, 100)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * The "can't run agents" marker on a model row. Shown on **both** lists —
 * resident and on-disk — because the fact belongs to the model, not to whether
 * it happens to be in memory: picking a completion-only model as the default is
 * what silently empties the + menu's Local Model group, and this is the only
 * place that decision is made.
 */
function NoToolsChip({ name, t }: { name: string; t: (k: TranslationKey, v?: Record<string, string>) => string }) {
  return (
    <span
      className="local-model-chip local-model-notools-chip"
      title={t("localModel.noToolsTitle", { name })}
    >
      {t("localModel.noToolsChip")}
    </span>
  );
}

/**
 * The stronger sibling of the no-tools chip: this model does embeddings only.
 * Same warning tone rather than a danger one, for the same reason — the model
 * is not broken, it simply answers a different question than the one this menu
 * is mostly about. See `isEmbeddingOnly` for why it replaces the other chip.
 */
function EmbeddingOnlyChip({
  name,
  t,
}: {
  name: string;
  t: (k: TranslationKey, v?: Record<string, string>) => string;
}) {
  return (
    <span
      className="local-model-chip local-model-notools-chip"
      title={t("localModel.embeddingTitle", { name })}
    >
      {t("localModel.embeddingChip")}
    </span>
  );
}

/**
 * A plain fact about a model — its quantization, its size on disk, a capability
 * Ollama reported. Deliberately NEUTRAL: the only coloured chip on a card is
 * the caveat (no-tools / embeddings-only), and that is the whole point of it.
 * A row of coloured facts beside it would cost the caveat exactly the
 * visibility it exists for.
 */
function ModelChip({ label, title }: { label: string; title: string }) {
  return (
    <span className="local-model-chip" title={title}>
      {label}
    </span>
  );
}

/**
 * The capability tags a model earns by reporting them: vision, thinking. Shared
 * by both lists so a model reads the same whether or not it happens to be in
 * memory — the facts belong to the model, not to its residency.
 */
function CapabilityChips({
  m,
  t,
}: {
  m: LocalModelInfo;
  t: (k: TranslationKey, v?: Record<string, string>) => string;
}) {
  return (
    <>
      {hasCapability(m, "vision") && (
        <ModelChip label={t("localModel.visionChip")} title={t("localModel.visionTitle", { name: m.name })} />
      )}
      {hasCapability(m, "thinking") && (
        <ModelChip label={t("localModel.thinkingChip")} title={t("localModel.thinkingTitle", { name: m.name })} />
      )}
    </>
  );
}

/**
 * The caveat chip, if this model has one — embeddings-only outranking no-tools,
 * never both. One component so the two lists cannot disagree about which of the
 * two a given model deserves.
 */
function CaveatChip({
  m,
  t,
}: {
  m: LocalModelInfo;
  t: (k: TranslationKey, v?: Record<string, string>) => string;
}) {
  if (isEmbeddingOnly(m)) return <EmbeddingOnlyChip name={m.name} t={t} />;
  if (lacksTools(m)) return <NoToolsChip name={m.name} t={t} />;
  return null;
}

/**
 * A model row's update control: the button when the registry has a newer
 * manifest, a muted "couldn't check" when it couldn't be reached, and nothing
 * at all otherwise — including before any check has run. Silence is the right
 * default here: an "up to date" tick nobody asked for would be a claim made
 * from no evidence.
 */
function UpdateAction({
  update,
  busy,
  onUpdate,
  t,
}: {
  update: OllamaModelUpdate | undefined;
  busy: boolean;
  onUpdate: () => void;
  t: (k: TranslationKey, v?: Record<string, string>) => string;
}) {
  if (!update) return null;
  if (update.error) {
    return (
      <span className="local-model-update-note" title={update.error}>
        {t("localModel.updateUnknown")}
      </span>
    );
  }
  if (!update.update_available) return null;
  return (
    <button
      type="button"
      className="local-model-role-chip local-model-update-action"
      disabled={busy}
      title={t("localModel.updateTitle", { name: update.model })}
      onClick={onUpdate}
    >
      {busy ? t("localModel.updating") : t("localModel.update")}
    </button>
  );
}

/**
 * An installed agent CLI's four chips: Default · + tab · Root · MCP. Reads the
 * settings itself, so the dropdown's agent row and the overlay's Agents & CLIs
 * card (`AgentsPanel`'s `installedExtras`) are the same control.
 *
 * `wiredClis` is `root_mcp_status().wired_clis`; `null` until it is read — and
 * on a backend that predates the field — which then shows no MCP chip rather
 * than guessing.
 */
export function AgentChips({ agent: a, wiredClis }: { agent: HubAgentInfo; wiredClis: string[] | null }) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  // The agent Tabtivity picks on its own when a feature needs exactly one and the
  // user hasn't chosen per-instance (today: scaffold-fill "Agent choice"; more
  // features are expected to read this same setting rather than each growing
  // its own agent picker). Falls back to Claude, matching every existing reader.
  const defaultAgentCmd = settings?.default_agent_cmd ?? "claude";
  const setDefaultAgent = (id: string) => {
    void updateSettings({ default_agent_cmd: id });
  };
  // The tag is a compact-menu preference, not an enable/disable switch: the
  // complete installed CLI list remains searchable from every + tab menu.
  const compactAgentIds = settings?.compact_tab_agents ?? DEFAULT_COMPACT_AGENT_IDS;
  const toggleCompactAgent = (id: string) => {
    const next = compactAgentIds.includes(id)
      ? compactAgentIds.filter((agentId) => agentId !== id)
      : [...compactAgentIds, id];
    void updateSettings({ compact_tab_agents: next });
  };
  // Which agents the root console offers. Opt-in, default none: a root agent
  // gets the root MCP tools (calendar, board, project list) no project agent
  // has. Read by `useAddTabMenuData` for the root scope's + menus.
  const rootAgentIds = settings?.root_agents ?? [];
  // Root = the agent may run in the root console; MCP = it runs there *with*
  // the root MCP tools, so MCP implies Root. Stored as binaries, since that is
  // all the backend sees at spawn; unset falls back to the root agents (before
  // the chip was a switch, every root agent got the tools).
  const mcpAgentIds = settings?.root_mcp_agents ?? rootAgentIds;
  const matches = (ids: string[], x: HubAgentInfo) => ids.includes(x.id) || ids.includes(x.bin);
  const without = (ids: string[], x: HubAgentInfo) => ids.filter((id) => id !== x.id && id !== x.bin);
  const toggleRootAgent = (x: HubAgentInfo) => {
    if (!matches(rootAgentIds, x)) {
      void updateSettings({ root_agents: [...rootAgentIds, x.id] });
      return;
    }
    // Off in root means off with the tools too.
    void updateSettings({
      root_agents: without(rootAgentIds, x),
      root_mcp_agents: without(mcpAgentIds, x),
    });
  };
  const toggleMcpAgent = (x: HubAgentInfo, inMcp: boolean) => {
    if (inMcp) {
      void updateSettings({ root_mcp_agents: without(mcpAgentIds, x) });
      return;
    }
    void updateSettings({
      root_agents: matches(rootAgentIds, x) ? rootAgentIds : [...rootAgentIds, x.id],
      root_mcp_agents: [...without(mcpAgentIds, x), x.bin],
    });
  };
  // Only a CLI the backend names the server to (`WIRED_CLIS`) can call the
  // tools, and the two Settings switches can withhold them from every cloud
  // agent at once — the chip still records the choice, its title says why it
  // does nothing now.
  const mcpOn = settings?.root_mcp !== false;
  const mcpLocalOnly = settings?.root_mcp_local_only === true;
  const isDefault = a.id === defaultAgentCmd;
  const isCompact = compactAgentIds.includes(a.id) || compactAgentIds.includes(a.bin);
  const inRoot = rootAgentIds.includes(a.id) || rootAgentIds.includes(a.bin);
  const wired = !!wiredClis && (wiredClis.includes(a.bin) || wiredClis.includes(a.id));
  const mcp = {
    wired,
    on: inRoot && matches(mcpAgentIds, a),
    titleKey: (!wired
      ? "localModel.agentMcpNotWiredTitle"
      : !mcpOn
        ? "localModel.agentMcpOffTitle"
        : mcpLocalOnly
          ? "localModel.agentMcpLocalOnlyTitle"
          : inRoot && matches(mcpAgentIds, a)
            ? "localModel.agentMcpOnTitle"
            : "localModel.agentMcpSetTitle") as TranslationKey,
  };
  return (
    <div className="local-model-row-actions">
      <button
        type="button"
        className={`local-model-role-chip${isDefault ? " on" : ""}`}
        title={t(
          isDefault ? "localModel.isDefaultAgentTitle" : "localModel.setDefaultAgentTitle",
          { label: a.label },
        )}
        aria-pressed={isDefault}
        disabled={isDefault}
        onClick={() => setDefaultAgent(a.id)}
      >
        {t("localModel.setDefaultAgent")}
      </button>
      <button
        type="button"
        className={`local-model-role-chip${isCompact ? " on" : ""}`}
        title={t(
          isCompact ? "localModel.isCompactAgentTitle" : "localModel.setCompactAgentTitle",
          { label: a.label },
        )}
        aria-pressed={isCompact}
        onClick={() => toggleCompactAgent(a.id)}
      >
        {t("localModel.compactAgent")}
      </button>
      <button
        type="button"
        className={`local-model-role-chip${inRoot ? " on" : ""}`}
        title={t(
          inRoot ? "localModel.isRootAgentTitle" : "localModel.setRootAgentTitle",
          { label: a.label },
        )}
        aria-pressed={inRoot}
        onClick={() => toggleRootAgent(a)}
      >
        {t("localModel.rootChip")}
      </button>
      {wiredClis && (
        <button
          type="button"
          className={`local-model-role-chip${mcp.on ? " on" : ""}${
            mcp.wired ? "" : " local-model-role-chip-unwired"
          }`}
          title={t(mcp.titleKey, { label: a.label })}
          aria-pressed={mcp.on}
          disabled={!mcp.wired && !mcp.on}
          onClick={() => toggleMcpAgent(a, mcp.on)}
        >
          {t("localModel.mcpChip")}
        </button>
      )}
      <UntestedTag id="localModelMenu.1" />
    </div>
  );
}

/**
 * One model list — Running or On disk. The overlay tiles its cards as a grid
 * (`.local-model-grid`, the overview tiles' vocabulary); the dropdown keeps
 * its single column, and its rows stay direct children of the menu there.
 */
function ModelCards({ grid, children }: { grid: boolean; children: ReactNode }) {
  return grid ? <div className="local-model-grid">{children}</div> : <>{children}</>;
}

/**
 * The Local models section: the Manage / Install door, the update check and
 * version, the upgrade-restore and autoload notices, the downloads, then the
 * Running models (roles, Root, MCP, autostart, unload) with the iGPU notice
 * beside them, and the models On disk.
 *
 * `layout` decides the door's untested pill (dropdown only; inside the
 * overlay the door is a tab switch) and whether the model lists tile as a card
 * grid (overlay only, `ModelCards`). The "Local Models" band renders in both,
 * since it is what makes Running / On disk read as its parts. `onManageModels`
 * is the door — the dropdown opens the overlay's Ollama tab with it, the
 * overlay switches to that tab.
 */
export function LocalModelsSection({
  hub,
  layout,
  onManageModels,
}: {
  hub: ModelsHub;
  layout: "menu" | "overlay";
  onManageModels: () => void;
}) {
  const t = useT();
  const {
    installed,
    status,
    models,
    loading,
    error,
    downloads,
    paused,
    loads,
    updates,
    checkingUpdates,
    checkResult,
    version,
    unloading,
    gpuStatus,
    activeModel,
    autoload,
    roles,
    rootOffModels,
    checkUpdates,
    upgradeOllama,
    pausePull,
    resumePull,
    deletePausedPull,
    select,
    toggleRole,
    toggleRootModel,
    modelMcpOn,
    toggleMcpModel,
    updateModel,
    toggleAutoload,
    unloadFromMemory,
    loadIntoMemory,
  } = hub;

  // Putting the models back after an upgrade (`stores/agents/ollamaUpgrade`). Reported
  // for the same reason the autoload below is: nobody is watching a restart
  // that takes minutes, and a load that starts by itself must say that it did.
  const restorePhase = useOllamaUpgradeStore((s) => s.phase);
  const restoreModels = useOllamaUpgradeStore((s) => s.models);
  const restoreLoaded = useOllamaUpgradeStore((s) => s.loaded);
  const restoreFailed = useOllamaUpgradeStore((s) => s.failed);
  const restoreDismissed = useOllamaUpgradeStore((s) => s.dismissed);
  const restoreNow = useOllamaUpgradeStore((s) => s.reloadNow);
  const restoreCancel = useOllamaUpgradeStore((s) => s.cancel);
  const restoreDismiss = useOllamaUpgradeStore((s) => s.dismiss);
  const showRestoreNote = !restoreDismissed && restorePhase !== "idle";
  const restoreSentence = !showRestoreNote
    ? ""
    : restorePhase === "waiting"
      ? t("localModel.upgradeRestoreWaiting", { names: restoreModels.join(", ") })
      : restorePhase === "reloading"
        ? t("localModel.upgradeRestoreLoading", { names: restoreModels.join(", ") })
        : restorePhase === "done"
          ? t("localModel.upgradeRestoreDone", { names: restoreLoaded.join(", ") })
          : restorePhase === "timeout"
            ? t("localModel.upgradeRestoreTimeout", { names: restoreModels.join(", ") })
            : t("localModel.upgradeRestoreFailed", {
                names: Object.keys(restoreFailed).join(", "),
                error: Object.values(restoreFailed)[0] ?? "",
              });

  const autoNotice = useAutoloadNotice();
  const showAutoNote = autoNotice.show;
  const autoPhase = autoNotice.phase;
  const autoNoteTitle = autoNotice.sentence;
  const autoLoadNow = useOllamaAutoloadStore((s) => s.loadNow);
  const autoDismiss = useOllamaAutoloadStore((s) => s.dismiss);

  // Resident models are selectable; the rest are offered as "load into memory".
  const running = models.filter((m) => m.running);
  const available = models.filter((m) => !m.running);

  return (
    <>
      {/* In both layouts: in the overlay the band repeats the tab's name, but
          it is what makes Running / On disk (`is-sub`) read as its parts. */}
      <div className="tab-new-menu-group-label">{t("localModel.localModelsGroup")}</div>
      <button className="tab-new-menu-item" onClick={onManageModels}>
        <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
          ●
        </span>
        {installed ? t("localModel.manageLocalModels") : t("localModel.installOllamaEllipsis")}
        {/* The dropdown's door now opens the overlay's Ollama tab, not Settings;
            inside the overlay it is a tab switch and carries no pill. */}
        {layout === "menu" && <> <UntestedTag id="localModel.manageLocalModels" /></>}
      </button>
      {/* The menu's one outbound request, and the reason it is a button
          rather than part of the hover: Ollama has no "is there a newer
          version" API, so a check is a manifest-digest comparison against
          the registry — one HEAD per installed model. Cheap, but network,
          so it happens when it is asked for and at no other time. Verdicts
          land on the rows above; nothing appears against a model that is
          already current, because "up to date" is a claim with a shelf
          life and a stale tick is worse than no tick. */}
      {installed && models.length > 0 && (
        <div className="local-model-check-row">
          <button
            className="tab-new-menu-item"
            disabled={checkingUpdates}
            title={t("localModel.checkUpdatesTitle")}
            onClick={checkUpdates}
          >
            <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
              ●
            </span>
            {checkingUpdates ? t("localModel.checkingUpdates") : t("localModel.checkUpdates")}
            {/* The click must always report back — but only where nothing
                else does. A *found* update now shows itself: the green
                version pair beside this label, and an Update chip on each
                model's own row, so an "N available" count here was the same
                news a third time and the one number that could disagree with
                the two things it was counting. What is left is the pair of
                results that have no other surface: a clean check (every row
                stays silent when it is current, so without this a good
                result was indistinguishable from a dead button) and a failed
                one, which speaks in the reason the check itself gave. */}
            {!checkingUpdates && checkResult && !(checkResult.ok && checkResult.updates > 0) && (
              <span className="local-model-update-note">
                {checkResult.ok ? t("localModel.updatesNone") : checkResult.reason}
              </span>
            )}
          </button>
          {/* The version pair, and the whole reason this row is a `div` with
              two children rather than one button: what the check found is
              `v0.14.3 → v0.15.2`, and the *new number is the upgrade*. A
              separate "Update" chip repeated the same fact in a second
              place, and a control nested inside the check button would be a
              button within a button — invalid markup, and one click landing
              on two actions. Sibling, so the arrow-and-number is a real
              button with a real hit area. It sits outside the check button
              on the current path too: the row's `margin-left: auto` puts it
              in the same place either way, and a version that is sometimes
              part of the button's label and sometimes not would move.

              The sentence the retired notice carried (a server a few minor
              versions back is missing whole *features* rather than weights —
              `ollama launch`, the only wiring that stands up an
              Anthropic-compatible endpoint for Claude Code, does not exist
              before v0.15) is the tooltip, together with what the click
              does. Gated on `update_available`, i.e. both versions parsed
              and `latest` genuinely newer — never on `latest` alone. */}
          {version?.current &&
            (version.update_available ? (
              <button
                type="button"
                className="local-model-version-note has-update"
                title={`${t("localModel.ollamaUpdateSentence", {
                  latest: version.latest,
                  current: version.current,
                })} — ${t("localModel.ollamaUpgradeTitle", { latest: version.latest })}`}
                onClick={upgradeOllama}
              >
                {t("localModel.ollamaVersion", { current: version.current })}
                <span className="local-model-version-arrow" aria-hidden="true">
                  →
                </span>
                <span className="local-model-version-new">
                  {t("localModel.ollamaVersionLatest", { latest: version.latest })}
                </span>
              </button>
            ) : (
              <span className="local-model-version-note">
                {version.latest
                  ? t("localModel.ollamaVersionCurrent", { current: version.current })
                  : t("localModel.ollamaVersion", { current: version.current })}
              </span>
            ))}
        </div>
      )}
      {/* The upgrade's other half: what happened to the models it evicted.
          Directly under the row that started it, and it reports every phase
          rather than only the failures — a restart the user is waiting
          through, a load they did not ask for and a load that did not
          happen are three things they cannot see from anywhere else (the
          server is machine-wide, the terminal tab shows the installer, not
          Ollama's memory). Toned like the autoload notice it borrows its
          chrome from: amber for the wait that ran out, red for a model that
          would not come back. */}
      {showRestoreNote && (
        <div
          className={`local-model-autostart-note${
            restorePhase === "timeout" ? " saver" : restorePhase === "error" ? " failed" : ""
          }`}
        >
          <button
            type="button"
            className="local-model-autostart-dismiss"
            title={t("localModel.autostartDismiss")}
            aria-label={t("localModel.autostartDismiss")}
            onClick={restoreDismiss}
          >
            ✕
          </button>
          <div className="local-model-autostart-text">
            <span className="local-model-autostart-sentence">{restoreSentence}</span>
            <UntestedTag id="localModelMenu.2" />
          </div>
          {/* Waiting is the one phase with something to *stop*; the two
              that ended without the models being back are the ones with
              something to retry. A finished restore offers neither — the
              models are in memory, and the note is only there to say so. */}
          {restorePhase === "waiting" && (
            <div className="local-model-autostart-actions">
              <button
                type="button"
                className="local-model-role-chip"
                title={t("localModel.upgradeRestoreCancelTitle")}
                onClick={restoreCancel}
              >
                {t("localModel.upgradeRestoreCancel")}
              </button>
            </div>
          )}
          {(restorePhase === "timeout" || restorePhase === "error") && (
            <div className="local-model-autostart-actions">
              <button
                type="button"
                className="local-model-role-chip"
                title={t("localModel.upgradeRestoreNowTitle")}
                onClick={() => void restoreNow()}
              >
                {t("localModel.upgradeRestoreNow")}
              </button>
            </div>
          )}
        </div>
      )}
      {showAutoNote && (
        <div
          className={`local-model-autostart-note${
            autoPhase === "skipped" ? " saver" : autoPhase === "error" ? " failed" : ""
          }`}
        >
          {/* Corner ✕, not a chip in the action row: dismissing is not one of
              the note's offers, and while loading it was that row's only
              member — a lone ✕ floating where a button was expected. */}
          <button
            type="button"
            className="local-model-autostart-dismiss"
            title={t("localModel.autostartDismiss")}
            aria-label={t("localModel.autostartDismiss")}
            onClick={autoDismiss}
          >
            ✕
          </button>
          <div className="local-model-autostart-text">
            <span className="local-model-autostart-sentence">{autoNoteTitle}</span>
            <UntestedTag id="localModelMenu.3" />
          </div>
          {autoPhase !== "loading" && (
            <div className="local-model-autostart-actions">
              <button
                type="button"
                className="local-model-role-chip"
                title={t("localModel.autostartLoadNowTitle")}
                onClick={() => void autoLoadNow()}
              >
                {t("localModel.autostartLoadNow")}
              </button>
              {autoPhase === "skipped" && (
                <button
                  type="button"
                  className="local-model-role-chip"
                  title={t("localModel.autostartSettingsTitle")}
                  onClick={onManageModels}
                >
                  {t("localModel.autostartSettings")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {installed && (Object.keys(downloads).length > 0 || paused.length > 0) && (
        <div className="local-model-downloads">
          {Object.entries(downloads).map(([model, d]) => (
            <div key={model} className="local-model-download-row" title={t("localModel.downloadingTitle")}>
              <div className="local-model-download-head">
                <span className="local-model-loaded-name">{model}</span>
                <span className="local-model-download-pct">
                  {d.pct != null ? `${d.pct}%` : "…"}
                </span>
                <button
                  type="button"
                  className="local-model-download-action"
                  title={t("localModel.pauseDownloadTitle")}
                  onClick={() => pausePull(model)}
                >
                  {t("ollama.pause")}
                </button>
              </div>
              <div className="ollama-download-bar">
                <div
                  className={`ollama-download-bar-fill${d.pct == null ? " indeterminate" : ""}`}
                  style={d.pct != null ? { width: `${d.pct}%` } : undefined}
                />
              </div>
            </div>
          ))}
          {paused.map((model) => (
            <div key={`paused:${model}`} className="local-model-download-row" title={t("localModel.pausedTitle")}>
              <div className="local-model-download-head">
                <span className="local-model-loaded-name">{model}</span>
                <span className="local-model-download-pct">{t("ollama.pausedBadge")}</span>
                <button
                  type="button"
                  className="local-model-download-action"
                  title={t("localModel.resumeDownloadTitle")}
                  onClick={() => resumePull(model)}
                >
                  {t("ollama.resume")}
                </button>
                <button
                  type="button"
                  className="local-model-download-action danger"
                  title={t("localModel.deletePartialDownloadTitle")}
                  onClick={() => deletePausedPull(model)}
                >
                  {t("ollama.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {!installed ? (
        <div className="tab-new-menu-hint">{t("localModel.notInstalled")}</div>
      ) : loading && models.length === 0 ? (
        <div className="tab-new-menu-hint">{t("common.loading")}</div>
      ) : error ? (
        <div className="tab-new-menu-hint">{error}</div>
      ) : models.length === 0 ? (
        <div className="tab-new-menu-hint">
          {status === "stopped" ? t("localModel.serverStopped") : t("localModel.noModelsInstalled")}
        </div>
      ) : (
        <>
          {/* Resident models — selectable as the active local model. The
              pair of subheaders (running / on disk) is what splits this one
              section in two: the same model list, divided by the only fact
              that differs between the halves — whether it is in memory. */}
          <div className="tab-new-menu-group-label is-sub">{t("localModel.runningGroup")}</div>
          {running.length === 0 ? (
            <div className="tab-new-menu-hint">{t("ollama.noModelLoaded")}</div>
          ) : (
            <ModelCards grid={layout === "overlay"}>
            {running.map((m) => (
              <div key={m.name} className="local-model-row">
                <button
                  className="tab-new-menu-item local-model-pick"
                  title={t(
                    activeModel === m.name
                      ? "localModel.defaultLoadedTitle"
                      : "localModel.loadedClickDefaultTitle",
                  )}
                  onClick={() => select(m.name)}
                >
                  {/* Green lamp: this model is resident in Ollama's memory. */}
                  <span className="local-model-lamp" aria-hidden="true" />
                  <span className="local-model-loaded-name">{m.name}</span>
                  {activeModel === m.name && (
                    <span className="local-model-default-tag">{t("localModel.defaultTag")}</span>
                  )}
                  {/* Same tags as a "Load into memory" card, and deliberately
                      so: what a model can do belongs to the model, not to
                      whether it happens to be resident, so the two lists must
                      not describe one model differently. What this row adds is
                      the one fact that IS about residency — where it is
                      running. Disk size is the other list's: here the GPU/CPU
                      figure is the live and more useful number. */}
                  <span className="local-model-loaded-badges">
                    {m.parameter_size && <span>{m.parameter_size}</span>}
                    {m.quantization && <span>{m.quantization}</span>}
                    <CaveatChip m={m} t={t} />
                    <CapabilityChips m={m} t={t} />
                    <span className={m.size_vram > 0 ? "gpu" : "cpu"}>
                      {m.size_vram > 0 ? `GPU ${formatBytes(m.size_vram)}` : "CPU"}
                    </span>
                  </span>
                </button>
                {/* Task tags: pin this model to a job (autocomplete/
                    tabs/mail). Several loaded models can each own a different
                    one. A `pending` tag adds "nothing reads this yet" to its
                    tooltip — the chip must not imply a job that doesn't run. */}
                <div className="local-model-roles">
                  {MODEL_ROLES.map((r) => {
                    const on = roles[r.key] === m.name;
                    const roleLabel = t(r.labelKey);
                    const title = t(on ? "localModel.usedForRole" : "localModel.useForRole", {
                      role: roleLabel.toLowerCase(),
                      name: m.name,
                    });
                    return (
                      <button
                        key={r.key}
                        type="button"
                        className={`local-model-role-chip${on ? " on" : ""}`}
                        title={
                          r.pending ? `${title} — ${t("localModel.roleNotWired")}` : title
                        }
                        onClick={() => toggleRole(r.key, m.name)}
                      >
                        {roleLabel}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={`local-model-role-chip${
                      rootOffModels.includes(m.name) ? "" : " on"
                    }`}
                    title={t(
                      rootOffModels.includes(m.name)
                        ? "localModel.setRootModelTitle"
                        : "localModel.isRootModelTitle",
                      { name: m.name },
                    )}
                    aria-pressed={!rootOffModels.includes(m.name)}
                    onClick={() => toggleRootModel(m.name)}
                  >
                    {t("localModel.rootChip")}
                  </button>
                  <button
                    type="button"
                    className={`local-model-role-chip${modelMcpOn(m.name) ? " on" : ""}`}
                    title={t(
                      lacksTools(m)
                        ? "localModel.mcpNoToolsTitle"
                        : modelMcpOn(m.name)
                          ? "localModel.isMcpModelTitle"
                          : "localModel.setMcpModelTitle",
                      { name: m.name },
                    )}
                    aria-pressed={modelMcpOn(m.name)}
                    disabled={lacksTools(m) && !modelMcpOn(m.name)}
                    onClick={() => toggleMcpModel(m.name, modelMcpOn(m.name))}
                  >
                    {t("localModel.mcpChip")}
                  </button>
                  <UntestedTag id="localModelMenu.4" />
                  {/* The row's own two verbs, grouped and right-aligned: the
                      task tags above are a wrapping set, these are a column. */}
                  <div className="local-model-row-actions">
                    {/* Newer manifest in the registry — re-pull it. Shown
                        on a resident model too: being in memory says
                        nothing about the version on disk. */}
                    <UpdateAction
                      update={updates[m.name]}
                      busy={downloads[m.name] !== undefined}
                      onUpdate={() => updateModel(m.name)}
                      t={t}
                    />
                    {/* Load this model into memory on every Tabtivity start. */}
                    <button
                      type="button"
                      className={`local-model-role-chip local-model-autostart-chip${
                        autoload.includes(m.name) ? " on" : ""
                      }`}
                      title={t(
                        autoload.includes(m.name)
                          ? "localModel.autostartOnTitle"
                          : "localModel.autostartOffTitle",
                        { name: m.name },
                      )}
                      onClick={() => toggleAutoload(m.name)}
                    >
                      {t("localModel.autostartChip")}
                    </button>
                    {/* Evict this model from memory (keeps it on disk). */}
                    <button
                      type="button"
                      className="local-model-role-chip local-model-unload"
                      disabled={unloading.has(m.name)}
                      title={t("localModel.unloadFromMemoryTitle", { name: m.name })}
                      onClick={() => unloadFromMemory(m.name)}
                    >
                      {unloading.has(m.name) ? t("localModel.unloading") : t("ollama.unload")}
                    </button>
                  </div>
                </div>
              </div>
            ))}
            </ModelCards>
          )}
          {/* The resident model is on the CPU, this machine has a GPU, and
              the reason is the server's own integrated-GPU gate rather than
              a model that didn't fit. Raised **only** on `igpu_dropped` —
              the backend requires four facts to line up before setting it,
              and blaming a setting for an ordinary out-of-VRAM would send
              the user to reconfigure a system service for nothing. The fix
              runs in a visible terminal (it needs a root password, and a
              command that rewrites a service is one to read first) rather
              than being applied behind their back. */}
          {gpuStatus?.igpu_dropped && (
            <div className="local-model-igpu-notice">
              <div className="local-model-igpu-text">
                {t("localModel.igpuDropped")} <UntestedTag id="localModel.igpuDropped" />
              </div>
              {gpuStatus.fix_cmd ? (
                <button
                  type="button"
                  className="tab-new-menu-item local-model-igpu-fix"
                  title={gpuStatus.fix_cmd}
                  onClick={() =>
                    runInstallInTab(
                      t("localModel.igpuFixLabel"),
                      gpuStatus.fix_cmd,
                      gpuStatus.shell_kind as InstallShellKind,
                    )
                  }
                >
                  {t("localModel.igpuFixAction")}
                </button>
              ) : (
                <div className="local-model-igpu-text">{t("localModel.igpuFixManual")}</div>
              )}
            </div>
          )}
          {/* Installed-but-not-resident models — click to load into memory. */}
          {available.length > 0 && (
            <>
              {/* A subheader, not a fourth section: these rows still
                  belong to Local Models, and it names what the list IS
                  (models sitting on disk, not resident) rather than what
                  clicking does — every row already carries its own Load /
                  GPU / CPU verb, so a header repeating the verb said the
                  same thing one level up. */}
              <div className="tab-new-menu-group-label is-sub">{t("localModel.onDiskGroup")}</div>
              <ModelCards grid={layout === "overlay"}>
              {available.map((m) => {
                const st = loads[m.name];
                return (
                  <div key={m.name} className="local-model-load-row">
                    {/* Line 1 — what the model IS: its name at the left, its
                        dimensions at the right corner. The name takes the
                        slack, so the group is pinned to the card's right edge
                        however long the name is, and PARAMETER SIZE is last in
                        it: the corner itself is the one position that cannot
                        move, so the badge that is compared down the list gets
                        it, and a model missing a quantization or a disk figure
                        shifts only the chips inboard of it. */}
                    <div className="local-model-load-name-line">
                      <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
                        ●
                      </span>
                      <span className="local-model-loaded-name">{m.name}</span>
                      <span className="local-model-load-facts">
                        {m.size > 0 && (
                          <ModelChip
                            label={formatBytes(m.size)}
                            title={t("localModel.diskSizeTitle", { size: formatBytes(m.size) })}
                          />
                        )}
                        {m.quantization && (
                          <ModelChip
                            label={m.quantization}
                            title={t("localModel.quantTitle", { value: m.quantization })}
                          />
                        )}
                        {m.parameter_size && <ModelChip label={m.parameter_size} title={t("localModel.paramTitle", { value: m.parameter_size })} />}
                      </span>
                    </div>
                    {/* Line 2 — what you can DO with it: the tags at the left
                        corner, the verbs at the right. Nothing of variable width
                        precedes the tags, so they start at the card's left edge
                        on every card; the actions are pushed to the right edge by
                        the slack between them. The CAVEAT leads the group for the
                        mirror of line 1's reason — it is the chip worth finding
                        down the list, so it gets the position that cannot move. */}
                    <div className="local-model-load-line">
                      <span className="local-model-load-caps">
                        <CaveatChip m={m} t={t} />
                        <CapabilityChips m={m} t={t} />
                      </span>
                      {/* Armed-for-launch, then the row's verb. */}
                      <div className="local-model-row-actions">
                        {/* Newer manifest in the registry — re-pull it. */}
                        <UpdateAction
                          update={updates[m.name]}
                          busy={downloads[m.name] !== undefined}
                          onUpdate={() => updateModel(m.name)}
                          t={t}
                        />
                        {/* Arm it for the next launch without loading it now. */}
                        <button
                          type="button"
                          className={`local-model-role-chip local-model-autostart-chip${
                            autoload.includes(m.name) ? " on" : ""
                          }`}
                          title={t(
                            autoload.includes(m.name)
                              ? "localModel.autostartOnTitle"
                              : "localModel.autostartOffTitle",
                            { name: m.name },
                          )}
                          onClick={() => toggleAutoload(m.name)}
                        >
                          {t("localModel.autostartChip")}
                        </button>
                        {/* Where to load it. Two buttons whenever the
                            machine has a GPU at all, one when it has none —
                            a "GPU" button on a machine with no GPU is a
                            control that can only fail. They are not a
                            preference stored anywhere: which processor
                            suits a model depends on the model and on what
                            else is resident, so it is asked per load, at
                            the moment the answer is known. `auto` (the old
                            single button) stays the no-GPU path and the
                            default everywhere else in the app, because
                            deferring to Ollama's scheduler is a real third
                            answer, not the absence of one. */}
                        {st === "loading" || st === "error" ? (
                          <button
                            type="button"
                            className="local-model-role-chip local-model-load-action"
                            disabled={st === "loading"}
                            title={t(
                              st === "error"
                                ? "localModel.failedRetryTitle"
                                : "localModel.loadIntoMemoryTitle",
                            )}
                            onClick={() => loadIntoMemory(m.name)}
                          >
                            {st === "loading" ? t("common.loading") : t("localModel.failed")}
                          </button>
                        ) : gpuStatus?.gpu_present ? (
                          <>
                            <button
                              type="button"
                              className="local-model-role-chip local-model-load-action"
                              title={t("localModel.loadOnGpuTitle", { name: m.name })}
                              onClick={() => loadIntoMemory(m.name, "gpu")}
                            >
                              {t("localModel.loadOnGpu")}
                            </button>
                            <button
                              type="button"
                              className="local-model-role-chip local-model-load-action"
                              title={t("localModel.loadOnCpuTitle", { name: m.name })}
                              onClick={() => loadIntoMemory(m.name, "cpu")}
                            >
                              {t("localModel.loadOnCpu")}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="local-model-role-chip local-model-load-action"
                            title={t("localModel.loadIntoMemoryTitle")}
                            onClick={() => loadIntoMemory(m.name)}
                          >
                            {t("ollama.load")}
                          </button>
                        )}
                      </div>
                    </div>
                    {st === "loading" && (
                      <div className="ollama-download-bar local-model-load-bar">
                        <div className="ollama-download-bar-fill indeterminate" />
                      </div>
                    )}
                  </div>
                );
              })}
              </ModelCards>
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * The Machine group: CPU, RAM and GPU, each the *device's* figure. Its own
 * group, and the dropdown's last, because it is neither an agent nor a model:
 * it is what the machine has left for whichever of them you pick. The overlay
 * shows it as the strip above its Local models tab.
 */
export function MachineMeters({ hub }: { hub: ModelsHub }) {
  const t = useT();
  const { gpus, machine } = hub;
  const { used: gpuUsed, total: gpuTotal } = gpuTotals(gpus);
  const gpuBusyPct = gpuBusy(gpus);
  const showMachine = machine?.supported === true;
  // Windows reports no load average, so its zeroed triple is "no reading" rather
  // than an idle machine — printing `0.00` there would be a made-up measurement.
  const loadShown = showMachine && machine.load_avg.some((v) => v > 0);
  const cpuTemp = formatTempC(machine?.cpu_temp_c);
  // The two other thermal readings, each `null` wherever nothing answers: a DIMM
  // sensor is only wired on some boards, and a GPU driver may report memory
  // without reporting a temperature. Absent, never a zero — a fabricated 0 °C in
  // a row that is otherwise all real measurements is worse than a missing one.
  const memTemp = formatTempC(machine?.mem_temp_c);
  const gpuTemp = formatTempC(gpuHottest(gpus));
  const gpuNote =
    [gpuBusyPct != null ? t("localModel.gpuBusy", { pct: Math.round(gpuBusyPct) }) : null, gpuTemp]
      .filter(Boolean)
      .join(" · ") || null;
  const cpuTitle = !showMachine
    ? ""
    : [
        t("localModel.cpuTitle"),
        t("localModel.cpuCores", { cores: machine.num_cores }),
        loadShown
          ? t("localModel.cpuLoad", { load: machine.load_avg.map((v) => v.toFixed(2)).join(" ") })
          : null,
        cpuTemp,
      ]
        .filter(Boolean)
        .join("\n");
  const ramTitle = !showMachine
    ? ""
    : [
        t("localModel.ramTitle"),
        machine.swap_total_bytes > 0
          ? t("localModel.ramSwap", {
              used: formatBytes(machine.swap_used_bytes),
              total: formatBytes(machine.swap_total_bytes),
            })
          : null,
        memTemp ? t("localModel.ramTemp", { temp: memTemp }) : null,
      ]
        .filter(Boolean)
        .join("\n");
  return (
    <>
      {/* Its own group, and the menu's last, because it is neither an agent
          nor a model: it is what the machine has left for whichever of them
          you pick above it. Each row is the *device's* figure, never a
          model's share of it — what is free here is what the next model has
          to fit into — and a reading that cannot be taken is absent rather
          than zero (no GPU on an Intel-only box; no aggregate CPU/memory
          backend outside Linux/Windows/macOS; a DIMM sensor most boards
          don't wire), since a zero would read as "no room" or "stone cold".
          The meter is the point: a percentage toned green/amber/red says
          "will it fit" at a glance, which is the only question asked here. */}
      {(showMachine || gpus.length > 0) && (
        <>
          <div className="tab-new-menu-group-label local-model-machine-label">
            <span>{t("localModel.machineGroup")}</span>
          </div>
          <div className="local-model-stats">
            {showMachine && (
              <>
                <StatMeter
                  label="CPU"
                  value={t("localModel.cpuPercent", { pct: Math.round(machine.cpu_percent) })}
                  // Temperature only where a sensor answers. The tooltip
                  // carries the load average, a three-number reading no
                  // single row has room for.
                  note={cpuTemp}
                  detail={t("localModel.cpuCores", { cores: machine.num_cores })}
                  percent={machine.cpu_percent}
                  title={cpuTitle}
                />
                <StatMeter
                  label="RAM"
                  value={t("localModel.statUsedTotal", {
                    used: formatBytes(machine.mem_used_bytes),
                    total: formatBytes(machine.mem_total_bytes),
                  })}
                  // The hottest DIMM, on the boards that wire a sensor at
                  // all. Absent everywhere else — and absent is the common
                  // answer here, which is exactly why it must not be a zero.
                  note={memTemp}
                  detail={t("localModel.ramFree", {
                    free: formatBytes(
                      Math.max(0, machine.mem_total_bytes - machine.mem_used_bytes),
                    ),
                  })}
                  percent={gpuPercent(machine.mem_used_bytes, machine.mem_total_bytes)}
                  title={ramTitle}
                />
              </>
            )}
            {gpus.length > 0 && (
              <StatMeter
                label="GPU"
                value={t("localModel.statUsedTotal", {
                  used: formatBytes(gpuUsed),
                  total: formatBytes(gpuTotal),
                })}
                // Utilization and temperature, each only when a driver
                // reports it — `null` there means "the driver won't say",
                // not an idle or a cold GPU. The free headroom keeps the
                // row's end either way: it is the figure that answers
                // whether the next model fits.
                note={gpuNote}
                detail={t("localModel.gpuFree", { free: formatBytes(Math.max(0, gpuTotal - gpuUsed)) })}
                percent={gpuPercent(gpuUsed, gpuTotal)}
                title={gpus.map(gpuAdapterTooltip).join("\n")}
              />
            )}
          </div>
        </>
      )}
    </>
  );
}
