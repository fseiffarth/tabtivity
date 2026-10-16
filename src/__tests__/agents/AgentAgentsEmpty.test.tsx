/**
 * The agent tab's one-time empty-AGENTS.md card (`TerminalAgentsEmptyCard`).
 *
 *  1. It names the missing guidance and offers to fill it.
 *  2. "Fill AGENTS.md" hands the fill to the caller (the pane pastes it).
 *  3. × persists the dismissal per project, so the card shows at most once.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  TerminalAgentsEmptyCard,
  agentsEmptyDismissed,
  dismissAgentsEmpty,
} from "../../components/terminal/TerminalAgentsEmptyCard";

function host() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

describe("agent tab empty-AGENTS.md card", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("names the missing guidance and offers to fill it", () => {
    render(
      <TerminalAgentsEmptyCard
        host={host()}
        projectId="p1"
        onFill={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("No project guidance yet")).toBeTruthy();
    expect(
      screen.getByText(
        "AGENTS.md holds no project information yet. Describe your project below and this agent will fill it in.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fill AGENTS.md" })).toBeTruthy();
  });

  it("Fill hands the fill to the caller without dismissing by itself", async () => {
    const onFill = vi.fn();
    const onDismiss = vi.fn();
    render(
      <TerminalAgentsEmptyCard host={host()} projectId="p1" onFill={onFill} onDismiss={onDismiss} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Fill AGENTS.md" }));
    expect(onFill).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("× persists the dismissal per project", async () => {
    const onDismiss = vi.fn();
    render(
      <TerminalAgentsEmptyCard host={host()} projectId="p1" onFill={() => {}} onDismiss={onDismiss} />,
    );
    expect(agentsEmptyDismissed("p1")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(agentsEmptyDismissed("p1")).toBe(true);
    expect(agentsEmptyDismissed("p2")).toBe(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a stored dismissal reads back after a reload", () => {
    dismissAgentsEmpty("p9");
    expect(agentsEmptyDismissed("p9")).toBe(true);
  });
});
