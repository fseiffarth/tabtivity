/**
 * The agent tab's "a newer release is out" card (`TerminalVersionCard`, fed by
 * the daily registry check through `stores/agents/agentVersionNotice`).
 *
 *  1. A tab opened while a newer release is known shows it; Update… opens
 *     Manage CLIs; × hides that release for every tab until restart.
 *  2. A tab already open when the daily check finds a release gets no card.
 *  3. Up to date, unreadable installed version, or no check: no card.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  listeners: new Map<string, Set<(e: { payload: unknown }) => void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    let set = h.listeners.get(name);
    if (!set) {
      set = new Set();
      h.listeners.set(name, set);
    }
    set.add(cb);
    return Promise.resolve(() => {
      set.delete(cb);
    });
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { TerminalVersionCard } from "../../components/terminal/TerminalVersionCard";
import {
  lastUpdateCheck,
  offeredUpdate,
  resetAgentVersionNotice,
  useAgentVersionNoticeStore,
} from "../../stores/agents/agentVersionNotice";
import { useModelsOverlayStore } from "../../stores/modelsOverlay";

const invokeMock = vi.mocked(invoke);

const row = (update: Record<string, unknown> | null) => ({
  agent: "claude",
  label: "Claude Code",
  version: "2.1.316",
  state: "match" as const,
  stale: [],
  dismissed: false,
  update:
    update && {
      agent: "claude",
      current: "2.1.316",
      latest: "2.1.320",
      updateAvailable: true,
      checkable: true,
      error: null,
      checkedAt: 100,
      ...update,
    },
});

let rows: unknown[] = [];

function host() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

const card = (pane: HTMLElement) => pane.querySelector(".terminal-version-drift");

describe("agent tab update card", () => {
  beforeEach(() => {
    rows = [];
    h.listeners.clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation(((cmd: string) =>
      Promise.resolve(cmd === "agent_versions" ? rows : null)) as never);
    resetAgentVersionNotice();
    useModelsOverlayStore.setState({ open: false, view: "home" });
    document.body.innerHTML = "";
  });

  it("offers a newer release on a tab that opens while it is known", async () => {
    rows = [row({})];
    const pane = host();
    render(<TerminalVersionCard host={pane} cmd="claude" />);
    expect(await screen.findByText("Claude Code 2.1.320 is out")).toBeTruthy();
    expect(card(pane)?.textContent).toContain("Installed 2.1.316");

    await userEvent.click(screen.getByRole("button", { name: "Update…" }));
    expect(useModelsOverlayStore.getState()).toMatchObject({ open: true, view: "agents" });
  });

  it("× hides that release on every tab until restart, and a later release speaks again", async () => {
    rows = [row({})];
    const a = host();
    const b = host();
    render(
      <>
        <TerminalVersionCard host={a} cmd="claude" />
        <TerminalVersionCard host={b} cmd="claude" />
      </>,
    );
    await waitFor(() => expect(card(a)).not.toBeNull());
    await userEvent.click(screen.getAllByRole("button", { name: "Hide until restart" })[0]);
    expect(card(a)).toBeNull();
    expect(card(b)).toBeNull();

    rows = [row({ latest: "2.1.321" })];
    const c = host();
    render(<TerminalVersionCard host={c} cmd="claude" />);
    expect(await screen.findByText("Claude Code 2.1.321 is out")).toBeTruthy();
  });

  it("does not pop into a tab already open when the daily check finds a release", async () => {
    rows = [row({ latest: "2.1.316", updateAvailable: false })];
    const pane = host();
    render(<TerminalVersionCard host={pane} cmd="claude" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("agent_versions", { refresh: false }));
    rows = [row({})];
    await act(async () => {
      for (const cb of h.listeners.get("agent-updates-checked") ?? []) cb({ payload: [] });
    });
    await waitFor(() => expect(useAgentVersionNoticeStore.getState().updates.claude?.latest).toBe("2.1.320"));
    expect(card(pane)).toBeNull();
  });

  it("goes when the CLI is updated past the offered release", async () => {
    rows = [row({})];
    const pane = host();
    render(<TerminalVersionCard host={pane} cmd="claude" />);
    await waitFor(() => expect(card(pane)).not.toBeNull());
    act(() =>
      useAgentVersionNoticeStore
        .getState()
        .update([row({ current: "2.1.320", updateAvailable: false })] as never),
    );
    expect(card(pane)).toBeNull();
  });

  it("offers nothing without a readable installed version or a newer release", () => {
    const state = (update: Record<string, unknown> | null) => {
      resetAgentVersionNotice();
      useAgentVersionNoticeStore.getState().update([row(update)] as never);
      return offeredUpdate(useAgentVersionNoticeStore.getState(), "claude");
    };
    expect(state({})?.latest).toBe("2.1.320");
    expect(state({ updateAvailable: false })).toBeNull();
    expect(state({ current: null })).toBeNull();
    expect(state(null)).toBeNull();
  });

  it("dates the menu's line by the newest check among the installed CLIs", () => {
    const updates = {
      claude: { checkedAt: 100 },
      codex: { checkedAt: 300 },
      gemini: { checkedAt: 900 },
    } as never;
    expect(lastUpdateCheck(updates, ["claude", "codex"])).toBe(300);
    expect(lastUpdateCheck(updates, ["aider"])).toBeNull();
  });
});
