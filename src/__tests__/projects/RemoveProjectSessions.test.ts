/**
 * Archiving or forgetting a project ends the LOCAL sessions its tabs own
 * before its tabs close and before the backend drops it (`removeProjectVia`),
 * as stopping it does: closing a tab only detaches it, and with the project
 * gone nothing would reattach it. A remote session is left running; a failed
 * end does not keep the project from being removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import type { ProjectEntry, Settings } from "../../types";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function project(id: string, remote = false): ProjectEntry {
  return {
    id,
    name: id,
    status: "active",
    position: 10,
    local_file: `/projects/${id}/project.json`,
    directory: `/projects/${id}`,
    ...(remote ? { remote: { host: "login.example.org", remote_path: "/h" } } : {}),
  } as ProjectEntry;
}

function seed(id: string, tabs: Partial<TabEntry>[], remote = false) {
  useProjectsStore.setState({ projects: [project(id, remote)], activeId: null });
  useTabsStore.setState((state) => ({ tabsByScope: { ...state.tabsByScope, [id]: tabs as TabEntry[] } }));
}

let calls: string[];

beforeEach(() => {
  calls = [];
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string, args?: { session?: string }) => {
    calls.push(args?.session ? `${cmd} ${args.session}` : cmd);
    return Promise.resolve(undefined);
  });
  useSettingsStore.setState({ settings: {} as Settings, loaded: true });
});

describe("removing a project ends its local sessions first", () => {
  it.each([
    ["archiveProject", "archive_project"],
    ["forgetProject", "forget_project"],
  ] as const)("%s ends a local shell's session before %s", async (verb, backend) => {
    seed("pa", [{ key: "s1", kind: "shell", cmd: "", label: "sh", cwd: "/projects/pa", tmuxSession: "s-shell" }]);
    await useProjectsStore.getState()[verb]("pa");
    expect(calls).toContain("local_tmux_kill s-shell");
    expect(calls.indexOf("local_tmux_kill s-shell")).toBeLessThan(calls.indexOf(backend));
    expect(useTabsStore.getState().tabsByScope.pa ?? []).toEqual([]);
  });

  it("leaves a remote tab's session on its host", async () => {
    seed("pr", [{ key: "s1", kind: "shell", cmd: "", label: "sh", cwd: "/h", tmuxSession: "s-remote", location: "remote" }], true);
    await useProjectsStore.getState().forgetProject("pr");
    expect(calls.some((c) => c.startsWith("local_tmux_kill"))).toBe(false);
    expect(calls).toContain("forget_project");
  });

  it("still removes the project when ending a session fails", async () => {
    seed("pf", [{ key: "s1", kind: "shell", cmd: "", label: "sh", cwd: "/projects/pf", tmuxSession: "s-stuck" }]);
    mockInvoke.mockImplementation((cmd: string) => {
      calls.push(cmd);
      return cmd === "local_tmux_kill" ? Promise.reject(new Error("busy")) : Promise.resolve(undefined);
    });
    await useProjectsStore.getState().forgetProject("pf");
    expect(calls).toContain("forget_project");
    expect(useProjectsStore.getState().projects.some((p) => p.id === "pf")).toBe(false);
  });
});
