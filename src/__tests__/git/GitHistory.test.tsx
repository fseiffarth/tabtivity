/**
 * Tests for the side-panel Git history & commit UI:
 * - #7 (Group D.3): the history view shows the current branch, a commit list
 *   (HEAD marked), clickable branch pills that check the branch out.
 * - #8 (Group D.3): clicking HEAD opens an editable commit window with a
 *   "Save (amend)" action (git_reword_head); an older commit is read-only;
 *   "Checkout" checks the commit out (detached).
 * - Lazy history: the list asks for one page and pages the rest in from the
 *   bottom row, instead of stopping at the first 100 commits.
 * - Graph view: hovering a lane's line names the branch(es) it carries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import { GitHistory } from "../../components/files/GitHistory";
import { storageKey } from "../../lib/brand";

const COMMITS = [
  { hash: "aaa111", short: "aaa111", subject: "feat: add widget", author: "me", date: "2d ago", refs: "HEAD -> main", is_head: true, parents: ["bbb222"] },
  { hash: "bbb222", short: "bbb222", subject: "fix: earlier bug", author: "me", date: "5d ago", refs: "", is_head: false, parents: [] },
];

const BRANCHES = [
  { name: "main", is_current: true, is_remote: false },
  { name: "feature", is_current: false, is_remote: false },
  { name: "origin/main", is_current: false, is_remote: true },
];

function setupInvoke() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "git_log") return Promise.resolve(COMMITS);
    if (cmd === "git_branches") return Promise.resolve(BRANCHES);
    if (cmd === "git_commit_message") return Promise.resolve("feat: add widget\n\nbody");
    if (cmd === "git_checkout") return Promise.resolve(null);
    if (cmd === "git_reword_head") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

async function renderHistory() {
  await act(async () => {
    render(<GitHistory projectDir="/p" />);
  });
}

describe("#7 git history view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvoke();
  });

  it("shows current branch, commit list with HEAD marked", async () => {
    await renderHistory();
    expect(await screen.findByText(/⎇\s*main/)).toBeTruthy();
    const headRow = (await screen.findByText("feat: add widget")).closest("button")!;
    expect(headRow.className).toContain("head");
    const olderRow = screen.getByText("fix: earlier bug").closest("button")!;
    expect(olderRow.className).not.toContain("head");
  });

  it("clicking a non-current branch pill checks it out", async () => {
    const user = userEvent.setup();
    await renderHistory();
    await user.click(await screen.findByRole("button", { name: "feature" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_checkout", { projectDir: "/p", target: "feature" });
  });
});

describe("#8 commit-message window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvoke();
  });

  it("HEAD opens editable, Save (amend) calls git_reword_head", async () => {
    const user = userEvent.setup();
    await renderHistory();
    await user.click(await screen.findByText("feat: add widget"));

    const textarea = (await screen.findByDisplayValue(/feat: add widget/)) as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(false);
    await user.click(screen.getByRole("button", { name: "Save (amend)" }));
    expect(mockInvoke).toHaveBeenCalledWith(
      "git_reword_head",
      expect.objectContaining({ projectDir: "/p" }),
    );
  });

  it("an older commit is read-only with no amend action", async () => {
    const user = userEvent.setup();
    await renderHistory();
    await user.click(await screen.findByText("fix: earlier bug"));

    const textarea = (await screen.findByDisplayValue(/feat: add widget/)) as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save (amend)" })).toBeNull();
    expect(screen.getByText(/Only the latest commit/)).toBeTruthy();
  });

  it("Checkout from the window checks out that commit", async () => {
    const user = userEvent.setup();
    await renderHistory();
    await user.click(await screen.findByText("fix: earlier bug"));
    await screen.findByDisplayValue(/feat: add widget/);
    await user.click(screen.getByRole("button", { name: "Checkout" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_checkout", { projectDir: "/p", target: "bbb222" });
  });
});

describe("lazy commit history", () => {
  /** A full page, so the panel knows there is probably more behind it. */
  function page(from: number, n: number) {
    return Array.from({ length: n }, (_, i) => ({
      hash: `h${from + i}`,
      short: `h${from + i}`,
      subject: `commit ${from + i}`,
      author: "me",
      date: "1d ago",
      refs: "",
      is_head: from + i === 0,
      parents: [],
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pages older commits in from the bottom row, once, without duplicates", async () => {
    const user = userEvent.setup();
    const calls: Array<{ limit: number; skip: number }> = [];
    mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "git_log") {
        const limit = args.limit as number;
        const skip = (args.skip as number) ?? 0;
        calls.push({ limit, skip });
        // 150 commits in all: a full page, then a short one.
        return Promise.resolve(page(skip, Math.min(limit, Math.max(0, 150 - skip))));
      }
      if (cmd === "git_branches") return Promise.resolve(BRANCHES);
      return Promise.resolve(null);
    });

    await act(async () => {
      render(<GitHistory projectDir="/p" />);
    });
    expect(calls[0]).toEqual({ limit: 100, skip: 0 });
    expect(screen.getByText("commit 99")).toBeTruthy();
    expect(screen.queryByText("commit 100")).toBeNull();

    // jsdom has no IntersectionObserver, so the sentinel is reached by click —
    // the same path as a pane too short to ever scroll it into view.
    await user.click(screen.getByRole("button", { name: /Load older commits/ }));
    expect(calls.some((c) => c.skip === 100 && c.limit === 100)).toBe(true);
    expect(screen.getByText("commit 149")).toBeTruthy();
    // The short page is the end of the history: no row left to click.
    expect(screen.queryByRole("button", { name: /Load older commits/ })).toBeNull();
    // Each commit is rendered once, even though page boundaries overlap nothing.
    expect(screen.getAllByText("commit 100").length).toBe(1);
  });

  it("a repo shorter than a page offers nothing to load", async () => {
    setupInvoke();
    await act(async () => {
      render(<GitHistory projectDir="/p" />);
    });
    await screen.findByText("feat: add widget");
    expect(screen.queryByRole("button", { name: /Load older commits/ })).toBeNull();
  });
});

describe("graph view branch names on hover", () => {
  // feature and main fork from base; main also merged an unnamed side line.
  const GRAPH = [
    { hash: "f2", short: "f2", subject: "feature work", author: "me", date: "1d", refs: "feature", is_head: false, parents: ["base"] },
    { hash: "m2", short: "m2", subject: "merge side", author: "me", date: "2d", refs: "HEAD -> main, origin/main, tag: v1", is_head: true, parents: ["m1", "s1"] },
    { hash: "s1", short: "s1", subject: "side work", author: "me", date: "3d", refs: "", is_head: false, parents: ["m1"] },
    { hash: "m1", short: "m1", subject: "main work", author: "me", date: "4d", refs: "", is_head: false, parents: ["base"] },
    { hash: "base", short: "base", subject: "root", author: "me", date: "5d", refs: "", is_head: false, parents: [] },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem(storageKey("gitHistoryGraph"), "1");
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "git_log") return Promise.resolve(GRAPH);
      if (cmd === "git_branches") return Promise.resolve(BRANCHES);
      return Promise.resolve(null);
    });
  });

  const titlesOf = (subject: string) =>
    Array.from(screen.getByText(subject).closest("button")!.querySelectorAll("svg title")).map((n) => n.textContent);

  it("names each line by the branch refs flowing down it", async () => {
    await renderHistory();
    await screen.findByText("feature work");
    // A tip's dot and trunk carry its branch names, tags excluded.
    expect(titlesOf("feature work")).toContain("feature");
    expect(titlesOf("merge side")).toContain("main, origin/main");
    expect(titlesOf("merge side").join("|")).not.toContain("v1");
    // The side line merged into main has no ref naming it: only main and the
    // feature lane passing by are named on its row.
    expect(new Set(titlesOf("side work"))).toEqual(new Set(["feature", "main, origin/main"]));
    // Where main's line runs into the feature lane, that lane carries both.
    expect(titlesOf("root")).toContain("feature, main, origin/main");
  });
});
