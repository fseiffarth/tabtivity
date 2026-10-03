import { useEffect, useMemo, useState } from "react";
import { AGENT_SORTS, DEFAULT_AGENT_SORT, isAgentSort, sortAgentTabs, type AgentSort } from "../../../shared/agentSort";
import { lastPrompt } from "../agentPrompts";
import { getActivity, type ActivityTab } from "../api";
import { AgentStatusPill } from "../components/AgentStatusPill";
import { AgentModeMarks, SubagentCount, agentModeClass } from "../components/AgentModeMarks";
import { tabColorCss } from "../tabColors";
import { classifyUnavailable, describeUnavailable, type UnavailableReason } from "../connection";
import { readChoice, writeChoice } from "../prefs";
import { BRAND } from "../../../src/lib/brand";

/**
 * Every agent tab that is working, waiting on a decision, or done — across
 * every project at once, in one flat list.
 *
 * The project overview answers "what is this project doing"; this answers the
 * question a phone is actually picked up to ask, which is "is anything waiting
 * for me". Grouping by project is what stood in the way of that: it made the
 * reader open each project in turn to find the one session that had stopped to
 * ask something. Nothing quiet is listed, so an empty list means an empty list.
 *
 * The desktop owns the classification — the sidecar never reads terminal
 * output — so with no desktop window open there is nothing to show, and the
 * screen says that rather than showing every tab as idle.
 */

/** One desktop round trip per poll, at the same cadence as the project
 * overview's, and stopped while the phone is showing something else. */
const POLL_MS = 5_000;

const SORT_LABEL: Record<AgentSort, string> = {
  lastWorking: "Last working",
  lastDone: "Last done",
  native: "Status",
};

/** "3m ago" from a desktop timestamp — a rough age, since the two clocks are
 * not the same clock and the reading is a minute old at worst. */
function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The reading the current sort is ordering by, said on the row so the order
 * explains itself: what a tab is doing now, or when it last did it. */
function timing(tab: ActivityTab, sort: AgentSort, now: number): string {
  if (sort === "lastDone") return tab.done_at === undefined ? "" : `finished ${ago(tab.done_at, now)}`;
  if (tab.agent_status === "working") return "working now";
  // Under `lastWorking` a tab that is neither asking nor working sits in the
  // tier ordered by its last finished turn, so that is the reading its row
  // shows. A question is ordered by nothing timed, and its last output is when
  // it stopped to ask — which is the reading worth having on it.
  if (sort === "lastWorking" && tab.agent_status !== "question" && tab.done_at !== undefined) {
    return `finished ${ago(tab.done_at, now)}`;
  }
  return tab.working_at === undefined ? "" : `worked ${ago(tab.working_at, now)}`;
}

/** Sorted here, by the reader's choice — by last working (the default), by
 * last finished turn, or as the sidecar ranks status (waiting first, finished
 * last). Each pill is the same one the project overview puts on a tab. */
export function Activity({ open, onConnection }: {
  open: (projectId: string, tab: ActivityTab) => void;
  /** The header's one lamp belongs to whichever list is live, and in this mode
   * that is this one — the project list behind it is not being polled at all. */
  onConnection: (reason: UnavailableReason | null) => void;
}) {
  const [tabs, setTabs] = useState<ActivityTab[]>([]);
  /** Until the first answer, an empty list is "still loading", not "nothing". */
  const [loaded, setLoaded] = useState(false);
  const [desktop, setDesktop] = useState(true);
  const [offline, setOffline] = useState<UnavailableReason | null>(null);
  const [sort, setSort] = useState<AgentSort>(() => readChoice("agentsSort", isAgentSort, DEFAULT_AGENT_SORT));
  const chooseSort = (next: AgentSort) => { setSort(next); writeChoice("agentsSort", next); };
  /** Taken at each poll rather than at render, so the ages on the rows move
   * with the list and not with every re-render in between. */
  const [now, setNow] = useState(() => Date.now());
  const sorted = useMemo(() => sortAgentTabs(tabs, sort, (tab) => ({
    decision: tab.agent_status === "question",
    working: tab.agent_status === "working",
    workingAt: tab.working_at,
    doneAt: tab.done_at,
  })), [sort, tabs]);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const load = () => {
      if (document.visibilityState !== "visible") return;
      void getActivity(controller.signal)
        .then((body) => {
          if (disposed) return;
          setTabs(body.tabs);
          setNow(Date.now());
          setDesktop(body.desktop_available);
          setOffline(null);
          onConnection(null);
          setLoaded(true);
        })
        // Keep the last good list rather than blanking it: one dropped packet on
        // a flaky link should not wipe the screen the reader is looking at.
        .catch((error: unknown) => {
          if (disposed || controller.signal.aborted) return;
          const reason = classifyUnavailable(error);
          setOffline(reason);
          onConnection(reason);
        });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [onConnection]);
  return <>
    {offline && <p className="error connection-error">
      <strong>{describeUnavailable(offline).title}</strong>
      <span>{describeUnavailable(offline).hint}</span>
      <span>{tabs.length ? "Showing the last list this session loaded." : "Agent activity is never loaded from cache."}</span>
    </p>}
    {!loaded && !offline && <p className="projects-empty" role="status">Loading agent tabs…</p>}
    {loaded && !desktop && <p className="notice">Desktop unavailable — {BRAND.display} on the desktop is what tells a working session from one waiting on you.</p>}
    {loaded && desktop && tabs.length === 0 && <p className="projects-empty">Nothing is working, waiting or done. Quiet tabs are not listed here — open a project to reach one.</p>}
    {tabs.length > 1 && <label className="activity-sort">
      <span>Sort</span>
      <select aria-label="Sort agent tabs" value={sort} onChange={(event) => { if (isAgentSort(event.target.value)) chooseSort(event.target.value); }}>
        {AGENT_SORTS.map((value) => <option key={value} value={value}>{SORT_LABEL[value]}</option>)}
      </select>
    </label>}
    <section className="cards">{sorted.map((tab) => {
      const when = timing(tab, sort, now);
      // The one line that says what a session is *about*. A flat cross-project
      // list is read to decide which tab to open, and "claude 2 · Paper ·
      // worked 3m ago" says everything about that except the thing it was
      // asked. Two lines at most, then ellipsized — the card stays a card.
      const asked = lastPrompt(tab);
      return <button
        // The tab's colour (#264) carries onto this list too, and this is the
        // list it earns most: a flat cross-project row of look-alike "claude"
        // sessions is the case the colour is assigned for.
        className={`card${tabColorCss(tab.color) ? " has-tab-color" : ""}${agentModeClass(tab)}`}
        key={tab.id}
        disabled={!tab.available}
        style={tabColorCss(tab.color) ? { ["--tab-color" as string]: tabColorCss(tab.color) } : undefined}
        onClick={() => open(tab.project_id, tab)}
      >
        <span><strong>{tab.label}</strong><small>{tab.project_label}{tab.agent_model ? ` · ${tab.agent_model}` : ""}{when ? ` · ${when}` : ""}{tab.viewer_busy ? " · open elsewhere" : tab.available ? "" : " · gone"}</small>{asked && <small className="activity-prompt" title={asked.text}>{asked.text}</small>}</span>
        <span className="card-trailing"><AgentModeMarks tab={tab} /><SubagentCount tab={tab} />{tab.agent_status && <AgentStatusPill status={tab.agent_status} />}<span>›</span></span>
      </button>;
    })}</section>
  </>;
}
