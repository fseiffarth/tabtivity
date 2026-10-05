/**
 * Detaching a project from its SSH host must re-point its tabs.
 *
 * The live bug this pins (DemoProj): while a project is remote its `directory` is the
 * state dir `~/.local/share/tabtivity/remote-projects/<id>/`, and `loadFromLayout` stores
 * exactly that as every tab's `cwd`. Nothing ever noticed, because `localTabCwd` rewrote
 * it at render time to the real mirror — an override gated on `isRemoteProject`.
 *
 * Detach flips that gate to false. The override stops firing, every tab falls back to the
 * stored cwd it should never have had, and agents relaunch inside the state dir — which
 * detach has just emptied. Claude keys its session history by cwd, so `--resume` then finds
 * no conversation (it lives under the mirror's path) and the agent starts asking for
 * permissions under `.local/share/tabtivity/remote-projects/…`.
 *
 * So: the fallback path is real, it is reachable, and `detachScopeFromRemote` is what keeps
 * it from being taken.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { localTabCwd, useTabsStore, type TabEntry } from "../../stores/tabs";
import { BRAND } from "../../lib/brand";

const STATE_DIR = `/home/u/.local/share/${BRAND.slug}/remote-projects/pid`;
const MIRROR = "/home/u/Documents/CodeProjectsGit/DemoProj";

function tab(over: Partial<TabEntry>): TabEntry {
  return {
    key: "agent-1",
    label: "Claude",
    cmd: "claude",
    args: [],
    env: {},
    cwd: STATE_DIR,
    kind: "agent",
    scope: "pid",
    ...over,
  } as TabEntry;
}

function seed(tabs: TabEntry[]) {
  useTabsStore.setState({
    scope: "pid",
    tabsByScope: { pid: tabs },
    layoutByScope: { pid: null },
    focusedGroupByScope: { pid: null },
    tabs,
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockClear();
});

describe("localTabCwd — why detach breaks tabs", () => {
  it("hides the bad cwd while remote, and exposes it the instant the project is local", () => {
    const t = { kind: "agent" as const, location: "local" as const };

    // Remote: the stored state-dir cwd is overridden by the mirror. Looks fine.
    expect(
      localTabCwd(t, {
        isRemoteProject: true,
        projectDirectory: STATE_DIR,
        fallback: STATE_DIR,
        mirror: MIRROR,
      }),
    ).toBe(MIRROR);

    // Detached: no override — the tab falls straight back to the cwd it was storing all
    // along. THIS is the `.local/share/tabtivity/remote-projects/…` the agent ends up in.
    expect(
      localTabCwd(t, {
        isRemoteProject: false,
        projectDirectory: MIRROR,
        fallback: STATE_DIR,
        mirror: null,
      }),
    ).toBe(STATE_DIR);
  });
});

describe("detachScopeFromRemote", () => {
  it("moves every tab's cwd out of the state dir and into the promoted mirror", () => {
    seed([
      tab({ key: "agent-1", cwd: STATE_DIR, location: "local" }),
      tab({ key: "agent-2", cwd: `${STATE_DIR}/sub`, location: "local", label: "Claude 2" }),
    ]);

    useTabsStore.getState().detachScopeFromRemote("pid", STATE_DIR, MIRROR);

    const tabs = useTabsStore.getState().tabsByScope.pid;
    expect(tabs[0].cwd).toBe(MIRROR);
    // A cwd *under* the old dir keeps its suffix rather than being flattened.
    expect(tabs[1].cwd).toBe(`${MIRROR}/sub`);
    // And the resolver now agrees, because the fallback is finally correct.
    expect(
      localTabCwd(tabs[0], {
        isRemoteProject: false,
        projectDirectory: MIRROR,
        fallback: tabs[0].cwd,
        mirror: null,
      }),
    ).toBe(MIRROR);
  });

  it("brings host-located tabs home — their cwd is a path on a machine we no longer have", () => {
    seed([
      tab({ key: "shell-1", kind: "shell", cmd: "bash", cwd: "/home/remote/Code/demoproj", location: "remote" }),
    ]);

    useTabsStore.getState().detachScopeFromRemote("pid", STATE_DIR, MIRROR);

    const t = useTabsStore.getState().tabsByScope.pid[0];
    expect(t.cwd).toBe(MIRROR);
    expect(t.location).toBeUndefined(); // back to the kind's default (local)
  });

  it("leaves a tab already sitting in the mirror alone", () => {
    seed([tab({ key: "shell-1", kind: "shell", cmd: "bash", cwd: `${MIRROR}/src`, location: "local" })]);

    useTabsStore.getState().detachScopeFromRemote("pid", STATE_DIR, MIRROR);

    expect(useTabsStore.getState().tabsByScope.pid[0].cwd).toBe(`${MIRROR}/src`);
  });

  it("is a no-op when there is nothing to move", () => {
    seed([tab({ key: "agent-1", cwd: MIRROR, location: "local" })]);
    const before = useTabsStore.getState().tabsByScope.pid;

    useTabsStore.getState().detachScopeFromRemote("pid", STATE_DIR, MIRROR);
    useTabsStore.getState().detachScopeFromRemote("pid", MIRROR, MIRROR); // same dir
    useTabsStore.getState().detachScopeFromRemote("pid", "", MIRROR); // no old dir

    expect(useTabsStore.getState().tabsByScope.pid).toBe(before);
  });
});
