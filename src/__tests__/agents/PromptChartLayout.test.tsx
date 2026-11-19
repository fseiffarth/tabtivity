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
const NOW = new Date(2026, 8, 4, 12, 2, 0);
const scrollIntoView = vi.fn();
let chartWidth = 1200;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "agent_prompts_list") return [{ id: "draft", message: "Plain draft", created_at: "x", updated_at: "x" }];
    return [];
  });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useSettingsStore.setState({ settings: null, loaded: true });
  useAgentSchedulesStore.setState({ byTarget: { ["p\u0000t"]: [] }, loading: {} });
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => chartWidth });
});

afterEach(() => {
  vi.useRealTimers();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("PromptChart stacked layout", () => {
  it("brings the inspector into view on select when the columns stack", async () => {
    chartWidth = 500;
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    fireEvent.click((await screen.findByText("Plain draft")).closest("article")!);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect((scrollIntoView.mock.contexts[0] as Element).className).toContain("agent-prompt-inspector");
  });

  it("scrolls nothing when the inspector is a column beside the timeline", async () => {
    chartWidth = 1200;
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    fireEvent.click((await screen.findByText("Plain draft")).closest("article")!);
    expect(screen.getByTestId("prompt-chart-inspector")).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
