/**
 * What an agent reports for its own tab through the cockpit MCP's
 * `tab_request_attention` and `tab_add_milestone` (`docs/context/cockpit_mcp.md`,
 * plan decisions 18-22): validated on the way in; the question is a Needs-you
 * item counted once with the app-detected asking state of the same tab, in the
 * same badge path; a dismissal is one narrow host command that answers and
 * approves nothing; milestones are agent-reported history shown in the detail
 * pane and in "While you were away". All plain text.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((cmd: string, _args?: unknown): Promise<unknown> => {
  if (cmd === "root_mcp_status") return Promise.resolve({ running: true, tools: [] });
  if (cmd === "cockpit_attention_dismiss") return Promise.resolve("dismissed");
  return Promise.resolve([]);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../../components/cockpit/CockpitViews", async () => {
  const { CockpitNow } = await import("../../components/cockpit/CockpitNow");
  const { CockpitTonight } = await import("../../components/cockpit/CockpitTonight");
  return { CockpitViewBody: ({ view }: { view: string }) => (view === "tonight" ? <CockpitTonight /> : <CockpitNow />) };
});
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab: vi.fn(), openPromptChartTab: vi.fn() }));

import { CockpitDetail } from "../../components/cockpit/CockpitDetail";
import { CockpitRail } from "../../components/cockpit/CockpitRail";
import { RootOverlayHost } from "../../components/layout/RootOverlay";
import { CockpitIndicator } from "../../components/header/CockpitIndicator";
import { currentAttention, currentMilestones, milestonesSince, openAttention, readCockpitMeta } from "../../lib/cockpit/agentNotes";
import { buildDecisions, cockpitBadge, DECISION_GROUPS } from "../../lib/cockpit/decisions";
import { buildRoster, type RosterInput, type RosterOptions } from "../../lib/cockpit/roster";
import { awaySince, buildAway } from "../../lib/cockpit/tonight";
import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { useActivityStore } from "../../stores/activity";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { useBoxesStore } from "../../stores/boxes";
import { useCockpitStore } from "../../stores/cockpit";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useRootReviewStore } from "../../stores/rootReview";
import { _resetSyncBaseForTest, adoptSyncOutcome, toSavedTabEntry, useTabsStore, type TabEntry, type WorkspaceSyncOutcome } from "../../stores/tabs";
import { duplicateSpec } from "../../stores/tabs/tabEntries";
import type { CockpitMeta } from "../../stores/tabs/types";
import type { ProjectEntry } from "../../types";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const meta = (patch: Partial<CockpitMeta> = {}): CockpitMeta => ({ v: 1, revision: 1, ...patch });
const saved = (patch: Record<string, unknown> = {}) => ({ v: 1, revision: 3, ...patch });
const ask = (over: Partial<NonNullable<CockpitMeta["attention"]>> = {}) => ({ id: "ask-1", question: "Which branch should I use?", setAt: NOW - 5 * MIN, ...over });

describe("readCockpitMeta, attention and milestones", () => {
  it("takes the host's shape, drops the spawn nonce and keeps the dismissal", () => {
    const read = readCockpitMeta(
      saved({
        attention: { id: "a1", question: "Deploy?\nYes or no", setAt: NOW, spawn: "nonce" },
        milestones: [{ requestId: "m-1", text: "Tests green", at: NOW - HOUR }, { requestId: "m-2", text: "Docs", at: NOW }],
      }),
    );
    expect(read).toEqual({
      v: 1,
      revision: 3,
      attention: { id: "a1", question: "Deploy?\nYes or no", setAt: NOW },
      milestones: [{ requestId: "m-1", text: "Tests green", at: NOW - HOUR }, { requestId: "m-2", text: "Docs", at: NOW }],
    });
    expect(JSON.stringify(read)).not.toContain("nonce");
    expect(readCockpitMeta(saved({ attention: { id: "a1", question: "Q", setAt: NOW, spawn: "s", dismissed: true } }))!.attention).toEqual({ id: "a1", question: "Q", setAt: NOW, dismissed: true });
    // Only a literal true is a dismissal.
    expect(readCockpitMeta(saved({ attention: { id: "a1", question: "Q", setAt: NOW, spawn: "s", dismissed: "yes" } }))!.attention!.dismissed).toBeUndefined();
  });

  it("enforces the backend's bounds on the way in and drops what is not well formed", () => {
    const attention = (a: unknown) => readCockpitMeta(saved({ attention: a }))!.attention;
    expect(Array.from(attention({ id: "a", question: "x".repeat(900), setAt: NOW })!.question)).toHaveLength(500);
    expect(attention({ id: "has space", question: "Q", setAt: NOW })).toBeUndefined();
    expect(attention({ id: "", question: "Q", setAt: NOW })).toBeUndefined();
    expect(attention({ id: "a".repeat(65), question: "Q", setAt: NOW })).toBeUndefined();
    expect(attention({ id: "a", question: 5, setAt: NOW })).toBeUndefined();
    expect(attention({ id: "a", question: "Q", setAt: "now" })).toBeUndefined();
    expect(attention({ id: "a", question: "Q", setAt: -1 })).toBeUndefined();
    expect(attention("Q")).toBeUndefined();
    const milestones = (m: unknown) => readCockpitMeta(saved({ milestones: m }))!.milestones;
    expect(milestones([{ requestId: "bad id", text: "x", at: 1 }, { requestId: "ok", text: "x".repeat(400), at: 1 }, { requestId: "n", text: 3, at: 1 }, null, "x"])).toEqual([
      { requestId: "ok", text: "x".repeat(200), at: 1 },
    ]);
    expect(milestones("x")).toBeUndefined();
    expect(milestones([])).toBeUndefined();
    const many = Array.from({ length: 30 }, (_, i) => ({ requestId: `m${i}`, text: `T${i}`, at: i + 1 }));
    expect(milestones(many)!.map((m) => m.requestId)).toEqual(many.slice(10).map((m) => m.requestId));
  });
});

describe("an agent's question is open for 24 hours and needs the user until dismissed", () => {
  it("is current while undismissed and under 24 hours old", () => {
    expect(currentAttention(meta({ attention: ask() }), NOW)?.id).toBe("ask-1");
    expect(currentAttention(meta({ attention: ask({ setAt: NOW - 24 * HOUR + MIN }) }), NOW)?.id).toBe("ask-1");
    expect(currentAttention(meta({ attention: ask({ setAt: NOW - 24 * HOUR }) }), NOW)).toBeUndefined();
    expect(currentAttention(meta({ attention: ask({ setAt: NOW + 10 * MIN }) }), NOW)).toBeUndefined();
    expect(currentAttention(meta({ attention: ask({ question: "  \n" }) }), NOW)).toBeUndefined();
    expect(currentAttention(meta(), NOW)).toBeUndefined();
    expect(currentAttention(undefined, NOW)).toBeUndefined();
  });

  it("a dismissed question is open but no longer current", () => {
    const dismissed = meta({ attention: ask({ dismissed: true }) });
    expect(currentAttention(dismissed, NOW)).toBeUndefined();
    expect(openAttention(dismissed, NOW)?.dismissed).toBe(true);
    expect(openAttention(meta({ attention: ask({ dismissed: true, setAt: NOW - 25 * HOUR }) }), NOW)).toBeUndefined();
  });

  it("milestones read newest first and filter by the away window and the clock", () => {
    const m = meta({ milestones: [{ requestId: "a", text: "A", at: NOW - 5 * HOUR }, { requestId: "b", text: "B", at: NOW - 2 * HOUR }, { requestId: "c", text: "C", at: NOW - 30 * MIN }, { requestId: "f", text: "F", at: NOW + 10 * MIN }] });
    expect(currentMilestones(m).map((x) => x.requestId)).toEqual(["f", "c", "b", "a"]);
    expect(milestonesSince(m, NOW - 3 * HOUR, NOW).map((x) => x.requestId)).toEqual(["c", "b"]);
    expect(milestonesSince(m, NOW - 3 * HOUR, NOW + 20 * MIN).map((x) => x.requestId)).toEqual(["f", "c", "b"]);
    expect(milestonesSince(meta(), 0, NOW)).toEqual([]);
    expect(currentMilestones(undefined)).toEqual([]);
  });
});

const OPTS: RosterOptions = { stateFilter: "all", sort: "lastWorking", mode: "flat", query: "", boxFilter: null, scopeFilter: null };
const scope = { id: "p1", name: "P1", kind: "project" as const, boxIds: [] };
function input(key: string, cockpitMeta?: CockpitMeta, state: "idle" | "question" | "working" | "interrupted" | "done" = "idle"): RosterInput {
  const tab: TabEntry = { key, id: `id-${key}`, label: `tab-${key}`, cmd: "claude", cwd: "/p", kind: "agent", cockpitMeta };
  return { scope, tab, facts: { ptyId: `p1:${key}`, state } };
}
const decide = (inputs: RosterInput[], now = NOW) =>
  buildDecisions({ rows: buildRoster(inputs, OPTS).rows, push: [], schedules: [], markup: [], alerts: [], names: { p1: "P1" }, now });

describe("buildDecisions: the Agent asks group", () => {
  it("lists an open undismissed question per tab, newest first, and counts it in the total", () => {
    const d = decide([
      input("old", meta({ attention: ask({ id: "o", setAt: NOW - 3 * HOUR }) })),
      input("new", meta({ attention: ask({ id: "n", setAt: NOW - MIN }) })),
      input("plain"),
    ]);
    expect(d.items.agentAsks.map((a) => [a.row.tab.key, a.id])).toEqual([["new", "n"], ["old", "o"]]);
    expect(d.groups).toEqual([{ id: "agentAsks", count: 2 }]);
    expect(d.total).toBe(2);
  });

  it("counts a tab the app detects as asking once: the detected state wins", () => {
    const d = decide([
      input("both", meta({ attention: ask() }), "question"),
      input("only", meta({ attention: ask({ id: "o2" }) }), "idle"),
      input("asking"),
    ].map((i, n) => (n === 2 ? input("asking", undefined, "question") : i)));
    expect(d.items.asking.map((r) => r.tab.key).sort()).toEqual(["asking", "both"]);
    expect(d.items.agentAsks.map((a) => a.row.tab.key)).toEqual(["only"]);
    expect(d.total).toBe(3);
    expect(d.groups.map((g) => [g.id, g.count])).toEqual([["asking", 2], ["agentAsks", 1]]);
  });

  it("lists a working or interrupted tab's question without making it the pane's default", () => {
    const d = decide([input("busy", meta({ attention: ask() }), "working"), input("cut", meta({ attention: ask({ id: "c" }) }), "interrupted")]);
    expect(d.items.agentAsks.map((a) => a.row.tab.key).sort()).toEqual(["busy", "cut"]);
    expect(d.topAsking).toBeNull();
  });

  it("drops a dismissed, expired or empty question and sits right after Asking in the rail order", () => {
    const d = decide([
      input("dismissed", meta({ attention: ask({ dismissed: true }) })),
      input("expired", meta({ attention: ask({ setAt: NOW - 25 * HOUR }) })),
      input("quiet"),
    ]);
    expect(d.items.agentAsks).toEqual([]);
    expect(d.groups).toEqual([]);
    expect(DECISION_GROUPS.slice(0, 3)).toEqual(["asking", "agentAsks", "interrupted"]);
  });
});

describe("cockpitBadge: the same path counts the agent's question", () => {
  const tab = (key: string, cockpitMeta?: CockpitMeta): TabEntry => ({ key, label: key, cmd: "claude", cwd: "/p", kind: "agent", cockpitMeta });
  const badge = (tabsByScope: Record<string, TabEntry[]>, busy: Record<string, boolean> = {}, attention: Record<string, "decision" | "interrupted"> = {}) =>
    cockpitBadge({ tabsByScope, busyByTab: busy, attentionByTab: attention, schedulesByTarget: {}, approvals: 0, now: NOW });

  it("adds an open undismissed question to the total and counts a detected asking tab once", () => {
    const b = badge(
      { p1: [tab("a", meta({ attention: ask() })), tab("b", meta({ attention: ask() })), tab("c", meta({ attention: ask({ dismissed: true }) })), tab("d", meta({ attention: ask({ setAt: NOW - 30 * HOUR }) })), tab("e")] },
      {},
      { "p1:a": "decision" },
    );
    expect(b).toEqual({ asking: 1, interrupted: 0, proposals: 0, approvals: 0, agentAsks: 1, total: 2 });
  });

  it("counts a working tab's question (it is not the detected asking state) and an interrupted tab once more", () => {
    const b = badge({ p1: [tab("a", meta({ attention: ask() })), tab("b", meta({ attention: ask() }))] }, { "p1:a": true }, { "p1:a": "decision", "p1:b": "interrupted" });
    expect(b.asking).toBe(0);
    expect(b.interrupted).toBe(1);
    expect(b.agentAsks).toBe(2);
    expect(b.total).toBe(3);
  });

  it("skips the assistant's scope and non-agent tabs", () => {
    const shell = { ...tab("s", meta({ attention: ask() })), kind: "shell" as const };
    expect(badge({ [ASSISTANT_SCOPE]: [tab("t", meta({ attention: ask() }))], p1: [shell] }).agentAsks).toBe(0);
  });
});

describe("buildAway: milestones inside the away window", () => {
  const since = NOW - 3 * HOUR;
  const away = (inputs: RosterInput[], now = NOW) =>
    buildAway({ rows: buildRoster(inputs, OPTS).rows, schedules: [], push: [], root: [], since, now });

  it("includes milestones after the window start and leaves out older ones, newest first across tabs", () => {
    const recap = away([
      input("a", meta({ milestones: [{ requestId: "a1", text: "Old", at: since - MIN }, { requestId: "a2", text: "In", at: NOW - 2 * HOUR }] })),
      input("b", meta({ milestones: [{ requestId: "b1", text: "Newer", at: NOW - HOUR }] })),
      input("c"),
    ]);
    expect(recap.milestones.map((m) => [m.row.tab.key, m.milestone.requestId])).toEqual([["b", "b1"], ["a", "a2"]]);
    expect(recap.empty).toBe(false);
  });

  it("is empty with only milestones outside the window or from the future", () => {
    const recap = away([input("a", meta({ milestones: [{ requestId: "a1", text: "Old", at: since }, { requestId: "a2", text: "Future", at: NOW + 10 * MIN }] }))]);
    expect(recap.milestones).toEqual([]);
    expect(recap.empty).toBe(true);
    expect(awaySince(since, undefined, NOW)).toBe(since);
  });
});

const alertsStub = { enabled: false, items: [], loading: false, error: null, refresh: () => {} } as never;

describe("the Needs-you rail's Agent asks rows", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useCockpitStore.setState({ selected: null });
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {}, workspaceVersionByScope: {} });
  });
  afterEach(() => cleanup());

  const hostile = '<b>bold</b> & <img src=x onerror="alert(1)">';
  const draw = (inputs: RosterInput[], onPick = vi.fn()) => {
    const d = decide(inputs, Date.now());
    const view = render(<CockpitRail decisions={d} selected={null} alerts={alertsStub} onPick={onPick} />);
    return { ...view, onPick };
  };
  const live = (over: Partial<NonNullable<CockpitMeta["attention"]>> = {}) => meta({ attention: ask({ setAt: Date.now() - 5 * MIN, ...over }) });

  it("shows the question as plain text under its tab, in a group counted in the heading", () => {
    const { container } = draw([input("a", live({ question: hostile }))]);
    const group = container.querySelector('[data-group="agentAsks"]')!;
    expect(group.querySelector(".cockpit-count")?.textContent).toBe("1");
    expect(group.textContent).toContain("Agent asks");
    expect(group.querySelector(".cockpit-agent-ask-text")?.textContent).toBe(hostile);
    expect(group.querySelector("b, img")).toBeNull();
    expect(group.querySelector(".cockpit-rail-tab")?.textContent).toBe("tab-a");
    expect(group.querySelector(".cockpit-rail-pick")?.getAttribute("title")).toContain("Written by the agent");
    expect(container.querySelector(".cockpit-rail > .cockpit-column-head .cockpit-count")?.textContent).toBe("1");
  });

  it("a tab that is also detected as asking is a row of Asking only", () => {
    const { container } = draw([input("a", live(), "question")]);
    expect(container.querySelector('[data-group="agentAsks"]')).toBeNull();
    expect(container.querySelectorAll('[data-group="asking"] .cockpit-rail-row')).toHaveLength(1);
  });

  it("clicking the row opens the tab's conversation like an asking row and invokes nothing", () => {
    const { container, onPick } = draw([input("a", live())]);
    fireEvent.click(container.querySelector('[data-group="agentAsks"] .cockpit-rail-pick')!);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].ptyId).toBe("p1:a");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("the default pick selects the tab for the detail pane, still answering nothing", () => {
    const d = decide([input("a", live())], Date.now());
    const { container } = render(<CockpitRail decisions={d} selected={null} alerts={alertsStub} />);
    fireEvent.click(container.querySelector('[data-group="agentAsks"] .cockpit-rail-pick')!);
    expect(useCockpitStore.getState().selected).toBe("p1:a");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("Dismiss sends only scope, saved tab id and attention id to the one command - nothing is answered or approved", async () => {
    const { container, onPick } = draw([input("a", live({ id: "ask-77" }))]);
    await act(async () => void fireEvent.click(container.querySelector('[data-group="agentAsks"] .settings-btn')!));
    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "cockpit_attention_dismiss");
    expect(calls).toEqual([["cockpit_attention_dismiss", { scope: "p1", tabId: "id-a", attentionId: "ask-77" }]]);
    for (const [cmd] of invokeMock.mock.calls) expect(cmd).not.toMatch(/pty|send|write|approve|answer|reply|prompt/i);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("carries the untested pill with its register id", () => {
    const { container } = draw([input("a", live())]);
    expect(container.querySelector('[data-group="agentAsks"] .untested-tag')).toBeTruthy();
  });
});

describe("the detail pane", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
  });
  afterEach(() => cleanup());

  const draw = (cockpitMeta?: CockpitMeta, now = NOW) => {
    const row = buildRoster([input("a", cockpitMeta)], OPTS).rows[0];
    return render(<CockpitDetail row={row} focused={false} now={now} />);
  };
  const hostile = '<script>boom()</script> & <img src=x onerror="alert(1)">';

  it("shows the open question as the agent's own notice, as plain text, with Dismiss", async () => {
    const { container } = draw(meta({ attention: ask({ question: hostile, setAt: NOW - 7 * MIN }) }));
    const block = container.querySelector(".cockpit-agent-attention")!;
    expect(block.querySelector("summary")?.textContent).toContain("Agent question");
    expect(block.textContent).toContain("Asked by the agent 7 minutes ago");
    expect(block.textContent).toContain("detected no question");
    expect(block.querySelector(".cockpit-note-text")?.textContent).toBe(hostile);
    expect(block.querySelector("script, img")).toBeNull();
    await act(async () => void fireEvent.click(block.querySelector(".settings-btn")!));
    expect(invokeMock.mock.calls.filter(([c]) => c === "cockpit_attention_dismiss")).toEqual([["cockpit_attention_dismiss", { scope: "p1", tabId: "id-a", attentionId: "ask-1" }]]);
  });

  it("shows a dismissed question quietly without a Dismiss, and nothing after 24 hours", () => {
    const { container } = draw(meta({ attention: ask({ dismissed: true }) }));
    const block = container.querySelector(".cockpit-agent-attention")!;
    expect(block.querySelector(".settings-btn")).toBeNull();
    expect(block.textContent).toContain("Dismissed. Nothing was answered or approved.");
    cleanup();
    expect(draw(meta({ attention: ask({ setAt: NOW - 25 * HOUR }) })).container.querySelector(".cockpit-agent-attention")).toBeNull();
  });

  it("lists the milestones newest first, as agent-reported plain text with the host's time", () => {
    const { container } = draw(meta({ milestones: [{ requestId: "a", text: "First", at: NOW - 3 * HOUR }, { requestId: "b", text: hostile, at: NOW - HOUR }] }));
    const block = container.querySelector(".cockpit-agent-milestones")!;
    expect(block.querySelector("summary")?.textContent).toContain("Agent milestones");
    expect(block.querySelector(".cockpit-meta")?.textContent).toContain("Reported by the agent");
    expect(Array.from(block.querySelectorAll(".cockpit-note-text")).map((n) => n.textContent)).toEqual([hostile, "First"]);
    expect(block.querySelector("script, img")).toBeNull();
    expect(block.querySelectorAll(".cockpit-step-state")).toHaveLength(2);
  });

  it("draws neither without them and puts the question above the handoff and the milestones last", () => {
    expect(draw(meta()).container.querySelector(".cockpit-agent-attention, .cockpit-agent-milestones")).toBeNull();
    cleanup();
    const { container } = draw(
      meta({
        handoff: { summary: "Done", checks: "", remaining: "", setAt: NOW },
        verification: { entries: [{ label: "T", outcome: "passed" }], setAt: NOW },
        attention: ask(),
        milestones: [{ requestId: "m", text: "M", at: NOW }],
      }),
    );
    const order = Array.from(container.querySelectorAll(".cockpit-agent-note")).map((el) =>
      ["cockpit-agent-attention", "cockpit-agent-verification", "cockpit-agent-milestones"].find((c) => el.classList.contains(c)) ?? "handoff",
    );
    expect(order).toEqual(["cockpit-agent-attention", "handoff", "cockpit-agent-verification", "cockpit-agent-milestones"]);
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
  });

  const answer = (version: number, cockpitMeta: unknown): WorkspaceSyncOutcome => ({
    version,
    stale: false,
    ops: [],
    tabs: [{ key: "k1", id: "id-a", label: "k1", cmd: "claude", cwd: "/tmp", kind: "agent", cockpitMeta }],
  });
  const asked = { v: 1, revision: 4, attention: { id: "a1", question: "Deploy?", setAt: NOW, spawn: "s" }, milestones: [{ requestId: "m1", text: "Built", at: NOW }] };

  it("adopts the host's question and milestones, follows the dismissal by revision and a later clear", () => {
    adoptSyncOutcome("p", answer(4, asked), new Set(["k1"]));
    const adopted = useTabsStore.getState().tabsByScope.p[0].cockpitMeta!;
    expect(adopted.attention).toEqual({ id: "a1", question: "Deploy?", setAt: NOW });
    expect(adopted.milestones).toEqual([{ requestId: "m1", text: "Built", at: NOW }]);
    expect(JSON.stringify(adopted)).not.toContain('"spawn"');
    // The user's dismissal (host write, revision 5) arrives with the next answer.
    adoptSyncOutcome("p", answer(5, { ...asked, revision: 5, attention: { ...asked.attention, dismissed: true } }), new Set(["k1"]));
    expect(useTabsStore.getState().tabsByScope.p[0].cockpitMeta!.attention?.dismissed).toBe(true);
    // A client's own copy cannot revive it: the same revision keeps the held reading.
    adoptSyncOutcome("p", answer(5, { ...asked, revision: 5 }), new Set(["k1"]));
    expect(useTabsStore.getState().tabsByScope.p[0].cockpitMeta!.attention?.dismissed).toBe(true);
    // The grant of a new spawn removes it.
    adoptSyncOutcome("p", answer(6, { v: 1, revision: 6, milestones: asked.milestones }), new Set(["k1"]));
    const next = useTabsStore.getState().tabsByScope.p[0].cockpitMeta!;
    expect(next.attention).toBeUndefined();
    expect(next.milestones).toHaveLength(1);
  });

  it("never sends them back and a duplicate starts without them", () => {
    const withNotes = tab("k1", "id-a", meta({ revision: 9, attention: ask(), milestones: [{ requestId: "m", text: "M", at: NOW }] }));
    expect("cockpitMeta" in toSavedTabEntry(withNotes)).toBe(false);
    expect("cockpitMeta" in duplicateSpec(withNotes)).toBe(false);
  });
});

const project = (id: string): ProjectEntry =>
  ({ id, name: id.toUpperCase(), status: "active", position: 1, local_file: `/${id}/project.json` }) as ProjectEntry;

describe("the header badge and the windows", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    invokeMock.mockClear();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    useProjectsStore.setState({ projects: [project("p1")], activeId: "p1", rootDir: "/r" });
    useBoxesStore.setState({ boxes: [] });
    useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, lastDoneByTab: {}, lastWorkingByTab: {} });
    useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
    useRootReviewStore.setState({ proposals: [], imports: [], refresh: vi.fn(() => Promise.resolve()) });
    useOverlayAgentStore.setState({ scopeShownKeys: new Set() });
    useRootOverlayStore.setState({ open: false, view: "root", installTabs: {} });
    useCockpitStore.setState({ selected: null, detailAsked: false, stateFilter: "all", query: "", rosterMode: "flat", boxFilter: null, scopeFilter: null, lastClosedAt: null });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const agentTab = (key: string, cockpitMeta?: CockpitMeta): TabEntry => ({ key, id: `id-${key}`, label: key, cmd: "claude", cwd: "/p", kind: "agent", cockpitMeta });

  it("the indicator's badge counts the question and reads nothing from the host", () => {
    const stamp = Date.now();
    useTabsStore.setState({ tabsByScope: { p1: [agentTab("a", meta({ attention: ask({ setAt: stamp - MIN }) })), agentTab("b")], root: [] }, layoutByScope: {}, focusedGroupByScope: {} });
    const { container } = render(<CockpitIndicator />);
    expect(container.querySelector(".cockpit-indicator-badge")?.textContent).toBe("1");
    expect(container.querySelector("button")?.getAttribute("title")).toContain("1 agent questions");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("the Now view lists the question in the rail and a click selects that tab without answering", async () => {
    const stamp = Date.now();
    useTabsStore.setState({ tabsByScope: { p1: [agentTab("a", meta({ attention: ask({ setAt: stamp - MIN }) }))], root: [] }, layoutByScope: {}, focusedGroupByScope: {}, detachedGroupsByScope: {} });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1400 });
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("now"));
    await act(async () => {});
    const group = await waitFor(() => {
      const el = document.querySelector('[data-group="agentAsks"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(group.querySelector(".cockpit-rail-pick")!);
    expect(useCockpitStore.getState().selected).toBe("p1:a");
    for (const [cmd] of invokeMock.mock.calls) expect(cmd).not.toMatch(/cockpit_attention_dismiss|approve|answer/i);
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  });

  it("Tonight's recap lists milestones inside the away window as agent-reported and none outside it", async () => {
    const stamp = Date.now();
    useCockpitStore.setState({ lastClosedAt: stamp - 3 * HOUR });
    useTabsStore.setState({
      tabsByScope: {
        p1: [agentTab("a", meta({ milestones: [{ requestId: "old", text: "Before I left", at: stamp - 5 * HOUR }, { requestId: "in", text: "Tests are green", at: stamp - HOUR }] }))],
        root: [],
      },
      layoutByScope: {},
      focusedGroupByScope: {},
      detachedGroupsByScope: {},
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1400 });
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("tonight"));
    await act(async () => {});
    const recap = await screen.findByLabelText("While you were away");
    expect(recap.textContent).toContain("Milestones reported by agents");
    expect(recap.textContent).toContain("Tests are green");
    expect(recap.textContent).toContain("agent-reported");
    expect(recap.textContent).not.toContain("Before I left");
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  });
});
