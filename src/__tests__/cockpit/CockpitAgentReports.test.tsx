/**
 * The structured reports an agent publishes about its own tab (cockpit MCP
 * `tab_set_progress` / `tab_set_blocker` / `tab_set_verification`,
 * `docs/context/cockpit_mcp.md`): validated on the way in; progress is history
 * (running only for a live agent's own, fresh report); a live blocker takes
 * the roster note's place without touching any detected state or count;
 * verification reads "reported by the agent at <time>", never "verified"; all
 * plain text; carried through the tabs store without ever being sent back.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab: vi.fn(), openPromptChartTab: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { CockpitDetail } from "../../components/cockpit/CockpitDetail";
import { CockpitRoster } from "../../components/cockpit/CockpitRoster";
import { currentBlocker, currentVerification, progressReport, readCockpitMeta } from "../../lib/cockpit/agentNotes";
import { buildRoster, rosterCounts, rosterNote, type RosterInput, type RosterOptions, type RosterRow } from "../../lib/cockpit/roster";
import { _resetSyncBaseForTest, adoptSyncOutcome, applyWorkspacePatch, toSavedTabEntry, useTabsStore, type TabEntry, type WorkspaceSyncOutcome } from "../../stores/tabs";
import { duplicateSpec } from "../../stores/tabs/tabEntries";
import type { CockpitMeta } from "../../stores/tabs/types";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { useCockpitStore } from "../../stores/cockpit";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const meta = (patch: Partial<CockpitMeta> = {}): CockpitMeta => ({ v: 1, revision: 1, ...patch });
const saved = (patch: Record<string, unknown> = {}) => ({ v: 1, revision: 3, ...patch });
const steps = [
  { id: "plan", label: "Plan the change", state: "done" as const },
  { id: "code", label: "Write the code", state: "active" as const },
  { id: "ship", label: "Ship it", state: "pending" as const },
];

describe("readCockpitMeta, step 4 fields", () => {
  it("takes the host's shape, drops the generation markers and keeps the ended mark", () => {
    const read = readCockpitMeta(
      saved({
        progress: { steps, setAt: NOW, spawn: "nonce", ended: true },
        blocker: { text: "Needs a key", setAt: NOW, spawn: "nonce" },
        verification: { entries: [{ label: "Unit tests", outcome: "passed", note: "12 passed\nnone failed" }, { label: "Live", outcome: "not_run" }], setAt: NOW },
      }),
    );
    expect(read).toEqual({
      v: 1,
      revision: 3,
      progress: { steps, setAt: NOW, ended: true },
      blocker: { text: "Needs a key", setAt: NOW },
      verification: { entries: [{ label: "Unit tests", outcome: "passed", note: "12 passed\nnone failed" }, { label: "Live", outcome: "not_run" }], setAt: NOW },
    });
    expect(JSON.stringify(read)).not.toContain("nonce");
  });

  it("keeps progress and verification all or nothing, within the backend's bounds", () => {
    const base = { setAt: NOW, spawn: "s" };
    const bad = (progress: unknown) => readCockpitMeta(saved({ progress }))!.progress;
    expect(bad({ ...base, steps })).toBeDefined();
    expect(bad({ ...base, steps: [...steps, ...steps, ...steps] })).toBeUndefined();
    expect(bad({ ...base, steps: [{ id: "A", label: "L", state: "done" }] })).toBeUndefined();
    expect(bad({ ...base, steps: [{ id: "a", label: "L", state: "running" }] })).toBeUndefined();
    expect(bad({ ...base, steps: [{ id: "a", label: "L", state: "done" }, { id: "a", label: "M", state: "done" }] })).toBeUndefined();
    expect(bad({ ...base, steps: [{ id: "a", label: "L", state: "active" }, { id: "b", label: "L", state: "active" }] })).toBeUndefined();
    expect(bad({ ...base, steps: [{ id: "a", label: 5, state: "done" }] })).toBeUndefined();
    expect(bad({ ...base, steps: "x" })).toBeUndefined();
    expect(bad({ steps, spawn: "s" })).toBeUndefined();
    const long = readCockpitMeta(saved({ progress: { ...base, steps: [{ id: "a", label: "x".repeat(500), state: "done" }] } }))!.progress!;
    expect(Array.from(long.steps[0].label)).toHaveLength(120);
    const verify = (verification: unknown) => readCockpitMeta(saved({ verification }))!.verification;
    expect(verify({ setAt: NOW, entries: [{ label: "L", outcome: "verified" }] })).toBeUndefined();
    expect(verify({ setAt: NOW, entries: [{ label: "L", outcome: "passed", note: 7 }] })).toBeUndefined();
    expect(verify({ setAt: NOW, entries: [] })).toEqual({ setAt: NOW, entries: [] });
    expect(verify({ entries: [{ label: "L", outcome: "passed" }] })).toBeUndefined();
    expect(readCockpitMeta(saved({ blocker: { text: "x".repeat(500), setAt: NOW } }))!.blocker!.text).toHaveLength(300);
    expect(readCockpitMeta(saved({ blocker: { text: "x", setAt: "soon" } }))!.blocker).toBeUndefined();
  });
});

describe("progress is history, not live state", () => {
  const fresh = meta({ progress: { steps, setAt: NOW - 5 * MIN } });

  it("runs only for a live agent's own report under 30 minutes old", () => {
    expect(progressReport(fresh, NOW, true)?.running).toBe(true);
    expect(progressReport(fresh, NOW + 24 * MIN, true)?.running).toBe(true);
  });

  it("is a past report once older than 30 minutes, with its steps and time kept", () => {
    const past = progressReport(fresh, NOW + 26 * MIN, true)!;
    expect(past.running).toBe(false);
    expect(past.setAt).toBe(NOW - 5 * MIN);
    expect(past.steps).toEqual(steps);
    expect(progressReport(meta({ progress: { steps, setAt: NOW - 90 * 24 * 60 * MIN } }), NOW, true)?.running).toBe(false);
  });

  it("is a past report when the host marked it ended (a later spawn took the tab), however young", () => {
    expect(progressReport(meta({ progress: { steps, setAt: NOW, ended: true } }), NOW, true)?.running).toBe(false);
  });

  it("is a past report while the agent's machine is down, and with a stamp from the future", () => {
    expect(progressReport(fresh, NOW, false)?.running).toBe(false);
    expect(progressReport(meta({ progress: { steps, setAt: NOW + 10 * MIN } }), NOW, true)?.running).toBe(false);
  });

  it("is absent without steps", () => {
    expect(progressReport(meta(), NOW, true)).toBeUndefined();
    expect(progressReport(undefined, NOW, true)).toBeUndefined();
    expect(progressReport(meta({ progress: { steps: [], setAt: NOW } }), NOW, true)).toBeUndefined();
  });

  it("keeps a verification report however old, and shows a blocker only while it is live and fresh", () => {
    const report = { entries: [{ label: "T", outcome: "passed" as const }], setAt: NOW - 90 * 24 * 60 * MIN };
    expect(currentVerification(meta({ verification: report }))).toEqual(report);
    expect(currentVerification(meta({ verification: { entries: [], setAt: NOW } }))).toBeUndefined();
    const line = meta({ blocker: { text: "Stuck", setAt: NOW - MIN } });
    expect(currentBlocker(line, NOW, true)?.text).toBe("Stuck");
    expect(currentBlocker(line, NOW, false)).toBeUndefined();
    expect(currentBlocker(line, NOW + 30 * MIN, true)).toBeUndefined();
    expect(currentBlocker(meta({ blocker: { text: "  ", setAt: NOW } }), NOW, true)).toBeUndefined();
  });
});

const OPTS: RosterOptions = { stateFilter: "all", sort: "lastWorking", mode: "flat", query: "", boxFilter: null, scopeFilter: null };
const scope = { id: "p1", name: "P1", kind: "project" as const, boxIds: [] };
function input(key: string, cockpitMeta?: CockpitMeta, extra: Partial<RosterInput> = {}, state: "idle" | "question" | "working" = "idle"): RosterInput {
  const tab: TabEntry = { key, label: `tab-${key}`, cmd: "claude", cwd: "/p", kind: "agent", cockpitMeta };
  return { scope, tab, facts: { ptyId: `p1:${key}`, state }, ...extra };
}

describe("rosterNote: a live blocker takes the activity line", () => {
  const both = meta({
    activity: { text: "Writing the code", setAt: NOW - 2 * MIN },
    blocker: { text: "Needs the API key", setAt: NOW - MIN },
  });

  it("is the blocker when there is one, else the activity, each under the same live and 30-minute rules", () => {
    expect(rosterNote(input("a", both), NOW)).toEqual({ kind: "blocker", text: "Needs the API key", setAt: NOW - MIN });
    expect(rosterNote(input("a", meta({ activity: both.activity })), NOW)?.kind).toBe("activity");
    // The blocker expires first: the activity line (still fresh) shows again.
    const early = meta({ activity: { text: "Writing", setAt: NOW - 3 * MIN }, blocker: { text: "Stuck", setAt: NOW - 29 * MIN } });
    expect(rosterNote(input("a", early), NOW)?.kind).toBe("blocker");
    expect(rosterNote(input("a", early), NOW + 2 * MIN)?.kind).toBe("activity");
    expect(rosterNote(input("a", early), NOW + 28 * MIN)).toBeUndefined();
    expect(rosterNote(input("a", both, { hostDown: true }), NOW)).toBeUndefined();
    expect(rosterNote(input("a"), NOW)).toBeUndefined();
  });

  it("changes neither the detected state nor any count", () => {
    const plain = [input("a", undefined, {}, "question"), input("b", undefined, {}, "working"), input("c")];
    const reported = [input("a", both, {}, "question"), input("b", both, {}, "working"), input("c", both)];
    const before = buildRoster(plain, OPTS);
    const after = buildRoster(reported, OPTS);
    expect(after.counts).toEqual(before.counts);
    expect(after.rows.map((r) => r.state)).toEqual(before.rows.map((r) => r.state));
    expect(rosterCounts(after.rows).asking).toBe(1);
    // A tab that is idle and merely says it is blocked is not asking.
    expect(buildRoster([input("c", both)], OPTS).counts.asking).toBe(0);
  });
});

describe("the roster subtitle", () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
    useCockpitStore.setState({ selected: null, stateFilter: "all", query: "", rosterMode: "flat", boxFilter: null, scopeFilter: null });
  });
  afterEach(() => cleanup());

  const draw = (rows: RosterInput[]) => render(<CockpitRoster roster={buildRoster(rows, OPTS)} selected={null} now={NOW} onShow={() => {}} />);

  it("shows the blocker in place of the activity, marked as the agent's report, as plain text", () => {
    const { container } = draw([
      input("a", meta({
        activity: { text: "Writing the code", setAt: NOW - 2 * MIN },
        blocker: { text: 'Needs <b>the key</b> <img src=x onerror="alert(1)">', setAt: NOW - 4 * MIN },
      })),
    ]);
    const notes = container.querySelectorAll(".cockpit-roster-note");
    expect(notes).toHaveLength(1);
    const note = notes[0];
    expect(note.classList.contains("blocker")).toBe(true);
    expect(note.querySelector(".cockpit-note-tag")?.textContent).toBe("Agent reports blocked");
    expect(note.querySelector(".cockpit-note-text")?.textContent).toBe('Needs <b>the key</b> <img src=x onerror="alert(1)">');
    expect(note.querySelector("b, img")).toBeNull();
    expect(note.textContent).toContain("4 minutes ago");
    expect(note.textContent).not.toContain("Writing the code");
    expect(note.getAttribute("title")).toContain("did not detect or verify");
    // The detected state is its own element and unchanged.
    expect(container.querySelector(".cockpit-roster-row.state-idle .cockpit-state-mark")).toBeTruthy();
  });

  it("falls back to the activity line when the blocker is old, and shows nothing for a row whose machine is down", () => {
    const stale = meta({ activity: { text: "Writing", setAt: NOW - MIN }, blocker: { text: "Old", setAt: NOW - 31 * MIN } });
    const { container } = draw([input("a", stale), input("b", stale, { hostDown: true, host: "m" })]);
    const notes = container.querySelectorAll(".cockpit-roster-note");
    expect(notes).toHaveLength(1);
    expect(notes[0].classList.contains("blocker")).toBe(false);
    expect(notes[0].querySelector(".cockpit-note-text")?.textContent).toBe("Writing");
  });
});

describe("the detail pane's reports", () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
  });
  afterEach(() => cleanup());

  const rowOf = (cockpitMeta?: CockpitMeta, extra: Partial<RosterInput> = {}): RosterRow =>
    buildRoster([input("a", cockpitMeta, extra)], OPTS).rows[0];
  const draw = (cockpitMeta?: CockpitMeta, extra: Partial<RosterInput> = {}, now = NOW) =>
    render(<CockpitDetail row={rowOf(cockpitMeta, extra)} focused={false} now={now} />);

  it("shows a running report with the agent's steps as words, no spinner, attributed with its age", () => {
    const { container } = draw(meta({ progress: { steps, setAt: NOW - 3 * MIN } }));
    const block = container.querySelector(".cockpit-agent-progress")!;
    expect(block.classList.contains("running")).toBe(true);
    expect(block.querySelector("summary")?.textContent).toContain("Agent progress");
    expect(block.querySelector("summary")?.textContent).not.toContain("past");
    expect(block.textContent).toContain("Reported by the agent 3 minutes ago");
    expect(Array.from(block.querySelectorAll(".cockpit-step")).map((li) => li.textContent)).toEqual([
      "donePlan the change",
      "in progressWrite the code",
      "pendingShip it",
    ]);
    expect(block.querySelector("[class*=spin], progress, svg")).toBeNull();
  });

  it("shows an old report as a past one: 'was in progress', never 'in progress'", () => {
    const { container } = draw(meta({ progress: { steps, setAt: NOW - 45 * MIN } }));
    const block = container.querySelector(".cockpit-agent-progress")!;
    expect(block.classList.contains("past")).toBe(true);
    expect(block.classList.contains("running")).toBe(false);
    expect(block.querySelector("summary")?.textContent).toContain("past report");
    expect(block.textContent).toContain("Past report from 45 minutes ago");
    const words = Array.from(block.querySelectorAll(".cockpit-step-state")).map((s) => s.textContent);
    expect(words).toEqual(["done", "was in progress", "pending"]);
  });

  it("shows a report of an earlier run (ended) or of a machine that is down as past, however young", () => {
    for (const [patch, extra] of [
      [{ progress: { steps, setAt: NOW - MIN, ended: true as const } }, {}],
      [{ progress: { steps, setAt: NOW - MIN } }, { hostDown: true, host: "m" }],
    ] as const) {
      const { container } = draw(meta(patch), extra);
      expect(container.querySelector(".cockpit-agent-progress.past")).toBeTruthy();
      expect(container.querySelector(".cockpit-agent-progress.running")).toBeNull();
      expect(Array.from(container.querySelectorAll(".cockpit-step-state")).map((s) => s.textContent)).not.toContain("in progress");
      cleanup();
    }
  });

  it("shows the blocker while it is live and fresh, as the agent's statement, and not when old", () => {
    const hostile = '<script>boom()</script> & <img src=x onerror="alert(1)">';
    const { container } = draw(meta({ blocker: { text: hostile, setAt: NOW - 6 * MIN } }));
    const block = container.querySelector(".cockpit-agent-blocker")!;
    expect(block.querySelector("summary")?.textContent).toContain("Agent-reported blocker");
    expect(block.textContent).toContain("Reported by the agent 6 minutes ago");
    expect(block.textContent).toContain("detects no block");
    expect(block.querySelector(".cockpit-note-text")?.textContent).toBe(hostile);
    expect(block.querySelector("script, img")).toBeNull();
    cleanup();
    expect(draw(meta({ blocker: { text: "Stuck", setAt: NOW - 31 * MIN } })).container.querySelector(".cockpit-agent-blocker")).toBeNull();
  });

  it("words verification as reported by the agent at a time - never as verified - and escapes it", () => {
    const hostile = '<b>bold</b> & <img src=x onerror="alert(1)">';
    const setAt = NOW - 2 * 60 * MIN;
    const { container } = draw(
      meta({
        verification: {
          setAt,
          entries: [
            { label: "Unit tests", outcome: "passed", note: "12 passed\nnone failed" },
            { label: hostile, outcome: "failed", note: hostile },
            { label: "Live desktop check", outcome: "not_run" },
            { label: "Lint", outcome: "pending" },
          ],
        },
      }),
    );
    const block = container.querySelector(".cockpit-agent-verification")!;
    expect(block.querySelector("summary")?.textContent).toContain("Agent-reported checks");
    expect(block.querySelector(".cockpit-meta")?.textContent).toMatch(/^Reported by the agent at .+ \(2 hours ago\)\. .* did not run or check these\.$/);
    expect(block.textContent).not.toMatch(/verified/i);
    expect(Array.from(block.querySelectorAll(".cockpit-check")).map((li) => li.querySelector(".cockpit-step-state")?.textContent)).toEqual([
      "passed",
      "failed",
      "not run",
      "pending",
    ]);
    const notes = Array.from(block.querySelectorAll(".cockpit-check-note")).map((n) => n.textContent);
    expect(notes).toEqual(["12 passed\nnone failed", hostile]);
    expect(block.textContent).toContain(hostile);
    expect(block.querySelector("b, img")).toBeNull();
    expect(container.querySelector("img[src='x']")).toBeNull();
  });

  it("puts progress, blocker and verification below the results, in that order", () => {
    const { container } = draw(
      meta({
        handoff: { summary: "Done", checks: "", remaining: "", setAt: NOW },
        results: { items: [{ label: "Plot", relativePath: "out/plot.png" }], setAt: NOW },
        progress: { steps, setAt: NOW },
        blocker: { text: "Stuck", setAt: NOW },
        verification: { entries: [{ label: "T", outcome: "passed" }], setAt: NOW },
      }),
    );
    const order = Array.from(container.querySelectorAll(".cockpit-agent-note")).map((el) =>
      ["cockpit-agent-results", "cockpit-agent-progress", "cockpit-agent-blocker", "cockpit-agent-verification"].find((c) => el.classList.contains(c)) ?? "handoff",
    );
    expect(order).toEqual(["handoff", "cockpit-agent-results", "cockpit-agent-progress", "cockpit-agent-blocker", "cockpit-agent-verification"]);
  });

  it("shows none of them without reports", () => {
    const { container } = draw(meta());
    expect(container.querySelector(".cockpit-agent-progress, .cockpit-agent-blocker, .cockpit-agent-verification")).toBeNull();
  });
});

function tab(key: string, id: string, cockpitMeta?: CockpitMeta): TabEntry {
  return { key, id, label: key, cmd: "claude", cwd: "/tmp", kind: "agent", cockpitMeta };
}

describe("carried through the tabs store", () => {
  beforeEach(() => {
    _resetSyncBaseForTest();
    useTabsStore.setState({
      scope: "p",
      tabsByScope: { p: [tab("k1", "id-a")] },
      tabs: [tab("k1", "id-a")],
      layoutByScope: { p: { type: "group", id: "g", tabKeys: ["k1"], activeKey: "k1" } },
      focusedGroupByScope: { p: "g" },
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      workspaceVersionByScope: { p: 3 },
    });
    vi.mocked(invoke).mockReset();
  });

  const answer = (version: number, cockpitMeta: unknown): WorkspaceSyncOutcome => ({
    version,
    stale: false,
    ops: [],
    tabs: [{ key: "k1", id: "id-a", label: "k1", cmd: "claude", cwd: "/tmp", kind: "agent", cockpitMeta }],
  });
  const reports = saved({
    revision: 4,
    progress: { steps, setAt: NOW, spawn: "s" },
    blocker: { text: "Stuck", setAt: NOW, spawn: "s" },
    verification: { entries: [{ label: "T", outcome: "passed" }], setAt: NOW },
  });

  it("adopts the host's reports from a sync answer and follows a later clear", () => {
    adoptSyncOutcome("p", answer(4, reports), new Set(["k1"]));
    const adopted = useTabsStore.getState().tabsByScope.p[0].cockpitMeta!;
    expect(adopted.progress?.steps).toEqual(steps);
    expect(adopted.blocker?.text).toBe("Stuck");
    expect(adopted.verification?.entries[0].outcome).toBe("passed");
    expect(JSON.stringify(adopted)).not.toContain('"spawn"');
    // The host bumped the revision when it ended the progress at a new spawn: the window follows.
    adoptSyncOutcome("p", answer(5, { ...reports, revision: 5, blocker: undefined, progress: { steps, setAt: NOW, spawn: "s", ended: true } }), new Set(["k1"]));
    const next = useTabsStore.getState().tabsByScope.p[0].cockpitMeta!;
    expect(next.blocker).toBeUndefined();
    expect(next.progress?.ended).toBe(true);
    adoptSyncOutcome("p", answer(6, undefined), new Set(["k1"]));
    expect(useTabsStore.getState().tabsByScope.p[0].cockpitMeta).toBeUndefined();
  });

  it("adopts a report-only change that arrives as a workspace patch", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ version: 5, tabLayout: answer(5, reports).tabs });
    await applyWorkspacePatch({ scope: "p", version: 5, ops: [{ op: "updated", id: "id-a" }] });
    expect(useTabsStore.getState().tabsByScope.p[0].cockpitMeta?.blocker?.text).toBe("Stuck");
  });

  it("never sends the reports back and a duplicate starts without them", () => {
    const withReports = tab("k1", "id-a", meta({ revision: 9, progress: { steps, setAt: NOW }, blocker: { text: "x", setAt: NOW } }));
    expect("cockpitMeta" in toSavedTabEntry(withReports)).toBe(false);
    expect("cockpitMeta" in duplicateSpec(withReports)).toBe(false);
  });
});
