import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
vi.mock("../../lib/shortcuts/steeringAgent", () => ({ sendSteeringPrompt: vi.fn(() => Promise.resolve()), clearAgentTab: vi.fn(() => Promise.resolve(true)) }));
vi.mock("../../lib/terminal/terminalInput", () => ({ writePtyInput: () => Promise.resolve() }));
vi.mock("../../components/embed/FileViewerPane", () => ({ FileViewerPane: ({ path }: { path: string }) => <div data-testid="file-viewer">{path}</div> }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { ReaderSideChat } from "../../components/layout/ReaderSideChat";
import { useReaderChatsStore } from "../../lib/agents/agentChats";
import { setReaderDraft } from "../../lib/agents/readerDrafts";
import { clearSentPrompts } from "../../lib/agents/sentPrompts";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useReaderSideChatStore } from "../../stores/agents/readerSideChat";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { Settings } from "../../types";

const ID = "p:agent-1";
const tab: TabEntry = { key: "agent-1", label: "Parser fix", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000, scheduleTargetId: "st-1" };
const transcript = { available: true, version: "v1", truncated: false, entries: [{ kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" }] };

type Panel = "changes" | "files" | null;

/** The pane as `TerminalView` wires it, beside the side panel's cover. */
function Pane({ host, start, offered = true }: { host: HTMLElement; start: Panel; offered?: boolean }) {
  const [panel, setPanel] = useState<Panel>(start);
  return <>
    <button type="button" onClick={() => setPanel("changes")}>to Diffs</button>
    <TerminalReaderView host={host} ptyId={ID} scope="p" tabKey="agent-1" cwd="/p"
      visible focused={panel === null} paneFocused sideChatOffered={offered} shown
      changesOpen={panel === "changes"} filesOpen={panel === "files"}
      onShowChat={() => setPanel(null)} />
    <aside data-testid="panel"><ReaderSideChat /></aside>
  </>;
}

describe("the chat in the side panel under Diffs and Data", () => {
  let host: HTMLElement;
  const settings = (patch: Partial<Settings>) =>
    useSettingsStore.setState({ settings: { experimental_explicit: true, ...patch } as Settings, loaded: true });
  beforeEach(() => {
    localStorage.clear();
    clearSentPrompts();
    invoke.mockReset();
    invoke.mockImplementation((command: string, args?: { patch?: Partial<Settings> }) => Promise.resolve(
      command === "agent_tab_transcript" ? transcript
        : command === "agent_tab_changes" ? { available: true, version: "c0", truncated: false, changes: [] }
        : command === "patch_settings" ? { ...useSettingsStore.getState().settings, ...args?.patch }
        : [],
    ));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    useReaderChatsStore.setState({ byPty: {} });
    useReaderSideChatStore.setState({ claims: [], slot: null });
    setReaderDraft("p", "agent-1", "");
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(async () => {
    await act(async () => {});
    cleanup();
    host.remove();
  });

  const stream = () => document.querySelector<HTMLElement>(".terminal-reader-stream")!;
  const panel = () => screen.getByTestId("panel");
  const toggle = () => screen.getByRole("button", { name: "Conversation in the side panel" });

  it("moves the one chat into the panel while Diffs is open, and back on ‹ Chat", async () => {
    settings({ reader_side_chat: true });
    render(<Pane host={host} start="changes" />);
    await screen.findByText("fix the parser");
    const chat = stream();
    expect(panel().contains(chat)).toBe(true);
    expect(host.contains(chat)).toBe(false);
    expect(panel().textContent).toContain("Parser fix");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(panel()).getByRole("button", { name: /Chat/ }));
    await waitFor(() => expect(host.contains(chat)).toBe(true));
    // The same element: nothing was mounted twice.
    expect(stream()).toBe(chat);
    expect(useReaderSideChatStore.getState().claims).toEqual([]);
    expect(panel().querySelector(".reader-side-chat")).toBeNull();
  });

  it("keeps the chat in the tab with the switch off, and the switch in the docked line turns it on", async () => {
    settings({});
    render(<Pane host={host} start="changes" />);
    await screen.findByText("No file changes in this conversation yet.");
    expect(host.contains(stream())).toBe(true);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle());
    expect(useSettingsStore.getState().settings?.reader_side_chat).toBe(true);
    await waitFor(() => expect(panel().contains(stream())).toBe(true));
  });

  it("offers no switch and never claims the panel where the Reader may not use it", async () => {
    settings({ reader_side_chat: true });
    render(<Pane host={host} start="changes" offered={false} />);
    await screen.findByText("No file changes in this conversation yet.");
    expect(screen.queryByRole("button", { name: "Conversation in the side panel" })).toBeNull();
    expect(useReaderSideChatStore.getState().claims).toEqual([]);
    expect(host.contains(stream())).toBe(true);
  });
});
