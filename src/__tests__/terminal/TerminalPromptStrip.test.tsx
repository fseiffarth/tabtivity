import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(() => Promise.resolve("/home/u/out.md")) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { TerminalPromptStrip } from "../../components/terminal/TerminalPromptStrip";
import { useAgentPromptsStore, type SentAgentPrompt } from "../../stores/agents/agentPrompts";
import { _resetPromptTrailForTest, notePromptTrailInput } from "../../stores/agents/promptTrail";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useMarkupLinksStore } from "../../stores/viewers/markupLinks";
import { onReaderInsert } from "../../lib/terminal/terminalDrop";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1" };
const iso = "2026-09-30T08:00:00Z";
const sent: SentAgentPrompt = { id: "r1", message: "the first prompt", created_at: iso, sent_at: iso, tab_label: "Claude", tab_id: "launch-1" };

function strip() {
  return render(
    <TerminalPromptStrip ptyId="p:agent-1" scope="p" tabKey="agent-1" background="#000" foreground="#fff" onReturnFocus={() => {}} />,
  );
}

describe("the prompt strip over an agent pane", () => {
  beforeEach(() => {
    _resetPromptTrailForTest();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentPromptsStore.setState({ historyByProject: { p: [sent] } });
    useMarkupLinksStore.setState({ byPty: {} });
  });

  it("shows the newest prompt and steps back to the older one", () => {
    notePromptTrailInput("p:agent-1", "now the second\r", false, () => true);
    strip();
    expect(screen.getByText("now the second")).toBeTruthy();
    expect(screen.getByText("2/2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Older prompt" }));
    expect(screen.getByText("the first prompt")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("opens the whole prompt and the list, and arrows move through it", () => {
    notePromptTrailInput("p:agent-1", "line one\x1b\rline two\r", false, () => true);
    strip();
    fireEvent.click(screen.getByRole("button", { name: /Show the whole prompt/ }));
    const panel = screen.getByRole("dialog");
    expect(panel.querySelector(".prompt-strip-full")?.textContent).toBe("line one\nline two");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(panel, { key: "ArrowUp" });
    expect(panel.querySelector(".prompt-strip-full")?.textContent).toBe("the first prompt");
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stamps the prompt on the app's clock, not the webview locale's", () => {
    const at = new Date();
    at.setHours(14, 5, 0, 0);
    const stamp = at.toISOString();
    useAgentPromptsStore.setState({ historyByProject: { p: [{ ...sent, created_at: stamp, sent_at: stamp }] } });
    const before = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: { ...(before ?? {}), time_format_24h: true } as typeof before });
    try {
      const { container } = strip();
      expect(container.querySelector(".prompt-strip-time")?.textContent).toBe("14:05");
    } finally {
      useSettingsStore.setState({ settings: before });
    }
  });

  it("leaves the prompt out under the chat and keeps the switch where it was", () => {
    const props = { ptyId: "p:agent-1", scope: "p", tabKey: "agent-1", background: "#000", foreground: "#fff", onReturnFocus: () => {} };
    const { container, rerender } = render(<TerminalPromptStrip {...props} reader={{ open: false, onToggle: () => {} }} />);
    expect(screen.getByText("the first prompt")).toBeTruthy();
    const actions = container.querySelector(".prompt-strip-actions");
    rerender(<TerminalPromptStrip {...props} chatShown reader={{ open: true, onToggle: () => {} }} />);
    expect(screen.queryByText("the first prompt")).toBeNull();
    expect(container.querySelector(".prompt-strip.chat")).toBeTruthy();
    expect(container.querySelector(".prompt-strip-actions")).toBe(actions);
    expect(screen.getByRole("button", { pressed: true }).getAttribute("title")).toMatch(/terminal/i);
    expect(screen.queryByRole("button", { name: /Chat/ })).toBeNull();
    // The list is offered over the chat too; Enter puts the prompt in its box.
    const inserted: string[] = [];
    const off = onReaderInsert("p:agent-1", (text) => inserted.push(text));
    try {
      fireEvent.click(screen.getByRole("button", { name: "Prompts" }));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
      expect(inserted).toEqual(["the first prompt"]);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      off();
    }
    // No switches to show (a chat-only view): nothing under the chat.
    rerender(<TerminalPromptStrip {...props} chatShown />);
    expect(container.querySelector(".prompt-strip")).toBeNull();
  });

  it("says so when the tab has no prompt yet", () => {
    useAgentPromptsStore.setState({ historyByProject: { p: [] } });
    strip();
    expect(screen.getByText("No prompt in this tab yet")).toBeTruthy();
  });

  it("leads back to the PDF whose marks the tab is working on, only while the link holds", () => {
    const setActive = vi.spyOn(useTabsStore.getState(), "setActive").mockImplementation(() => {});
    try {
      strip();
      expect(screen.queryByRole("button", { name: /paper\.pdf/ })).toBeNull();
      act(() => useMarkupLinksStore.getState().set("p:agent-1", { tabKey: "pdf-7", name: "paper.pdf", owner: "viewer-a" }));
      fireEvent.click(screen.getByRole("button", { name: /paper\.pdf/ }));
      expect(setActive).toHaveBeenCalledWith("pdf-7");
      // Only the viewer that set the link takes it back.
      act(() => useMarkupLinksStore.getState().clear("p:agent-1", "viewer-b"));
      expect(screen.getByRole("button", { name: /paper\.pdf/ })).toBeTruthy();
      act(() => useMarkupLinksStore.getState().clear("p:agent-1", "viewer-a"));
      expect(screen.queryByRole("button", { name: /paper\.pdf/ })).toBeNull();
    } finally {
      setActive.mockRestore();
    }
  });

  it("exports the whole session as Markdown where the save dialog says", async () => {
    const calls = vi.mocked(invoke);
    calls.mockImplementation(((cmd: string) => Promise.resolve(cmd === "agent_tab_transcript"
      ? { available: true, truncated: false, entries: [{ kind: "prompt", text: "the first prompt" }, { kind: "answer", text: "the answer" }] }
      : [])) as typeof invoke);
    try {
      render(<TerminalPromptStrip ptyId="p:agent-1" scope="p" tabKey="agent-1" background="#000" foreground="#fff" onReturnFocus={() => {}} reader={{ open: false, onToggle: () => {}, cwd: "/p" }} />);
      fireEvent.click(screen.getByRole("button", { name: /Show the whole prompt/ }));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export session…" })));
      expect(vi.mocked(save)).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "Claude-session.md" }));
      const write = calls.mock.calls.find((c) => c[0] === "agent_session_export_write");
      const args = write?.[1] as { path: string; content: string };
      expect(args.path).toBe("/home/u/out.md");
      expect(args.content).toContain("## You\n\nthe first prompt");
      expect(args.content).toContain("## Agent\n\nthe answer");
      expect(screen.getByRole("status").textContent).toBe("Saved to /home/u/out.md");
      // The same conversation as a chat page.
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export as chat…" })));
      expect(vi.mocked(save)).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: "Claude-chat.html" }));
      const page = calls.mock.calls.filter((c) => c[0] === "agent_session_export_write").at(-1)?.[1] as { content: string };
      expect(page.content).toMatch(/<div class="turn user">.*the first prompt.*<div class="turn agent">.*the answer/s);
    } finally {
      calls.mockImplementation((() => Promise.resolve([])) as typeof invoke);
    }
  });

  it("exports only the prompts from the panel's list when no transcript is read", async () => {
    const calls = vi.mocked(invoke);
    calls.mockClear();
    strip();
    fireEvent.click(screen.getByRole("button", { name: /Show the whole prompt/ }));
    // No Chat for this agent: only its prompts can be exported.
    expect(screen.queryByRole("button", { name: "Export session…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export as chat…" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export my prompts…" })));
    expect(calls.mock.calls.some((c) => c[0] === "agent_tab_transcript")).toBe(false);
    const write = calls.mock.calls.find((c) => c[0] === "agent_session_export_write");
    const content = (write?.[1] as { content: string }).content;
    expect(content.startsWith("# My prompts — Claude")).toBe(true);
    expect(content).toMatch(/## 1 · .+\n\nthe first prompt\n$/);
  });
});
