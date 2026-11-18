import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const openFileEntry = vi.fn();
vi.mock("../../lib/files/openFileEntry", () => ({ openFileEntry: (...args: unknown[]) => openFileEntry(...args) }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { readerInsideFor } from "../../lib/agents/readerSteering";
import type { SteeringAction } from "../../lib/shortcuts/steeringBindings";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const ID = "p:agent-1";
const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };
// Oldest first, as the store sends them: the panel shows them newest first,
// so the cards read a.rs (10:02), b.md (10:01), a.rs (10:00).
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

function reader(host: HTMLElement, visible = true) {
  return render(
    <TerminalReaderView host={host} ptyId={ID} scope="p" tabKey="agent-1" cwd="/p" visible={visible} focused changesOpen />,
  );
}

function press(action: SteeringAction, init: { shiftKey?: boolean; repeat?: boolean } = {}) {
  const target = readerInsideFor(ID);
  if (!target) throw new Error("no inside target");
  let result: string | undefined;
  act(() => {
    result = target.key(action, { shiftKey: false, repeat: false, ...init } as KeyboardEvent);
  });
  return result;
}

const heads = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".terminal-changes-card-head")];
const cursorAt = (host: HTMLElement) => heads(host).findIndex((head) => head.classList.contains("steer-cursor"));

function steerInside() {
  act(() => {
    useKeyboardSteeringStore.getState().enter();
    useKeyboardSteeringStore.getState().setLevel("scroll");
  });
}

describe("steering inside the Reader's Diffs view", () => {
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
    useTabsStore.setState((state) => ({ ...state, scope: "p", tabs: [tab], activeKey: "agent-1", tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    useKeyboardSteeringStore.getState().exit();
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    useKeyboardSteeringStore.getState().exit();
    host.remove();
  });

  async function shown() {
    const view = reader(host);
    await waitFor(() => expect(host.querySelectorAll(".terminal-changes-card").length).toBe(3));
    return view;
  }

  it("draws no cursor until steering is Inside, then starts on the newest card", async () => {
    await shown();
    expect(cursorAt(host)).toBe(-1);
    steerInside();
    expect(cursorAt(host)).toBe(0);
    act(() => useKeyboardSteeringStore.getState().setLevel("tabs"));
    expect(cursorAt(host)).toBe(-1);
  });

  it("registers only while the panel is visible", async () => {
    const view = reader(host, false);
    await act(async () => {});
    expect(readerInsideFor(ID)).toBeNull();
    view.rerender(<TerminalReaderView host={host} ptyId={ID} scope="p" tabKey="agent-1" cwd="/p" visible focused changesOpen />);
    await waitFor(() => expect(readerInsideFor(ID)?.view).toBe("changes"));
    view.unmount();
    expect(readerInsideFor(ID)).toBeNull();
  });

  it("moves the cursor with down and up, and up on the first card leaves", async () => {
    await shown();
    steerInside();
    expect(press("down")).toBe("handled");
    expect(cursorAt(host)).toBe(1);
    expect(press("down")).toBe("handled");
    expect(press("down")).toBe("handled");
    expect(cursorAt(host)).toBe(2);
    press("up");
    press("up");
    expect(cursorAt(host)).toBe(0);
    expect(press("up")).toBe("leave");
    // A held key does not run out of the view.
    expect(press("up", { repeat: true })).toBe("handled");
    expect(cursorAt(host)).toBe(0);
  });

  it("passes left, right, Enter and Space on, and swallows what it does not use", async () => {
    await shown();
    steerInside();
    for (const action of ["left", "right", "work", "agentPrompt"] as const) expect(press(action)).toBe("pass");
    expect(press("newShell")).toBe("handled");
  });

  it("folds and unfolds the card under the cursor", async () => {
    await shown();
    steerInside();
    const section = () => host.querySelectorAll<HTMLElement>(".terminal-changes-card")[1];
    press("down");
    expect(section().querySelector(".terminal-changes-fold")?.getAttribute("aria-expanded")).toBe("false");
    press("viewToggle");
    expect(section().querySelector(".terminal-changes-fold")?.getAttribute("aria-expanded")).toBe("true");
    expect(section().querySelector(".terminal-changes-diff")).not.toBeNull();
    press("viewToggle", { repeat: true });
    expect(section().querySelector(".terminal-changes-fold")?.getAttribute("aria-expanded")).toBe("true");
    press("viewToggle");
    expect(section().querySelector(".terminal-changes-diff")).toBeNull();
  });

  it("flips split and unified", async () => {
    await shown();
    steerInside();
    expect(host.querySelectorAll(".terminal-changes-split-row").length).toBeGreaterThan(0);
    press("viewMode");
    expect(host.querySelectorAll(".terminal-changes-split-row").length).toBe(0);
    expect(host.querySelectorAll(".diff-line").length).toBeGreaterThan(0);
    press("viewMode");
    expect(host.querySelectorAll(".terminal-changes-split-row").length).toBeGreaterThan(0);
  });

  it("opens the card's file in a tab, Shift in a new subwindow, and the diff viewer; not on repeat", async () => {
    await shown();
    steerInside();
    press("down");
    press("viewOpen");
    expect(openFileEntry).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ path: "/p/docs/b.md" }),
      scope: "p",
      newSubwindow: false,
    }));
    press("viewOpen", { shiftKey: true });
    expect(openFileEntry).toHaveBeenLastCalledWith(expect.objectContaining({ newSubwindow: true }));
    press("viewOpen", { repeat: true });
    expect(openFileEntry).toHaveBeenCalledTimes(2);
    press("viewOpenAlt");
    const opened = useTabsStore.getState().tabsByScope.p.find((t) => t.kind === "embed");
    expect(opened).toMatchObject({ viewer: "diff", embedPath: "/p/docs/b.md" });
  });

  it("steps the file list with Shift, wrapping back to All files", async () => {
    await shown();
    steerInside();
    const files = () => host.querySelectorAll<HTMLElement>(".terminal-changes-files [role='option']");
    const selected = () => [...files()].findIndex((option) => option.getAttribute("aria-selected") === "true");
    expect(selected()).toBe(0);
    press("down", { shiftKey: true });
    expect(selected()).toBe(1);
    expect(host.querySelectorAll(".terminal-changes-card").length).toBe(2);
    expect(cursorAt(host)).toBe(0);
    press("down", { shiftKey: true });
    expect(selected()).toBe(2);
    expect(host.querySelectorAll(".terminal-changes-card").length).toBe(1);
    press("down", { shiftKey: true });
    expect(selected()).toBe(0);
    expect(host.querySelectorAll(".terminal-changes-card").length).toBe(3);
    press("up", { shiftKey: true });
    expect(selected()).toBe(2);
    // Shift never steps out, even on the first card.
    expect(press("up", { shiftKey: true })).toBe("handled");
  });

  it("ignores open on a deleted or moved card", async () => {
    invoke.mockImplementation((command: string) => Promise.resolve(command === "agent_tab_changes"
      ? {
        ...changes,
        changes: [
          { path: "/p/gone.rs", kind: "delete", diff: "", added: 0, removed: 3, at: "2026-10-02T10:03:00Z" },
        ],
      }
      : { available: true, version: "v1", truncated: false, entries: [] }));
    reader(host);
    await waitFor(() => expect(host.querySelectorAll(".terminal-changes-card").length).toBe(1));
    steerInside();
    expect(press("viewOpen")).toBe("handled");
    expect(press("viewOpenAlt")).toBe("handled");
    expect(openFileEntry).not.toHaveBeenCalled();
    expect(useTabsStore.getState().tabsByScope.p.some((t) => t.kind === "embed")).toBe(false);
  });

  it("jumps to the next New card, wrapping", async () => {
    let current = changes;
    invoke.mockImplementation((command: string) => {
      if (command === "agent_tab_changes") return Promise.resolve(current);
      if (command === "agent_tab_transcript") return Promise.resolve({ available: true, version: "v1", truncated: false, entries: [] });
      return Promise.resolve([]);
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      reader(host);
      await waitFor(() => expect(host.querySelectorAll(".terminal-changes-card").length).toBe(3));
      steerInside();
      expect(press("viewNew")).toBe("handled");
      expect(cursorAt(host)).toBe(0);
      current = {
        ...changes,
        version: "c2",
        changes: [...changes.changes, { path: "/p/src/c.ts", kind: "edit", diff: "@@ -1,1 +1,1 @@\n-a\n+b\n", added: 1, removed: 1, at: "2026-10-02T10:03:00Z" }],
      };
      await vi.advanceTimersByTimeAsync(2100);
      await waitFor(() => expect(host.querySelectorAll(".terminal-changes-card").length).toBe(4));
      // The new card is the newest, first in the list; the cursor sits on it already
      // (it snapped nowhere), move down then jump back to it with N.
      press("down");
      press("down");
      expect(cursorAt(host)).toBe(2);
      press("viewNew");
      expect(cursorAt(host)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves at once when there is nothing to walk", async () => {
    invoke.mockImplementation((command: string) => Promise.resolve(command === "agent_tab_changes"
      ? { available: true, version: "c0", truncated: false, changes: [] }
      : { available: true, version: "v1", truncated: false, entries: [] }));
    reader(host);
    await waitFor(() => expect(readerInsideFor(ID)).not.toBeNull());
    await waitFor(() => expect(host.textContent).toContain("No file changes"));
    steerInside();
    expect(press("up")).toBe("leave");
    expect(press("down")).toBe("handled");
  });
});
