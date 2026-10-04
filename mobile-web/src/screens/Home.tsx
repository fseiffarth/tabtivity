import { useEffect, useState } from "react";
import { api, resolveAlert, wasApplied, type ActivityTab, type MobileAlertItem, type MobileAlerts, type ProjectRow, type TabPlace } from "../api";
import { classifyUnavailable, describeFailure, describeUnavailable, type UnavailableReason } from "../connection";
import { readFlag, readOrder, writeFlag, writeOrder } from "../prefs";
import { arrangeProjects, mergeProjectOrder, scopeCaption } from "../projectOrder";
import { useRowDrag } from "../rowDrag";
import { placeBeside } from "../tabReorder";
import { Activity } from "./Activity";
import { SECTION_GLYPH } from "../glyphs";
import { BUNDLE_VERSION } from "../buildInfo";
import { isUntested } from "../../../src/lib/untested";
import { useT } from "../../../src/lib/i18n";
import { SpeechLangSheet, speechLangSummary } from "../components/SpeechLangPicker";
import { ThemeRow, ThemeSheet } from "../components/ThemePicker";
import { readPhoneTheme, type PhoneTheme } from "../theme";
import { SendToDesktop } from "../components/SendToDesktop";
import { LocalModelsSection } from "./LocalModelsSheet";
import { GitMark } from "../components/GitMark";
import { readSpeechLang, type SpeechLang } from "../speechLang";
import { NotificationsSheet, pushSummary } from "../components/NotificationsSheet";
import { customMarkupPrompts, MarkupInstructionSheet, markupInstructionSummary } from "../components/MarkupInstructionSheet";
import { getPushState, pushSupport, type HostPushState } from "../push";
import { AppMark } from "../AppMark";
import { BRAND } from "../../../src/lib/brand";

const ALERT_ICON: Record<MobileAlertItem["kind"], string> = {
  mail: SECTION_GLYPH.mail,
  event: SECTION_GLYPH.calendar,
  task: SECTION_GLYPH.todo,
};

function relativeAlertTime(item: MobileAlertItem): string {
  if (item.minutes_away === undefined) return "No date";
  if (item.all_day) {
    const days = item.days_away ?? 0;
    if (days === 0) return "Today";
    return days < 0 ? `${Math.abs(days)}d overdue` : `In ${days}d`;
  }
  const minutes = item.minutes_away;
  if (minutes === 0) return "Now";
  const abs = Math.abs(minutes);
  const amount = abs >= 1440
    ? `${Math.floor(abs / 1440)}d`
    : abs >= 60
      ? `${Math.floor(abs / 60)}h`
      : `${abs}m`;
  return minutes < 0 ? `${amount} overdue` : `In ${amount}`;
}

/** What the ✓ does to *this* row, said in the row's own terms — the desktop's
 * three labels verbatim, because it is the same act reaching the same stores.
 * None of the three deletes anything. */
const DONE_LABEL: Record<MobileAlertItem["kind"], string> = {
  mail: "Return this mail to normal",
  event: "Remove this appointment from alerts",
  task: "Mark this to-do done",
};

function AlertRows({ alerts, onAlerts, todo, mail }: {
  alerts: MobileAlerts;
  onAlerts: (alerts: MobileAlerts) => void;
  todo: (card?: string) => void;
  mail: () => void;
}) {
  // The row being resolved, so its own ✓ can say it is working and the rest go
  // quiet: the three resolutions are desktop store writes, and two of them
  // landing at once is how a phone on bad signal ends up ticking the wrong card.
  const [finishing, setFinishing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const finish = async (alertId: string) => {
    if (finishing) return;
    setFinishing(alertId);
    setError("");
    try {
      // The desktop answers with the feed as it stands afterwards, so the list
      // is replaced rather than patched here: what a ✓ removes is the desktop's
      // to decide, and a card that reappears because it was only 90% done is a
      // truth the phone should show rather than hide.
      onAlerts((await resolveAlert(alertId)).alerts);
    } catch (reason) {
      // Done on the desktop with a feed too large to show is not a failed ✓.
      setError(wasApplied(reason) ? describeFailure(reason) : `That alert could not be completed. ${BRAND.display} on the desktop owns it.`);
    } finally {
      setFinishing(null);
    }
  };
  if (!alerts.enabled) return null;
  return <section className="mobile-alerts" aria-labelledby="mobile-alerts-heading">
    <h2 id="mobile-alerts-heading">Alerts</h2>
    {error && <p className="mobile-alerts-error" role="alert">{error}</p>}
    {alerts.items.length === 0
      ? <p className="mobile-alerts-empty">Nothing needs attention.</p>
      : <div className="mobile-alert-list">{alerts.items.map((item, index) => {
        // A card row opens *its own* card: the alert has already named the one
        // thing that needs attention, and a board of forty is where finding it
        // again costs the search the row exists to save. A row the desktop
        // could not resolve to a card still opens the board.
        const open = item.kind === "mail"
          ? mail
          : item.kind === "task"
            ? () => todo(item.task_id)
            : undefined;
        const key = item.alert_id ?? `${item.kind}-${item.at ?? ""}-${item.title}-${index}`;
        const contents = <>
          <span className={`mobile-alert-dot ${item.severity}`} aria-hidden="true" />
          <span className="mobile-alert-icon" aria-hidden="true">{ALERT_ICON[item.kind]}</span>
          <span className="mobile-alert-copy"><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span>
          <time>{relativeAlertTime(item)}</time>
        </>;
        // The ✓ sits **beside** the row rather than inside it, for the desktop
        // strip's reason: a button nested in a button is invalid markup, and it
        // would also make finishing the thing part of the tap that opens it.
        // A row the desktop minted no handle for keeps its opener and loses only
        // the ✓ — there is nothing honest to send back for it.
        return <div className="mobile-alert-row-wrap" key={key}>
          {item.alert_id && <button
            className="mobile-alert-done"
            disabled={finishing !== null}
            onClick={() => void finish(item.alert_id as string)}
            title={DONE_LABEL[item.kind]}
            aria-label={DONE_LABEL[item.kind]}
          >{finishing === item.alert_id ? "…" : "✓"}</button>}
          {open
            ? <button className="mobile-alert-row" onClick={open}>{contents}</button>
            : <div className="mobile-alert-row">{contents}</div>}
        </div>;
      })}</div>}
  </section>;
}

/** The three modes of the Projects section. `agents` is not a filter over the
 * project list but a different list entirely — every project's agent tabs that
 * are working, waiting or done, flat — so it is the one mode worth remembering
 * across the re-mounts a tab switch and a terminal visit cause. */
type HomeView = "active" | "agents" | "search";
const HOME_VIEWS: [HomeView, string][] = [["active", "Active"], ["agents", "Agents"], ["search", "Search"]];

export function Home({ open, openTab, todo, mail }: {
  open: (id: string) => void;
  openTab: (projectId: string, tab: ActivityTab) => void;
  todo: (card?: string) => void;
  mail: () => void;
}) {
  const [view, setView] = useState<HomeView>(() => (readFlag("projectsAgents") ? "agents" : "active"));
  const t = useT();
  /** The language the phone speaks and listens in (`speechLang.ts`). It is
   * reachable from inside a session too, under the Reader's menu, but it is
   * the phone's setting rather than that session's — and a reader who has to
   * fix it mid-answer has already been read to in the wrong voice. */
  const [speechLang, setSpeechLang] = useState<SpeechLang>(() => readSpeechLang());
  const [speechLangSheet, setSpeechLangSheet] = useState(false);
  /** What a Mark up Submit tells the agent — worded here and nowhere else. */
  const [markupInstruction, setMarkupInstruction] = useState(() => customMarkupPrompts());
  const [markupInstructionSheet, setMarkupInstructionSheet] = useState(false);
  /** The phone's own theme (`theme.ts`); unset, it follows the desktop's. */
  const [theme, setTheme] = useState<PhoneTheme>(() => readPhoneTheme());
  const [themeSheet, setThemeSheet] = useState(false);
  const [pushSheet, setPushSheet] = useState(false);
  const [push, setPush] = useState<HostPushState | null>(null);
  useEffect(() => {
    if (pushSupport() !== "supported") return;
    getPushState().then(setPush, () => undefined);
  }, []);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ProjectRow[]>([]);
  /** Whether any list has come back yet. Until it has, an empty `rows` is
   * "still loading", not "nothing here" — and a first open with no active
   * project drew nothing at all under the heading, which read as broken. */
  const [loaded, setLoaded] = useState(false);
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
  useEffect(() => {
    // The agents mode reads its own list; leaving this poll running behind it
    // would be a catalog load per tick for a list nothing is showing.
    if (view === "agents") return;
    // Without an abort, typing "ab" then "abc" on mobile data could land the
    // older response last and leave the wrong result set on screen.
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const suffix = view === "search" ? `?view=search&q=${encodeURIComponent(query)}` : "?view=active";
      void api<{ projects: ProjectRow[] }>(`/api/v1/projects${suffix}`, { signal: controller.signal })
        .then((body) => { setRows(body.projects); setOffline(null); setLoaded(true); })
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
  useEffect(() => {
    if (!offline) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setReload((count) => count + 1);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [offline]);
  useEffect(() => {
    // Alerts sit under the project list and are deliberately not part of the
    // agents mode, which shows agent tabs and nothing else; polling a feed
    // that mode does not draw would be a minute-timer for nobody.
    if (view === "agents") return;
    let disposed = false;
    const load = () => {
      void api<{ alerts: MobileAlerts }>("/api/v1/alerts")
        .then((body) => { if (!disposed) setAlerts(body.alerts); })
        .catch(() => { if (!disposed) setAlerts(null); });
    };
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [view]);
  /** The rows as they are drawn. The active list is the reader's own order with
   * the host's as the fallback; a search result is not arranged at all — it is
   * an answer to a query, and the best match belongs at the top of it. */
  const listed = view === "search" ? rows : arrangeProjects(rows, (project) => project.id, order);
  /** One row cannot be rearranged, and neither can a search result. */
  const canReorder = view === "active" && listed.length > 1;
  /** Move one project beside another and remember it. Nothing is sent anywhere:
   *  the order is this phone's, so the drop is done the moment it is stored —
   *  there is no round trip to reconcile with and no way for it to be refused. */
  const moveProject = (key: string, anchor: string, place: TabPlace) => {
    const next = mergeProjectOrder(order, placeBeside(listed, (project) => project.id, key, anchor, place).map((project) => project.id));
    setOrder(next);
    writeOrder("projectOrder", next);
  };
  const drag = useRowDrag(listed.map((project) => project.id), moveProject, canReorder);
  return <main className="screen home-screen">
    <header className="home-header">
      <div className="home-brand" aria-label={BRAND.display}>
        <span className="home-logo-frame" aria-hidden="true"><AppMark className="home-logo" /></span>
        <span className="home-brand-copy"><strong>{BRAND.display}</strong><small>{BUNDLE_VERSION}{isUntested("mobile.version.commit") && <span className="untested">Untested</span>}</small></span>
      </div>
      {/* The global views used to live here as a header rail; they are tabs of
          their own now, so the bar at the bottom of every screen carries them. */}
      <span className={offline ? "lamp off" : "lamp"} />
    </header>
    <div className="projects-row">
      <h1>{view === "agents" ? "Agents" : "Projects"}</h1>
    </div>
    <nav>{HOME_VIEWS.map(([id, label]) => <button
      key={id}
      className={view === id ? "selected" : ""}
      aria-pressed={view === id}
      onClick={() => choose(id)}
    >{label}</button>)}</nav>
    {view === "agents" && <Activity open={openTab} onConnection={setOffline} />}
    {view !== "agents" && <>
      {view === "search" && <input className="search" placeholder="Project name" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} />}
      {offline && <p className="error connection-error">
        <strong>{describeUnavailable(offline).title}</strong>
        <span>{describeUnavailable(offline).hint}</span>
        <span>{rows.length ? "Showing the last list this session loaded." : "Project data is never loaded from cache."}</span>
        {isUntested("mobile.home.recover") && <span className="untested">Untested</span>}
      </p>}
      {!loaded && !offline && <p className="projects-empty" role="status">Loading projects…</p>}
      {loaded && rows.length === 0 && <p className="projects-empty">{view === "search"
        ? query.trim() ? `No project by that name has ${BRAND.display} Mobile access.` : "Type a project's name to find it."
        : `No project is active right now. Search finds any project with ${BRAND.display} Mobile access.`}</p>}
      {canReorder && <p className="reorder-hint">Drag <span aria-hidden="true">⠿</span> to arrange — this order is kept on this phone, so the {BRAND.display} window's own project pills stay as they are. A project that has only just become active joins the end. {isUntested("mobile.home.reorder") && <span className="untested">{t("mobile.newTab.untested")}</span>}</p>}
      {/* A box row says it is one where a project row says its status: a box
          has no status of its own (listing it is what its switch means), and
          a "Paper" box beside a "Paper" project must be tellable apart.

          The row is the project screen's tab card, one line tall: the grip has
          to sit beside the opener rather than on it (a press anywhere else
          opens the project, and the two must not be one gesture), which is the
          same shape — and so the same classes — the tab list already wears. */}
      <section className="cards">{listed.map((project) => <div
        className={`tab-card one-row home-project-card${drag.rowClass(project.id)}`}
        key={project.id}
        ref={drag.rowRef(project.id)}
      >
        <div className="tab-card-head">
          <button className="card" onClick={() => open(project.id)}><span><strong>{project.label}</strong><small>{scopeCaption(project)}{project.git && <GitMark state={project.git} />}</small></span><span className="count">{project.live_sessions}</span></button>
          {canReorder && <button
            className="tab-card-grip"
            aria-label={`Move ${project.label}`}
            title="Drag to move this project, or use the arrow keys"
            {...drag.gripProps(project.id)}
          ><span aria-hidden="true">⠿</span></button>}
        </div>
      </div>)}</section>
      {alerts && <AlertRows alerts={alerts} onAlerts={setAlerts} todo={todo} mail={mail} />}
    </>}
    <SendToDesktop />
    <LocalModelsSection />
    {/* What this phone does, as against what the desktop is doing — kept to the
        end of the page, under whichever list the reader came for. */}
    <section className="phone-settings" aria-labelledby="phone-settings-heading">
      <h2 id="phone-settings-heading">{t("mobile.home.phoneSettings")}</h2>
      <ul className="option-list">
        <ThemeRow choice={theme} open={() => setThemeSheet(true)} expanded={themeSheet} />
        <li><button aria-haspopup="dialog" aria-expanded={speechLangSheet} onClick={() => setSpeechLangSheet(true)}>
          <span><strong>{t("mobile.speech.language")}{isUntested("mobile.speech.language") && <span className="untested">Untested</span>}</strong><small>{speechLangSummary(speechLang, t)}</small></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button></li>
        <li><button aria-haspopup="dialog" aria-expanded={pushSheet} onClick={() => setPushSheet(true)}>
          <span><strong>{t("mobile.push.title")}{isUntested("mobile.push.title") && <span className="untested">Untested</span>}</strong><small>{pushSummary(push, t)}</small></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button></li>
        <li><button aria-haspopup="dialog" aria-expanded={markupInstructionSheet} onClick={() => setMarkupInstructionSheet(true)}>
          <span><strong>{t("mobile.markup.instruction.title")}{isUntested("mobile.markup.instruction") && <span className="untested">Untested</span>}</strong><small>{markupInstructionSummary(markupInstruction, t)}</small></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button></li>
      </ul>
    </section>
    {themeSheet && <ThemeSheet chosen={theme} onChoose={setTheme} onClose={() => setThemeSheet(false)} />}
    {speechLangSheet && <SpeechLangSheet chosen={speechLang} onChoose={setSpeechLang} onClose={() => setSpeechLangSheet(false)} />}
    {pushSheet && <NotificationsSheet onChange={setPush} onClose={() => setPushSheet(false)} />}
    {markupInstructionSheet && <MarkupInstructionSheet onChange={setMarkupInstruction} onClose={() => setMarkupInstructionSheet(false)} />}
  </main>;
}
