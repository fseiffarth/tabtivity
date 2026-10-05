import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const openFileEntry = vi.fn();
vi.mock("../../components/files/openFileEntry", () => ({ openFileEntry: (...args: unknown[]) => openFileEntry(...args) }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { TerminalPromptStrip } from "../../components/terminal/TerminalPromptStrip";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { rememberedChanges } from "../../lib/agents/agentReader";

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };
const changes = {
  available: true,
  version: "c1",
  truncated: false,
  changes: [
    { path: "/p/src/a.rs", kind: "edit", diff: "@@ -9,2 +9,3 @@\n keep\n-old line\n+new line\n+more\n", added: 2, removed: 1, at: "2026-10-02T10:00:00Z" },
    { path: "/p/docs/b.md", kind: "add", diff: "@@ -0,0 +1,1 @@\n+# B\n", added: 1, removed: 0, at: "2026-10-02T10:01:00Z" },
    { path: "/p/src/a.rs", kind: "edit", diff: "@@ -1,1 +1,1 @@\n-x\n+y\n", added: 1, removed: 1, at: "2026-10-02T10:02:00Z" },
  ],
};

function reader(host: HTMLElement) {
  return render(
    <TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />,
  );
}

describe("the Reader's Changes panel", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    openFileEntry.mockReset();
    invoke.mockImplementation((command: string) => {
      if (command === "agent_tab_changes") return Promise.resolve(changes);
      if (command === "agent_tab_transcript") return Promise.resolve({ available: true, version: "v1", truncated: false, entries: [] });
      return Promise.resolve([]);
    });
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {}, changesByAgent: {} });
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it("stays closed and reads nothing until it is switched on", async () => {
    reader(host);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_tab_transcript", expect.anything()));
    expect(host.querySelector(".terminal-changes")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("agent_tab_changes", expect.anything());
  });

  it("lists the conversation's changes beside the chat, newest first, with their diffs", async () => {
    useAgentReaderStore.getState().setChanges("claude", true);
    reader(host);
    const panel = await waitFor(() => {
      const found = host.querySelector<HTMLElement>(".terminal-changes");
      expect(found?.querySelectorAll(".terminal-changes-card").length).toBe(3);
      return found!;
    });
    expect(invoke).toHaveBeenCalledWith("agent_tab_changes", expect.objectContaining({
      agent: "claude", projectId: "p", sessionId: "launch-1", tabDir: "/p", subagent: null, limit: null,
    }));
    // The chat gives way: its right edge moves in by the panel's width.
    const chat = host.querySelector<HTMLElement>(".terminal-reader");
    expect(chat?.classList.contains("with-changes")).toBe(true);
    expect(chat?.style.getPropertyValue("--reader-changes-w")).toBe("520px");
    const cards = [...panel.querySelectorAll<HTMLElement>(".terminal-changes-card")];
    // Newest first, paths shown relative to the tab's folder.
    expect(cards.map((card) => card.querySelector(".terminal-changes-path")?.textContent)).toEqual(["src/a.rs", "docs/b.md", "src/a.rs"]);
    expect(cards[1].querySelector(".terminal-changes-kind")?.textContent).toBe("Created");
    // Every diff starts folded; what the panel found on opening is not new.
    expect(panel.querySelectorAll(".terminal-changes-diff").length).toBe(0);
    expect(panel.querySelectorAll(".terminal-changes-new").length).toBe(0);
    fireEvent.click(within(cards[2]).getByRole("button", { expanded: false }));
    // The diff, with the old/new line numbers its hunk names.
    const rows = [...cards[2].querySelectorAll<HTMLElement>(".diff-line")];
    expect(rows.map((row) => row.querySelector(".diff-text")?.textContent)).toEqual(["@@ -9,2 +9,3 @@", " keep", "-old line", "+new line", "+more"]);
    expect(rows[3].querySelectorAll(".diff-gutter")[1].textContent).toBe("10");
    expect(panel.textContent).toContain("2 files · 3 changes");
  });

  it("narrows to one file, folds a diff, and opens the file", async () => {
    useAgentReaderStore.getState().setChanges("claude", true);
    reader(host);
    const files = await screen.findByRole("listbox", { name: "Changed files" });
    fireEvent.click(within(files).getByTitle("/p/docs/b.md"));
    const panel = host.querySelector<HTMLElement>(".terminal-changes")!;
    expect(panel.querySelectorAll(".terminal-changes-card").length).toBe(1);
    const card = panel.querySelector<HTMLElement>(".terminal-changes-card")!;
    fireEvent.click(within(card).getByRole("button", { expanded: false }));
    expect(card.querySelector(".terminal-changes-diff")).not.toBeNull();
    fireEvent.click(within(card).getByRole("button", { expanded: true }));
    expect(card.querySelector(".terminal-changes-diff")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Open the file" }));
    expect(openFileEntry).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ path: "/p/docs/b.md", name: "b.md", extension: ".md" }),
      projectDir: "/p",
      scope: "p",
    }));
    fireEvent.click(within(files).getByText("All files"));
    expect(panel.querySelectorAll(".terminal-changes-card").length).toBe(3);
  });

  it("marks a change that arrives while it is shown as new, folded, until it is unfolded", async () => {
    let current = changes;
    invoke.mockImplementation((command: string) => {
      if (command === "agent_tab_changes") return Promise.resolve(current);
      if (command === "agent_tab_transcript") return Promise.resolve({ available: true, version: "v1", truncated: false, entries: [] });
      return Promise.resolve([]);
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      useAgentReaderStore.getState().setChanges("claude", true);
      reader(host);
      await waitFor(() => expect(host.querySelectorAll(".terminal-changes-card").length).toBe(3));
      current = {
        ...changes,
        version: "c2",
        changes: [...changes.changes, { path: "/p/src/c.ts", kind: "edit", diff: "@@ -1,1 +1,1 @@\n-a\n+b\n", added: 1, removed: 1, at: "2026-10-02T10:03:00Z" }],
      };
      await vi.advanceTimersByTimeAsync(2100);
      const newest = await waitFor(() => {
        const cards = host.querySelectorAll<HTMLElement>(".terminal-changes-card");
        expect(cards.length).toBe(4);
        return cards[0];
      });
      expect(newest.classList.contains("fresh")).toBe(true);
      expect(newest.querySelector(".terminal-changes-new")?.textContent).toBe("New");
      expect(newest.querySelector(".terminal-changes-diff")).toBeNull();
      expect(host.querySelectorAll(".terminal-changes-card.fresh").length).toBe(1);
      fireEvent.click(within(newest).getByRole("button", { expanded: false }));
      expect(newest.classList.contains("fresh")).toBe(false);
      expect(newest.querySelector(".terminal-changes-diff")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so when the conversation changed nothing yet, and closes from its own button", async () => {
    invoke.mockImplementation((command: string) => Promise.resolve(command === "agent_tab_changes"
      ? { available: true, version: "c0", truncated: false, changes: [] }
      : { available: true, version: "v1", truncated: false, entries: [] }));
    useAgentReaderStore.getState().setChanges("claude", true);
    reader(host);
    await screen.findByText("No file changes in this conversation yet.");
    fireEvent.click(screen.getByRole("button", { name: "Hide the diffs" }));
    await waitFor(() => expect(host.querySelector(".terminal-changes")).toBeNull());
    expect(rememberedChanges()).toEqual({ claude: false });
  });

  it("is switched from the prompt strip, chat shown or not, remembered per agent CLI", () => {
    const onToggle = vi.fn();
    const strip = (readerOpen: boolean) => (
      <TerminalPromptStrip
        ptyId="p:agent-1"
        scope="p"
        tabKey="agent-1"
        background="#000"
        foreground="#fff"
        onReturnFocus={() => {}}
        reader={{ open: readerOpen, onToggle: () => {}, changes: { open: false, onToggle } }}
      />
    );
    const { rerender } = render(strip(false));
    fireEvent.click(screen.getByRole("button", { name: /Diffs/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(strip(true));
    fireEvent.click(screen.getByRole("button", { name: /Diffs/ }));
    expect(onToggle).toHaveBeenCalledTimes(2);
    useAgentReaderStore.getState().setChanges("codex", true);
    expect(rememberedChanges()).toEqual({ codex: true });
  });
});
