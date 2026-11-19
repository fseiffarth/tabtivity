import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { PromptChart } from "../../components/agents/PromptChart";
import { useActivityStore } from "../../stores/activity";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";

const tab: TabEntry = { key: "a", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "t", sessionId: "s" };
const tab2: TabEntry = { key: "b", label: "Codex", cmd: "codex", cwd: "/p", kind: "agent", scheduleTargetId: "t2", sessionId: "s2" };
const NOW = new Date(2026, 8, 4, 12, 2, 0);
const at = (hour: number, minute = 0) => new Date(2026, 8, 4, hour, minute).toISOString();

const row = (id: string, session: string, label: string, sentAt: string, extra: Record<string, unknown> = {}) =>
  ({ id, message: id, created_at: "x", sent_at: sentAt, tab_label: label, session_id: session, result: "delivered" as const, ...extra });

const history = [
  row("Running prompt", "s", "Claude", at(11, 50)),
  row("Question prompt", "s2", "Codex", at(11, 40)),
  row("Finished prompt", "g1", "Gone one", at(9, 0), { files_at: at(9, 6), files: ["a.ts", "b.ts"] }),
  row("Delivered prompt", "g2", "Gone two", at(8, 0)),
  row("Missed prompt", "g3", "Gone three", at(7, 0), { result: "missed" }),
  row("Failed prompt", "g4", "Gone four", at(6, 30), { result: "failed" }),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => (command === "agent_prompt_history_list" ? history : []));
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useSettingsStore.setState({ settings: null, loaded: true });
  useAgentSchedulesStore.setState({ byTarget: { ["p\u0000t"]: [], ["p\u0000t2"]: [] }, loading: {} });
  useActivityStore.setState({
    statusTabsByScope: { p: [{ key: "a", state: "working" }, { key: "b", state: "needs-decision" }] },
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  useActivityStore.setState({ statusTabsByScope: {} } as never);
});

const cardOf = (text: string) => screen.getByText(text).closest("article")!;
const chipOf = (text: string) => cardOf(text).querySelector(".agent-prompt-chip")!.textContent;

describe("outcome on past cards", () => {
  it("words every outcome on the card face", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab, tab2]} />); });
    await screen.findByText("Running prompt");
    expect(chipOf("Running prompt")).toBe("Running");
    expect(chipOf("Question prompt")).toBe("Needs answer");
    expect(chipOf("Finished prompt")).toBe("Finished");
    expect(chipOf("Delivered prompt")).toBe("Delivered");
    expect(chipOf("Missed prompt")).toBe("Missed");
    expect(chipOf("Failed prompt")).toBe("Failed");
  });

  it("prints the facts: the length so far, the finished turn's totals, the reason a row did not go", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab, tab2]} />); });
    await screen.findByText("Running prompt");
    const fact = (text: string) => cardOf(text).querySelector(".agent-prompt-card-fact")?.textContent;
    expect(fact("Running prompt")).toBe("12 min so far");
    expect(fact("Question prompt")).toBe("22 min so far · waiting for your answer");
    expect(fact("Finished prompt")).toBe("6 min · 2 files");
    expect(fact("Delivered prompt")).toBeUndefined();
    expect(fact("Missed prompt")).toBe("Nothing was sent at its minute");
    expect(fact("Failed prompt")).toBe("Could not be delivered to the tab");
  });

  it("anchors a running card's bar at its right edge, like any past card", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab, tab2]} />); });
    await screen.findByText("Running prompt");
    const bar = (text: string) => cardOf(text).querySelector<HTMLElement>(".agent-prompt-card-bar");
    expect(bar("Running prompt")?.classList.contains("is-right")).toBe(true);
    expect(bar("Finished prompt")?.classList.contains("is-right")).toBe(true);
  });

  it("shows the result in the inspector, with the live word", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab, tab2]} />); });
    await screen.findByText("Running prompt");
    fireEvent.click(cardOf("Finished prompt"));
    const inspector = within(screen.getByTestId("prompt-chart-inspector"));
    expect(inspector.getByTestId("prompt-chart-inspector-outcome").textContent).toContain("6 min · 2 files");
    expect(inspector.getByText("Finished")).toBeTruthy();
    fireEvent.click(cardOf("Question prompt"));
    expect(within(screen.getByTestId("prompt-chart-inspector")).getByText("Needs answer")).toBeTruthy();
  });

  it("calls a row Delivered, not Running, when its tab is idle", async () => {
    useActivityStore.setState({ statusTabsByScope: { p: [{ key: "a", state: "finished" }, { key: "b", state: "finished" }] } } as never);
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab, tab2]} />); });
    await screen.findByText("Running prompt");
    expect(chipOf("Running prompt")).toBe("Delivered");
    expect(chipOf("Question prompt")).toBe("Delivered");
  });
});
