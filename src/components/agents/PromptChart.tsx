import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { subscribeTauri } from "../../hooks/useTauriListener";
import {
  buildPromptChart,
  occupiedTargets,
  promptChartCardMatches,
  promptChartInWindow,
  rowOnStrand,
  type PromptChartCard,
  type PromptChartFilter,
  type PromptChartStrand,
  type PromptChartWindow,
} from "../../lib/agents/prompt/chart";
import { agentModelsFor, prefaceCommandsFor } from "../../lib/agents/agentPrefaces";
import { historyTabId } from "../../lib/agents/prompt/adopt";
import { afterLinkRefusal } from "../../lib/agents/prompt/links";
import { findEmptyAgentTab } from "../../lib/agents/emptyAgentTab";
import { agentItemFor, newAgentTabForDraft, promptChartNewTabAgent } from "../../lib/agents/prompt/newTab";
import { useUse24h } from "../../lib/timeFormat";
import {
  dayFold,
  formatTimelineInstant,
  hourAnchor,
  promptTargetColor,
  queueReorderWrites,
  sessionGroupKey,
  shiftAnchor,
  timelineDropAction,
  timelineGroupDrop,
  timelineGroupMovable,
  timelineItems,
  timelineWindow,
  promptEndedAt,
  zoomTimelineView,
  type PromptTimelineDrop,
  type SessionSpan,
  type TimelineView,
  type TimelineZone,
} from "../../lib/agents/prompt/timeline";
import { localOccurrenceKey, localWallClock } from "../../lib/agents/agentSchedule";
import { tagCounts } from "../../lib/agents/prompt/tags";
import { formatLongDate, monthName, toDateStr, todayStr } from "../../lib/calendar/calendarTime";
import { useI18nStore, useT } from "../../lib/i18n";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import {
  queuePromptForTab,
  sendCollectedPrompt,
  useAgentPromptsStore,
  type ProjectAgentPrompt,
  type PromptLink,
  type SentAgentPrompt,
} from "../../stores/agents/agentPrompts";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { SCHEDULE_BUSY_ERROR, SCHEDULE_GONE_ERROR, scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { resolveProjectDirectory } from "../../types";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { useDialogs } from "../common/PromptDialogs";
import { AgentScheduleDialog } from "./AgentScheduleDialog";
import { PromptCard } from "./PromptCard";
import { PromptInspector } from "./PromptInspector";
import { PromptSessionCard } from "./PromptSessionCard";
import { PromptChartFilterBar } from "./PromptChartFilterBar";
import { PromptChartCommandBar } from "./PromptChartCommandBar";
import { PromptChartHelp } from "./PromptChartHelp";
import { PromptChartOptions } from "./PromptChartOptions";
import { PromptChartLinks } from "./PromptChartLinks";
import { PromptLinkEditor } from "./PromptLinkEditor";
import { PromptTimeline } from "./PromptTimeline";
import { usePromptChartDrag } from "./usePromptChartDrag";
import { usePromptChartUsage } from "./usePromptChartUsage";
import { usePromptLiveState } from "./usePromptLiveState";
import { limitWarning } from "../../lib/agents/agentUsageResets";
import { PromptDraftBoard, type DraftBoardHandle } from "./PromptDraftBoard";
import { PromptComposer, type ComposeSubmit } from "./PromptComposer";
import { PromptSequenceInspector } from "./PromptSequenceGroup";
import {
  nextPendingStep,
  promptSequences,
  resumeSendsAtOnce,
  sequencePlaces,
  skipPlan,
  stopEdge,
  type PromptSequence,
} from "../../lib/agents/prompt/sequences";
import { draftSequence } from "../../lib/agents/prompt/drafts";
import { AGENT_ITEMS, EMPTY_CUSTOM_AGENTS } from "../../lib/tabs/newTabItems";
import { useAddTabMenuData } from "../tabs/useAddTabMenuData";
import { ChevronLeftIcon, ChevronRightIcon } from "../common/icons/Icon";
import { bindDragRelease, dragPlatform } from "../../lib/window/dragPlatform";
import { storageKey } from "../../lib/brand";

const EMPTY_PROMPTS: ProjectAgentPrompt[] = [];
const EMPTY_HISTORY: SentAgentPrompt[] = [];
const EMPTY_LINKS: ReturnType<typeof useAgentPromptsStore.getState>["linksByProject"][string] = [];
const EMPTY_FILTER: PromptChartFilter = { text: "", tag: "", agent: "", result: "" };
/** The backend's refusals of an After link (`apply_link_upsert`), mapped to
 *  the same sentences the frontend's own check shows. */
const LINK_CYCLE_ERROR = "prompt_link_cycle";
const LINK_JOIN_ERROR = "prompt_link_join";
/** How much of a prompt a delete confirmation quotes. */
const CONFIRM_QUOTE_CHARS = 80;
/** What a card's ±5 min buttons step by, and how close to now "earlier" may
 *  land: one fixed margin in every view, since the buttons move 5 min at any
 *  zoom — a view's snap step would make "earlier" come and go as you zoom. */
const RETIME_STEP_MS = 5 * 60_000;
/** A selection refused for the past says which past: dropped on the past
 *  body it is told to use the band; dropped on a future minute, one of its
 *  members would have landed at or before now — it never meant to send. */
const pastRefusalKey = (zoneKind?: TimelineZone["kind"]) =>
  zoneKind === "time" ? "promptChart.groupLandsPast" as const : "promptChart.groupPastRefused" as const;
/** The Drafts column's two reader's conveniences, remembered per window like
 *  the Agents view's sort: whether it is collapsed, and how wide it is. The
 *  filters are not — a filter that survives a relaunch is how a card goes
 *  missing. */
const DRAFTS_STORAGE_KEY = storageKey("promptChart.drafts");
const DRAFTS_WIDTH_KEY = storageKey("promptChart.draftsWidth");
export const DRAFTS_MIN_WIDTH = 240;
export const DRAFTS_MAX_WIDTH = 720;
const DRAFTS_DEFAULT_WIDTH = 288;
/** What an arrow key on the column's resize handle moves it by. */
const DRAFTS_KEY_STEP = 16;
/** Below this much width of the chart itself the three columns stack (the same
 *  number as the stylesheet's container query), and the inspector sits below
 *  the timeline, out of sight until something brings it in. */
export const PROMPT_CHART_STACK_WIDTH = 900;

function readDraftsCollapsed(): boolean {
  try { return localStorage.getItem(DRAFTS_STORAGE_KEY) === "collapsed"; } catch { return false; }
}

function readDraftsWidth(): number {
  try {
    const stored = Number(localStorage.getItem(DRAFTS_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? Math.max(DRAFTS_MIN_WIDTH, Math.min(DRAFTS_MAX_WIDTH, stored)) : DRAFTS_DEFAULT_WIDTH;
  } catch { return DRAFTS_DEFAULT_WIDTH; }
}

function isStripCard(card: PromptChartCard): boolean {
  return card.state === "draft" || card.state === "chained";
}

function agentsOf(cards: PromptChartCard[]): string[] {
  return [...new Set(cards.flatMap((card) => card.autoTags.filter((tag) => tag.startsWith("agent:")).map((tag) => tag.slice(6))))].sort();
}

interface Props {
  scope: string;
  active: boolean;
  tabs: TabEntry[];
  stateOf?: (tab: TabEntry) => string;
}

function target(tab: TabEntry) {
  return {
    scheduleTargetId: tab.scheduleTargetId!,
    label: tab.label,
    sessionId: tab.sessionId,
    agent: tab.cmd,
  };
}

function rectOf(node: Element | null) {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** Why a drop or a selection's drop means nothing, when it says (`C3`). */
function noneReason(drop: PromptTimelineDrop | undefined): string | undefined {
  return drop?.type === "none" ? drop.reason : undefined;
}

/**
 * One horizontal time axis for every prompt of the scope — sent, queued,
 * scheduled — with the timeless drafts on a strip above it. The chart owns
 * the data and every write; the axis (`PromptTimeline`) owns only geometry,
 * and the gesture (`usePromptChartDrag`) owns only the pointer. A drop is
 * turned into exactly one write by `timelineDropAction`, and which tab a
 * card is aimed at is the card's own, picked on its face.
 */
export function PromptChart({ scope, active, tabs, stateOf }: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const weekStart = useSettingsStore((s) => (s.settings?.calendar_week_start ?? 1) as 0 | 1);
  const prompts = useAgentPromptsStore((state) => state.byProject[scope] ?? EMPTY_PROMPTS);
  const history = useAgentPromptsStore((state) => state.historyByProject[scope] ?? EMPTY_HISTORY);
  const links = useAgentPromptsStore((state) => state.linksByProject[scope] ?? EMPTY_LINKS);
  const loadPrompts = useAgentPromptsStore((state) => state.load);
  const loadHistory = useAgentPromptsStore((state) => state.loadHistory);
  const loadLinks = useAgentPromptsStore((state) => state.loadLinks);
  const upsertPrompt = useAgentPromptsStore((state) => state.upsert);
  const removePrompt = useAgentPromptsStore((state) => state.remove);
  const clearHistory = useAgentPromptsStore((state) => state.clearHistory);
  const upsertLink = useAgentPromptsStore((state) => state.link);
  const removeLink = useAgentPromptsStore((state) => state.unlink);
  const schedulesByTarget = useAgentSchedulesStore((state) => state.byTarget);
  // The model pill beside each tab, by composed PTY id — worn by the tab's
  // cards as a `model:` tag.
  const modelByTab = useAgentModelsStore((state) => state.byTab);
  // The two actions only — never the whole store. `load` writes `loading` twice
  // around every `byTarget` write, and `refreshLoaded` fans that across every
  // loaded target on each `agent-schedules-changed`; none of it is read here.
  const upsertSchedule = useAgentSchedulesStore((state) => state.upsert);
  const removeSchedule = useAgentSchedulesStore((state) => state.remove);
  const [now, setNow] = useState(() => new Date());
  const [view, setView] = useState<TimelineView>("day");
  const [anchor, setAnchor] = useState(() => todayStr());
  // One filter for the whole chart: the drafts column and the timeline answer
  // the same question. The "When" facet applies to the timeline's cards only.
  const [filter, setFilter] = useState<PromptChartFilter>(EMPTY_FILTER);
  const [hide, setHide] = useState(false);
  const [when, setWhen] = useState<PromptChartWindow>("any");
  const [draftsCollapsed, setDraftsCollapsed] = useState(readDraftsCollapsed);
  const [draftsWidth, setDraftsWidth] = useState(readDraftsWidth);
  const [selected, setSelected] = useState<string | null>(null);
  /** The sequence open in the inspector (its first member's id), instead of a card. */
  const [selectedSeq, setSelectedSeq] = useState<string | null>(null);
  /** The card whose prompt is open in the inspector's editor. */
  const [editId, setEditId] = useState<string | null>(null);
  /** Bumped when a keyboard open should move focus into the inspector, and the
   *  card it was asked for: an inspector that mounts for a click is not focused. */
  const [focusToken, setFocusToken] = useState(0);
  const [focusFor, setFocusFor] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [linkKind, setLinkKind] = useState<"related" | "after">("after");
  /** The composer's "After another prompt…": the draft it wrote, waiting for
   *  the card it follows. The next card clicked becomes that edge's source. */
  const [afterFor, setAfterFor] = useState<string | null>(null);
  /** Where a composed prompt would land on a reset, drawn dashed on the axis. */
  const [preview, setPreview] = useState<{ at: Date; message: string } | null>(null);
  const [dialog, setDialog] = useState<{ tab: TabEntry; message?: string; promptId?: string } | null>(null);
  const [error, setError] = useState("");
  const [linksVersion, setLinksVersion] = useState(0);
  /** The edge whose editor is open, and where. */
  const [edgeEdit, setEdgeEdit] = useState<{ id: string; x: number; y: number } | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** Sent cards the reader dragged up or down out of the way, per view (the
   *  lanes pack differently in each): px off their lane, by timeline item key.
   *  A way of reading the axis, so it is not persisted — like the filters. */
  const [lifts, setLifts] = useState<Partial<Record<TimelineView, Record<string, number>>>>({});
  /** The timeline's multi-selection, by timeline item key (a session card's is
   *  its session). Session-only view state: it picks what one drag carries. */
  const [multi, setMulti] = useState<ReadonlySet<string>>(() => new Set());
  const prefaceOverrides = useSettingsStore((s) => s.settings?.agent_preface_commands);
  // What a draft's "New agent tab" opens: the chart's own agent and model
  // picks, one pair for every chart (`lib/agents/prompt/newTab`).
  const newTabAgent = useSettingsStore((s) => promptChartNewTabAgent(s.settings));
  const newTabModel = useSettingsStore((s) => s.settings?.prompt_chart_model?.trim() ?? "");
  const modelOverrides = useSettingsStore((s) => s.settings?.agent_models);
  const customAgents = useSettingsStore((s) => s.settings?.custom_agents ?? EMPTY_CUSTOM_AGENTS);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { enabledAgents, installedCustom } = useAddTabMenuData(scope);
  const addTabToScope = useTabsStore((s) => s.addTabToScope);
  const project = useProjectsStore((s) => s.projects.find((item) => item.id === scope));
  const use24h = useUse24h();
  const { confirmAction, dialogs } = useDialogs();
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const nowBandRef = useRef<HTMLDivElement>(null);
  const cardNodes = useRef(new Map<string, HTMLElement>());
  const draftBoard = useRef<DraftBoardHandle>(null);
  const refreshLinks = useCallback(() => setLinksVersion((value) => value + 1), []);

  /** What a failed write says: a backend sentinel as its sentence, anything
   *  else as its own message — never `String(error)`'s "Error: " prefix. */
  const formatError = (cause: unknown): string => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes(SCHEDULE_GONE_ERROR)) return t("promptChart.scheduleGone");
    if (message.includes(SCHEDULE_BUSY_ERROR)) return t("promptChart.scheduleBusy");
    if (message.includes(LINK_CYCLE_ERROR)) return t("promptChart.linkCycle");
    if (message.includes(LINK_JOIN_ERROR)) return t("promptChart.linkJoin");
    return message;
  };
  /** Every write starts by clearing the last error (the link editor's rule),
   *  and reports its own failure in the banner. Never rejects. */
  const attempt = (work: () => Promise<unknown>): Promise<void> => {
    setError("");
    return work().then(() => undefined, (cause) => setError(formatError(cause)));
  };

  // A hidden chart does not reload on every prompt change — the backend
  // emits one per history record and blame write, constantly while agents
  // work. It remembers that it is behind and catches up once, on show.
  const activeRef = useRef(active);
  activeRef.current = active;
  const staleRef = useRef(false);
  const reload = useCallback(() => {
    void Promise.all([
      loadPrompts(scope),
      loadHistory(scope),
      loadLinks(scope).catch(() => []),
    ]).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [loadHistory, loadLinks, loadPrompts, scope]);
  useEffect(() => {
    if (activeRef.current) reload();
    else staleRef.current = true;
    return subscribeTauri(() =>
      listen("agent-prompts-changed", () => {
        if (activeRef.current) reload();
        else staleRef.current = true;
      }),
    );
  }, [reload]);
  useEffect(() => {
    if (!active || !staleRef.current) return;
    staleRef.current = false;
    reload();
  }, [active, reload]);

  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [active]);

  const baseWin = useMemo(() => timelineWindow(view, anchor, weekStart), [anchor, view, weekStart]);

  const liveStrands = useMemo<PromptChartStrand[]>(() => tabs.map((tab) => ({
    id: `strand:${tab.scheduleTargetId}`,
    label: tab.label,
    scheduleTargetId: tab.scheduleTargetId,
    tabKey: tab.key,
    sessionId: tab.sessionId,
    tabId: historyTabId(tab),
    agent: tab.cmd,
    model: modelByTab[`${scope}:${tab.key}`],
    schedules: schedulesByTarget[scheduleCacheKey(scope, tab.scheduleTargetId!)] ?? [],
  })), [modelByTab, scope, schedulesByTarget, tabs]);

  // One closed strand per gone TAB, not per session: a tab's rows after a
  // `/clear` carry a new session id but the same tab id, and they stay on
  // its strand — as separate session cards, joined by the edge the history
  // drew when the id rolled.
  const closedStrands = useMemo<PromptChartStrand[]>(() => {
    const map = new Map<string, PromptChartStrand>();
    for (const row of history) {
      if (liveStrands.some((strand) => rowOnStrand(strand, row))) continue;
      const identity = row.tab_id ?? row.session_id ?? row.tab_label;
      if (map.has(identity)) continue;
      map.set(identity, {
        id: `closed:${identity}`,
        label: row.tab_label || t("promptChart.closed"),
        sessionId: row.session_id,
        tabId: row.tab_id,
        agent: row.agent,
        closed: true,
        schedules: [],
      });
    }
    return [...map.values()];
  }, [history, liveStrands, t]);
  const strands = useMemo(() => [...liveStrands, ...closedStrands], [closedStrands, liveStrands]);
  const strandById = useMemo(() => new Map(strands.map((strand) => [strand.id, strand])), [strands]);
  const tabByTarget = useMemo(() => new Map(tabs.map((tab) => [tab.scheduleTargetId, tab])), [tabs]);
  const cards = useMemo(() => buildPromptChart({ prompts, history, strands, links, now, newTabAgent, newTabModel }), [history, links, newTabAgent, newTabModel, now, prompts, strands]);
  // The turns running or waiting for an answer right now (read off the tabs'
  // activity, never stored): their cards wear Running or Needs answer, and the
  // running ones' bars grow with `now`.
  const live = usePromptLiveState(scope, cards, strands, active);
  const runningIds = useMemo(() => new Set([...live].filter(([, state]) => state === "running").map(([id]) => id)), [live]);
  // Sequences are read off the edges, never stored: each is an `after` chain of
  // two or more prompts, and each member knows its place in it.
  const sequences = useMemo(() => promptSequences(cards, links, live), [cards, links, live]);
  const places = useMemo(() => sequencePlaces(sequences), [sequences]);
  // Tabs already holding a live rule: not offered to a draft or to another
  // rule, since two rules on one tab fire in no set order. A further prompt
  // reaches such a tab by an `after` link from the rule it holds.
  const occupiedIds = useMemo(() => new Set(occupiedTargets(cards).keys()), [cards]);
  // Chained cards stay on the board with the drafts: they have no minute of
  // their own (they go once their source's turn has finished), and the board
  // is where a card without a time can be moved freely.
  const stripCards = useMemo(() => cards.filter(isStripCard), [cards]);
  const stripIds = useMemo(() => new Set(stripCards.map((card) => card.id)), [stripCards]);
  const timeCards = useMemo(() => cards.filter((card) => !stripIds.has(card.id)), [cards, stripIds]);
  // The text/tag/agent/outcome match, by key, for strip and timeline cards
  // alike; the "When" window is asked of timeline cards only, and per drawn
  // instant, since a recurring rule's occurrences share a key.
  const matched = useMemo(() => new Set(cards.filter((card) => promptChartCardMatches(card, filter)).map((card) => card.key)), [cards, filter]);
  const allTagCounts = useMemo(() => tagCounts(cards.map((card) => ({ tags: [...card.tags, ...card.autoTags] }))), [cards]);
  const allAgents = useMemo(() => agentsOf(cards), [cards]);
  const tabAgents = useMemo(() => tabs.map((tab) => tab.cmd), [tabs]);
  const { marks: usageResets, upcoming: upcomingResets } = usePromptChartUsage(tabAgents, active, now, baseWin.start, baseWin.end, filter.agent);
  // The Day view folds its quiet night (00:00–06:00) into one block while
  // nothing lies in it. The window carries the fold, so the axis, the drag
  // hook and every drop computation read the same piecewise scale.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const win = useMemo(() => {
    if (baseWin.view !== "day" || unfolded.has(baseWin.anchor)) return baseWin;
    const instants = [
      now,
      ...timelineItems(cards, baseWin, now).flatMap((item) => [item.at, promptEndedAt(item.card) ?? item.at]),
      ...usageResets.map((mark) => mark.at),
    ];
    const fold = dayFold(baseWin, instants);
    return fold ? { ...baseWin, fold } : baseWin;
  }, [baseWin, cards, now, unfolded, usageResets]);
  /** Whether a card passes the filter. On the timeline the When window is
   *  asked of the instant the card is DRAWN at: a recurring rule's first
   *  occurrence in a future window is not its `at` (the next one from now). */
  const matches = (card: PromptChartCard, occurrence?: string, drawnAt?: Date): boolean => {
    if (stripIds.has(card.id)) return matched.has(card.key);
    const at = occurrence ? localWallClock(occurrence) : drawnAt ?? card.at ?? null;
    return matched.has(card.key) && promptChartInWindow(card, at, when, now);
  };
  const visible = (card: PromptChartCard, occurrence?: string, drawnAt?: Date) =>
    !hide || matches(card, occurrence, drawnAt);
  const sessionMatched = useMemo(
    () => new Set(timeCards.filter((card) => matched.has(card.key) && promptChartInWindow(card, card.at, when, now)).map((card) => card.key)),
    [matched, now, timeCards, when],
  );
  const shownCount = stripCards.filter((card) => matched.has(card.key)).length + sessionMatched.size;
  const filterCount = [filter.text, filter.tag, filter.agent, filter.result, when !== "any" ? when : ""].filter(Boolean).length;
  const targetIds = useMemo(() => tabs.map((tab) => tab.scheduleTargetId!), [tabs]);
  const targets = useMemo(() => tabs.map((tab) => ({
    id: tab.scheduleTargetId!,
    label: stateOf ? `${tab.label} · ${stateOf(tab)}` : tab.label,
  })), [stateOf, tabs]);

  // A lift that ended moved its card (and a repack may move others): the
  // links follow once, not on every pointer move.
  useEffect(() => setLinksVersion((value) => value + 1), [cards, view, anchor, lifts]);

  const tabOf = (targetId?: string) => (targetId ? tabByTarget.get(targetId) : undefined);
  /** The tabs a card's picker offers: a draft is not offered an occupied tab,
   *  a rule keeps its own tab and is not offered another rule's; a chained
   *  card is linked already, which is the one way onto an occupied tab. */
  const targetsFor = (card: PromptChartCard) => card.state === "chained" || card.state === "sent"
    ? targets
    : targets.filter((item) => !occupiedIds.has(item.id) || (!!card.schedule && item.id === card.targetId));
  const occupiedError = (targetId?: string) => {
    const tab = tabOf(targetId);
    return tab ? t("promptChart.targetOccupied", { tab: tab.label }) : t("promptChart.noFreeTarget");
  };
  /** A drop that means nothing, in words, when it says why. */
  const refusalText = (reason: string | undefined, targetId?: string, zoneKind?: TimelineZone["kind"]): string => {
    if (reason === "occupied") return occupiedError(targetId);
    if (reason === "past") return t(pastRefusalKey(zoneKind));
    if (reason === "no-target") return t("promptChart.dropNoTarget");
    return "";
  };
  /** A scheduled card due before its agent's window resets, with the window
   *  nearly used up: the warning, and the retime that is its one action. */
  const limitFor = (card: PromptChartCard) => {
    const warning = limitWarning(card, upcomingResets, now, win.snapMinutes);
    return warning && { warning, notice: { percent: warning.mark.percent, until: warning.mark.at } };
  };
  const newTabItem = agentItemFor(newTabAgent, customAgents);
  const newTabLabel = t("promptChart.newAgentTab", { agent: newTabItem.label });
  // The agents the toolbar offers: the "+" menu's own set (installed built-ins
  // the user has not turned off, custom agents that probe present), plus the
  // one already picked, so the pick never reads blank while a probe is out or
  // after its CLI went missing.
  const newTabAgentOptions = useMemo(() => {
    const options = [
      ...AGENT_ITEMS.filter((item) => enabledAgents?.has(item.cmd)).map((item) => ({ value: item.cmd, label: item.label })),
      ...customAgents.filter((agent) => installedCustom === null || installedCustom.has(agent.cmd)).map((agent) => ({ value: agent.cmd, label: agent.label })),
    ];
    if (!options.some((option) => option.value === newTabAgent)) options.unshift({ value: newTabAgent, label: newTabItem.label });
    return options;
  }, [customAgents, enabledAgents, installedCustom, newTabAgent, newTabItem.label]);
  const newTabModels = useMemo(() => agentModelsFor(newTabAgent, modelOverrides), [modelOverrides, newTabAgent]);
  /** A draft with no tab of its own: Send opens a new agent tab running the
   *  chart's agent and queues the prompt at it, with the model pick typed
   *  ahead as the agent's own `/model`; Schedule opens the tab and then the
   *  rule dialog on it. The tab opens on the project root — the "+" menu's
   *  worktree question is not asked here. */
  const openNewTab = (): { tab: TabEntry; preface: string[] } => {
    const spec = newAgentTabForDraft({
      agent: newTabAgent,
      model: newTabModel,
      customAgents,
      cwd: project ? resolveProjectDirectory(project) : "",
      projectName: project?.name ?? "",
      t,
    });
    // An agent of this launch nothing has been asked of yet takes the prompt
    // instead of a second blank tab opening.
    const store = useTabsStore.getState();
    const empty = findEmptyAgentTab(scope, store.tabsByScope[scope] ?? [], spec.tab);
    if (empty?.scheduleTargetId && store.revealTabInScope(scope, empty.key)) {
      return { tab: empty, preface: spec.preface };
    }
    return { tab: addTabToScope(scope, spec.tab), preface: spec.preface };
  };
  const sendPromptToNewTab = async (prompt: ProjectAgentPrompt) => {
    const { tab, preface } = openNewTab();
    await sendCollectedPrompt(scope, target(tab), prompt, preface);
  };
  const sendToNewTab = async (card: PromptChartCard) => {
    if (card.prompt) await sendPromptToNewTab(card.prompt);
  };
  const colorOf = (card: PromptChartCard) => {
    const strand = strandById.get(card.strandId);
    if (strand?.closed) return promptTargetColor(-1);
    const targetId = card.targetId ?? strand?.scheduleTargetId;
    return promptTargetColor(targetId ? targetIds.indexOf(targetId) : 0);
  };

  const send = async (card: PromptChartCard, tab: TabEntry) => {
    if (card.prompt && !card.schedule) {
      await sendCollectedPrompt(scope, target(tab), card.prompt);
    } else if (card.schedule && card.recurring) {
      // "Send this now" on a recurring rule sends one copy and leaves the rule:
      // queuing it under the rule's own id would replace the rule with a
      // one-time one, which is then retired after its delivery.
      await queuePromptForTab(scope, tab.scheduleTargetId!, card.message, {
        id: crypto.randomUUID(),
        preface: card.schedule.preface,
      });
    } else {
      // A one-time rule is taken back only if it has not gone out meanwhile —
      // otherwise the re-queue below would deliver it a second time.
      if (card.schedule && card.targetId) await removeSchedule(scope, card.targetId, card.schedule.id, { expectUndelivered: true });
      await queuePromptForTab(scope, tab.scheduleTargetId!, card.message, {
        id: card.id,
        preface: card.schedule?.preface ?? card.history?.preface,
      });
    }
  };
  const pickTab = (picked: PromptChartCard, action: "send" | "schedule") => {
    setError("");
    const card = isStripCard(picked) ? draftSequence(picked.id, cards, links)?.[0] : picked;
    if (!card) { setError(t("promptChart.sequenceBlocked")); return; }
    if (card.state === "draft" && !card.targetId) {
      if (action === "send") void attempt(() => sendToNewTab(card));
      else setDialog({ tab: openNewTab().tab, message: card.message, promptId: card.prompt?.id });
      return;
    }
    const tab = tabOf(card.targetId) ?? tabs.find((item) => !occupiedIds.has(item.scheduleTargetId!));
    if (!tab) { setError(occupiedError()); return; }
    if (!card.schedule && occupiedIds.has(tab.scheduleTargetId!)) { setError(occupiedError(tab.scheduleTargetId)); return; }
    if (action === "send") void attempt(() => send(card, tab));
    else setDialog({ tab, message: card.message, promptId: card.prompt?.id });
  };
  /** Write the rule to its (new) tab first, then drop the old copy: the
   *  order that cannot lose the rule, and the one whose upsert persists the
   *  tab binding. The upsert edits a rule that must still exist where the
   *  card says it is — a rule the scheduler delivered and retired meanwhile
   *  is refused (`schedule_gone`) rather than re-created and sent again. */
  const moveRule = async (card: PromptChartCard, targetId: string, at?: Date) => {
    if (!card.schedule) return;
    const rule = at ? { type: "once" as const, at: localOccurrenceKey(at) } : card.schedule.rule;
    if (targetId === card.targetId && !at) return;
    if (targetId !== card.targetId && occupiedIds.has(targetId)) throw new Error(occupiedError(targetId));
    await upsertSchedule(scope, targetId, { ...card.schedule, last: undefined, rule }, card.targetId ? { expectExistingOn: card.targetId } : undefined);
    if (card.targetId && targetId !== card.targetId) await removeSchedule(scope, card.targetId, card.schedule.id);
  };
  /** Whether an earlier move to `at` comes too close to `nowMs`: within one
   *  step of now the rule is simply due — a send nobody asked for. The one
   *  test behind both the refusal and the − 5 min button's disabled state. */
  const tooSoonForEarlier = (at: number, nowMs: number) => at <= nowMs + RETIME_STEP_MS;
  /** `lead` is the earlier button's margin. A later move and a drop only need
   *  the target still ahead: a drop already landed past the now line, and
   *  moving a rule later never sends it sooner. */
  const retime = async (card: PromptChartCard, at: Date, targetId = card.targetId, lead = true) => {
    if (!card.schedule || !targetId || card.recurring) return;
    const nowMs = Math.max(now.getTime(), Date.now());
    if (lead ? tooSoonForEarlier(at.getTime(), nowMs) : at.getTime() <= Date.now()) throw new Error(t("promptChart.retimeTooSoon"));
    await moveRule(card, targetId, at);
  };
  /** ± 5 min on a card. Later counts from now for a card already due (a
   *  queued one), so it always lands 5 min ahead rather than still overdue. */
  const nudge = (card: PromptChartCard, minutes: number) => {
    const from = card.at?.getTime() ?? now.getTime();
    return minutes < 0
      ? retime(card, new Date(from + minutes * 60_000))
      : retime(card, new Date(Math.max(from, Date.now()) + minutes * 60_000), card.targetId, false);
  };
  const reorderQueue = async (card: PromptChartCard, step: -1 | 1) => {
    if (!card.schedule || !card.targetId) return;
    // Ordered as the queue column shows it, not as the file stores it.
    for (const write of queueReorderWrites(cards, card, step, now)) {
      const schedule = cards.find((item) => item.targetId === card.targetId && item.schedule?.id === write.id)?.schedule;
      if (!schedule) continue;
      await upsertSchedule(scope, card.targetId, {
        ...schedule,
        last: undefined,
        rule: { type: "once", at: write.at },
      }, { expectExistingOn: card.targetId });
    }
  };
  const collect = async (card: PromptChartCard) => {
    await upsertPrompt(scope, { id: crypto.randomUUID(), message: card.message, tags: card.tags });
  };
  const remove = async (card: PromptChartCard) => {
    if (card.schedule && card.targetId) await removeSchedule(scope, card.targetId, card.schedule.id);
    if (card.prompt) await removePrompt(scope, card.prompt.id);
    if (card.history && card.state === "sent") await clearHistory(scope, card.history.id);
  };
  /** The deletes that cannot be taken back ask first: a rule (with its
   *  prompt) and a history row, naming the links the backend prunes with
   *  them. A draft is cheap to retype and a link to redraw, so those stay
   *  one click. */
  const confirmRemove = async (card: PromptChartCard) => {
    if (card.state === "scheduled" || card.state === "queued" || card.state === "sent") {
      const count = links.filter((link) => link.from === card.id || link.to === card.id).length;
      const quote = card.message.length > CONFIRM_QUOTE_CHARS ? `${card.message.slice(0, CONFIRM_QUOTE_CHARS)}…` : card.message;
      const body = [
        t("promptChart.deleteBody", { prompt: quote }),
        count === 1 ? t("promptChart.deleteLinksOne") : count > 1 ? t("promptChart.deleteLinksMany", { count }) : "",
      ].filter(Boolean).join("\n");
      const confirmed = await confirmAction({ title: t("promptChart.deleteTitle"), body, confirmLabel: t("common.delete"), danger: true });
      if (!confirmed) return;
    }
    await remove(card);
  };
  const unschedule = async (card: PromptChartCard) => {
    if (!card.prompt) await upsertPrompt(scope, { id: crypto.randomUUID(), message: card.message, tags: card.tags });
    if (card.schedule && card.targetId) await removeSchedule(scope, card.targetId, card.schedule.id);
    // A prompt taken off the axis leaves its sequence: an edge left behind
    // would chain it again, or point at a rule that no longer exists.
    for (const link of links.filter((item) => item.from === card.id || item.to === card.id)) {
      await removeLink(scope, link.id);
    }
  };
  const save = async (card: PromptChartCard, message: string, tags: string[]) => {
    if (card.prompt) await upsertPrompt(scope, { id: card.prompt.id, message, tags });
    if (card.schedule && card.targetId) await upsertSchedule(scope, card.targetId, { ...card.schedule, message }, { expectExistingOn: card.targetId });
  };
  /** The agent picker on a card: what "aim this at that tab" writes per state. */
  const setAgent = async (card: PromptChartCard, targetId: string) => {
    if (card.state === "draft" && card.prompt) {
      if (targetId && occupiedIds.has(targetId)) throw new Error(occupiedError(targetId));
      await upsertPrompt(scope, { id: card.prompt.id, message: card.message, tags: card.tags, target: targetId || "" });
    } else if (card.state === "chained" && card.chainLink) {
      await upsertLink(scope, { ...card.chainLink, target: targetId || undefined });
    } else if (card.schedule && targetId) {
      // A queued rule is due on its tab now: moving it (upsert on the new tab
      // before the delete on the old) leaves a window where both tabs hold it
      // due and may each deliver it. It stays put; a future rule still moves.
      if (card.state === "queued" && targetId !== card.targetId) throw new Error(t("promptChart.queuedRetarget"));
      await moveRule(card, targetId);
    }
  };

  const cardById = (id: string) => cards.find((card) => card.id === id);
  const closeInspectorRef = useRef<() => void>(() => {});
  /** Selecting another card closes the inspector's editor. */
  const select = (id: string) => {
    setFocusFor(null);
    setSelected(id);
    setSelectedSeq(null);
    setEditId((current) => (current === id ? current : null));
  };
  /** Enter or Space on a card: select was just called for it (batched with
   *  this), and the inspector takes the focus. */
  const openInspector = (id: string) => {
    setFocusFor(id);
    setFocusToken((value) => value + 1);
  };
  const selectedCard = selected ? cardById(selected) : undefined;
  const selectedSequence = selectedSeq ? sequences.find((sequence) => sequence.id === selectedSeq) : undefined;
  const selectSequence = (id: string) => {
    setSelected(null);
    setEditId(null);
    setSelectedSeq(id);
  };
  const selectedSession = useMemo(() => {
    const key = selectedCard ? sessionGroupKey(selectedCard) : null;
    if (!key) return undefined;
    const members = timeCards.filter((card) => sessionGroupKey(card) === key).sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
    return members.length > 1 ? members : undefined;
  }, [selectedCard, timeCards]);
  const closeInspector = () => {
    const id = selected;
    setSelected(null);
    setSelectedSeq(null);
    setEditId(null);
    // Closing it returns the reader to the card they came from.
    if (id) requestAnimationFrame(() => cardNodes.current.get(id)?.focus());
  };
  closeInspectorRef.current = closeInspector;
  const ensureLinkEndpoint = async (card: PromptChartCard) => {
    if (card.prompt || card.history) return;
    await upsertPrompt(scope, { id: card.id, message: card.message, tags: card.tags });
  };
  const beginLink = async (card: PromptChartCard) => {
    await ensureLinkEndpoint(card);
    setLinkFrom(card.id);
    select(card.id);
  };
  const targetOf = (card?: PromptChartCard) =>
    card?.targetId ?? (card ? strandById.get(card.strandId)?.scheduleTargetId : undefined);
  /** An After link that would close a loop or give a prompt a second
   *  predecessor is refused before it is written (the backend refuses it too). */
  const refuseAfterLink = (from: string, to: string, ignoreLinkId?: string) => {
    const refusal = afterLinkRefusal(links, from, to, ignoreLinkId);
    if (refusal) throw new Error(t(refusal === "cycle" ? "promptChart.linkCycle" : "promptChart.linkJoin"));
  };
  const linkCards = async (fromId: string, toId: string, kind: "related" | "after" = linkKind) => {
    if (fromId === toId) return;
    const source = cardById(fromId);
    const to = cardById(toId);
    if (!source || !to) return;
    if (kind === "after") refuseAfterLink(fromId, toId);
    await ensureLinkEndpoint(source);
    await ensureLinkEndpoint(to);
    await upsertLink(scope, {
      id: crypto.randomUUID(), from: fromId, to: toId, kind,
      target: kind === "after" ? targetOf(to) ?? targetOf(source) : undefined,
    });
  };
  const linkTo = async (to: PromptChartCard) => {
    const from = linkFrom;
    setLinkFrom(null);
    if (from) await linkCards(from, to.id);
  };
  /** The composer's draft is waiting for the prompt it follows: this card is it. */
  const linkAfter = async (source: PromptChartCard) => {
    const draft = afterFor;
    setAfterFor(null);
    if (draft) await linkCards(source.id, draft, "after");
  };
  /** Whether a click on the card `ids` finishes a pick that another card began:
   *  a link armed from it, or the composer's draft waiting for its source. */
  const pickArmed = (ids: string[]) =>
    (!!linkFrom && !ids.includes(linkFrom)) || (!!afterFor && !ids.includes(afterFor));
  const finishPick = (card: PromptChartCard) => (afterFor ? linkAfter(card) : linkTo(card));
  /** The port (a click or Enter on it) and a card's Link button: finish the
   *  pick armed on another card, else arm one from this card. */
  const linkOrBegin = (card: PromptChartCard, armedElsewhere: boolean) =>
    void attempt(() => (armedElsewhere ? finishPick(card) : beginLink(card)));
  /** The tab an edge queues its target on: its own, else the target's, else the source's. */
  const edgeTarget = (link: PromptLink) =>
    link.target ?? targetOf(cardById(link.to)) ?? targetOf(cardById(link.from));
  const editEdge = async (link: PromptLink, patch: Pick<PromptLink, "kind" | "preface">) => {
    if (patch.kind === "after" && link.kind !== "after") refuseAfterLink(link.from, link.to, link.id);
    await upsertLink(scope, {
      ...link,
      ...patch,
      target: patch.kind === "after" ? edgeTarget(link) : undefined,
    });
  };
  const openEdgeEditor = (link: PromptLink, x: number, y: number) => setEdgeEdit({ id: link.id, x, y });

  /** The tabs the composer offers: the free ones, as a draft's picker does. */
  const composeTargets = useMemo(() => targets.filter((item) => !occupiedIds.has(item.id)), [occupiedIds, targets]);
  const composeAgentOf = useCallback(
    (targetId: string) => (targetId ? tabByTarget.get(targetId)?.cmd : newTabAgent),
    [newTabAgent, tabByTarget],
  );
  /** The composer's write: the prompt as a draft first, so every choice is the
   *  draft's own gesture — send it, schedule it, link it After another card.
   *  The draft's own write failing is the composer's (it keeps its text); what
   *  comes after it reports in the banner, since the draft already exists. */
  const submitCompose = async ({ message, targetId, when, resetAt }: ComposeSubmit) => {
    setError("");
    if (targetId && occupiedIds.has(targetId)) {
      const text = occupiedError(targetId);
      setError(text);
      throw new Error(text);
    }
    const id = crypto.randomUUID();
    let prompt: ProjectAgentPrompt | undefined;
    try {
      prompt = (await upsertPrompt(scope, { id, message, tags: [], target: targetId || undefined })).find((item) => item.id === id);
    } catch (cause) {
      setError(formatError(cause));
      throw cause;
    }
    if (!prompt || when === "draft") return;
    const written = prompt;
    if (when === "after") { setAfterFor(id); return; }
    await attempt(async () => {
      if (when === "now") {
        const tab = targetId ? tabOf(targetId) : undefined;
        if (targetId && !tab) throw new Error(t("promptChart.tabGone"));
        if (tab) await sendCollectedPrompt(scope, target(tab), written);
        else await sendPromptToNewTab(written);
        return;
      }
      // A time and a reset both need a tab to hold the rule: a new one opens first.
      const tab = targetId ? tabOf(targetId) : openNewTab().tab;
      if (!tab) throw new Error(t("promptChart.tabGone"));
      if (when === "time") { setDialog({ tab, message, promptId: id }); return; }
      if (!resetAt) return;
      await upsertSchedule(scope, tab.scheduleTargetId!, { id, enabled: true, message, rule: { type: "once", at: localOccurrenceKey(resetAt) } });
    });
  };

  /** Pause holds the next step back (a flag on the edge into it); Resume clears
   *  it, and when the step before it had already finished — so the host has no
   *  turn left to react to — sends the held step itself, with the edge's commands.
   *  The tab is found, and the step sent, BEFORE the flag is cleared: a tab that
   *  closed, or a send that failed, leaves the step paused and Resume retryable,
   *  instead of a step no longer held that nothing will ever send. */
  const togglePause = (sequence: PromptSequence) => attempt(async () => {
    const held = sequence.steps.find((step) => step.status === "paused");
    if (held?.edge) {
      const edge = held.edge;
      if (held.card.prompt && resumeSendsAtOnce(sequence, held, live)) {
        const tab = tabOf(edgeTarget(edge));
        if (!tab) throw new Error(t("promptChart.tabGone"));
        await sendCollectedPrompt(scope, target(tab), held.card.prompt, edge.preface?.length ? edge.preface : undefined);
      }
      await upsertLink(scope, { ...edge, paused: undefined });
      return;
    }
    const edge = nextPendingStep(sequence)?.edge;
    if (edge) await upsertLink(scope, { ...edge, paused: true });
  });
  /** Skip the next step: its neighbours are linked to each other, and it is a
   *  loose draft again. Stop: the edge into it goes, the rest stays linked. */
  const skipStep = (sequence: PromptSequence) => attempt(async () => {
    const plan = skipPlan(sequence, crypto.randomUUID());
    if (!plan) return;
    for (const id of plan.remove) await removeLink(scope, id);
    if (plan.add) await upsertLink(scope, plan.add);
  });
  const stopSequence = (sequence: PromptSequence) => attempt(async () => {
    const edge = stopEdge(sequence);
    if (edge) await removeLink(scope, edge.id);
  });

  const applyDrop = async (card: PromptChartCard, drop: PromptTimelineDrop) => {
    if (drop.type === "send") {
      const tab = tabOf(drop.targetId);
      // The badge said "Send now"; a tab that closed mid-drag must say why nothing went.
      if (!tab) throw new Error(t("promptChart.tabGone"));
      await send(card, tab);
    } else if (drop.type === "retime") {
      const at = localWallClock(drop.at);
      if (at) await retime(card, at, drop.targetId, false);
    } else if (drop.type === "schedule") {
      await upsertSchedule(scope, drop.targetId, { id: card.id, enabled: true, message: card.message, rule: { type: "once", at: drop.at } });
    } else if (drop.type === "unschedule") {
      await unschedule(card);
    }
  };

  // Pulling any unscheduled member carries its sequence's start. The remaining
  // prompts keep their dependency edges; only the start acquires a schedule.
  const dropSource = useCallback(
    (card: PromptChartCard) => (isStripCard(card) ? draftSequence(card.id, cards, links)?.[0] : card),
    [cards, links],
  );

  const toggleMulti = (key: string) => setMulti((keys) => {
    const next = new Set(keys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const clearMulti = () => setMulti((keys) => (keys.size ? new Set() : keys));
  /** What pressing the item `key` lifts: the whole selection when it is part
   *  of one, the pressed item first. */
  const liftKeysFor = (key: string) => (multi.has(key) ? [key, ...[...multi].filter((other) => other !== key)] : [key]);
  /** The cards one carry moves: a selected one-time rule takes the selection's
   *  other one-time rules along; anything else moves alone. */
  const carriedWith = useCallback((card: PromptChartCard): PromptChartCard[] => {
    if (multi.size < 2 || !multi.has(card.key) || !timelineGroupMovable(card)) return [card];
    const others = timeCards.filter((item) => item !== card && multi.has(item.key) && timelineGroupMovable(item));
    return [card, ...others];
  }, [multi, timeCards]);

  // Escape backs out of one thing at a time: link mode first, then the
  // multi-selection, then the selected card. A key some editor already handled
  // (its own Escape cancels the edit) or one typed into a field or a dialog is
  // not the chart's.
  const hasSelection = !!selectedCard || !!selectedSequence;
  const hasEscapable = !!linkFrom || !!afterFor || multi.size > 0 || hasSelection;
  useEffect(() => {
    if (!active || !hasEscapable) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const origin = event.target as Element | null;
      // The composer's field keeps the focus after Enter: its Escape has no edit
      // of its own to cancel, so while a pick is armed it ends that pick (and
      // nothing else: typing a prompt must not close the inspector).
      if (typeof origin?.closest === "function" && origin.closest(".agent-prompt-composer")) {
        if (linkFrom) setLinkFrom(null);
        else if (afterFor) setAfterFor(null);
        return;
      }
      if (typeof origin?.closest === "function" && origin.closest("input, textarea, [contenteditable], [role=dialog], .context-menu")) return;
      if (linkFrom) setLinkFrom(null);
      else if (afterFor) setAfterFor(null);
      else if (multi.size > 0) setMulti(new Set());
      else closeInspectorRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, afterFor, hasEscapable, linkFrom, multi.size]);

  // Stacked, the inspector is under the timeline: selecting a card scrolls it
  // into view so the click is not answered off-screen.
  useEffect(() => {
    const root = rootRef.current;
    if ((!selected && !selectedSeq) || !root || root.clientWidth >= PROMPT_CHART_STACK_WIDTH) return;
    root.querySelector(".agent-prompt-inspector")?.scrollIntoView?.({ block: "nearest" });
  }, [selected, selectedSeq]);

  const { drag, onCardPointerDown, onLiftPointerDown, onMarqueePointerDown, onPortPointerDown } = usePromptChartDrag({
    win,
    now,
    cards,
    resets: usageResets,
    agentOf: (card) => card.history?.agent ?? card.autoTags.find((tag) => tag.startsWith("agent:"))?.slice(6),
    onStale: () => setError(t("promptChart.cardChanged")),
    measure: () => {
      const body = bodyRef.current;
      const bodyRect = rectOf(body);
      return {
        rects: { strip: rectOf(stripRef.current), body: bodyRect, nowBand: rectOf(nowBandRef.current) },
        width: bodyRect?.width ?? 0,
        scrollLeft: body?.scrollLeft ?? 0,
      };
    },
    measureCards: () => [...cardNodes.current.entries()].map(([id, node]) => ({ id, rect: rectOf(node)! })),
    onDropCard: (card, zone: TimelineZone, carried) => {
      setError("");
      if (zone.kind === "strip" && stripIds.has(card.id)) {
        draftBoard.current?.place(card.id, carried.x - carried.grabDx, carried.y - carried.grabDy);
        return;
      }
      const source = dropSource(card);
      if (!source) { setError(t("promptChart.sequenceBlocked")); return; }
      const group = carriedWith(source);
      if (group.length > 1) {
        // Occupancy and the now line are checked for every member before any
        // write: a selection moves whole or not at all.
        const drops = timelineGroupDrop(source, group, zone, targetIds, win, now, occupiedIds);
        const writes = drops.filter((entry) => entry.drop.type !== "none");
        if (writes.length === 0) {
          const refused = drops.find((entry) => entry.drop.type === "none");
          const text = refusalText(noneReason(refused?.drop), refused?.card.targetId, zone.kind);
          if (text) setError(text);
          return;
        }
        void attempt(async () => { for (const { card: member, drop } of writes) await applyDrop(member, drop); });
        return;
      }
      const drop = timelineDropAction(source, zone, targetIds, occupiedIds);
      if (drop.type === "none") {
        const text = refusalText(drop.reason, source.targetId);
        if (text) setError(text);
        return;
      }
      void attempt(() => applyDrop(source, drop));
    },
    onDropLink: (from, toId) => void attempt(() => linkCards(from.id, toId)),
    onLift: (moved) => setLifts((all) => ({ ...all, [view]: { ...all[view], ...moved } })),
    measureItems: () => [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-item-key]") ?? [])]
      .map((node) => ({ id: node.dataset.itemKey!, rect: rectOf(node)! })),
    onMarquee: (keys, additive) => setMulti((current) => {
      if (!additive) return keys.length || current.size ? new Set(keys) : current;
      return keys.length ? new Set([...current, ...keys]) : current;
    }),
  });
  const dragCard = drag?.kind === "card" ? drag.card : null;
  const carried = useMemo(() => (dragCard ? carriedWith(dropSource(dragCard) ?? dragCard) : []), [carriedWith, dragCard, dropSource]);
  const boardFree = draftBoard.current?.free ?? false;

  // Links follow only the drags that move cards: a lift, and a draft carried
  // over the free canvas (drawn at the pointer). A carry or a rubber band over
  // the timeline moves nothing — its ghost is fixed-position — so it does not
  // re-measure every link per pointer move. One measure per frame at most, and
  // one more once such a drag ends.
  const followKey = drag?.kind === "lift"
    ? `lift:${drag.dy}`
    : drag?.kind === "card" && drag.zone.kind === "strip" && boardFree ? `strip:${drag.x}:${drag.y}` : "";
  const following = useRef(false);
  useEffect(() => {
    if (!followKey) {
      if (following.current) { following.current = false; refreshLinks(); }
      return;
    }
    following.current = true;
    const frame = requestAnimationFrame(refreshLinks);
    return () => cancelAnimationFrame(frame);
  }, [followKey, refreshLinks]);

  // The badge is decided once per zone, not once per pointer move: a zone is
  // the same write all across its width (a time zone per snapped minute).
  const zoneKind = drag?.kind === "card" ? drag.zone.kind : null;
  const zoneAt = drag?.kind === "card" && drag.zone.kind === "time" ? drag.zone.at.getTime() : 0;
  const zoneReset = drag?.kind === "card" && drag.zone.kind === "time" ? drag.zone.reset : undefined;
  const dropBadge = useMemo<{ label: string; blocked: boolean } | null>(() => {
    if (!dragCard || !zoneKind) return null;
    const zone = (zoneKind === "time" ? { kind: "time", at: new Date(zoneAt), reset: zoneReset } : { kind: zoneKind }) as TimelineZone;
    if (zone.kind === "strip" && stripIds.has(dragCard.id)) {
      return boardFree
        ? { label: t("promptChart.dropMoveHere"), blocked: false }
        : { label: t("promptChart.dropNeedsFreeLayout"), blocked: true };
    }
    const source = dropSource(dragCard);
    const keys: Record<PromptTimelineDrop["type"], "promptChart.sendNow" | "promptChart.dropSchedule" | "promptChart.dropRetime" | "promptChart.dropUnschedule" | "promptChart.dropBlocked"> = {
      send: "promptChart.sendNow",
      schedule: "promptChart.dropSchedule",
      retime: "promptChart.dropRetime",
      unschedule: "promptChart.dropUnschedule",
      none: "promptChart.dropBlocked",
    };
    const blocked = (reason?: string) => ({
      label: reason === "occupied" ? t("promptChart.dropOccupied")
        : reason === "past" ? t(pastRefusalKey(zone.kind))
          : reason === "no-target" ? t("promptChart.dropNoTarget")
            : t(keys.none),
      blocked: true,
    });
    if (source && carried.length > 1) {
      const drops = timelineGroupDrop(source, carried, zone, targetIds, win, now, occupiedIds);
      const writes = drops.filter((entry) => entry.drop.type !== "none");
      if (writes.length === 0) return blocked(noneReason(drops.find((entry) => entry.drop.type === "none")?.drop));
      return { label: t("promptChart.dropGroup", { action: t(keys[writes[0].drop.type]), count: writes.length }), blocked: false };
    }
    const drop: PromptTimelineDrop = source ? timelineDropAction(source, zone, targetIds, occupiedIds) : { type: "none" };
    if (drop.type === "none") return blocked(drop.reason);
    // Name the tab the write reaches: an unaimed draft falls back to the first
    // free tab, which its face ("New agent tab") does not say.
    const tabLabel = drop.type === "send" || drop.type === "schedule" ? tabByTarget.get(drop.targetId)?.label : undefined;
    const action = tabLabel && drop.type === "send" ? t("promptChart.dropSendIn", { tab: tabLabel })
      : tabLabel && drop.type === "schedule" ? t("promptChart.dropScheduleOn", { tab: tabLabel })
        : t(keys[drop.type]);
    const sequence = draftSequence(dragCard.id, cards, links);
    // A drop snapped to a reset says so: "Schedule on Claude · after the 5h reset".
    const named = zoneReset && (drop.type === "schedule" || drop.type === "retime")
      ? `${action} · ${t(`promptChart.afterReset.${zoneReset}` as "promptChart.afterReset.session")}`
      : action;
    return {
      label: sequence && sequence.length > 1 && (drop.type === "send" || drop.type === "schedule")
        ? t("promptChart.dropSequence", { action: named, count: sequence.length }) : named,
      blocked: false,
    };
  }, [boardFree, cards, carried, dragCard, dropSource, links, now, occupiedIds, stripIds, t, tabByTarget, targetIds, win, zoneAt, zoneKind, zoneReset]);

  const linkLabel = (id: string) => {
    const card = cardById(id);
    const text = card?.message ?? id;
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  };

  /** A session's sent prompts as one card, drawn under the newest of them. */
  const renderSession = (latest: PromptChartCard, session: SessionSpan, bar?: { anchor: "left" | "right"; width: number }) => {
    if (!session.cards.some((card) => visible(card))) return null;
    const ids = session.cards.map((card) => card.id);
    const itemKey = sessionGroupKey(latest) ?? latest.key;
    const armedElsewhere = pickArmed(ids);
    return (
      <PromptSessionCard
        cards={session.cards}
        offsets={session.offsets}
        matchedKeys={sessionMatched}
        selected={!!selected && ids.includes(selected)}
        multiSelected={multi.has(itemKey)}
        onToggleSelect={() => toggleMulti(itemKey)}
        linking={armedElsewhere}
        linkOver={drag?.kind === "link" && !!drag.overId && ids.includes(drag.overId)}
        color={colorOf(latest)}
        register={(node) => {
          for (const id of ids) {
            if (node) cardNodes.current.set(id, node);
            else cardNodes.current.delete(id);
          }
        }}
        onPointerDown={onLiftPointerDown(liftKeysFor(itemKey))}
        live={live.get(latest.id)}
        step={places.get(latest.id)}
        now={now}
        onPortPointerDown={onPortPointerDown(latest)}
        onSelect={() => {
          if (armedElsewhere) void attempt(() => finishPick(latest));
          select(latest.id);
          clearMulti();
        }}
        onOpen={() => openInspector(latest.id)}
        onLink={() => linkOrBegin(latest, armedElsewhere)}
        bar={bar}
      />
    );
  };

  const renderCard = (card: PromptChartCard, occurrence?: string, session?: SessionSpan, drawnAt?: Date, bar?: { anchor: "left" | "right"; width: number }) => {
    if (session) return renderSession(card, session, bar);
    if (!visible(card, occurrence, drawnAt)) return null;
    const itemKey = occurrence ? `${card.key}@${occurrence}` : card.key;
    // On a lane: selectable, and liftable. The strip and the queue are neither.
    const onLane = !stripIds.has(card.id) && card.state !== "queued";
    const armedElsewhere = pickArmed([card.id]);
    const pointerDown = card.state === "sent"
      ? onLiftPointerDown(liftKeysFor(itemKey))
      // A recurring rule never carries; with Shift it still lifts.
      : card.recurring || occurrence
        ? onLane ? onLiftPointerDown(liftKeysFor(itemKey), true) : undefined
        : onCardPointerDown(card, onLane ? liftKeysFor(itemKey) : undefined);
    return (
      <PromptCard
        projectId={scope}
        key={itemKey}
        card={card}
        occurrence={occurrence}
        drawnAt={drawnAt}
        matched={matches(card, occurrence, drawnAt)}
        live={live.get(card.id)}
        limit={occurrence ? undefined : limitFor(card)?.notice}
        onMoveAfterReset={(() => {
          const found = limitFor(card);
          return found && !card.recurring ? () => void attempt(() => retime(card, found.warning.moveTo, card.targetId, false)) : undefined;
        })()}
        step={occurrence ? undefined : places.get(card.id)}
        now={now}
        selected={selected === card.id}
        multiSelected={onLane && multi.has(itemKey)}
        onToggleSelect={onLane ? () => toggleMulti(itemKey) : undefined}
        linking={armedElsewhere}
        dragging={drag?.kind === "card" && (drag.card.key === card.key || (!occurrence && carried.includes(card)))}
        linkOver={drag?.kind === "link" && drag.overId === card.id}
        color={colorOf(card)}
        targets={targetsFor(card)}
        targetBlocked={card.state === "draft" && card.targetId && occupiedIds.has(card.targetId) ? tabOf(card.targetId)?.label : undefined}
        targetLabel={card.state === "sent" ? card.history?.tab_label : undefined}
        newTabLabel={newTabLabel}
        register={(node) => {
          if (node) cardNodes.current.set(card.id, node);
          else cardNodes.current.delete(card.id);
        }}
        // A sent card keeps its instant; it only lifts up or down its lane.
        onPointerDown={pointerDown}
        onPortPointerDown={onPortPointerDown(card)}
        onSelect={() => {
          if (armedElsewhere) void attempt(() => finishPick(card));
          select(card.id);
          clearMulti();
        }}
        onOpen={() => openInspector(card.id)}
        onEdit={() => { select(card.id); setEditId(card.id); }}
        onAgent={(targetId) => attempt(() => setAgent(card, targetId))}
        onDelete={() => attempt(() => confirmRemove(card))}
        onLink={() => linkOrBegin(card, armedElsewhere)}
        links={links}
        bar={bar}
        showDate={view !== "day" && view !== "hour"}
      />
    );
  };

  /** Ctrl + wheel: the next view in, or out, keeping the pointed-at day. */
  const zoom = (direction: "in" | "out", at: Date) => {
    const next = zoomTimelineView(view, direction);
    if (!next) return;
    setAnchor(next === "hour" ? hourAnchor(at) : toDateStr(at));
    setView(next);
  };
  /** A view button: the Hour view needs an hour, and takes the clock's. */
  const pickView = (next: TimelineView) => {
    if (next === "hour") setAnchor((value) => value.includes("T") ? value : `${value.slice(0, 10)}${hourAnchor(new Date()).slice(10)}`);
    setView(next);
  };

  const toggleDrafts = () => setDraftsCollapsed((collapsed) => {
    try { localStorage.setItem(DRAFTS_STORAGE_KEY, collapsed ? "expanded" : "collapsed"); } catch { /* the choice lasts the session */ }
    return !collapsed;
  });
  const clampDraftsWidth = (width: number) => Math.max(DRAFTS_MIN_WIDTH, Math.min(DRAFTS_MAX_WIDTH, Math.round(width)));
  const storeDraftsWidth = (width: number) => {
    try { localStorage.setItem(DRAFTS_WIDTH_KEY, String(width)); } catch { /* the width lasts the session */ }
  };
  /** The handle on the column's right edge. A drag follows the pointer; the
   *  release is bound at the press like the chart's other gestures. */
  const resizeDrafts = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = draftsWidth;
    const pointerId = event.pointerId;
    const captureEl = document.documentElement;
    let width = startWidth;
    if (dragPlatform.needsPointerCapture) {
      try { captureEl.setPointerCapture(pointerId); } catch { /* an optimisation */ }
    }
    const onMove = (pointer: PointerEvent) => {
      width = clampDraftsWidth(startWidth + pointer.clientX - startX);
      setDraftsWidth(width);
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      if (dragPlatform.needsPointerCapture) {
        try { captureEl.releasePointerCapture(pointerId); } catch { /* already released */ }
      }
      storeDraftsWidth(width);
    };
    window.addEventListener("pointermove", onMove);
    bindDragRelease({ onCommit: finish, onAbort: finish });
  };
  const rangeLabel = view === "hour"
    ? `${formatLongDate(anchor.slice(0, 10), lang)} · ${formatTimelineInstant(win.start, lang, use24h, false)} – ${formatTimelineInstant(win.end, lang, use24h, false)}`
    : view === "day"
    ? formatLongDate(anchor.slice(0, 10), lang)
    : view === "week"
      ? `${formatLongDate(todayStr(win.start), lang)} – ${formatLongDate(todayStr(new Date(win.end.getTime() - 1)), lang)}`
      : `${monthName(lang, win.start.getMonth() + 1)} ${win.start.getFullYear()}`;
  const viewLifted = Object.keys(lifts[view] ?? {}).length > 0;

  const filterPanel = (
    <PromptChartFilterBar
      testId="prompt-chart-filter"
      filter={filter}
      onChange={setFilter}
      agents={allAgents}
      tags={allTagCounts}
      hideOthers={hide}
      onHideOthers={() => setHide((value) => !value)}
      window={when}
      onWindow={setWhen}
      shown={shownCount}
      total={cards.length}
      onClear={() => { setFilter(EMPTY_FILTER); setWhen("any"); }}
    />
  );

  return (
    <section className="agent-prompts-section agent-prompt-chart-section">
      <PromptChartCommandBar
        text={filter.text}
        onText={(text) => setFilter((value) => ({ ...value, text }))}
        filterCount={filterCount}
        filterPanel={filterPanel}
        view={view}
        onView={pickView}
        onPrev={() => setAnchor((value) => shiftAnchor(view, value, -1))}
        onToday={() => setAnchor(view === "hour" ? hourAnchor(new Date()) : todayStr())}
        onNext={() => setAnchor((value) => shiftAnchor(view, value, 1))}
        rangeLabel={rangeLabel}
        selectedCount={multi.size}
        onClearSelection={clearMulti}
        viewLifted={viewLifted}
        // Lifts are view state: putting them back writes nothing.
        onResetLifts={() => setLifts((all) => ({ ...all, [view]: {} }))}
        linkArmed={!!linkFrom || !!afterFor}
        linkArmedText={afterFor ? t("promptChart.pickAfterSource") : undefined}
        onCancelLink={() => { setLinkFrom(null); setAfterFor(null); }}
        trailing={(
          <>
            <PromptChartOptions
              linkKind={linkKind}
              onLinkKind={setLinkKind}
              agent={newTabAgent}
              agentOptions={newTabAgentOptions}
              onAgent={(value) => void attempt(() => updateSettings({ prompt_chart_agent: value, prompt_chart_model: "" }))}
              model={newTabModel}
              models={newTabModels}
              onModel={(value) => void attempt(() => updateSettings({ prompt_chart_model: value }))}
            />
            <PromptChartHelp />
          </>
        )}
      />
      <PromptComposer
        targets={composeTargets}
        newTabLabel={newTabLabel}
        agentOf={composeAgentOf}
        resets={upcomingResets}
        now={now}
        snapMinutes={win.snapMinutes}
        onSubmit={submitCompose}
        onPreview={setPreview}
      />
      {error && (
        <div className="project-dialog-error agent-prompt-chart-error" role="alert" data-testid="prompt-chart-error">
          <span>{error}</span>
          <button type="button" className="settings-btn sm" onClick={() => setError("")}>{t("promptChart.dismissError")}</button>
        </div>
      )}
      <div className="agent-prompt-chart" ref={rootRef}>
        <PromptChartLinks
          rootRef={rootRef}
          cardNodes={cardNodes}
          links={links}
          selectedId={selected}
          version={linksVersion}
          preview={drag?.kind === "link" ? { x1: drag.x1, y1: drag.y1, x2: drag.x, y2: drag.y, kind: linkKind } : null}
          onEdit={openEdgeEditor}
          onMenu={(link, x, y) => { setEdgeEdit(null); setEdgeMenu({ id: link.id, x, y }); }}
          editLabel={t("promptChart.editLink")}
        />
        <div
          className={`agent-prompt-chart-columns${selectedCard || selectedSequence ? " has-inspector" : ""}`}
          style={{ "--drafts-width": `${draftsWidth}px` } as CSSProperties}
        >
          <div
            className={`agent-prompt-drafts-strip${draftsCollapsed ? " is-collapsed" : ""}${drag?.kind === "card" && drag.zone.kind === "strip" ? " is-drop-over" : ""}`}
            ref={stripRef}
            data-testid="prompt-chart-strip"
          >
            <header>
              <strong>{t("promptChart.drafts")}</strong>
              <span>{stripCards.length}</span>
              {!draftsCollapsed && (
                <>
                  <div className="agent-prompt-bar-spacer" />
                  <div className="agent-prompt-seg" role="group" aria-label={t("promptChart.draftLayout")}>
                    <button type="button" aria-label={t("promptChart.listLayout")} aria-pressed={!boardFree} onClick={() => draftBoard.current?.setFree(false)}>{t("promptChart.layoutList")}</button>
                    <button type="button" aria-label={t("promptChart.freeLayout")} aria-pressed={boardFree} onClick={() => draftBoard.current?.setFree(true)}>{t("promptChart.layoutFree")}</button>
                  </div>
                </>
              )}
              <button
                className="settings-btn sm is-icon agent-prompt-drafts-collapse"
                type="button"
                aria-expanded={!draftsCollapsed}
                aria-label={draftsCollapsed ? t("promptChart.expandDrafts") : t("promptChart.collapseDrafts")}
                title={draftsCollapsed ? t("promptChart.expandDrafts") : t("promptChart.collapseDrafts")}
                onClick={toggleDrafts}
              >{draftsCollapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}</button>
            </header>
            {!draftsCollapsed && (
              <PromptDraftBoard
                key={scope}
                ref={draftBoard}
                scope={scope}
                cards={stripCards}
                drag={drag}
                renderCard={renderCard}
                sequences={sequences}
                activeSequence={selectedSeq}
                selectedId={selected}
                onOpenSequence={selectSequence}
                onPickStep={(card) => select(card.id)}
                onPauseToggle={(sequence) => void togglePause(sequence)}
                onLayout={refreshLinks}
                onCreate={async (message, tags) => {
                  const id = crypto.randomUUID();
                  setError("");
                  try {
                    await upsertPrompt(scope, { id, message, tags });
                  } catch (cause) {
                    setError(formatError(cause));
                    throw cause;
                  }
                  return id;
                }}
              />
            )}
            {!draftsCollapsed && (
              <div
                className="agent-prompt-drafts-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label={t("promptChart.resizeDrafts")}
                aria-valuemin={DRAFTS_MIN_WIDTH}
                aria-valuemax={DRAFTS_MAX_WIDTH}
                aria-valuenow={draftsWidth}
                tabIndex={0}
                data-testid="prompt-chart-drafts-resize"
                onPointerDown={resizeDrafts}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const width = clampDraftsWidth(draftsWidth + (event.key === "ArrowRight" ? DRAFTS_KEY_STEP : -DRAFTS_KEY_STEP));
                  setDraftsWidth(width);
                  storeDraftsWidth(width);
                }}
              />
            )}
          </div>
          <PromptTimeline
            win={win}
            cards={cards}
            now={now}
            drag={drag}
            bodyRef={bodyRef}
            nowBandRef={nowBandRef}
            renderCard={renderCard}
            onRefine={(date) => { setAnchor(date); setView("day"); }}
            dropLabel={dropBadge?.label ?? null}
            dropBlocked={dropBadge?.blocked}
            emptyHint={tabs.length === 0 && timeCards.length === 0 ? t("promptChart.timelineEmpty") : undefined}
            onZoom={zoom}
            lifts={lifts[view]}
            resets={usageResets}
            preview={preview}
            running={runningIds}
            onBodyPointerDown={onMarqueePointerDown}
            onUnfold={() => setUnfolded((days) => new Set(days).add(baseWin.anchor))}
          />
          {selectedSequence && !selectedCard && (
            <PromptSequenceInspector
              key={selectedSequence.id}
              sequence={selectedSequence}
              live={live}
              now={now}
              onPickStep={(step) => select(step.card.id)}
              onPauseToggle={() => void togglePause(selectedSequence)}
              onSkip={() => void skipStep(selectedSequence)}
              onStop={() => void stopSequence(selectedSequence)}
              onEditLink={openEdgeEditor}
              onClose={closeInspector}
            />
          )}
          {selectedCard && (() => {
            const strand = strandById.get(selectedCard.strandId);
            return (
              <PromptInspector
                key={selectedCard.id}
                projectId={scope}
                card={selectedCard}
                live={live.get(selectedCard.id)}
                now={now}
                limit={limitFor(selectedCard)?.notice}
                onMoveAfterReset={(() => {
                  const found = limitFor(selectedCard);
                  return found && !selectedCard.recurring ? () => void attempt(() => retime(selectedCard, found.warning.moveTo, selectedCard.targetId, false)) : undefined;
                })()}
                session={selectedSession}
                editing={editId === selectedCard.id}
                onEditing={(editing) => setEditId(editing ? selectedCard.id : null)}
                focusToken={focusFor === selectedCard.id ? focusToken : 0}
                color={colorOf(selectedCard)}
                retimeEarlierDisabled={!!selectedCard.at && tooSoonForEarlier(selectedCard.at.getTime() - RETIME_STEP_MS, now.getTime())}
                targets={targetsFor(selectedCard)}
                targetBlocked={selectedCard.state === "draft" && selectedCard.targetId && occupiedIds.has(selectedCard.targetId) ? tabOf(selectedCard.targetId)?.label : undefined}
                targetLabel={selectedCard.state === "sent" ? selectedCard.history?.tab_label : undefined}
                newTabLabel={newTabLabel}
                links={links}
                linkLabel={linkLabel}
                onAgent={(targetId) => attempt(() => setAgent(selectedCard, targetId))}
                // The editor stays open with its text when the save fails.
                onSave={(message, tags) => {
                  setError("");
                  return save(selectedCard, message, tags).catch((cause) => { setError(formatError(cause)); throw cause; });
                }}
                onDelete={() => attempt(() => confirmRemove(selectedCard))}
                onSend={() => pickTab(selectedCard, "send")}
                onSchedule={() => pickTab(selectedCard, "schedule")}
                onUnschedule={() => attempt(() => unschedule(selectedCard))}
                onCollect={() => attempt(() => collect(selectedCard))}
                onRetime={(minutes) => attempt(() => nudge(selectedCard, minutes))}
                onQueueMove={(step) => attempt(() => reorderQueue(selectedCard, step))}
                onLink={() => linkOrBegin(selectedCard, pickArmed([selectedCard.id]))}
                onUnlink={(linkId) => attempt(() => removeLink(scope, linkId))}
                onEditLink={openEdgeEditor}
                onGoToTab={strand?.tabKey ? () => jumpToTab(scope, strand.tabKey!) : undefined}
                onCollectCard={(card) => attempt(() => collect(card))}
                onDeleteCard={(card) => attempt(() => confirmRemove(card))}
                onClose={closeInspector}
              />
            );
          })()}
        </div>
      </div>
      {(() => {
        const link = edgeMenu && links.find((item) => item.id === edgeMenu.id);
        if (!edgeMenu || !link) return null;
        return (
          <ContextMenuPortal x={edgeMenu.x} y={edgeMenu.y} onClose={() => setEdgeMenu(null)} className="context-menu agent-prompt-link-editor">
            <div className="context-menu-group-label">{t("promptChart.link")}</div>
            <p className="agent-prompt-link-editor-ends">{linkLabel(link.from)} {link.kind === "after" ? "→" : "—"} {linkLabel(link.to)}</p>
            <button type="button" onClick={() => { setEdgeMenu(null); openEdgeEditor(link, edgeMenu.x, edgeMenu.y); }}>{t("promptChart.editLink")}</button>
            <button type="button" onClick={() => { setEdgeMenu(null); void attempt(() => removeLink(scope, link.id)); }}>{t("promptChart.removeLink")}</button>
          </ContextMenuPortal>
        );
      })()}
      {(() => {
        const link = edgeEdit && links.find((item) => item.id === edgeEdit.id);
        if (!edgeEdit || !link) return null;
        const tab = tabOf(edgeTarget(link));
        return (
          <PromptLinkEditor
            link={link}
            fromLabel={linkLabel(link.from)}
            toLabel={linkLabel(link.to)}
            tabLabel={tab?.label}
            offered={tab ? prefaceCommandsFor(tab.cmd, prefaceOverrides) : []}
            x={edgeEdit.x}
            y={edgeEdit.y}
            // The editor shows its own failures; hand it the sentence, not the sentinel.
            onChange={(patch) => editEdge(link, patch).catch((cause) => { throw new Error(formatError(cause)); })}
            onRemove={() => removeLink(scope, link.id).then(() => setEdgeEdit(null))}
            onClose={() => setEdgeEdit(null)}
          />
        );
      })()}
      {dialog && <AgentScheduleDialog scope={scope} tab={dialog.tab} initialMessage={dialog.message} initialPromptId={dialog.promptId} onClose={() => setDialog(null)} />}
      {dialogs}
    </section>
  );
}
