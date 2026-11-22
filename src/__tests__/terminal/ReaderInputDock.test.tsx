import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const send = vi.fn();
vi.mock("../../lib/shortcuts/steeringAgent", () => ({ sendSteeringPrompt: (...args: unknown[]) => send(...args), clearAgentTab: vi.fn(() => Promise.resolve(true)) }));
const written: string[] = [];
vi.mock("../../lib/terminal/terminalInput", () => ({
  writePtyInput: (_id: string, bytes: Uint8Array) => {
    written.push(new TextDecoder().decode(bytes));
    return Promise.resolve();
  },
}));
vi.mock("../../components/embed/FileViewerPane", () => ({ FileViewerPane: ({ path }: { path: string }) => <div data-testid="file-viewer">{path}</div> }));

import type { Terminal } from "@xterm/xterm";
import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { useReaderChatsStore } from "../../lib/agents/agentChats";
import { openReaderComposer } from "../../lib/agents/readerSteering";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { setReaderDraft } from "../../lib/agents/readerDrafts";
import { clearSentPrompts, noteSentPrompt } from "../../lib/agents/sentPrompts";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const ID = "p:agent-1";
const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000, scheduleTargetId: "st-1" };
const transcript = { available: true, version: "v1", truncated: false, entries: [{ kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" }] };
const WORKING = ["> fix it", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> ", "  ? for shortcuts"];
const ASKING = [
  "> fix the strings", "", "Edit file", "  src/lib/i18n.ts", "",
  "Do you want to make this edit to i18n.ts?",
  "❯ 1. Yes", "  2. Yes, allow all edits during this session", "  3. No, and tell Claude what to do differently",
  "", "  esc to cancel",
];

/** A pane's xterm as far as the Reader reads it (`TerminalReaderView.test`). */
function fakeTerminal(rows: string[]): Terminal {
  return {
    buffer: { active: { get length() { return rows.length; }, getLine: (row: number) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) } },
    onWriteParsed: () => ({ dispose() {} }),
  } as unknown as Terminal;
}

type Panel = "changes" | "files" | null;

/** The pane as `TerminalView` wires it: the top bar's action slot, Chat
 * focused only without a panel, and Chat shown again by `onShowChat`. */
function Pane({ host, start, onShowChat }: { host: HTMLElement; start: Panel; onShowChat?: () => void }) {
  const [panel, setPanel] = useState<Panel>(start);
  const [actionSlot, setActionSlot] = useState<HTMLSpanElement | null>(null);
  return <>
    <span ref={setActionSlot} />
    <button type="button" onClick={() => setPanel("changes")}>to Diffs</button>
    <button type="button" onClick={() => setPanel("files")}>to Data</button>
    <TerminalReaderView host={host} ptyId={ID} scope="p" tabKey="agent-1" cwd="/p"
      visible focused={panel === null} shown changesOpen={panel === "changes"} filesOpen={panel === "files"}
      onShowChat={() => { setPanel(null); onShowChat?.(); }} actionSlot={actionSlot} />
  </>;
}

describe("the composer docked under Diffs and Data", () => {
  let host: HTMLElement;
  let term: Terminal | undefined;
  beforeEach(() => {
    localStorage.clear();
    clearSentPrompts();
    written.length = 0;
    invoke.mockReset();
    send.mockReset();
    send.mockResolvedValue(undefined);
    invoke.mockImplementation((command: string) => Promise.resolve(
      command === "agent_tab_transcript" ? transcript
        : command === "agent_tab_changes" ? { available: true, version: "c0", truncated: false, changes: [] }
        : [],
    ));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    useReaderChatsStore.setState({ byPty: {} });
    setReaderDraft("p", "agent-1", "");
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(async () => {
    await act(async () => {});
    cleanup();
    if (term) unregisterTerminal(ID, term);
    term = undefined;
    host.remove();
    vi.useRealTimers();
  });

  const root = () => host.querySelector<HTMLElement>(".terminal-reader")!;
  const dock = () => host.querySelector<HTMLElement>(".terminal-reader-dock")!;
  const box = () => dock().querySelector<HTMLTextAreaElement>("textarea")!;
  const status = () => host.querySelector<HTMLElement>(".terminal-reader-dock-status");
  const isOpen = () => root().classList.contains("dock-open");
  const diffsShown = () => screen.findByText("No file changes in this conversation yet.");
  const working = (rows = WORKING) => {
    term = fakeTerminal(rows);
    registerTerminal(ID, term);
  };

  it("keeps the one field, enabled and resting, under Diffs and under Data", async () => {
    render(<Pane host={host} start="changes" />);
    await diffsShown();
    const field = box();
    expect(field.disabled).toBe(false);
    expect(root().classList.contains("panel-open")).toBe(true);
    expect(isOpen()).toBe(false);
    expect(field.getAttribute("rows")).toBe("1");
    expect(field.placeholder).toBe("Message the agent — Enter sends");
    fireEvent.click(screen.getByRole("button", { name: "to Data" }));
    await waitFor(() => expect(host.querySelector(".terminal-files")).not.toBeNull());
    expect(box()).toBe(field);
    expect(field.disabled).toBe(false);
    expect(isOpen()).toBe(false);
  });

  it("opens on a focus or a press in the field, and rests again on a press in the panel", async () => {
    render(<Pane host={host} start="changes" />);
    await diffsShown();
    act(() => box().focus());
    expect(isOpen()).toBe(true);
    expect(box().getAttribute("rows")).toBe("3");
    const panel = host.querySelector<HTMLElement>(".terminal-changes")!;
    act(() => {
      fireEvent.pointerDown(panel);
      panel.focus();
    });
    expect(isOpen()).toBe(false);
    act(() => { fireEvent.pointerDown(box()); });
    expect(isOpen()).toBe(true);
  });

  it("rests again once steering's Prompt key has handed the field back", async () => {
    render(<Pane host={host} start="changes" />);
    await diffsShown();
    act(() => useKeyboardSteeringStore.getState().enter("scroll"));
    try {
      act(() => {
        expect(openReaderComposer(ID, "scroll")).toBe(true);
        useKeyboardSteeringStore.getState().handOff("prompt");
      });
      expect(document.activeElement).toBe(box());
      expect(isOpen()).toBe(true);
      act(() => { fireEvent.keyDown(box(), { key: "Escape" }); });
      // Nothing holds the field now: no facts row over the Diffs cursor.
      expect(dock().querySelector("textarea")).toBeNull();
      expect(isOpen()).toBe(false);
      act(() => useKeyboardSteeringStore.getState().exit());
      expect(box().value).toBe("");
      expect(isOpen()).toBe(false);
    } finally {
      act(() => useKeyboardSteeringStore.getState().exit());
    }
  });

  it("keeps the dock open while a press in it, or the window, takes the field's focus away", async () => {
    render(<Pane host={host} start="changes" />);
    await diffsShown();
    act(() => box().focus());
    expect(isOpen()).toBe(true);
    // The window losing focus: the field keeps it.
    act(() => { fireEvent.focusOut(box()); });
    expect(isOpen()).toBe(true);
    // WebKit focuses no button on a click: the press on a chip blurs the field
    // to nowhere before the click lands.
    const plan = within(dock()).getByRole("button", { name: /^Plan/ });
    act(() => {
      fireEvent.pointerDown(plan);
      box().blur();
    });
    expect(isOpen()).toBe(true);
    act(() => { fireEvent.pointerUp(plan); });
    fireEvent.click(plan);
    expect(box().value.startsWith("/plan")).toBe(true);
  });

  it("opens on a press on a chip, whose click still lands", async () => {
    render(<Pane host={host} start="changes" />);
    await diffsShown();
    const plan = within(dock()).getByRole("button", { name: /^Plan/ });
    act(() => { fireEvent.pointerDown(plan); });
    expect(isOpen()).toBe(true);
    fireEvent.click(plan);
    expect(box().value.startsWith("/plan")).toBe(true);
    expect(isOpen()).toBe(true);
  });

  it("opens for a draft, the same one Chat holds", async () => {
    render(<Pane host={host} start={null} />);
    await screen.findByText("fix the parser");
    const field = box();
    fireEvent.change(field, { target: { value: "half a thought" } });
    fireEvent.click(screen.getByRole("button", { name: "to Diffs" }));
    await diffsShown();
    expect(box()).toBe(field);
    expect(field.value).toBe("half a thought");
    expect(isOpen()).toBe(true);
    // A press in the panel keeps it open: the draft does.
    act(() => { fireEvent.pointerDown(host.querySelector(".terminal-changes")!); });
    expect(isOpen()).toBe(true);
  });

  it("leaves the keyboard to the panel on a switch to Diffs", async () => {
    render(<Pane host={host} start={null} />);
    await screen.findByText("fix the parser");
    expect(document.activeElement).toBe(box());
    fireEvent.click(screen.getByRole("button", { name: "to Diffs" }));
    await diffsShown();
    // `TerminalView` puts the keys on the panel's root; nothing takes them back.
    const panel = host.querySelector<HTMLElement>(".terminal-changes")!;
    act(() => panel.focus());
    await act(async () => {});
    expect(document.activeElement).toBe(panel);
    expect(isOpen()).toBe(false);
  });

  it("sends from Diffs and stays there", async () => {
    const onShowChat = vi.fn();
    render(<Pane host={host} start="changes" onShowChat={onShowChat} />);
    await diffsShown();
    fireEvent.change(box(), { target: { value: "look at b.md" } });
    await act(async () => { fireEvent.keyDown(box(), { key: "Enter" }); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ key: "agent-1" }), "look at b.md");
    expect(box().value).toBe("");
    expect(onShowChat).not.toHaveBeenCalled();
    expect(host.querySelector(".terminal-changes")).not.toBeNull();
  });

  it("shows the working line with Stop and the queued count, only under a panel", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    working();
    const view = render(<Pane host={host} start="changes" />);
    await diffsShown();
    const line = await waitFor(() => {
      const found = status();
      expect(found).not.toBeNull();
      return found!;
    });
    expect(line.getAttribute("role")).toBe("status");
    expect(line.querySelector(".terminal-reader-working-dots")).not.toBeNull();
    expect(line.textContent).not.toContain("queued");
    act(() => noteSentPrompt("st-1", "and the docs"));
    await waitFor(() => expect(status()?.textContent).toContain("1 queued"));
    written.length = 0;
    fireEvent.click(within(status()!).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(written).toContain("\x1b"));
    view.unmount();
    // Under Chat, Chat's own working row says it: no dock line.
    render(<Pane host={host} start={null} />);
    await screen.findByText("fix the parser");
    expect(status()).toBeNull();
  });

  it("shows no line while the agent is idle", async () => {
    render(<Pane host={host} start="changes" />);
    await diffsShown();
    expect(status()).toBeNull();
  });

  it("rests, locked, while a question waits, and answers it in Chat", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setReaderDraft("p", "agent-1", "kept for later");
    working(ASKING);
    const onShowChat = vi.fn();
    render(<Pane host={host} start="changes" onShowChat={onShowChat} />);
    await diffsShown();
    const line = await waitFor(() => {
      const found = status();
      expect(found?.textContent).toContain("The agent asks a question");
      return found!;
    });
    expect(line.textContent).toContain("Messages wait until it is answered");
    expect(box().disabled).toBe(true);
    expect(box().placeholder).toBe("Answer the agent's question first");
    expect(box().value).toBe("kept for later");
    expect(isOpen()).toBe(false);
    fireEvent.click(within(line).getByRole("button", { name: "Answer in Chat" }));
    expect(onShowChat).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(host.querySelector(".terminal-changes")).toBeNull();
    expect((document.activeElement as HTMLElement | null)?.classList.contains("terminal-reader-option")).toBe(true);
  });

  it("is the earlier chat's read-only foot under Diffs: no field, no line", async () => {
    working();
    const chats = [
      { id: "c-now", title: "the work at hand", updated: Date.now(), current: true },
      { id: "c-1", title: "fix the parser", updated: Date.now() - 86_400_000, current: false },
    ];
    useReaderChatsStore.getState().browse(ID, chats[1], chats);
    render(<Pane host={host} start="changes" />);
    await diffsShown();
    expect(dock().querySelector("textarea")).toBeNull();
    expect(dock().querySelector(".terminal-reader-chat-foot")).not.toBeNull();
    expect(status()).toBeNull();
  });
});
