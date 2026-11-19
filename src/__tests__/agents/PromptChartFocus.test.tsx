import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { PromptChart } from "../../components/agents/PromptChart";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";

const tab: TabEntry = { key: "a", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "t", sessionId: "s" };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "agent_prompts_list") {
      return ["one", "two"].map((id) => ({ id, message: `Draft ${id}`, created_at: "x", updated_at: "x" }));
    }
    return [];
  });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useSettingsStore.setState({ settings: null, loaded: true });
  useAgentSchedulesStore.setState({ byTarget: { ["p\u0000t"]: [] }, loading: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

const cardOf = (text: string) => screen.getAllByTestId("prompt-chart-card-draft").find((card) => card.textContent?.includes(text))!;
const heading = () => screen.getByTestId("prompt-chart-inspector").querySelector("h4")!;

describe("PromptChart inspector focus", () => {
  it("Enter moves focus into the inspector; a later mouse selection does not steal it again", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    await screen.findByText("Draft one");
    fireEvent.keyDown(cardOf("Draft one"), { key: "Enter" });
    expect(document.activeElement).toBe(heading());
    // The inspector of the next card, opened by a click, is only shown.
    fireEvent.click(cardOf("Draft two"));
    expect(screen.getByTestId("prompt-chart-inspector-prompt").textContent).toBe("Draft two");
    expect(document.activeElement).not.toBe(heading());
    // Enter on a card still asks for it, and asks again.
    fireEvent.keyDown(cardOf("Draft two"), { key: "Enter" });
    expect(document.activeElement).toBe(heading());
  });
});
