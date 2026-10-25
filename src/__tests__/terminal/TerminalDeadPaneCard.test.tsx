/**
 * The card a fenced agent's pane shows once the agent has quit
 * (`TerminalDeadPaneCard`): a dead tmux pane offers Restart and Open a shell
 * here; a live one shows nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { TerminalDeadPaneCard } from "../../components/terminal/TerminalDeadPaneCard";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { BRAND } from "../../lib/brand";

const SESSION = `${BRAND.slug}-p1--agent-1`;

function seedTab(extra: Partial<TabEntry> = {}): TabEntry {
  const tab = {
    key: "agent-1",
    scope: "p1",
    kind: "agent",
    cmd: "codex",
    label: "codex",
    cwd: "/p1",
    tmuxSession: SESSION,
    ...extra,
  } as TabEntry;
  useTabsStore.setState((state) => ({ tabsByScope: { ...state.tabsByScope, p1: [tab] } }));
  return tab;
}

function host() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

describe("dead agent pane card", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    document.body.innerHTML = "";
    useProjectsStore.setState({ projects: [{ id: "p1", name: "p1", path: "/p1" }] as never });
  });

  it("shows nothing while the pane is alive", async () => {
    seedTab();
    invokeMock.mockResolvedValue(false);
    render(<TerminalDeadPaneCard host={host()} ptyId="p1:agent-1" visible />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_tmux_pane_dead", { session: SESSION }));
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  it("does not ask for a hidden pane or a tab without its own tmux session", async () => {
    seedTab();
    render(<TerminalDeadPaneCard host={host()} ptyId="p1:agent-1" visible={false} />);
    seedTab({ tmuxAttach: "other" });
    render(<TerminalDeadPaneCard host={host()} ptyId="p1:agent-1" visible />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("offers Open a shell here once the pane is dead, in the tab's folder", async () => {
    seedTab();
    invokeMock.mockResolvedValue(true);
    render(<TerminalDeadPaneCard host={host()} ptyId="p1:agent-1" visible />);
    await userEvent.click(await screen.findByRole("button", { name: "Open a shell here" }));
    const shell = useTabsStore.getState().tabsByScope.p1.find((tab) => tab.kind === "shell");
    expect(shell?.cwd).toBe("/p1");
    expect(shell?.cmd).toBe("");
  });

  it("Restart ends the dead session and relaunches the tab", async () => {
    seedTab();
    invokeMock.mockResolvedValue(true);
    render(<TerminalDeadPaneCard host={host()} ptyId="p1:agent-1" visible />);
    await userEvent.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_tmux_kill", { session: SESSION }));
    await waitFor(() =>
      expect(useTabsStore.getState().tabsByScope.p1.find((tab) => tab.key === "agent-1")?.relaunchSeq).toBe(1),
    );
  });
});
