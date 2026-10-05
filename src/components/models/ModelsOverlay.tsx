import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MODELS_OVERLAY_SECTIONS,
  useModelsOverlayStore,
  type ModelsOverlaySection,
} from "../../stores/modelsOverlay";
import { initLocalModelEvents, useOllamaActivityStore } from "../../stores/agents/ollamaActivity";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { saverInterval, useQuiesce } from "../../stores/power";
import { AGENT_REGISTRY_CHANGED_EVENT } from "../../lib/agents/agentRegistry";
import { ollamaVersionStatus } from "../../lib/agents/localDrivers";
import { PERSONAL_SKILLS, listInstalledSkills } from "../../lib/agents/skills";
import { useOllamaStatus } from "../../lib/ollamaStatus";
import { useT, type TranslationKey } from "../../lib/i18n";
import type { InstalledSkill } from "../../types/skills";
import { UntestedTag } from "../common/UntestedTag";
import { useFloatingFrame } from "../common/useFloatingFrame";
import { ArrowLeftIcon, ArrowRightIcon, InboxIcon, SparkleIcon, TerminalIcon } from "../common/icons/Icon";
import { ModelsGlyph } from "../header/HeaderGlyphs";
import { AgentsPanel, OllamaPanel } from "../layout/SettingsSubPanels";
import { SkillsLibraryView } from "../skills/SkillsLibraryView";
import { AgentChips, LocalModelsSection, MachineMeters } from "./ModelsHubSections";
import { useModelsHub, type HubAgentInfo } from "./useModelsHub";
import { storageKey } from "../../lib/brand";

/**
 * The **Models & agents overlay** — what a click on the header's processor-chip
 * button (`layout/LocalModelMenu`) opens. The hover dropdown stays as it was;
 * this is the room it points into: everything the dropdown does, plus what it
 * used to send to Settings for (installing and removing agent CLIs, installing
 * Ollama, its storage and catalog) — so no door in it leads out to Settings,
 * and Settings keeps its own Agents / Ollama pages unchanged.
 *
 * A **grid, not a tab strip**: a plain open lands on the overview — one tile
 * per section, each with a live summary (which CLIs are installed, what is on
 * disk and in memory, whether Ollama runs, how many skills) — and a tile opens
 * its section, with a back button in the bar to return. The dropdown's doors
 * deep-link straight into a section. Each section is a surface that already
 * exists rather than a second copy:
 *  - **Agents & CLIs** — Settings' `AgentsPanel`, each installed card carrying
 *    the dropdown's Default · + tab · Root · MCP chips (`AgentChips`), the
 *    cards tiled across the window;
 *  - **Local models** — the dropdown's own sections (`ModelsHubSections`) over
 *    the shared `stores/agents/ollamaActivity`, in its order: models, then the
 *    Machine meters;
 *  - **Ollama** — Settings' `OllamaPanel` (install, storage, pulls, catalog);
 *  - **Skills** — the machine-level skills library the retired SkillsOverlay
 *    hosted (`SkillsLibraryView` with no project).
 *
 * The chrome is the header overlays' one (`.root-overlay.subwindow`, moved and
 * resized by `useFloatingFrame`). A section mounts the first time it is opened
 * and then stays mounted, `hidden`, because install logs are component state;
 * the visited set resets on close (the host renders nothing while closed). The
 * overview itself holds nothing and is re-read each time it is shown.
 */
export function ModelsOverlayHost() {
  const open = useModelsOverlayStore((s) => s.open);
  if (!open) return null;
  return <ModelsOverlay />;
}

const SECTION_LABEL: Record<ModelsOverlaySection, TranslationKey> = {
  agents: "modelsOverlay.tab.agents",
  models: "modelsOverlay.tab.models",
  ollama: "modelsOverlay.tab.ollama",
  skills: "modelsOverlay.tab.skills",
};

const SECTION_INTRO: Record<ModelsOverlaySection, TranslationKey> = {
  agents: "modelsOverlay.intro.agents",
  models: "modelsOverlay.intro.models",
  ollama: "modelsOverlay.intro.ollama",
  skills: "modelsOverlay.intro.skills",
};

function SectionIcon({ id, size }: { id: ModelsOverlaySection; size: number }) {
  switch (id) {
    case "agents":
      return <TerminalIcon size={size} />;
    case "models":
      return (
        <span className="models-section-glyph" style={{ width: size, height: size }}>
          <ModelsGlyph className="models-section-glyph-svg" />
        </span>
      );
    case "ollama":
      return <InboxIcon size={size} />;
    case "skills":
      return <SparkleIcon size={size} />;
  }
}

const paneId = (id: ModelsOverlaySection) => `models-overlay-pane-${id}`;
const tileId = (id: ModelsOverlaySection) => `models-overlay-tile-${id}`;

function ModelsOverlay() {
  const t = useT();
  const view = useModelsOverlayStore((s) => s.view);
  const show = useModelsOverlayStore((s) => s.show);
  const close = () => useModelsOverlayStore.getState().close();
  // Moves, resizes and fills like the root console; remembered per overlay.
  const { frameRef, frameStyle, frameClass, barProps, grips, fillButton } =
    useFloatingFrame(storageKey("modelsOverlayFrame"));
  // `barProps.title` is the move hint; on the whole bar it would hover over the
  // back button too, so it goes on the mark alone (the root console's placement).
  const { title: moveHint, ...barRest } = barProps;

  // Sections visited this opening. A section is rendered once it has been shown
  // and is kept (hidden) after, so a running install's log survives a trip back
  // to the grid. Derived with the view so a first visit renders in the same
  // frame, not one effect later.
  const [visited, setVisited] = useState<ReadonlySet<ModelsOverlaySection>>(
    () => new Set(view === "home" ? [] : [view]),
  );
  useEffect(() => {
    if (view === "home") return;
    setVisited((v) => (v.has(view) ? v : new Set(v).add(view)));
  }, [view]);
  const mounted = (id: ModelsOverlaySection) => id === view || visited.has(id);

  // The section last shown, so the grid hands focus back to its tile — the
  // place a keyboard user left from.
  const lastSection = useRef<ModelsOverlaySection | null>(view === "home" ? null : view);
  const backRef = useRef<HTMLButtonElement>(null);
  // Focus leaves the header button on open (which gets it back on close —
  // LocalModelMenu): a section lands on the back button, the grid on a tile
  // (the grid focuses its own, since it mounts with the view).
  useEffect(() => {
    if (view !== "home") {
      lastSection.current = view;
      backRef.current?.focus();
    }
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // The root console opens above this overlay (a "Run in terminal"
      // install): its Escape is its own, and must not also close the room the
      // install was started from. Likewise any key aimed outside this frame
      // (focus on <body> still counts as ours — a click on the bar drops it
      // there).
      if (useRootOverlayStore.getState().open) return;
      const tgt = e.target;
      if (tgt instanceof Node && tgt !== document.body && !frameRef.current?.contains(tgt)) return;
      e.stopPropagation();
      useModelsOverlayStore.getState().close();
    };
    // Bubble phase on `window`, as the sibling overlays: a dropdown or field
    // inside that handles its own Escape marks it, and this one stands down.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frameRef]); // a `useRef` object: stable, so this still runs once

  return (
    <div
      className="modal-backdrop root-overlay-backdrop app-overlay-backdrop models-overlay-backdrop"
      onMouseDown={(e) => {
        // Backdrop only — a drag that starts inside the pane and ends out here
        // (selecting text in an install log) must not be read as "dismiss".
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={frameRef}
        className={`root-overlay subwindow focused models-overlay ${frameClass}`}
        style={frameStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t("modelsOverlay.title")}
      >
        {grips}
        {/* The root console's bar: mark, where-am-I trail, controls. The bar is
            the move handle; the back button and the controls keep their press. */}
        <div {...barRest} className={`tab-bar root-overlay-bar ${barRest.className}`}>
          <div className="root-overlay-mark app-overlay-mark models-overlay-mark" title={moveHint}>
            <ModelsGlyph className="models-overlay-glyph" />
            <span className="app-overlay-label models-overlay-label">{t("modelsOverlay.title")}</span>
            <UntestedTag id="modelsOverlay.title" />
          </div>
          <nav className="models-overlay-trail" aria-label={t("modelsOverlay.trailAria")}>
            {view !== "home" && (
              <>
                <button
                  ref={backRef}
                  type="button"
                  className="models-overlay-back"
                  title={t("modelsOverlay.backTitle")}
                  onClick={() => show("home")}
                >
                  <ArrowLeftIcon size={13} />
                  <span>{t("modelsOverlay.back")}</span>
                </button>
                <span className="models-overlay-trail-sep" aria-hidden="true">
                  /
                </span>
                <span className="models-overlay-trail-current" aria-current="page">
                  <SectionIcon id={view} size={14} />
                  {t(SECTION_LABEL[view])}
                </span>
                {/* The skills library's pill moved here with the library
                    (from the retired SkillsOverlay's mark). */}
                {view === "skills" && <UntestedTag id="skillsLibrary.overlayTitle" />}
              </>
            )}
          </nav>
          <div className="tab-controls root-overlay-controls">
            {fillButton}
            <button
              type="button"
              className="subwindow-hide"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={close}
            >
              ×
            </button>
          </div>
        </div>
        <div className="subwindow-body models-overlay-body">
          {view === "home" && (
            <OverviewGrid focusSection={lastSection.current} onOpen={(id) => show(id)} />
          )}
          {MODELS_OVERLAY_SECTIONS.map((id) =>
            mounted(id) ? (
              <div
                key={id}
                id={paneId(id)}
                role="region"
                aria-label={t(SECTION_LABEL[id])}
                className={`models-overlay-pane models-overlay-pane-${id}`}
                hidden={id !== view}
              >
                <p className="settings-help models-overlay-intro">{t(SECTION_INTRO[id])}</p>
                {/* No `onClose` to the embedded panels: it only feeds their
                    header's ×, which the CSS hides with the title row — the
                    overlay's bar has its own. */}
                {id === "agents" && <AgentsTab active={view === "agents"} />}
                {id === "models" && (
                  <ModelsTab active={view === "models"} onManageModels={() => show("ollama")} />
                )}
                {id === "ollama" && <OllamaPanel />}
                {/* No project: this surface belongs to the machine, so the
                    personal scope is the only one it can honestly offer. */}
                {id === "skills" && <SkillsLibraryView projectDir={null} visible={view === "skills"} />}
              </div>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}

/** Chips shown on a tile before the rest fold into "+N more". */
const TILE_CHIPS = 6;

interface TileChip {
  key: string;
  label: string;
  /** Lit (running, enabled) or dimmed (disabled, only on disk). */
  tone?: "on" | "off";
}

interface TileSummary {
  /** One line: the section's state at a glance. */
  stat: string;
  /** Green when the section is doing its job, muted when it has nothing yet. */
  ok: boolean;
  chips: TileChip[];
  /** A short flag in the tile's corner (an update, downloads in flight). */
  badge?: string;
}

/**
 * The overview: one tile per section, laid out as a grid that fills the
 * window, each tile naming the section, saying what it is for, and showing its
 * live state — so the question "what do I have?" is answered before anything
 * is opened. The reads are the cheap ones the dropdown already makes on hover
 * (PATH lookups, the model list, a local `ollama --version`, a directory
 * listing); nothing here spawns a CLI or reaches the network.
 *
 * Arrow keys move between tiles (↑/↓ by a row), Enter or a click opens one.
 */
function OverviewGrid({
  focusSection,
  onOpen,
}: {
  focusSection: ModelsOverlaySection | null;
  onOpen: (id: ModelsOverlaySection) => void;
}) {
  const t = useT();
  const quiesce = useQuiesce();

  const [agents, setAgents] = useState<HubAgentInfo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      invoke<HubAgentInfo[]>("list_agents")
        .then((all) => {
          if (!cancelled) setAgents(Array.isArray(all) ? all.filter((a) => a.installed) : []);
        })
        .catch(() => {
          if (!cancelled) setAgents([]);
        });
    void read();
    const onChanged = () => void read();
    window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, onChanged);
    };
  }, []);
  const disabledAgents = useSettingsStore((s) => s.settings?.disabled_agents);

  const installed = useOllamaActivityStore((s) => s.installed);
  const models = useOllamaActivityStore((s) => s.models);
  const downloads = useOllamaActivityStore((s) => s.downloads);
  const version = useOllamaActivityStore((s) => s.version);
  const status = useOllamaStatus(installed, saverInterval(5000, quiesce));
  // Live pull progress, ref-counted with the header button's subscription.
  useEffect(() => initLocalModelEvents(), []);
  useEffect(() => {
    if (!installed) return;
    void useOllamaActivityStore.getState().fetchModels();
    ollamaVersionStatus(false)
      .then((v) => useOllamaActivityStore.getState().mergeInstalledVersion(v))
      .catch(() => {});
  }, [installed]);

  const [skills, setSkills] = useState<InstalledSkill[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    listInstalledSkills(PERSONAL_SKILLS)
      .then((rows) => {
        if (!cancelled) setSkills(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const checking = t("modelsOverlay.stat.checking");
  const downloading = Object.keys(downloads).length;
  const running = models.filter((m) => m.running);

  const summary: Record<ModelsOverlaySection, TileSummary> = {
    agents:
      agents === null
        ? { stat: checking, ok: false, chips: [] }
        : agents.length === 0
          ? { stat: t("modelsOverlay.stat.agentsNone"), ok: false, chips: [] }
          : {
              stat: t("modelsOverlay.stat.agentsInstalled", { count: String(agents.length) }),
              ok: true,
              chips: agents.map((a) => ({
                key: a.id,
                label: a.label,
                tone: disabledAgents?.includes(a.id) ? "off" : "on",
              })),
            },
    models: !installed
      ? { stat: t("modelsOverlay.stat.modelsNeedOllama"), ok: false, chips: [] }
      : {
          stat:
            models.length === 0
              ? t("modelsOverlay.stat.modelsNone")
              : t("modelsOverlay.stat.models", {
                  disk: String(models.length),
                  running: String(running.length),
                }),
          ok: running.length > 0,
          // Resident ones first: they are what answers right now.
          chips: [...running, ...models.filter((m) => !m.running)].map((m) => ({
            key: m.name,
            label: m.name,
            tone: m.running ? "on" : "off",
          })),
          badge:
            downloading > 0
              ? t("modelsOverlay.stat.downloading", { count: String(downloading) })
              : undefined,
        },
    ollama: !installed
      ? { stat: t("modelsOverlay.stat.ollamaMissing"), ok: false, chips: [] }
      : {
          stat: t(status === "stopped" ? "modelsOverlay.stat.ollamaStopped" : "modelsOverlay.stat.ollamaRunning"),
          ok: status !== "stopped",
          chips: version?.current
            ? [{ key: "version", label: t("modelsOverlay.stat.version", { version: version.current }) }]
            : [],
          badge: version?.update_available ? t("modelsOverlay.stat.update") : undefined,
        },
    skills:
      skills === null
        ? { stat: checking, ok: false, chips: [] }
        : skills.length === 0
          ? { stat: t("modelsOverlay.stat.skillsNone"), ok: false, chips: [] }
          : {
              stat: t("modelsOverlay.stat.skills", { count: String(skills.length) }),
              ok: true,
              chips: skills.map((s) => ({ key: s.name, label: s.name })),
            },
  };

  // Roving arrows over the tiles. ↑/↓ step by the grid's live column count,
  // so the keys follow the layout at any window width.
  const gridRef = useRef<HTMLDivElement>(null);
  const tiles = () => [...(gridRef.current?.querySelectorAll<HTMLButtonElement>(".models-tile") ?? [])];
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = tiles();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const cols = gridRef.current
      ? Math.max(1, getComputedStyle(gridRef.current).gridTemplateColumns.split(" ").filter(Boolean).length)
      : 1;
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key in step) next = i + step[e.key];
    else return;
    e.preventDefault();
    list[Math.min(list.length - 1, Math.max(0, next))]?.focus();
  };
  // Landing focus: the tile of the section just left, else the first.
  useEffect(() => {
    const target = focusSection ? document.getElementById(tileId(focusSection)) : tiles()[0];
    target?.focus();
    // Once, on mount: the grid mounts each time it is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="models-home">
      <div className="models-home-inner">
        <p className="models-home-lead">{t("modelsOverlay.home.lead")}</p>
        <div className="models-home-grid" ref={gridRef} onKeyDown={onKeyDown}>
          {MODELS_OVERLAY_SECTIONS.map((id) => (
            <SectionTile key={id} id={id} summary={summary[id]} onOpen={() => onOpen(id)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionTile({
  id,
  summary,
  onOpen,
}: {
  id: ModelsOverlaySection;
  summary: TileSummary;
  onOpen: () => void;
}) {
  const t = useT();
  const shown = summary.chips.slice(0, TILE_CHIPS);
  const more = summary.chips.length - shown.length;
  const descId = `${tileId(id)}-desc`;
  let chips: ReactNode = null;
  if (shown.length > 0) {
    chips = (
      <span className="models-tile-chips">
        {shown.map((c) => (
          <span key={c.key} className={`models-tile-chip${c.tone ? ` ${c.tone}` : ""}`}>
            {c.label}
          </span>
        ))}
        {more > 0 && (
          <span className="models-tile-chip more">{t("modelsOverlay.stat.more", { count: String(more) })}</span>
        )}
      </span>
    );
  }
  return (
    <button
      type="button"
      id={tileId(id)}
      className={`models-tile models-tile-${id}`}
      aria-label={t(SECTION_LABEL[id])}
      aria-describedby={descId}
      onClick={onOpen}
    >
      <span className="models-tile-head">
        <span className="models-tile-icon">
          <SectionIcon id={id} size={22} />
        </span>
        <span className="models-tile-title">{t(SECTION_LABEL[id])}</span>
        {summary.badge && <span className="models-tile-badge">{summary.badge}</span>}
        <span className="models-tile-go" aria-hidden="true">
          <ArrowRightIcon size={16} />
        </span>
      </span>
      <span id={descId} className="models-tile-desc">
        <span className="models-tile-intro">{t(SECTION_INTRO[id])}</span>
        <span className="models-tile-stat">
          <span className={`ollama-status-dot ${summary.ok ? "running" : "stopped"}`} aria-hidden="true" />
          {summary.stat}
        </span>
      </span>
      {chips}
    </button>
  );
}

/**
 * Settings' Agents panel, each installed card carrying the dropdown's chips.
 * `wired` (which CLIs the root MCP server is named to) is read when the section
 * becomes visible and again whenever the agent registry changes — installing
 * or removing a CLI can change the answer. `null` until then, which draws no
 * MCP chip, as the dropdown does before its own read.
 */
function AgentsTab({ active }: { active: boolean }) {
  const [wired, setWired] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      invoke<{ wired_clis?: string[] }>("root_mcp_status")
        .then((s) => {
          if (!cancelled) setWired(s.wired_clis ?? null);
        })
        .catch(() => {
          if (!cancelled) setWired(null);
        });
    if (active) void read();
    const onChanged = () => void read();
    window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, onChanged);
    };
  }, [active]);
  return (
    <AgentsPanel installedExtras={(a) => <AgentChips agent={a} wiredClis={wired} />} />
  );
}

/**
 * The dropdown's Local models section at full size, in the dropdown's order:
 * the "Local Models" band with its Running / On disk sub-bands, then the
 * Machine meters (what is left to run them with). `useModelsHub(active)` gates
 * the 2 s GPU/machine poll and the GPU-status read on this section being the
 * visible one; the list and version are re-read each time it becomes visible,
 * as a hover does — but not the agents, which this section doesn't show.
 */
function ModelsTab({ active, onManageModels }: { active: boolean; onManageModels: () => void }) {
  const hub = useModelsHub(active);
  const installed = useOllamaActivityStore((s) => s.installed);
  // The progress events, ref-counted with the header button's own subscription:
  // the section stays live even if that button is ever not mounted.
  useEffect(() => initLocalModelEvents(), []);
  useEffect(() => {
    if (active) hub.refreshModels();
    // `refreshModels` is a fresh closure every render; what should re-run it is the
    // section becoming visible (or Ollama turning up installed while it is).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, installed]);
  return (
    <div className="dialog-scroll models-overlay-models">
      <LocalModelsSection hub={hub} layout="overlay" onManageModels={onManageModels} />
      <MachineMeters hub={hub} />
    </div>
  );
}
