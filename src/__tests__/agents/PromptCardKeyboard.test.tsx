import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

import { PromptCard } from "../../components/agents/PromptCard";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";

const draft = {
  id: "d",
  key: "prompt:d",
  state: "draft",
  message: "Plain draft",
  tags: [],
  autoTags: [],
  strandId: "strand:t",
  prompt: { id: "d", message: "Plain draft", created_at: "x", updated_at: "x" },
} as unknown as PromptChartCard;

function renderCard() {
  const noop = vi.fn(async () => {});
  const handlers = { onSelect: vi.fn(), onOpen: vi.fn(), onEdit: vi.fn(), onLink: vi.fn() };
  render(
    <PromptCard
      card={draft}
      matched
      selected={false}
      linking={false}
      dragging={false}
      linkOver={false}
      color="var(--accent)"
      targets={[{ id: "t", label: "Claude" }]}
      onAgent={noop}
      onDelete={noop}
      {...handlers}
    />,
  );
  return { article: screen.getByTestId("prompt-chart-card-draft"), ...handlers };
}

describe("PromptCard keyboard route", () => {
  it("is focusable and selects with Enter and Space, asking for the inspector's focus", () => {
    const { article, onSelect, onOpen } = renderCard();
    expect(article.getAttribute("tabindex")).toBe("0");
    expect(article.getAttribute("role")).toBe("button");
    fireEvent.keyDown(article, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(article, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledTimes(2);
    // Any other key is not the card's.
    fireEvent.keyDown(article, { key: "a" });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("nothing opens inside the card: a click only selects", () => {
    const { article, onSelect } = renderCard();
    fireEvent.click(article);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(article.querySelector(".agent-prompt-card-expanded")).toBeNull();
    expect(within(article).queryByRole("button", { name: "Send" })).toBeNull();
    expect(within(article).queryByRole("textbox")).toBeNull();
  });

  it("leaves keys aimed at the card's own button to it, and a double click asks for the editor", () => {
    const { article, onSelect, onEdit } = renderCard();
    fireEvent.keyDown(within(article).getByRole("button", { name: "Drag to link with another card" }), { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.doubleClick(article);
    expect(onEdit).toHaveBeenCalledTimes(1);
    // A double click on a control stays that control's.
    fireEvent.doubleClick(within(article).getByRole("button", { name: "Delete draft" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
