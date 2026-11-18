/**
 * The results an agent lists for its own tab (cockpit MCP `tab_set_results`,
 * `docs/context/cockpit_mcp.md`): validated on the way in, shown as plain
 * text under the handoff with the agent's attribution, never read or checked
 * by drawing them, and opened only by a click that asks the host - which
 * receives the scope, the saved tab id, the index and the revision, never a path.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab: vi.fn(), openPromptChartTab: vi.fn() }));
vi.mock("../../lib/terminal/pathLinks", () => ({ openPathLink: vi.fn(), isLinkable: vi.fn(() => true) }));

import { invoke } from "@tauri-apps/api/core";
import { CockpitDetail } from "../../components/cockpit/CockpitDetail";
import { currentResults, readCockpitMeta } from "../../lib/cockpit/agentNotes";
import { buildRoster, type RosterInput, type RosterOptions, type RosterRow } from "../../lib/cockpit/roster";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import { isLinkable, openPathLink } from "../../lib/terminal/pathLinks";
import { _resetSyncBaseForTest, adoptSyncOutcome, useTabsStore, type TabEntry, type WorkspaceSyncOutcome } from "../../stores/tabs";
import type { CockpitMeta } from "../../stores/tabs/types";
import { useAgentModelsStore } from "../../stores/agents/agentModels";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

const results = (items: { label: string; relativePath: string }[], setAt = NOW - 2 * HOUR): CockpitMeta["results"] => ({ items, setAt });
const meta = (patch: Partial<CockpitMeta> = {}): CockpitMeta => ({ v: 1, revision: 4, ...patch });
const saved = (patch: Record<string, unknown> = {}) => ({ v: 1, revision: 4, ...patch });

describe("readCockpitMeta results", () => {
  it("takes the host's list, bounded, and drops nothing that is valid", () => {
    const read = readCockpitMeta(
      saved({ results: { items: [{ label: "Plot", relativePath: "out/plot.png" }, { label: "Log", relativePath: "run.log" }], setAt: NOW } }),
    );
    expect(read?.results).toEqual({ items: [{ label: "Plot", relativePath: "out/plot.png" }, { label: "Log", relativePath: "run.log" }], setAt: NOW });
    const cut = readCockpitMeta(saved({ results: { items: [{ label: "x".repeat(300), relativePath: "p".repeat(900) }], setAt: NOW } }))!;
    expect(Array.from(cut.results!.items[0].label)).toHaveLength(120);
    expect(Array.from(cut.results!.items[0].relativePath)).toHaveLength(512);
  });

  it("keeps all of a list or none of it, because a click names an item by its place", () => {
    const good = { label: "A", relativePath: "a" };
    for (const items of [[good, { label: 5, relativePath: "b" }], [good, null], [good, "text"], Array.from({ length: 9 }, () => good)]) {
      expect(readCockpitMeta(saved({ results: { items, setAt: NOW } }))?.results).toBeUndefined();
    }
    for (const bad of [undefined, "x", [], { items: "a", setAt: NOW }, { items: [good], setAt: "soon" }, { items: [good] }]) {
      expect(readCockpitMeta(saved({ results: bad }))?.results).toBeUndefined();
    }
  });

  it("shows a list however old it is, and nothing for an empty one", () => {
    const old = results([{ label: "A", relativePath: "a" }], NOW - 90 * 24 * HOUR);
    expect(currentResults(meta({ results: old }))).toEqual(old);
    expect(currentResults(meta({ results: results([]) }))).toBeUndefined();
    expect(currentResults(meta())).toBeUndefined();
    expect(currentResults(undefined)).toBeUndefined();
  });
});

const OPTS: RosterOptions = { stateFilter: "all", sort: "lastWorking", mode: "flat", query: "", boxFilter: null, scopeFilter: null };
const scope = { id: "p1", name: "P1", kind: "project" as const, boxIds: [] };
function input(cockpitMeta?: CockpitMeta, id: string | undefined = "saved-id"): RosterInput {
  const tab: TabEntry = { key: "k1", id, label: "tab-k1", cmd: "claude", cwd: "/p", kind: "agent", cockpitMeta };
  return { scope, tab, facts: { ptyId: "p1:k1", state: "idle" } };
}
const rowOf = (cockpitMeta?: CockpitMeta, id?: string): RosterRow => buildRoster([id === undefined ? input(cockpitMeta) : input(cockpitMeta, id)], OPTS).rows[0];

const ITEMS = [
  { label: "Plot", relativePath: "out/plot.png" },
  { label: "Not yet made", relativePath: "out/later.csv" },
];
const FILE = { name: "plot.png", path: "/p/out/plot.png", is_dir: false, size: 3, extension: ".png", mime: "image/png" };

describe("the detail results", () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue([]);
    vi.mocked(openPathLink).mockReset();
    vi.mocked(jumpToTab).mockReset();
    vi.mocked(isLinkable).mockReset();
    vi.mocked(isLinkable).mockReturnValue(true);
  });
  afterEach(() => cleanup());

  const draw = (cockpitMeta?: CockpitMeta, id?: string) => render(<CockpitDetail row={rowOf(cockpitMeta, id)} focused={false} now={NOW} />);
  const targetCalls = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "cockpit_result_target");

  it("lists each item as a plain-text label with its relative path, attributed to the agent, below the handoff", () => {
    const handoff = { summary: "Done", checks: "", remaining: "", setAt: NOW };
    const { container } = draw(meta({ handoff, results: results(ITEMS) }));
    const blocks = Array.from(container.querySelectorAll(".cockpit-agent-note"));
    expect(blocks).toHaveLength(2);
    expect(blocks[0].textContent).toContain("Agent handoff");
    const block = container.querySelector(".cockpit-agent-results")!;
    expect(blocks[1]).toBe(block);
    expect(block.querySelector("summary")?.textContent).toContain("Agent results");
    expect(block.textContent).toContain("Listed by the agent 2 hours ago");
    expect(block.textContent).toContain("not checked by");
    const rows = Array.from(block.querySelectorAll("li"));
    expect(rows.map((li) => li.querySelector("button")?.textContent)).toEqual(["Plot", "Not yet made"]);
    expect(rows.map((li) => li.querySelector(".cockpit-result-path")?.textContent)).toEqual(["out/plot.png", "out/later.csv"]);
    // Nothing is a link: no anchors, no hrefs - only buttons.
    expect(block.querySelector("a, [href]")).toBeNull();
  });

  it("renders hostile labels and paths as text", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>boom()</script>';
    const { container } = draw(meta({ results: results([{ label: hostile, relativePath: "javascript:alert(1)" }]) }));
    const row = container.querySelector(".cockpit-result-list li")!;
    expect(row.querySelector("button")?.textContent).toBe(hostile);
    expect(row.querySelector(".cockpit-result-path")?.textContent).toBe("javascript:alert(1)");
    expect(row.querySelector("img, script")).toBeNull();
    expect(container.querySelector("img[src='x']")).toBeNull();
  });

  it("is absent without results, and drawing asks the host for nothing", () => {
    const { container, unmount } = draw(meta());
    expect(container.querySelector(".cockpit-agent-results")).toBeNull();
    unmount();
    draw(meta({ results: results(ITEMS) }));
    expect(targetCalls()).toHaveLength(0);
    expect(openPathLink).not.toHaveBeenCalled();
    expect(jumpToTab).not.toHaveBeenCalled();
  });

  it("opens only on a click: the host gets the scope, tab id, index and revision, never a path", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "cockpit_result_target" ? { status: "open", entry: FILE, projectDir: "/p" } : []),
    );
    draw(meta({ results: results(ITEMS) }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Plot" }));
    });
    expect(targetCalls()).toEqual([["cockpit_result_target", { scope: "p1", tabId: "saved-id", index: 0, revision: 4 }]]);
    expect(JSON.stringify(targetCalls())).not.toContain("plot.png");
    expect(openPathLink).toHaveBeenCalledTimes(1);
    const [entry, at, ctx] = vi.mocked(openPathLink).mock.calls[0];
    expect(entry).toEqual(FILE);
    expect(at).toEqual({});
    expect(ctx).toMatchObject({ scope: "p1", projectId: "p1", projectDir: "/p", cwd: "/p", fromTab: "k1" });
    expect(jumpToTab).toHaveBeenCalledWith("p1", "k1");
  });

  it("says Unavailable for a missing file and opens nothing", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => Promise.resolve(cmd === "cockpit_result_target" ? { status: "unavailable" } : []));
    const { container } = draw(meta({ results: results(ITEMS) }));
    expect(container.querySelector(".cockpit-result-note")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Not yet made" }));
    });
    const rows = Array.from(container.querySelectorAll(".cockpit-result-list li"));
    expect(rows[1].querySelector(".cockpit-result-note")?.textContent).toBe("Unavailable");
    expect(rows[0].querySelector(".cockpit-result-note")).toBeNull();
    expect(openPathLink).not.toHaveBeenCalled();
    expect(jumpToTab).not.toHaveBeenCalled();
  });

  it("tells a refused, a changed and an unviewable result apart, and opens none", async () => {
    const answers: Record<string, unknown>[] = [{ status: "refused" }, { status: "stale" }, { status: "open", entry: FILE, projectDir: "/p" }];
    vi.mocked(invoke).mockImplementation((cmd: string) => Promise.resolve(cmd === "cockpit_result_target" ? answers.shift() : []));
    vi.mocked(isLinkable).mockReturnValue(false);
    const { container } = draw(meta({ results: results(ITEMS) }));
    const note = () => container.querySelector(".cockpit-result-note")?.textContent;
    for (const expected of ["Not opened: it is outside the project", "The list changed. Click again.", "No viewer for this file type"]) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Plot" }));
      });
      expect(note()).toBe(expected);
    }
    expect(openPathLink).not.toHaveBeenCalled();
  });

  it("opens nothing for a tab with no saved id or when the host call fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    const { container } = draw(meta({ results: results(ITEMS) }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Plot" }));
    });
    expect(container.querySelector(".cockpit-result-note")?.textContent).toBe("Unavailable");
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue([]);
    const unsaved = draw(meta({ results: results(ITEMS) }), "");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Plot" }));
    });
    expect(targetCalls()).toHaveLength(0);
    expect(unsaved.container.querySelector(".cockpit-result-note")?.textContent).toBe("Unavailable");
    expect(openPathLink).not.toHaveBeenCalled();
  });

  it("forgets a click's answer when the agent lists something else", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => Promise.resolve(cmd === "cockpit_result_target" ? { status: "unavailable" } : []));
    const { container, rerender } = draw(meta({ results: results(ITEMS) }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Plot" }));
    });
    expect(container.querySelector(".cockpit-result-note")).not.toBeNull();
    rerender(<CockpitDetail row={rowOf(meta({ revision: 5, results: results(ITEMS, NOW) }))} focused={false} now={NOW} />);
    expect(container.querySelector(".cockpit-result-note")).toBeNull();
  });
});

describe("carried through the tabs store", () => {
  beforeEach(() => {
    _resetSyncBaseForTest();
    const tab: TabEntry = { key: "k1", id: "id-a", label: "k1", cmd: "claude", cwd: "/tmp", kind: "agent" };
    useTabsStore.setState({
      scope: "p",
      tabsByScope: { p: [tab] },
      tabs: [tab],
      layoutByScope: { p: { type: "group", id: "g", tabKeys: ["k1"], activeKey: "k1" } },
      focusedGroupByScope: { p: "g" },
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      workspaceVersionByScope: { p: 3 },
    });
  });

  it("adopts the host's list from a sync answer", () => {
    const answer: WorkspaceSyncOutcome = {
      version: 4,
      stale: false,
      ops: [],
      tabs: [{ key: "k1", id: "id-a", label: "k1", cmd: "claude", cwd: "/tmp", kind: "agent", cockpitMeta: saved({ revision: 2, results: { items: ITEMS, setAt: NOW } }) }],
    };
    adoptSyncOutcome("p", answer, new Set(["k1"]));
    expect(useTabsStore.getState().tabsByScope.p[0].cockpitMeta?.results).toEqual({ items: ITEMS, setAt: NOW });
  });
});
