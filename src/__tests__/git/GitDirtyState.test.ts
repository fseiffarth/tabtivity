import { describe, it, expect, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import {
  gitDirtyState,
  expectsGitRepo,
  gitDotsDue,
  GIT_DOT_BACKGROUND_EVERY,
  GIT_DOT_TICK_MS,
  gitDotProbedAt,
  remoteGitDotStep,
  useGitDirtyStore,
} from "../../stores/gitDirty";

const status = (over: Partial<{ staged: number; unstaged: number; untracked: number; is_repo: boolean }>) => ({
  staged: 0,
  unstaged: 0,
  untracked: 0,
  has_remote: false,
  is_repo: true,
  ...over,
});

describe("gitDirtyState", () => {
  it("reports clean for a non-repo regardless of counts (git_type is decided in refresh, not here)", () => {
    expect(gitDirtyState(status({ is_repo: false, untracked: 5, staged: 2 }), 3)).toBe("clean");
  });

  it("reports clean when nothing is pending", () => {
    expect(gitDirtyState(status({}), 0)).toBe("clean");
  });

  it("reports dirty for untracked or unstaged working-tree changes", () => {
    expect(gitDirtyState(status({ untracked: 1 }), 0)).toBe("dirty");
    expect(gitDirtyState(status({ unstaged: 1 }), 0)).toBe("dirty");
  });

  it("reports staged when only staged changes exist", () => {
    expect(gitDirtyState(status({ staged: 2 }), 0)).toBe("staged");
  });

  it("reports unpushed when only local commits are ahead", () => {
    expect(gitDirtyState(status({}), 4)).toBe("unpushed");
  });

  it("prioritizes dirty over staged over unpushed", () => {
    expect(gitDirtyState(status({ untracked: 1, staged: 1 }), 2)).toBe("dirty");
    expect(gitDirtyState(status({ staged: 1 }), 2)).toBe("staged");
  });
});

describe("expectsGitRepo", () => {
  it("is true for a project whose git_type names a repo", () => {
    expect(expectsGitRepo("local")).toBe(true);
    expect(expectsGitRepo("remote-private")).toBe(true);
    expect(expectsGitRepo("remote-public")).toBe(true);
  });

  it("is false for a project that never had git", () => {
    expect(expectsGitRepo("none")).toBe(false);
    expect(expectsGitRepo(undefined)).toBe(false);
    expect(expectsGitRepo(null)).toBe(false);
    expect(expectsGitRepo("")).toBe(false);
  });
});

describe("gitDotsDue — the switcher's per-project probe cadence", () => {
  const TICK = 12_000;
  const ids = ["fg", "bg"];
  const fg = new Set(["fg"]);

  it("probes every project that was never probed", () => {
    expect(gitDotsDue(ids, fg, new Map(), 0, TICK)).toEqual(["fg", "bg"]);
  });

  it("probes the project on screen every tick and the others every few ticks", () => {
    const last = new Map([["fg", 0], ["bg", 0]]);
    expect(gitDotsDue(ids, fg, last, TICK, TICK)).toEqual(["fg"]);
    expect(gitDotsDue(ids, fg, last, TICK * (GIT_DOT_BACKGROUND_EVERY - 1), TICK)).toEqual(["fg"]);
    expect(gitDotsDue(ids, fg, last, TICK * GIT_DOT_BACKGROUND_EVERY, TICK)).toEqual(["fg", "bg"]);
  });

  it("counts a timer that fires slightly early, but not a re-arm moments later", () => {
    const last = new Map([["fg", 0], ["bg", 0]]);
    expect(gitDotsDue(ids, fg, last, TICK - 50, TICK)).toEqual(["fg"]);
    // A focus change re-arms the effect right after a probe: nothing is due.
    expect(gitDotsDue(ids, fg, last, 500, TICK)).toEqual([]);
  });
});

describe("useGitDirtyStore.refresh", () => {
  it("shares one running probe between overlapping asks for the same project", async () => {
    let answer: (v: unknown) => void = () => {};
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const refresh = useGitDirtyStore.getState().refresh;
    const first = refresh("p1", "/p1");
    const second = refresh("p1", "/p1");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    answer({ status: { staged: 0, unstaged: 1, untracked: 0, has_remote: false, is_repo: true }, unpushed: 0 });
    await Promise.all([first, second]);
    expect(useGitDirtyStore.getState().byId.p1).toBe("dirty");

    // Once it has answered, the next ask probes again.
    mockInvoke.mockResolvedValue({
      status: { staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: true },
      unpushed: 0,
    });
    await refresh("p1", "/p1");
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(useGitDirtyStore.getState().byId.p1).toBe("clean");
  });

  it("marks a failed probe unknown, never writing it as clean (#2349)", async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValueOnce({
      status: { staged: 0, unstaged: 1, untracked: 0, has_remote: false, is_repo: true },
      unpushed: 0,
    });
    const refresh = useGitDirtyStore.getState().refresh;
    await refresh("p2", "/p2");
    expect(useGitDirtyStore.getState().byId.p2).toBe("dirty");

    // A refused / timed-out git: no old-spelling retry, and no "clean".
    mockInvoke.mockRejectedValueOnce("git status timed out after 120 s and was stopped.");
    await refresh("p2", "/p2");
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(useGitDirtyStore.getState().byId.p2).toBe("unknown");

    // An outdated backend without the combined command still gets the fallback.
    mockInvoke
      .mockRejectedValueOnce("command git_dirty_probe not found")
      .mockResolvedValueOnce({ staged: 1, unstaged: 0, untracked: 0, has_remote: false, is_repo: true })
      .mockResolvedValueOnce([]);
    await refresh("p2", "/p2");
    expect(mockInvoke).toHaveBeenCalledTimes(5);
    expect(useGitDirtyStore.getState().byId.p2).toBe("staged");
  });
});

describe("gitDotProbedAt — the watcher's probes count for the switcher's timer", () => {
  it("stamps a probe and a full reading, so the next tick skips that project", async () => {
    gitDotProbedAt.clear();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({ status: status({ unstaged: 1 }), unpushed: 0 });
    await useGitDirtyStore.getState().refresh("watched", "/w");
    useGitDirtyStore.getState().set("bar-read", "staged");
    const now = Date.now();
    const due = gitDotsDue(["watched", "bar-read", "never"], new Set(["watched", "bar-read"]), gitDotProbedAt, now, GIT_DOT_TICK_MS);
    expect(due).toEqual(["never"]);
    // A tick later both are due again: the timer stays the backstop.
    expect(
      gitDotsDue(["watched", "bar-read"], new Set(["watched", "bar-read"]), gitDotProbedAt, now + GIT_DOT_TICK_MS, GIT_DOT_TICK_MS),
    ).toEqual(["watched", "bar-read"]);
  });
});

describe("remoteGitDotStep — a remote dot follows its SSH lamp", () => {
  it("drops to unknown whenever the host is not connected (VPN dropped, torn down, connecting, failed)", () => {
    for (const ssh of ["off", "connecting", "error"] as const) {
      expect(remoteGitDotStep("connected", ssh)).toBe("unknown");
      expect(remoteGitDotStep(undefined, ssh)).toBe("unknown");
    }
  });

  it("re-reads once on (re)connecting, then leaves the dot to the Files view", () => {
    expect(remoteGitDotStep(undefined, "connected")).toBe("probe");
    expect(remoteGitDotStep("off", "connected")).toBe("probe");
    expect(remoteGitDotStep("connecting", "connected")).toBe("probe");
    expect(remoteGitDotStep("connected", "connected")).toBeNull();
  });
});
