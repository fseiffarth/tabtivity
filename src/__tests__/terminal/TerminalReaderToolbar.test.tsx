import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const invoke = vi.fn();
const send = vi.fn();
const openFile = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
vi.mock("../../lib/shortcuts/steeringAgent", () => ({ sendSteeringPrompt: (...args: unknown[]) => send(...args), clearAgentTab: vi.fn(() => Promise.resolve(true)) }));
vi.mock("../../lib/files/openFileEntry", () => ({ openFileEntry: (...args: unknown[]) => openFile(...args) }));
vi.mock("../../components/embed/FileViewerPane", () => ({ FileViewerPane: ({ path }: { path: string }) => <div data-testid="file-viewer">{path}</div> }));

import { TerminalPromptStrip } from "../../components/terminal/TerminalPromptStrip";
import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { splitDiffRows } from "../../components/terminal/TerminalReaderChanges";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { setReaderDraft } from "../../lib/agents/readerDrafts";
import { clearPathLinkCache } from "../../lib/terminal/pathLinks";
import { insertIntoReader } from "../../lib/terminal/terminalDrop";
import { COMMIT_PROMPTS } from "../../../mobile-web/src/terminal/commitPrompts";
import type { ProjectEntry } from "../../types";
import type { TranscriptEntry } from "../../../mobile-web/src/api";

const tab: TabEntry = { key: "a", label: "Claude", cmd: "claude", cwd: "/project", kind: "agent", sessionId: "launch", scheduleTargetId: "target" };

function Pane({ host }: { host: HTMLElement }) {
  const [navigationSlot, setNavigationSlot] = useState<HTMLSpanElement | null>(null);
  const [actionSlot, setActionSlot] = useState<HTMLSpanElement | null>(null);
  const open = useAgentReaderStore((state) => state.byAgent.claude ?? true);
  const [panel, setPanel] = useState<"changes" | "files" | null>(null);
  const [filesKnown, setFilesKnown] = useState(false);
  const changes = panel === "changes";
  const files = panel === "files";
  const on = open || panel !== null;
  const showChat = () => { setPanel(null); useAgentReaderStore.getState().set("claude", true); };
  return <>
    <TerminalPromptStrip ptyId="p:a" scope="p" tabKey="a" background="#000" foreground="#fff"
      onReturnFocus={() => {}} topBar chatShown={open}
      navigationSlot={setNavigationSlot} actionSlot={setActionSlot}
      reader={{ open: on, onToggle: () => { setPanel(null); useAgentReaderStore.getState().set("claude", !on); }, cwd: tab.cwd,
        changes: { open: changes, onToggle: () => (changes ? showChat() : setPanel("changes")) },
        files: { open: files, empty: !filesKnown, onToggle: () => (files ? showChat() : setPanel("files")) } }} />
    <TerminalReaderView host={host} ptyId="p:a" scope="p" tabKey="a" cwd={tab.cwd}
      visible={on} focused={open && !panel} shown={on} changesOpen={changes} filesOpen={files} onShowChat={showChat}
      onShowFiles={() => setPanel("files")} onFilesKnown={setFilesKnown}
      navigationSlot={navigationSlot} actionSlot={actionSlot} />
  </>;
}

describe("desktop conversation toolbar", () => {
  let host: HTMLElement;
  let entries: TranscriptEntry[];
  beforeEach(() => {
    localStorage.clear();
    clearPathLinkCache();
    vi.clearAllMocks();
    entries = [{ kind: "prompt", text: "hello", at: "2026-10-25T09:00:00Z" }];
    invoke.mockImplementation((command: string, args?: { candidates?: string[] }) => {
      if (command === "agent_tab_transcript") return Promise.resolve({ available: true, entries, truncated: false, version: "1" });
      if (command === "agent_tab_changes") return Promise.resolve({ available: true, changes: [], truncated: false, version: "1" });
      if (command === "resolve_text_paths") return Promise.resolve(args?.candidates?.map((path) => path === "src/result.ts"
        ? { name: "result.ts", path: "/project/src/result.ts", is_dir: false, size: 10, extension: ".ts" } : null));
      return Promise.resolve([]);
    });
    send.mockResolvedValue(undefined);
    useTabsStore.setState({ scope: "p", tabsByScope: { p: [tab] } });
    useAgentPromptsStore.setState({ historyByProject: { p: [] } });
    useAgentReaderStore.setState({ byAgent: { claude: true } });
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    useProjectsStore.setState({ projects: [{ id: "p", name: "P", directory: "/project", local_file: "/project/project.json" } as ProjectEntry] });
    setReaderDraft("p", "a", "");
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(async () => {
    await act(async () => {});
    cleanup();
    host.remove();
    useProjectsStore.setState({ projects: [] });
  });

  it("keeps the draft across Chat, Diffs and Terminal; Clear and Commit sit in the composer", async () => {
    render(<Pane host={host} />);
    await screen.findByText("hello");
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    const commit = screen.getByRole("button", { name: /^Commit/ });
    expect(commit.closest(".terminal-reader-composer")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Clear" }).closest(".terminal-reader-composer")).not.toBeNull();
    expect(host.querySelector(".reader-topbar-actions .terminal-reader-chip")).toBeNull();
    fireEvent.click(commit);
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /Split into commits/ })));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ key: "a" }), COMMIT_PROMPTS.split);
    fireEvent.change(box, { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "Diffs" }));
    await screen.findByText("No file changes in this conversation yet.");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")).toBe("true");
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Chat" })));
    expect(screen.getByRole("textbox")).toBe(box);
    expect(box.value).toBe("keep this draft");
    expect(host.querySelector(".terminal-changes")).toBeNull();
  });

  it("omits resource menus when this conversation has none", async () => {
    render(<Pane host={host} />);
    await screen.findByText("hello");
    expect(screen.queryByRole("button", { name: /Subagents|Workspaces/ })).toBeNull();
    expect((screen.getByRole("tab", { name: /^Files/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("returns to Chat when a prompt or dropped file is inserted while reviewing Diffs", async () => {
    render(<Pane host={host} />);
    await screen.findByText("hello");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "Diffs" }));
    await screen.findByText("No file changes in this conversation yet.");
    act(() => { expect(insertIntoReader("p:a", "file.ts")).toBe(true); });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("draft file.ts");
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
  });

  it("lists the conversation's files in the Files tab with the picked one in its viewer", async () => {
    entries.push({ kind: "answer", text: "Updated src/result.ts", at: "2026-10-25T09:01:00Z" });
    render(<Pane host={host} />);
    const filesTab = screen.getByRole("tab", { name: /^Files/ }) as HTMLButtonElement;
    await waitFor(() => expect(filesTab.disabled).toBe(false));
    fireEvent.click(filesTab);
    const option = within(screen.getByRole("listbox", { name: "Files this conversation names" })).getByRole("option", { name: "src/result.ts" });
    // Nothing picked yet: the newest file is shown.
    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("file-viewer").textContent).toBe("/project/src/result.ts");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(openFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Open in a tab/ }));
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ entry: expect.objectContaining({ path: "/project/src/result.ts" }) }));
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".terminal-files")).toBeNull();
  });

  it("shows a file clicked in the chat in the Files tab; Ctrl+click still opens a tab", async () => {
    entries.push({ kind: "answer", text: "Updated src/result.ts", at: "2026-10-25T09:01:00Z" });
    render(<Pane host={host} />);
    const link = await waitFor(() => {
      const found = host.querySelector<HTMLElement>('[data-path-link="src/result.ts"]');
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(link, { ctrlKey: true });
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(link);
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tab", { name: /^Files/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("file-viewer").textContent).toBe("/project/src/result.ts");
  });

  it("links a sent file no viewer shows; it opens only in the Files tab, outside the app on a click there", async () => {
    entries.push({ kind: "answer", text: "Sent to your desktop:\n\nblender/kb_top.stl", at: "2026-10-25T09:01:00Z" });
    invoke.mockImplementation((command: string, args?: { candidates?: string[]; path?: string }) => {
      if (command === "agent_tab_transcript") return Promise.resolve({ available: true, entries, truncated: false, version: "1" });
      if (command === "resolve_text_paths") return Promise.resolve(args?.candidates?.map((path) => path === "blender/kb_top.stl"
        ? { name: "kb_top.stl", path: "/project/blender/kb_top.stl", is_dir: false, size: 2048, extension: ".stl" } : null));
      return Promise.resolve([]);
    });
    render(<Pane host={host} />);
    const link = await waitFor(() => {
      const found = host.querySelector<HTMLElement>('[data-path-link="blender/kb_top.stl"]');
      expect(found).not.toBeNull();
      return found!;
    });
    // No viewer tab to open: Ctrl+click shows it in the Files tab as well.
    fireEvent.click(link, { ctrlKey: true });
    expect(openFile).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /^Files/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("file-viewer")).toBeNull();
    expect(screen.getByText("No in-app viewer shows this file.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Open in a tab/ })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show in folder" })));
    expect(invoke).toHaveBeenCalledWith("open_in_file_manager", { path: "/project/blender" });
  });

  it("lists the conversation's workflow runs as Workspaces, apart from its subagents", async () => {
    entries.push(
      { kind: "agent", text: "Review parser", role: "reviewer", subagent: "child", at: "2026-10-25T09:01:00Z" },
      { kind: "agent", text: "Audit the repo", role: "workflow", subagent: "run", workflow: true, at: "2026-10-25T09:02:00Z" },
    );
    render(<Pane host={host} />);
    expect(await screen.findByRole("button", { name: /^Subagents \(1\)/ })).toBeTruthy();
    const workspaces = screen.getByRole("button", { name: /^Workspaces \(1\)/ });
    expect(workspaces.closest(".reader-topbar-navigation")).not.toBeNull();
    fireEvent.click(workspaces);
    const list = screen.getByRole("navigation", { name: "Claude workflow runs in this conversation" });
    expect(within(list).queryByRole("button", { name: /Review parser/ })).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: /Audit the repo/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_tab_transcript", expect.objectContaining({ subagent: "run" })));
  });

  it("keeps subagent navigation above the views and returns from Diffs to its chat", async () => {
    entries.push({ kind: "agent", text: "Review parser", role: "reviewer", subagent: "child", at: "2026-10-25T09:01:00Z" });
    render(<Pane host={host} />);
    const menu = await screen.findByRole("button", { name: /^Subagents \(1\)/ });
    expect(menu.closest(".reader-topbar-navigation")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Diffs" }));
    fireEvent.click(menu);
    const navigation = screen.getByRole("navigation", { name: "Subagents in this conversation" });
    fireEvent.click(within(navigation).getByRole("button", { name: /Review parser/ }));
    await waitFor(() => expect(host.querySelector(".terminal-changes")).toBeNull());
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
  });
});

it("pairs unequal replacement runs without dropping lines or their original numbers", () => {
  const rows = splitDiffRows([
    { type: "context", text: "keep", oldNo: 1, newNo: 1 },
    { type: "del", text: "old", oldNo: 2, newNo: null },
    { type: "add", text: "new", oldNo: null, newNo: 2 },
    { type: "add", text: "extra", oldNo: null, newNo: 3 },
    { type: "nonewline", text: "No newline", oldNo: null, newNo: null },
  ]);
  expect(rows.map((row) => [row.before?.text, row.after?.text, row.note])).toEqual([
    ["keep", "keep", undefined], ["old", "new", undefined], [undefined, "extra", undefined], [undefined, undefined, "No newline"],
  ]);
  expect(rows[1].before?.oldNo).toBe(2);
  expect(rows[2].after?.newNo).toBe(3);
});
