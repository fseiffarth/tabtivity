import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { noteTypedClear, undoAgentClear, useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { _clearScheduledAgentInputsForTest, registerScheduledAgentInput } from "../../lib/agents/scheduledAgentInput";
import { noteTypedLine, screenAtCursor, type TypedScreen } from "../../lib/agents/typedClear";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useActivityStore } from "../../stores/activity";
import { BRAND } from "../../lib/brand";

const SESSION = "11111111-1111-4111-8111-111111111111";

function agentTab(cmd: string, extra: Partial<TabEntry> = {}): TabEntry {
  return { key: `agent-${cmd}`, kind: "agent", cmd, label: cmd, cwd: "/p1", sessionId: SESSION, scheduleTargetId: `target-${cmd}`, tmuxSession: `${BRAND.slug}-p1-${cmd}`, ...extra } as TabEntry;
}

function seed(tabs: TabEntry[]): void {
  useTabsStore.setState((state) => ({
    tabsByScope: { ...state.tabsByScope, p1: tabs },
  }));
}

describe("Undo clear", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    _clearScheduledAgentInputsForTest();
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    useProjectsStore.setState({ projects: [{ id: "p1", name: "p1", path: "/p1" }] as never });
    seed([]);
  });

  it("offers the undo on a clear and withdraws it on a resume, not on a plain start", () => {
    const store = useAgentClearUndoStore.getState();
    store.noteRoll("p1:agent-1", "clear");
    expect(useAgentClearUndoStore.getState().cleared["p1:agent-1"]).toBe(true);
    store.noteRoll("p1:agent-1", "startup");
    expect(useAgentClearUndoStore.getState().cleared["p1:agent-1"]).toBe(true);
    store.noteRoll("p1:agent-1", "resume");
    expect(useAgentClearUndoStore.getState().cleared["p1:agent-1"]).toBeUndefined();
    store.noteRoll("p1:agent-1", "clear");
    store.dismiss("p1:agent-1");
    expect(useAgentClearUndoStore.getState().cleared).toEqual({});
  });

  it("keeps the Reader's mark past the card, until the conversation is resumed or cleared anew", () => {
    const store = useAgentClearUndoStore.getState();
    const mark = { anchor: { kind: "answer", text: "done" }, seen: 1 } as never;
    store.noteRoll("p1:agent-1", "clear");
    store.setMark("p1:agent-1", mark);
    store.noteRoll("p1:agent-1", "clear");
    expect(useAgentClearUndoStore.getState().marks["p1:agent-1"]).toBe(mark);
    store.dismiss("p1:agent-1");
    expect(useAgentClearUndoStore.getState().marks["p1:agent-1"]).toBe(mark);
    store.noteRoll("p1:agent-1", "clear");
    expect(useAgentClearUndoStore.getState().marks).toEqual({});
    store.setMark("p1:agent-1", mark);
    store.noteRoll("p1:agent-1", "resume");
    expect(useAgentClearUndoStore.getState().marks).toEqual({});
  });

  it("offers a typed clear only on a tab whose conversation can come back", () => {
    seed([agentTab("gemini"), agentTab("aider")]);
    noteTypedClear("p1:agent-gemini");
    noteTypedClear("p1:agent-aider");
    expect(useAgentClearUndoStore.getState().cleared).toEqual({ "p1:agent-gemini": true });
  });

  it("leaves a clear typed mid-turn to the hook: the CLI queues it, the chat is not cleared yet", () => {
    seed([agentTab("claude")]);
    useActivityStore.setState({ busyByTab: { "p1:agent-claude": true } });
    noteTypedClear("p1:agent-claude");
    expect(useAgentClearUndoStore.getState().cleared).toEqual({});
    useActivityStore.setState({ busyByTab: {} });
    noteTypedClear("p1:agent-claude", true);
    expect(useAgentClearUndoStore.getState().cleared).toEqual({});
    noteTypedClear("p1:agent-claude");
    expect(useAgentClearUndoStore.getState().cleared).toEqual({ "p1:agent-claude": true });
  });

  it("types Claude's resume into the running session as a command, not a prompt", async () => {
    const writes: string[] = [];
    invokeMock.mockImplementation((command: string, args: { data?: Uint8Array }) => {
      if (command === "agent_tab_undo_clear") return Promise.resolve({ kind: "type", command: "/resume 22222222-2222-4222-8222-222222222222" });
      if (command === "pty_write") writes.push(new TextDecoder().decode(args.data));
      return Promise.resolve();
    });
    const recordAuthorizedInput = vi.fn();
    const noteInput = vi.fn();
    registerScheduledAgentInput("target-claude", { ptyId: "p1:agent-claude", ready: () => true, bracketedPaste: () => false, agent: "claude", recordAuthorizedInput, noteInput });
    const tab = agentTab("claude");
    useAgentClearUndoStore.getState().noteRoll("p1:agent-claude", "clear");

    await expect(undoAgentClear("p1", tab)).resolves.toBe("undone");
    expect(invokeMock).toHaveBeenCalledWith("agent_tab_undo_clear", { agent: "claude", projectId: "p1", sessionId: SESSION });
    expect(writes.join("")).toContain("/resume 22222222-2222-4222-8222-222222222222");
    expect(noteInput).toHaveBeenCalledTimes(1);
    expect(recordAuthorizedInput).not.toHaveBeenCalled();
    expect(useAgentClearUndoStore.getState().cleared).toEqual({});
  });

  it("relaunches Codex like a restart: its tmux session ends, the pane respawns", async () => {
    const tab = agentTab("codex", { args: [] });
    seed([tab]);
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_tab_undo_clear" ? { kind: "relaunch" } : undefined));
    await expect(undoAgentClear("p1", tab)).resolves.toBe("undone");
    expect(invokeMock).toHaveBeenCalledWith("local_tmux_kill", { session: `${BRAND.slug}-p1-codex` });
    const after = useTabsStore.getState().tabsByScope.p1[0];
    expect(after.relaunchSeq).toBe(1);
    expect(after.args).toEqual([]);
  });

  it("relaunches a continue-last agent on its resume flag", async () => {
    const tab = agentTab("gemini", { args: [] });
    seed([tab]);
    invokeMock.mockResolvedValue(null);
    await expect(undoAgentClear("p1", tab)).resolves.toBe("undone");
    const after = useTabsStore.getState().tabsByScope.p1[0];
    expect(after.args).toEqual(["--resume", "latest"]);
    expect(after.relaunchSeq).toBe(1);
  });

  it("does not relaunch Claude when its hook names no cleared conversation", async () => {
    vi.useFakeTimers();
    const tab = agentTab("claude");
    seed([tab]);
    invokeMock.mockResolvedValue(null);
    const result = undoAgentClear("p1", tab);
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(result).resolves.toBe("nothing_to_undo");
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(useTabsStore.getState().tabsByScope.p1[0].relaunchSeq).toBeUndefined();
    vi.useRealTimers();
  });

  it("leaves a tab running on a remote host alone", async () => {
    useProjectsStore.setState({ projects: [{ id: "p1", name: "p1", path: "/p1", remote: { host: "h", user: "u", path: "/r" } }] as never });
    const tab = agentTab("gemini", { location: "remote" } as Partial<TabEntry>);
    seed([tab]);
    invokeMock.mockResolvedValue(null);
    await expect(undoAgentClear("p1", tab)).resolves.toBe("remote_tab");
    expect(invokeMock).not.toHaveBeenCalledWith("local_tmux_kill", expect.anything());
  });

  it("says so when an agent resumes nothing", async () => {
    const tab = agentTab("aider");
    useAgentClearUndoStore.getState().noteRoll("p1:agent-aider", "clear");
    await expect(undoAgentClear("p1", tab)).resolves.toBe("nothing_to_undo");
    expect(useAgentClearUndoStore.getState().cleared).toEqual({});
  });
});

describe("typed new-conversation commands", () => {
  it("sees a command typed out in full, and nothing else", () => {
    /** Type the keys one chunk each; what the last one (the Enter) answered. */
    const type = (id: string, keys: string[]) => keys.reduce((_, key) => noteTypedLine(id, key), false);
    expect(type("t1", ["/", "c", "l", "e", "a", "r", "\r"])).toBe(true);
    expect(type("t2", [..."/new", "\r"])).toBe(true);
    // Backspace edits the line; a paste is typing done at once.
    expect(type("t3", [..."/clearx", "\x7f", "\r"])).toBe(true);
    expect(noteTypedLine("t4", "\x1b[200~/clear\x1b[201~")).toBe(false);
    expect(noteTypedLine("t4", "\r")).toBe(true);
    // A prompt that mentions it, completion, or history recall is not one.
    expect(type("t5", [..."please /clear", "\r"])).toBe(false);
    expect(type("t6", [..."/cl", "\t", "\r"])).toBe(false);
    expect(type("t7", ["\x1b[A", "\r"])).toBe(false);
    // …and the next line after an unknown one is read afresh.
    expect(type("t7", [..."/clear", "\r"])).toBe(true);
  });

  it("reads a command finished in the CLI's slash popup off the screen", () => {
    /** Type the keys; the last (the Enter) sees `screen`. */
    const type = (id: string, keys: string[], screen: TypedScreen) =>
      keys.reduce((_, key) => noteTypedLine(id, key, () => screen), false);
    const codexPopup = (input: string, first: string): TypedScreen => ({
      input: `› ${input}`,
      below: ["", `  ${first}     start a new chat`, "  /collab    collaborate"],
    });
    // Tab completed it, or ↑ recalled it: the composer row says what runs.
    expect(type("p1", [..."/cl", "\t", "\r"], { input: "› /clear ", below: [] })).toBe(true);
    expect(type("p2", ["\x1b[A", "\r"], { input: "│ > /clear   │", below: [] })).toBe(true);
    // A prefix typed out and run as is runs the popup's first entry.
    expect(type("p3", [..."/cl", "\r"], codexPopup("/cl", "/clear"))).toBe(true);
    expect(type("p4", [..."/co", "\r"], codexPopup("/co", "/compact"))).toBe(false);
    // An arrow may have moved the selection: only a whole command counts.
    expect(type("p5", [..."/cl", "\x1b[B", "\r"], codexPopup("/cl", "/clear"))).toBe(false);
    // A completion to something else, a prompt, or no composer at all.
    expect(type("p6", [..."/mo", "\t", "\r"], { input: "› /model ", below: [] })).toBe(false);
    expect(type("p7", [..."fix it", "\r"], codexPopup("fix it", "/clear"))).toBe(false);
    expect(type("p8", [..."/cl", "\t", "\r"], { input: "/clear", below: [] })).toBe(false);
  });

  it("takes the cursor's row and the ones under it", () => {
    const rows = ["old", "› /cl", "  /clear  new chat", "footer"];
    const buffer = {
      baseY: 1,
      cursorY: 0,
      length: rows.length,
      getLine: (y: number) => (rows[y] === undefined ? undefined : { translateToString: () => rows[y] }),
    };
    expect(screenAtCursor(buffer)).toEqual({ input: "› /cl", below: ["  /clear  new chat", "footer"] });
  });
});
