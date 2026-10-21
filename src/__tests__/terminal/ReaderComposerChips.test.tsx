import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const sendSteeringPrompt = vi.fn();
const clearAgentTab = vi.fn();
vi.mock("../../lib/shortcuts/steeringAgent", () => ({
  sendSteeringPrompt: (...args: unknown[]) => sendSteeringPrompt(...args),
  clearAgentTab: (...args: unknown[]) => clearAgentTab(...args),
}));
vi.mock("../../lib/terminal/terminalInput", () => ({ writePtyInput: () => Promise.resolve() }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { setReaderDraft } from "../../lib/agents/readerDrafts";
import { COMMIT_PROMPTS } from "../../../mobile-web/src/terminal/commitPrompts";

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };

async function composer(host: HTMLElement): Promise<HTMLTextAreaElement> {
  render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />);
  await screen.findByText("fix the parser");
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("the Reader composer's Plan / Goal / Clear / Commit chips", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    sendSteeringPrompt.mockReset();
    sendSteeringPrompt.mockResolvedValue(undefined);
    clearAgentTab.mockReset();
    clearAgentTab.mockResolvedValue(true);
    invoke.mockImplementation((command: string) => Promise.resolve(command === "agent_tab_transcript"
      ? { available: true, version: "v1", entries: [{ kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" }] }
      : []));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    setReaderDraft("p", "agent-1", "");
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it("leads the draft with /plan or /goal, swaps one for the other and takes it off again, sending nothing", async () => {
    const box = await composer(host);
    fireEvent.change(box, { target: { value: "fix it" } });
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(box.value).toBe("/plan fix it");
    fireEvent.click(screen.getByRole("button", { name: "Goal" }));
    expect(box.value).toBe("/goal fix it");
    expect(screen.getByRole("button", { name: "Goal" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Goal" }));
    expect(box.value).toBe("fix it");
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
  });

  it("starts a new conversation at once and keeps the draft", async () => {
    const box = await composer(host);
    fireEvent.change(box, { target: { value: "keep me" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Clear" })); });
    expect(clearAgentTab).toHaveBeenCalledWith("p", expect.objectContaining({ key: "agent-1" }));
    expect(box.value).toBe("keep me");
  });

  it("says why a clear did not go in", async () => {
    clearAgentTab.mockResolvedValue(false);
    await composer(host);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Clear" })); });
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("opens the commit menu and sends the picked prompt, the draft kept", async () => {
    const box = await composer(host);
    fireEvent.change(box, { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: /^Commit/ }));
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /Split into commits/ })); });
    expect(sendSteeringPrompt).toHaveBeenCalledWith(expect.objectContaining({ key: "agent-1" }), COMMIT_PROMPTS.split);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(box.value).toBe("keep me");
  });

  it("closes the commit menu on Esc without sending", async () => {
    await composer(host);
    fireEvent.click(screen.getByRole("button", { name: /^Commit/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
  });
});
