import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_SORTS, DEFAULT_AGENT_SORT, isAgentSort, sortAgentTabs, type AgentSort } from "../../../shared/agentSort";
import { relativeToNow, scheduleStatus, scheduleSummary, type ScheduledAgentPrompt } from "../../lib/agents/agentSchedule";
import { agentModelsFor, buildPreface, prefaceCommandsFor } from "../../lib/agents/agentPrefaces";
import { useI18nStore, useT } from "../../lib/i18n";
import { useChordHint } from "../../lib/shortcuts/shortcutHint";
import { jumpToTab, openPromptChartTab } from "../../lib/shortcuts/tabJump";
import { useActivityStore } from "../../stores/activity";
import { continueKey, useAgentContinueStore } from "../../stores/agents/agentContinue";
import { agentTabModelTag, useAgentModelsStore } from "../../stores/agents/agentModels";
import { queuePromptForTab } from "../../stores/agents/agentPrompts";
import { persistScopeLayout, scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import { isResumableAgentTab, useTabsStore, type TabEntry } from "../../stores/tabs";
import { Dropdown } from "../common/Dropdown";
import { MarkdownPromptField } from "../common/MarkdownPromptField";
import { AgentScheduleDialog } from "./AgentScheduleDialog";
import { AgentScheduleProposal } from "./AgentScheduleProposal";
import { GitPushProposals } from "./GitPushMcp";
import { isPromptTargetTab } from "./PromptChartTab";
import { ArrowUpRightIcon } from "../common/icons/Icon";
import { ErrorNote } from "../common/ErrorNote";
import { storageKey } from "../../lib/brand";

interface Props { scope: string; active: boolean }
const EMPTY_TABS: TabEntry[] = [];
const EMPTY_SCHEDULES: ScheduledAgentPrompt[] = [];
type AgentState = "working" | "decision" | "done" | "idle";

/** The list's order is the reader's, kept across relaunches; the phone keeps
 * its own copy of the same choice (`mobile-web/src/prefs.ts`). */
const SORT_STORAGE_KEY = storageKey("agentsSort");
function readAgentSort(): AgentSort {
  try {
    const stored = localStorage.getItem(SORT_STORAGE_KEY);
    return isAgentSort(stored) ? stored : DEFAULT_AGENT_SORT;
  } catch {
    return DEFAULT_AGENT_SORT;
  }
}
function writeAgentSort(sort: AgentSort): void {
  try { localStorage.setItem(SORT_STORAGE_KEY, sort); } catch { /* private window: the choice lasts the session */ }
}

function AgentTabComposer({ scope, tab, offered, models }: { scope: string; tab: TabEntry; offered: string[]; models: string[] }) {
  const t = useT();
  const chordHint = useChordHint();
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const preface = useMemo(() => buildPreface(offered, selected, model), [model, offered, selected]);
  const submit = async () => {
    if (!draft.trim() || !tab.scheduleTargetId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const { pruned } = await queuePromptForTab(scope, tab.scheduleTargetId, draft.trim(), { preface });
      setNotice(t("agentPrompts.queued", { tab: tab.label }) + (pruned ? ` ${t("agentPrompts.pruned", { count: pruned })}` : ""));
      setDraft("");
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return (
    <div className="agent-composer" data-testid="agent-composer">
      {offered.length > 0 ? <div className="agent-composer-chips" role="group" aria-label={t("agentPrompts.prefixHeading")}>
        <span className="agent-composer-chips-label">{t("agentPrompts.prefixHeading")}</span>
        {offered.map((command) => <button key={command} type="button" className={`agent-composer-chip${selected.includes(command) ? " active" : ""}`} aria-pressed={selected.includes(command)} title={t("agentPrompts.prefixChipTitle", { command })} onClick={() => setSelected((items) => items.includes(command) ? items.filter((item) => item !== command) : [...items, command])}>{command}</button>)}
      </div> : <p className="settings-help">{t("agentPrompts.prefixNone")}</p>}
      {models.length > 0 && <label className="agent-composer-model"><span>{t("agentPrompts.model")}</span><Dropdown value={model} placeholder={t("agentPrompts.modelUnchanged")} title={t("agentPrompts.modelTitle")} options={[{ value: "", label: t("agentPrompts.modelUnchanged") }, ...models.map((name) => ({ value: name, label: name }))]} onChange={setModel} /></label>}
      <MarkdownPromptField rows={3} value={draft} placeholder={t("agentPrompts.composerPlaceholder", { tab: tab.label })} ariaLabel={t("agentPrompts.composerPlaceholder", { tab: tab.label })} onChange={setDraft} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!busy) void submit(); } }} />
      {preface.length > 0 && <small className="agent-composer-preview">{t("agentPrompts.prefixPreview", { commands: preface.join(" · ") })}</small>}
      <div className="agent-schedule-form-actions"><button className="settings-btn sm primary" type="button" disabled={busy || !draft.trim()} title={chordHint(t("agentPrompts.composerSendTitle"), { key: "Enter", ctrl: true })} onClick={() => void submit()}>{t("agentPrompts.composerSend")}</button></div>
      {notice && <div className="agent-prompts-notice" data-testid="agent-composer-notice">{notice}</div>}
      {error && <ErrorNote className="project-dialog-error" error={error} />}
    </div>
  );
}

/** Agent tabs remain the command surface; the prompt chart — the one timeline
 * for collected, scheduled and sent prompts — is a tab of its own
 * (`PromptChartTab`), reached from the button in this view's header. */
export function AgentSchedulesView({ scope, active }: Props) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const tabs = useTabsStore((state) => state.tabsByScope[scope] ?? EMPTY_TABS);
  const agentTabs = useMemo(() => tabs.filter(isPromptTargetTab), [tabs]);
  const schedulesByTarget = useAgentSchedulesStore((state) => state.byTarget);
  const loadSchedules = useAgentSchedulesStore((state) => state.load);
  const busyByTab = useActivityStore((state) => state.busyByTab);
  const attentionByTab = useActivityStore((state) => state.attentionByTab);
  const lastWorkingByTab = useActivityStore((state) => state.lastWorkingByTab);
  const lastDoneByTab = useActivityStore((state) => state.lastDoneByTab);
  const modelByTab = useAgentModelsStore((state) => state.byTab);
  const promptByTab = useAgentModelsStore((state) => state.promptByTab);
  const screenModelByTab = useAgentModelsStore((state) => state.screenByTab);
  const refreshModel = useAgentModelsStore((state) => state.refresh);
  const refreshScreen = useAgentModelsStore((state) => state.refreshScreen);
  const settings = useSettingsStore((state) => state.settings);
  const renameTabInScope = useTabsStore((state) => state.renameTabInScope);
  const setAutoContinue = useTabsStore((state) => state.setAutoContinueInScope);
  const reorderTab = useTabsStore((state) => state.reorderTabInScope);
  const continueByTarget = useAgentContinueStore((state) => state.byTarget);
  const [now, setNow] = useState(() => new Date());
  const [dialog, setDialog] = useState<TabEntry | null>(null);
  const [unfolded, setUnfolded] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [sort, setSort] = useState<AgentSort>(readAgentSort);
  const chooseSort = (next: AgentSort) => { setSort(next); writeAgentSort(next); };
  const sortedTabs = useMemo(() => sortAgentTabs(agentTabs, sort, (tab) => {
    const ptyId = `${scope}:${tab.key}`;
    return {
      decision: attentionByTab[ptyId] === "decision",
      working: !!busyByTab[ptyId],
      workingAt: lastWorkingByTab[ptyId],
      doneAt: lastDoneByTab[ptyId],
    };
  }), [agentTabs, attentionByTab, busyByTab, lastDoneByTab, lastWorkingByTab, scope, sort]);

  // Drag-to-reorder, and only under the "native" sort: the other two orders are
  // computed from what the agents did, so a dropped row would spring back the
  // next time one of them worked. The gesture is pointer-driven, not HTML5 DnD,
  // for the reason the tab bar's is (WebKitGTK delivers native drag events
  // unreliably); it doubles as the row's click, since a press that never moved
  // is exactly a click on the tab.
  const canReorder = sort === "native" && sortedTabs.length > 1;
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [drop, setDrop] = useState<{ key: string; anchor: string; place: "before" | "after" } | null>(null);
  /** Which row the pointer is over, and which side of its midline — the slot the
   *  dragged row would land in. Above the first row and below the last both
   *  clamp to that end, so a drop in the section's padding still lands. */
  const dropAt = useCallback((key: string, clientY: number) => {
    const rows = sortedTabs
      .map((tab) => ({ key: tab.key, rect: rowRefs.current.get(tab.key)?.getBoundingClientRect() }))
      .filter((row): row is { key: string; rect: DOMRect } => !!row.rect);
    if (rows.length === 0) return null;
    const hit = rows.find((row) => clientY < row.rect.bottom) ?? rows[rows.length - 1];
    const place: "before" | "after" = clientY < hit.rect.top + hit.rect.height / 2 ? "before" : "after";
    // Either side of the dragged row itself is where it already is.
    if (hit.key === key) return null;
    return { key, anchor: hit.key, place };
  }, [sortedTabs]);
  const onRowPointerDown = (event: React.PointerEvent<HTMLDivElement>, key: string) => {
    // Left button only, and never when the press landed on the row's own
    // controls (the buttons, the rename field, the composer) — those speak for
    // themselves and must not also jump or drag the row.
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, textarea, select, a, .agent-composer")) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const onMove = (move: PointerEvent) => {
      if (!moved && Math.hypot(move.clientX - startX, move.clientY - startY) < 5) return;
      moved = true;
      if (canReorder) setDrop(dropAt(key, move.clientY));
    };
    const onUp = (up: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDrop(null);
      // Never moved → a click on the row: show me that tab.
      if (!moved) { jumpToTab(scope, key); return; }
      if (!canReorder) return;
      const target = dropAt(key, up.clientY);
      if (!target) return;
      reorderTab(scope, key, target.anchor, target.place);
      void persistScopeLayout(scope);
    };
    const onCancel = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDrop(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  useEffect(() => {
    // The model tag: read on show and on the 30-second tick (throttled in the
    // store); the store itself re-reads a tab the moment it finishes a turn.
    if (!active) return;
    for (const tab of agentTabs) {
      void refreshModel(scope, tab);
      void refreshScreen(scope, tab);
    }
  }, [active, agentTabs, now, refreshModel, refreshScreen, scope]);
  useEffect(() => {
    for (const tab of agentTabs) if (tab.scheduleTargetId && !schedulesByTarget[scheduleCacheKey(scope, tab.scheduleTargetId)]) void loadSchedules(scope, tab.scheduleTargetId).catch(() => []);
  }, [agentTabs, loadSchedules, schedulesByTarget, scope]);
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => { if (renaming && !agentTabs.some((tab) => tab.key === renaming)) setRenaming(null); }, [agentTabs, renaming]);

  const stateOf = (tab: TabEntry): AgentState => {
    const ptyId = `${scope}:${tab.key}`;
    if (attentionByTab[ptyId] === "decision") return "decision";
    if (busyByTab[ptyId]) return "working";
    return attentionByTab[ptyId] === "done" ? "done" : "idle";
  };
  const continueLabel = (tab: TabEntry): string | null => {
    if (!tab.autoContinue || !tab.scheduleTargetId) return null;
    const status = continueByTarget[continueKey(scope, tab.scheduleTargetId)];
    if (!status) return t("agentContinue.reading");
    if (status.phase === "armed") return status.armedAt === undefined ? t("agentContinue.reading") : t("agentContinue.armed", { relative: relativeToNow(new Date(status.armedAt), now, lang), window: status.window ?? "", resets: status.resets ?? "" });
    if (status.phase === "sending") return t("agentContinue.sending");
    if (status.phase === "unsupported") return t("agentContinue.unsupported");
    if (status.phase === "unreadable") return t("agentContinue.unreadable");
    if (status.phase === "error") return t("agentContinue.error", { reason: status.error ?? "" });
    return t("agentContinue.reading");
  };
  const timesLabel = (tab: TabEntry, state: AgentState): string => {
    const ptyId = `${scope}:${tab.key}`;
    const worked = state === "working"
      ? t("agentPrompts.workingNow")
      : lastWorkingByTab[ptyId] !== undefined
        ? t("agentPrompts.lastWorking", { relative: relativeToNow(new Date(lastWorkingByTab[ptyId]), now, lang) })
        : t("agentPrompts.neverWorked");
    const done = lastDoneByTab[ptyId] !== undefined ? t("agentPrompts.lastDone", { relative: relativeToNow(new Date(lastDoneByTab[ptyId]), now, lang) }) : "";
    return done ? `${worked} · ${done}` : worked;
  };
  const commitRename = (tabKey: string, label: string) => {
    const clean = label.trim();
    if (clean) renameTabInScope(scope, tabKey, clean);
    setRenaming(null);
  };

  return <div className="side-panel-scroll agent-prompts-view" style={{ flex: 1, overflowY: "auto", padding: 6 }}>
    <section className="agent-prompts-section">
      <div className="agent-prompts-tabs-head">
        <h3 className="settings-section-title">{t("agentPrompts.tabsHeading")}</h3>
        <button className="settings-btn sm" type="button" data-testid="open-prompt-chart" title={t("promptChart.openTabTitle")} onClick={() => void openPromptChartTab(scope)}>⧗ {t("promptChart.openTab")}</button>
        {agentTabs.length > 1 && <div className="agent-prompts-sort" data-testid="agent-sort">
          <span>{t("agentPrompts.sort.label")}</span>
          <Dropdown value={sort} title={t("agentPrompts.sort.title")} options={AGENT_SORTS.map((value) => ({ value, label: t(`agentPrompts.sort.${value}`) }))} onChange={(value) => { if (isAgentSort(value)) chooseSort(value); }} />
        </div>}
      </div>
      {/* Agent push requests for this scope (`services::git_push_mcp`). */}
      <GitPushProposals projectId={scope} />
      {agentTabs.length === 0 ? <div className="file-tree-empty">{t("agentPrompts.noTabs")}</div> : sortedTabs.map((tab) => {
        const schedules = schedulesByTarget[scheduleCacheKey(scope, tab.scheduleTargetId!)] ?? EMPTY_SCHEDULES;
        const summary = scheduleSummary(schedules, now);
        const queued = schedules.filter((schedule) => scheduleStatus(schedule, now).kind === "due");
        const state = stateOf(tab);
        // The session's own status line, read off the live pane, with the
        // transcript's shortened id behind it (`agentTabModelTag`). Composed
        // here rather than held in the store: a `/model` typed into the session
        // changes the screen and nothing else, and this row is re-rendered on
        // the 30-second tick and on every edge the activity store reports.
        const model = agentTabModelTag(scope, tab, modelByTab, screenModelByTab);
        const open = unfolded.includes(tab.key);
        const slot = drop?.anchor === tab.key ? ` drop-${drop.place}` : "";
        return <div
          className={`agent-prompts-tab is-agent-${state}${drop?.key === tab.key ? " dragging" : ""}${slot}${canReorder ? " reorderable" : ""}`}
          key={tab.key}
          ref={(node) => { if (node) rowRefs.current.set(tab.key, node); else rowRefs.current.delete(tab.key); }}
          onPointerDown={(event) => onRowPointerDown(event, tab.key)}
          title={`${t(`agentPrompts.state.${state}`)} · ${t("agentPrompts.jumpTitle", { tab: tab.label })}`}
          data-testid="agent-prompts-tab"
          data-state={state}
        >
          <div className="agent-prompts-tab-main">
            <div className="agent-prompts-tab-head">
              {renaming === tab.key ? <input className="agent-prompts-rename" defaultValue={tab.label} autoFocus aria-label={t("tabBar.renameAriaLabel")} ref={(node) => node?.select()} onKeyDown={(event) => { if (event.key === "Enter") commitRename(tab.key, event.currentTarget.value); if (event.key === "Escape") setRenaming(null); }} onBlur={(event) => commitRename(tab.key, event.target.value)} /> : <><button className="agent-prompts-tab-name" type="button" title={t("agentPrompts.jumpTitle", { tab: tab.label })} onClick={() => jumpToTab(scope, tab.key)}><strong>{tab.label}</strong></button><button className="agent-composer-chip agent-prompts-rename-btn" type="button" title={t("common.rename")} aria-label={t("tabBar.renameAriaLabel")} onClick={() => setRenaming(tab.key)}>✎</button></>}
              <small>{tab.cmd}</small>
              {model && <small className="agent-prompts-model" data-testid="agent-model" title={t("agentPrompts.modelTagTitle")}>{model}</small>}
              {!isResumableAgentTab(tab) && <small className="danger-text">{t("agentPrompts.nonResumable")}</small>}
            </div>
            <small className="agent-prompts-tab-when" data-testid="agent-tab-times">{timesLabel(tab, state)}</small>
            {promptByTab[`${scope}:${tab.key}`] && <small className="agent-prompts-tab-when agent-prompts-last-prompt" data-testid="agent-last-prompt" title={`${t("agentPrompts.lastPromptTitle")}\n\n${promptByTab[`${scope}:${tab.key}`]}`}>{t("agentPrompts.lastPrompt", { prompt: promptByTab[`${scope}:${tab.key}`] })}</small>}
            <small className="agent-prompts-tab-when">{summary.total === 0 ? t("agentPrompts.noSchedules") : summary.next ? `${summary.enabled} · ${t("agentPrompts.nextRun", { relative: relativeToNow(summary.next, now, lang) })}` : queued.length ? `${summary.enabled} · ${t("agentPrompts.queuedCount", { count: queued.length })}` : `${summary.enabled} · ${t("agentSchedule.noNext")}`}</small>
            {continueLabel(tab) && <small className="agent-prompts-tab-when" data-testid="agent-continue-status">⟳ {continueLabel(tab)}</small>}
            {open && <AgentTabComposer scope={scope} tab={tab} offered={prefaceCommandsFor(tab.cmd, settings?.agent_preface_commands)} models={agentModelsFor(tab.cmd, settings?.agent_models)} />}
          </div>
          <div className="agent-prompts-tab-actions">
            <button className="agent-composer-chip" type="button" onClick={() => jumpToTab(scope, tab.key)}><ArrowUpRightIcon /> {t("agentPrompts.jump")}</button>
            <button className={`agent-composer-chip${open ? " active" : ""}`} type="button" aria-pressed={open} onClick={() => setUnfolded((keys) => keys.includes(tab.key) ? keys.filter((key) => key !== tab.key) : [...keys, tab.key])}>{t("agentPrompts.composerToggle")}</button>
            <button className={`agent-composer-chip${tab.autoContinue ? " active" : ""}`} type="button" aria-pressed={!!tab.autoContinue} data-testid="agent-continue-toggle" onClick={() => { setAutoContinue(scope, tab.key, !tab.autoContinue); void persistScopeLayout(scope); }}>⟳ {t("agentContinue.toggle")}</button>
            {schedules.filter((s) => s.origin).map((schedule) => <div key={schedule.id}>
              <small>{schedule.message}</small>
              <AgentScheduleProposal projectId={scope} targetId={tab.scheduleTargetId!} schedule={schedule} />
            </div>)}
            <button className="settings-btn sm" type="button" onClick={() => setDialog(tab)}>◷ {t("agentPrompts.schedulesButton")}</button>
          </div>
        </div>;
      })}
    </section>
    {dialog && <AgentScheduleDialog scope={scope} tab={dialog} onClose={() => setDialog(null)} />}
  </div>;
}
