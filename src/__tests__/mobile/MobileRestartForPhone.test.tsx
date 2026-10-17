/**
 * The phone opening an agent tab that was running before the project's Mobile
 * switch went on. That tab runs outside tmux (`lib/terminal/mobileTmuxReady`),
 * so the phone lists it as not available; its tap asks the desktop to restart
 * it inside tmux on its resume args — only while the agent is idle, and only
 * when a restart keeps its conversation.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { useActivityStore } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { TabEntry } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";
import { RESUMABLE_AGENTS } from "../../lib/agents/agentClis";
import { BRAND, MOBILE_ACCESS_KEY, NAMES } from "../../lib/brand";
import { mobileAgentTmuxReady, mobileTmuxReadiness, mobileTmuxReadyKey } from "../../lib/terminal/mobileTmuxReady";

const project: ProjectEntry = {
  id: "p1",
  name: "Paper",
  status: "active",
  position: 1,
  local_file: "/projects/paper/project.json",
  [MOBILE_ACCESS_KEY]: true,
};

const TMUX = `${BRAND.slug}-p1--agent-123456789`;
const SESSION = "0b9c6a52-5d55-4c3e-9f57-3f2b1a0c9d11";

function agentTab(extra: Partial<TabEntry> = {}): TabEntry {
  return { key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: "/projects/paper", tmuxSession: TMUX, sessionId: SESSION, ...extra };
}

async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();
  deliver({ payload: request });
  await vi.waitFor(() => expect(invokeMock.mock.calls.some(
    ([command]) => command === "mobile_desktop_respond",
  )).toBe(true));
  const call = invokeMock.mock.calls.find(([command]) => command === "mobile_desktop_respond");
  return (call?.[1] as { response: Record<string, unknown> }).response;
}

function openFromPhone() {
  return ask({ type: "activate", request_id: "r1", project_id: project.id, tmux_session: TMUX });
}

function tabNow(): TabEntry | undefined {
  return useTabsStore.getState().tabsByScope[project.id]?.[0];
}

describe("Mobile bridge — an agent tab started before Mobile access", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    mobileAgentTmuxReady.clear();
    useProjectsStore.setState({ projects: [project], activeId: project.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useTabsStore.setState({ scope: project.id, tabsByScope: { [project.id]: [agentTab()] } });
    useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, attentionByScope: {} });
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    mobileAgentTmuxReady.clear();
    useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, attentionByScope: {} });
  });

  it("restarts an idle resumable agent inside tmux on its resume args", async () => {
    mobileAgentTmuxReady.set(mobileTmuxReadyKey(project.id, "agent-1"), false);
    const response = await openFromPhone();
    expect(response.status).toBe("activated");
    expect(mobileTmuxReadiness(project.id, "agent-1")).toBe(true);
    expect(tabNow()?.relaunchSeq).toBe(1);
    expect(tabNow()?.args).toEqual(RESUMABLE_AGENTS.claude(SESSION));
  });

  it("leaves a working or asking agent alone", async () => {
    mobileAgentTmuxReady.set(mobileTmuxReadyKey(project.id, "agent-1"), false);
    useActivityStore.setState({ busyByTab: { [`${project.id}:agent-1`]: true } });
    expect(await openFromPhone()).toMatchObject({ status: "error", code: "agent_busy" });
    useActivityStore.setState({ busyByTab: {}, attentionByTab: { [`${project.id}:agent-1`]: "decision" } });
    expect(await openFromPhone()).toMatchObject({ status: "error", code: "agent_busy" });
    expect(mobileTmuxReadiness(project.id, "agent-1")).toBe(false);
    expect(tabNow()?.relaunchSeq).toBeUndefined();
  });

  it("refuses a tab whose restart would lose its conversation", async () => {
    useTabsStore.setState({ tabsByScope: { [project.id]: [agentTab({ sessionId: undefined })] } });
    mobileAgentTmuxReady.set(mobileTmuxReadyKey(project.id, "agent-1"), false);
    expect(await openFromPhone()).toMatchObject({ status: "error", code: "tab_not_resumable" });
    expect(tabNow()?.relaunchSeq).toBeUndefined();
  });

  it("says a wrapped tab whose session ended is gone instead of restarting it", async () => {
    mobileAgentTmuxReady.set(mobileTmuxReadyKey(project.id, "agent-1"), true);
    expect(await openFromPhone()).toMatchObject({ status: "error", code: "session_gone" });
    expect(tabNow()?.relaunchSeq).toBeUndefined();
  });

  it("does nothing to a tab no pane has drawn yet: its first render wraps it", async () => {
    expect((await openFromPhone()).status).toBe("activated");
    expect(mobileTmuxReadiness(project.id, "agent-1")).toBeUndefined();
    expect(tabNow()?.relaunchSeq).toBeUndefined();
  });

  it("leaves tabs alone when persistent local sessions are off", async () => {
    useSettingsStore.setState({ settings: { persist_local_sessions: false } as Settings, loaded: true });
    mobileAgentTmuxReady.set(mobileTmuxReadyKey(project.id, "agent-1"), false);
    expect(await openFromPhone()).toMatchObject({ status: "error", code: "session_gone" });
    expect(tabNow()?.relaunchSeq).toBeUndefined();
  });
});
