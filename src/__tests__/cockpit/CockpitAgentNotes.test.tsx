/**
 * The notes an agent publishes about its own tab (cockpit MCP `tab_set_activity`
 * / `tab_set_handoff`, `docs/context/cockpit_mcp.md`): validated on the way
 * in, a one-line subtitle under the roster row only while the agent is live
 * and the line is under 30 minutes old, a handoff block in the detail pane,
 * both as plain text marked as the agent's own words — and carried through the
 * tabs store without ever being sent back.
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
import {
  ACTIVITY_TTL_MS,
  currentActivity,
  currentHandoff,
  isActivityFresh,
  readCockpitMeta,
  sameCockpitMeta,
} from "../../lib/cockpit/agentNotes";
import { buildRoster, rosterActivity, type RosterInput, type RosterOptions, type RosterRow } from "../../lib/cockpit/roster";
import { duplicateSpec, restoreSavedTab } from "../../stores/tabs/tabEntries";
import { _resetSyncBaseForTest, adoptSyncOutcome, applyWorkspacePatch, toSavedTabEntry, useTabsStore, type TabEntry, type WorkspaceSyncOutcome } from "../../stores/tabs";
import type { CockpitMeta } from "../../stores/tabs/types";
import { useCockpitStore } from "../../stores/cockpit";
import { useAgentModelsStore } from "../../stores/agents/agentModels";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const meta = (patch: Partial<CockpitMeta> = {}): CockpitMeta => ({ v: 1, revision: 1, ...patch });
const saved = (patch: Record<string, unknown> = {}) => ({ v: 1, revision: 3, ...patch });

describe("readCockpitMeta", () => {
  it("takes the host's shape and drops the generation marker", () => {
    const read = readCockpitMeta(
      saved({
        activity: { text: "Checking layout", setAt: NOW, spawn: "nonce" },
        handoff: { summary: "Did it", checks: "tests", remaining: "", setAt: NOW },
        results: [{ label: "later key" }],
      }),
    );
    expect(read).toEqual({
      v: 1,
      revision: 3,
      activity: { text: "Checking layout", setAt: NOW },
      handoff: { summary: "Did it", checks: "tests", remaining: "", setAt: NOW },
    });
    expect(JSON.stringify(read)).not.toContain("nonce");
  });

  it("refuses anything that is not this schema and bounds what it keeps", () => {
    for (const bad of [undefined, null, "text", 7, [], { v: 2, revision: 1 }, { revision: 1 }]) {
      expect(readCockpitMeta(bad)).toBeUndefined();
    }
    const read = readCockpitMeta(
      saved({
        revision: -4,
        activity: { text: "x".repeat(500), setAt: NOW },
        handoff: { summary: 5, checks: "", remaining: "", setAt: NOW },
      }),
    )!;
    expect(read.revision).toBe(0);
    expect(Array.from(read.activity!.text)).toHaveLength(160);
    expect(read.handoff).toBeUndefined();
    expect(readCockpitMeta(saved({ activity: { text: "x", setAt: "soon" } }))!.activity).toBeUndefined();
  });

  it("compares by revision, which the host never reuses", () => {
    expect(sameCockpitMeta(undefined, undefined)).toBe(true);
    expect(sameCockpitMeta(meta(), undefined)).toBe(false);
    expect(sameCockpitMeta(meta({ revision: 2 }), meta({ revision: 2 }))).toBe(true);
    expect(sameCockpitMeta(meta({ revision: 2 }), meta({ revision: 3 }))).toBe(false);
  });
});

describe("freshness", () => {
  it("shows a line under 30 minutes old, by the host's stamp", () => {
    const line = meta({ activity: { text: "Working", setAt: NOW } });
    expect(currentActivity(line, NOW, true)?.text).toBe("Working");
    expect(currentActivity(line, NOW + ACTIVITY_TTL_MS - 1, true)).toBeDefined();
    expect(currentActivity(line, NOW + ACTIVITY_TTL_MS, true)).toBeUndefined();
    // A little clock skew is fine; a stamp minutes ahead of the clock is not a fresh line.
    expect(isActivityFresh(NOW + 30_000, NOW)).toBe(true);
    expect(isActivityFresh(NOW + 5 * MIN, NOW)).toBe(false);
  });

  it("hides the line when the agent is not live, and has nothing without one", () => {
    const line = meta({ activity: { text: "Working", setAt: NOW } });
    expect(currentActivity(line, NOW, false)).toBeUndefined();
    expect(currentActivity(meta(), NOW, true)).toBeUndefined();
    expect(currentActivity(undefined, NOW, true)).toBeUndefined();
    expect(currentActivity(meta({ activity: { text: "  ", setAt: NOW } }), NOW, true)).toBeUndefined();
  });

  it("keeps a handoff however old: it is a historical report", () => {
    const note = { summary: "Done", checks: "", remaining: "", setAt: NOW - 90 * 24 * 60 * MIN };
    expect(currentHandoff(meta({ handoff: note }))).toEqual(note);
    expect(currentHandoff(meta({ handoff: { ...note, summary: " " } }))).toBeUndefined();
    expect(currentHandoff(undefined)).toBeUndefined();
  });
});

const OPTS: RosterOptions = { stateFilter: "all", sort: "lastWorking", mode: "flat", query: "", boxFilter: null, scopeFilter: null };
const scope = { id: "p1", name: "P1", kind: "project" as const, boxIds: [] };
function input(key: string, cockpitMeta?: CockpitMeta, extra: Partial<RosterInput> = {}): RosterInput {
  const tab: TabEntry = { key, label: `tab-${key}`, cmd: "claude", cwd: "/p", kind: "agent", cockpitMeta };
  return { scope, tab, facts: { ptyId: `p1:${key}`, state: "idle" }, ...extra };
}

describe("rosterActivity", () => {
  it("is the agent's current line, and nothing for a row whose machine is down", () => {
    const line = meta({ activity: { text: "Checking narrow-window behavior", setAt: NOW - 5 * MIN } });
    expect(rosterActivity(input("a", line), NOW)?.text).toBe("Checking narrow-window behavior");
    expect(rosterActivity(input("a", line, { hostDown: true }), NOW)).toBeUndefined();
    expect(rosterActivity(input("a", line), NOW + 26 * MIN)).toBeUndefined();
  });
});

describe("the roster subtitle", () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
    useCockpitStore.setState({ selected: null, stateFilter: "all", query: "", rosterMode: "flat", boxFilter: null, scopeFilter: null });
  });
  afterEach(() => cleanup());

  const draw = (rows: RosterInput[], now = NOW) => {
    const roster = buildRoster(rows, OPTS);
    return render(<CockpitRoster roster={roster} selected={null} now={now} onShow={() => {}} />);
  };

  it("shows the live, fresh line as the agent's own words with its age, apart from the detected state", () => {
    const { container } = draw([input("a", meta({ activity: { text: "Checking <b>narrow</b> windows", setAt: NOW - 5 * MIN } }), {})]);
    const note = container.querySelector(".cockpit-roster-note")!;
    expect(note).toBeTruthy();
    expect(note.querySelector(".cockpit-note-tag")?.textContent).toBe("Agent says");
    expect(note.querySelector(".cockpit-note-text")?.textContent).toBe("Checking <b>narrow</b> windows");
    expect(note.querySelector("b")).toBeNull();
    expect(note.textContent).toContain("5 minutes ago");
    // The detected state mark is its own element and unchanged by the note.
    expect(container.querySelector(".cockpit-roster-row.state-idle .cockpit-state-mark")).toBeTruthy();
    expect(container.querySelector(".cockpit-roster-line .cockpit-roster-note")).toBeNull();
  });

  it("shows nothing for an old line, a row whose machine is down, or a row with no notes", () => {
    const old = meta({ activity: { text: "Stale", setAt: NOW - 31 * MIN } });
    const line = meta({ activity: { text: "Working", setAt: NOW - MIN } });
    const { container } = draw([input("old", old), input("down", line, { hostDown: true, host: "m" }), input("none")]);
    expect(container.querySelector(".cockpit-roster-note")).toBeNull();
    cleanup();
    const again = draw([input("live", line), input("down", line, { hostDown: true, host: "m" })]);
    expect(again.container.querySelectorAll(".cockpit-roster-note")).toHaveLength(1);
  });
});

describe("the detail handoff", () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
  });
  afterEach(() => cleanup());

  const rowOf = (cockpitMeta?: CockpitMeta): RosterRow => buildRoster([input("a", cockpitMeta)], OPTS).rows[0];

  it("shows the report as plain text attributed to the agent, with its age", () => {
    const hostile = '<img src=x onerror="alert(1)"> & <script>boom()</script>';
    const handoff = { summary: `Fixed it\nsecond line ${hostile}`, checks: "unit tests passed", remaining: "", setAt: NOW - 2 * 60 * MIN };
    const { container } = render(<CockpitDetail row={rowOf(meta({ handoff }))} focused={false} now={NOW} />);
    const block = container.querySelector(".cockpit-agent-note")!;
    expect(block).toBeTruthy();
    expect(block.querySelector("summary")?.textContent).toContain("Agent handoff");
    expect(block.textContent).toContain("Written by the agent 2 hours ago");
    expect(block.textContent).toContain("not verified");
    const fields = Array.from(block.querySelectorAll(".cockpit-note-field"));
    expect(fields.map((f) => f.querySelector(".cockpit-note-tag")?.textContent)).toEqual(["Summary", "Checks reported"]);
    expect(fields[0].querySelector(".cockpit-note-text")?.textContent).toBe(handoff.summary);
    expect(block.querySelector("img, script")).toBeNull();
    expect(container.querySelector("img[src='x']")).toBeNull();
  });

  it("is absent without a handoff", () => {
    const { container } = render(<CockpitDetail row={rowOf(meta())} focused={false} now={NOW} />);
    expect(container.querySelector(".cockpit-agent-note")).toBeNull();
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
      tabsByScope: { p: [tab("k1", "id-a"), tab("k2", "id-b", meta({ revision: 1 }))] },
      tabs: [tab("k1", "id-a"), tab("k2", "id-b", meta({ revision: 1 }))],
      layoutByScope: { p: { type: "group", id: "g", tabKeys: ["k1", "k2"], activeKey: "k1" } },
      focusedGroupByScope: { p: "g" },
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      workspaceVersionByScope: { p: 3 },
    });
    vi.mocked(invoke).mockReset();
  });

  const answer = (version: number, a: unknown, b?: unknown): WorkspaceSyncOutcome => ({
    version,
    stale: false,
    ops: [],
    tabs: [
      { key: "k1", id: "id-a", label: "k1", cmd: "claude", cwd: "/tmp", kind: "agent", cockpitMeta: a },
      { key: "k2", id: "id-b", label: "k2", cmd: "claude", cwd: "/tmp", kind: "agent", cockpitMeta: b },
    ],
  });

  it("adopts the host's notes from a sync answer, updates a revision and clears what the host cleared", () => {
    const note = saved({ revision: 2, activity: { text: "Working", setAt: NOW, spawn: "s" } });
    adoptSyncOutcome("p", answer(4, note, saved({ revision: 1 })), new Set(["k1", "k2"]));
    const state = useTabsStore.getState();
    expect(state.tabsByScope.p[0].cockpitMeta).toEqual({ v: 1, revision: 2, activity: { text: "Working", setAt: NOW } });
    expect(state.tabs[0].cockpitMeta?.revision).toBe(2);
    // An unchanged revision keeps the very same object (no needless array replacement).
    const kept = state.tabsByScope.p[1];
    adoptSyncOutcome("p", answer(5, note, saved({ revision: 1 })), new Set(["k1", "k2"]));
    expect(useTabsStore.getState().tabsByScope.p[1]).toBe(kept);
    // The host dropped it (a closed-over or stripped record): the window follows.
    adoptSyncOutcome("p", answer(6, undefined, undefined), new Set(["k1", "k2"]));
    expect(useTabsStore.getState().tabsByScope.p.map((t) => t.cockpitMeta)).toEqual([undefined, undefined]);
  });

  it("adopts a metadata-only change that arrives as a workspace patch", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      version: 5,
      tabLayout: answer(5, saved({ revision: 4, handoff: { summary: "Done", checks: "", remaining: "", setAt: NOW } }), saved({ revision: 1 })).tabs,
    });
    await applyWorkspacePatch({ scope: "p", version: 5, ops: [{ op: "updated", id: "id-a" }] });
    expect(useTabsStore.getState().tabsByScope.p[0].cockpitMeta?.handoff?.summary).toBe("Done");
  });

  it("never sends the notes back, and a duplicate or restore starts from what the host stored", () => {
    const withNotes = tab("k1", "id-a", meta({ revision: 9, activity: { text: "x", setAt: NOW } }));
    expect("cockpitMeta" in toSavedTabEntry(withNotes)).toBe(false);
    expect("cockpitMeta" in duplicateSpec(withNotes)).toBe(false);
    const restored = restoreSavedTab(
      { key: "old", id: "id-a", label: "A", cmd: "claude", cwd: "/tmp", kind: "agent", cockpitMeta: saved({ revision: 5 }) },
      { defaultCwd: "/tmp", scope: "p", agentRoots: [] },
    );
    expect(restored.cockpitMeta).toEqual({ v: 1, revision: 5 });
    const forged = restoreSavedTab(
      { key: "old", label: "A", cmd: "claude", cwd: "/tmp", kind: "agent", cockpitMeta: "<script>" },
      { defaultCwd: "/tmp", scope: "p", agentRoots: [] },
    );
    expect(forged.cockpitMeta).toBeUndefined();
  });
});

