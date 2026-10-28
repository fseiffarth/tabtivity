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

import { carriesAcrossHosts, switchTabLocation } from "../../stores/agents/agentLocationSwitch";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { BRAND } from "../../lib/brand";
import type { ProjectEntry } from "../../types";

const SESSION = "11111111-1111-4111-8111-111111111111";

const REMOTE = {
  id: "p1",
  name: "p1",
  directory: "/state/p1",
  remote: { host: "gpu", remote_path: "/srv/p1" },
  compute_hosts: [{ id: "w1", host: "w1", remote_path: "/srv/p1" }],
} as unknown as ProjectEntry;

function agentTab(cmd: string, extra: Partial<TabEntry> = {}): TabEntry {
  return { key: `agent-${cmd}`, kind: "agent", cmd, label: cmd, cwd: "/srv/p1", sessionId: SESSION, location: "local", tmuxSession: `${BRAND.slug}-p1-${cmd}`, ...extra } as TabEntry;
}

function seed(tabs: TabEntry[], project: ProjectEntry = REMOTE): void {
  useProjectsStore.setState({ projects: [project] } as never);
  useTabsStore.setState((state) => ({ tabsByScope: { ...state.tabsByScope, p1: tabs } }));
}

const stored = (key: string) => useTabsStore.getState().tabsByScope.p1?.find((tab) => tab.key === key);

describe("carriesAcrossHosts", () => {
  it("is a Claude tab of a remote project changing the machine it runs on", () => {
    const tab = agentTab("claude");
    expect(carriesAcrossHosts(tab, REMOTE, "remote")).toBe(true);
    expect(carriesAcrossHosts({ ...tab, location: "remote" }, REMOTE, "host:w1")).toBe(true);
    expect(carriesAcrossHosts(tab, REMOTE, "local")).toBe(false);
    expect(carriesAcrossHosts(agentTab("codex"), REMOTE, "remote")).toBe(false);
    expect(carriesAcrossHosts({ ...tab, sessionId: undefined }, REMOTE, "remote")).toBe(false);
    expect(carriesAcrossHosts(tab, { ...REMOTE, remote: undefined } as ProjectEntry, "remote")).toBe(false);
    expect(carriesAcrossHosts(tab, { ...REMOTE, vm: { enabled: true } } as ProjectEntry, "remote")).toBe(false);
  });
});

describe("switchTabLocation", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    seed([]);
  });

  it("stops the local CLI, takes its conversation to the host, then respawns it there on its resume args", async () => {
    const calls: string[] = [];
    invokeMock.mockImplementation((command: string) => {
      calls.push(command);
      return Promise.resolve(command === "agent_tab_move_host" ? "carried" : undefined);
    });
    const tab = agentTab("claude");
    seed([tab]);
    await expect(switchTabLocation("p1", tab, "remote")).resolves.toBe("carried");
    expect(calls).toEqual(["local_tmux_kill", "pty_kill", "agent_tab_move_host"]);
    expect(invokeMock).toHaveBeenCalledWith("agent_tab_move_host", {
      agent: "claude", projectId: "p1", sessionId: SESSION, from: null, to: "primary", tmuxSession: tab.tmuxSession,
    });
    const after = stored(tab.key);
    expect(after?.location).toBe("remote");
    expect(after?.args).toEqual(["--resume", SESSION]);
    expect(after?.relaunchSeq).toBe(1);
  });

  it("leaves a host's tmux session to the backend, which asks it first", async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_tab_move_host" ? "carried" : undefined));
    const tab = agentTab("claude", { location: "host:w1" });
    seed([tab]);
    await expect(switchTabLocation("p1", tab, "local")).resolves.toBe("carried");
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain("local_tmux_kill");
    expect(invokeMock).toHaveBeenCalledWith("agent_tab_move_host", expect.objectContaining({ from: "w1", to: null }));
    expect(stored(tab.key)?.location).toBe("local");
  });

  it("respawns the tab where it was when the conversation cannot be taken along", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "agent_tab_move_host" ? Promise.reject(new Error("the host is not connected")) : Promise.resolve());
    const tab = agentTab("claude");
    seed([tab]);
    await expect(switchTabLocation("p1", tab, "remote")).resolves.toBe("failed");
    const after = stored(tab.key);
    expect(after?.location).toBe("local");
    expect(after?.relaunchSeq).toBe(1);
  });

  it("switches any other agent plainly, as before", async () => {
    const tab = agentTab("codex");
    seed([tab]);
    await expect(switchTabLocation("p1", tab, "remote")).resolves.toBe("fresh");
    expect(invokeMock).not.toHaveBeenCalled();
    const after = stored(tab.key);
    expect(after?.location).toBe("remote");
    expect(after?.relaunchSeq).toBeUndefined();
  });
});
