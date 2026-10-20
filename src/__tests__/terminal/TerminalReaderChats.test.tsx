import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const submitCommand = vi.fn((..._args: unknown[]) => Promise.resolve("p:agent-1"));
vi.mock("../../lib/agents/scheduledAgentInput", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/agents/scheduledAgentInput")>()),
  submitScheduledAgentCommand: (...args: unknown[]) => submitCommand(...args),
}));

import { TerminalReaderChats, chatWhen } from "../../components/terminal/TerminalReaderChats";
import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { chatPosition, chatsOffered, stepChat, useReaderChatsStore, type StoredChat } from "../../lib/agents/agentChats";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useActivityStore } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const DAY = 86_400_000;
const tab: TabEntry = {
  key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent",
  sessionId: "launch-1", launchedAt: 1000, scheduleTargetId: "st-1",
};
const now = Date.now();
const rows: StoredChat[] = [
  { id: "c-now", title: "the work at hand", updated: now, current: true },
  { id: "c-1", title: "fix the parser", last: "and add a test", updated: now - 3 * DAY, current: false },
  { id: "c-2", title: "write the docs", updated: now - 5 * DAY, current: false },
];
const transcript = {
  available: true,
  version: "v1",
  truncated: false,
  entries: [
    { kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" },
    { kind: "answer", text: "Done.", at: "2026-09-30T08:01:00Z" },
  ],
};

function answer(command: string, args?: Record<string, unknown>): unknown {
  if (command === "agent_tab_chats") {
    return args?.offset === 0
      ? { supported: true, chats: rows, next: 12 }
      : { supported: true, chats: [{ id: "c-3", title: "an old idea", updated: now - 40 * DAY, current: false }] };
  }
  if (command === "agent_tab_resume_chat") return { kind: "type", command: `/resume ${String(args?.chat)}` };
  if (command === "agent_tab_transcript") return transcript;
  return [];
}

describe("the Resume menu", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    submitCommand.mockClear();
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => Promise.resolve(answer(command, args)));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    useReaderChatsStore.setState({ byPty: {} });
    useActivityStore.setState((state) => ({ ...state, busyByTab: {} }));
  });

  /** The strip's Resume ▾ button (each row has a Resume of its own). */
  const toggle = () => document.querySelector<HTMLButtonElement>(".reader-chats > button")!;

  function menu() {
    return render(<TerminalReaderChats ptyId="p:agent-1" scope="p" tab={tab} cwd="/p" onReturnFocus={() => {}} />);
  }

  it("lists the folder's earlier chats, newest first, the tab's own marked", async () => {
    menu();
    fireEvent.click(toggle());
    await screen.findByText("fix the parser");
    expect(invoke).toHaveBeenCalledWith("agent_tab_chats", {
      agent: "claude", projectId: "p", tabDir: "/p", sessionId: "launch-1", offset: 0,
    });
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.querySelector(".reader-chats-row-title")?.textContent))
      .toEqual(["the work at hand", "fix the parser", "write the docs"]);
    expect(options[0].textContent).toContain("This chat");
    expect(options[1].textContent).toContain("and add a test");
    // The tab's own chat is not one to resume.
    expect(options[0].querySelector(".reader-chats-resume")).toBeNull();
  });

  it("narrows the rows with the filter and reads older chats a page at a time", async () => {
    menu();
    fireEvent.click(toggle());
    await screen.findByText("fix the parser");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "DOCS" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Show older chats" }));
    await screen.findByText("an old idea");
    expect(invoke).toHaveBeenCalledWith("agent_tab_chats", expect.objectContaining({ offset: 12 }));
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Show older chats" })).toBeNull();
  });

  it("opens a chat in the chat view, and the tab's own goes back to it", async () => {
    menu();
    fireEvent.click(toggle());
    fireEvent.click(await screen.findByText("fix the parser"));
    expect(useReaderChatsStore.getState().byPty["p:agent-1"]?.chat.id).toBe("c-1");
    expect(useAgentReaderStore.getState().byAgent.claude).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(toggle());
    fireEvent.click(await screen.findByText("the work at hand"));
    expect(useReaderChatsStore.getState().byPty["p:agent-1"]).toBeUndefined();
  });

  it("walks the rows with the keys; Ctrl+Enter resumes the one chosen", async () => {
    menu();
    fireEvent.click(toggle());
    await screen.findByText("fix the parser");
    const filter = screen.getByRole("searchbox");
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2].getAttribute("aria-selected")).toBe("true");
    await act(async () => { fireEvent.keyDown(filter, { key: "Enter", ctrlKey: true }); });
    expect(invoke).toHaveBeenCalledWith("agent_tab_resume_chat", expect.objectContaining({ chat: "c-2", sessionId: "launch-1" }));
    await waitFor(() => expect(submitCommand).toHaveBeenCalledWith("st-1", "/resume c-2"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("resumes nothing while the agent works", async () => {
    useActivityStore.setState((state) => ({ ...state, busyByTab: { "p:agent-1": true } }));
    menu();
    fireEvent.click(toggle());
    await screen.findByText("fix the parser");
    const resume = screen.getAllByRole("button", { name: "Resume" })[0] as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter", ctrlKey: true });
    expect(invoke).not.toHaveBeenCalledWith("agent_tab_resume_chat", expect.anything());
  });

  it("says why a chat could not be resumed", async () => {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      Promise.resolve(command === "agent_tab_resume_chat" ? null : answer(command, args)));
    menu();
    fireEvent.click(toggle());
    await screen.findByText("fix the parser");
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Resume" })[0]); });
    await waitFor(() => expect(useProjectsStore.getState().switchToast).toBe("That chat is no longer stored, so it cannot be resumed."));
    expect(submitCommand).not.toHaveBeenCalled();
  });
});

describe("an earlier chat in the Reader", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    submitCommand.mockClear();
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => Promise.resolve(answer(command, args)));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useReaderChatsStore.setState({ byPty: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it("is read in place of the session's, read-only, and goes back on Esc", async () => {
    useReaderChatsStore.getState().browse("p:agent-1", rows[1], rows);
    render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />);
    await screen.findByText("Done.");
    expect(invoke).toHaveBeenCalledWith("agent_tab_transcript", expect.objectContaining({ chat: "c-1", sessionId: "launch-1" }));
    const bar = screen.getByRole("navigation", { name: "Earlier chat" });
    expect(bar.textContent).toContain("fix the parser");
    expect(bar.textContent).toContain("1 of 2");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Resume this chat" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" });
    expect(useReaderChatsStore.getState().byPty["p:agent-1"]).toBeUndefined();
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("agent_tab_transcript", expect.objectContaining({ chat: null })));
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("steps to the chat beside it and resumes it from the footer", async () => {
    useReaderChatsStore.getState().browse("p:agent-1", rows[1], rows);
    render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />);
    await screen.findByText("Done.");
    fireEvent.click(screen.getByRole("button", { name: "Older chat" }));
    expect(useReaderChatsStore.getState().byPty["p:agent-1"]?.chat.id).toBe("c-2");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_tab_transcript", expect.objectContaining({ chat: "c-2" })));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resume this chat" })); });
    await waitFor(() => expect(submitCommand).toHaveBeenCalledWith("st-1", "/resume c-2"));
    await waitFor(() => expect(useReaderChatsStore.getState().byPty["p:agent-1"]).toBeUndefined());
  });
});

describe("the chats model", () => {
  it("steps past the tab's own chat and counts only the others", () => {
    const browsed = { chat: rows[1], list: rows };
    expect(stepChat(browsed, 1)?.id).toBe("c-2");
    expect(stepChat(browsed, -1)).toBeUndefined();
    expect(chatPosition(browsed)).toEqual({ index: 0, count: 2 });
  });

  it("is offered for Claude and Codex tabs with a launch id only", () => {
    expect(chatsOffered("p", tab)).toBe(true);
    expect(chatsOffered("p", { ...tab, cmd: "codex" })).toBe(true);
    expect(chatsOffered("p", { ...tab, cmd: "opencode" })).toBe(false);
    expect(chatsOffered("p", { ...tab, sessionId: undefined })).toBe(false);
    expect(chatsOffered("p", { ...tab, kind: "shell" })).toBe(false);
  });

  it("says when a chat was written the way the chat's day chips do", () => {
    const today = new Date(2026, 9, 20, 15, 30);
    expect(chatWhen(new Date(2026, 9, 20, 9, 5).getTime(), true, "Yesterday", today)).toBe("09:05");
    expect(chatWhen(new Date(2026, 9, 19, 9, 5).getTime(), true, "Yesterday", today)).toBe("Yesterday 09:05");
    expect(chatWhen(new Date(2026, 8, 2).getTime(), true, "Yesterday", today)).not.toContain("2026");
    expect(chatWhen(new Date(2025, 8, 2).getTime(), true, "Yesterday", today)).toContain("2025");
  });
});
