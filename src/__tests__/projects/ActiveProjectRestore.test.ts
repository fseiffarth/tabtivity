/**
 * Active-but-not-current projects resume at startup.
 *
 * "Active" is the status of a project whose terminals were never stopped —
 * stopping them is exactly what `deactivateProject` does before it writes
 * "inactive". Restore used to be lazy per scope (CenterPanel's effect, on the
 * first visit), so a relaunch came back with only the CURRENT project running
 * and every other pill's tabs suspended until it was clicked. `load()` now
 * restores them all; `activateProject` does the same for a project promoted
 * mid-session (which is what makes an activated-from-Mobile project report its
 * agent tabs).
 *
 * Each test uses its own project ids: the "already tried" set that keeps an
 * empty layout from being re-read is module state, deliberately session-lived.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  restoreActiveProjectScopes,
  restoreProjectScope,
  useProjectsStore,
} from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import type { ProjectEntry } from "../../types";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function project(id: string, status: string): ProjectEntry {
  return {
    id,
    name: id,
    status,
    position: 10,
    local_file: `/projects/${id}/project.json`,
    directory: `/projects/${id}`,
  } as ProjectEntry;
}

/** A saved layout holding one shell tab, as `load_tab_session` returns it. */
function savedShell(label: string) {
  return { tabLayout: [{ key: "s1", label, cmd: "", cwd: "", kind: "shell" }] };
}

/** Route `load_tab_session` per project id; everything else resolves undefined. */
function sessionsBy(byId: Record<string, unknown>) {
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
    Promise.resolve(
      cmd === "workspace_snapshot" ? byId[args?.projectId as string] ?? { tabLayout: [] } : undefined,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockImplementation(() => Promise.resolve(undefined));
  useSettingsStore.setState({ settings: {} as never, loaded: true });
  useTabsStore.setState({
    scope: "root",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
});

describe("restoreActiveProjectScopes", () => {
  it("restores every active project's tabs and leaves current/inactive alone", async () => {
    useProjectsStore.setState({
      projects: [project("cur", "current"), project("act", "active"), project("off", "inactive")],
      activeId: "cur",
      loaded: true,
    });
    sessionsBy({
      cur: savedShell("current"),
      act: savedShell("background"),
      off: savedShell("stopped"),
    });

    await restoreActiveProjectScopes();

    const { tabsByScope } = useTabsStore.getState();
    expect(tabsByScope.act).toHaveLength(1);
    expect(tabsByScope.act[0].label).toBe("background");
    // The current project is CenterPanel's to restore (it also sets the scope);
    // an inactive one has had its terminals deliberately stopped.
    expect(tabsByScope.cur).toBeUndefined();
    expect(tabsByScope.off).toBeUndefined();
  });

  it("restoring a background scope does not move the live scope", async () => {
    useProjectsStore.setState({
      projects: [project("cur2", "current"), project("act2", "active")],
      activeId: "cur2",
      loaded: true,
    });
    useTabsStore.getState().setScope("cur2");
    sessionsBy({ act2: savedShell("background") });

    await restoreActiveProjectScopes();

    expect(useTabsStore.getState().scope).toBe("cur2");
    expect(useTabsStore.getState().tabs).toHaveLength(0);
    expect(useTabsStore.getState().tabsByScope.act2).toHaveLength(1);
  });

  it("creates NO scope key when nothing restorable was saved", async () => {
    // An absent key is what tells persistScope the scope was never hydrated —
    // the guard that keeps an unvisited project's saved layout from being erased.
    useProjectsStore.setState({
      projects: [project("empty", "active")],
      activeId: null,
      loaded: true,
    });
    sessionsBy({ empty: { tabLayout: [] } });

    await restoreActiveProjectScopes();

    expect("empty" in useTabsStore.getState().tabsByScope).toBe(false);
  });

  it("never overwrites a scope already loaded this session", async () => {
    useProjectsStore.setState({
      projects: [project("live", "active")],
      activeId: null,
      loaded: true,
    });
    useTabsStore.getState().loadFromLayout(
      [{ key: "k", label: "live", cmd: "", cwd: "/projects/live", kind: "shell" as const }],
      "/projects/live",
      "live",
    );
    sessionsBy({ live: savedShell("stale") });

    await restoreActiveProjectScopes();

    const tabs = useTabsStore.getState().tabsByScope.live;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].label).toBe("live");
  });

  it("reads each project once, so an empty layout is not re-read on every call", async () => {
    useProjectsStore.setState({
      projects: [project("once", "active")],
      activeId: null,
      loaded: true,
    });
    sessionsBy({ once: { tabLayout: [] } });

    await restoreActiveProjectScopes();
    await restoreActiveProjectScopes();

    const reads = mockInvoke.mock.calls.filter((c) => c[0] === "workspace_snapshot");
    expect(reads).toHaveLength(1);
  });
});

describe("load — the startup path", () => {
  it("brings up the active pills' tabs, not just the current project's", async () => {
    const saved: Record<string, unknown> = {
      boot_cur: savedShell("current"),
      boot_act: savedShell("background"),
    };
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_projects") {
        return Promise.resolve([project("boot_cur", "current"), project("boot_act", "active")]);
      }
      if (cmd === "root_work_dir") return Promise.resolve("/root");
      if (cmd === "workspace_snapshot") {
        return Promise.resolve(saved[args?.projectId as string] ?? { tabLayout: [] });
      }
      return Promise.resolve(undefined);
    });

    await useProjectsStore.getState().load();
    // The restore is chained on whenSettingsLoaded (already resolved here) and
    // then on its own load_tab_session; both are microtasks.
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(useProjectsStore.getState().activeId).toBe("boot_cur");
    expect(useTabsStore.getState().tabsByScope.boot_act).toHaveLength(1);
    expect(useTabsStore.getState().tabsByScope.boot_act[0].label).toBe("background");
  });
});

describe("restoreProjectScope — concurrent restores of one scope", () => {
  it("restores once when the startup pass and a switch overlap", async () => {
    // Both callers clear the in-memory guard (neither has written the key yet);
    // without the in-flight claim each would loadFromLayout, giving every tab a
    // second key and a second PTY.
    const p = project("race", "active");
    useProjectsStore.setState({ projects: [p], activeId: null, loaded: true });
    sessionsBy({ race: savedShell("only") });

    await Promise.all([restoreProjectScope(p), restoreProjectScope(p)]);

    expect(useTabsStore.getState().tabsByScope.race).toHaveLength(1);
  });
});

describe("activateProject", () => {
  it("starts the promoted project's tabs (the inverse of stopping them)", async () => {
    useProjectsStore.setState({
      projects: [project("promoted", "inactive")],
      activeId: null,
      loaded: true,
    });
    sessionsBy({ promoted: savedShell("resumed") });

    await useProjectsStore.getState().activateProject("promoted");
    // The restore is fire-and-forget: let its load_tab_session settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(useProjectsStore.getState().projects[0].status).toBe("active");
    const tabs = useTabsStore.getState().tabsByScope.promoted;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].label).toBe("resumed");
    // activeId is untouched: activating is not opening.
    expect(useProjectsStore.getState().activeId).toBeNull();
  });
});
