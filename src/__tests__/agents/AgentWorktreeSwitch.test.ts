import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
// The old CLI's exit lands at once: the switch waits for it before moving.
vi.mock("../../lib/terminal/terminalBus", () => ({
  onTerminalExit: (_id: string, handler: () => void) => {
    setTimeout(handler, 0);
    return () => {};
  },
}));

import { switchAgentWorktree } from "../../stores/agents/agentWorktreeSwitch";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { BRAND, NAMES } from "../../lib/brand";

const SESSION = "11111111-1111-4111-8111-111111111111";
const TO = `/p1/${NAMES.worktreesDir}/feature`;

function agentTab(cmd: string, extra: Partial<TabEntry> = {}): TabEntry {
  return { key: `agent-${cmd}`, kind: "agent", cmd, label: cmd, cwd: "/p1", sessionId: SESSION, tmuxSession: `${BRAND.slug}-p1-${cmd}`, ...extra } as TabEntry;
}

function seed(tabs: TabEntry[]): void {
  useTabsStore.setState((state) => ({ tabsByScope: { ...state.tabsByScope, p1: tabs } }));
}

const stored = (key: string) => useTabsStore.getState().tabsByScope.p1?.find((tab) => tab.key === key);

describe("switchAgentWorktree", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    seed([]);
  });

  it("stops the CLI, moves its conversation, then respawns it in the worktree on its resume args", async () => {
    const calls: string[] = [];
    invokeMock.mockImplementation((command: string) => {
      calls.push(command);
      return Promise.resolve(command === "agent_tab_move_session" ? "carried" : undefined);
    });
    const tab = agentTab("claude");
    seed([tab]);
    await expect(switchAgentWorktree("p1", tab, TO, "claude · feature")).resolves.toBe("carried");
    expect(calls).toEqual(["local_tmux_kill", "pty_kill", "agent_tab_move_session"]);
    expect(invokeMock).toHaveBeenCalledWith("agent_tab_move_session", {
      agent: "claude", projectId: "p1", sessionId: SESSION, from: "/p1", to: TO,
    });
    const after = stored(tab.key);
    expect(after?.cwd).toBe(TO);
    expect(after?.label).toBe("claude · feature");
    expect(after?.args).toEqual(["--resume", SESSION]);
    expect(after?.relaunchSeq).toBe(1);
  });

  it("respawns the tab where it was when the conversation cannot be moved", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "agent_tab_move_session" ? Promise.reject(new Error("gone")) : Promise.resolve());
    const tab = agentTab("gemini");
    seed([tab]);
    await expect(switchAgentWorktree("p1", tab, TO, "x")).resolves.toBe("failed");
    const after = stored(tab.key);
    expect(after?.cwd).toBe("/p1");
    expect(after?.label).toBe("gemini");
    expect(after?.relaunchSeq).toBe(1);
  });

  it("never ends a tmux session the tab only attached to", async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_tab_move_session" ? "fresh" : undefined));
    const tab = agentTab("copilot", { tmuxAttach: "someone-else" } as Partial<TabEntry>);
    seed([tab]);
    await expect(switchAgentWorktree("p1", tab, TO, "copilot · feature")).resolves.toBe("fresh");
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain("local_tmux_kill");
    expect(stored(tab.key)?.cwd).toBe(TO);
  });
});
