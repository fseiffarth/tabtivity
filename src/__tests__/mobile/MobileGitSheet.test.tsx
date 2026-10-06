/**
 * The project screen's read-only git overview (`GitSheet`, ⎇ Git in the name
 * menu): the project folder's branch and upstream, worktrees (only when a
 * linked one exists), local and remote branches, capped with `+N more`; a
 * folder outside git and a host older than the route each say so.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitOverview } from "../../../mobile-web/src/api";
import { GitSheet } from "../../../mobile-web/src/screens/GitSheet";

const FULL: GitOverview = {
  repo: true,
  head: { branch: "main", upstream: "origin/main", ahead: 2, behind: 1 },
  worktrees: [
    { id: "w-main", label: "", branch: "main", main: true, current: true, locked: false, missing: false, git: "dirty", checked: true, tabs: 1 },
    { id: "w-topic", label: "topic", branch: "topic", main: false, current: false, locked: true, missing: false, checked: true, tabs: 2 },
    { id: "w-loose", label: "loose", short: "1a2b3c4", main: false, current: false, locked: false, missing: false, checked: false, tabs: 0 },
  ],
  worktrees_total: 3,
  branches: [
    { name: "main", current: true, upstream: "origin/main", ahead: 2, behind: 1 },
    { name: "topic", current: false, ahead: 0, behind: 0, worktree: "topic" },
    { name: "old", current: false, ahead: 0, behind: 0 },
  ],
  branches_total: 65,
  remote_branches: ["origin/review"],
  remote_total: 1,
};

const ONLY_MAIN: GitOverview = {
  repo: true,
  head: { short: "9f8e7d6", ahead: 0, behind: 0 },
  worktrees: [{ id: "w-main", label: "", short: "9f8e7d6", main: true, current: true, locked: false, missing: false, checked: true, tabs: 0 }],
  worktrees_total: 1,
  branches: [{ name: "main", current: false, ahead: 0, behind: 0 }],
  branches_total: 1,
  remote_branches: [],
  remote_total: 0,
};

function hostAnswering(...bodies: (GitOverview | "old" | "box")[]) {
  let call = 0;
  return vi.fn(async (input: string | URL | Request) => {
    expect(String(input)).toBe("/api/v1/projects/p1/git");
    const body = bodies[Math.min(call++, bodies.length - 1)];
    if (body === "old") return new Response(null, { status: 404 });
    if (body === "box") return new Response(JSON.stringify({ error: "not_a_project" }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe("Mobile project — git overview sheet", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the head, the worktrees with the project folder first, and capped branches", async () => {
    vi.stubGlobal("fetch", hostAnswering(FULL));
    render(<GitSheet projectId="p1" label="Aurora" onClose={() => {}} />);
    const sheet = await screen.findByRole("dialog", { name: "Git · Aurora" });
    await within(sheet).findByText("Worktrees (3)");
    expect(within(sheet).getByText("↑2 ↓1", { selector: ".git-head span" })).toBeTruthy();
    expect(within(sheet).getByText("origin/main", { selector: ".git-head span" })).toBeTruthy();

    const [worktrees, branches] = within(sheet).getAllByRole("list");
    const rows = within(worktrees).getAllByRole("listitem");
    expect(rows[0].className).toBe("current");
    expect(rows[0].textContent).toContain("Project folder · Main");
    expect(rows[0].textContent).toContain("Aurora — ⎇ main");
    expect(rows[0].textContent).toContain("1 tab");
    expect(rows[1].textContent).toContain("Locked");
    expect(rows[1].textContent).toContain("2 tabs");
    expect(rows[2].textContent).toContain("loose — Detached at 1a2b3c4");
    expect(rows[2].textContent).toContain("changes not checked");

    expect(within(sheet).getByText("Branches (65)")).toBeTruthy();
    const branchRows = within(branches).getAllByRole("listitem");
    expect(branchRows[0].textContent).toContain("● main");
    expect(branchRows[1].textContent).toContain("in topic");
    expect(branchRows[3].textContent).toBe("+62 more");
    expect(within(sheet).getByText("Remote branches (1)")).toBeTruthy();
    expect(within(sheet).getByText("origin/review")).toBeTruthy();
  });

  it("hides the worktrees with only the project folder, and says detached", async () => {
    vi.stubGlobal("fetch", hostAnswering(ONLY_MAIN));
    render(<GitSheet projectId="p1" label="Aurora" onClose={() => {}} />);
    await screen.findByText("Detached at 9f8e7d6");
    expect(screen.queryByText(/^Worktrees/)).toBeNull();
    expect(screen.queryByText(/^Remote branches/)).toBeNull();
    expect(screen.getByText("Branches (1)")).toBeTruthy();
  });

  it("says when the folder is not a git repository", async () => {
    vi.stubGlobal("fetch", hostAnswering({ ...ONLY_MAIN, repo: false, head: undefined, worktrees: [], worktrees_total: 0, branches: [], branches_total: 0 }));
    render(<GitSheet projectId="p1" label="Aurora" onClose={() => {}} />);
    await screen.findByText("Not a git repository");
    expect(screen.queryByText(/^Branches/)).toBeNull();
  });

  it("tells an older phone host apart from an error", async () => {
    vi.stubGlobal("fetch", hostAnswering("old"));
    render(<GitSheet projectId="p1" label="Aurora" onClose={() => {}} />);
    await screen.findByText(/older than this view/);
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();

    vi.stubGlobal("fetch", hostAnswering("box"));
    render(<GitSheet projectId="p1" label="Aurora" onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not read git");
    expect(screen.queryByText(/older than this view/)).toBeNull();
  });

  it("asks again on ↻ and closes on Done", async () => {
    const fetch = hostAnswering(ONLY_MAIN, FULL);
    vi.stubGlobal("fetch", fetch);
    const onClose = vi.fn();
    render(<GitSheet projectId="p1" label="Aurora" onClose={onClose} />);
    await screen.findByText("Detached at 9f8e7d6");
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await screen.findByText("Worktrees (3)");
    expect(fetch).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });
});
