import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

import { PromptSessionCard } from "../../components/agents/PromptSessionCard";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";

function sent(id: string, at: Date): PromptChartCard {
  return {
    id,
    key: `history:${id}`,
    state: "sent",
    message: `Prompt ${id}`,
    tags: [],
    autoTags: [],
    strandId: "strand:t",
    at,
    history: { id, message: `Prompt ${id}`, created_at: "x", sent_at: at.toISOString(), tab_label: "Claude", session_id: "s", result: "delivered" },
  } as unknown as PromptChartCard;
}

function renderSession(cards: PromptChartCard[], handlers: { onSelect?: () => void; onOpen?: () => void } = {}) {
  render(
    <PromptSessionCard
      cards={cards}
      offsets={cards.map((_, index) => index * 10)}
      matchedKeys={new Set(cards.map((card) => card.key))}
      selected={false}
      linking={false}
      linkOver={false}
      color="var(--accent)"
      onSelect={handlers.onSelect ?? vi.fn()}
      onOpen={handlers.onOpen}
      onLink={vi.fn()}
    />,
  );
  return screen.getByTestId("prompt-chart-session");
}

describe("PromptSessionCard span", () => {
  it("writes the dates when the session runs past midnight", () => {
    const card = renderSession([sent("a", new Date(2026, 8, 4, 23, 10)), sent("b", new Date(2026, 8, 5, 1, 40))]);
    const fact = card.querySelector(".agent-prompt-card-fact")!.textContent ?? "";
    expect(fact).toContain("4 Sep");
    expect(fact).toContain("5 Sep");
  });

  it("leaves the dates off a span inside one day", () => {
    const card = renderSession([sent("a", new Date(2026, 8, 4, 9, 10)), sent("b", new Date(2026, 8, 4, 11, 40))]);
    const fact = card.querySelector(".agent-prompt-card-fact")!.textContent ?? "";
    expect(fact).not.toContain("Sep");
    expect(fact).toContain("2 prompts");
  });

  it("selects from the keyboard like a prompt card, and lists nothing inside itself", () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const card = renderSession([sent("a", new Date(2026, 8, 4, 9, 10)), sent("b", new Date(2026, 8, 4, 11, 40))], { onSelect, onOpen });
    expect(card.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The session's prompts are the inspector's list, not an expanded body.
    expect(screen.queryAllByTestId("prompt-chart-session-row")).toHaveLength(0);
  });
});
