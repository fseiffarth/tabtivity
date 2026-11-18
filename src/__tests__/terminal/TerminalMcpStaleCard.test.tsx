/**
 * The card over an agent tab whose Tabtivity tools went dead on a reattach
 * (`TerminalMcpStaleCard`): Reconnect while idle, "Reconnect when this turn
 * ends" mid-turn, a confirm for a continue-latest CLI, the notice only for a
 * CLI without resume — and nothing for a tab that is not stale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.fn((_cmd: string, _args?: unknown): Promise<unknown> => Promise.resolve(null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { TerminalMcpStaleCard } from "../../components/terminal/TerminalMcpStaleCard";
import { _resetMcpStaleForTest, noteMcpStale, useMcpStaleStore } from "../../stores/agents/mcpStale";
import { _clearPtyActivityForTest, noteAgentTurn } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { BRAND } from "../../lib/brand";

const SESSION = `${BRAND.slug}-p1--agent-1`;
const TITLE = `${BRAND.display} tools disconnected`;

function seedTab(extra: Partial<TabEntry> = {}) {
  const tab = {
    key: "agent-1",
    scope: "p1",
    kind: "agent",
    cmd: "claude",
    label: "claude",
    cwd: "/p1",
    sessionId: "sid-1",
    tmuxSession: SESSION,
    ...extra,
  } as TabEntry;
  useTabsStore.setState((state) => ({ tabsByScope: { ...state.tabsByScope, p1: [tab] } }));
}

function host() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

const relaunchSeq = () => useTabsStore.getState().tabsByScope.p1.find((tab) => tab.key === "agent-1")?.relaunchSeq ?? 0;

describe("stale Tabtivity tools card", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve(null));
    document.body.innerHTML = "";
    useProjectsStore.setState({ projects: [{ id: "p1", name: "p1", path: "/p1" }] as never });
  });
  afterEach(() => {
    _resetMcpStaleForTest();
    _clearPtyActivityForTest();
  });

  it("shows nothing for a tab whose tools are live", () => {
    seedTab();
    noteMcpStale("p1:agent-1", false);
    render(<TerminalMcpStaleCard host={host()} ptyId="p1:agent-1" />);
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("Reconnect ends the session and relaunches the tab", async () => {
    seedTab();
    noteMcpStale("p1:agent-1", true);
    render(<TerminalMcpStaleCard host={host()} ptyId="p1:agent-1" />);
    expect(screen.getByText(TITLE)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_tmux_kill", { session: SESSION }));
    await waitFor(() => expect(relaunchSeq()).toBe(1));
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("mid-turn arms Reconnect when this turn ends, and can take it back", async () => {
    seedTab();
    noteMcpStale("p1:agent-1", true);
    noteAgentTurn("p1:agent-1", "working");
    render(<TerminalMcpStaleCard host={host()} ptyId="p1:agent-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Reconnect when this turn ends" }));
    expect(useMcpStaleStore.getState().armed["p1:agent-1"]).toBe(true);
    expect(relaunchSeq()).toBe(0);
    expect(screen.getByText("It reconnects as soon as this turn ends.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Don't reconnect" }));
    expect(useMcpStaleStore.getState().armed["p1:agent-1"]).toBeUndefined();
  });

  it("a continue-latest CLI reconnects only after the confirm", async () => {
    seedTab({ cmd: "gemini" });
    noteMcpStale("p1:agent-1", true);
    render(<TerminalMcpStaleCard host={host()} ptyId="p1:agent-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("resumes the latest conversation in this folder");
    expect(relaunchSeq()).toBe(0);
    const confirm = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Reconnect");
    await userEvent.click(confirm!);
    await waitFor(() => expect(relaunchSeq()).toBe(1));
  });

  it("a CLI without resume gets the notice only, and the ✕ hides it", async () => {
    seedTab({ cmd: "aider" });
    noteMcpStale("p1:agent-1", true);
    render(<TerminalMcpStaleCard host={host()} ptyId="p1:agent-1" />);
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.getByText(/cannot resume its conversation/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(TITLE)).toBeNull();
    act(() => noteMcpStale("p1:agent-1", false));
    expect(useMcpStaleStore.getState().dismissed["p1:agent-1"]).toBeUndefined();
  });
});
