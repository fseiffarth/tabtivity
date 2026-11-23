import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "s-1", launchedAt: 1000 };
const expired = [
  { kind: "prompt", text: "fix the parser", at: "2026-11-23T08:00:00Z" },
  { kind: "answer", text: "Login expired · Please run /login", at: "2026-11-23T08:01:00Z" },
];

/** The tab as the store holds it now. */
const stored = (scope = "p") => useTabsStore.getState().tabsByScope[scope]?.[0];

describe("the Reader's Continue on saved token", () => {
  let host: HTMLElement;
  let entries = expired;
  let token = { saved: true, inUse: true, remote: true, revision: 0 };
  beforeEach(() => {
    localStorage.clear();
    entries = expired;
    token = { saved: true, inUse: true, remote: true, revision: 0 };
    invoke.mockReset();
    invoke.mockImplementation((command: string) => {
      if (command === "agent_tab_transcript") return Promise.resolve({ available: true, version: "v1", truncated: false, entries });
      if (command === "claude_token_status") return Promise.resolve(token);
      return Promise.resolve([]);
    });
    useProjectsStore.setState({ projects: [{ id: "p", name: "P", directory: "/p", local_file: "/p/project.json" } as unknown as ProjectEntry] });
    useTabsStore.setState((state) => ({ ...state, scope: "p", tabsByScope: { p: [tab], q: [{ ...tab, cmd: "codex" }] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
    useProjectsStore.setState({ projects: [], switchToast: null });
  });

  const mount = (scope = "p") =>
    render(<TerminalReaderView host={host} ptyId={`${scope}:agent-1`} scope={scope} tabKey="agent-1" cwd="/p" visible focused />);
  const tokenButton = () => screen.queryByRole("button", { name: /Continue on saved token/u });

  it("restarts a logged-out Claude tab on its resume args, once per message", async () => {
    mount();
    const button = await screen.findByRole("button", { name: /Continue on saved token/u });
    // Signing in for real stays one click away.
    expect(screen.getByRole("button", { name: /Sign in/u })).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(stored()?.relaunchSeq).toBe(1));
    expect(stored()?.args).toEqual(["--resume", "s-1"]);
    // No tmux session of the tab's own: nothing to end first.
    expect(invoke.mock.calls.some(([command]) => command === "local_tmux_kill")).toBe(false);
    // The restart adds no turn: the same answer must not offer it again.
    await waitFor(() => expect(tokenButton()).toBeNull());
    expect(useProjectsStore.getState().switchToast).toBe("Restarted on the saved Claude token. Send your prompt again.");
    expect(screen.getByRole("button", { name: /Sign in/u })).toBeTruthy();
  });

  it("is not offered while the shared login is good, or without a token", async () => {
    token = { saved: true, inUse: false, remote: true, revision: 0 };
    mount();
    await screen.findByRole("button", { name: /Sign in/u });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("claude_token_status"));
    expect(tokenButton()).toBeNull();
  });

  it("is Claude's only, and asks nothing while the chat shows no expired login", async () => {
    mount("q");
    await screen.findByText(/Login expired/u);
    expect(tokenButton()).toBeNull();
    expect(invoke.mock.calls.some(([command]) => command === "claude_token_status")).toBe(false);
  });

  it("asks nothing in a chat that is signed in", async () => {
    entries = [expired[0], { kind: "answer", text: "Done.", at: "2026-11-23T08:01:00Z" }];
    mount();
    await screen.findByText("Done.");
    expect(tokenButton()).toBeNull();
    expect(invoke.mock.calls.some(([command]) => command === "claude_token_status")).toBe(false);
  });
});
