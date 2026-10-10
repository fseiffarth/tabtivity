import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { TerminalPromptStrip } from "../../components/terminal/TerminalPromptStrip";
import { useAgentPromptsStore, type SentAgentPrompt } from "../../stores/agents/agentPrompts";
import { _resetPromptTrailForTest, notePromptTrailInput } from "../../stores/agents/promptTrail";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useMarkupLinksStore } from "../../stores/viewers/markupLinks";

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
});
