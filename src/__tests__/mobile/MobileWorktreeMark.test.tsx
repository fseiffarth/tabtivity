/**
 * The worktree an agent tab's card names: the linked worktree's folder name,
 * its branch beside it where that is named differently, and nothing for a tab
 * in the project folder's own checkout.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { WorktreeMark } from "../../../mobile-web/src/components/AgentModeMarks";

describe("WorktreeMark", () => {
  it("names the worktree and a differently named branch", () => {
    const { container } = render(<WorktreeMark tab={{ worktree: { label: "fix-login", branch: "fix/login" } }} />);
    const mark = container.querySelector(".agent-worktree");
    expect(mark?.textContent).toBe("⎇ fix-login · fix/login");
    expect(mark?.getAttribute("title")).toBe("Works in worktree fix-login on branch fix/login");
  });

  it("does not repeat a branch named like its worktree", () => {
    const { container } = render(<WorktreeMark tab={{ worktree: { label: "feature-x", branch: "feature-x" } }} />);
    expect(container.querySelector(".agent-worktree")?.textContent).toBe("⎇ feature-x");
  });

  it("says a detached worktree has no branch", () => {
    const { container } = render(<WorktreeMark tab={{ worktree: { label: "bisect" } }} />);
    expect(container.querySelector(".agent-worktree")?.getAttribute("title")).toBe("Works in worktree bisect (detached HEAD)");
  });

  it("shows nothing for a tab in the project folder", () => {
    const { container } = render(<WorktreeMark tab={{}} />);
    expect(container.querySelector(".agent-worktree")).toBeNull();
  });
});
