/**
 * Regression tests for agent-tab path contamination across projects.
 *
 * Root cause 1: loadFromLayout() in projects.ts was called without targetScope.
 * When switch_project_runtime resolved after the user had already switched to a
 * different project, the returned tabs were written into whatever scope was
 * active at resolution time — so e.g. one project's scope could receive another's
 * layout (or vice versa), and the agent tab's cwd would be wrong.
 * Fix: always pass targetScope.
 *
 * Root cause 2: CenterPanel's load_project .then() had no guard against
 * calling loadFromLayout when tabs were already populated by switch_project_runtime.
 * Both paths fired concurrently; whichever resolved second won the race and
 * could (a) overwrite a larger layout with a smaller one, or (b) if the layouts
 * had drifted between project.json and terminals.json, produce the wrong number
 * of tabs or the wrong agent cwd.
 * Fix: check tabsByScope[scopeForLoad].length === 0 inside the .then() callback
 * before calling loadFromLayout, mirroring the guard already in projects.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { useTabsStore } from "../../stores/tabs";
import { envName } from "../../lib/brand";

describe("loadFromLayout — scope isolation", () => {
  beforeEach(() => {
    // Merge-reset the data fields only so function implementations are preserved.
    useTabsStore.setState({
      scope: "project-a",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
  });

  it("writes to targetScope even when current scope differs", () => {
    const layout = [
      { key: "agent-1", label: "claude", cmd: "claude", cwd: "/stale", kind: "agent" as const },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-b-dir", "project-b");

    const state = useTabsStore.getState();
    expect(state.tabsByScope["project-b"]).toHaveLength(1);
    expect(state.tabsByScope["project-a"]).toBeFalsy();
    // flat shortcuts are NOT updated (current scope is still project-a)
    expect(state.tabs).toHaveLength(0);
    expect(state.activeKey).toBeNull();
  });

  it("agent tab cwd is replaced by defaultCwd unless it is a worktree or a passed agent root", () => {
    const layout = [
      { key: "agent-2", label: "claude", cmd: "claude", cwd: "/saved-cwd", kind: "agent" as const },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/default-cwd", "project-c");

    const tab = useTabsStore.getState().tabsByScope["project-c"]?.[0];
    expect(tab?.cwd).toBe("/default-cwd");
    expect(tab?.cwd).not.toContain("saved-cwd");
  });

  it("agent tab keeps a cwd that is one of the agent roots the caller passes (box members)", () => {
    const layout = [
      { key: "a1", label: "claude — P", cmd: "claude", cwd: "/members/p", kind: "agent" as const },
      { key: "a2", label: "claude", cmd: "claude", cwd: "/stale/elsewhere", kind: "agent" as const },
    ];

    useTabsStore
      .getState()
      .loadFromLayout(layout, "/boxes/b1", "box:b1", undefined, { agentRoots: ["/members/p"] });

    const tabs = useTabsStore.getState().tabsByScope["box:b1"] ?? [];
    expect(tabs.map((t) => t.cwd)).toEqual(["/members/p", "/boxes/b1"]);
  });

  it("shell tab cwd is kept from layout (only agents are overridden)", () => {
    const layout = [
      { key: "shell-1", label: "bash", cmd: "bash", cwd: "/some/shell/dir", kind: "shell" as const },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-dir", "project-x");

    const tab = useTabsStore.getState().tabsByScope["project-x"]?.[0];
    expect(tab?.cwd).toBe("/some/shell/dir");
  });

  it("does not overwrite an already-populated scope (guard matches projects.ts check)", () => {
    // Pre-populate project-b with a live tab
    const live = [
      { key: "agent-live", label: "claude", cmd: "claude", cwd: "/correct", kind: "agent" as const },
    ];
    useTabsStore.getState().loadFromLayout(live, "/correct", "project-b");

    // Simulate a late async resolve trying to overwrite project-b
    const stale = [
      { key: "agent-stale", label: "claude", cmd: "claude", cwd: "/wrong", kind: "agent" as const },
    ];
    const liveTabs = useTabsStore.getState().tabsByScope["project-b"];
    if (!liveTabs || liveTabs.length === 0) {
      useTabsStore.getState().loadFromLayout(stale, "/wrong", "project-b");
    }

    // Still has the original live tab, not the stale one
    expect(useTabsStore.getState().tabsByScope["project-b"]).toHaveLength(1);
    expect(useTabsStore.getState().tabsByScope["project-b"][0].cwd).toBe("/correct");
  });

  it("restoring the same saved key into two scopes yields distinct keys (PTY id collision)", () => {
    // Two projects can both have persisted "agent-1" (the key counter resets
    // every session). Restored tabs must never share a key, otherwise both
    // projects attach to the same PTY.
    const savedLayout = [
      { key: "agent-1", label: "claude", cmd: "claude", cwd: "/stale", kind: "agent" as const },
    ];

    useTabsStore.getState().loadFromLayout(savedLayout, "/gedpaths", "project-gedpaths");
    useTabsStore.getState().loadFromLayout(savedLayout, "/libgraph", "project-libgraph");

    const a = useTabsStore.getState().tabsByScope["project-gedpaths"][0];
    const b = useTabsStore.getState().tabsByScope["project-libgraph"][0];
    expect(a.key).not.toBe(b.key);
  });

  it("flat tabs and activeKey reflect targetScope when targetScope equals current scope", () => {
    useTabsStore.getState().setScope("project-c");

    const layout = [
      { key: "agent-c1", label: "claude", cmd: "claude", cwd: "/stale-c", kind: "agent" as const },
      { key: "agent-c2", label: "gemini", cmd: "gemini", cwd: "/stale-c", kind: "agent" as const },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-c-dir", "project-c");

    const state = useTabsStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeKey).toBe(state.tabs[0].key);
    expect(state.tabs[0].cwd).toBe("/project-c-dir");
    expect(state.tabs[1].cwd).toBe("/project-c-dir");
  });
});

/**
 * Dual-path loading race: switch_project_runtime (projects.ts) and
 * load_project (CenterPanel) both fire when tabs are empty.  Whichever
 * resolves first wins; the second must skip via a guard.
 *
 * These tests encode the guard logic that lives in CenterPanel's .then():
 *   if ((useTabsStore.getState().tabsByScope[scopeForLoad]?.length ?? 0) > 0) return;
 * and the matching guard already in projects.ts setActive .then().
 */
describe("dual-path loading race — CenterPanel guard", () => {
  beforeEach(() => {
    useTabsStore.setState({
      scope: "project-b",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
  });

  it("switch_project_runtime wins: load_project guard prevents second loadFromLayout call", () => {
    const sessionLayout = [
      { key: "agent-s1", label: "claude", cmd: "claude", cwd: "/stale", kind: "agent" as const },
    ];
    const projectJsonLayout = [
      { key: "agent-s1", label: "claude", cmd: "claude", cwd: "/stale", kind: "agent" as const },
    ];
    const projectCwd = "/project-b";

    // switch_project_runtime path (projects.ts guard) — resolves first
    const liveBefore = useTabsStore.getState().tabsByScope["project-b"];
    if (!liveBefore || liveBefore.length === 0) {
      useTabsStore.getState().loadFromLayout(sessionLayout, projectCwd, "project-b");
    }

    // load_project path (CenterPanel guard) — resolves second
    const liveAfter = useTabsStore.getState().tabsByScope["project-b"];
    if (!liveAfter || liveAfter.length === 0) {
      useTabsStore.getState().loadFromLayout(projectJsonLayout, projectCwd, "project-b");
    }

    expect(useTabsStore.getState().tabsByScope["project-b"]).toHaveLength(1);
    expect(useTabsStore.getState().tabsByScope["project-b"][0].label).toBe("claude");
  });

  it("load_project wins: switch_project_runtime guard prevents second loadFromLayout call", () => {
    const projectJsonLayout = [
      { key: "agent-p1", label: "claude", cmd: "claude", cwd: "/stale", kind: "agent" as const },
    ];
    const sessionLayout = [
      { key: "agent-p1", label: "claude", cmd: "claude", cwd: "/stale", kind: "agent" as const },
    ];
    const projectCwd = "/project-b";

    // CenterPanel path — resolves first (no guard needed here, tabs are empty)
    useTabsStore.getState().loadFromLayout(projectJsonLayout, projectCwd, "project-b");

    // switch_project_runtime path — resolves second, uses its guard
    const liveTabs = useTabsStore.getState().tabsByScope["project-b"];
    if (!liveTabs || liveTabs.length === 0) {
      useTabsStore.getState().loadFromLayout(sessionLayout, projectCwd, "project-b");
    }

    expect(useTabsStore.getState().tabsByScope["project-b"]).toHaveLength(1);
    expect(useTabsStore.getState().tabsByScope["project-b"][0].cwd).toBe(projectCwd);
  });

  it("session file (switch_project_runtime) has more tabs than project.json — session wins, correct tab count preserved", () => {
    // Simulates drift: terminals.json had 2 tabs, project.json had only 1.
    const sessionLayout = [
      { key: "agent-1", label: "claude", cmd: "claude", cwd: "/stale", kind: "agent" as const },
      { key: "agent-2", label: "gemini", cmd: "gemini", cwd: "/stale", kind: "agent" as const },
    ];
    const projectJsonLayout = [
      { key: "agent-1", label: "claude", cmd: "claude", cwd: "/stale", kind: "agent" as const },
    ];
    const projectCwd = "/project-b";

    // switch_project_runtime resolves first with the 2-tab session layout
    const live1 = useTabsStore.getState().tabsByScope["project-b"];
    if (!live1 || live1.length === 0) {
      useTabsStore.getState().loadFromLayout(sessionLayout, projectCwd, "project-b");
    }

    // CenterPanel's load_project resolves second — guard must prevent it from
    // replacing the 2-tab result with only 1 tab (the wrong-agent-count bug).
    const live2 = useTabsStore.getState().tabsByScope["project-b"];
    if (!live2 || live2.length === 0) {
      useTabsStore.getState().loadFromLayout(projectJsonLayout, projectCwd, "project-b");
    }

    expect(useTabsStore.getState().tabsByScope["project-b"]).toHaveLength(2);
  });

  it("switch_project_runtime loaded correct cwd — load_project must not overwrite with wrong cwd", () => {
    // Simulates the wrong-path bug: switch_project_runtime loaded the agent
    // with the correct projectCwd, but an unguarded load_project call would
    // later call loadFromLayout with an empty defaultCwd (resolveProjectDirectory
    // returned ""), causing the agent to fall back to its stale saved cwd.
    const sessionLayout = [
      { key: "agent-1", label: "claude", cmd: "claude", cwd: "/stale-from-other-project", kind: "agent" as const },
    ];
    const correctCwd = "/project-b";

    // switch_project_runtime loads first with correct projectCwd
    const live1 = useTabsStore.getState().tabsByScope["project-b"];
    if (!live1 || live1.length === 0) {
      useTabsStore.getState().loadFromLayout(sessionLayout, correctCwd, "project-b");
    }
    expect(useTabsStore.getState().tabsByScope["project-b"]![0].cwd).toBe(correctCwd);

    // load_project with empty defaultCwd (simulates resolveProjectDirectory returning "")
    // Without the guard this would override the agent cwd with the stale saved value.
    const live2 = useTabsStore.getState().tabsByScope["project-b"];
    if (!live2 || live2.length === 0) {
      // defaultCwd = "" → agent would fall back to t.cwd = "/stale-from-other-project"
      useTabsStore.getState().loadFromLayout(sessionLayout, "", "project-b");
    }

    // Agent must still have the correct cwd set by switch_project_runtime
    expect(useTabsStore.getState().tabsByScope["project-b"]![0].cwd).toBe(correctCwd);
  });
});

/**
 * Resume-on-restore: a resumable agent tab (Claude with a sessionId) must come
 * back launched with `--resume <id>` so its conversation resumes; a non-resumable
 * agent (no map entry, or no sessionId) must NOT receive resume args.
 */
describe("loadFromLayout — resume args", () => {
  beforeEach(() => {
    useTabsStore.setState({
      scope: "project-r",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
  });

  it("resumable Claude agent restores with --resume <id> and carries sessionId", () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    const layout = [
      { key: "agent-1", label: "claude", cmd: "claude", cwd: "/stale", kind: "agent" as const, sessionId: sid },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-r-dir", "project-r");

    const tab = useTabsStore.getState().tabsByScope["project-r"]![0];
    expect(tab.args).toEqual(["--resume", sid]);
    expect(tab.sessionId).toBe(sid);
  });

  it("resumable Codex agent restores with its binding key repaired in env", () => {
    const sid = "codex-tab-key-1";
    const layout = [
      {
        key: "agent-1",
        label: "codex",
        cmd: "codex",
        cwd: "/stale",
        kind: "agent" as const,
        sessionId: sid,
        // Older layouts omitted this field, while a malformed one could carry
        // the binding key from a different tab. Both must resolve to `sid`.
        env: { [envName("TAB_UID")]: "wrong-tab-key", KEEP_ME: "yes" },
      },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-r-dir", "project-r");

    const tab = useTabsStore.getState().tabsByScope["project-r"]![0];
    // Codex's sessionId is only the TABTIVITY_TAB_UID key, not a Codex session id,
    // so the frontend passes no resume args; the backend resolves the live id.
    expect(tab.args).toEqual([]);
    expect(tab.sessionId).toBe(sid);
    expect(tab.env).toEqual({ [envName("TAB_UID")]: sid, KEEP_ME: "yes" });
  });

  it("Claude agent without a sessionId gets no resume args", () => {
    const layout = [
      { key: "agent-1", label: "claude", cmd: "claude", cwd: "/stale", kind: "agent" as const },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-r-dir", "project-r");

    const tab = useTabsStore.getState().tabsByScope["project-r"]![0];
    expect(tab.args).toEqual([]);
    expect(tab.sessionId).toBeUndefined();
  });

  it("continue-last agent (gemini) restores with --resume latest and carries sessionId", () => {
    const layout = [
      { key: "agent-1", label: "gemini", cmd: "gemini", cwd: "/stale", kind: "agent" as const, sessionId: "abc" },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-r-dir", "project-r");

    const tab = useTabsStore.getState().tabsByScope["project-r"]![0];
    // Gemini's `--resume` continues the project's most-recent session ("latest"),
    // since its `--resume` takes latest/index, not the launch uuid.
    expect(tab.args).toEqual(["--resume", "latest"]);
    expect(tab.sessionId).toBe("abc");
  });

  it("Vibe restores its stable tab key for exact backend resume, with --continue as fallback", () => {
    const layout = [
      { key: "agent-1", label: "vibe", cmd: "vibe", cwd: "/stale", kind: "agent" as const, sessionId: "vibe-key-1" },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-r-dir", "project-r");

    const tab = useTabsStore.getState().tabsByScope["project-r"]![0];
    expect(tab.args).toEqual(["--continue"]);
    expect(tab.sessionId).toBe("vibe-key-1");
    expect(tab.env?.[envName("TAB_UID")]).toBe("vibe-key-1");
  });

  it("agent with no wired resume (aider) with a sessionId gets no resume args", () => {
    const layout = [
      { key: "agent-1", label: "aider", cmd: "aider", cwd: "/stale", kind: "agent" as const, sessionId: "abc" },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-r-dir", "project-r");

    const tab = useTabsStore.getState().tabsByScope["project-r"]![0];
    expect(tab.args).toEqual([]);
    // sessionId is still carried through (durable), but no resume launch.
    expect(tab.sessionId).toBe("abc");
  });
});
