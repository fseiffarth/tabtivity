import { Fragment, useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import { api, type ActivityTab, type MobileAlerts, type ProjectRow, type TabPlace, type AgentCounts as AgentCountsRow } from "../api";
import { classifyUnavailable, describeUnavailable, type UnavailableReason } from "../connection";
import { readFlag, readOrder, writeFlag, writeOrder } from "../prefs";
import { arrangeProjects, mergeProjectOrder, scopeCaption, sortProjectsByAgents } from "../projectOrder";
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
import { shortModelName } from "../localModels";
import { CliOverviewSection } from "./CliOverviewSheet";
import { AGENT_STATUS_GLYPH } from "../components/AgentStatusPill";
import { DesktopSwitchButton } from "../shell/DesktopFrame";
import { listScrollKey, useRestoreListScroll } from "../listScroll";
import { readSpeechLang, type SpeechLang } from "../speechLang";
import { NotificationsSheet, pushSummary } from "../components/NotificationsSheet";
import { customMarkupPrompts, MarkupInstructionSheet, markupInstructionSummary } from "../components/MarkupInstructionSheet";
import { MarkupOpenSheet, markupOpenSummary } from "../components/MarkupOpenSheet";
import { getSteering, subscribe as subscribeSteering, takeFindRequest } from "../steering/steeringState";
import { readMarkupOpen } from "../markupOpen";
import { getPushState, pushSupport, type HostPushState } from "../push";
import { AppMark } from "../AppMark";
import { BRAND } from "../../../src/lib/brand";
import { NeedsYou } from "../components/NeedsYou";
import { firstGrapheme } from "../components/TabCard";
import { AssistantIcon } from "../../../src/components/common/icons/Icon";
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, DiamondIcon, EyeIcon, FolderIcon, GridIcon, GripIcon, HexagonIcon, ListIcon, PencilIcon, PlusIcon, SearchIcon, StarIcon } from "../glyphs";
import { createGroup, groupOf, isFavorite, isHidden, moveToGroup, placeInSection, readProjectSorting, renameGroup, sectionProjects, setFavorite, setHidden, shiftGroup, toggleFolded, ungroup, writeProjectSorting, type ProjectGroup, type ProjectSorting, type SectionKey } from "../projectGroups";
import { GroupNameSheet } from "../components/GroupNameSheet";
import { useTapHolds } from "../newTabDefault";
import { OptionSheet } from "../components/OptionSheet";
import type { IconProps } from "../../../src/components/common/icons/Icon";
import { FavoritesPage } from "../components/FavoritesPage";
import { markDoneSeen, readSeenDone, type SeenDone } from "../seenDone";
import { useBackLayer } from "../backStack";
import { useVisiblePoll } from "../visiblePoll";
import { effectiveLayout, readChosenLayout, writeLayout, type HomeLayout } from "../homeLayout";
import { useTier } from "../useTier";

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

/** The layouts the button offers (`HomeLayout`, `homeLayout.ts`). */
const HOME_LAYOUTS: [HomeLayout, TranslationKey, ComponentType<IconProps>][] = [["list", "mobile.home.listLayout", ListIcon], ["grid", "mobile.home.gridLayout", GridIcon], ["boxes", "mobile.home.boxLayout", HexagonIcon]];
/** Each view but Active, as its page title: the header's 🔍 and ☆ and the
 *  agent tiles lead into them, and ‹ (or the phone's back) comes home. */
const SUBVIEW_TITLE: Record<Exclude<HomeView, "active">, TranslationKey> = { agents: "mobile.home.agentsTitle", favorites: "mobile.home.viewFavorites", search: "mobile.home.viewSearch" };

export function Home({ open, openTab, tabby, todo, mail, selectedId, vpn }: {
  open: (id: string) => void;
  /** The desktop machine's OpenVPN tunnel, for the header's pill; null where
   * it has no VPN config or no status has said yet. */
  vpn?: "up" | "down" | null;
  /** The project open beside this list (the split tier): its row is marked. */
  selectedId?: string;
  /** Opens Tabby's one chat (the FAB): the assistant scope is no row here. */
  tabby: (id: string) => void;
  openTab: (projectId: string, tab: ActivityTab) => void;
  todo: (card?: string) => void;
  mail: () => void;
}) {
  const [view, setView] = useState<HomeView>(() => (readFlag("projectsAgents") ? "agents" : "active"));
  // The tablet tiers (`useTier.ts`) change how the list is drawn without
  // touching what the reader chose: with no choice yet a tablet in portrait
  // draws the grid, and beside the project (split) it is always the list.
  const tier = useTier();
  const split = tier === "split";
  const [chosenLayout, setChosenLayout] = useState<HomeLayout | null>(() => readChosenLayout());
  const layout = effectiveLayout(chosenLayout, tier);
  const chooseLayout = (next: HomeLayout) => {
    setChosenLayout(next);
    writeLayout(next);
  };
  /** The boxes folded shut in the box layout, this phone's own. */
  const [foldedBoxes, setFoldedBoxes] = useState<string[]>(() => readOrder("homeFoldedBoxes"));
  /** The layout button's sheet: list, grid or boxes. */
  const [layoutSheet, setLayoutSheet] = useState(false);
  /** The desktop's models in memory, as the Local models section last read
   *  them: the header's pill. A tap on it opens that section's sheet. */
  const [loadedModels, setLoadedModels] = useState<string[]>([]);
  const [modelsOpen, setModelsOpen] = useState(0);
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
  // Reuse the Needs you feed instead of starting a second activity poll.
  const [activityTabs, setActivityTabs] = useState<ActivityTab[]>([]);
  /** The hand-arranged project order, this phone's own (`projectOrder.ts`). It
   * is read once: nothing else on the phone writes it, and re-reading it on
   * every render would undo a drag the moment a poll came back. */
  const [order, setOrder] = useState<string[]>(() => readOrder("projectOrder"));
  /** Favorites, hidden projects and named groups, this phone's own
   *  (`projectGroups.ts`); read once for the same reason as the order. */
  const [sorting, setSorting] = useState<ProjectSorting>(() => readProjectSorting());
  const updateSorting = (next: ProjectSorting) => {
    setSorting(next);
    writeProjectSorting(next);
  };
  /** The project a hold opened its sheet for, and which step of it is up:
   *  the actions, the group picker, or naming a new group. */
  const [rowMenu, setRowMenu] = useState<{ project: ProjectRow; step: "actions" | "group" | "name" } | null>(null);
  /** The group a hold on its heading opened the sheet for. */
  const [groupMenu, setGroupMenu] = useState<{ group: ProjectGroup; step: "actions" | "rename" } | null>(null);
  /** The Hidden fold at the list's end, shut until asked for. */
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const press = useTapHolds();
  /** Only the agents mode is remembered: the other two differ by a query the
   * reader has to type anyway, and a Projects tab that opened on an empty
   * search box would be a worse landing than the active list. */
  const choose = (next: HomeView) => {
    setView(next);
    writeFlag("projectsAgents", next === "agents");
  };
  /** The `/` key of keyboard steering asks for the search, possibly from a
   * screen that unmounted Home: the request waits in the steering store until
   * Home mounts (or sees the counter move) and then takes it. */
  const findSeq = useSyncExternalStore(subscribeSteering, () => getSteering().findSeq, () => 0);
  useEffect(() => {
    if (!takeFindRequest()) return;
    choose("search");
    // `autoFocus` only fires when the box mounts; from the search view already, put the caret in it.
    const frame = requestAnimationFrame(() => document.querySelector<HTMLInputElement>("input.search")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [findSeq]);
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
   * the default agent order as the fallback; a search result is not arranged at all — it is
   * an answer to a query, and the best match belongs at the top of it. */
  const listed = view === "search" ? rows : arrangeProjects(sortProjectsByAgents(rows, activityTabs), (project) => project.id, order);
  const firstCounted = listed.find((project) => project.agents)?.id;
  /** The active list's hidden rows go to the Hidden fold in every layout; a
   *  search result shows everything it found. */
  const hiddenRows = view === "active" ? listed.filter((project) => isHidden(sorting, project.id)) : [];
  const shown = hiddenRows.length ? listed.filter((project) => !isHidden(sorting, project.id)) : listed;
  /** The list and grid layouts' sections: Favorites, each named group, the
   *  ungrouped rest (`projectGroups.ts`). The box layout has its own. */
  const sections = view === "active" && layout !== "boxes" ? sectionProjects(listed, (project) => project.id, sorting) : null;
  /** Each drawn row's section, for a drop that crosses into another one. */
  const sectionOf = new Map<string, SectionKey>();
  if (sections) {
    for (const project of sections.favorites) sectionOf.set(project.id, { kind: "favorites" });
    for (const { group, rows: members } of sections.groups) {
      if (!sorting.folded.includes(group.id)) for (const project of members) sectionOf.set(project.id, { kind: "group", id: group.id });
    }
    for (const project of sections.loose) sectionOf.set(project.id, { kind: "loose" });
  }
  /** The rows as they stand on screen, top to bottom: what a drag reads its
   *  drop positions off and the arrow keys step through. */
  const drawnKeys = sections ? [...sectionOf.keys()] : shown.map((project) => project.id);
  /** One row cannot be rearranged, and neither can a search result — nor the
   *  box layout, where a project can stand under more than one box. */
  const canReorder = view === "active" && layout !== "boxes" && drawnKeys.length > 1;
  /** The box layout's groups: each box row with the listed projects it names
   *  (`members`, already narrowed by the host to what this phone may see), in
   *  the box's order, and every other row below. An older host sends no
   *  members, so its boxes fold nothing and every project stays loose. */
  const boxGroups = layout === "boxes" ? (() => {
    const byId = new Map(shown.map((project) => [project.id, project]));
    const groups = shown.filter((project) => project.kind === "box").map((box) => ({
      box,
      members: (box.members ?? []).map((id) => byId.get(id)).filter((project): project is ProjectRow => !!project && (project.kind ?? "project") === "project"),
    }));
    const boxed = new Set(groups.flatMap((group) => group.members.map((project) => project.id)));
    return { groups, loose: shown.filter((project) => project.kind !== "box" && !boxed.has(project.id)) };
  })() : null;
  /** Move one project beside another and remember it. Nothing is sent anywhere:
   *  the order is this phone's, so the drop is done the moment it is stored —
   *  there is no round trip to reconcile with and no way for it to be refused. */
  const moveProject = (key: string, anchor: string, place: TabPlace) => {
    const next = mergeProjectOrder(order, placeBeside(listed, (project) => project.id, key, anchor, place).map((project) => project.id));
    setOrder(next);
    writeOrder("projectOrder", next);
    // Dropped beside a row of another section: the project moves into it.
    const from = sectionOf.get(key);
    const to = sectionOf.get(anchor);
    if (from && to && JSON.stringify(from) !== JSON.stringify(to)) updateSorting(placeInSection(sorting, key, to));
  };
  /** The list's drag hint, gone for good once dismissed or once a row has
   *  been dragged. */
  const [hintGone, setHintGone] = useState(() => readFlag("homeHintReorder"));
  const dropHint = () => {
    setHintGone(true);
    writeFlag("homeHintReorder", true);
  };
  const drag = useRowDrag(drawnKeys, (key, anchor, place) => { dropHint(); moveProject(key, anchor, place); }, canReorder);
  /** The hold hint under the list ("Hold a project to …"), gone for good once
   *  dismissed or once a hold has opened the sheet. */
  const [holdHintGone, setHoldHintGone] = useState(() => readFlag("homeHintHold"));
  const dropHoldHint = () => {
    setHoldHintGone(true);
    writeFlag("homeHintHold", true);
  };
  const holdProject = (project: ProjectRow) => {
    dropHoldHint();
    setRowMenu({ project, step: "actions" });
  };
  /** The finished tabs this phone has opened (`seenDone.ts`): Needs you lists
   *  a done tab until then. Opening one from anywhere on Home — Needs you or
   *  the Agents view — marks it. */
  const [seen, setSeen] = useState<SeenDone>(() => readSeenDone());
  const openAgentTab = (projectId: string, tab: ActivityTab) => {
    if (tab.agent_status === "done") setSeen(markDoneSeen(tab.id, tab.done_at));
    // A tab with no live session here — ended, started before the project's
    // Mobile switch, or on a host the desktop is not connected to — opens its
    // project: its card there restarts it, or says why it cannot. A terminal
    // opened on it would only report the session gone.
    if (!tab.available) open(projectId);
    else openTab(projectId, tab);
  };
  /** One project row's opener — tile, name and caption, agent counts, open
   *  tabs — the same in every layout. `caption` replaces the scope line (a
   *  box head says how many projects it holds). */
  const projectCard = (project: ProjectRow, caption?: string) => <button className="card" data-steer-row={project.id} aria-current={project.id === selectedId ? "true" : undefined} {...press(() => open(project.id), () => holdProject(project))}><span className="home-tile" aria-hidden="true">{projectTile(project)}</span><span><strong>{isFavorite(sorting, project.id) && <span className="home-fav-mark" role="img" aria-label={t("mobile.home.favoriteMark")} title={t("mobile.home.favoriteMark")}><StarIcon size="0.85em" /></span>}{project.label}</strong><small>{caption ?? scopeCaption(project)}</small></span><span className="card-trailing"><span className="home-agent-counts">{project.agents && <AgentCounts counts={project.agents} tagged={project.id === firstCounted} />}</span><span className="count" title={t("mobile.home.openTabs", { count: project.live_sessions })} aria-label={t("mobile.home.openTabs", { count: project.live_sessions })}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-7l-2-3H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1Z" /><path d="M3 10h18" /></svg><span>{project.live_sessions}</span></span></span></button>;
  /** One section's rows as an inset group: a row per project — its tile,
   *  name and caption, the agent counts and the open tabs — with the grip in
   *  its own column beside the opener (a press anywhere else opens the
   *  project, a hold opens its sheet, and neither may be the drag). A box row
   *  says it is one where a project row says its status: a "Paper" box
   *  beside a "Paper" project must be tellable apart. */
  const projectRows = (members: ProjectRow[], key: string) => <section key={key} className={`cards home-projects${layout === "grid" ? " home-projects-grid" : ""}`}>{members.map((project) => {
    const first = project.id === drawnKeys[0];
    return <div
      className={`tab-card one-row home-project-card${project.id === selectedId ? " is-current" : ""}${drag.rowClass(project.id)}`}
      key={project.id}
      ref={drag.rowRef(project.id)}
    >
      <div className="tab-card-head">
        {projectCard(project)}
        {first && isUntested("mobile.home.agentOrder") && <span className="untested">{t("mobile.newTab.untested")}</span>}
        {canReorder && first && isUntested("mobile.home.reorder") && <span className="untested">{t("mobile.newTab.untested")}</span>}
        {canReorder && <button
          className="tab-card-grip"
          aria-label={t("mobile.home.move", { label: project.label })}
          title={t("mobile.home.moveHint")}
          {...drag.gripProps(project.id)}
        ><GripIcon size="1em" /></button>}
      </div>
    </div>;
  })}</section>;
  const rootWaiting = rootRow?.pending_reviews ?? 0;
  const rootLabel = rootRow ? `${t("mobile.home.openRoot")}${rootWaiting > 0 ? ` · ${t("mobile.home.awaitingApproval", { count: rootWaiting })}` : ""}` : "";
  const connection = t(offline ? "mobile.home.offline" : "mobile.home.connected");
  const vpnLabel = t(vpn === "up" ? "mobile.home.vpnUp" : "mobile.home.vpnDown");
  const modelLabel = t("mobile.home.modelLoaded", { names: loadedModels.map(shortModelName).join(", ") });
  const LayoutGlyph = HOME_LAYOUTS.find(([id]) => id === layout)?.[2] ?? ListIcon;
  /** One button for the three layouts, drawn as the one in use; its sheet
   *  holds the choice. Active and Search share it. */
  const layoutButton = split ? null : <button className="home-layout-button" aria-haspopup="dialog" aria-expanded={layoutSheet} aria-label={t("mobile.home.layout")} title={t("mobile.home.layout")} onClick={() => setLayoutSheet(true)}>
    <LayoutGlyph size="22px" />
    {isUntested("mobile.home.projectGrid") && <span className="untested">{t("mobile.newTab.untested")}</span>}
    {isUntested("mobile.home.boxLayout") && <span className="untested">{t("mobile.newTab.untested")}</span>}
  </button>;
  return <main className={assistantId ? "screen home-screen has-fab" : "screen home-screen"} data-steer-pane={split ? "list" : undefined}>
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
      {/* The desktop machine's OpenVPN tunnel, when it has a VPN config: a
          word, since a second bare lamp would not say what it is for. A dead
          link says nothing about the tunnel, so the pill goes with it. */}
      {!offline && vpn && <span className={vpn === "up" ? "home-vpn up" : "home-vpn"} role="img" aria-label={vpnLabel} title={vpnLabel}>
        <span aria-hidden="true">{t("mobile.home.vpn")}</span>
        {isUntested("mobile.home.vpnLamp") && <span className="untested">{t("mobile.newTab.untested")}</span>}
      </span>}
      {/* A local model in memory on the desktop, by name, green like an up
          tunnel: it holds GPU memory, so it is worth seeing at a glance. A
          tap opens the Local models sheet (Unload is there). */}
      {!offline && loadedModels.length > 0 && <button className="home-model" aria-haspopup="dialog" aria-label={modelLabel} title={modelLabel} onClick={() => setModelsOpen((count) => count + 1)}>
        <span className="home-model-dot" aria-hidden="true" />
        <span className="home-model-name" aria-hidden="true">{shortModelName(loadedModels[0])}</span>
        {loadedModels.length > 1 && <span aria-hidden="true">{t("mobile.home.modelMore", { count: loadedModels.length - 1 })}</span>}
        {isUntested("mobile.home.modelPill") && <span className="untested">{t("mobile.newTab.untested")}</span>}
      </button>}
      {/* Another linked desktop (`shell/`): shown when there is one to switch
          to, or inside one's frame, where it asks the shell for its picker. */}
      <DesktopSwitchButton />
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
      {view === "active" && <NeedsYou onTabs={setActivityTabs} alerts={alerts} onAlerts={setAlerts} seen={seen} open={openAgentTab} todo={todo} mail={mail} showAgents={() => choose("agents")} />}
      {view === "active" && <div className="projects-row">
        <h1>{t("mobile.home.projectsTitle")}{tier !== "phone" && isUntested("mobile.tablet") && <span className="untested">{t("mobile.newTab.untested")}</span>}</h1>
        {/* The header's 🔍 again, where the list is: a reader scrolled past
            the header reaches the search without scrolling back up. */}
        <button className="home-layout-button" aria-label={t("mobile.home.searchAll")} title={t("mobile.home.searchAll")} onClick={() => choose("search")}><SearchIcon size="22px" />{isUntested("mobile.home.projectsSearch") && <span className="untested">{t("mobile.newTab.untested")}</span>}</button>
        {layoutButton}
        <button
          className="primary new-tab"
          data-steer-act="new"
          onClick={() => setNewProject(true)}
          aria-haspopup="dialog"
          aria-expanded={newProject}
          aria-label={t("mobile.newProject.title")}
          title={t("mobile.newProject.title")}
        ><PlusIcon size="1em" />{tier === "tablet" && <span className="new-tab-label">{t("mobile.newProject.title")}</span>}</button>
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
      {/* Favorites, each named group under its heading (a tap folds it, a
          hold renames, moves or dissolves it), then the ungrouped rest —
          headed only when something stands above it. A search result is
          one plain section: it is an answer, not the arranged list. */}
      {sections && sections.favorites.length > 0 && <h2 className="home-group-head home-favorites-head"><StarIcon size="0.95em" /><span>{t("mobile.home.favorites")}</span><span className="home-group-count">{sections.favorites.length}</span>{isUntested("mobile.home.projectGroups") && <span className="untested">{t("mobile.newTab.untested")}</span>}</h2>}
      {sections && sections.favorites.length > 0 && projectRows(sections.favorites, "favorites")}
      {sections && sections.groups.map(({ group, rows: members }) => {
        const folded = sorting.folded.includes(group.id);
        return <Fragment key={group.id}>
          <button
            className="home-group-head home-group-toggle"
            aria-expanded={!folded}
            title={t(folded ? "mobile.home.boxUnfold" : "mobile.home.boxFold", { label: group.name })}
            {...press(() => updateSorting(toggleFolded(sorting, group.id)), () => { dropHoldHint(); setGroupMenu({ group, step: "actions" }); })}
          ><ChevronRightIcon size="0.95em" /><span>{group.name}</span><span className="home-group-count">{members.length}</span>{isUntested("mobile.home.projectGroups") && <span className="untested">{t("mobile.newTab.untested")}</span>}</button>
          {!folded && projectRows(members, group.id)}
        </Fragment>;
      })}
      {sections && sections.loose.length > 0 && (sections.favorites.length > 0 || sections.groups.length > 0) && <h2 className="home-group-head">{t("mobile.home.otherProjects")}<span className="home-group-count">{sections.loose.length}</span></h2>}
      {sections && sections.loose.length > 0 && projectRows(sections.loose, "loose")}
      {!sections && !boxGroups && shown.length > 0 && projectRows(shown, "all")}
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
          {!folded && members.map((project) => <div className={`tab-card one-row home-project-card home-box-member${project.id === selectedId ? " is-current" : ""}`} key={project.id}>
            <div className="tab-card-head">{projectCard(project)}</div>
          </div>)}
        </section>;
      })}
      {boxGroups && view === "active" && rows.length > 0 && boxGroups.groups.length === 0 && <p className="home-box-none">{t("mobile.home.noBoxes")}</p>}
      {boxGroups && boxGroups.loose.length > 0 && <section className="cards home-projects">{boxGroups.loose.map((project) => <div className={`tab-card one-row home-project-card${project.id === selectedId ? " is-current" : ""}`} key={project.id}>
        <div className="tab-card-head">{projectCard(project)}</div>
      </div>)}</section>}
      {canReorder && !hintGone && <p className="home-hint">
        <span><GripHint text={t("mobile.home.reorderHint")} />{isUntested("mobile.home.hintDismiss") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>
        <button onClick={dropHint} aria-label={t("mobile.project.hintDismiss")} title={t("mobile.project.hintDismiss")}><span aria-hidden="true">×</span></button>
      </p>}
      {view === "active" && shown.length > 0 && !holdHintGone && <p className="home-hint">
        <span>{t("mobile.home.holdHint")}{isUntested("mobile.home.projectGroups") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>
        <button onClick={dropHoldHint} aria-label={t("mobile.project.hintDismiss")} title={t("mobile.project.hintDismiss")}><span aria-hidden="true">×</span></button>
      </p>}
      {/* The hidden projects, folded shut at the end: a tap opens one, a hold
          offers Show in the list. Search finds them as well. */}
      {hiddenRows.length > 0 && <div className="project-foot home-hidden">
        <section className="project-closed" aria-label={t("mobile.home.hidden")}>
          <button className="project-foot-row" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen((was) => !was)}>
            <span aria-hidden="true" className="project-foot-icon"><EyeIcon size="1em" /></span>
            <span>{t("mobile.home.hiddenCount", { count: hiddenRows.length })}{isUntested("mobile.home.projectGroups") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>
            <svg className="project-foot-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button>
          {hiddenOpen && hiddenRows.map((project) => <button key={project.id} className="project-closed-row" {...press(() => open(project.id), () => holdProject(project))}>{project.label}</button>)}
        </section>
      </div>}
    </>}
    {/* What goes to the desktop rather than coming from it: a file for its
        inbox and the local models it runs — plus its agent CLIs' plans and
        limits. They stay on the page, not in a sheet — closing one would drop
        the upload rows still in flight. */}
    <h2 className="home-section-head">{t("mobile.home.desktopHead")}</h2>
    <div className="home-desktop">
      <SendToDesktop />
      <LocalModelsSection onLoaded={setLoadedModels} openRequest={modelsOpen} />
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
    {/* A project row's hold: star it, put it in a group, hide it. All of it
        stays on this phone (`projectGroups.ts`). */}
    {rowMenu?.step === "actions" && (() => {
      const { project } = rowMenu;
      const favorite = isFavorite(sorting, project.id);
      const hidden = isHidden(sorting, project.id);
      return <OptionSheet
        title={project.label}
        options={[
          { key: "favorite", label: t(favorite ? "mobile.home.unfavorite" : "mobile.home.favorite"), icon: <StarIcon size="1em" />, current: false },
          { key: "group", label: t("mobile.home.moveToGroup"), icon: <FolderIcon size="1em" />, trailing: groupOf(sorting, project.id)?.name ?? t("mobile.home.noGroup"), more: true, current: false },
          { key: "hide", label: t(hidden ? "mobile.home.unhide" : "mobile.home.hide"), icon: <EyeIcon size="1em" />, current: false },
        ]}
        waiting=""
        busy={false}
        onPick={(key) => {
          if (key === "group") { setRowMenu({ project, step: "group" }); return; }
          updateSorting(key === "favorite" ? setFavorite(sorting, project.id, !favorite) : setHidden(sorting, project.id, !hidden));
          setRowMenu(null);
        }}
        onClose={() => setRowMenu(null)}
      />;
    })()}
    {rowMenu?.step === "group" && (() => {
      const { project } = rowMenu;
      const current = groupOf(sorting, project.id)?.id;
      return <OptionSheet
        title={t("mobile.home.moveToGroup")}
        subtitle={project.label}
        options={[
          ...sorting.groups.map((group) => ({ key: `group:${group.id}`, label: group.name, icon: <FolderIcon size="1em" />, current: group.id === current })),
          { key: "none", label: t("mobile.home.noGroup"), current: !current },
          { key: "new", label: t("mobile.home.newGroup"), icon: <PlusIcon size="1em" />, more: true, current: false, section: "new" },
        ]}
        waiting=""
        busy={false}
        onPick={(key) => {
          if (key === "new") { setRowMenu({ project, step: "name" }); return; }
          updateSorting(moveToGroup(sorting, project.id, key.startsWith("group:") ? key.slice("group:".length) : null));
          setRowMenu(null);
        }}
        onClose={() => setRowMenu(null)}
      />;
    })()}
    {rowMenu?.step === "name" && <GroupNameSheet
      title={t("mobile.home.newGroup")}
      onSave={(name) => { updateSorting(createGroup(sorting, name, rowMenu.project.id)); setRowMenu(null); }}
      onClose={() => setRowMenu(null)}
    />}
    {/* A group heading's hold: rename, move the section, or dissolve it. */}
    {groupMenu?.step === "actions" && (() => {
      const { group } = groupMenu;
      const index = sorting.groups.findIndex((entry) => entry.id === group.id);
      return <OptionSheet
        title={group.name}
        options={[
          { key: "rename", label: t("common.rename"), icon: <PencilIcon size="1em" />, more: true, current: false },
          { key: "up", label: t("mobile.home.groupUp"), icon: <ArrowUpIcon size="1em" />, current: false, disabled: index <= 0 },
          { key: "down", label: t("mobile.home.groupDown"), icon: <ArrowDownIcon size="1em" />, current: false, disabled: index < 0 || index >= sorting.groups.length - 1 },
          { key: "ungroup", label: t("mobile.home.ungroup"), current: false, danger: true, section: "end" },
        ]}
        waiting=""
        busy={false}
        onPick={(key) => {
          if (key === "rename") { setGroupMenu({ group, step: "rename" }); return; }
          updateSorting(key === "up" ? shiftGroup(sorting, group.id, -1) : key === "down" ? shiftGroup(sorting, group.id, 1) : ungroup(sorting, group.id));
          setGroupMenu(null);
        }}
        onClose={() => setGroupMenu(null)}
      />;
    })()}
    {groupMenu?.step === "rename" && <GroupNameSheet
      title={t("mobile.home.renameGroup")}
      initial={groupMenu.group.name}
      onSave={(name) => { updateSorting(renameGroup(sorting, groupMenu.group.id, name)); setGroupMenu(null); }}
      onClose={() => setGroupMenu(null)}
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
