import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AppMark } from "./AppMark";
import { hasPairedDevice, logoutAuth, resumeAuth } from "./auth";
import { connectTrace, getMobileStatus, primeConnection, setUnauthorizedHandler, traceConnect, type TabRow } from "./api";
import { classifyUnavailable, describeUnavailable, suspectsTunnel, tailscaleAppLink, TUNNEL_STEPS, unavailableDetail, type UnavailableReason } from "./connection";
import { forgetLastPlace, parsePlace, rememberLastPlace, resolvePlace, restoreLastPlace, type LastPlace, type MobileSection, type RestoredPlace } from "./lastPlace";
import { refreshPush } from "./push";
import { hasLocalUnlock } from "./localLock";
import { clearConnectReload, isConnectReload, noteUnlockedLeave, takeConnectReload, takeReloadGrace } from "./reloadGrace";
import { noteDesktopTheme } from "./theme";
import { isUntested, setUntestedTagsVisible } from "../../src/lib/untested";
import { useT, type TranslationKey } from "../../src/lib/i18n";
import { Pair } from "./screens/Pair";
import { LocalUnlock } from "./screens/LocalUnlock";
import { LockedHomeShell } from "./screens/LockedHomeShell";
import { Home } from "./screens/Home";
import { Project } from "./screens/Project";
import { Terminal } from "./screens/Terminal";
import { Todo } from "./screens/Todo";
import { Mail } from "./screens/Mail";
import { Calendar } from "./screens/Calendar";
import { SECTION_GLYPH } from "./glyphs";
/** The bundle this phone is running, on every splash: a connect that hangs or
 * fails is exactly when the reader needs to know whether the phone picked up
 * the desktop's current bundle or is booting a stale one out of the cache. */
import { BUNDLE_VERSION as SPLASH_VERSION } from "./buildInfo";
import { BRAND, LEGACY_NAMES, NAMES, storageDashKey } from "../../src/lib/brand";

/**
 * The four top-level sections. To-do, Calendar and Mail used to be pushed on
 * top of the project list as one-way screens reached from the home header, so
 * every glance at the board cost a trip back through Projects. They are peers
 * of the project list, not children of it, and the tab bar says so: each keeps
 * its own place, and the bar is the only way between them.
 */
type Tab = MobileSection;
/** Where the Projects tab is standing: the list, or one project's tabs. */
type ProjectView = { kind: "home" } | { kind: "project"; id: string };
/**
 * The whole of where the reader is standing, as `lastPlace` stores it. A
 * terminal is full-bleed and sits on top of its project, so it wins over the
 * section behind it.
 */
function currentPlace(tab: Tab, projectView: ProjectView, terminal: { project: string; tab: TabRow } | null): LastPlace {
  if (terminal) return { section: "projects", projectId: terminal.project, tabId: terminal.tab.id };
  if (tab !== "projects") return { section: tab };
  return projectView.kind === "project" ? { section: "projects", projectId: projectView.id } : { section: "projects" };
}
const TABS: { id: Tab; icon: string; label: TranslationKey }[] = [
  { id: "projects", icon: SECTION_GLYPH.projects, label: "mobile.tabs.projects" },
  { id: "todo", icon: SECTION_GLYPH.todo, label: "mobile.tabs.todo" },
  { id: "calendar", icon: SECTION_GLYPH.calendar, label: "mobile.tabs.calendar" },
  { id: "mail", icon: SECTION_GLYPH.mail, label: "mobile.tabs.mail" },
];
/**
 * How long Tabtivity Mobile may go untouched before the local lock closes the
 * session. Long enough to outlast a reload, a trip to another app, and reading a
 * screenful of terminal output without touching the glass; short enough that a
 * phone whose own screen saver has taken over is locked here too — the web
 * offers no screen-off signal of its own, so idle time is the stand-in.
 *
 * It is also the line a silent re-login is allowed to cross: a 401 met while
 * the reader was active this recently — the sidecar restarted, or the session
 * slid out during a long read — is renewed with the device key and the request
 * sent again, with no PIN screen in between. Past it the app locks, as it
 * would have on its own.
 */
const LOCK_AFTER_IDLE_MS = 180_000;
/**
 * The place a tapped notification asked for — the Calendar, or an agent's tab
 * (`sw.js` opens `/?open=projects&project=…&tab=…` when no window is running).
 * Read once and taken out of the address bar, so a reload lands where the
 * reader is rather than where the notification was.
 */
function takeLaunchPlace(): LastPlace | null {
  try {
    const url = new URL(window.location.href);
    const open = url.searchParams.get("open");
    if (open === null) return null;
    const place = parsePlace({
      section: open,
      projectId: url.searchParams.get("project") ?? undefined,
      tabId: url.searchParams.get("tab") ?? undefined,
    });
    for (const key of ["open", "project", "tab"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return place;
  } catch {
    return null;
  }
}
const launchPlace = takeLaunchPlace();

// Keep the last known desktop preference through the lock and connection
// screens, before the authenticated status probe can refresh it.
try {
  setUntestedTagsVisible(localStorage.getItem(storageDashKey("show-untested-tags")) === "true");
} catch {
  // Private browsing may refuse localStorage; default to hiding the tags.
  setUntestedTagsVisible(false);
}

/** What counts as someone being there. Streamed terminal output does not. */
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "input", "touchstart", "touchmove", "wheel", "scroll"] as const;

/**
 * The launch curtain, and the same one the desktop app draws while its settings
 * and project reads are in flight (`AppShell`'s `StartupSplash`): the Tabtivity
 * mark inside two counter-rotating orbit rings. It stood in as a `✦` glyph,
 * which is the one screen a phone reliably sees on every cold open — every cold
 * open asks for the PIN or fingerprint first, and re-authenticates from scratch
 * after it; a reload of a page left unlocked moments ago (pull-to-refresh) is
 * the one return that skips the lock (`reloadGrace.ts`).
 *
 * Deliberately no minimum display time, unlike the desktop's: this is shown
 * while a real round trip to the sidecar is outstanding, so a fast answer
 * should reach the user at once rather than be held behind a flourish.
 */
function Splash({ message, progress, tone, children }: { message: string; progress?: boolean; tone?: "error"; children?: ReactNode }) {
  const t = useT();
  return (
    <main className={`screen splash${tone === "error" ? " splash-failed" : ""}`} role="status" aria-live="polite">
      <div className="splash-mark" aria-hidden="true">
        <span className="splash-orbit splash-orbit-one" />
        <span className="splash-orbit splash-orbit-two" />
        <AppMark />
      </div>
      <div className="splash-name">{BRAND.display.toUpperCase()}</div>
      <p className="splash-message">{message}</p>
      {progress ? <div className="splash-progress" aria-hidden="true"><span /></div> : null}
      {children}
      <p className="splash-version">{SPLASH_VERSION}{isUntested("mobile.link.splashVersion") && <> <span className="untested">{t("mobile.newTab.untested")}</span></>}</p>
    </main>
  );
}

/** How long "Connecting…" runs before it names the likeliest culprit. The
 * request itself only gives up after `REQUEST_TIMEOUT` (behind the service
 * worker's own wait), and with Tailscale off on the phone that is the whole
 * wait, spent on a spinner that says nothing. */
const SLOW_CONNECT_MS = 4000;

function SlowConnectHint() {
  const t = useT();
  const [slow, setSlow] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_CONNECT_MS);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!slow) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 500);
    return () => window.clearInterval(timer);
  }, [slow]);
  if (!slow) return null;
  return <>
    <p className="splash-hint">
      {t("mobile.tunnel.slow")}
      {isUntested("mobile.link.slowConnectHint") && <> <span className="untested">{t("mobile.newTab.untested")}</span></>}
    </p>
    <TunnelSteps />
    <ConnectTrace />
  </>;
}

/** The numbered way out of a stuck tunnel (`suspectsTunnel`), then how to make
 * it rarer. Step one carries Open Tailscale on Android, where the link can
 * open the app; a web page cannot force-stop it, so that step stays a path. */
function TunnelSteps() {
  const t = useT();
  const link = tailscaleAppLink();
  return <div className="splash-steps">
    <p className="splash-steps-title">
      {t("mobile.tunnel.try")}
      {isUntested("mobile.link.tunnelSteps") && <> <span className="untested">{t("mobile.newTab.untested")}</span></>}
    </p>
    <ol>
      {TUNNEL_STEPS.map((key, index) => <li key={key}>
        {t(key)}
        {index === 0 && link && <> <a className="splash-link" href={link}>{t("mobile.tunnel.openApp")}</a></>}
      </li>)}
    </ol>
    <p className="splash-steps-prevent">{t("mobile.tunnel.prevent")}</p>
  </div>;
}

/** The way in so far (`traceConnect`), for a slow or failed sign-in. */
function ConnectTrace() {
  const t = useT();
  const lines = connectTrace();
  if (lines.length === 0) return null;
  // The lines themselves stay in English: they are a diagnostic log for a bug
  // report, carrying status codes and timings rather than prose.
  return <pre className="splash-detail connect-trace" aria-label={t("mobile.app.connectTrace")}>
    {lines.join("\n")}
    {isUntested("mobile.link.connectTrace") && <>{"\n"}<span className="untested">{t("mobile.newTab.untested")}</span></>}
  </pre>;
}

function TabBar({ active, open }: { active: Tab; open: (tab: Tab) => void }) {
  const t = useT();
  return <nav className="mobile-tabbar" aria-label={t("mobile.tabs.sections")}>
    {TABS.map((tab) => <button
      key={tab.id}
      className={`mobile-tab${active === tab.id ? " active" : ""}`}
      aria-current={active === tab.id ? "page" : undefined}
      onClick={() => open(tab.id)}
    ><span aria-hidden="true">{tab.icon}</span>{t(tab.label)}</button>)}
  </nav>;
}

export function App() {
  const t = useT();
  const [auth, setAuth] = useState<"loading" | "paired" | "unpaired" | "setup" | "locked" | "unavailable">("loading");
  const [pairNeedsLock, setPairNeedsLock] = useState(false);
  const [, refreshTags] = useState(0);
  const [tab, setTab] = useState<Tab>("projects");
  const [projectView, setProjectView] = useState<ProjectView>({ kind: "home" });
  const [terminal, setTerminal] = useState<{ project: string; tab: TabRow; pickModel?: boolean; signIn?: boolean } | null>(null);
  const [todoCard, setTodoCard] = useState<string | undefined>(undefined);
  /** Why the last attempt failed, shown on the `unavailable` splash. */
  const [unavailable, setUnavailable] = useState<{ reason: UnavailableReason; detail?: string }>({ reason: "unreachable" });
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  /** When the reader last touched the glass — the idle lock's clock, and the
   * silent re-login's test of whether anyone is still here. */
  const lastActive = useRef(Date.now());
  /** When the reader last passed the local lock. The unavailable splash's
   * Retry signs in again without asking for it a second time while this is
   * recent; past the idle window it goes back through the lock. */
  const unlockedAt = useRef(0);
  /** A place a tapped notification asked for, waiting on the unlock; it wins
   * over the remembered place, because it is what the reader just chose. */
  const pendingPlace = useRef<LastPlace | null>(launchPlace);
  /** One renewal at a time: every request that met the same 401 waits on it. */
  const renewing = useRef<Promise<boolean> | null>(null);
  // Everything the tab bar navigates between, back at its starting point. Used
  // on every lock and on a dropped session, so a re-entry never lands on a
  // stale board or a detached terminal.
  const reset = useCallback(() => {
    setTab("projects");
    setProjectView({ kind: "home" });
    setTerminal(null);
    setTodoCard(undefined);
  }, []);
  /** Stand where `place` says, from the section's root. */
  const goTo = useCallback((place: RestoredPlace) => {
    reset();
    setTab(place.section);
    // Leaving the Projects tab pointed at the restored project keeps a
    // terminal's back chevron meaningful rather than dumping the reader
    // on the project list.
    if (place.projectId) {
      setProjectView({ kind: "project", id: place.projectId });
      if (place.tab) setTerminal({ project: place.projectId, tab: place.tab });
    }
  }, [reset]);
  const fail = useCallback((reason: UnavailableReason, detail?: string) => {
    // A path the phone wedged gets one fresh page before the splash
    // (`takeConnectReload`). An unlock from moments ago rides across it on
    // the reload grace, so the new page signs in without asking again.
    if (suspectsTunnel(reason) && takeConnectReload()) {
      if (Date.now() - unlockedAt.current < LOCK_AFTER_IDLE_MS) noteUnlockedLeave();
      location.reload();
      return;
    }
    setUnavailable({ reason, detail });
    setAuth("unavailable");
  }, []);

  const resume = useCallback(() => {
    setAuth("loading");
    void resumeAuth().then(async (result) => {
      if (result.kind === "paired") {
        clearConnectReload();
        const pending = pendingPlace.current;
        pendingPlace.current = null;
        const restored = pending ? await resolvePlace(pending) : await restoreLastPlace();
        reset();
        if (restored) goTo(restored);
        void refreshPush().catch(() => undefined);
      } else if (result.kind === "unpaired") {
        forgetLastPlace();
      } else {
        fail(result.reason, result.detail);
        return;
      }
      setAuth(result.kind);
    }).catch((error: unknown) => fail(classifyUnavailable(error), unavailableDetail(error)));
  }, [reset, goTo, fail]);

  const begin = useCallback(() => {
    setAuth("loading");
    // A cold open had no warm-up at all — only a return to the front sent
    // one — so the sign-in after the fingerprint was the first request on
    // the connection the browser kept from before the phone slept, and it
    // waited out the browser's ~10 s check that the connection is dead. Sent
    // now, that check runs while the reader is still at the lock.
    traceConnect("app started", true);
    if (isConnectReload()) traceConnect("reloaded after a failed connect");
    primeConnection();
    void Promise.all([hasPairedDevice(), hasLocalUnlock()]).then(([paired, locked]) => {
      if (!paired) {
        forgetLastPlace();
        setPairNeedsLock(!locked);
        setAuth("unpaired");
      } else if (locked && takeReloadGrace()) {
        // Pull-to-refresh on a page that was unlocked and in use seconds ago:
        // the session carries on, signed in afresh with the device key.
        unlockedAt.current = Date.now();
        traceConnect("reloaded unlocked");
        resume();
      } else {
        // Every other open asks: a launch, a page the browser restored, an app
        // the OS killed and reopened. `restoreLastPlace` still returns the
        // reader to their tab once they have unlocked.
        setAuth(locked ? "locked" : "setup");
      }
    // Both reads above are the phone's own key store, never the network, so a
    // rejection here is a blocked browser store rather than an absent host.
    }).catch(() => fail("storage_blocked"));
  }, [resume, fail]);
  useEffect(() => begin(), [begin]);

  // Where the reader is standing, kept in the phone's own storage so the next
  // cold open — the normal way a PWA comes back — resumes there. It is derived
  // from the state rather than written on the way into a terminal, which is what
  // made one terminal every later launch's landing: leaving it, or moving to
  // another section, wrote nothing, so the route outlived the visit. Only while
  // paired, because a lock and a dropped session `reset()` this same state and
  // that reset must not overwrite the place the next unlock returns to.
  useEffect(() => {
    if (auth !== "paired") return;
    rememberLastPlace(currentPlace(tab, projectView, terminal));
  }, [auth, tab, projectView, terminal]);

  useEffect(() => {
    if (auth !== "paired") return;
    const refresh = () => {
      void getMobileStatus().then(({ show_untested_tags, color_scheme }) => {
        noteDesktopTheme(color_scheme);
        const visible = show_untested_tags === true;
        if (setUntestedTagsVisible(visible)) refreshTags((tick) => tick + 1);
        try { localStorage.setItem(storageDashKey("show-untested-tags"), String(visible)); } catch { /* unavailable */ }
      }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [auth]);

  // A notification tapped while a window is already open: `sw.js` focuses it
  // and says where to go. Locked, it waits for the unlock like a cold open.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null;
      // The worker and the page update at different moments, so across a
      // rename a still-old worker posts the old message type.
      if (data?.type !== NAMES.mobileOpenMessage && data?.type !== LEGACY_NAMES.mobileOpenMessage) return;
      const place = parsePlace(data);
      if (!place) return;
      if (authRef.current === "paired") void resolvePlace(place).then(goTo);
      else pendingPlace.current = place;
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [goTo]);

  useEffect(() => {
    // A 401 mid-session: the sidecar restarted (its sessions live in memory,
    // by design), or the sliding session ran out. With the reader still
    // active, renew it silently — the device key signs a fresh challenge —
    // and tell `api()` to send the request again. A device the desktop no
    // longer knows is sent to pair rather than around this loop; anything
    // else that fails, or a reader who has been away, meets the lock screen.
    setUnauthorizedHandler(() => {
      if (authRef.current !== "paired") return Promise.resolve(false);
      if (Date.now() - lastActive.current >= LOCK_AFTER_IDLE_MS) {
        reset();
        setAuth("locked");
        return Promise.resolve(false);
      }
      renewing.current ??= resumeAuth().then((result) => {
        if (result.kind === "paired") return true;
        reset();
        if (result.kind === "unpaired") {
          forgetLastPlace();
          setAuth("unpaired");
        } else {
          setAuth("locked");
        }
        return false;
      }, () => {
        reset();
        setAuth("locked");
        return false;
      }).finally(() => { renewing.current = null; });
      return renewing.current;
    });
    return () => setUnauthorizedHandler(undefined);
  }, [reset]);

  useEffect(() => {
    const lock = () => {
      if (authRef.current !== "paired") return;
      // Detach terminal UI and remove its opaque route. The server receives a
      // best-effort logout; the next local unlock always performs the signed
      // challenge login anew.
      // The stored place holds nothing but a section name and opaque,
      // server-revalidated ids, so it can safely outlive the lock. Clearing it
      // here made `restoreLastPlace` dead on a phone: backgrounding is the
      // normal way to leave a PWA, so the place was always already forgotten by
      // the time the user unlocked.
      reset();
      setAuth("locked");
      void logoutAuth().catch(() => undefined);
    };
    // What ends the session is a stretch with no one there, not the page being
    // hidden: a reload hides it, and so do the notification shade, the share
    // sheet and a glance at the clock — locking on each of those meant the PIN
    // or fingerprint came back after every refresh. Time since the last touch or
    // keystroke is the measure instead, which covers both the phone left face-up
    // until its own screen saver takes it and the app left behind in the
    // background. A reload leaves a stamp on the way out (`pagehide`) so the
    // next page can carry on unlocked — only while someone is here, since an
    // idle page is one the timer is about to lock anyway.
    lastActive.current = Date.now();
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // Re-armed against the wall clock rather than trusted to have slept the
        // right amount: a backgrounded page is throttled and then frozen
        // outright, so a fired timer proves nothing about elapsed time.
        if (Date.now() - lastActive.current >= LOCK_AFTER_IDLE_MS) lock();
        else arm();
      }, Math.max(1_000, LOCK_AFTER_IDLE_MS - (Date.now() - lastActive.current)));
    };
    const noteActivity = () => {
      const previous = lastActive.current;
      lastActive.current = Date.now();
      // A scroll is hundreds of events; re-arming on each would be hundreds of
      // timer resets a second. The deadline only has to move when it has drifted
      // far enough to matter — the timer above re-arms itself when it fires early.
      if (lastActive.current - previous >= 5_000) arm();
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      traceConnect("back in front", true);
      primeConnection();
      if (Date.now() - lastActive.current >= LOCK_AFTER_IDLE_MS) lock();
      else arm();
    };
    arm();
    // Capture, so a handler that stops propagation cannot hide activity, and
    // passive, so none of this can delay a scroll.
    const options = { capture: true, passive: true } as const;
    for (const event of ACTIVITY_EVENTS) document.addEventListener(event, noteActivity, options);
    document.addEventListener("visibilitychange", onVisibility);
    const onPageHide = () => {
      if (authRef.current === "paired" && Date.now() - lastActive.current < LOCK_AFTER_IDLE_MS) noteUnlockedLeave();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) document.removeEventListener(event, noteActivity, options);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
    // `auth` is a dependency so that an unlock counts as activity. The default
    // unlock is the fingerprint sheet raised as the screen opens — OS UI that
    // never touches this document — so after it `lastActive` still dated from
    // before the lock, no timer was armed, and the next glance away and back
    // (`onVisibility`) locked the app again seconds after it was unlocked.
  }, [reset, auth]);

  const openTerminal = (project: string, next: TabRow, pickModel = false, signIn = false) => setTerminal({ project, tab: next, pickModel, signIn });
  // A card named by an alert opens on the To-do tab; switching tabs by hand
  // clears it, so returning to the board later does not re-open the editor a
  // reader already closed.
  const openTodo = (card?: string) => { setTodoCard(card); setTab("todo"); };
  // Tapping the tab you are already on returns it to its root, the gesture every
  // phone tab bar answers to: back to the project list, or a fresh section with
  // its folder, month and filters cleared. `reseed` remounts the section, which
  // is also the only way to unwind Mail's own message → folder → accounts stack
  // from out here.
  const [reseed, setReseed] = useState(0);
  const openSection = (next: Tab) => {
    setTodoCard(undefined);
    if (next === tab) {
      if (next === "projects") setProjectView({ kind: "home" });
      else setReseed((seed) => seed + 1);
    }
    setTab(next);
  };
  // A failed sign-in right after an unlock is retried as a sign-in: sending
  // the reader back through the fingerprint for a network hiccup made every
  // failure cost two unlocks. A blocked key store never got that far.
  const retry = () => {
    if (unavailable.reason !== "storage_blocked" && Date.now() - unlockedAt.current < LOCK_AFTER_IDLE_MS) resume();
    else begin();
  };
  if (auth === "loading") return <Splash message={t("mobile.app.connecting")} progress><SlowConnectHint /></Splash>;
  if (auth === "unavailable") {
    const { title, hint } = describeUnavailable(unavailable.reason);
    return (
      <Splash message={title} tone="error">
        <p className="splash-hint">{hint}</p>
        {suspectsTunnel(unavailable.reason) && <TunnelSteps />}
        {unavailable.reason === "host_down" && isUntested("mobile.link.offlineShell") && <p className="splash-hint muted"><span className="untested">{t("mobile.newTab.untested")}</span></p>}
        <p className="splash-hint muted">{t("mobile.app.noCache")}</p>
        {unavailable.detail && <p className="splash-detail">{unavailable.detail}</p>}
        <ConnectTrace />
        <button className="primary" onClick={retry}>{t("mobile.app.retry")}</button>
        {isUntested("mobile.link.unlockRetry") && <p className="splash-hint muted"><span className="untested">{t("mobile.newTab.untested")}</span></p>}
        {suspectsTunnel(unavailable.reason) && isUntested("mobile.link.connectReload") && <p className="splash-hint muted"><span className="untested">{t("mobile.newTab.untested")}</span></p>}
      </Splash>
    );
  }
  if (auth === "unpaired") return <Pair setupLock={pairNeedsLock} onDone={pairNeedsLock ? resume : begin} />;
  if (auth === "setup") return <LocalUnlock setup onUnlocked={() => setAuth("locked")} />;
  if (auth === "locked") return <>
    <LockedHomeShell />
    <LocalUnlock setup={false} onUnlocked={() => { unlockedAt.current = Date.now(); traceConnect("unlocked"); resume(); }} />
  </>;
  // A terminal is the one full-bleed screen: it owns every pixel it can get,
  // and the tab bar would sit on the keyboard toolbar besides.
  if (terminal) return <Terminal
    key={terminal.tab.id}
    tab={terminal.tab}
    project={terminal.project}
    pickModel={terminal.pickModel}
    signInTab={terminal.signIn}
    openTab={(next, opts) => openTerminal(terminal.project, next, false, opts?.signIn)}
    back={() => setTerminal(null)}
  />;
  return <div className="tabbed">
    {tab === "todo" ? <Todo key={reseed} card={todoCard} />
      : tab === "mail" ? <Mail key={reseed} />
        : tab === "calendar" ? <Calendar key={reseed} />
          : projectView.kind === "project"
            ? <Project id={projectView.id} back={() => setProjectView({ kind: "home" })} terminal={(row, opts) => openTerminal(projectView.id, row, opts?.pickModel, opts?.signIn)} />
            : <Home
              open={(id) => setProjectView({ kind: "project", id })}
              // Straight into the session, leaving the Projects tab on its
              // list: the agents mode is a triage list, and its loop is
              // list → tab → back to the list, not a detour through the
              // project the tab happens to live in.
              openTab={(projectId, row) => openTerminal(projectId, row)}
              todo={openTodo}
              mail={() => setTab("mail")}
            />}
    <TabBar active={tab} open={openSection} />
  </div>;
}
