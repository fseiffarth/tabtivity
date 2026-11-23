/**
 * The phone's local-model "what's next" through the window (user decision
 * 2026-11-22): the bridge asks `agent_next_prompt` with the very arguments the
 * Reader sends (`nextPromptArgs`), so the backend names the phone's ask and the
 * window composer's by one session and runs a turn once. A warm-up stands
 * aside while a local-model agent tab is in a turn.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { nextPromptArgs } from "../../lib/agents/nextPrompt";
import { useActivityStore } from "../../stores/activity";
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

const CODEX_TMUX = `${BRAND.slug}-p_paper--agent-333333333`;
const codex: TabEntry = { key: "agent-3", label: "Codex", kind: "agent", cmd: "codex", cwd: "/projects/paper", tmuxSession: CODEX_TMUX, sessionId: "s-3" };
const local: TabEntry = { key: "agent-4", label: "Local", kind: "local_agent", cmd: "ollama", cwd: "/projects/paper", tmuxSession: `${BRAND.slug}-p_paper--agent-444444444` };

async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();
  deliver({ payload: request });
  await vi.waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === "mobile_desktop_respond")).toBe(true));
  const call = invokeMock.mock.calls.find(([command]) => command === "mobile_desktop_respond");
  return (call?.[1] as { response: Record<string, unknown> }).response;
}

const asked = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "agent_next_prompt");

describe("Mobile bridge — the local-model next prompt", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "agent_next_prompt") return Promise.resolve({ text: "Run the whole suite", turnKey: "k", status: "ok", model: "qwen3:4b" });
      if (command === "list_agents" || command === "agent_schedules_list") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [paper], activeId: paper.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useTabsStore.setState({ scope: paper.id, tabsByScope: { [paper.id]: [codex, local] } });
    useActivityStore.setState({ busyByTab: {} });
    render(<MobileBridgeHost />);
  });
  afterEach(() => cleanup());

  it("asks with the Reader's own arguments and answers text, outcome and model", async () => {
    const response = await ask({ type: "agent_next_prompt", request_id: "n1", project_id: paper.id, tmux_session: CODEX_TMUX, phase: "final" });
    expect(response).toEqual({ status: "agent_next_prompt", text: "Run the whole suite", outcome: "ok", model: "qwen3:4b" });
    expect(asked()).toHaveLength(1);
    expect(asked()[0][1]).toEqual(nextPromptArgs(paper.id, codex, "/projects/paper", undefined, "final"));
  });

  it("lets a warm-up stand aside while a local-model tab is in a turn", async () => {
    useActivityStore.setState({ busyByTab: { [`${paper.id}:${local.key}`]: true } });
    const warm = await ask({ type: "agent_next_prompt", request_id: "n2", project_id: paper.id, tmux_session: CODEX_TMUX, phase: "warm" });
    expect(warm).toEqual({ status: "agent_next_prompt", text: null, outcome: "skipped" });
    expect(asked()).toHaveLength(0);
    // The turn's own suggestion is still asked.
    const final = await ask({ type: "agent_next_prompt", request_id: "n3", project_id: paper.id, tmux_session: CODEX_TMUX, phase: "final" });
    expect(final).toMatchObject({ outcome: "ok" });
  });

  it("answers an unknown tab as not found and a bad phase without asking", async () => {
    const gone = await ask({ type: "agent_next_prompt", request_id: "n4", project_id: paper.id, tmux_session: "nope", phase: "final" });
    expect(gone).toMatchObject({ status: "error", code: "tab_not_found" });
    const bad = await ask({ type: "agent_next_prompt", request_id: "n5", project_id: paper.id, tmux_session: CODEX_TMUX, phase: "now" });
    expect(bad).toEqual({ status: "agent_next_prompt", text: null, outcome: "unavailable" });
    expect(asked()).toHaveLength(0);
  });
});
