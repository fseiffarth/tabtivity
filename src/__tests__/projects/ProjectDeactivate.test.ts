import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  message: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (...args: unknown[]) => mocks.message(...args),
}));

import { useProjectsStore } from "../../stores/projects";
import { useStopProjectStore } from "../../stores/stopProjectPrompt";
import { useTabsStore, type GroupNode, type TabEntry } from "../../stores/tabs";

/** The in-app confirmation stands in for the native `confirm()` this used to
 *  mock: `deactivateProject` awaits `request()`, so answering it IS the test's
 *  "the user clicked Stop". Answering synchronously keeps every case a plain
 *  `await deactivateProject(...)`. */
function answerStopPrompt(proceed: boolean) {
  const asked = vi.fn();
  useStopProjectStore.setState({
    request: (name, tabs, sessions, remoteSessions) => {
      asked(name, tabs, sessions, remoteSessions);
      return Promise.resolve(proceed);
    },
  });
  return asked;
}

const project = (id: string, status: string, position: number): ProjectEntry => ({
  id,
  name: id,
  status,
  position,
  local_file: `/p/${id}/project.json`,
});

const shell: TabEntry = {
  key: "shell-1",
  scope: "a",
  label: "Shell",
  cmd: "",
  cwd: "/p/a",
  kind: "shell",
  tmuxAttach: "train",
};
const layout: GroupNode = {
  type: "group",
  id: "g-a",
  tabKeys: [shell.key],
  activeKey: shell.key,
};

describe("project deactivation", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    mocks.message.mockReset();
    mocks.message.mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [project("a", "current", 0), project("b", "active", 1)],
      activeId: "a",
    });
    useTabsStore.setState({
      scope: "a",
      tabs: [shell],
      layout,
      focusedGroupId: layout.id,
      activeKey: shell.key,
      tabsByScope: { a: [shell] },
      layoutByScope: { a: layout },
      focusedGroupByScope: { a: layout.id },
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      pendingRespawnByScope: {},
    });
  });

  it("saves, stops tab-owned sessions and PTYs, switches, then unloads the scope", async () => {
    const asked = answerStopPrompt(true);
    await useProjectsStore.getState().deactivateProject("a");

    // The dialog is told what it is about to stop — the project by name, the tab
    // itself (not just a count), and the persistent session behind it.
    expect(asked).toHaveBeenCalledWith(
      "a",
      [expect.objectContaining({ key: shell.key, label: "Shell", kind: "shell" })],
      1,
      0,
    );
    const commands = mocks.invoke.mock.calls.map((call) => call[0]);
    expect(commands.indexOf("workspace_sync")).toBeLessThan(commands.indexOf("local_tmux_kill"));
    expect(commands.indexOf("local_tmux_kill")).toBeLessThan(commands.indexOf("pty_kill_scope"));
    expect(mocks.invoke).toHaveBeenCalledWith("local_tmux_kill", { session: "train" });
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill_scope", { scope: "a" });
    expect(useProjectsStore.getState().projects.find((p) => p.id === "a")?.status).toBe("inactive");
    expect(useProjectsStore.getState().activeId).toBe("b");
    expect(useTabsStore.getState().tabsByScope.a).toBeUndefined();
  });

  it("leaves remote tmux sessions running and never dials the host", async () => {
    // A persistent session on a remote host survives the project closing — that
    // is what it is for, and the host may be unreachable right now. Only the
    // project's Sessions view kills remote sessions (`remote_tmux_kill`).
    const remoteShell: TabEntry = { ...shell, location: "remote", tmuxAttach: "gpu-train" };
    useProjectsStore.setState({
      projects: [
        {
          ...project("a", "current", 0),
          remote: { host: "h", user: "u", remote_path: "/r" },
        } as ProjectEntry,
        project("b", "active", 1),
      ],
      activeId: "a",
    });
    useTabsStore.setState({ tabs: [remoteShell], tabsByScope: { a: [remoteShell] } });
    const asked = answerStopPrompt(true);
    await useProjectsStore.getState().deactivateProject("a");

    // The dialog counts it as KEPT (fourth argument), not as a session to stop.
    expect(asked).toHaveBeenCalledWith("a", expect.any(Array), 0, 1);
    expect(mocks.invoke).not.toHaveBeenCalledWith("remote_tmux_kill", expect.anything());
    expect(mocks.invoke).not.toHaveBeenCalledWith("local_tmux_kill", expect.anything());
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill_scope", { scope: "a" });
    expect(useProjectsStore.getState().projects.find((p) => p.id === "a")?.status).toBe("inactive");
    expect(useProjectsStore.getState().activeId).toBe("b");
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("hands the window to the next open project, or to none", async () => {
    useProjectsStore.setState({
      projects: [
        project("a", "current", 1),
        project("b", "active", 2),
        project("c", "inactive", 3),
      ],
      activeId: "a",
    });
    answerStopPrompt(true);
    await useProjectsStore.getState().deactivateProject("a");
    expect(useProjectsStore.getState().activeId).toBe("b");

    useProjectsStore.setState({
      projects: [project("b", "current", 1)],
      activeId: "b",
    });
    useTabsStore.setState({ tabsByScope: { b: [] } });
    await useProjectsStore.getState().deactivateProject("b");
    expect(useProjectsStore.getState().activeId).toBeNull();
  });

  it("does not stop anything when confirmation is declined", async () => {
    answerStopPrompt(false);
    await useProjectsStore.getState().deactivateProject("a");
    expect(mocks.invoke).not.toHaveBeenCalledWith("pty_kill_scope", expect.anything());
    expect(useProjectsStore.getState().projects[0].status).toBe("current");
    expect(useTabsStore.getState().tabsByScope.a).toHaveLength(1);
  });

  it("aborts before termination when the strict layout save fails", async () => {
    answerStopPrompt(true);
    mocks.invoke.mockImplementation((command: string) =>
      command === "workspace_sync"
        ? Promise.reject(new Error("disk full"))
        : Promise.resolve(undefined),
    );
    await useProjectsStore.getState().deactivateProject("a");
    expect(mocks.invoke).not.toHaveBeenCalledWith("local_tmux_kill", expect.anything());
    expect(mocks.invoke).not.toHaveBeenCalledWith("pty_kill_scope", expect.anything());
    expect(useProjectsStore.getState().projects[0].status).toBe("current");
    expect(mocks.message).toHaveBeenCalledOnce();
  });

  it("reports a persistent-session failure without hiding the project", async () => {
    answerStopPrompt(true);
    mocks.invoke.mockImplementation((command: string) =>
      command === "local_tmux_kill"
        ? Promise.reject(new Error("tmux failed"))
        : Promise.resolve(undefined),
    );
    await useProjectsStore.getState().deactivateProject("a");
    expect(mocks.invoke).not.toHaveBeenCalledWith("pty_kill_scope", expect.anything());
    expect(useProjectsStore.getState().projects[0].status).toBe("current");
    expect(useTabsStore.getState().tabsByScope.a).toHaveLength(1);
    expect(mocks.message).toHaveBeenCalledOnce();
  });
});
