/**
 * The worktree an agent tab's card names: the linked worktree's folder name,
 * its branch beside it where that is named differently, and nothing for a tab
 * in the project folder's own checkout.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SubagentWorktreeMarks, WorktreeMark } from "../../../mobile-web/src/components/AgentModeMarks";
import { transcriptTurns } from "../../../mobile-web/src/terminal/transcriptTurns";
import { subagentsIn } from "../../../mobile-web/src/terminal/subagents";

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

describe("SubagentWorktreeMarks", () => {
  it("names each other worktree the subagents at work are in, with how many", () => {
    const { container } = render(<SubagentWorktreeMarks tab={{ subagent_worktrees: [
      { label: "agent-a1b2", branch: "worktree-agent-a1b2", count: 2 },
      { label: "fix", count: 1 },
    ] }} />);
    const marks = [...container.querySelectorAll(".agent-worktree.subagent")];
    expect(marks.map((mark) => mark.textContent)).toEqual(["↳ ⎇ agent-a1b2 · worktree-agent-a1b2 ×2", "↳ ⎇ fix"]);
    expect(marks[0].getAttribute("title")).toBe("Subagents at work in worktree agent-a1b2 on branch worktree-agent-a1b2: 2");
    expect(marks[1].getAttribute("title")).toBe("Subagents at work in worktree fix (detached HEAD): 1");
  });

  it("shows nothing while no subagent is in another worktree", () => {
    const { container } = render(<SubagentWorktreeMarks tab={{}} />);
    expect(container.querySelector(".agent-worktree")).toBeNull();
  });

  it("carries a subagent entry's worktree to its chat card and its Subagents row", () => {
    const worktree = { label: "agent-a1b2", branch: "worktree-agent-a1b2" };
    const entries = [{ kind: "agent" as const, text: "Fix it", subagent: "0123456789abcdef", worktree }];
    expect(transcriptTurns(entries)[0].worktree).toEqual(worktree);
    expect(subagentsIn(entries)[0].worktree).toEqual(worktree);
  });
});
