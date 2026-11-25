import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { clearPathLinkCache } from "../../lib/terminal/pathLinks";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";

const localTab: TabEntry = { key: "agent-1", label: "qwen3", cmd: "opencode", cwd: "/p", kind: "local_agent", localDriver: "opencode", launchedAt: 1000 };
const cloudTab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "s-1", launchedAt: 1000 };

describe("the Chat's thinking of a local model", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    clearPathLinkCache();
    invoke.mockReset();
    invoke.mockImplementation((command: string) => {
      if (command === "agent_tab_transcript") {
        return Promise.resolve({
          available: true, version: "v1", truncated: false,
          entries: [
            { kind: "prompt", text: "why?", at: "2026-11-24T08:00:00Z" },
            { kind: "thinking", text: "The user asks why.", at: "2026-11-24T08:00:01Z" },
            { kind: "answer", text: "Because.", at: "2026-11-24T08:00:05Z" },
          ],
        });
      }
      return Promise.resolve([]);
    });
    useProjectsStore.setState({ projects: [{ id: "p", name: "P", directory: "/p", local_file: "/p/project.json" } as unknown as ProjectEntry] });
    useAgentReaderStore.setState({ byAgent: {} });
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
    useProjectsStore.setState({ projects: [] });
  });

  const mount = (tab: TabEntry) => {
    useTabsStore.setState((state) => ({ ...state, scope: "p", tabsByScope: { p: [tab] } }));
    return render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />);
  };

  it("asks for a local-model tab's thinking and folds it above the answer", async () => {
    mount(localTab);
    await screen.findByText("Because.");
    expect(invoke).toHaveBeenCalledWith("agent_tab_transcript", expect.objectContaining({ localModel: true, thinking: true }));
    const block = document.querySelector("details.terminal-reader-thinking");
    expect(block).not.toBeNull();
    expect(block?.hasAttribute("open")).toBe(false);
    expect(block?.querySelector("summary")?.textContent).toContain("Thinking");
    expect(block?.textContent).toContain("The user asks why.");
    // In its place in the turn: after the prompt, before the answer.
    const answer = screen.getByText("Because.").closest(".terminal-reader-turn");
    expect(answer && block && (block.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    // Not an answer bubble of its own.
    expect(block?.closest(".terminal-reader-turn")).toBeNull();
  });

  it("does not ask a cloud tab's read for thinking", async () => {
    mount(cloudTab);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_tab_transcript", expect.objectContaining({ localModel: false, thinking: false })));
  });
});
