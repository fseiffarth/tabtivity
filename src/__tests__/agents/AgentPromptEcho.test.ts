import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { lastPromptEcho } from "../../lib/agents/prompt/echo";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import type { ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { useActivityStore } from "../../stores/activity";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

function plainBuffer(rows: string[]): ReadableBufferLike {
  return { length: rows.length, getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) };
}

describe("the prompt echoed on an agent pane's screen", () => {
  it("is the last echoed turn, never the draft in the input box nor a dialog row", () => {
    expect(lastPromptEcho(plainBuffer([
      "› add a test",
      "",
      "• Added one.",
      "",
      "› and run",
      "  it twice",
      "",
      "• Running…",
      "",
      "› ",
    ]))).toBe("and run it twice");
    // The draft still being typed sits in the input box at the bottom.
    expect(lastPromptEcho(plainBuffer(["> fix the tests", "", "⏺ Done.", "", "> half typ"]))).toBe("fix the tests");
    // A select dialog opens its rows with the same marker: a question, not a prompt.
    expect(lastPromptEcho(plainBuffer(["> fix the tests", "", "Allow?", "❯ 1. Yes", "  2. No"]))).toBe("fix the tests");
    expect(lastPromptEcho(plainBuffer(["⏺ Hello.", "", "> "]))).toBeUndefined();
  });

  it("never takes Antigravity's model picker, drawn under its input box, for a prompt", () => {
    const picker = [
      ">",
      "Switch Model",
      "",
      "  Search:",
      "",
      "  Gemini 3.8 Flash             (current)",
      "> Gemini 4 Carbon",
      "  Gemini 4 Argon",
      "",
      "Keyboard: ↑/↓ Navigate  esc Go Back",
    ];
    expect(lastPromptEcho(plainBuffer(picker), "Google Antigravity")).toBeUndefined();
    expect(lastPromptEcho(plainBuffer(["> fix the tests", "", "• Done.", "", ...picker]), "Google Antigravity")).toBe("fix the tests");
  });

  it("stands in for a transcript the backend cannot read", async () => {
    const tab: TabEntry = { key: "agent-1", label: "Gemini", cmd: "gemini", cwd: "/p", kind: "agent", sessionId: "session-abc", scheduleTargetId: "target-1" };
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useActivityStore.setState({ busyByTab: {}, lastDoneByTab: {} });
    useAgentModelsStore.setState({ byTab: {}, promptByTab: {} });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async () => null);
    const term = { buffer: { active: plainBuffer(["> write docs", "", "✦ Sure.", "", "> "]) } } as unknown as Terminal;
    registerTerminal("p:agent-1", term);
    try {
      await useAgentModelsStore.getState().refresh("p", tab, true);
      expect(useAgentModelsStore.getState().promptByTab["p:agent-1"]).toBe("write docs");
    } finally {
      unregisterTerminal("p:agent-1", term);
    }
    // The transcript, when there is one, wins over the screen.
    vi.mocked(invoke).mockImplementation(async (command) => (command === "agent_tab_last_prompt" ? "from the transcript" : null));
    registerTerminal("p:agent-1", term);
    try {
      await useAgentModelsStore.getState().refresh("p", tab, true);
      expect(useAgentModelsStore.getState().promptByTab["p:agent-1"]).toBe("from the transcript");
    } finally {
      unregisterTerminal("p:agent-1", term);
    }
  });
});
beforeEach(() => vi.mocked(invoke).mockReset());
