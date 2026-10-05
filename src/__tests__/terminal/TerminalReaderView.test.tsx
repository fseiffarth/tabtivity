import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const sendSteeringPrompt = vi.fn();
const clearAgentTab = vi.fn();
vi.mock("../../lib/shortcuts/steeringAgent", () => ({
  sendSteeringPrompt: (...args: unknown[]) => sendSteeringPrompt(...args),
  clearAgentTab: (...args: unknown[]) => clearAgentTab(...args),
}));
const submitCommand = vi.fn((..._args: unknown[]) => Promise.resolve("p:agent-1"));
vi.mock("../../lib/agents/scheduledAgentInput", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/agents/scheduledAgentInput")>()),
  submitScheduledAgentCommand: (...args: unknown[]) => submitCommand(...args),
}));
const written: string[] = [];
vi.mock("../../lib/terminal/terminalInput", () => ({
  writePtyInput: (_id: string, bytes: Uint8Array) => { written.push(new TextDecoder().decode(bytes)); return Promise.resolve(); },
}));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { TerminalPromptStrip } from "../../components/terminal/TerminalPromptStrip";
import { composerHistory, mergeTranscript, readerOffered, readerRequest, rememberReader, rememberedReader, shortPath } from "../../lib/agents/agentReader";
import { worktreeOfPath } from "../../lib/agents/agentWorktrees";
import { useAgentReaderStore, useReaderOpen } from "../../stores/agents/agentReader";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { noteSentPrompt } from "../../lib/agents/sentPrompts";
import { setReaderDraft } from "../../lib/agents/readerDrafts";
import type { Terminal } from "@xterm/xterm";
import { NAMES, storageKey } from "../../lib/brand";

/** A pane's xterm as far as the Reader reads it: its active buffer. */
function fakeTerminal(rows: string[]): Terminal {
  return {
    buffer: { active: { get length() { return rows.length; }, getLine: (row: number) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) } },
    onWriteParsed: () => ({ dispose() {} }),
  } as unknown as Terminal;
}

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };
const transcript = {
  available: true,
  version: "v1",
  truncated: true,
  entries: [
    { kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" },
    { kind: "answer", text: "Done — **two** changes.", at: "2026-09-30T08:01:00Z" },
    { kind: "prompt", text: "/model opus", at: "2026-09-30T08:02:00Z" },
  ],
};

function reader(host: HTMLElement) {
  return render(
    <TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />,
  );
}

describe("the agent pane's Reader", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    sendSteeringPrompt.mockReset();
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_tab_transcript" ? transcript : []));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    setReaderDraft("p", "agent-1", "");
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it("draws the stored conversation: prompts, formatted answers, commands as rules", async () => {
    reader(host);
    await screen.findByText("fix the parser");
    expect(host.querySelector(".terminal-reader-turn.user")?.textContent).toContain("fix the parser");
    expect(host.querySelector(".terminal-reader-turn.agent strong")?.textContent).toBe("two");
    expect(host.querySelector(".terminal-reader-command")?.textContent).toBe("/model opus");
    expect(screen.getByRole("button", { name: "Show earlier turns" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("agent_tab_transcript", expect.objectContaining({
      agent: "claude", projectId: "p", sessionId: "launch-1", tabDir: "/p", since: 1000, version: null,
    }));
    // A long session that never spawned a subagent has no "Subagents (0+)".
    expect(screen.queryByRole("navigation", { name: "Subagents in this conversation" })).toBeNull();
  });

  it("offers the subagents of earlier turns only when those turns hold one", async () => {
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_tab_transcript" ? { ...transcript, agentsEarlier: true } : []));
    reader(host);
    await screen.findByRole("button", { name: /^Subagents \(0\+\)/ });
  });

  it("sends a prompt through the prompt box's path and shows it as sending", async () => {
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, scheduleTargetId: "st-1" }] } }));
    sendSteeringPrompt.mockImplementation((_tab: TabEntry, text: string) => { noteSentPrompt("st-1", text); return Promise.resolve(); });
    reader(host);
    await screen.findByText("fix the parser");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "and add a test" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(sendSteeringPrompt).toHaveBeenCalledWith(expect.objectContaining({ key: "agent-1" }), "and add a test");
    expect(host.querySelector(".terminal-reader-turn.pending")?.textContent).toContain("and add a test");
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("shows a prompt steering's box sent at once, and keeps it while the agent works", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const term = fakeTerminal(["> fix it", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> ", "  ? for shortcuts"]);
    try {
      useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, scheduleTargetId: "st-1" }] } }));
      registerTerminal("p:agent-1", term);
      reader(host);
      await screen.findByText("fix the parser");
      act(() => noteSentPrompt("st-1", "queued while busy"));
      expect(host.querySelector(".terminal-reader-turn.pending")?.textContent).toContain("queued while busy");
      noteSentPrompt("st-2", "another tab's prompt");
      await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
      expect(host.querySelector(".terminal-reader-turn.pending")?.textContent).toContain("queued while busy");
      expect(host.textContent).not.toContain("another tab's prompt");
    } finally {
      unregisterTerminal("p:agent-1", term);
      vi.useRealTimers();
    }
  });

  it("starts a new conversation the way the Clear key does, not as a prompt", async () => {
    clearAgentTab.mockReset();
    clearAgentTab.mockResolvedValue(true);
    reader(host);
    await screen.findByText("fix the parser");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/clear" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(clearAgentTab).toHaveBeenCalledWith("p", expect.objectContaining({ key: "agent-1" }));
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe("");
    // A prefix the CLI's popup completes to `/clear` is that clear too.
    clearAgentTab.mockClear();
    fireEvent.change(box, { target: { value: "/clea" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(clearAgentTab).toHaveBeenCalledTimes(1);
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
    // Refused (Codex mid-turn, a pane not ready): the text stays, with why.
    clearAgentTab.mockResolvedValue(false);
    fireEvent.change(box, { target: { value: "/new" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(screen.getByRole("alert").textContent).toMatch(/Not sent/);
    expect((box as HTMLTextAreaElement).value).toBe("/new");
  });

  it("lets a sent command prefix go once the command it completed to is recorded", async () => {
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, scheduleTargetId: "st-1" }] } }));
    sendSteeringPrompt.mockImplementation((_tab: TabEntry, text: string) => { noteSentPrompt("st-1", text); return Promise.resolve(); });
    reader(host);
    await screen.findByText("fix the parser");
    // `/com` continues `/compact` and `/context`: it goes as typed.
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/com" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(sendSteeringPrompt).toHaveBeenCalledWith(expect.anything(), "/com");
    expect(host.querySelector(".terminal-reader-turn.pending")?.textContent).toContain("/com");
    const compacted = {
      ...transcript,
      version: "v2",
      entries: [...transcript.entries, { kind: "prompt", text: "/compact", at: new Date(Date.now() + 1000).toISOString() }],
    };
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_tab_transcript" ? compacted : []));
    await waitFor(() => expect(host.querySelector(".terminal-reader-turn.pending")).toBeNull(), { timeout: 5000 });
  });

  it("keeps the text and says why when the prompt did not go in", async () => {
    sendSteeringPrompt.mockRejectedValue(new Error("agent terminal is not ready"));
    reader(host);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "hello" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(screen.getByRole("alert").textContent).toMatch(/Not sent/);
    expect((box as HTMLTextAreaElement).value).toBe("hello");
  });

  it("keeps an unsent draft per tab when the Reader goes away and comes back", async () => {
    const first = reader(host);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "not sent yet" } });
    first.unmount();
    const other = render(
      <TerminalReaderView host={host} ptyId="p:agent-2" scope="p" tabKey="agent-2" cwd="/p" visible focused />,
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    other.unmount();
    reader(host);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.value).toBe("not sent yet");
    sendSteeringPrompt.mockResolvedValue(undefined);
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(box.value).toBe("");
  });

  it("types Esc into the session on Esc, staying in the chat with the draft kept", async () => {
    written.length = 0;
    reader(host);
    await screen.findByText("fix the parser");
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "half typed" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Escape" }); });
    expect(written).toEqual(["\u001b"]);
    expect(screen.getByRole("textbox")).toBe(box);
    expect(box.value).toBe("half typed");
  });

  it("walks the session's prompts with ↑ and ↓, as the CLI's box, and gives the draft back", async () => {
    reader(host);
    await screen.findByText("fix the parser");
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "half typed" } });
    box.setSelectionRange(0, 0);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("/model opus");
    box.setSelectionRange(0, 0);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("fix the parser");
    box.setSelectionRange(0, 0);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("fix the parser");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.value).toBe("/model opus");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.value).toBe("half typed");
  });

  it("leaves ↑ to the text while the caret is below the first line", async () => {
    reader(host);
    await screen.findByText("fix the parser");
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "one\ntwo" } });
    box.setSelectionRange(6, 6);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("one\ntwo");
  });

  it("hides the composer while steering holds the keyboard, and takes it back after", async () => {
    act(() => useKeyboardSteeringStore.getState().enter());
    try {
      reader(host);
      await screen.findByText("fix the parser");
      expect(screen.queryByRole("textbox")).toBeNull();
      act(() => useKeyboardSteeringStore.getState().handOff("prompt"));
      expect(screen.queryByRole("textbox")).toBeNull();
      act(() => useKeyboardSteeringStore.getState().exit());
      expect(document.activeElement).toBe(screen.getByRole("textbox"));
    } finally {
      act(() => useKeyboardSteeringStore.getState().exit());
    }
  });

  it("empties the chat on a clear while the cleared session is still what is read", async () => {
    reader(host);
    await screen.findByText("fix the parser");
    act(() => useAgentClearUndoStore.getState().noteRoll("p:agent-1", "clear"));
    await waitFor(() => expect(host.textContent).not.toContain("fix the parser"));
    expect(useAgentClearUndoStore.getState().marks["p:agent-1"]).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show earlier turns" })).toBeNull();
    // Taken back: the whole conversation again.
    act(() => useAgentClearUndoStore.getState().noteRoll("p:agent-1", "resume"));
    await screen.findByText("fix the parser");
  });

  it("says why when there is no session to read", async () => {
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, sessionId: undefined }] } }));
    reader(host);
    await waitFor(() => expect(host.textContent).toMatch(/no session id yet/));
    expect(invoke).not.toHaveBeenCalledWith("agent_tab_transcript", expect.anything());
  });
});

describe("the Reader's subagents", () => {
  let host: HTMLElement;
  const session = {
    available: true,
    version: "s1",
    truncated: false,
    entries: [
      { kind: "prompt", text: "survey the repo", at: "2026-09-30T08:00:00Z" },
      { kind: "agent", text: "Find the parser", role: "Explore", subagent: "sa-1", at: "2026-09-30T08:00:10Z", finished: true },
      { kind: "agent", text: "Find the tests", role: "Explore", subagent: "sa-2", at: "2026-09-30T08:00:11Z" },
      { kind: "agent", text: "Not recorded yet", at: "2026-09-30T08:00:12Z" },
      { kind: "answer", text: "Both found.", at: "2026-09-30T08:02:00Z" },
    ],
  };
  const conversations: Record<string, unknown> = {
    "sa-1": { available: true, version: "a1", truncated: false, entries: [
      { kind: "prompt", text: "Find the parser" },
      { kind: "answer", text: "It lives in parse.ts." },
      { kind: "agent", text: "Read parse.ts", role: "general-purpose", subagent: "sa-1-1" },
    ] },
    "sa-2": { available: true, version: "a2", truncated: false, entries: [{ kind: "answer", text: "Tests sit beside the sources." }] },
    "sa-1-1": { available: false, reason: "no_transcript", entries: [], truncated: false },
  };
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    sendSteeringPrompt.mockReset();
    invoke.mockImplementation((command: string, args?: { subagent?: string | null }) => {
      if (command !== "agent_tab_transcript") return Promise.resolve([]);
      return Promise.resolve(args?.subagent ? conversations[args.subagent] : session);
    });
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, scheduleTargetId: "st-1" }] } }));
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
    if (term) unregisterTerminal("p:agent-1", term);
    term = undefined;
  });
  let term: Terminal | undefined;

  /** Opens the session's subagent named `task` from the list over the chat. */
  async function openListed(task: string) {
    const toggle = await screen.findByRole("button", { name: /Subagents \(/ });
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
    const list = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    fireEvent.click(within(list).getByText(task).closest("button")!);
  }

  it("shows the session's subagents in its chat, when each started, and a ✓ on the finished one", async () => {
    reader(host);
    await screen.findByText("Both found.");
    const cards = [...host.querySelectorAll<HTMLElement>(".terminal-reader-subagent")];
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Find the parser"),
      expect.stringContaining("Find the tests"),
      expect.stringContaining("Not recorded yet"),
    ]);
    expect(cards.every((card) => card.querySelector(".terminal-reader-time"))).toBe(true);
    expect(cards.map((card) => !!card.querySelector(".tab-status-mark.done"))).toEqual([true, false, false]);
  });

  it("opens a subagent's own conversation and goes back up", async () => {
    reader(host);
    await openListed("Find the parser");
    await screen.findByText("It lives in parse.ts.");
    expect(invoke).toHaveBeenCalledWith("agent_tab_transcript", expect.objectContaining({ sessionId: "launch-1", subagent: "sa-1" }));
    const bar = screen.getByRole("navigation", { name: "Subagent" });
    expect(bar.textContent).toContain("Find the parser");
    expect(screen.queryByText("Both found.")).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Back to the main conversation" }));
    await screen.findByText("Both found.");
    expect(screen.queryByRole("navigation", { name: "Subagent" })).toBeNull();
  });

  it("cannot open a subagent whose CLI has not said where it lives", async () => {
    reader(host);
    const toggle = await screen.findByRole("button", { name: /Subagents \(3\)/ });
    fireEvent.click(toggle);
    const list = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(within(list).getByText("Not recorded yet").closest("button")?.disabled).toBe(true);
    expect(host.querySelectorAll<HTMLButtonElement>(".terminal-reader-subagent")[2].disabled).toBe(true);
  });

  it("steps between siblings and opens nested subagents from cards; Esc goes up one level", async () => {
    reader(host);
    await openListed("Find the parser");
    await screen.findByText("It lives in parse.ts.");
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next subagent" }));
    await screen.findByText("Tests sit beside the sources.");
    expect(screen.getByText("2 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous subagent" }));
    fireEvent.click((await screen.findByText("Read parse.ts")).closest("button")!);
    await waitFor(() => expect(host.textContent).toContain("This subagent’s conversation can’t be read"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await screen.findByText("It lives in parse.ts.");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await screen.findByText("Both found.");
  });

  it("lists every subagent of the session and opens one from the list", async () => {
    reader(host);
    const toggle = await screen.findByRole("button", { name: /Subagents \(3\)/ });
    fireEvent.click(toggle);
    const list = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    fireEvent.click(within(list).getByText("Find the tests").closest("button")!);
    await screen.findByText("Tests sit beside the sources.");
  });

  it("goes back to the session when a prompt is sent from a subagent on another CLI", async () => {
    // A Claude tab writes to the subagent instead (`subagentInput`, MobileSubagentInput.test).
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, label: "Codex", cmd: "codex", scheduleTargetId: "st-1" }] } }));
    sendSteeringPrompt.mockImplementation((_tab: TabEntry, text: string) => { noteSentPrompt("st-1", text); return Promise.resolve(); });
    reader(host);
    await openListed("Find the parser");
    await screen.findByText("It lives in parse.ts.");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "now fix it" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(sendSteeringPrompt).toHaveBeenCalledWith(expect.objectContaining({ key: "agent-1" }), "now fix it");
    await screen.findByText("Both found.");
    expect(host.querySelector(".terminal-reader-turn.pending")?.textContent).toContain("now fix it");
  });

  it("names the open subagent's own model while it is still at work", async () => {
    const running = { ...session, version: "s2", entries: session.entries.map((entry) => (entry.subagent === "sa-1" ? { ...entry, running: true } : entry)) };
    const sub = { ...(conversations["sa-1"] as object), model: "claude-haiku-4-5-20251001", tokens: 12_345 };
    invoke.mockImplementation((command: string, args?: { subagent?: string | null }) => {
      if (command !== "agent_tab_transcript") return Promise.resolve([]);
      return Promise.resolve(args?.subagent === "sa-1" ? sub : args?.subagent ? conversations[args.subagent] : running);
    });
    term = fakeTerminal(["> survey", "", "✻ Thinking… (9s · esc to interrupt)", ">", "~/p (develop) · Opus 4.1 · 85% context left"]);
    registerTerminal("p:agent-1", term);
    reader(host);
    await screen.findByText("Opus is working…");
    fireEvent.click(await screen.findByRole("button", { name: /Subagents \(3\)/ }));
    // The list marks the one still at work.
    const busy = screen.getAllByRole("img", { name: "Agent is working…" });
    expect(busy).toHaveLength(1);
    expect(busy[0].closest("button")?.textContent).toContain("Find the parser");
    await openListed("Find the parser");
    const row = (await screen.findByText("Haiku is working…")).closest(".terminal-reader-working")!;
    expect(screen.queryByText("Opus is working…")).toBeNull();
    // Its own figures, as the phone's row shows them.
    expect(row.querySelector("small")?.textContent).toMatch(/12\.3k tokens/);
    // A sibling that has reported back shows no working row.
    fireEvent.click(screen.getByRole("button", { name: "Next subagent" }));
    await screen.findByText("Tests sit beside the sources.");
    expect(screen.queryByText(/is working…/)).toBeNull();
  });

  it("keeps a background subagent at work after the session's turn ends", async () => {
    const running = { ...session, version: "s2", entries: session.entries.map((entry) => (entry.subagent === "sa-1" ? { ...entry, running: true, background: true } : entry)) };
    const sub = { ...(conversations["sa-1"] as object), model: "claude-haiku-4-5-20251001" };
    invoke.mockImplementation((command: string, args?: { subagent?: string | null }) => {
      if (command !== "agent_tab_transcript") return Promise.resolve([]);
      return Promise.resolve(args?.subagent === "sa-1" ? sub : args?.subagent ? conversations[args.subagent] : running);
    });
    reader(host);
    // The session's turn is over: its working row stands for the subagent.
    expect(await screen.findByText("Subagents working in the background… (1)")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /Subagents \(3\)/ }));
    expect(screen.getAllByRole("img", { name: "Agent is working…" })).toHaveLength(1);
    await openListed("Find the parser");
    expect(await screen.findByText("Haiku is working…")).toBeTruthy();
    expect(screen.queryByText(/in the background…/)).toBeNull();
    // The session is idle: Esc would stop nothing.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("the Reader's live rows", () => {
  let host: HTMLElement;
  let term: Terminal | undefined;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    written.length = 0;
    invoke.mockReset();
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_tab_transcript" ? { ...transcript, truncated: false } : []));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    if (term) unregisterTerminal("p:agent-1", term);
    host.remove();
    vi.useRealTimers();
  });

  it("answers the question on screen with a click: arrows from the highlight, then Enter", async () => {
    term = fakeTerminal([
      "> fix the strings", "", "Edit file", "  src/lib/i18n.ts", "",
      "Do you want to make this edit to i18n.ts?",
      "❯ 1. Yes", "  2. Yes, allow all edits during this session", "  3. No, and tell Claude what to do differently",
      "", "  esc to cancel",
    ]);
    registerTerminal("p:agent-1", term);
    reader(host);
    const group = await screen.findByRole("group", { name: "Waiting for your answer" });
    expect(group.textContent).toMatch(/Do you want to make this edit/);
    fireEvent.click(screen.getByRole("button", { name: /Yes, allow all edits/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(written).toEqual(["\u001b[B", "\r"]);
    // Nothing can be clicked twice while the session redraws.
    expect((screen.getByRole("button", { name: /No, and tell Claude/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an agent's own question as its header, its question and tagged rows — not the screen", async () => {
    term = fakeTerminal([
      "> push it", "",
      "● My fix is ready, but pushing develop now would also push four",
      "  other commits.", "",
      "☐ Push scope", "",
      "Four other-session commits sit unpushed on develop. How should I land my",
      "Windows/CodeQL fix?", "",
      "❯ 1. Fix only (Recommended)", "     Put my fix directly on the pushed main.",
      "  2. Push everything", "     Push develop with all four commits.",
      "", "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ]);
    registerTerminal("p:agent-1", term);
    reader(host);
    const group = await screen.findByRole("group", { name: "Waiting for your answer" });
    expect(group.querySelector(".terminal-reader-question-tabs")?.textContent).toBe("Push scope");
    expect(group.querySelector(".terminal-reader-question-ask")?.textContent)
      .toBe("Four other-session commits sit unpushed on develop. How should I land my Windows/CodeQL fix?");
    expect(group.querySelector(".terminal-reader-question-context")).toBeNull();
    expect(group.textContent).not.toMatch(/☐|My fix is ready|\(Recommended\)/);
    expect(group.querySelector(".terminal-reader-recommended")?.textContent).toBe("Recommended");
  });

  it("walks a several-question dialog's tabs with ←/→, so an answer can be changed before Submit", async () => {
    term = fakeTerminal([
      "> tag it", "",
      "←  ☒ Scope  ☒ Release tag  ✔ Submit  →", "",
      "Review your answers", "",
      "❯ 1. Submit answers", "  2. Cancel",
      "", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ]);
    registerTerminal("p:agent-1", term);
    reader(host);
    const steps = await screen.findByRole("toolbar", { name: "Questions" });
    expect(steps.textContent).toMatch(/✓ Scope.*✓ Release tag.*Submit/);
    // The row does not say which step is on screen here: the arrows still
    // walk, the headers wait until it does.
    expect((screen.getByRole("button", { name: /Scope/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(written).toEqual(["\u001b[D"]);
    expect(screen.queryByText("Answering…")).toBeNull();
  });

  it("shows the agent at work and stops it with Esc", async () => {
    term = fakeTerminal(["> fix it", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> ", "  ? for shortcuts"]);
    registerTerminal("p:agent-1", term);
    reader(host);
    const status = await screen.findByText("Agent is working…");
    expect(status.parentElement?.textContent).toMatch(/9s · 1.2k tokens/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop" })); });
    expect(written).toEqual(["\u001b"]);
  });

  it("shows the shell at work under the working row, and its whole command on a click", async () => {
    const command = "cargo test -q --manifest-path src-tauri/Cargo.toml \\\n  -- --test-threads=1";
    invoke.mockImplementation((name: string) => Promise.resolve(name === "agent_tab_transcript"
      ? { ...transcript, shells: [{ command, description: "Run the backend tests", at: "2026-09-30T08:03:00Z" }] }
      : []));
    term = fakeTerminal(["> fix it", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> ", "  ? for shortcuts"]);
    registerTerminal("p:agent-1", term);
    reader(host);
    const line = await screen.findByText("Shell is running…");
    const toggle = line.closest("button")!;
    expect(toggle.textContent).toMatch(/Run the backend tests/);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/--test-threads=1/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.textContent).toBe(command);
    fireEvent.click(toggle);
    expect(screen.queryByText(/--test-threads=1/)).toBeNull();
  });

  it("shows no shell line while the agent is not at work", async () => {
    invoke.mockImplementation((name: string) => Promise.resolve(name === "agent_tab_transcript"
      ? { ...transcript, shells: [{ command: "sleep 999" }] }
      : []));
    term = fakeTerminal(["> fix it", "", "Done.", "> ", "  ? for shortcuts"]);
    registerTerminal("p:agent-1", term);
    reader(host);
    await screen.findByText("fix the parser");
    expect(screen.queryByText("Shell is running…")).toBeNull();
  });

  it("shows a background shell while the agent is idle", async () => {
    invoke.mockImplementation((name: string) => Promise.resolve(name === "agent_tab_transcript"
      ? { ...transcript, shells: [{ command: "sleep 999" }, { command: "npm run dev", background: true }] }
      : []));
    term = fakeTerminal(["> fix it", "", "Done.", "> ", "  ? for shortcuts"]);
    registerTerminal("p:agent-1", term);
    reader(host);
    const line = await screen.findByText("Background shell running…");
    expect(line.closest("button")?.textContent).toMatch(/npm run dev/);
    expect(screen.queryByText("Shell is running…")).toBeNull();
  });

  it("names the model at work and shows the status line's facts with the account's limits", async () => {
    invoke.mockImplementation((command: string) => Promise.resolve(
      command === "agent_tab_transcript" ? { ...transcript, truncated: false }
        : command === "agent_usage" ? {
          agent: "claude", label: "Claude", supported: true, cached: false,
          raw: "Current session: 71% used\nCurrent week (all models): 94% used\nCurrent week (Fable): 12% used",
        }
          : []));
    term = fakeTerminal([
      "> fix it", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", ">",
      "~/p (develop) · Opus 4.1 · 85% context left",
    ]);
    registerTerminal("p:agent-1", term);
    reader(host);
    expect(await screen.findByText("Opus is working…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Opus 4.1" })).toBeTruthy();
    const facts = host.querySelector(".terminal-reader-facts")!;
    expect(facts.textContent).toContain("⎇ develop");
    expect(facts.textContent).toContain("85% context");
    await waitFor(() => expect(facts.textContent).toContain("5h 29%"));
    expect(facts.textContent).toContain("week 6%");
    expect(host.querySelector(".terminal-reader-fact.high")?.textContent).toBe("week 6%");
  });

  it("shows the mode, the effort the busy row named, the folder and its worktree", async () => {
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, cwd: `/home/u/p/${NAMES.worktreesDir}/feat-x` }] } }));
    const rows = ["> fix it", "", "✻ Pondering… (9s · ↓ 1.2k tokens · thinking with high effort)", ">", "⏵⏵ accept edits on (shift+tab to cycle)"];
    term = fakeTerminal(rows);
    registerTerminal("p:agent-1", term);
    reader(host);
    expect(await screen.findByRole("button", { name: "Accept edits" })).toBeTruthy();
    const facts = host.querySelector(".terminal-reader-facts")!;
    expect(facts.textContent).toContain("high effort");
    expect(facts.textContent).toContain("…/worktrees/feat-x");
    expect(facts.textContent).toContain("worktree feat-x");
    // The effort stays once the turn is over.
    rows.splice(0, rows.length, "Done.", ">", "⏵⏵ accept edits on (shift+tab to cycle)");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(facts.textContent).toContain("high effort");
  });

  it("shows the effort the transcript records and changes it with /effort, or Codex's /model", async () => {
    submitCommand.mockClear();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, scheduleTargetId: "st-1" }] } }));
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_tab_transcript" ? { ...transcript, effort: "medium" } : []));
    term = fakeTerminal([">", "⏵⏵ accept edits on (shift+tab to cycle)"]);
    registerTerminal("p:agent-1", term);
    const view = reader(host);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    // No busy row has named it: the transcript does.
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /medium effort/ })); });
    const list = screen.getByRole("dialog", { name: "Reasoning effort" });
    await act(async () => { fireEvent.click(within(list).getByRole("button", { name: /xhigh effort/ })); });
    expect(submitCommand).toHaveBeenCalledWith("st-1", "/effort xhigh");
    expect(screen.queryByRole("dialog", { name: "Reasoning effort" })).toBeNull();
    expect(screen.getByRole("button", { name: /xhigh effort/ })).toBeTruthy();
    view.unmount();

    // Codex sets it on its /model picker's next step.
    submitCommand.mockClear();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, cmd: "codex", label: "Codex", scheduleTargetId: "st-1" }] } }));
    reader(host);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /medium effort/ })); });
    expect(submitCommand).toHaveBeenCalledWith("st-1", "/model");
  });

  it("switches the mode from its list by walking Shift+Tab until the session shows it", async () => {
    const rows = [">", "⏵⏵ accept edits on (shift+tab to cycle)"];
    term = fakeTerminal(rows);
    registerTerminal("p:agent-1", term);
    reader(host);
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Accept edits" })); });
    const list = screen.getByRole("dialog", { name: "Permission mode" });
    await act(async () => { fireEvent.click(within(list).getByRole("button", { name: /Plan/ })); });
    expect(written).toEqual(["\u001b[Z"]);
    rows.splice(0, rows.length, ">", "⏸ plan mode on (shift+tab to cycle)");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(written).toEqual(["\u001b[Z"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
  });

  it("chooses Codex permissions from its native picker and follows the Full Access confirmation", async () => {
    submitCommand.mockClear();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, cmd: "codex", label: "Codex", scheduleTargetId: "st-1" }] } }));
    const rows = ["›", "gpt-6 · 85% context left"];
    term = fakeTerminal(rows);
    registerTerminal("p:agent-1", term);
    reader(host);
    const chip = screen.getByTitle("Choose permissions — opens the session's own /permissions picker");
    await act(async () => { fireEvent.click(chip); });
    expect(submitCommand).toHaveBeenCalledWith("st-1", "/permissions");
    expect(written).toEqual([]);
    expect(screen.getByRole("dialog", { name: "Permission mode" }).textContent).toContain("Waiting for the session's permission picker");
    rows.splice(0, rows.length, "Update Model Permissions", "",
      "› 1. Ask for approval (current)   Ask before running commands outside the workspace.",
      "  2. Approve for me   Review risky actions automatically.",
      "  3. Full Access   Allow unrestricted access.",
      "  4. Read Only   Only read files.", "", "Press enter to confirm or esc to go back");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
    const list = screen.getByRole("dialog", { name: "Update Model Permissions" });
    expect(within(list).getByRole("button", { name: /Approve for me/ })).toBeTruthy();
    expect(within(list).queryByRole("button", { name: /Plan/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Waiting for your answer" })).toBeNull();
    await act(async () => {
      fireEvent.click(within(list).getByRole("button", { name: /Full Access/ }));
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(written).toEqual(["\u001b[B", "\u001b[B", "\r"]);
    rows.splice(0, rows.length, "Enable full access?", "",
      "› 1. Yes, enable full access", "  2. No, go back", "", "Press enter to confirm or esc to go back");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const confirmation = screen.getByRole("dialog", { name: "Enable full access?" });
    await act(async () => { fireEvent.click(within(confirmation).getByRole("button", { name: /Yes, enable/ })); });
    expect(written[written.length - 1]).toBe("\r");
    rows.splice(0, rows.length, "• Permissions updated to Full Access", "›", "gpt-6 · 85% context left");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chip.textContent).toContain("Full access");
  });

  it("closes Codex's permission picker with Esc and does not open it during a turn", async () => {
    submitCommand.mockClear();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, cmd: "codex", label: "Codex", scheduleTargetId: "st-1" }] } }));
    const rows = ["›", "gpt-6 · 85% context left"];
    term = fakeTerminal(rows);
    registerTerminal("p:agent-1", term);
    reader(host);
    const chip = screen.getByTitle("Choose permissions — opens the session's own /permissions picker");
    await act(async () => { fireEvent.click(chip); });
    rows.splice(0, rows.length, "Update Model Permissions", "", "› 1. Ask for approval", "  2. Read Only", "", "Press enter to confirm or esc to go back");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); });
    expect(written).toEqual(["\u001b"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    rows.splice(0, rows.length, "› fix it", "Working (9s · esc to interrupt)", "›", "gpt-6 · 85% context left");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(chip);
    expect(submitCommand).toHaveBeenCalledTimes(1);
  });

  it("opens the session's own /model picker as a list and answers it there", async () => {
    submitCommand.mockClear();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, scheduleTargetId: "st-1" }] } }));
    const rows = [">", "~/p (develop) · Opus 4.1 · 85% context left"];
    term = fakeTerminal(rows);
    registerTerminal("p:agent-1", term);
    reader(host);
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Opus 4.1" })); });
    expect(submitCommand).toHaveBeenCalledWith("st-1", "/model");
    rows.splice(0, rows.length,
      "> /model", "", "Select model", "Switch between Claude models.", "",
      "  1. Default (recommended)   Opus",
      "❯ 2. Sonnet                  Everyday tasks",
      "  3. Haiku                   Fastest",
      "", "Enter to confirm · Esc to exit");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const list = screen.getByRole("dialog", { name: "Select model" });
    // The picker is listed once — not also as a question in the chat.
    expect(screen.queryByRole("group", { name: "Waiting for your answer" })).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: /Haiku/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(written).toEqual(["\u001b[B", "\r"]);
    rows.splice(0, rows.length, ">", "~/p (develop) · Haiku 4.5 · 85% context left");
    // Gone after the answer: a short wait for a next step (Codex's reasoning
    // level), then the list closes.
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Haiku 4.5" })).toBeTruthy();
  });

  it("visualizes Codex /status with remaining meters and the CLI's details", async () => {
    submitCommand.mockClear();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, cmd: "codex", label: "Codex", scheduleTargetId: "st-1" }] } }));
    const rows = ["›", "gpt-6 · 80% context left"];
    term = fakeTerminal(rows);
    registerTerminal("p:agent-1", term);
    reader(host);
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /^Status/ })); });
    expect(submitCommand).toHaveBeenCalledWith("st-1", "/status");
    rows.splice(0, rows.length, "/status", ">_ OpenAI Codex (v0.101.0)",
      "Model: gpt-6 (high)", "Directory: /p", "Permissions: Custom (workspace-write)",
      "Context window: 80% left (54K used / 272K)",
      "5h limit: [██████░░░░] 60% left (resets 13:45)",
      "Weekly limit: [░░░░░░░░░░] 5% left", "Session: launch-1", "›");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const panel = screen.getByRole("dialog", { name: "Codex status" });
    expect(within(panel).getByRole("meter", { name: "Context window" }).getAttribute("aria-valuenow")).toBe("80");
    expect(within(panel).getByRole("meter", { name: "5-hour limit" }).getAttribute("aria-valuenow")).toBe("60");
    expect(within(panel).getByRole("meter", { name: "Weekly limit" }).getAttribute("aria-valuenow")).toBe("5");
    expect(panel.textContent).toContain("Custom (workspace-write)");
    expect(panel.querySelector(".terminal-reader-status-meter.low")?.textContent).toContain("5% left");
    expect(panel.querySelector("details pre")?.textContent).toContain("Session: launch-1");
    fireEvent.click(within(panel).getByRole("button", { name: "Refresh /status" }));
    expect(submitCommand).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Codex status" })).toBeNull();
  });

  it("opens /status from Codex's chat composer without sending an agent prompt or replacing busy input", async () => {
    submitCommand.mockClear();
    sendSteeringPrompt.mockClear();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, cmd: "codex", label: "Codex", scheduleTargetId: "st-1" }] } }));
    invoke.mockImplementation((command: string) => Promise.resolve(command === "agent_tab_transcript"
      ? { ...transcript, usage: { contextLeft: 75, session: { used: 40 } } } : []));
    term = fakeTerminal(["› fix it", "Working (9s · esc to interrupt)", "›", "gpt-6 · 75% context left"]);
    registerTerminal("p:agent-1", term);
    reader(host);
    await screen.findByText(/is working…/);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/status" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    const panel = screen.getByRole("dialog", { name: "Codex status" });
    expect(within(panel).getAllByRole("meter")).toHaveLength(2);
    expect(within(panel).queryByRole("meter", { name: "Weekly limit" })).toBeNull();
    expect(submitCommand).not.toHaveBeenCalled();
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe("");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Codex status" })).toBeNull();
  });
});

describe("the Chat switch on the prompt strip", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(() => Promise.resolve([]));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
  });

  it("shows only when offered and flips between Reader and Terminal", async () => {
    const toggle = vi.fn();
    const { rerender } = render(
      <TerminalPromptStrip ptyId="p:agent-1" scope="p" tabKey="agent-1" background="#000" foreground="#fff" onReturnFocus={() => {}} />,
    );
    await act(async () => {});
    expect(screen.queryByRole("button", { pressed: false, name: /Chat/ })).toBeNull();
    rerender(
      <TerminalPromptStrip ptyId="p:agent-1" scope="p" tabKey="agent-1" background="#000" foreground="#fff" onReturnFocus={() => {}} reader={{ open: false, onToggle: toggle }} />,
    );
    fireEvent.click(screen.getByRole("button", { pressed: false, name: /Chat/ }));
    expect(toggle).toHaveBeenCalled();
    rerender(
      <TerminalPromptStrip ptyId="p:agent-1" scope="p" tabKey="agent-1" background="#000" foreground="#fff" onReturnFocus={() => {}} reader={{ open: true, onToggle: toggle }} />,
    );
    expect(screen.getByRole("button", { pressed: true, name: /Terminal/ })).toBeTruthy();
  });
});

describe("agentReader helpers", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the session's prompts for ↑, oldest first, a repeat once", () => {
    expect(composerHistory([
      { kind: "prompt", text: "a" }, { kind: "answer", text: "x" }, { kind: "prompt", text: " a " }, { kind: "prompt", text: "b" },
    ], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("names a linked worktree from the path and shortens the path", () => {
    expect(worktreeOfPath(`/p/${NAMES.worktreesDir}/feat`)).toBe("feat");
    expect(worktreeOfPath("/p/.claude/worktrees/x/src")).toBe("x");
    expect(worktreeOfPath(`C:\\p\\${NAMES.projectDir}\\worktrees\\w`)).toBe("w");
    expect(worktreeOfPath("/p/worktrees/feat")).toBeUndefined();
    expect(worktreeOfPath(undefined)).toBeUndefined();
    expect(shortPath("/home/u/p/")).toBe("…/u/p");
    expect(shortPath("~/p")).toBe("~/p");
  });

  it("offers the Reader only for agents whose transcript is read", () => {
    expect(readerOffered(tab)).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "codex" })).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "gemini" })).toBe(false);
    expect(readerOffered({ kind: "local_agent", cmd: "ollama" })).toBe(false);
    expect(readerOffered({ kind: "shell", cmd: "bash" })).toBe(false);
    expect(readerOffered(undefined)).toBe(false);
  });

  it("builds the read like the phone bridge: root has no project, --continue has no launch floor", () => {
    expect(readerRequest("p", { ...tab, sessionId: undefined }, "/p", undefined, 60)).toBeNull();
    expect(readerRequest("root", tab, "/r", "v9", 60)).toMatchObject({ projectId: null, version: "v9", limit: 60 });
    expect(readerRequest("p", { ...tab, args: ["--continue"] }, "/p", undefined, 60)).toMatchObject({ since: null });
    expect(readerRequest("p", tab, "/p", undefined, 60)).toMatchObject({ subagent: null });
    expect(readerRequest("p", tab, "/p", undefined, 60, "sa-1")).toMatchObject({ subagent: "sa-1" });
  });

  it("keeps what is shown when the read answers unchanged", () => {
    const shown = { available: true, entries: [], truncated: false, version: "v1" };
    expect(mergeTranscript(shown, { available: true, unchanged: true, entries: [], truncated: false })).toBe(shown);
  });

  it("remembers one choice per agent CLI; the terminal is the default", () => {
    expect(rememberedReader("claude")).toBe(false);
    rememberReader("claude", true);
    expect(rememberedReader("claude")).toBe(true);
    expect(rememberedReader("codex")).toBe(false);
    rememberReader("claude", false);
    expect(rememberedReader("claude")).toBe(false);
    // The window-wide choice it replaced seeds every CLI without its own.
    localStorage.clear();
    localStorage.setItem(storageKey("agentReader.open"), "1");
    rememberReader("codex", false);
    expect(rememberedReader("claude")).toBe(true);
    expect(rememberedReader("codex")).toBe(false);
  });

  it("picking the Reader in one pane switches every pane of that CLI only", () => {
    const { result: claude } = renderHook(() => useReaderOpen("claude", true));
    const { result: otherClaude } = renderHook(() => useReaderOpen("claude", true));
    const { result: codex } = renderHook(() => useReaderOpen("codex", true));
    const { result: gemini } = renderHook(() => useReaderOpen("gemini", false));
    act(() => useAgentReaderStore.getState().set("claude", true));
    expect(claude.current).toBe(true);
    expect(otherClaude.current).toBe(true);
    expect(codex.current).toBe(false);
    expect(gemini.current).toBe(false);
    expect(rememberedReader("claude")).toBe(true);
    act(() => useAgentReaderStore.getState().set("claude", false));
    expect(claude.current).toBe(false);
    expect(otherClaude.current).toBe(false);
  });
});
