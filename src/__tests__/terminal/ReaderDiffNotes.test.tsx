import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { readerInsideFor } from "../../lib/agents/readerSteering";
import type { SteeringAction } from "../../lib/shortcuts/steeringBindings";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useDiffNotesStore } from "../../stores/agents/diffNotes";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const ID = "p:agent-1";
const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };
// Newest first in the panel: a.rs (10:02, open), b.md (10:01), a.rs (10:00).
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

function press(action: SteeringAction) {
  const target = readerInsideFor(ID);
  if (!target) throw new Error("no inside target");
  act(() => {
    target.key(action, { shiftKey: false, repeat: false } as KeyboardEvent);
  });
}

describe("notes on the Reader's Diffs tab", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    invoke.mockImplementation((command: string) => {
      if (command === "agent_tab_changes") return Promise.resolve(changes);
      if (command === "agent_tab_transcript") return Promise.resolve({ available: true, version: "v1", truncated: false, entries: [] });
      return Promise.resolve([]);
    });
    useTabsStore.setState((state) => ({ ...state, scope: "p", tabs: [tab], activeKey: "agent-1", tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    useDiffNotesStore.setState({ byTab: {} });
    useKeyboardSteeringStore.getState().exit();
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    useKeyboardSteeringStore.getState().exit();
    host.remove();
  });

  async function shown() {
    const view = render(<TerminalReaderView host={host} ptyId={ID} scope="p" tabKey="agent-1" cwd="/p" visible focused changesOpen />);
    await waitFor(() => expect(host.querySelectorAll(".terminal-changes-card").length).toBe(3));
    return view;
  }
  const field = () => host.querySelector<HTMLTextAreaElement>(".terminal-changes-notebox textarea");
  const composer = () => host.querySelector<HTMLTextAreaElement>(".terminal-reader-composer textarea");
  const buttonNamed = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".terminal-changes button")].find((b) => b.textContent === label);
  const write = (text: string) => {
    fireEvent.change(field() as HTMLTextAreaElement, { target: { value: text } });
    fireEvent.click(buttonNamed("Save") as HTMLButtonElement);
  };

  it("takes a note on a split row, counts it, and puts the prompt into the Chat box", async () => {
    await shown();
    fireEvent.click(host.querySelector(".terminal-changes-card .diff-note-add") as HTMLElement);
    expect(host.querySelector(".terminal-changes-split-row.noted")).not.toBeNull();
    expect(buttonNamed("Save")?.disabled).toBe(true);
    write("Why not y?");
    expect(host.querySelector(".terminal-changes-savednote")?.textContent).toBe("Why not y?");
    expect(host.querySelector(".terminal-changes-notechip")?.textContent).toBe("1 note");
    expect(host.querySelector(".terminal-changes-notes")?.textContent).toContain("1 note");
    expect(useDiffNotesStore.getState().byTab[ID]).toHaveLength(1);

    fireEvent.click(buttonNamed("Add to draft") as HTMLButtonElement);
    expect(composer()?.value).toContain("Review notes on your changes:\n\nsrc/a.rs:1\n```diff\n- x\n+ y\n```\n→ Why not y?");
    expect(useDiffNotesStore.getState().byTab[ID]).toBeUndefined();
    expect(host.querySelector(".terminal-changes-notes")).toBeNull();
    // Into the field docked under Diffs, which stays, the field open.
    expect(host.querySelector(".terminal-changes")).not.toBeNull();
    expect(host.querySelector(".terminal-reader")?.classList.contains("dock-open")).toBe(true);
  });

  it("starts a note from the key on a folded card, extends it with Shift in the unified layout, and edits it", async () => {
    await shown();
    press("viewMode");
    press("down");
    press("down");
    press("viewNote");
    await waitFor(() => expect(field()).not.toBeNull());
    expect(document.activeElement).toBe(field());
    const rows = () => [...host.querySelectorAll<HTMLElement>(".terminal-changes-card:nth-of-type(3) .diff-line .diff-note-add")];
    fireEvent.click(rows()[3], { shiftKey: true });
    fireEvent.change(field() as HTMLTextAreaElement, { target: { value: "Rename these." } });
    fireEvent.keyDown(field() as HTMLTextAreaElement, { key: "Enter", ctrlKey: true });
    const [saved] = useDiffNotesStore.getState().byTab[ID];
    expect(saved).toMatchObject({ path: "src/a.rs", side: "new", from: 10, to: 11, text: "Rename these.", quote: ["- old line", "+ new line", "+ more"] });
    expect(host.querySelectorAll(".diff-line.noted")).toHaveLength(3);

    fireEvent.click(host.querySelector<HTMLElement>("[aria-label='Edit']") as HTMLElement);
    expect(field()?.value).toBe("Rename these.");
    fireEvent.keyDown(field() as HTMLTextAreaElement, { key: "Escape" });
    expect(field()).toBeNull();
    expect(useDiffNotesStore.getState().byTab[ID]).toHaveLength(1);

    fireEvent.click(host.querySelector<HTMLElement>("[aria-label='Delete']") as HTMLElement);
    expect(useDiffNotesStore.getState().byTab[ID]).toBeUndefined();
  });

  it("keeps what was typed when Shift+click moves the box to a later row", async () => {
    await shown();
    press("viewMode");
    const rows = () => [...host.querySelectorAll<HTMLElement>(".terminal-changes-card:nth-of-type(3) .diff-line .diff-note-add")];
    press("down");
    press("down");
    press("viewToggle");
    await waitFor(() => expect(rows().length).toBe(4));
    fireEvent.click(rows()[1]);
    fireEvent.change(field() as HTMLTextAreaElement, { target: { value: "Half a thought" } });
    fireEvent.click(rows()[3], { shiftKey: true });
    expect(field()?.value).toBe("Half a thought");
    fireEvent.keyDown(field() as HTMLTextAreaElement, { key: "Enter", ctrlKey: true });
    expect(useDiffNotesStore.getState().byTab[ID]?.[0]).toMatchObject({ text: "Half a thought", lines: [2, 3, 4] });
  });

  it("clears the notes at once when there is one", async () => {
    await shown();
    fireEvent.click(host.querySelector(".terminal-changes-card .diff-note-add") as HTMLElement);
    write("One.");
    await act(async () => {
      fireEvent.click(host.querySelectorAll<HTMLButtonElement>(".terminal-changes-notes button")[1]);
    });
    expect(useDiffNotesStore.getState().byTab[ID]).toBeUndefined();
  });
});
