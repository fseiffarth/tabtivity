/**
 * The root terminal is a scope like every other one — the only distinction is
 * that it is always there. It has a folder (`~/tabtivity/root`), tabs that persist
 * and restore, and its own pill; what it does NOT have is an entry in
 * `projects.json`, and every difference this file locks came from some code
 * path reading that absence as "this scope does not count".
 *
 * Locked here:
 *  - time spent at the root terminal lands in a bucket (`ROOT_TIMER_ID`), not
 *    in nothing at all;
 *  - the keyboard project-cycle stops at the root scope instead of treating it
 *    as a one-way door out;
 *  - switching away from the root scope writes its layout, which the backend
 *    switch cannot do for it (no `local_file` to key the save by).
 *
 * `shouldPersistLocalTab`'s root parity lives in `TmuxSessions.test.ts`, beside
 * its siblings.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectEntry } from "../../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useProjectsStore } from "../../stores/projects";
import { useTimerStore, ROOT_TIMER_ID, APP_TIMER_ID } from "../../stores/timer";
import { useTabsStore } from "../../stores/tabs";

function proj(id: string, position: number, status = "active"): ProjectEntry {
  return { id, name: id, status, position, local_file: `/p/${id}/project.json` };
}

/** Every invoke resolves; `get_time_today` answers with a number. */
function serve() {
  invoke.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "get_time_today" ? 0 : undefined),
  );
}

/** The projectIds `get_time_today` was asked about. */
function timeQueries(): unknown[] {
  return invoke.mock.calls
    .filter((c) => c[0] === "get_time_today")
    .map((c) => (c[1] as { projectId: unknown }).projectId);
}

beforeEach(() => {
  invoke.mockReset();
  serve();
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useTimerStore.setState({
    paused: false,
    appStartedAt: null,
    appCommittedSecs: 0,
    projectStartedAt: null,
    projectCommittedSecs: 0,
    activeProjectId: null,
  });
});

describe("time tracking — the root terminal has its own bucket", () => {
  it("init(null) reads and tracks the root scope, not nothing", async () => {
    await useTimerStore.getState().init(null);
    expect(timeQueries()).toEqual(expect.arrayContaining([APP_TIMER_ID, ROOT_TIMER_ID]));
    expect(useTimerStore.getState().activeProjectId).toBe(ROOT_TIMER_ID);
  });

  it("setProject(null) switches TO the root bucket", async () => {
    await useTimerStore.getState().setProject("p1");
    invoke.mockClear();
    await useTimerStore.getState().setProject(null);
    expect(useTimerStore.getState().activeProjectId).toBe(ROOT_TIMER_ID);
    expect(timeQueries()).toContain(ROOT_TIMER_ID);
  });

  it("flushes the root scope's elapsed seconds on the way out", async () => {
    await useTimerStore.getState().setProject(null);
    // A second of root-terminal work, then a switch to a project.
    useTimerStore.setState({ projectStartedAt: Date.now() - 1000 });
    invoke.mockClear();
    await useTimerStore.getState().setProject("p1");

    const flush = invoke.mock.calls.find((c) => c[0] === "timer_flush_project");
    expect(flush).toBeDefined();
    expect((flush?.[1] as { projectId: string }).projectId).toBe(ROOT_TIMER_ID);
  });
});

describe("setActive — leaving the root scope persists its layout", () => {
  it("writes the root layout itself, since the backend switch cannot", async () => {
    const persistScope = vi.fn().mockResolvedValue(undefined);
    useTabsStore.setState({ persistScope } as never);
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null });

    await useProjectsStore.getState().setActive("p1");

    expect(persistScope).toHaveBeenCalledWith("root", "");
  });

  it("does not write it when leaving a PROJECT (the switch snapshot owns that)", async () => {
    const persistScope = vi.fn().mockResolvedValue(undefined);
    useTabsStore.setState({ persistScope } as never);
    useProjectsStore.setState({
      projects: [proj("p1", 10, "current"), proj("p2", 20)],
      activeId: "p1",
    });

    await useProjectsStore.getState().setActive("p2");

    expect(persistScope).not.toHaveBeenCalled();
  });
});
