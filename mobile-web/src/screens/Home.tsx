import { useEffect, useState, type ComponentType } from "react";
import { api, type ActivityTab, type MobileAlerts, type ProjectRow, type TabPlace, type AgentCounts as AgentCountsRow } from "../api";
import { classifyUnavailable, describeUnavailable, type UnavailableReason } from "../connection";
import { readFlag, readOrder, writeFlag, writeOrder } from "../prefs";
import { arrangeProjects, mergeProjectOrder, scopeCaption } from "../projectOrder";
import { useRowDrag } from "../rowDrag";
import { rememberScopeKind } from "../scopeKind";
import { placeBeside } from "../tabReorder";
import { Activity } from "./Activity";
import { BUNDLE_VERSION } from "../buildInfo";
import { isUntested } from "../../../src/lib/untested";
import { ListSkeleton } from "../components/ListSkeleton";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { SpeechLangSheet, speechLangSummary } from "../components/SpeechLangPicker";
import { ReadAloudSheet, readAloudSummary } from "../components/ReadAloudSheet";
import { readBrief, readingRate } from "../speechOutput";
import { ThemeRow, ThemeSheet } from "../components/ThemePicker";
import { TipsRow, TipsSheet, tipsOff } from "../components/TipsPicker";
import { LanguageRow, LanguageSheet } from "../components/LanguagePicker";
import { readPhoneTheme, type PhoneTheme } from "../theme";
import { SendToDesktop } from "../components/SendToDesktop";
import { NewProjectSheet } from "./NewProjectSheet";
import { LocalModelsSection } from "./LocalModelsSheet";
import { CliOverviewSection } from "./CliOverviewSheet";
import { AGENT_STATUS_GLYPH } from "../components/AgentStatusPill";
import { listScrollKey, useRestoreListScroll } from "../listScroll";
import { readSpeechLang, type SpeechLang } from "../speechLang";
import { NotificationsSheet, pushSummary } from "../components/NotificationsSheet";
import { customMarkupPrompts, MarkupInstructionSheet, markupInstructionSummary } from "../components/MarkupInstructionSheet";
import { MarkupOpenSheet, markupOpenSummary } from "../components/MarkupOpenSheet";
import { readMarkupOpen } from "../markupOpen";
import { getPushState, pushSupport, type HostPushState } from "../push";
import { AppMark } from "../AppMark";
import { BRAND } from "../../../src/lib/brand";
import { NeedsYou } from "../components/NeedsYou";
import { firstGrapheme } from "../components/TabCard";
import { AssistantIcon } from "../../../src/components/common/icons/Icon";
import { ChevronLeftIcon, ChevronRightIcon, DiamondIcon, GridIcon, GripIcon, HexagonIcon, ListIcon, PlusIcon, SearchIcon, StarIcon } from "../glyphs";
import { OptionSheet } from "../components/OptionSheet";
import type { IconProps } from "../../../src/components/common/icons/Icon";
import { FavoritesPage } from "../components/FavoritesPage";
import { markDoneSeen, readSeenDone, type SeenDone } from "../seenDone";
import { useBackLayer } from "../backStack";
import { useVisiblePoll } from "../visiblePoll";

/** A reorder hint with the drag grip drawn where its `{grip}` stands, so the
 * sentence stays one translatable string. The project screen's hint too. */
export function GripHint({ text }: { text: string }) {
  const [before, after = ""] = text.split("{grip}");
  return <>{before}<GripIcon size="1em" />{after}</>;
}

/** A project row's agent tabs by state — working, waiting on a decision,
 * done — as the tab cards' own status pills, glyph and number; a state with
 * none is left out. The glyph is decoration, so each pill's name is its
 * sentence. `tagged` carries the untested pill (one row wears it). */
const COUNTED_STATES = ["working", "question", "done"] as const;
const AGENT_COUNT_WORD: Record<(typeof COUNTED_STATES)[number], TranslationKey> = {
  working: "mobile.home.agentsWorking",
  question: "mobile.home.agentsQuestion",
  done: "mobile.home.agentsDone",
};
function AgentCounts({ counts, tagged }: { counts: AgentCountsRow; tagged: boolean }) {
  const t = useT();
  return <>{tagged && isUntested("mobile.home.agentCounts") && <span className="untested">{t("mobile.newTab.untested")}</span>}{COUNTED_STATES.filter((state) => counts[state] > 0).map((state) => {
    const word = t(AGENT_COUNT_WORD[state], { count: counts[state] });
    return <small key={state} className={`agent-status home-agent-count ${state}`} role="img" aria-label={word} title={word}><span className="agent-status-glyph" aria-hidden="true">{AGENT_STATUS_GLYPH[state]}</span>{counts[state]}</small>;
  })}</>;
}

/** A project row's tile: the name's first letter, ⬡ for a box and `>_` for
 * the root console. One accent tint for all of them — a hue per project
 * would be a second colour code beside the tab colours. */
function projectTile(project: ProjectRow): string {
  if (project.kind === "box") return "⬡";
  if (project.kind === "root") return ">_";
  return firstGrapheme(project.label).toUpperCase();
}

/** The four modes of the Projects section. `agents` is not a filter over the
 * project list but a different list entirely — every project's agent tabs that
 * are working, waiting or done, flat — so it is the one mode worth remembering
 * across the re-mounts a tab switch and a terminal visit cause. `favorites` is
 * no project list either: the files and folders starred across all projects
 * (`FavoritesPage`). */
type HomeView = "active" | "agents" | "favorites" | "search";

/** How the project list is drawn: one row per project, two tiles a line, or
 * each box folding its member projects under it (the rest below). Remembered
 * on this phone; `projectsGrid` predates the box layout and still says grid. */
type HomeLayout = "list" | "grid" | "boxes";
const readLayout = (): HomeLayout => (readFlag("projectsBoxes") ? "boxes" : readFlag("projectsGrid") ? "grid" : "list");
const HOME_LAYOUTS: [HomeLayout, TranslationKey, ComponentType<IconProps>][] = [["list", "mobile.home.listLayout", ListIcon], ["grid", "mobile.home.gridLayout", GridIcon], ["boxes", "mobile.home.boxLayout", HexagonIcon]];
/** Each view but Active, as its page title: the header's 🔍 and ☆ and the
 *  agent tiles lead into them, and ‹ (or the phone's back) comes home. */
const SUBVIEW_TITLE: Record<Exclude<HomeView, "active">, TranslationKey> = { agents: "mobile.home.agentsTitle", favorites: "mobile.home.viewFavorites", search: "mobile.home.viewSearch" };

export function Home({ open, openTab, tabby, todo, mail }: {
  open: (id: string) => void;
  /** Opens Tabby's one chat (the FAB): the assistant scope is no row here. */
  tabby: (id: string) => void;
  openTab: (projectId: string, tab: ActivityTab) => void;
  todo: (card?: string) => void;
  mail: () => void;
}) {
  const [view, setView] = useState<HomeView>(() => (readFlag("projectsAgents") ? "agents" : "active"));
  const [layout, setLayout] = useState<HomeLayout>(readLayout);
  const chooseLayout = (next: HomeLayout) => {
    setLayout(next);
    writeFlag("projectsGrid", next === "grid");
    writeFlag("projectsBoxes", next === "boxes");
  };
  /** The boxes folded shut in the box layout, this phone's own. */
  const [foldedBoxes, setFoldedBoxes] = useState<string[]>(() => readOrder("homeFoldedBoxes"));
  /** The layout button's sheet: list, grid or boxes. */
  const [layoutSheet, setLayoutSheet] = useState(false);
  const toggleBox = (id: string) => {
    const next = foldedBoxes.includes(id) ? foldedBoxes.filter((box) => box !== id) : [id, ...foldedBoxes];
    setFoldedBoxes(next);
    writeOrder("homeFoldedBoxes", next);
  };
  const t = useT();
  /** The language the phone speaks and listens in (`speechLang.ts`). It is
   * reachable from inside a session too, under the Reader's menu, but it is
   * the phone's setting rather than that session's — and a reader who has to
   * fix it mid-answer has already been read to in the wrong voice. */
  const [speechLang, setSpeechLang] = useState<SpeechLang>(() => readSpeechLang());
  const [speechLangSheet, setSpeechLangSheet] = useState(false);
  /** How read-aloud reads: whole or brief, and its rate (`speechOutput.ts`). */
  const [reading, setReading] = useState(() => ({ brief: readBrief(), rate: readingRate() }));
  const [readingSheet, setReadingSheet] = useState(false);
  const [languageSheet, setLanguageSheet] = useState(false);
  /** What a Mark up Submit tells the agent — worded here and nowhere else. */
  const [markupInstruction, setMarkupInstruction] = useState(() => customMarkupPrompts());
  const [markupInstructionSheet, setMarkupInstructionSheet] = useState(false);
  /** The mode a markable PDF opens in (`markupOpen.ts`). */
  const [markupOpen, setMarkupOpen] = useState(readMarkupOpen);
  const [markupOpenSheet, setMarkupOpenSheet] = useState(false);
  /** The phone's own theme (`theme.ts`); unset, it follows the desktop's. */
  const [theme, setTheme] = useState<PhoneTheme>(() => readPhoneTheme());
  const [themeSheet, setThemeSheet] = useState(false);
  /** The tip cards' Turn off tips, undone here (`TipsPicker`). */
  const [tipsAreOff, setTipsAreOff] = useState(tipsOff);
  const [tipsSheet, setTipsSheet] = useState(false);
  const [pushSheet, setPushSheet] = useState(false);
  /** The header gear's sheet: the phone's own settings, kept off the page. */
  const [deviceSheet, setDeviceSheet] = useState(false);
  useBackLayer(() => setDeviceSheet(false), deviceSheet);
  /** The Projects heading's ＋: a new project, made by name in the desktop's
   * projects folder (`NewProjectSheet`). */
  const [newProject, setNewProject] = useState(false);
  const rowSheetOpen = languageSheet || themeSheet || tipsSheet || speechLangSheet || readingSheet || pushSheet || markupInstructionSheet || markupOpenSheet;
  const [push, setPush] = useState<HostPushState | null>(null);
  useEffect(() => {
    if (pushSupport() !== "supported") return;
    getPushState().then(setPush, () => undefined);
  }, []);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ProjectRow[]>([]);
  /** The assistant scope's id, for the chat FAB. The active list always holds
   * it while the Mobile switch for it is on, so that list says whether it is
   * gone; a search result that misses it says nothing either way. */
  const [assistantId, setAssistantId] = useState<string | null>(null);
  /** The root console's row, when this phone may reach it. It is no project:
   * the header's logo opens it, so the list never draws it. Like the
   * assistant, only the active list says whether it is gone. */
  const [rootRow, setRootRow] = useState<ProjectRow | null>(null);
  /** Whether any list has come back yet. Until it has, an empty `rows` is
   * "still loading", not "nothing here" — and a first open with no active
   * project drew nothing at all under the heading, which read as broken. */
  const [loaded, setLoaded] = useState(false);
  // The Agents view's rows come from their own, later answer: that list puts
  // the offset back itself once they are in (`Activity`).
  useRestoreListScroll(listScrollKey(null), loaded && view !== "agents");
  /** Null while the list is loading fine; otherwise why it is not. */
  const [offline, setOffline] = useState<UnavailableReason | null>(null);
  /** Bumped to load the list again without a change of view or query: the
   * page coming back into view, the phone coming back online, and a slow
   * retry while the last load failed. After a silent re-login the reader
   * lands back on this screen, and the list it was showing is whatever the
   * dead link left — nothing else would ever ask for it again. */
  const [reload, setReload] = useState(0);
  const [alerts, setAlerts] = useState<MobileAlerts | null>(null);
  /** The hand-arranged project order, this phone's own (`projectOrder.ts`). It
   * is read once: nothing else on the phone writes it, and re-reading it on
   * every render would undo a drag the moment a poll came back. */
  const [order, setOrder] = useState<string[]>(() => readOrder("projectOrder"));
  /** Only the agents mode is remembered: the other two differ by a query the
   * reader has to type anyway, and a Projects tab that opened on an empty
   * search box would be a worse landing than the active list. */
  const choose = (next: HomeView) => {
    setView(next);
    writeFlag("projectsAgents", next === "agents");
  };
  /** A view other than Active is one step in: the phone's back comes home. */
  useBackLayer(() => choose("active"), view !== "active");
  useEffect(() => {
    // The agents mode reads its own list; leaving this poll running behind it
    // would be a catalog load per tick for a list nothing is showing.
    if (view === "agents" || view === "favorites") return;
    // Without an abort, typing "ab" then "abc" on mobile data could land the
    // older response last and leave the wrong result set on screen.
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const suffix = view === "search" ? `?view=search&q=${encodeURIComponent(query)}` : "?view=active";
      void api<{ projects: ProjectRow[] }>(`/api/v1/projects${suffix}`, { signal: controller.signal })
        .then((body) => {
          for (const project of body.projects) rememberScopeKind(project.id, project.kind);
          const assistant = body.projects.find((project) => project.kind === "assistant");
          if (assistant || view === "active") setAssistantId(assistant?.id ?? null);
          const root = body.projects.find((project) => project.kind === "root");
          if (root || view === "active") setRootRow(root ?? null);
          // Tabby is reached through the FAB and root through the logo, not
          // listed as projects.
          setRows(body.projects.filter((project) => project.kind !== "assistant" && project.kind !== "root")); setOffline(null); setLoaded(true);
        })
        .catch((error: unknown) => { if (!controller.signal.aborted) setOffline(classifyUnavailable(error)); });
    }, view === "search" ? 180 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [view, query, reload]);
  useEffect(() => {
    const again = () => setReload((count) => count + 1);
    const onVisible = () => { if (document.visibilityState === "visible") again(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", again);
    window.addEventListener("online", again);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", again);
      window.removeEventListener("online", again);
    };
  }, []);
  /** While the last load failed, try again on a slow clock — the project
   * screen's own poll does this for its tab list (`Project.tsx`). */
  useVisiblePoll(() => setReload((count) => count + 1), 30_000, { enabled: !!offline, immediate: false, catchUp: false });
  // Alerts are rows of Needs you, which only the active view draws: the
  // agents mode shows agent tabs and nothing else, and a search result is
  // an answer to a query. Polling a feed no view draws would be a
  // minute-timer for nobody.
  useVisiblePoll((signal) => api<{ alerts: MobileAlerts }>("/api/v1/alerts")
    .then((body) => { if (!signal.aborted) setAlerts(body.alerts); })
    .catch(() => { if (!signal.aborted) setAlerts(null); }), 60_000, { enabled: view === "active", catchUp: false }, []);
  /** The rows as they are drawn. The active list is the reader's own order with
   * the host's as the fallback; a search result is not arranged at all — it is
   * an answer to a query, and the best match belongs at the top of it. */
  const listed = view === "search" ? rows : arrangeProjects(rows, (project) => project.id, order);
  const firstCounted = listed.find((project) => project.agents)?.id;
  /** One row cannot be rearranged, and neither can a search result — nor the
   *  box layout, where a project can stand under more than one box. */
  const canReorder = view === "active" && layout !== "boxes" && listed.length > 1;
  /** The box layout's groups: each box row with the listed projects it names
   *  (`members`, already narrowed by the host to what this phone may see), in
   *  the box's order, and every other row below. An older host sends no
   *  members, so its boxes fold nothing and every project stays loose. */
  const boxGroups = layout === "boxes" ? (() => {
    const byId = new Map(listed.map((project) => [project.id, project]));
    const groups = listed.filter((project) => project.kind === "box").map((box) => ({
      box,
      members: (box.members ?? []).map((id) => byId.get(id)).filter((project): project is ProjectRow => !!project && (project.kind ?? "project") === "project"),
    }));
    const boxed = new Set(groups.flatMap((group) => group.members.map((project) => project.id)));
    return { groups, loose: listed.filter((project) => project.kind !== "box" && !boxed.has(project.id)) };
  })() : null;
  /** Move one project beside another and remember it. Nothing is sent anywhere:
   *  the order is this phone's, so the drop is done the moment it is stored —
   *  there is no round trip to reconcile with and no way for it to be refused. */
  const moveProject = (key: string, anchor: string, place: TabPlace) => {
    const next = mergeProjectOrder(order, placeBeside(listed, (project) => project.id, key, anchor, place).map((project) => project.id));
    setOrder(next);
    writeOrder("projectOrder", next);
  };
  /** The list's drag hint, gone for good once dismissed or once a row has
   *  been dragged. */
  const [hintGone, setHintGone] = useState(() => readFlag("homeHintReorder"));
  const dropHint = () => {
    setHintGone(true);
    writeFlag("homeHintReorder", true);
  };
  const drag = useRowDrag(listed.map((project) => project.id), (key, anchor, place) => { dropHint(); moveProject(key, anchor, place); }, canReorder);
  /** The finished tabs this phone has opened (`seenDone.ts`): Needs you lists
   *  a done tab until then. Opening one from anywhere on Home — Needs you or
   *  the Agents view — marks it. */
  const [seen, setSeen] = useState<SeenDone>(() => readSeenDone());
  const openAgentTab = (projectId: string, tab: ActivityTab) => {
    if (tab.agent_status === "done") setSeen(markDoneSeen(tab.id, tab.done_at));
    openTab(projectId, tab);
  };
  /** One project row's opener — tile, name and caption, agent counts, open
   *  tabs — the same in every layout. `caption` replaces the scope line (a
   *  box head says how many projects it holds). */
  const projectCard = (project: ProjectRow, caption?: string) => <button className="card" onClick={() => open(project.id)}><span className="home-tile" aria-hidden="true">{projectTile(project)}</span><span><strong>{project.label}</strong><small>{caption ?? scopeCaption(project)}</small></span><span className="card-trailing"><span className="home-agent-counts">{project.agents && <AgentCounts counts={project.agents} tagged={project.id === firstCounted} />}</span><span className="count" title={t("mobile.home.openTabs", { count: project.live_sessions })} aria-label={t("mobile.home.openTabs", { count: project.live_sessions })}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-7l-2-3H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1Z" /><path d="M3 10h18" /></svg><span>{project.live_sessions}</span></span></span></button>;
  const rootWaiting = rootRow?.pending_reviews ?? 0;
  const rootLabel = rootRow ? `${t("mobile.home.openRoot")}${rootWaiting > 0 ? ` · ${t("mobile.home.awaitingApproval", { count: rootWaiting })}` : ""}` : "";
  const connection = t(offline ? "mobile.home.offline" : "mobile.home.connected");
  const LayoutGlyph = HOME_LAYOUTS.find(([id]) => id === layout)?.[2] ?? ListIcon;
  /** One button for the three layouts, drawn as the one in use; its sheet
   *  holds the choice. Active and Search share it. */
  const layoutButton = <button className="home-layout-button" aria-haspopup="dialog" aria-expanded={layoutSheet} aria-label={t("mobile.home.layout")} title={t("mobile.home.layout")} onClick={() => setLayoutSheet(true)}>
    <LayoutGlyph size="22px" />
    {isUntested("mobile.home.projectGrid") && <span className="untested">{t("mobile.newTab.untested")}</span>}
    {isUntested("mobile.home.boxLayout") && <span className="untested">{t("mobile.newTab.untested")}</span>}
  </button>;
  return <main className={assistantId ? "screen home-screen has-fab" : "screen home-screen"}>
    {/* A slim bar: the mark and name, the link's lamp — worded only when the
        link is down, where it is news — and the gear for this phone's own
        settings. The global views live in the tab bar at the bottom. */}
    <header className="home-header">
      {/* The root console is no project row: when this phone may reach it, the
          mark and name open it, with a dot while its agents' proposals wait
          at the desk. Otherwise the brand is only a label. */}
      {rootRow
        ? <button className="home-brand home-brand-root" aria-label={rootLabel} title={rootLabel} onClick={() => open(rootRow.id)}>
          <span className="home-logo-frame" aria-hidden="true"><AppMark className="home-logo" />{rootWaiting > 0 && <span className="home-brand-dot" />}</span>
          <strong>{BRAND.display}</strong>
          {isUntested("mobile.home.rootLogo") && <span className="untested">{t("mobile.newTab.untested")}</span>}
        </button>
        : <div className="home-brand" aria-label={BRAND.display}>
          <span className="home-logo-frame" aria-hidden="true"><AppMark className="home-logo" /></span>
          <strong>{BRAND.display}</strong>
        </div>}
      {offline
        ? <span className="home-offline" role="img" aria-label={connection}><span className="lamp off" aria-hidden="true" /><span aria-hidden="true">{connection}</span></span>
        : <span className="lamp" role="img" aria-label={connection} title={connection} />}
      {/* The views that are no project list: a tap goes in, a second (or ‹)
          comes back. Agents is reached through Needs you's tiles. */}
      <button className="home-head-button" aria-pressed={view === "search"} aria-label={t("mobile.home.viewSearch")} title={t("mobile.home.viewSearch")} onClick={() => choose(view === "search" ? "active" : "search")}><SearchIcon size="22px" /></button>
      <button className="home-head-button" aria-pressed={view === "favorites"} aria-label={t("mobile.home.viewFavorites")} title={t("mobile.home.viewFavorites")} onClick={() => choose(view === "favorites" ? "active" : "favorites")}><StarIcon size="22px" />{isUntested("mobile.home.headerViews") && <span className="untested">{t("mobile.newTab.untested")}</span>}</button>
      <button className="home-settings" aria-haspopup="dialog" aria-expanded={deviceSheet} aria-label={t("mobile.home.thisDevice")} title={t("mobile.home.thisDevice")} onClick={() => { setTipsAreOff(tipsOff()); setDeviceSheet(true); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      </button>
    </header>
    {view !== "active" && <div className="home-subview-head">
      <button className="home-back" onClick={() => choose("active")} aria-label={t("common.back")} title={t("common.back")}><ChevronLeftIcon size="22px" /></button>
      <h1>{t(SUBVIEW_TITLE[view])}</h1>
      {view === "search" && layoutButton}
    </div>}
    {view === "agents" && <Activity open={openAgentTab} onConnection={setOffline} />}
    {view === "favorites" && <FavoritesPage />}
    {view !== "agents" && view !== "favorites" && <>
      {view === "search" && <input className="search" placeholder={t("mobile.home.searchPlaceholder")} value={query} autoFocus onChange={(event) => setQuery(event.target.value)} />}
      {offline && <p className="error connection-error">
        <strong>{describeUnavailable(offline).title}</strong>
        <span>{describeUnavailable(offline).hint}</span>
        <span>{rows.length ? t("mobile.home.showingLast") : t("mobile.home.neverCached")}</span>
        {isUntested("mobile.home.recover") && <span className="untested">{t("mobile.newTab.untested")}</span>}
      </p>}
      {view === "active" && <NeedsYou alerts={alerts} onAlerts={setAlerts} seen={seen} open={openAgentTab} todo={todo} mail={mail} showAgents={() => choose("agents")} />}
      {view === "active" && <div className="projects-row">
        <h1>{t("mobile.home.projectsTitle")}</h1>
        {layoutButton}
        <button
          className="primary new-tab"
          onClick={() => setNewProject(true)}
          aria-haspopup="dialog"
          aria-expanded={newProject}
          aria-label={t("mobile.newProject.title")}
          title={t("mobile.newProject.title")}
        ><PlusIcon size="1em" /></button>
      </div>}
      {!loaded && !offline && <ListSkeleton label={t("mobile.home.loading")} />}
      {loaded && rows.length === 0 && <div className="home-empty">
        <span className="home-empty-glyph" aria-hidden="true">{view === "search" ? <SearchIcon size="1em" /> : <DiamondIcon size="1em" />}</span>
        {view !== "search" && <strong>{t("mobile.home.emptyActiveTitle")}</strong>}
        <p>{view === "search"
          ? query.trim() ? t("mobile.home.noMatch") : t("mobile.home.typeToSearch")
          : t("mobile.home.noneActive")}</p>
        {view !== "search" && <button onClick={() => choose("search")}>{t("mobile.home.searchAll")}</button>}
      </div>}
      {/* One inset group: a row per project — its tile, name and caption, the
          agent counts and the open tabs — with the grip in its own column
          beside the opener (a press anywhere else opens the project, and the
          two must not be one gesture). A box row says it is one where a
          project row says its status: a "Paper" box beside a "Paper" project
          must be tellable apart. */}
      {listed.length > 0 && !boxGroups && <section className={`cards home-projects${layout === "grid" ? " home-projects-grid" : ""}`}>{listed.map((project, index) => <div
        className={`tab-card one-row home-project-card${drag.rowClass(project.id)}`}
        key={project.id}
        ref={drag.rowRef(project.id)}
      >
        <div className="tab-card-head">
          {projectCard(project)}
          {canReorder && index === 0 && isUntested("mobile.home.reorder") && <span className="untested">{t("mobile.newTab.untested")}</span>}
          {canReorder && <button
            className="tab-card-grip"
            aria-label={t("mobile.home.move", { label: project.label })}
            title={t("mobile.home.moveHint")}
            {...drag.gripProps(project.id)}
          ><GripIcon size="1em" /></button>}
        </div>
      </div>)}</section>}
      {/* The box layout: each box one inset group, its head the box's own row
          (opens the box) with a fold beside it, its members below; the
          projects in no box after the last one, as the list draws them. */}
      {boxGroups && boxGroups.groups.map(({ box, members }) => {
        const folded = foldedBoxes.includes(box.id);
        return <section className="cards home-projects home-box" key={box.id}>
          <div className="tab-card one-row home-project-card home-box-head">
            <div className="tab-card-head">
              {projectCard(box, t("mobile.home.boxMembers", { count: members.length }))}
              {members.length > 0 && <button
                className="tab-card-grip home-box-fold"
                aria-expanded={!folded}
                aria-label={t(folded ? "mobile.home.boxUnfold" : "mobile.home.boxFold", { label: box.label })}
                title={t(folded ? "mobile.home.boxUnfold" : "mobile.home.boxFold", { label: box.label })}
                onClick={() => toggleBox(box.id)}
              ><ChevronRightIcon size="1em" /></button>}
            </div>
          </div>
          {!folded && members.map((project) => <div className="tab-card one-row home-project-card home-box-member" key={project.id}>
            <div className="tab-card-head">{projectCard(project)}</div>
          </div>)}
        </section>;
      })}
      {boxGroups && view === "active" && rows.length > 0 && boxGroups.groups.length === 0 && <p className="home-box-none">{t("mobile.home.noBoxes")}</p>}
      {boxGroups && boxGroups.loose.length > 0 && <section className="cards home-projects">{boxGroups.loose.map((project) => <div className="tab-card one-row home-project-card" key={project.id}>
        <div className="tab-card-head">{projectCard(project)}</div>
      </div>)}</section>}
      {canReorder && !hintGone && <p className="home-hint">
        <span><GripHint text={t("mobile.home.reorderHint")} />{isUntested("mobile.home.hintDismiss") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>
        <button onClick={dropHint} aria-label={t("mobile.project.hintDismiss")} title={t("mobile.project.hintDismiss")}><span aria-hidden="true">×</span></button>
      </p>}
    </>}
    {/* What goes to the desktop rather than coming from it: a file for its
        inbox and the local models it runs — plus its agent CLIs' plans and
        limits. They stay on the page, not in a sheet — closing one would drop
        the upload rows still in flight. */}
    <h2 className="home-section-head">{t("mobile.home.desktopHead")}</h2>
    <div className="home-desktop">
      <SendToDesktop />
      <LocalModelsSection />
      <CliOverviewSection />
    </div>
    {/* What this phone does, as against what the desktop is doing, behind
        the header's gear. A row's own sheet replaces it while open, and
        closing that one comes back here rather than to the page. */}
    {deviceSheet && !rowSheetOpen && <div className="sheet-backdrop" role="presentation" onClick={() => setDeviceSheet(false)}>
      <section className="option-sheet device-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.home.thisDevice")} onClick={(event) => event.stopPropagation()}>
        <span className="sheet-grip" aria-hidden="true" />
        <header><button className="sheet-close" onClick={() => setDeviceSheet(false)} aria-label={t("common.close")}>✕</button><h2>{t("mobile.home.thisDevice")} {isUntested("mobile.home.thisDevice") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
        <ul className="option-list">
          <LanguageRow open={() => setLanguageSheet(true)} expanded={languageSheet} />
          <ThemeRow choice={theme} open={() => setThemeSheet(true)} expanded={themeSheet} />
          <TipsRow off={tipsAreOff} open={() => setTipsSheet(true)} expanded={tipsSheet} />
          <li><button aria-haspopup="dialog" aria-expanded={speechLangSheet} onClick={() => setSpeechLangSheet(true)}>
            <span><strong>{t("mobile.speech.language")}{isUntested("mobile.speech.language") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{speechLangSummary(speechLang, t)}</small></span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button></li>
          <li><button aria-haspopup="dialog" aria-expanded={readingSheet} onClick={() => setReadingSheet(true)}>
            <span><strong>{t("mobile.speech.reading")}{isUntested("mobile.speech.reading") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{readAloudSummary(reading.brief, reading.rate, t)}</small></span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button></li>
          <li><button aria-haspopup="dialog" aria-expanded={pushSheet} onClick={() => setPushSheet(true)}>
            <span><strong>{t("mobile.push.title")}{isUntested("mobile.push.title") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{pushSummary(push, t)}</small></span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button></li>
          <li><button aria-haspopup="dialog" aria-expanded={markupInstructionSheet} onClick={() => setMarkupInstructionSheet(true)}>
            <span><strong>{t("mobile.markup.instruction.title")}{isUntested("mobile.markup.instruction") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{markupInstructionSummary(markupInstruction, t)}</small></span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button></li>
          <li><button aria-haspopup="dialog" aria-expanded={markupOpenSheet} onClick={() => setMarkupOpenSheet(true)}>
            <span><strong>{t("mobile.markup.opensIn.title")}{isUntested("mobile.markup.opensIn") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{markupOpenSummary(markupOpen, t)}</small></span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button></li>
        </ul>
        {/* The build this phone runs, which used to ride under the name in
            the start page's header. */}
        <p className="sheet-note device-version">{BRAND.display} {BUNDLE_VERSION}{isUntested("mobile.version.commit") && <span className="untested">{t("mobile.newTab.untested")}</span>}</p>
      </section>
    </div>}
    {/* The assistant one tap from anywhere on Home, in the place the project
        screen keeps its ＋, straight into its one chat; the list has no row
        for it. */}
    {assistantId && <button
      className="primary fab fab-round fab-chat"
      onClick={() => tabby(assistantId)}
      aria-label={t("assistant.button")}
      title={t("assistant.button")}
    ><AssistantIcon className="fab-chat-icon" size={28} />{isUntested("mobile.home.assistantFab") && <span className="untested" aria-hidden="true">{t("mobile.newTab.untested")}</span>}</button>}
    {layoutSheet && <OptionSheet
      title={t("mobile.home.layout")}
      options={HOME_LAYOUTS.map(([id, label]) => ({ key: id, label: t(label), current: layout === id }))}
      waiting=""
      busy={false}
      onPick={(key) => { chooseLayout(key as HomeLayout); setLayoutSheet(false); }}
      onClose={() => setLayoutSheet(false)}
    />}
    {newProject && <NewProjectSheet onClose={() => setNewProject(false)} onCreated={(project) => { setNewProject(false); open(project.id); }} />}
    {languageSheet && <LanguageSheet onClose={() => setLanguageSheet(false)} />}
    {themeSheet && <ThemeSheet chosen={theme} onChoose={setTheme} onClose={() => setThemeSheet(false)} />}
    {tipsSheet && <TipsSheet off={tipsAreOff} onChange={setTipsAreOff} onClose={() => setTipsSheet(false)} />}
    {speechLangSheet && <SpeechLangSheet chosen={speechLang} onChoose={setSpeechLang} onClose={() => setSpeechLangSheet(false)} />}
    {readingSheet && <ReadAloudSheet onChange={(brief, rate) => setReading({ brief, rate })} onClose={() => setReadingSheet(false)} />}
    {pushSheet && <NotificationsSheet onChange={setPush} onClose={() => setPushSheet(false)} />}
    {markupInstructionSheet && <MarkupInstructionSheet onChange={setMarkupInstruction} onClose={() => setMarkupInstructionSheet(false)} />}
    {markupOpenSheet && <MarkupOpenSheet chosen={markupOpen} onChoose={setMarkupOpen} onClose={() => setMarkupOpenSheet(false)} />}
  </main>;
}
