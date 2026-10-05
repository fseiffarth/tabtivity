/**
 * What each session was last asked reaches the phone (#31ai).
 *
 * The phone's project overview and its flat Agents list both name a session by
 * its tab label, which is "Claude" for every one of them. The reading that
 * tells them apart is the prompt the session was given, and the desktop already
 * has it: the same transcript tail the model tag is read from
 * (`stores/agents/agentModels`, `agent_tab_recent_prompts`).
 *
 * Two things are load-bearing here and are what this file pins:
 *
 * - a **quiet** tab carries prompts. `projectAgentStatuses` returns before its
 *   own refresh for an idle tab — that is right for a status (the Agents list
 *   deliberately lists nothing quiet) and wrong for this, since the session
 *   nobody has prompted since this morning is exactly the one whose last prompt
 *   is worth reading;
 * - the answer is a **list**, bounded and oldest-first, not one line: the card
 *   shows the tail uncollapsed.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { useActivityStore } from "../../stores/activity";
import { clearAgentModelFloorForTest, useAgentModelsStore } from "../../stores/agents/agentModels";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
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

const BUSY_TMUX = `${BRAND.slug}-p_paper--agent-111111111`;
const QUIET_TMUX = `${BRAND.slug}-p_paper--agent-222222222`;

/** Oldest first, the way the transcript reads and the backend answers. */
const TAIL = [
  { text: "read the docs", at: "2026-09-17T08:00:00Z" },
  { text: "now fix the failing tests", at: "2026-09-17T08:20:00Z" },
];

interface PromptRow { tmux_session: string; prompts: { text: string; at?: string }[] }

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

/** The first answer is given while the transcript read it triggered is still in
 * flight, so the prompts land on the next poll — which is what the phone does. */
async function askUntilPrompts(request: Record<string, unknown>, expected = 2): Promise<PromptRow[]> {
  let rows: PromptRow[] = [];
  await vi.waitFor(async () => {
    rows = ((await ask({ ...request })) as { prompts?: PromptRow[] }).prompts ?? [];
    expect(rows.length).toBe(expected);
  });
  return rows;
}

describe("Mobile bridge — what a session was last asked", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      if (command === "agent_tab_recent_prompts") return Promise.resolve(TAIL);
      if (command === "agent_tab_model") return Promise.resolve("claude-opus-5");
      // The prompt history the transcript read adopts into; an empty one here
      // keeps this file about the bridge answer and not about the chart.
      if (command === "agent_prompt_history_list") return Promise.resolve([]);
      if (command === "agent_prompt_record") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [paper], activeId: paper.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useAgentModelsStore.setState({ byTab: {}, promptByTab: {}, recentByTab: {} });
    clearAgentModelFloorForTest();
    useTabsStore.setState({
      scope: paper.id,
      tabsByScope: {
        [paper.id]: [
          { key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: "/projects/paper", tmuxSession: BUSY_TMUX, sessionId: "s-1" },
          { key: "agent-2", label: "Claude", kind: "agent", cmd: "claude", cwd: "/projects/paper", tmuxSession: QUIET_TMUX, sessionId: "s-2" },
        ] satisfies TabEntry[],
      },
    });
    // Only the first tab is doing anything; the second is the quiet one.
    useActivityStore.setState({ busyByTab: { [`${paper.id}:agent-1`]: true } });
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, attentionByScope: {} });
    useAgentModelsStore.setState({ byTab: {}, promptByTab: {}, recentByTab: {} });
  });

  it("answers a catalog with every agent tab's prompt tail, quiet ones included", async () => {
    const rows = await askUntilPrompts({ type: "catalog", request_id: "r1", project_id: paper.id });
    expect(rows.map((row) => row.tmux_session).sort()).toEqual([BUSY_TMUX, QUIET_TMUX]);
    // The status list is the other half of the contract, and it still lists the
    // busy tab alone: a prompt line is not a claim that anything is running.
    const answer = await ask({ type: "catalog", request_id: "r2", project_id: paper.id });
    expect(answer.statuses).toMatchObject([{ tmux_session: BUSY_TMUX, status: "working" }]);
  });

  it("sends the tail oldest-first, so the newest prompt is the last one", async () => {
    const rows = await askUntilPrompts({ type: "catalog", request_id: "r3", project_id: paper.id });
    const quiet = rows.find((row) => row.tmux_session === QUIET_TMUX);
    expect(quiet?.prompts).toEqual(TAIL);
  });

  it("carries the same rows on the cross-project activity answer", async () => {
    const rows = await askUntilPrompts({ type: "activity", request_id: "r4" });
    expect(rows.map((row) => row.tmux_session).sort()).toEqual([BUSY_TMUX, QUIET_TMUX]);
  });

  it("says nothing about a project whose Mobile switch is off", async () => {
    useProjectsStore.setState({ projects: [{ ...paper, [MOBILE_ACCESS_KEY]: false }], activeId: paper.id, loaded: true });
    const answer = await ask({ type: "catalog", request_id: "r5", project_id: paper.id });
    expect(answer.prompts).toEqual([]);
  });

  it("keeps a phone-sent Codex prompt's time until its rollout is readable", async () => {
    useTabsStore.setState((state) => ({
      tabsByScope: {
        [paper.id]: state.tabsByScope[paper.id].map((tab) => tab.key === "agent-1"
          ? { ...tab, label: "Codex", cmd: "codex", sessionId: "codex-session" }
          : tab),
      },
    }));
    useAgentModelsStore.setState({ byTab: {}, promptByTab: {}, recentByTab: {} });
    useAgentPromptsStore.setState({ historyByProject: {
      [paper.id]: [{
        id: "phone-send",
        message: "keep the timestamp",
        created_at: "2026-09-21T10:00:00Z",
        sent_at: "2026-09-21T10:00:00Z",
        tab_label: "Codex",
        tab_id: "codex-session",
        result: "delivered",
      }],
    } });

    const answer = await ask({ type: "catalog", request_id: "codex-time", project_id: paper.id }) as unknown as { prompts: PromptRow[] };
    const codex = answer.prompts.find((row) => row.tmux_session === BUSY_TMUX);
    expect(codex?.prompts).toContainEqual({ text: "keep the timestamp", at: "2026-09-21T10:00:00Z" });
  });
});
