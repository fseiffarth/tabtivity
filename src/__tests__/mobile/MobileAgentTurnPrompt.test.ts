/**
 * A finished-turn push notice names the prompt the turn answered.
 *
 * The desktop re-reads the tab's transcript at the edge (the model store's
 * floor could still hold the turn before a quick one) and sends the newest
 * prompt with the edge; a backend or sidecar predating the field refuses the
 * request, and the bare edge still goes out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { reportAgentTurn } from "../../components/mobile/MobileBridgeHost";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { TabEntry } from "../../stores/tabs";
import type { ProjectBox, Settings } from "../../types";
import { BRAND, MOBILE_ACCESS_KEY } from "../../lib/brand";

const box: ProjectBox = {
  id: "b1",
  name: "Paper",
  member_ids: [],
  position: 10,
  folder: "/boxes/paper",
  [MOBILE_ACCESS_KEY]: true,
};
const TMUX = `${BRAND.slug}-box_b1--agent-123456789`;

function adminRequests() {
  return vi.mocked(invoke).mock.calls
    .filter(([command]) => command === "mobile_admin")
    .map(([, args]) => (args as { request: Record<string, unknown> }).request);
}

describe("agent-turn notice prompt", () => {
  let adminAnswer: (request: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    adminAnswer = () => Promise.resolve({ status: "ok" });
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "agent_tab_recent_prompts") {
        return Promise.resolve([
          { text: "an older one", at: "2026-09-28T10:00:00Z" },
          { text: "fix the failing tests", at: "2026-09-28T10:05:00Z" },
        ]);
      }
      if (command === "agent_prompt_history_list") return Promise.resolve([]);
      if (command === "mobile_admin") return adminAnswer((args as { request: Record<string, unknown> }).request);
      return Promise.resolve(undefined);
    });
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
    useBoxesStore.setState({ boxes: [box], loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useTabsStore.setState({
      scope: "root",
      tabsByScope: {
        "box:b1": [
          { key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: "/boxes/paper", tmuxSession: TMUX, sessionId: "s1" },
        ] satisfies TabEntry[],
      },
    });
    useAgentModelsStore.setState({ byTab: {}, promptByTab: {}, recentByTab: {} });
  });

  afterEach(() => {
    vi.mocked(invoke).mockReset();
    useBoxesStore.setState({ boxes: [], loaded: false });
  });

  it("sends the newest prompt with a finished turn, read fresh", async () => {
    await reportAgentTurn({ tmuxSession: TMUX, status: "done" });
    expect(adminRequests()).toEqual([
      { type: "agent_turn", tmux_session: TMUX, status: "done", prompt: "fix the failing tests" },
    ]);
  });

  it("sends a question bare, without reading anything", async () => {
    await reportAgentTurn({ tmuxSession: TMUX, status: "question" });
    expect(adminRequests()).toEqual([{ type: "agent_turn", tmux_session: TMUX, status: "question" }]);
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "agent_tab_recent_prompts")).toBe(false);
  });

  it("falls back to the bare edge when the far side refuses the prompt", async () => {
    adminAnswer = (request) => request.prompt
      ? Promise.reject(new Error("unknown field `prompt`"))
      : Promise.resolve({ status: "ok" });
    await reportAgentTurn({ tmuxSession: TMUX, status: "done" });
    expect(adminRequests()).toEqual([
      { type: "agent_turn", tmux_session: TMUX, status: "done", prompt: "fix the failing tests" },
      { type: "agent_turn", tmux_session: TMUX, status: "done" },
    ]);
  });

  it("sends the bare edge for a tab no phone can reach", async () => {
    await reportAgentTurn({ tmuxSession: `${BRAND.slug}-unknown`, status: "done" });
    expect(adminRequests()).toEqual([{ type: "agent_turn", tmux_session: `${BRAND.slug}-unknown`, status: "done" }]);
  });
});
