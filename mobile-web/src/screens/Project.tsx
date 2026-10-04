import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_SORTS, DEFAULT_AGENT_SORT, isAgentSort, sortAgentTabs, type AgentSort } from "../../../shared/agentSort";
import { promptClock, promptLines, promptsFromTranscript, scheduleClock } from "../agentPrompts";
import { ApiError, TAB_CREATE_TIMEOUT, api, closeTab, deleteOutboxFile, listOutbox, reopenTab, reorderTab, type AgentRow, type ClosedTabRow, type OutboxFile, type ProjectDetail, type TabPlace, type TabRow, type TabSchedules } from "../api";
import { GitSheet } from "./GitSheet";
import { OUTBOX_POLL, sameOutbox } from "../outbox";
import { readChoice, writeChoice } from "../prefs";
import { useRowDrag } from "../rowDrag";
import { applyServerOrder, placeBeside } from "../tabReorder";
import { ColorSheet } from "./ColorSheet";
import { NewTabSheet, type NewTabLaunch } from "./NewTabSheet";
import { useProjectInbox } from "../components/ProjectInbox";
import { PromptsSheet } from "./PromptsSheet";
import { RenameSheet } from "./RenameSheet";
import { ScheduleSheet } from "./ScheduleSheet";
import { AgentStatusMark } from "../components/AgentStatusPill";
import { AgentModeMarks, SubagentCount, WorktreeMark, agentModeClass } from "../components/AgentModeMarks";
import { OutboxGallery } from "../components/OutboxGallery";
import { OutboxViewer, type MarkupNewTab } from "../components/OutboxViewer";
import { ProjectFiles } from "../components/ProjectFiles";
import { tabColorCss } from "../tabColors";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { GripHint } from "./Home";
import { isUntested } from "../../../src/lib/untested";
import { describeFailure } from "../connection";
import { installFocusSwipe } from "../terminal/focusSwipe";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

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

/** The line under an agent tab, in the words the desktop's Agents view uses:
 * how many prompts are scheduled and when the first one fires. The desktop
 * computed both against its own clock, so the phone only formats them. A tab
 * with none — or a desktop that did not say — gets no line at all: the ◷
 * beside the model is always there to add one. */
function scheduleLine(schedules: TabSchedules | undefined, t: Translate): string | null {
  if (!schedules || schedules.total === 0) return null;
  const count = schedules.enabled === schedules.total
    ? t("mobile.project.scheduledCount", { count: schedules.total })
    : t("mobile.project.scheduledSome", { enabled: schedules.enabled, total: schedules.total });
  // Desktop-local wall clock, year trimmed: the sheet below spells out the
  // time zone this belongs to.
  return `${count} · ${schedules.next ? t("mobile.project.nextRun", { when: schedules.next.slice(5).replace("T", " ") }) : t("mobile.project.noNextRun")}`;
}

/**
 * What this session was last asked, on the card itself.
 *
 * Always open, and never a disclosure: the question a project screen is opened
 * with is "which of these five tabs is the one I set on the docs" — a label
 * like "claude 3" cannot answer it, and an expander answers it one tap at a
 * time. The newest prompt leads and is given room to wrap; the ones behind it
 * are one line each, enough to recognize a session by its recent history
 * without turning the card into a transcript (the Focus view is that).
 *
 * The prompts still to come lead the list: the soonest scheduled ones, each
 * behind a ◷ and the desktop time it fires, so the list reads from what is
 * next down to what was asked last.
 */
function PromptLines({ tab }: { tab: TabRow }) {
  const t = useT();
  const lines = promptLines(tab);
  const scheduled = tab.schedules?.upcoming ?? [];
  return <div className="tab-card-prompts">
    <small className="tab-card-prompts-label">{t("mobile.project.lastPrompts")}</small>
    {scheduled.map((prompt, index) => {
      const when = prompt.at ? scheduleClock(prompt.at) : "";
      return <p className="tab-card-prompt scheduled" key={`scheduled-${prompt.at ?? ""}-${index}`} title={when ? t("mobile.project.scheduledAt", { at: when }) : undefined}>
        <span className="tab-card-prompt-when"><span aria-hidden="true">◷</span> {when}</span>
        <span className="tab-card-prompt-text">{prompt.text}</span>
      </p>;
    })}
    {lines.length === 0
      ? <p className="tab-card-prompt empty">{promptsFromTranscript(tab)
        ? t("mobile.project.noPromptsRead")
        : t("mobile.project.openCodeHistory")}</p>
      : lines.map((prompt, index) => {
        const when = promptClock(prompt.at);
        return <p className={index === 0 ? "tab-card-prompt latest" : "tab-card-prompt"} key={`${prompt.at ?? ""}-${index}`}>
          {when && <span className="tab-card-prompt-when">{when}</span>}
          <span className="tab-card-prompt-text">{prompt.text}</span>
        </p>;
      })}
  </div>;
}

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

export function Project({ id, back, terminal }: { id: string; back: () => void; terminal: (tab: TabRow, opts?: { pickModel?: boolean; signIn?: boolean }) => void }) {
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
  /** The read-only file browser, a drawer a left→right swipe over the screen
   * slides in from the left, there when the desktop's "Project files on the
   * phone" switch is on (`detail.files`); the name's dropdown opens it too. */
  const [filesOpen, setFilesOpen] = useState(false);
  /** The dropdown under the project's name (the gallery, the file drawer). */
  const [projectMenu, setProjectMenu] = useState(false);
  /** The read-only git overview (`GitSheet`), for a project scope only: a box
   * or the root console has no repo of its own. */
  const [gitOpen, setGitOpen] = useState(false);
  const screenRef = useRef<HTMLElement | null>(null);
  const filesOffered = !!detail?.files;
  const gitOffered = !!detail && (detail.project.kind ?? "project") === "project";
  const projectMenuOffered = outbox.length > 0 || filesOffered || gitOffered;
  useEffect(() => {
    const host = screenRef.current;
    if (!filesOffered || filesOpen || !host) return;
    // Not from a card's grip (its drag is its own, `touch-action:none`), and
    // not through a sheet laid over the list.
    return installFocusSwipe(host, { onSwipeRight: () => setFilesOpen(true), onSwipeLeft: () => {} }, { ignore: ".tab-card-grip, .sheet-backdrop, [role='dialog']", leftEdge: true });
  }, [filesOffered, filesOpen]);
  const outboxScope = useMemo(() => ({ project: id }), [id]);
  /** The pictures among them, which the full-screen viewer steps through. */
  const outboxPictures = useMemo(() => outbox.filter((file) => file.kind.startsWith("image/")), [outbox]);
  /** The tab whose colour is being picked (#264), of any kind the phone lists —
   * colouring is how a row of look-alike sessions is told apart, which is as
   * true of five shells as of five agents. */
  const [colorTab, setColorTab] = useState<TabRow | null>(null);
  /** The tab whose ✕ was pressed. The sheet asks before anything is closed: the
   *  button sits a thumb-width from the one that opens the terminal, and the
   *  answer is worth reading — closing leaves the session running. */
  /** The tab whose close is in flight — its ✕ is held until the desktop answers. */
  const [closingId, setClosingId] = useState<string | null>(null);
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
  const tabs = useMemo(() => sortAgentTabs(detail?.tabs ?? [], sort, (tab) => ({
    decision: tab.agent_status === "question",
    working: tab.agent_status === "working",
    workingAt: tab.working_at,
    doneAt: tab.done_at,
  })), [detail?.tabs, sort]);
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
      .then((next) => { setDetail(withoutClosed(next, closed.current)); setError(""); })
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
  }, [id]);
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
  /** Mark up from here has no chat to send to: its Submit opens a new tab of
   * the desktop's default agent and shows it — offered once there is one. */
  const markupNewTab = useMemo<MarkupNewTab | undefined>(
    () => detail?.agents.length ? { projectId: id, show: (tab: TabRow) => terminal(tab) } : undefined,
    [detail?.agents.length, id, terminal],
  );
  const create = async (kind: "shell" | "agent", agent?: AgentRow, mode?: string, launch?: NewTabLaunch) => {
    setCreating(true); setError("");
    const action = `${kind}:${agent?.id ?? ""}:${mode ?? ""}:${launch?.worktree ?? ""}:${launch?.cloud ?? ""}:${launch?.task ?? ""}:${launch?.sign_in ?? ""}:${launch?.local ?? ""}`;
    const idempotencyKey = pendingKeys.current.get(action) ?? crypto.randomUUID();
    pendingKeys.current.set(action, idempotencyKey);
    try {
      const body = await api<{ tab: TabRow }>(`/api/v1/projects/${encodeURIComponent(id)}/tabs`, { method: "POST", body: JSON.stringify({ project_id: id, kind, agent_id: agent?.id, mode, ...launch, idempotency_key: idempotencyKey }) }, TAB_CREATE_TIMEOUT);
      pendingKeys.current.delete(action);
      terminal(body.tab, launch?.sign_in ? { signIn: true } : undefined);
    } catch (reason) { setError(describeFailure(reason)); void load(); } finally { setCreating(false); }
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
  return <main className="screen project-screen" ref={screenRef}>
    {/* One dense row, shaped like an agent tab's header: chevron, the name
        (ellipsized), then this list's own controls kept compact — the order
        select at view-switch size and a small ＋ — so the name keeps the rest.

        The same three orders the desktop Agents view offers, remembered per
        phone. "Manual" is this screen's name for the arrival order, because here
        that order is the desktop's own tab order — the one a drag writes into. */}
    <header className="project-header">
      <button className="back" onClick={back}>‹</button>
      {/* The name opens what this project has besides its tabs — the agent's
          files (the 🖼 the Focus screen carries) and the file drawer a swipe
          also opens — so the row keeps only the order and ＋. Plain text while
          there is nothing to offer. */}
      <div className="terminal-title"><h1>{projectMenuOffered
        ? <button
          className="project-title"
          onClick={() => setProjectMenu((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={projectMenu}
          title={t("mobile.project.menu")}
        ><span>{detail?.project.label ?? t("mobile.project.fallbackName")}</span><span className="view-caret" aria-hidden="true" /></button>
        : detail?.project.label ?? t("mobile.project.fallbackName")}</h1></div>
      <div className="project-header-tools">
        {tabs.length > 1 && <label className="activity-sort in-header">
          <span>{t("agentPrompts.sort.label")}</span>
          <select aria-label={t("mobile.project.sortAria")} value={sort} onChange={(event) => { if (isAgentSort(event.target.value)) chooseSort(event.target.value); }}>
            {AGENT_SORTS.map((value) => <option key={value} value={value}>{t(SORT_LABEL[value])}</option>)}
          </select>
        </label>}
        {/* Opening a session is what this screen is for, so it sits where the
            thumb already is rather than under however many cards the project has
            (`NewTabSheet`). It opens without the desktop too: sending a file
            from the phone needs only this host, and the sheet holds its create
            buttons instead — the notice below says why. */}
        <button
          className="primary new-tab"
          disabled={!detail}
          onClick={() => setNewTabOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={newTabOpen}
          aria-label={t("mobile.newTab.title")}
          title={t("mobile.project.newTabTitle")}
        ><span aria-hidden="true">＋</span></button>
      </div>
    </header>
    {projectMenu && projectMenuOffered && <div className="focus-menu-backdrop" role="presentation" onClick={() => setProjectMenu(false)}>
      <div className="focus-menu project-menu" role="menu" aria-label={t("mobile.project.menu")} onClick={(event) => event.stopPropagation()}>
        {outbox.length > 0 && <button
          role="menuitem"
          aria-label={t("mobile.outbox.galleryOpen", { count: outbox.length })}
          onClick={() => { setProjectMenu(false); setGalleryOpen(true); }}
        ><span aria-hidden="true" className="project-menu-icon">🖼</span><span><strong>{t("mobile.outbox.region")}</strong></span><small className="project-menu-count">{outbox.length}</small></button>}
        {filesOffered && <button
          role="menuitem"
          onClick={() => { setProjectMenu(false); setFilesOpen(true); }}
        ><span aria-hidden="true" className="project-menu-icon">📁</span><span><strong>{t("mobile.project.files")}</strong></span></button>}
        {gitOffered && <button
          role="menuitem"
          onClick={() => { setProjectMenu(false); setGitOpen(true); }}
        ><span aria-hidden="true" className="project-menu-icon">⎇</span><span><strong>{t("mobile.gitSheet.menu")}</strong>{isUntested("mobile.project.gitOverview") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span></button>}
        {isUntested("mobile.project.nameMenu") && <p className="project-menu-note"><span className="untested">{t("mobile.newTab.untested")}</span></p>}
      </div>
    </div>}
    {gitOpen && detail && <GitSheet projectId={id} label={detail.project.label} onClose={() => setGitOpen(false)} />}
    {/* Only once the host has answered: `!detail?.desktop_available` was also
        true while the first load was in flight, so every project opened on a
        "Desktop unavailable" notice that vanished a moment later. */}
    {detail && !detail.desktop_available && <p className="notice">{t("mobile.project.desktopUnavailable")} {isUntested("mobile.headless.tabs") && <span className="untested">{t("mobile.newTab.untested")}</span>}</p>}
    {error && <p className="error">{error}</p>}
    {projectInbox.view}
    {canReorder && <p className="reorder-hint"><GripHint text={t("mobile.project.reorderHint")} /> {isUntested("mobile.project.reorder") && <span className="untested">{t("mobile.newTab.untested")}</span>}</p>}
    <section className="cards">{tabs.map((tab) => <div
      className={`tab-card${tabColorCss(tab.color) ? " has-tab-color" : ""}${agentModeClass(tab)}${drag.rowClass(tab.id)}`}
      key={tab.id}
      ref={drag.rowRef(tab.id)}
      // The desktop marks a coloured tab with its bottom rule; a phone card has
      // no such edge to spend, so the colour becomes the card's left border —
      // the same "which of these five is which" job, in the shape this surface
      // has. The id→hex mapping is the desktop's (see `tabColors.ts`), so the
      // two surfaces show one colour rather than two readings of a name.
      style={tabColorCss(tab.color) ? { ["--tab-color" as string]: tabColorCss(tab.color) } : undefined}
    >
      <div className="tab-card-head">
      {/* The colour chooser is the dot in the card's upper-left corner: it
          shows the tab's colour (a hollow ring when it has none) and opens the
          sheet, so the foot keeps its width for the worded actions. */}
      <button className="tab-card-dot" onClick={() => setColorTab(tab)} aria-haspopup="dialog" aria-expanded={colorTab?.id === tab.id} aria-label={t("mobile.project.colorTab", { label: tab.label })}><span aria-hidden="true" /></button>
      {/* The card opens the session; on an agent tab its name renames it.
          A button cannot hold a button, so the opener is a sibling stretched
          over the whole card — head, prompts and foot — and the controls that
          are not it sit above it. The name carries the model beside it and
          nothing under it: the CLI's own name repeated under every card bought
          little and pushed each card's prompts a line further down. */}
      <div className={`card tab-card-main${tab.available ? "" : " unavailable"}`}>
        <span>
          <span className="tab-card-title">
            {tab.kind === "agent"
              ? <button className="tab-card-name" onClick={() => setRenameTab(tab)} aria-haspopup="dialog" aria-expanded={renameTab?.id === tab.id} aria-label={t("mobile.project.renameTab", { label: tab.label })} title={t("common.rename")}><strong>{tab.label}</strong></button>
              : <strong>{tab.label}</strong>}
            {/* The model is its own control, like the name: a tap opens the
                session with its model picker already up, so changing the
                model (and, where the agent asks, the effort) is one tap from
                here rather than open-then-find-the-chip. */}
            {tab.agent_model && <button className="tab-card-model" disabled={!tab.available} onClick={() => terminal(tab, { pickModel: true })} aria-haspopup="dialog" aria-label={t("mobile.project.changeModelOf", { label: tab.label })} title={t("mobile.project.changeModel")}>{tab.agent_model}</button>}
            {tab.agent_model && isUntested("mobile.project.modelTap") && <span className="untested">{t("mobile.newTab.untested")}</span>}
            <AgentModeMarks tab={tab} />
            <SubagentCount tab={tab} />
            {/* Which worktree the agent works in, when it is not the project folder. */}
            <WorktreeMark tab={tab} />
            {/* Scheduling lives out here beside the tab, not inside the
                session: reaching a schedule must not mean attaching a
                terminal. The ◷ rides right of the model; agent tabs only. */}
            {tab.kind === "agent" && <button className="tab-card-icon accent tab-card-schedule" onClick={() => setScheduleTab({ tab })} aria-haspopup="dialog" aria-expanded={scheduleTab?.tab.id === tab.id} aria-label={t("mobile.project.scheduledFor", { label: tab.label })} title={t("agentPrompts.scheduledHeading")}><span aria-hidden="true">◷</span></button>}
            {tab.kind === "agent" && isUntested("mobile.project.scheduledInPrompts") && <span className="untested">{t("mobile.newTab.untested")}</span>}
          </span>
        </span>
      </div>
      {/* Close is the card's top-right ✕, where a phone looks for it; every tab
          the phone lists offers it, shell included. */}
      <button className="tab-card-icon tab-card-close" disabled={closingId !== null} onClick={() => void close(tab)} aria-label={t("mobile.project.closeTab", { label: tab.label })} title={t("common.close")}><span aria-hidden="true">✕</span></button>
      {/* The grip, under the manual order only. It is also the keyboard's way
          in: the arrows move the tab one place, which a drag cannot be asked
          for without a finger. */}
      {canReorder && <button
        className="tab-card-grip"
        aria-label={t("mobile.home.move", { label: tab.label })}
        title={t("mobile.project.moveHint")}
        {...drag.gripProps(tab.id)}
      ><span aria-hidden="true">⠿</span></button>}
      </div>
      {tab.kind === "agent" && <PromptLines tab={tab} />}
      {/* The desktop's schedule summary, where it puts it — only when the tab
          has schedules; the upcoming ones are listed with the prompts above. */}
      {tab.kind === "agent" && scheduleLine(tab.schedules, t) && <div className="tab-card-foot">
        <small className="tab-card-when" title={tab.schedules?.next ? t("mobile.project.nextRunTitle", { when: tab.schedules.next.replace("T", " ") }) : undefined}>{scheduleLine(tab.schedules, t)}</small>
      </div>}
      {/* Last, so it lies over the whole card: a tap anywhere the controls above
          have not claimed opens the session. */}
      <button className="tab-card-open" disabled={!tab.available} onClick={() => terminal(tab)} aria-label={t("mobile.project.openTab", { label: tab.label })} />
      {/* The agent's state is the desktop's bare glyph — ▶ working, ? asking,
          ✓ done — set on the card's left border, where it reads down the list
          at a glance without spending a row's width on a worded pill. */}
      {tab.agent_status && <AgentStatusMark status={tab.agent_status} />}
    </div>)}</section>
    {/* Agent tabs closed on either surface, newest first: a tap reopens one
        on the desktop, resuming its conversation, and its card comes back. */}
    {!!detail?.closed?.length && <section className="create reopen-closed" aria-label={t("mobile.project.recentlyClosed")}>
      <small className="reopen-closed-label">{t("mobile.project.recentlyClosed")}{isUntested("mobile.project.reopenClosed") && <span className="untested">{t("mobile.newTab.untested")}</span>}</small>
      {detail.closed.slice(0, 3).map((row) => <button
        key={row.id}
        className={reopeningId === row.id ? "reopening" : undefined}
        disabled={reopeningId !== null}
        aria-busy={reopeningId === row.id}
        onClick={() => void reopen(row)}
        aria-label={t("mobile.project.reopenHint", { label: row.label })}
        title={t("mobile.project.reopenHint", { label: row.label })}
      >{reopeningId === row.id
        ? <><span className="transcript-working-dots" aria-hidden="true"><i /><i /><i /></span> {t("mobile.project.reopening", { label: row.label })}{isUntested("mobile.project.reopening") && <span className="untested">{t("mobile.newTab.untested")}</span>}</>
        : <><span aria-hidden="true">↺</span> {row.label}</>}</button>)}
    </section>}
    {detail?.project.status === "inactive" && <section className="create"><button className="primary" disabled={activating} onClick={() => void activate()}>{t("mobile.project.activate")}</button></section>}
    <section className="create"><button disabled={!detail} onClick={() => setPromptsOpen(true)} aria-haspopup="dialog" aria-expanded={promptsOpen}>◷ {t("agentPrompts.heading")}</button></section>
    {/* The shell and agent buttons that stood here are the header's ＋ now: a
        project with a screenful of tabs put them past the end of the scroll. */}
    {newTabOpen && detail && <NewTabSheet
      projectId={id}
      agents={detail.agents}
      shells={detail.shells === true}
      busy={creating}
      headless={!detail.desktop_available}
      onClose={() => setNewTabOpen(false)}
      onPick={(kind, agent, mode, launch) => { setNewTabOpen(false); void create(kind, agent, mode, launch); }}
      onSendFile={() => { projectInbox.open(); setNewTabOpen(false); }}
    />}
    {promptsOpen && detail && <PromptsSheet projectId={id} tabs={detail.tabs} onClose={() => setPromptsOpen(false)} onSchedule={(tab, initialMessage) => { setPromptsOpen(false); setScheduleTab({ tab, initialMessage }); }} />}
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
    {galleryOpen && !fileOpen && <OutboxGallery scope={outboxScope} files={outbox} onOpen={openFile} onDetails={setFileOpen} onDelete={removeFile} onClose={() => setGalleryOpen(false)} />}
    {filesOpen && detail?.files && <ProjectFiles key={id} projectId={id} label={detail.project.label} onClose={() => setFilesOpen(false)}
      showTab={markupNewTab?.show} />}
    {fileOpen && <OutboxViewer key={`${id}/${fileOpen.name}`} scope={outboxScope} file={fileOpen} pictures={outboxPictures} onStep={setFileOpen} onClose={() => setFileOpen(null)}
      newTab={markupNewTab} />}
  </main>;
}
