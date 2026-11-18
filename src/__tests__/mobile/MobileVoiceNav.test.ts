import { beforeEach, describe, expect, it } from "vitest";
import type { ActivityTab, ProjectRow, SessionTranscript, TabRow } from "../../../mobile-web/src/api";
import {
  LANDING_MAX_AGE_MS, agentTabChoice, detailLists, landingRead, latestAgentTab, leaveLanding, navQueue, nextInQueue, noteJump,
  projectItems, promptForVoice, resetNavCursors, tabAtNumber, takeLanding, tabsOfAgent,
} from "../../../mobile-web/src/voiceNav";
import { needsYouGroups } from "../../../mobile-web/src/needsYouGroups";
import { BRAND } from "../../lib/brand";

function tab(id: string, extra: Partial<ActivityTab> = {}): ActivityTab {
  return { id, label: id, kind: "agent", agent_label: "Claude Code", available: true, viewer_busy: false, project_id: "p1", project_label: "Alpha", ...extra };
}

describe(`${BRAND.display} voice navigation targets`, () => {
  beforeEach(() => resetNavCursors());

  it("lists real projects only, by label", () => {
    const rows = [
      { id: "a", label: "Alpha", status: "", live_sessions: 0 },
      { id: "b", label: "Box", status: "", kind: "box", live_sessions: 0 },
      { id: "r", label: "Root", status: "", kind: "root", live_sessions: 0 },
      { id: "t", label: "Chat", status: "", kind: "assistant", live_sessions: 0 },
      { id: "c", label: "Gamma", status: "", kind: "project", live_sessions: 0 },
    ] as ProjectRow[];
    expect(projectItems(rows)).toEqual([{ id: "a", name: "Alpha" }, { id: "c", name: "Gamma" }]);
  });

  it("lists a project's tabs by title and its agents with their spellings", () => {
    const lists = detailLists({
      tabs: [tab("t1", { label: "Fix login" }), tab("t2", { label: "Docs", kind: "shell" })],
      agents: [{ id: "claude", label: "Claude Code", modes: [] }, { id: "mine", label: "Zed", modes: [] }],
    });
    expect(lists.tabs).toEqual([{ id: "t1", name: "Fix login" }, { id: "t2", name: "Docs" }]);
    expect(lists.agents[0].aliases).toContain("cloud");
    expect(lists.agents[1].aliases).toEqual([]);
  });

  it("lands on the project's agent tab with the latest activity, else its first", () => {
    const tabs: TabRow[] = [
      tab("shell", { kind: "shell", last_activity: 99 }),
      tab("old", { last_activity: 10 }),
      tab("new", { last_activity: 50 }),
      tab("signin", { sign_in: true, last_activity: 80 }),
      tab("down", { available: false, last_activity: 90 }),
    ];
    expect(latestAgentTab(tabs)?.id).toBe("new");
    expect(latestAgentTab([tab("first"), tab("second")])?.id).toBe("first");
    expect(latestAgentTab([tab("shell", { kind: "shell" }), tab("signin", { sign_in: true })])).toBeUndefined();
    expect(latestAgentTab([])).toBeUndefined();
  });

  it("picks a tab by its number, and an agent's n-th tab or its latest", () => {
    const tabs: TabRow[] = [
      tab("a", { agent_label: "Codex", last_activity: 1 }),
      tab("b", { last_activity: 5 }),
      tab("c", { last_activity: 9 }),
      tab("d", { kind: "shell" }),
    ];
    expect(tabAtNumber(tabs, 2)?.id).toBe("b");
    expect(tabAtNumber(tabs, 0)).toBeUndefined();
    expect(tabAtNumber(tabs, 9)).toBeUndefined();
    expect(tabsOfAgent(tabs, "Claude").map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(agentTabChoice(tabs, "Claude Code", 2)?.id).toBe("c");
    expect(agentTabChoice(tabs, "Claude Code")?.id).toBe("c");
    expect(agentTabChoice(tabs, "Claude Code", 3)).toBeUndefined();
    expect(agentTabChoice(tabs, "Gemini")).toBeUndefined();
  });
});

describe(`${BRAND.display} voice navigation queues`, () => {
  beforeEach(() => resetNavCursors());
  const activity: ActivityTab[] = [
    tab("work1", { agent_status: "working", project_id: "p1" }),
    tab("ask1", { agent_status: "interrupted", working_at: 100, project_id: "p2" }),
    tab("q1", { agent_status: "question", working_at: 50, project_id: "p1" }),
    tab("done-old", { agent_status: "done", done_at: 10, project_id: "p2" }),
    tab("done-new", { agent_status: "done", done_at: 90, project_id: "p3" }),
    tab("work2", { agent_status: "working", project_id: "p3" }),
    tab("seen", { agent_status: "done", done_at: 70 }),
    tab("gone", { agent_status: "working", available: false }),
  ];
  const seen = [["seen", 70] as const];

  it("waiting is Needs you's asking group: a question first, then cut-off turns", () => {
    expect(navQueue("waiting", activity, seen).map((entry) => entry.id)).toEqual(["q1", "ask1"]);
  });

  it("done is Needs you's finished group: unseen only, newest first", () => {
    expect(navQueue("done", activity, seen).map((entry) => entry.id)).toEqual(["done-new", "done-old"]);
  });

  it("working is the working tabs in the Agents view's order, those that are up", () => {
    expect(navQueue("working", activity, seen).map((entry) => entry.id)).toEqual(["work1", "work2"]);
  });

  it("is the same selection the Needs you group draws", () => {
    const groups = needsYouGroups(activity, seen);
    expect(groups.asking.map((entry) => entry.id)).toEqual(["q1", "ask1"]);
    expect(groups.finished.map((entry) => entry.id)).toEqual(["done-new", "done-old"]);
  });

  it("goes on after the tab it jumped to, wrapping, never to the tab the reader is on", () => {
    const queue = navQueue("working", activity, seen);
    expect(nextInQueue("working", queue, "elsewhere")?.id).toBe("work1");
    noteJump("working", "work1");
    expect(nextInQueue("working", queue, "work1")?.id).toBe("work2");
    noteJump("working", "work2");
    expect(nextInQueue("working", queue, "work2")?.id).toBe("work1");
    // The reader is on the next one: it is skipped.
    expect(nextInQueue("working", queue, "work1")?.id).toBe("work2");
  });

  it("finds nothing when the queue holds only the current tab, or nothing", () => {
    const queue = navQueue("working", [activity[0]], seen);
    expect(nextInQueue("working", queue, "work1")).toBeUndefined();
    expect(nextInQueue("working", [], "x")).toBeUndefined();
  });

  it("keeps a cursor per queue", () => {
    const queue = navQueue("working", activity, seen);
    noteJump("working", "work1");
    expect(nextInQueue("waiting", navQueue("waiting", activity, seen), "x")?.id).toBe("q1");
    expect(nextInQueue("working", queue, "x")?.id).toBe("work2");
  });

  it("walks the done queue as tabs are seen", () => {
    const first = nextInQueue("done", navQueue("done", activity, seen), "x");
    expect(first?.id).toBe("done-new");
    const afterSeen = [...seen, ["done-new", 90] as const];
    expect(nextInQueue("done", navQueue("done", activity, afterSeen), "done-new")?.id).toBe("done-old");
  });
});

describe(`${BRAND.display} voice navigation landing`, () => {
  it("is taken once, by the tab it is for", () => {
    leaveLanding({ tabId: "t1", where: "Claude in Alpha" }, 1_000);
    expect(takeLanding("t1", 2_000)).toEqual({ tabId: "t1", where: "Claude in Alpha", at: 1_000 });
    expect(takeLanding("t1", 2_000)).toBeNull();
  });

  it("drops a landing for another tab, and a stale one", () => {
    leaveLanding({ tabId: "t1", where: "x" }, 1_000);
    expect(takeLanding("t2", 2_000)).toBeNull();
    expect(takeLanding("t1", 2_000)).toBeNull();
    leaveLanding({ tabId: "t1", where: "x" }, 1_000);
    expect(takeLanding("t1", 1_000 + LANDING_MAX_AGE_MS + 1)).toBeNull();
    leaveLanding({ tabId: "t1", where: "x" }, 1_000);
    expect(takeLanding("t1", 1_000 + LANDING_MAX_AGE_MS)).not.toBeNull();
  });

  it("keeps the newest of two notes", () => {
    leaveLanding({ tabId: "t1", where: "one" }, 1_000);
    leaveLanding({ tabId: "t2", where: "two" }, 1_100);
    expect(takeLanding("t1", 1_200)).toBeNull();
  });
});

describe(`${BRAND.display} prompt read at a landing`, () => {
  it("keeps the first two sentences of a long prompt", () => {
    expect(promptForVoice("Fix the login. Then add a test! And also refactor the whole module. Later.")).toBe("Fix the login. Then add a test!");
  });

  it("keeps a short prompt whole, folding line breaks", () => {
    expect(promptForVoice("add a clear button\nto the composer")).toBe("add a clear button to the composer");
  });

  it("cuts one endless sentence at a word", () => {
    const long = `${"word ".repeat(100)}end`;
    const cut = promptForVoice(long);
    expect(cut.length).toBeLessThanOrEqual(281);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe(`${BRAND.display} what a landing reads`, () => {
  const entries = (...list: [string, string][]) => list.map(([kind, text], index) => ({ kind, text, at: `2026-11-09T10:00:0${index}.000Z` }));
  const session = (...list: [string, string][]): SessionTranscript => ({ available: true, truncated: false, entries: entries(...list) } as SessionTranscript);
  const row = tab("t1");

  it("reads the last prompt and the answers after it, from the answer before it", () => {
    const read = landingRead(row, session(["prompt", "one"], ["answer", "first"], ["prompt", "two"], ["answer", "second"]), true);
    expect(read).toEqual({ kind: "prompt", text: "two", answered: true, sinceKey: "answer:2026-11-09T10:00:01.000Z" });
  });

  it("starts from nothing when no answer comes before the prompt, and says a prompt has no answer yet", () => {
    expect(landingRead(row, session(["prompt", "one"]), true)).toEqual({ kind: "prompt", text: "one", answered: false, sinceKey: null });
    expect(landingRead(row, session(["prompt", "one"], ["answer", "a"], ["prompt", "two"]), true))
      .toMatchObject({ answered: false, sinceKey: "answer:2026-11-09T10:00:01.000Z" });
  });

  it("skips a slash command for the prompt before it", () => {
    const read = landingRead(row, session(["prompt", "real prompt"], ["answer", "a"], ["prompt", "/clear"]), true);
    expect(read).toMatchObject({ kind: "prompt", text: "real prompt" });
  });

  it("says only where it landed with no prompt, no session or no Focus", () => {
    expect(landingRead(row, session(["answer", "a"]), true)).toEqual({ kind: "where" });
    expect(landingRead(row, { available: false, reason: "no_session", entries: [], truncated: false } as SessionTranscript, true)).toEqual({ kind: "where" });
    expect(landingRead(row, session(["prompt", "x"]), false)).toEqual({ kind: "where" });
  });

  it("falls back to the tab row's last prompt when the session cannot be read", () => {
    const asked = tab("t2", { prompts: [{ text: "older" }, { text: "fix it. then more. and more." }] } as Partial<ActivityTab>);
    expect(landingRead(asked, null, true)).toEqual({ kind: "fallback", text: "fix it. then more." });
    expect(landingRead(asked, { available: false, reason: "read_failed", entries: [], truncated: false } as SessionTranscript, true).kind).toBe("fallback");
    expect(landingRead(row, null, true)).toEqual({ kind: "where" });
  });
});
