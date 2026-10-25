import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const invoke = vi.fn();
const send = vi.fn();
const openFile = vi.fn();
const move = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
vi.mock("../../lib/shortcuts/steeringAgent", () => ({ sendSteeringPrompt: (...args: unknown[]) => send(...args), clearAgentTab: vi.fn(() => Promise.resolve(true)) }));
vi.mock("../../components/files/openFileEntry", () => ({ openFileEntry: (...args: unknown[]) => openFile(...args) }));
vi.mock("../../stores/agents/agentWorktreeSwitch", async (original) => ({
  ...await original<typeof import("../../stores/agents/agentWorktreeSwitch")>(),
  moveAgentToWorktree: (...args: unknown[]) => move(...args),
}));

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
import { NAMES } from "../../lib/brand";
import type { ProjectEntry } from "../../types";
import type { TranscriptEntry } from "../../../mobile-web/src/api";

const tab: TabEntry = { key: "a", label: "Claude", cmd: "claude", cwd: "/project", kind: "agent", sessionId: "launch", scheduleTargetId: "target" };

function Pane({ host }: { host: HTMLElement }) {
  const [navigationSlot, setNavigationSlot] = useState<HTMLSpanElement | null>(null);
  const [actionSlot, setActionSlot] = useState<HTMLSpanElement | null>(null);
  const open = useAgentReaderStore((state) => state.byAgent.claude ?? true);
  const changes = useAgentReaderStore((state) => state.changesByAgent.claude ?? false);
  return <>
    <TerminalPromptStrip ptyId="p:a" scope="p" tabKey="a" background="#000" foreground="#fff"
      onReturnFocus={() => {}} topBar chatShown={open}
      navigationSlot={setNavigationSlot} actionSlot={setActionSlot}
      reader={{ open, onToggle: () => useAgentReaderStore.getState().set("claude", !open), cwd: tab.cwd,
        changes: { open: changes, onToggle: () => useAgentReaderStore.getState().setChanges("claude", !changes) } }} />
    <TerminalReaderView host={host} ptyId="p:a" scope="p" tabKey="a" cwd={tab.cwd}
      visible={open} focused={open && !changes} shown={open} navigationSlot={navigationSlot} actionSlot={actionSlot} />
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
    move.mockResolvedValue("carried");
    useTabsStore.setState({ scope: "p", tabsByScope: { p: [tab] } });
    useAgentPromptsStore.setState({ historyByProject: { p: [] } });
    useAgentReaderStore.setState({ byAgent: { claude: true }, changesByAgent: {} });
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

  it("keeps the draft and Commit available across Chat, Diffs and Terminal", async () => {
    render(<Pane host={host} />);
    await screen.findByText("hello");
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "Diffs" }));
    await screen.findByText("No file changes in this conversation yet.");
    expect(screen.queryByRole("textbox")).toBeNull();
    const commit = screen.getByRole("button", { name: /^Commit/ });
    expect(commit.closest(".reader-topbar-actions")).not.toBeNull();
    fireEvent.click(commit);
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /Split into commits/ })));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ key: "a" }), COMMIT_PROMPTS.split);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /^Commit/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Chat" })));
    expect(screen.getByRole("textbox")).toBe(box);
    expect(box.value).toBe("keep this draft");
    expect(host.querySelector(".terminal-changes")).toBeNull();
  });

  it("omits resource menus when this conversation has none", async () => {
    render(<Pane host={host} />);
    await screen.findByText("hello");
    expect(screen.queryByRole("button", { name: /Subagents|Workspaces|Files \(/ })).toBeNull();
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

  it("opens the conversation's existing files from the top bar", async () => {
    entries.push({ kind: "answer", text: "Updated src/result.ts", at: "2026-10-25T09:01:00Z" });
    render(<Pane host={host} />);
    fireEvent.click(await screen.findByRole("button", { name: "Files (1)" }));
    fireEvent.click(screen.getByRole("option", { name: "src/result.ts" }));
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ entry: expect.objectContaining({ path: "/project/src/result.ts" }) }));
  });

  it("offers linked workspaces through the existing worktree move", async () => {
    const choices = [{ path: "/project", is_main: true, branch: "develop" }, { path: `/project/${NAMES.worktreesDir}/feature`, is_main: false, branch: "feature" }];
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, args?: unknown) => command === "git_worktree_list" ? Promise.resolve(choices) : original(command, args));
    render(<Pane host={host} />);
    fireEvent.click(await screen.findByRole("button", { name: "Workspaces (2)" }));
    await act(async () => fireEvent.click(screen.getByRole("option", { name: "feature" })));
    expect(move).toHaveBeenCalledWith("p", expect.objectContaining({ key: "a" }), choices, choices[1], expect.any(Function));
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
