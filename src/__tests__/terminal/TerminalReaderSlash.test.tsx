import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const sendSteeringPrompt = vi.fn();
vi.mock("../../lib/shortcuts/steeringAgent", () => ({
  sendSteeringPrompt: (...args: unknown[]) => sendSteeringPrompt(...args),
  clearAgentTab: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../../lib/terminal/terminalInput", () => ({ writePtyInput: () => Promise.resolve() }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { setReaderDraft } from "../../lib/agents/readerDrafts";
import { readSlashCommands } from "../../../mobile-web/src/slashCommands";

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };

async function composer(host: HTMLElement): Promise<HTMLTextAreaElement> {
  render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />);
  await screen.findByText("fix the parser");
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

const rows = () => [...document.querySelectorAll(".terminal-reader-slash-row strong")].map((row) => row.textContent);

describe("the Reader composer's / menu", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    sendSteeringPrompt.mockReset();
    sendSteeringPrompt.mockResolvedValue(undefined);
    invoke.mockImplementation((command: string) => Promise.resolve(command === "agent_tab_transcript"
      ? { available: true, version: "v1", entries: [{ kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" }] }
      : []));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    setReaderDraft("p", "agent-1", "");
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it("offers the CLI's commands as a / is typed, and nothing for plain words", async () => {
    const box = await composer(host);
    fireEvent.change(box, { target: { value: "co" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box, { target: { value: "/co" } });
    expect(rows()).toEqual(["/compact", "/context", "/cost", "/config"]);
  });

  it("fills the box from a picked row without sending it", async () => {
    const box = await composer(host);
    fireEvent.change(box, { target: { value: "/mo" } });
    fireEvent.click(screen.getByText("/model"));
    // `/model` reads an argument: the caret waits after a space.
    expect(box.value).toBe("/model ");
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
  });

  it("walks the rows with ↑/↓ and fills the picked one on Enter; Tab takes the first", async () => {
    const box = await composer(host);
    fireEvent.change(box, { target: { value: "/co" } });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(document.querySelector(".terminal-reader-slash-row.active strong")?.textContent).toBe("/context");
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(box.value).toBe("/context");
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "/he" } });
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("/help");
  });

  it("sends on Enter with no row picked, and offers the sent line first next time", async () => {
    const box = await composer(host);
    fireEvent.change(box, { target: { value: "/model opus" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(sendSteeringPrompt).toHaveBeenCalledWith(expect.objectContaining({ key: "agent-1" }), "/model opus");
    expect(readSlashCommands("claude")).toEqual(["/model opus"]);
    fireEvent.change(box, { target: { value: "/mo" } });
    expect(rows()).toEqual(["/model opus", "/model", "/memory"]);
    fireEvent.click(screen.getByRole("button", { name: "Forget /model opus" }));
    expect(rows()).toEqual(["/model", "/memory"]);
  });

  it("closes on Esc for the draft as it stands, without leaving the chat", async () => {
    const box = await composer(host);
    fireEvent.change(box, { target: { value: "/co" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box.value).toBe("/co");
    fireEvent.change(box, { target: { value: "/com" } });
    expect(rows()).toEqual(["/compact"]);
  });
});
