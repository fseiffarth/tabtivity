/**
 * Which model the phone tags an agent tab with.
 *
 * The overview's tag and the Focus chip over the keyboard are one reading in
 * two places, so the tag is the session's own status line read off the pane
 * here — the words the session prints, effort included — rather than the
 * transcript's model id, which names the model of the last *answer* and is
 * one `/model` behind the screen until the next one.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import type { ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { useActivityStore } from "../../stores/activity";
import { clearAgentModelFloorForTest, useAgentModelsStore } from "../../stores/agents/agentModels";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";
import { BRAND, MOBILE_ACCESS_KEY, NAMES } from "../../lib/brand";

const paper: ProjectEntry = {
  id: "p-paper",
  name: "Paper",
  status: "active",
  position: 1,
  local_file: "/projects/paper/project.json",
  directory: "/projects/paper",
  [MOBILE_ACCESS_KEY]: true,
};

const TMUX = `${BRAND.slug}-p_paper--agent-111111111`;
const PTY = `${paper.id}:agent-1`;

/** The session has been switched to Sonnet since its last answer: its status
 * line says so, its transcript still names the model that answered. */
const SCREEN = [
  "● Done.",
  "",
  ">",
  "~/projects/paper (develop) · Sonnet 4.5 · 85% context left",
];

/** What this window's xterm still shows for a pane that was hidden before the
 * `/model` switch: a hidden pane is fed no output until it is shown again. */
const STALE_SCREEN = [
  "● Done.",
  "",
  ">",
  "~/projects/paper (develop) · Opus 4.1 · 85% context left",
];

let liveScreen: string | null = null;

function pane(rows: string[]): Terminal {
  const buffer: ReadableBufferLike = {
    length: rows.length,
    getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }),
  };
  return { buffer: { active: buffer } } as unknown as Terminal;
}

async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const invokeMock = vi.mocked(invoke);
  deliver({ payload: request });
  await vi.waitFor(() => expect(invokeMock.mock.calls.some(
    ([command]) => command === "mobile_desktop_respond",
  )).toBe(true));
  const calls = invokeMock.mock.calls.filter(([command]) => command === "mobile_desktop_respond");
  const last = calls[calls.length - 1];
  return (last[1] as { response: Record<string, unknown> }).response;
}

describe("Mobile bridge — the model beside a tab", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      if (command === "agent_tab_recent_prompts") return Promise.resolve([]);
      if (command === "agent_tab_model") return Promise.resolve("claude-opus-4-1-20250805");
      if (command === "agent_prompt_history_list") return Promise.resolve([]);
      if (command === "local_tmux_screen") return Promise.resolve(liveScreen);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [paper], activeId: paper.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useAgentModelsStore.setState({ byTab: {}, promptByTab: {}, recentByTab: {}, screenByTab: {}, modeByTab: {}, goalByTab: {} });
    clearAgentModelFloorForTest();
    useTabsStore.setState({
      scope: paper.id,
      tabsByScope: {
        [paper.id]: [
          { key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: "/projects/paper", tmuxSession: TMUX, sessionId: "s-1" },
        ] satisfies TabEntry[],
      },
    });
    useActivityStore.setState({ busyByTab: { [PTY]: true } });
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    liveScreen = null;
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, attentionByScope: {} });
    useAgentModelsStore.setState({ byTab: {}, promptByTab: {}, recentByTab: {}, screenByTab: {}, modeByTab: {}, goalByTab: {} });
  });

  it("is what the session's own status line says, in its own words", async () => {
    const term = pane(SCREEN);
    registerTerminal(PTY, term);
    try {
      const answer = await ask({ type: "catalog", request_id: "m1", project_id: paper.id });
      expect(answer.statuses).toMatchObject([{ tmux_session: TMUX, model: "Sonnet 4.5" }]);
    } finally {
      unregisterTerminal(PTY, term);
    }
  });

  it("falls back to the transcript's model, shortened, when no pane here has the screen", async () => {
    await vi.waitFor(async () => {
      const answer = await ask({ type: "catalog", request_id: "m2", project_id: paper.id });
      expect(answer.statuses).toMatchObject([{ tmux_session: TMUX, model: "Opus 4.1" }]);
    });
  });

  it("says the same thing on the cross-project activity answer", async () => {
    const term = pane(SCREEN);
    registerTerminal(PTY, term);
    try {
      const answer = await ask({ type: "activity", request_id: "m3" });
      expect(answer.statuses).toMatchObject([{ tmux_session: TMUX, model: "Sonnet 4.5" }]);
    } finally {
      unregisterTerminal(PTY, term);
    }
  });

  it("reads the live tmux pane over a hidden pane's stale xterm", async () => {
    liveScreen = SCREEN.join("\n");
    // The busy edge in `beforeEach` already read a pane with no session.
    clearAgentModelFloorForTest();
    const term = pane(STALE_SCREEN);
    registerTerminal(PTY, term);
    try {
      await vi.waitFor(async () => {
        const answer = await ask({ type: "catalog", request_id: "m4", project_id: paper.id });
        expect(answer.statuses).toMatchObject([{ tmux_session: TMUX, model: "Sonnet 4.5" }]);
      });
    } finally {
      unregisterTerminal(PTY, term);
    }
  });

  it("keeps the last live reading while the status line is covered", async () => {
    liveScreen = SCREEN.join("\n");
    clearAgentModelFloorForTest();
    await vi.waitFor(async () => {
      const answer = await ask({ type: "catalog", request_id: "m5", project_id: paper.id });
      expect(answer.statuses).toMatchObject([{ tmux_session: TMUX, model: "Sonnet 4.5" }]);
    });
    // A dialog replaces the input box: no status line to read.
    liveScreen = "Do you want to proceed?\n❯ 1. Yes\n  2. No";
    clearAgentModelFloorForTest();
    await useAgentModelsStore.getState().refreshScreen(paper.id, useTabsStore.getState().tabsByScope[paper.id][0], true);
    const answer = await ask({ type: "catalog", request_id: "m6", project_id: paper.id });
    expect(answer.statuses).toMatchObject([{ tmux_session: TMUX, model: "Sonnet 4.5" }]);
  });

  it("carries the PLAN and GOAL marks the desktop's tab strip reads, and only while on", async () => {
    liveScreen = [">", "⏸ plan mode on (shift+tab to cycle) · ◎ /goal active (3m)"].join("\n");
    clearAgentModelFloorForTest();
    await vi.waitFor(async () => {
      const answer = await ask({ type: "catalog", request_id: "m8", project_id: paper.id });
      expect(answer.statuses).toMatchObject([{ tmux_session: TMUX, plan: true, goal: true }]);
    });
    liveScreen = SCREEN.join("\n");
    clearAgentModelFloorForTest();
    await useAgentModelsStore.getState().refreshScreen(paper.id, useTabsStore.getState().tabsByScope[paper.id][0], true);
    const answer = await ask({ type: "activity", request_id: "m9" });
    const [row] = answer.statuses as Record<string, unknown>[];
    expect(row).not.toHaveProperty("plan");
    expect(row).not.toHaveProperty("goal");
  });

  it("takes the goal from the session's own record, whatever the footer shows", async () => {
    const fallback = vi.mocked(invoke).getMockImplementation()!;
    let goal: boolean | null = true;
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) =>
      command === "agent_tab_goal" ? Promise.resolve(goal) : fallback(command, args as never));
    // A footer the parser reads no goal in: a statusline and the mode row only.
    liveScreen = [">", "me@box:~/paper (main) · Opus 5.5", "⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
    clearAgentModelFloorForTest();
    await vi.waitFor(async () => {
      const answer = await ask({ type: "catalog", request_id: "g1", project_id: paper.id });
      expect(answer.statuses).toMatchObject([{ tmux_session: TMUX, goal: true }]);
    });
    // Met: the record says so, and the mark goes, though no footer ever showed it.
    goal = false;
    clearAgentModelFloorForTest();
    await vi.waitFor(async () => {
      const answer = await ask({ type: "catalog", request_id: "g2", project_id: paper.id });
      expect((answer.statuses as Record<string, unknown>[])[0]).not.toHaveProperty("goal");
    });
  });

  it("marks a quiet tab in plan mode", async () => {
    useActivityStore.setState({ busyByTab: {} });
    useAgentModelsStore.setState({ byTab: {} });
    liveScreen = [">", "⏸ plan mode on (shift+tab to cycle)"].join("\n");
    clearAgentModelFloorForTest();
    await vi.waitFor(async () => {
      const answer = await ask({ type: "catalog", request_id: "m10", project_id: paper.id });
      expect(answer.timings).toMatchObject([{ tmux_session: TMUX, plan: true }]);
    });
  });

  it("tags a quiet tab too", async () => {
    useActivityStore.setState({ busyByTab: {} });
    liveScreen = SCREEN.join("\n");
    clearAgentModelFloorForTest();
    await vi.waitFor(async () => {
      const answer = await ask({ type: "catalog", request_id: "m7", project_id: paper.id });
      expect(answer.statuses).toEqual([]);
      expect(answer.timings).toMatchObject([{ tmux_session: TMUX, model: "Sonnet 4.5" }]);
    });
  });
});
