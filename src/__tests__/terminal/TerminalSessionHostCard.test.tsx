/**
 * The Windows session host's notice on an agent pane (`TerminalSessionHostCard`)
 * and the per-PTY record behind it (`lib/terminal/sessionHostNotice`): the
 * `session-host-fallback` event, heard from app start even before any pane;
 * a `pty_spawn` rejection reported as `session_host_silent` /
 * `session_host_refused`, which fails closed with Retry; and the record
 * clearing at every spawn attempt and when the PTY goes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Handler = (event: { payload: unknown }) => void;
const handlers: { name: string; handler: Handler }[] = [];
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: Handler) => {
    const entry = { name, handler };
    handlers.push(entry);
    return Promise.resolve(() => {
      const i = handlers.indexOf(entry);
      if (i >= 0) handlers.splice(i, 1);
    });
  }),
  emit: vi.fn(() => Promise.resolve()),
}));

import { TerminalSessionHostCard } from "../../components/terminal/TerminalSessionHostCard";
import {
  clearSessionHostState,
  onSessionHostState,
  reportSessionHostSpawnError,
  resetSessionHostNotices,
  sessionHostSignalOf,
  sessionHostSpawnErrorState,
  startSessionHostNotices,
} from "../../lib/terminal/sessionHostNotice";
import { killAsleepPty, markPtyAsleep } from "../../lib/terminal/sleepingPtys";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const PTY = "p1:agent-1";

function seedTab() {
  const tab = { key: "agent-1", scope: "p1", kind: "agent", cmd: "claude", label: "claude", cwd: "/p1" } as TabEntry;
  useTabsStore.setState((state) => ({ tabsByScope: { ...state.tabsByScope, p1: [tab] } }));
}

function host() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

/** Let `subscribeTauri` settle, then deliver the event. */
async function fallbackEvent(payload: unknown) {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    for (const { name, handler } of [...handlers]) if (name === "session-host-fallback") handler({ payload });
  });
}

beforeEach(() => {
  resetSessionHostNotices();
  handlers.length = 0;
  document.body.innerHTML = "";
  seedTab();
});

describe("session host notice card", () => {
  it("shows nothing until the host says something about this tab", async () => {
    render(<TerminalSessionHostCard host={host()} ptyId={PTY} visible />);
    await fallbackEvent({ id: "p1:other", reason: "x" });
    act(() => reportSessionHostSpawnError("p1:other", "session_host_silent: no answer"));
    act(() => reportSessionHostSpawnError(PTY, "ssh: not found"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a fallback event that came before any pane existed, and Got it hides it", async () => {
    startSessionHostNotices();
    await fallbackEvent({ id: PTY, reason: "the host did not start" });
    render(<TerminalSessionHostCard host={host()} ptyId={PTY} visible />);
    expect(await screen.findByText("Running in this window")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText("Running in this window")).toBeNull();
  });

  it("fails closed on a silent host with Retry, which respawns the tab", async () => {
    render(<TerminalSessionHostCard host={host()} ptyId={PTY} visible />);
    act(() => reportSessionHostSpawnError(PTY, "session_host_silent: no answer in 15 s"));
    expect(await screen.findByText("Session host not responding")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(useTabsStore.getState().tabsByScope.p1.find((tab) => tab.key === "agent-1")?.relaunchSeq).toBe(1);
    expect(screen.queryByText("Session host not responding")).toBeNull();
  });

  it("says when the host declined, and hears a rejection reported before it mounted", async () => {
    reportSessionHostSpawnError(PTY, new Error("session_host_refused: invalid session name"));
    render(<TerminalSessionHostCard host={host()} ptyId={PTY} visible />);
    expect(await screen.findByText("Session host declined this tab")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("hides when the next spawn attempt clears the record", async () => {
    render(<TerminalSessionHostCard host={host()} ptyId={PTY} visible />);
    act(() => reportSessionHostSpawnError(PTY, "session_host_silent: no answer"));
    expect(await screen.findByText("Session host not responding")).toBeTruthy();
    act(() => clearSessionHostState(PTY));
    expect(screen.queryByText("Session host not responding")).toBeNull();
  });

  it("waits for the pane to be visible", () => {
    const el = host();
    const view = render(<TerminalSessionHostCard host={el} ptyId={PTY} visible={false} />);
    act(() => reportSessionHostSpawnError(PTY, "session_host_silent: no answer"));
    expect(screen.queryByText("Session host not responding")).toBeNull();
    view.rerender(<TerminalSessionHostCard host={el} ptyId={PTY} visible />);
    expect(screen.getByText("Session host not responding")).toBeTruthy();
  });
});

describe("the per-PTY record", () => {
  it("is dropped when a sleeping pane's PTY is killed", () => {
    reportSessionHostSpawnError(PTY, "session_host_silent: x");
    markPtyAsleep(PTY);
    killAsleepPty(PTY);
    const seen: unknown[] = [];
    onSessionHostState(PTY, (state) => seen.push(state))();
    expect(seen).toEqual([]);
  });

  it("tells a follower when it clears, and nothing when there was nothing", () => {
    const seen: unknown[] = [];
    const off = onSessionHostState(PTY, (state) => seen.push(state));
    clearSessionHostState(PTY);
    reportSessionHostSpawnError(PTY, "session_host_refused: x");
    clearSessionHostState(PTY);
    off();
    expect(seen).toEqual(["refused", null]);
  });

  it("listens once however often it is started", async () => {
    startSessionHostNotices();
    startSessionHostNotices();
    await act(async () => {
      await Promise.resolve();
    });
    expect(handlers.filter((h) => h.name === "session-host-fallback")).toHaveLength(1);
  });
});

describe("the adapters", () => {
  it("reads the fallback event's { id, reason } payload, and nothing else", () => {
    expect(sessionHostSignalOf({ id: PTY, reason: "the host did not start" })).toEqual({ ptyId: PTY, state: "fallback" });
    expect(sessionHostSignalOf({ id: PTY })).toBeNull();
    expect(sessionHostSignalOf({ id: "", reason: "x" })).toBeNull();
    expect(sessionHostSignalOf({ ptyId: PTY, reason: "x" })).toBeNull();
    expect(sessionHostSignalOf(null)).toBeNull();
    expect(sessionHostSignalOf("fallback")).toBeNull();
  });

  it("maps the pty_spawn error prefixes, and only them", () => {
    expect(sessionHostSpawnErrorState("session_host_silent: no answer")).toBe("unresponsive");
    expect(sessionHostSpawnErrorState("session_host_refused: invalid session name")).toBe("refused");
    expect(sessionHostSpawnErrorState(new Error("session_host_silent: pipe busy"))).toBe("unresponsive");
    expect(sessionHostSpawnErrorState("session_host_silent")).toBe("unresponsive");
    expect(sessionHostSpawnErrorState("session_host_silently: x")).toBeNull();
    expect(sessionHostSpawnErrorState("spawn failed: session_host_silent: x")).toBeNull();
    expect(sessionHostSpawnErrorState("ssh: not found")).toBeNull();
    expect(sessionHostSpawnErrorState(undefined)).toBeNull();
    expect(sessionHostSpawnErrorState({ code: "session_host_silent" })).toBeNull();
  });
});
