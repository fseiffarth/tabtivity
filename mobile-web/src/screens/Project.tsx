import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileImageIcon } from "../../../src/components/common/icons/Icon";
import { AGENT_SORTS, DEFAULT_AGENT_SORT, isAgentSort, sortAgentTabs, type AgentSort } from "../../../shared/agentSort";
import { GitSheet } from "./GitSheet";
import { ApiError, TAB_CREATE_TIMEOUT, api, clearOutbox, closeTab, deleteOutboxFile, listOutbox, listProjectFiles, reopenTab, reorderTab, type AgentRow, type ClosedTabRow, type CreateVerdict, type ProjectHost, type OutboxFile, type ProjectDetail, type TabPlace, type TabRow } from "../api";
import { OUTBOX_POLL, sameOutbox } from "../outbox";
import { readChoice, readFlag, writeChoice, writeFlag } from "../prefs";
import { useRowDrag } from "../rowDrag";
import { applyServerOrder, placeBeside } from "../tabReorder";
import { ColorSheet } from "./ColorSheet";
import { NewTabSheet, type NewTabLaunch } from "./NewTabSheet";
import { newTabAgent, readNewTabAgent, useTapHold, writeNewTabAgent } from "../newTabDefault";
import { isAssistantScope, rememberScopeKind } from "../scopeKind";
import { useProjectInbox } from "../components/ProjectInbox";
import { PromptsSheet } from "./PromptsSheet";
import { SubagentsSheet } from "./SubagentsSheet";
import { RenameSheet } from "./RenameSheet";
import { ScheduleSheet } from "./ScheduleSheet";
import { FileTabCard, TAB_ACTION_LABEL, TabCard, schedulesOffered, tabActions, type TabAction } from "../components/TabCard";
import { OptionSheet } from "../components/OptionSheet";
import { lastWorkedAt } from "../components/AgentModeMarks";
import { clearCardDrag, installCardSwipe } from "../terminal/cardSwipe";
import { markDoneSeen, markInterruptedSeen, readSeenDone, readSeenInterrupted, showsStatusBadge, withoutResumed, writeSeenInterrupted } from "../seenDone";
import { OutboxGallery } from "../components/OutboxGallery";
import { OutboxViewer, type MarkupBack, type MarkupNewTab } from "../components/OutboxViewer";
import { ProjectFiles, asViewerFile } from "../components/ProjectFiles";
import { closeFileTab, findFileTab, onFileTabs, readFileTabs, refreshFileTab, type FileTab } from "../filesPlace";
import { markCount } from "../markup/layer";
import { layerKey, loadLayer } from "../markup/store";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { GripHint } from "./Home";
import { isUntested } from "../../../src/lib/untested";
import { describeFailure } from "../connection";
import { installFocusSwipe } from "../terminal/focusSwipe";
import type { SubagentStep } from "../terminal/subagents";

/** The orders this list offers, in the words this screen can use for them. The
 * cross-project Agents list calls `native` "Status", because there the arrival
 * order is the sidecar's status ranking; here it is the desktop's own tab
 * order, which is the thing a reader arranges by hand — so here it is
 * "Manual", and it is the only order a drag can be dropped into. */
const SORT_LABEL: Record<AgentSort, TranslationKey> = {
  lastWorking: "agentPrompts.sort.lastWorking",
  lastDone: "agentPrompts.sort.lastDone",
  native: "mobile.project.sortManual",
};

/** How long a closed row is held back from the catalog before the phone gives
 *  up and shows it again. The desktop writes the session file before it answers
 *  "closed", so the catalog agrees within one of its own reads — this is the
 *  outer bound, not the expected wait. Past it the close plainly did not take,
 *  and a row hidden for ever would be a tab the reader can neither see nor
 *  close again. */
const CLOSED_HELD_MS = 30_000;

/** The line a project type that limits the phone gets under the header (the
 * desktop says the same in `mobile.hostReach.*`). A local project has none. */
const HOST_NOTE: Partial<Record<ProjectHost, TranslationKey>> = {
  remote: "mobile.project.hostRemote",
  container: "mobile.project.hostContainer",
  vm: "mobile.project.hostVm",
};
/** Why a project the host gave no folder for has no files, Git or send-a-file,
 * by type: a remote project has no local copy yet, a VM keeps its files. */
const NO_FOLDER_NOTE: Record<ProjectHost, TranslationKey> = {
  local: "mobile.project.noFolder",
  container: "mobile.project.noFolder",
  remote: "mobile.project.noFolderRemote",
  vm: "mobile.project.noFolderVm",
};

/** How many one-second reads the wait for a started chat's session lasts. */
const CHAT_START_TRIES = 25;

/**
 * A freshly read catalog with the rows this phone has closed taken back out.
 *
 * The desktop persists its tab layout before it answers "closed", but the read
 * that carries the answer back to this screen need not be the next one to
 * arrive: the poll that was already in flight when the ✕ was pressed answers
 * with the pre-close list, and the sidecar may serve its own snapshot for a
 * moment longer. Dropping the row from the list in hand (`dropTab`) survives
 * neither, so a closed card used to spring back for a whole poll cycle.
 *
 * An id is forgotten the moment a load no longer carries it — the catalog has
 * agreed and nothing needs holding — and forgotten regardless after
 * `CLOSED_HELD_MS`, so a close that never reached disk shows its row again
 * rather than leaving a live tab invisible.
 */
function withoutClosed(detail: ProjectDetail, closed: Map<string, number>): ProjectDetail {
  if (closed.size === 0) return detail;
  const now = Date.now();
  for (const [tabId, at] of closed) {
    if (now - at > CLOSED_HELD_MS || !detail.tabs.some((row) => row.id === tabId)) closed.delete(tabId);
  }
  return closed.size === 0
    ? detail
    : { ...detail, tabs: detail.tabs.filter((row) => !closed.has(row.id)) };
}

/** How long a swiped card takes to leave (`.tab-card.swiped-out`), slide and
 *  collapse together. */
const SWIPE_OUT_MS = 360;

/** A card's own height, pinned before it is swiped out so the collapse has a
 *  number to run from (a transition cannot start at `none`); the read forces
 *  the style in before the class that animates it. */
function pinHeight(card: HTMLElement) {
  card.style.setProperty("--card-h", `${card.getBoundingClientRect().height}px`);
}
function unpinHeight(card: HTMLElement) {
  card.style.removeProperty("--card-h");
  clearCardDrag(card);
}

/** A phone-side file card's key, for React and for the swipe that closes it;
 * prefixed so it can never read as a session's id. */
function fileTabKey(file: FileTab): string {
  return file.from === "outbox" ? `outbox:${file.name}` : `file:${file.place}/${file.name}`;
}

/** A card's file as the viewer opens it: an outbox file's row as the
 * project's outbox lists it now, else as the card last saw it. */
function cardViewerFile(file: FileTab, outbox: readonly OutboxFile[]): OutboxFile {
  if (file.from !== "outbox") return asViewerFile(file);
  return outbox.find((row) => row.name === file.name)
    ?? { name: file.name, kind: file.kind, size: file.size, modified: file.modified, ...(file.label ? { original: file.label } : {}) };
}

export function Project({ id, back, terminal }: { id: string; back: () => void; terminal: (tab: TabRow, opts?: { pickModel?: boolean; signIn?: boolean; subagent?: SubagentStep; markupBack?: MarkupBack }) => void }) {
  const t = useT();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState("");
  /** The agent tab whose scheduled prompts are open. Lives on this screen so a
   * schedule can be set without attaching to the session at all. */
  const [scheduleTab, setScheduleTab] = useState<{ tab: TabRow; initialMessage?: string } | null>(null);
  /** The project's collected prompts (no tab); "Schedule…" there hands a
   * prompt to the per-tab sheet above with the text prefilled. */
  const [promptsOpen, setPromptsOpen] = useState(false);
  /** The header's ＋: what to open next — a shell, or one of the desktop's
   * agents in one of its modes. */
  const [newTabOpen, setNewTabOpen] = useState(false);
  /** The agent this phone starred in that sheet for a tap on ＋ ("" none). */
  const [starredAgent, setStarredAgent] = useState(readNewTabAgent);
  /** Which finished / interrupted tabs this phone has opened: their card
   *  badge goes, as the desktop's lamp does (`seenDone.ts`). */
  const [seenDone, setSeenDone] = useState(() => readSeenDone());
  const [seenInterrupted, setSeenInterrupted] = useState(() => readSeenInterrupted());
  /** The ＋ sheet's "Send a file": its picker and a row per pick. */
  const projectInbox = useProjectInbox(id);
  /** The agent tab being renamed. The desktop owns the tab layout, so the sheet
   * writes through the bridge and the next poll brings the new label back. */
  const [renameTab, setRenameTab] = useState<TabRow | null>(null);
  /** What the agent sent this project (`tabtivity-send` → `.tabtivity/outbox/`),
   * newest first, behind the header's 🖼. The files belong to the project, not
   * to a session, so this screen reads them by the project: a file sent from a
   * tab that has since been closed is still here. */
  const [outbox, setOutbox] = useState<OutboxFile[]>([]);
  /** Whether the listing is up, in the same sheet the Focus screen's gallery
   * button opens. */
  const [galleryOpen, setGalleryOpen] = useState(false);
  /** The file open full screen (a picture or a text preview). */
  const [fileOpen, setFileOpen] = useState<OutboxFile | null>(null);
  /** The project's drawer, slid in from the right by a right→left swipe over
   * the screen or the header's ☰: the agent's files and Git, then the
   * read-only file browser while the desktop's "Project files on the phone"
   * switch is on (`detail.files`). */
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** The PDFs this phone opened from the drawer and the files it marked up
   * (`filesPlace.ts`), a card each after the tabs, and the one open now. */
  const [fileTabs, setFileTabs] = useState<FileTab[]>(() => readFileTabs(id));
  const [fileTabOpen, setFileTabOpen] = useState<FileTab | null>(null);
  useEffect(() => {
    setFileTabs(readFileTabs(id));
    setFileTabOpen(null);
    return onFileTabs(() => setFileTabs(readFileTabs(id)));
  }, [id]);
  /** Mark up's Reload on a card's PDF: its folder listed again for the file's
   * fresh token, size and time, which the card keeps too. */
  const refreshFileTabRow = useCallback(async (file: OutboxFile): Promise<OutboxFile | null> => {
    const tab = fileTabOpen;
    if (!tab || tab.from === "outbox") return null;
    const fresh = await listProjectFiles(id, tab.folder);
    const entry = fresh.entries.find((candidate) => candidate.kind !== "dir" && candidate.name === file.name);
    if (!entry) return null;
    refreshFileTab(id, { ...tab, token: entry.token, kind: entry.kind, size: entry.size, modified: entry.modified });
    return asViewerFile(entry);
  }, [id, fileTabOpen]);
  /** The read-only git overview (`GitSheet`), for a project scope only: a box
   * or the root console has no repo of its own. */
  const [gitOpen, setGitOpen] = useState(false);
  const screenRef = useRef<HTMLElement | null>(null);
  /** The latest `back`, for the swipe listener that outlives a render. */
  const backRef = useRef(back);
  backRef.current = back;
  /** The assistant scope is no project: Tabby is one chat, opened from Home's
   * FAB (`TabbyOpen`). A place restored or a notification that lands here on
   * it goes back to Home. */
  const assistantScope = detail?.project.kind === "assistant";
  useEffect(() => {
    if (assistantScope) backRef.current();
  }, [assistantScope]);
  /** The host has no folder to give the phone for this project (a remote one
   * before its first sync, a VM without a mirror): no files, Git or
   * send-a-file here, and one line says why. An older desktop sends no field,
   * which means it has one. */
  const folderless = detail?.folder === false;
  const filesOffered = !!detail?.files && !assistantScope && !folderless;
  /** The files drawer's remote side: a remote project's tree on its host,
   * read over the desktop's connection (`detail.host_files`). This
   * computer's file cards stay `filesOffered`'s. */
  const hostFilesOffered = !!detail?.host_files && !assistantScope;
  const gitOffered = !!detail && (detail.project.kind ?? "project") === "project" && !folderless;
  /** Whether the host's tabs attach through tmux (`detail.terminals`): on a
   * host with none (Windows) nothing can be opened, scheduled or sent to from
   * here, so the ＋ sheet keeps only its send-a-file row, each card's ◷ and
   * Mark up's Submit stay out and one line says why. An older desktop sends
   * no field, which means tmux. */
  const terminalsOffered = detail?.terminals !== "unsupported";
  /** What the phone may start here (`detail.create`, the host's verdict for
   * the project's type): everything; agents alone (a remote project's shell
   * would run on the remote host); nothing. Absent is everything. */
  const createVerdict: CreateVerdict = detail?.create ?? "all";
  const creates = terminalsOffered && createVerdict !== "none";
  /** The ＋ stays while it can still do something: start a tab, or send a file
   * into a folder. Before the host answers it is drawn (disabled). */
  const fabOffered = !detail || creates || !folderless;
  /** Whether the drawer has anything to hold, once the host has answered:
   * no ☰ and no swipe else. */
  const drawerOffered = !!detail && (outbox.length > 0 || filesOffered || hostFilesOffered || gitOffered);
  /** What a right→left swipe over a card (`data-swipe-close`) does, read at
   * the swipe: the listener below outlives the render that installed it, and
   * would otherwise close against that render's list. Set further down, once
   * the list and `close` are in hand. */
  const swipeClose = useRef<(card: HTMLElement) => boolean>(() => false);
  useEffect(() => {
    const host = screenRef.current;
    if (drawerOpen || !host) return;
    // Not from a card's grip (its drag is its own, `touch-action:none`), and
    // not through a sheet laid over the list. Left→right goes back, as the
    // header's ‹ does; right→left pulls the drawer in, from the right edge too.
    return installFocusSwipe(host, {
      onSwipeRight: () => backRef.current(),
      // A leftward drag over a card closes it (`installCardSwipe`, below), not
      // the drawer.
      onSwipeLeft: (_start, target) => { if (drawerOffered && !target?.closest("[data-swipe-close]")) setDrawerOpen(true); },
    }, { ignore: ".tab-card-grip, .sheet-backdrop, [role='dialog']", leftEdge: true, rightEdge: drawerOffered });
  }, [drawerOffered, drawerOpen]);
  useEffect(() => {
    const host = screenRef.current;
    if (drawerOpen || !host) return;
    return installCardSwipe(host, (card) => swipeClose.current(card));
  }, [drawerOpen]);
  const outboxScope = useMemo(() => ({ project: id }), [id]);
  const filesScope = useMemo(() => ({ files: id }), [id]);
  /** The pictures among them, which the full-screen viewer steps through. */
  const outboxPictures = useMemo(() => outbox.filter((file) => file.kind.startsWith("image/")), [outbox]);
  /** The cards shown: a project file's only while the desktop's files switch
   * is on, as it gates the files they read; a file the agent sent always. */
  const shownFileTabs = useMemo(() => fileTabs.filter((file) => file.from === "outbox" || filesOffered), [fileTabs, filesOffered]);
  /** Each card's marks not yet submitted, from the phone's layer store —
   * read again whenever a viewer over this screen closes. */
  const [unsentMarks, setUnsentMarks] = useState<Record<string, number>>({});
  const viewerUp = fileTabOpen !== null || fileOpen !== null || drawerOpen || galleryOpen;
  useEffect(() => {
    if (viewerUp) return;
    let live = true;
    void Promise.all(shownFileTabs.map(async (file) => {
      const stored = await loadLayer(layerKey(id, file.from === "outbox" ? { outbox: file.name } : { files: `${file.place}/${file.name}` }));
      return [fileTabKey(file), stored && stored !== "unavailable" ? markCount(stored.layer).marks : 0] as const;
    })).then((counts) => { if (live) setUnsentMarks(Object.fromEntries(counts)); });
    return () => { live = false; };
  }, [id, shownFileTabs, viewerUp]);
  /** The tab whose colour is being picked (#264), of any kind the phone lists —
   * colouring is how a row of look-alike sessions is told apart, which is as
   * true of five shells as of five agents. */
  const [colorTab, setColorTab] = useState<TabRow | null>(null);
  /** The tab whose subagent pill was tapped: its subagents are listed. */
  const [subagentsTab, setSubagentsTab] = useState<TabRow | null>(null);
  /** The tab whose ⋯ sheet is up: rename, colour, schedules, subagents and
   *  close, the actions a card no longer spends its own width on. */
  const [moreTab, setMoreTab] = useState<TabRow | null>(null);
  /** Recently closed, folded shut until asked for. */
  const [closedOpen, setClosedOpen] = useState(false);
  /** The list's two gesture hints, each gone for good once dismissed or once
   *  its gesture has been used (`prefs.ts`). */
  const [hintsGone, setHintsGone] = useState(() => ({ reorder: readFlag("projectHintReorder"), swipe: readFlag("projectHintSwipe"), hold: readFlag("projectHintHold") }));
  const dropHint = (which: "reorder" | "swipe" | "hold") => {
    setHintsGone((gone) => gone[which] ? gone : { ...gone, [which]: true });
    writeFlag(which === "reorder" ? "projectHintReorder" : which === "swipe" ? "projectHintSwipe" : "projectHintHold", true);
  };
  /** The tab whose close is in flight — its ✕ is held until the desktop answers. */
  const [closingId, setClosingId] = useState<string | null>(null);
  /** The card a swipe is closing: it slides out while the desktop answers,
   *  and back in if the close is refused. */
  const [swipedId, setSwipedId] = useState<string | null>(null);
  /** The tabs this phone has closed, each against the moment it was answered,
   *  held back from every load until the catalog agrees (`withoutClosed`). */
  const closed = useRef(new Map<string, number>());
  /** The reader's order for this project's tabs, kept on the phone. The
   * default is the desktop Agents view's, by the same shared function: a tab
   * asking something, then the ones working now, then the rest by their last
   * finished turn. A shell (or an agent with no turn this session) has no
   * reading and sinks, keeping the tab bar's order among its kind. */
  const [sort, setSort] = useState<AgentSort>(() => readChoice("projectTabsSort", isAgentSort, DEFAULT_AGENT_SORT));
  const chooseSort = (next: AgentSort) => { setSort(next); writeChoice("projectTabsSort", next); };
  /** The dropdown under the project's name, which picks the order. */
  const [sortMenu, setSortMenu] = useState(false);
  const tabs = useMemo(() => sortAgentTabs(detail?.tabs ?? [], sort, (tab) => ({
    decision: tab.agent_status === "question",
    working: tab.agent_status === "working",
    workingAt: tab.working_at,
    doneAt: lastWorkedAt(tab),
  })), [detail?.tabs, sort]);
  // A tab that ran again forgets it was seen interrupted: its next interruption
  // is news.
  useEffect(() => {
    const rows = detail?.tabs;
    if (!rows) return;
    const kept = withoutResumed(seenInterrupted, rows);
    if (kept.length === seenInterrupted.length) return;
    setSeenInterrupted(writeSeenInterrupted(kept));
  }, [detail?.tabs, seenInterrupted]);
  /** Rearranging by hand is offered under the manual order alone. The other two
   * are computed from what the agents did, so a dropped row would spring back
   * the next time one of them worked — the same rule the desktop's own drag
   * follows. */
  const canReorder = sort === "native" && tabs.length > 1;
  const pendingKeys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  /** A move the desktop has not answered yet. The poll is paused across it: the
   * list is already showing where the row was dropped, and a reply carrying the
   * pre-drop order would yank it back for a second. */
  const moving = useRef(false);
  const load = useCallback(() => {
    if (inFlight.current || moving.current) return Promise.resolve();
    inFlight.current = true;
    return api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}`)
      .then((next) => { rememberScopeKind(id, next.project.kind); setDetail(withoutClosed(next, closed.current)); setError(""); })
      // Keep the last good view rather than blanking the tab list: on a poll
      // this fast, one dropped packet used to wipe the screen and flash the
      // "Desktop unavailable" notice on every flaky-signal hiccup.
      .catch((reason) => setError(describeFailure(reason)))
      .finally(() => { inFlight.current = false; });
  }, [id]);
  useEffect(() => {
    // A 1.5s poll is a full catalog load plus a desktop round trip, 40 times a
    // minute, and it ran while the phone's screen was off.
    let timer = 0;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void load();
    };
    void load();
    timer = window.setInterval(tick, 5_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);
  /** Reads the outbox now and every `OUTBOX_POLL` while the page is visible;
   * coming back to the page reads it at once. A listing that could not be
   * fetched keeps what was shown — the next poll retries, and a missing 🖼
   * would read as "the desktop sent nothing", which is a different thing. */
  useEffect(() => {
    setOutbox([]);
    setGalleryOpen(false);
    setFileOpen(null);
    // No folder stands behind the assistant scope, so there is no outbox to read.
    if (assistantScope || isAssistantScope(id)) return;
    let stopped = false;
    let inflight: AbortController | undefined;
    const poll = () => {
      if (stopped || document.visibilityState === "hidden") return;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      void listOutbox({ project: id }, controller.signal).then(
        (files) => {
          if (stopped || controller.signal.aborted || !Array.isArray(files)) return;
          setOutbox((current) => sameOutbox(current, files) ? current : files);
        },
        () => {},
      );
    };
    poll();
    const timer = window.setInterval(poll, OUTBOX_POLL);
    document.addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      inflight?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [id, assistantScope]);
  useEffect(() => {
    if (!fileOpen && !galleryOpen) return;
    // The viewer opens over the gallery, so Escape closes the top one first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (fileOpen) setFileOpen(null);
      else setGalleryOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileOpen, galleryOpen]);
  /** A picture, a text or a PDF opens full screen here — the Focus screen's
   * gallery does the same with the same files. A PDF handed to the phone's
   * own viewer left no way back into the installed app. */
  const openFile = useCallback((file: OutboxFile) => setFileOpen(file), []);
  /** Removes one file the desktop sent, from the tile's own confirm. The row is
   * dropped here rather than by the next poll — an 8 s wait on a tile that has
   * already been answered reads as the delete not having worked — and the sheet
   * closes with the last file, where it would otherwise stand empty. */
  const removeFile = useCallback(async (file: OutboxFile) => {
    await deleteOutboxFile({ project: id }, file.name);
    setOutbox((current) => {
      const left = current.filter((row) => row.name !== file.name);
      if (left.length === 0) setGalleryOpen(false);
      return left;
    });
    setFileOpen((open) => open?.name === file.name ? null : open);
  }, [id]);
  /** The gallery's Delete all: the project's whole outbox goes, to free the
   * space, and the sheet closes over the empty list. */
  const removeAllFiles = useCallback(async () => {
    await clearOutbox({ project: id });
    setOutbox([]);
    setGalleryOpen(false);
    setFileOpen(null);
  }, [id]);
  /** The desktop's tabs as last listed, for `markupNewTab`'s `linked`: read
   * at a markup view's opening, so a poll does not rebuild the prop. */
  const tabRows = useRef<TabRow[]>([]);
  tabRows.current = detail?.tabs ?? [];
  /** Mark up from here has no chat to send to: its Submit opens a new tab of
   * the desktop's default agent, which its Open tab shows — offered once
   * there is one. A file whose card names an agent tab still open sends
   * there instead (`linked`). */
  const markupNewTab = useMemo<MarkupNewTab | undefined>(
    () => detail?.agents.length && creates ? {
      projectId: id,
      // The tab opens with the view tucked away under its bar: the way back.
      show: (tab: TabRow, markupBack?: MarkupBack) => terminal(tab, { markupBack }),
      linked: (file) => {
        const tabId = findFileTab(id, file)?.tab;
        // Never a tab on the remote host: it cannot read the marked pages.
        return tabId ? tabRows.current.find((row) => row.id === tabId && row.kind === "agent" && !row.on_host) : undefined;
      },
    } : undefined,
    [detail?.agents.length, creates, id, terminal],
  );
  const create = async (kind: "shell" | "agent", agent?: AgentRow, mode?: string, launch?: NewTabLaunch) => {
    setCreating(true); setError("");
    const action = `${kind}:${agent?.id ?? ""}:${mode ?? ""}:${launch?.worktree ?? ""}:${launch?.cloud ?? ""}:${launch?.task ?? ""}:${launch?.sign_in ?? ""}:${launch?.local ?? ""}:${launch?.api_key ? "api" : ""}`;
    const idempotencyKey = pendingKeys.current.get(action) ?? crypto.randomUUID();
    pendingKeys.current.set(action, idempotencyKey);
    try {
      const body = await api<{ tab: TabRow }>(`/api/v1/projects/${encodeURIComponent(id)}/tabs`, { method: "POST", body: JSON.stringify({ project_id: id, kind, agent_id: agent?.id, mode, ...launch, idempotency_key: idempotencyKey }) }, TAB_CREATE_TIMEOUT);
      pendingKeys.current.delete(action);
      terminal(body.tab, launch?.sign_in ? { signIn: true } : undefined);
    } catch (reason) { setError(describeFailure(reason)); void load(); } finally { setCreating(false); }
  };
  /** A tap on ＋ starts the default agent here at once (`newTabDefault.ts`);
   * a hold opens the sheet of every choice, which is also where the default
   * is starred. With no agent to start — a host without tmux, a desktop
   * listing none — the tap opens that sheet as before. */
  const quickAgent = creates ? newTabAgent(detail?.agents ?? [], starredAgent) : undefined;
  const fabPress = useTapHold(
    () => { if (!quickAgent) setNewTabOpen(true); else if (!creating) void create("agent", quickAgent); },
    () => { dropHint("hold"); setNewTabOpen(true); },
  );
  /** The tab being started, by tab id: an agent tab the desktop is
   * restarting so the phone can attach to it. */
  const [startingId, setStartingId] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  /** Ask the desktop to start one tab, then wait for its session to be live —
   * the catalog's `available` — and open it. The wait is the desktop starting
   * a CLI: seconds, not a poll cycle, so it reads the list itself each second.
   *
   * This is an agent tab that was already running
   * when the project's Mobile switch went on: it runs outside tmux, which the
   * phone attaches through, so the desktop restarts it on its resume args
   * inside its tmux session (`MobileBridgeHost`'s `wrapAgentTabForPhone`), or
   * says why not — busy, not resumable, or simply gone. */
  const startTab = async (tab: TabRow) => {
    setStartingId(tab.id); setError("");
    try {
      const started = await api<{ desktop_available?: boolean }>(`/api/v1/projects/${encodeURIComponent(id)}/activate?tab=${encodeURIComponent(tab.id)}`, { method: "POST" });
      // No window: nothing is left running outside tmux to bring back.
      if (started.desktop_available === false) throw new ApiError(410, "session_gone");
      for (let attempt = 0; attempt < CHAT_START_TRIES && alive.current; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        if (!alive.current) return;
        const next = await api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}`);
        setDetail(withoutClosed(next, closed.current));
        const row = next.tabs.find((candidate) => candidate.id === tab.id);
        if (row?.available) { terminal(row); return; }
      }
      setError(t("mobile.project.restartFailed"));
    } catch (reason) { if (alive.current) setError(describeFailure(reason)); } finally { if (alive.current) setStartingId(null); }
  };
  /** Drop the row here rather than reloading, and remember that it is gone: the
   *  next catalog read can still be carrying the tab that was just closed — the
   *  poll in flight when the ✕ was pressed certainly is — and a row dropped from
   *  the list in hand alone springs back with it (`withoutClosed`). */
  const dropTab = (id: string) => {
    closed.current.set(id, Date.now());
    setDetail((prev) => prev ? { ...prev, tabs: prev.tabs.filter((row) => row.id !== id) } : prev);
  };
  /** Close on the tap, as the desktop's × does — no sheet in between. It is the
   *  same act on both surfaces, through the same desktop seam: the tab leaves
   *  the Tabtivity window and the local tmux session it minted ends with it (a
   *  session on a remote host keeps running). */
  const close = async (tab: TabRow) => {
    setClosingId(tab.id);
    setError("");
    try {
      await closeTab(tab.id);
      dropTab(tab.id);
      // The desktop now lists it under Recently closed; show that row at once.
      if (tab.kind === "agent") void load();
    } catch (cause) {
      setError(cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
        ? t("mobile.project.closeNeedsDesktop")
        : t("mobile.project.closeFailed"));
    } finally {
      setClosingId(null);
    }
  };
  /** A swipe closes the card it ran over, as its ✕ would: a session through
   *  the desktop (held while another close is in flight, as the ✕ is), a
   *  phone-side PDF card at once. */
  swipeClose.current = (card) => {
    const key = card.getAttribute("data-swipe-close");
    const tab = tabs.find((row) => row.id === key);
    dropHint("swipe");
    if (tab) {
      if (closingId !== null) return false;
      pinHeight(card);
      setSwipedId(tab.id);
      // The card leaves the list when the close lands, so let the exit play first.
      void new Promise((done) => window.setTimeout(done, SWIPE_OUT_MS)).then(() => close(tab)).finally(() => { setSwipedId(null); unpinHeight(card); });
      return true;
    }
    const file = shownFileTabs.find((row) => fileTabKey(row) === key);
    if (file) {
      // Nothing to ask the desktop: let the card go out, then forget it.
      pinHeight(card);
      setSwipedId(fileTabKey(file));
      window.setTimeout(() => { closeFileTab(id, file); setSwipedId(null); }, SWIPE_OUT_MS);
      return true;
    }
    return false;
  };
  /** The closed tab whose reopen is in flight. */
  const [reopeningId, setReopeningId] = useState<string | null>(null);
  /** Reopen a closed agent tab on the desktop — back in its place there, on
   *  its conversation — and put its card back here. */
  const reopen = async (closedTab: ClosedTabRow) => {
    setReopeningId(closedTab.id);
    setError("");
    try {
      const body = await reopenTab(id, closedTab.id);
      closed.current.delete(body.tab.id);
      setDetail((prev) => prev ? {
        ...prev,
        tabs: prev.tabs.some((row) => row.id === body.tab.id) ? prev.tabs : [...prev.tabs, body.tab],
        closed: (prev.closed ?? []).filter((row) => row.id !== closedTab.id),
      } : prev);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === "nothing_to_reopen"
        ? t("mobile.project.reopenGone")
        : cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
          ? t("mobile.project.reopenFailed")
          : describeFailure(cause));
      void load();
    } finally {
      setReopeningId(null);
    }
  };
  /** Move one tab beside another and tell the desktop, which owns the layout
   *  this order is. The list is rearranged first — a drop that waits for a
   *  round trip before it moves anything reads as a dropped gesture — and then
   *  reconciled with the order the desktop answers with; a refused move puts
   *  the row back where it was and says why. */
  const commitMove = async (key: string, anchorId: string, place: TabPlace) => {
    const before = (detail?.tabs ?? []).map((row) => row.id);
    setDetail((prev) => prev ? { ...prev, tabs: placeBeside(prev.tabs, (row) => row.id, key, anchorId, place) } : prev);
    moving.current = true;
    setError("");
    dropHint("reorder");
    try {
      const answer = await reorderTab(key, anchorId, place);
      setDetail((prev) => prev ? { ...prev, tabs: applyServerOrder(prev.tabs, (row) => row.id, answer.tabs ?? []) } : prev);
    } catch (cause) {
      setDetail((prev) => prev ? { ...prev, tabs: applyServerOrder(prev.tabs, (row) => row.id, before) } : prev);
      setError(cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
        ? t("mobile.project.moveNeedsDesktop")
        : t("mobile.project.moveFailed"));
    } finally {
      moving.current = false;
    }
  };

  /** The gesture around that move — the captured pointer, the edge scrolling and
   *  the arrow keys — which the home screen's project cards wear too
   *  (`rowDrag.ts`). Under the computed orders the grips are not drawn at all;
   *  `canReorder` also makes them inert, so a stale one cannot move a row that
   *  the next agent's turn would spring back. */
  const drag = useRowDrag(tabs.map((row) => row.id), (key, anchorId, place) => void commitMove(key, anchorId, place), canReorder);

  const activate = async () => {
    setActivating(true); setError("");
    try {
      await api(`/api/v1/projects/${encodeURIComponent(id)}/activate`, { method: "POST" });
      void load();
    } catch (reason) { setError(describeFailure(reason)); void load(); } finally { setActivating(false); }
  };
  /** What the ⋯ sheet's row does: each opens the sheet the card's own
   *  control used to, or closes the tab as ✕ does. */
  const runAction = (tab: TabRow, action: TabAction) => {
    setMoreTab(null);
    if (action === "rename") setRenameTab(tab);
    else if (action === "color") setColorTab(tab);
    else if (action === "schedule") setScheduleTab({ tab });
    else if (action === "subagents") setSubagentsTab(tab);
    else void close(tab);
  };
  /** Opening a finished tab is reading what it finished: Home's Needs you
   *  stops listing it (`seenDone.ts`). */
  const openTab = (tab: TabRow) => {
    if (tab.agent_status === "done") setSeenDone(markDoneSeen(tab.id, tab.done_at));
    if (tab.agent_status === "interrupted") setSeenInterrupted(markInterruptedSeen(tab.id));
    terminal(tab);
  };
  const projectName = detail?.project.label ?? t("mobile.project.fallbackName");
  // A reopen starts a tab, which a project the phone cannot start tabs in refuses.
  const closedRows = createVerdict === "none" ? [] : detail?.closed ?? [];
  const showReorderHint = canReorder && !hintsGone.reorder;
  const showSwipeHint = tabs.length > 0 && !hintsGone.swipe;
  // Only while a tap starts one agent: the sheet of the others sits behind a hold.
  const showHoldHint = !!quickAgent && tabs.length > 0 && !hintsGone.hold;
  return <main className="screen project-screen" ref={screenRef}>
    {/* One dense row, shaped like an agent tab's header: chevron, the name
        (ellipsized) with the order it sorts by under it, then the drawer's ☰
        — so the name keeps the rest. Sticky, so the way back and the menu
        stay in reach down a long list.

        The name is the order's dropdown, with the Focus switch's caret: the
        same three orders the desktop Agents view offers, remembered per phone.
        "Manual" is this screen's name for the arrival order, because here that
        order is the desktop's own tab order — the one a drag writes into. Plain
        text while there is only one tab to order. */}
    <header className="project-header">
      <button className="back" onClick={back} aria-label={t("common.back")} title={t("common.back")}>‹</button>
      <div className="terminal-title">{tabs.length > 1
        ? <><h1><button
          className="project-title"
          onClick={() => setSortMenu((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={sortMenu}
          title={t("mobile.project.sortAria")}
        ><span>{projectName}</span><span className="view-caret" aria-hidden="true" /></button></h1>
          <small>{t("mobile.project.sortedBy", { order: t(SORT_LABEL[sort]) })}</small></>
        : <h1>{projectName}</h1>}</div>
      <div className="project-header-tools">
        {/* What this project has besides its tabs — the agent's files (the
            🖼 the Focus screen carries), Git and the file browser — lives in
            the drawer a right→left swipe also pulls in. */}
        {drawerOffered && <button
          className="drawer-open"
          onClick={() => setDrawerOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          aria-label={t("mobile.project.menu")}
          title={t("mobile.project.menu")}
        ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>}
      </div>
    </header>
    {sortMenu && tabs.length > 1 && <div className="focus-menu-backdrop" role="presentation" onClick={() => setSortMenu(false)}>
      <div className="focus-menu project-menu" role="menu" aria-label={t("mobile.project.sortAria")} onClick={(event) => event.stopPropagation()}>
        {AGENT_SORTS.map((value) => <button key={value} role="menuitemradio" aria-checked={sort === value} onClick={() => { chooseSort(value); setSortMenu(false); }}>
          <span><strong>{t(SORT_LABEL[value])}</strong></span>
          {sort === value && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
        </button>)}
        {isUntested("mobile.project.sortMenu") && <p className="project-menu-note"><span className="untested">{t("mobile.newTab.untested")}</span></p>}
      </div>
    </div>}
    {gitOpen && detail && <GitSheet projectId={id} label={detail.project.label} onClose={() => setGitOpen(false)} />}
    {/* Only once the host has answered: `!detail?.desktop_available` was also
        true while the first load was in flight, so every project opened on a
        "Desktop unavailable" notice that vanished a moment later. */}
    {detail && !detail.desktop_available && <p className="notice">{t("mobile.project.desktopUnavailable")} {isUntested("mobile.headless.tabs") && <span className="untested">{t("mobile.newTab.untested")}</span>}</p>}
    {/* The host has no tmux (Windows): its tabs never reach a phone, so the
        controls that would open, schedule or send to one are not offered. */}
    {!terminalsOffered && <p className="notice">{t("mobile.project.terminalsUnsupported")} {isUntested("mobile.project.terminalsUnsupported") && <span className="untested">{t("mobile.newTab.untested")}</span>}</p>}
    {/* Where the project runs, when that limits the phone: a remote project's
        agents are the ones on this computer, and a container's or VM's tabs are
        not on the phone yet. A project with no folder to give says so too —
        the files, Git and send-a-file entries are gone, and the reader should
        not have to wonder why. */}
    {detail && (HOST_NOTE[detail.project.host ?? "local"] || folderless) && <p className="notice">{[
      HOST_NOTE[detail.project.host ?? "local"],
      folderless ? (hostFilesOffered ? "mobile.project.noFolderRemoteHost" : NO_FOLDER_NOTE[detail.project.host ?? "local"]) : undefined,
    ].flatMap((key) => key ? [t(key)] : []).join(" ")} {isUntested("mobile-every-project-type") && <span className="untested">{t("mobile.newTab.untested")}</span>}</p>}
    {error && <p className="error">{error}</p>}
    {projectInbox.view}
    {/* An inactive project is activated before anything else here is worth
        doing, so the button leads the list rather than trailing it. */}
    {detail?.project.status === "inactive" && <div className="project-activate"><button className="primary" disabled={activating} onClick={() => void activate()}>{t("mobile.project.activate")}</button></div>}
    {/* No tabs: say so once and point at the ＋ below, rather than drawing a
        second button that does the same. */}
    {detail && tabs.length === 0 && shownFileTabs.length === 0 && <div className="project-empty">
      <span className="project-empty-glyph" aria-hidden="true">▭</span>
      <strong>{t("mobile.project.emptyTitle")}</strong>
      <p>{t(!fabOffered ? "mobile.project.emptyHintNone" : !creates ? "mobile.project.emptyHintFiles" : createVerdict === "agents" ? "mobile.project.emptyHintAgents" : "mobile.project.emptyHint")}</p>
    </div>}
    <section className="cards">{tabs.map((tab) => <TabCard
      key={tab.id}
      tab={tab}
      statusShown={showsStatusBadge(seenDone, seenInterrupted, tab)}
      drag={drag}
      canReorder={canReorder}
      schedulesOffered={schedulesOffered(tab, terminalsOffered, detail?.desktop_available)}
      restart={terminalsOffered && tab.kind === "agent" && !tab.on_host ? { busy: startingId !== null, starting: startingId === tab.id } : undefined}
      swiped={swipedId === tab.id}
      closing={closingId !== null}
      moreOpen={moreTab?.id === tab.id}
      scheduleOpen={scheduleTab?.tab.id === tab.id}
      onOpen={() => (!tab.available && terminalsOffered && tab.kind === "agent" && !tab.on_host ? void startTab(tab) : openTab(tab))}
      onModel={() => terminal(tab, { pickModel: true })}
      onMore={() => setMoreTab(tab)}
      onSchedule={() => setScheduleTab({ tab })}
      onSubagents={() => setSubagentsTab(tab)}
      onClose={() => void close(tab)}
    />)}
    {/* The PDFs opened from the file drawer, after the sessions: the phone's
        own cards, so the desktop opens nothing and ✕ only forgets one. The
        drawer's switch gates them, as it gates the files they read. */}
    {shownFileTabs.map((file) => <FileTabCard
      key={fileTabKey(file)}
      file={file}
      swipeKey={fileTabKey(file)}
      swiped={swipedId === fileTabKey(file)}
      unsent={unsentMarks[fileTabKey(file)] ?? 0}
      linked={file.tab ? tabs.find((row) => row.id === file.tab && row.kind === "agent") : undefined}
      onOpen={() => setFileTabOpen(file)}
      onForget={() => closeFileTab(id, file)}
    />)}</section>
    {/* The list's gestures, said once under it in one muted line: gone for
        good once dismissed, and each half once its gesture has been used. */}
    {(showReorderHint || showSwipeHint || showHoldHint) && <p className="project-hint">
      <span>
        {showReorderHint && <><GripHint text={t("mobile.project.reorderHint")} /> {isUntested("mobile.project.reorder") && <span className="untested">{t("mobile.newTab.untested")}</span>} </>}
        {showSwipeHint && <>{t("mobile.project.swipeCloseHint")}{isUntested("mobile.project.swipeClose") && <span className="untested">{t("mobile.newTab.untested")}</span>} </>}
        {showHoldHint && <>{t("mobile.project.fabHoldHint", { agent: quickAgent?.label ?? "" })}{isUntested("mobile.project.fabHoldHint") && <span className="untested">{t("mobile.newTab.untested")}</span>}</>}
        {isUntested("mobile.project.hintDismiss") && <span className="untested">{t("mobile.newTab.untested")}</span>}
      </span>
      <button onClick={() => { if (showReorderHint) dropHint("reorder"); if (showSwipeHint) dropHint("swipe"); if (showHoldHint) dropHint("hold"); }} aria-label={t("mobile.project.hintDismiss")} title={t("mobile.project.hintDismiss")}><span aria-hidden="true">×</span></button>
    </p>}
    <div className="project-foot">
      {/* Agent tabs closed on either surface, newest first, folded under one
          row: a tap reopens one on the desktop, resuming its conversation,
          and its card comes back. */}
      {closedRows.length > 0 && <section className="project-closed" aria-label={t("mobile.project.recentlyClosed")}>
        <button className="project-foot-row" aria-expanded={closedOpen} onClick={() => setClosedOpen((open) => !open)}>
          <span aria-hidden="true" className="project-foot-icon">↺</span>
          <span>{t("mobile.project.recentlyClosedCount", { count: closedRows.length })}{isUntested("mobile.project.reopenClosed") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>
          <svg className="project-foot-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
        {closedOpen && closedRows.map((row) => <button
          key={row.id}
          className={reopeningId === row.id ? "project-closed-row reopening" : "project-closed-row"}
          disabled={reopeningId !== null}
          aria-busy={reopeningId === row.id}
          onClick={() => void reopen(row)}
          aria-label={t("mobile.project.reopenHint", { label: row.label })}
          title={t("mobile.project.reopenHint", { label: row.label })}
        >{reopeningId === row.id
          ? <><span className="transcript-working-dots" aria-hidden="true"><i /><i /><i /></span> {t("mobile.project.reopening", { label: row.label })}{isUntested("mobile.project.reopening") && <span className="untested">{t("mobile.newTab.untested")}</span>}</>
          : <>{row.label}</>}</button>)}
      </section>}
      <button className="project-foot-row" disabled={!detail} onClick={() => setPromptsOpen(true)} aria-haspopup="dialog" aria-expanded={promptsOpen}>◷ {t("agentPrompts.heading")}<svg className="project-foot-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button>
    </div>
    {/* Opening a session is what this screen is for, so it rides above the
        list where the thumb already is, rather than in the header's corner
        (`NewTabSheet`). It opens without the desktop too: sending a file from
        the phone needs only this host, and the sheet holds its create buttons
        instead — the notice above says why. On a host with no tmux it stays
        for that file row alone, and is named after it. */}
    {fabOffered && <button
      className="primary fab fab-round"
      disabled={!detail}
      {...fabPress}
      aria-haspopup="dialog"
      aria-expanded={newTabOpen}
      aria-busy={creating}
      aria-label={t(creates ? "mobile.newTab.title" : "mobile.projectInbox.send")}
      title={quickAgent ? t("mobile.project.fabQuick", { agent: quickAgent.label }) : t(creates ? "mobile.project.newTabTitle" : "mobile.projectInbox.send")}
    ><span aria-hidden="true" className="fab-plus">＋</span>{(isUntested("mobile.project.fab") || (quickAgent && isUntested("mobile.project.fabQuick"))) && <span className="untested" aria-hidden="true">{t("mobile.newTab.untested")}</span>}</button>}
    {moreTab && <OptionSheet
      title={moreTab.label}
      waiting=""
      busy={false}
      onClose={() => setMoreTab(null)}
      options={tabActions(moreTab, schedulesOffered(moreTab, terminalsOffered, detail?.desktop_available)).map((action) => ({ key: action, label: t(TAB_ACTION_LABEL[action]), current: false }))}
      onPick={(key) => { const action = tabActions(moreTab, schedulesOffered(moreTab, terminalsOffered, detail?.desktop_available)).find((row) => row === key); if (action) runAction(moreTab, action); }}
    >{isUntested("mobile.project.cardMenu") && <p className="sheet-note"><span className="untested">{t("mobile.newTab.untested")}</span></p>}</OptionSheet>}
    {newTabOpen && detail && <NewTabSheet
      projectId={id}
      agents={detail.agents}
      shells={detail.shells === true && createVerdict === "all"}
      busy={creating}
      headless={!detail.desktop_available}
      creates={creates}
      agentsOnly={createVerdict === "agents"}
      defaultAgent={quickAgent?.id}
      onDefault={(agent) => { writeNewTabAgent(agent.id); setStarredAgent(agent.id); }}
      onClose={() => setNewTabOpen(false)}
      onPick={(kind, agent, mode, launch) => { setNewTabOpen(false); void create(kind, agent, mode, launch); }}
      onSendFile={() => { projectInbox.open(); setNewTabOpen(false); }}
    />}
    {subagentsTab && <SubagentsSheet tab={subagentsTab} onClose={() => setSubagentsTab(null)} onOpen={(step) => { const row = subagentsTab; setSubagentsTab(null); terminal(row, { subagent: step }); }} />}
    {/* A send-now is a one-time schedule: with no window, not to a tab on
        the remote host (`schedulesOffered`). */}
    {promptsOpen && detail && <PromptsSheet projectId={id} tabs={detail.desktop_available === false ? detail.tabs.filter((tab) => !tab.on_host) : detail.tabs} onClose={() => setPromptsOpen(false)} onSchedule={terminalsOffered ? (tab, initialMessage) => { setPromptsOpen(false); setScheduleTab({ tab, initialMessage }); } : undefined} />}
    {colorTab && <ColorSheet
      tab={colorTab}
      onClose={() => setColorTab(null)}
      onColored={(color) => {
        // Patch the row in place rather than reloading. The desktop persists its
        // tab layout asynchronously, so the next catalog read can still carry
        // the old colour and the card would flicker back — the same reason
        // `dropTab` above patches instead of reloading after a close.
        setColorTab((prev) => prev ? { ...prev, color } : prev);
        setDetail((prev) => prev
          ? { ...prev, tabs: prev.tabs.map((row) => row.id === colorTab.id ? { ...row, color } : row) }
          : prev);
      }}
    />}
    {renameTab && <RenameSheet tab={renameTab} onClose={() => setRenameTab(null)} onRenamed={() => { setRenameTab(null); void load(); }} />}
    {scheduleTab && <ScheduleSheet tabId={scheduleTab.tab.id} label={scheduleTab.tab.label} initialMessage={scheduleTab.initialMessage} onClose={() => setScheduleTab(null)} />}
    {/* The viewer covers the phone; the gallery stays open behind it, so
        closing the file comes back to the list it was opened from. */}
    {galleryOpen && !fileOpen && <OutboxGallery scope={outboxScope} files={outbox} onOpen={openFile} onDetails={setFileOpen} onDelete={removeFile} onDeleteAll={removeAllFiles} onClose={() => setGalleryOpen(false)} />}
    {drawerOpen && detail && <ProjectFiles key={id} projectId={id} label={detail.project.label} onClose={() => setDrawerOpen(false)}
      browse={filesOffered || hostFilesOffered} here={filesOffered} host={hostFilesOffered} showTab={markupNewTab?.show} linked={markupNewTab?.linked} menu={(outbox.length > 0 || gitOffered) ? <div className="option-list drawer-menu" role="menu" aria-label={t("mobile.project.menu")}>
        {outbox.length > 0 && <button
          role="menuitem"
          aria-label={t("mobile.outbox.galleryOpen", { count: outbox.length })}
          onClick={() => { setDrawerOpen(false); setGalleryOpen(true); }}
        ><span aria-hidden="true" className="project-menu-icon"><FileImageIcon /></span><span><strong>{t("mobile.outbox.region")}</strong></span><small className="project-menu-count">{outbox.length}</small></button>}
        {gitOffered && <button
          role="menuitem"
          onClick={() => { setDrawerOpen(false); setGitOpen(true); }}
        ><span aria-hidden="true" className="project-menu-icon">⎇</span><span><strong>{t("mobile.gitSheet.menu")}</strong>{isUntested("mobile.project.gitOverview") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span></button>}
        {isUntested("mobile.project.drawerMenu") && <p className="project-menu-note"><span className="untested">{t("mobile.newTab.untested")}</span></p>}
      </div> : undefined} />}
    {/* A card's file: a picture opens in Mark up — its card is a markup under
        way — and a PDF as the phone's "PDFs open in" says. */}
    {fileTabOpen && (fileTabOpen.from === "outbox" || filesOffered) && <OutboxViewer key={`${id}/${fileTabKey(fileTabOpen)}`}
      scope={fileTabOpen.from === "outbox" ? outboxScope : filesScope} file={cardViewerFile(fileTabOpen, outbox)} onClose={() => setFileTabOpen(null)}
      startMarking={fileTabOpen.kind.startsWith("image/")}
      newTab={markupNewTab && (fileTabOpen.from === "outbox" ? markupNewTab
        : { ...markupNewTab, place: fileTabOpen.place, folder: fileTabOpen.folder, refresh: refreshFileTabRow })} />}
    {fileOpen && <OutboxViewer key={`${id}/${fileOpen.name}`} scope={outboxScope} file={fileOpen} pictures={outboxPictures} onStep={setFileOpen} onClose={() => setFileOpen(null)}
      newTab={markupNewTab} />}
  </main>;
}
