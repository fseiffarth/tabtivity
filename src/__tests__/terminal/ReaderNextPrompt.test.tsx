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
    invoke.mockImplementation((command: string, args?: { phase?: string }) => Promise.resolve(
      command === "agent_tab_transcript" ? { available: true, version: "v1", entries: ENDED }
      : command === "agent_next_prompt" && args?.phase === "complete" ? { text: " and update the changelog", turnKey: "e2", status: "ok", model: "qwen3:4b" }
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
    // The chip names the model that wrote it, as the suggestion's author, not
    // the tab's model.
    const chip = host.querySelector(".suggestion-source-chip");
    expect(chip?.querySelector(".suggestion-source-by")?.textContent).toBe("Suggested by");
    expect(chip?.querySelector(".suggestion-source-name")?.textContent).toBe("qwen3:4b");
    expect(chip?.getAttribute("title")).toBe("Suggested by the local model qwen3:4b");
    expect(asks()).toHaveLength(1);
    expect(asks()[0][1]).toEqual(expect.objectContaining({ agent: "codex", sessionId: "launch-1", phase: "final" }));
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("run the tests");
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
  });

  it("asks for no suggestion while the box holds a draft", async () => {
    setReaderDraft("p", "agent-1", "my own words");
    const box = await composer(host);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(box.value).toBe("my own words");
    expect(asks().filter(([, args]) => args.phase !== "complete")).toHaveLength(0);
  });

  it("draws how a typed draft goes on after it; Tab at its end takes it in and nothing is sent", async () => {
    const box = await composer(host);
    await waitFor(() => expect(box.placeholder).toContain("run the tests"));
    fireEvent.change(box, { target: { value: "fix the lint" } });
    const rest = await waitFor(() => {
      const ghost = host.querySelector(".prompt-ghost-rest");
      expect(ghost?.textContent).toBe(" and update the changelog");
      return ghost;
    });
    expect(rest?.closest(".prompt-ghost")?.querySelector(".prompt-ghost-typed")?.textContent).toBe("fix the lint");
    expect(box.getAttribute("aria-description")).toContain("and update the changelog");
    // The completion's author keeps the corner while the draft is typed.
    expect(host.querySelector(".suggestion-source-chip")?.textContent).toContain("Suggested byqwen3:4b");
    const completes = asks().filter(([, args]) => args.phase === "complete");
    expect(completes).toHaveLength(1);
    expect(completes[0][1]).toEqual(expect.objectContaining({ agent: "codex", sessionId: "launch-1", draft: "fix the lint" }));
    // The caret inside the text: nothing is drawn, and Tab takes nothing.
    box.setSelectionRange(3, 3);
    fireEvent.select(box);
    await waitFor(() => expect(host.querySelector(".prompt-ghost")).toBeNull());
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("fix the lint");
    box.setSelectionRange(box.value.length, box.value.length);
    fireEvent.select(box);
    await waitFor(() => expect(host.querySelector(".prompt-ghost-rest")).not.toBeNull());
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("fix the lint and update the changelog");
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
  });

  it("keeps the offered suggestion's rest while it is typed along, with no model run", async () => {
    const box = await composer(host);
    await waitFor(() => expect(box.placeholder).toContain("run the tests"));
    fireEvent.change(box, { target: { value: "run the" } });
    await waitFor(() => expect(host.querySelector(".prompt-ghost-rest")?.textContent).toBe(" tests"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(asks().filter(([, args]) => args.phase === "complete")).toHaveLength(0);
    fireEvent.keyDown(box, { key: "ArrowRight" });
    expect(box.value).toBe("run the tests");
  });

  it("asks nothing while the pane is hidden", async () => {
    render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible={false} focused={false} />);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(asks()).toHaveLength(0);
  });
});
