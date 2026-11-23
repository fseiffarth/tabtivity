/**
 * The Chat view composer offers the local model's next-prompt suggestion
 * (`lib/agents/nextPrompt`) in the slot Claude's own takes, on a CLI that
 * draws none: once the conversation ends on an answer, dimmed in the empty
 * box, Tab takes it, nothing sends it. `agent_next_prompt` is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const sendSteeringPrompt = vi.fn();
vi.mock("../../lib/shortcuts/steeringAgent", () => ({
  sendSteeringPrompt: (...args: unknown[]) => sendSteeringPrompt(...args),
  clearAgentTab: vi.fn(),
}));
vi.mock("../../lib/terminal/terminalInput", () => ({ writePtyInput: () => Promise.resolve() }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { setReaderDraft } from "../../lib/agents/readerDrafts";

const tab: TabEntry = { key: "agent-1", label: "Codex", cmd: "codex", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };
const ENDED = [
  { kind: "prompt", text: "fix the parser", at: "2026-11-22T08:00:00Z" },
  { kind: "answer", text: "Fixed it.", at: "2026-11-22T08:01:00Z" },
];

const asks = () => invoke.mock.calls.filter(([command]) => command === "agent_next_prompt");

async function composer(host: HTMLElement): Promise<HTMLTextAreaElement> {
  render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />);
  await screen.findByText("fix the parser");
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("the Reader composer and the local model's suggestion", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    sendSteeringPrompt.mockReset();
    invoke.mockImplementation((command: string) => Promise.resolve(
      command === "agent_tab_transcript" ? { available: true, version: "v1", entries: ENDED }
      : command === "agent_next_prompt" ? { text: "run the tests", turnKey: "e2", status: "ok", model: "qwen3:4b" }
      : []));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    setReaderDraft("p", "agent-1", "");
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it("shows it dimmed in the empty box once the turn ended; Tab takes it in and nothing is sent", async () => {
    const box = await composer(host);
    await waitFor(() => expect(box.placeholder).toContain("run the tests"));
    expect(box.getAttribute("aria-label")).toBe("Local model suggests: run the tests");
    // The chip names the model that wrote it.
    const chip = host.querySelector(".suggestion-source-chip");
    expect(chip?.textContent).toContain("qwen3:4b");
    expect(chip?.getAttribute("title")).toBe("Suggested by the local model qwen3:4b");
    expect(asks()).toHaveLength(1);
    expect(asks()[0][1]).toEqual(expect.objectContaining({ agent: "codex", sessionId: "launch-1", phase: "final" }));
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("run the tests");
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
  });

  it("asks nothing while the box holds a draft", async () => {
    setReaderDraft("p", "agent-1", "my own words");
    const box = await composer(host);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(box.value).toBe("my own words");
    expect(asks()).toHaveLength(0);
  });

  it("asks nothing while the pane is hidden", async () => {
    render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible={false} focused={false} />);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(asks()).toHaveLength(0);
  });
});
