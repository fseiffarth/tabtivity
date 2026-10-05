import { describe, expect, it } from "vitest";
import {
  inputBoxShown,
  readAgentList,
  readTasksDialog,
  rowMatches,
  sendToSubagent,
  viewLabel,
  type SubagentDriver,
} from "../../../mobile-web/src/terminal/subagentInput";

const FAST = { waitMs: 30, pollMs: 2 };
const RULE = "────────────────────────────────────────";

// Claude Code 2.1.287's footer, as captured with the list's cursor on Alpha.
const CAPTURED = [
  RULE,
  "❯ ",
  RULE,
  "  user@host:~/project",
  "  Enter to view · x to stop · ctrl+x ctrl+k to stop all agents",
  "  ● main",
  "❯ ◯ general-purpose  Alpha sleeper                                 6s · ↓ 24.1k tokens",
  "  ◯ general-purpose  Beta sleeper                                  7s · ↓ 24.1k tokens",
  "",
];

// Its `/tasks` dialog, as captured.
const TASKS = [
  "❯ /tasks",
  RULE,
  "  Background",
  "  1 active agent",
  "    Local agents (1)",
  "  ❯ ● Epsilon writer   running · Haiku 4.5",
  "    Completed (1)",
  "    ✔ Delta waiter     done · Haiku 4.5",
  "  ↑/↓ to select · Enter to view · f to foreground · x to stop · Esc to close",
];

type Agent = { kind: string; task: string; listed?: boolean; summary?: string };

/**
 * Claude Code's input box, footer and `/tasks`, as probed: ↓ crosses `pills`
 * before the agent list, ↑ on its first row leaves it, Enter views the row
 * under the cursor and keeps the keyboard in the list, Esc there hands it
 * back, `x` there stops the agent under the cursor, and typed text in the box
 * goes to the conversation viewed. Agents not `listed` are only in `/tasks`,
 * whose Enter views one and lists it again.
 */
function fakeClaude(agents: Agent[], pills = 1) {
  const state = {
    focus: "box" as "box" | "pill" | "list" | "tasks",
    pill: 0,
    cursor: 0,
    viewed: "main",
    sent: [] as { to: string; text: string }[],
    commands: [] as string[],
    stopped: [] as string[],
    escInBox: 0,
  };
  const listed = () => ["main", ...agents.filter((agent) => agent.listed !== false || agent.task === state.viewed).map((agent) => agent.task)];
  const kindOf = (task: string) => agents.find((agent) => agent.task === task)?.kind ?? "";
  const rows = () => {
    if (state.focus === "tasks") {
      return [
        "❯ /tasks",
        RULE,
        "  Background",
        ...agents.map((agent, index) => `  ${state.cursor === index ? "❯" : " "} ✔ ${agent.task}     done · Haiku 4.5`),
        "  ↑/↓ to select · Enter to view · x to stop · Esc to close",
      ];
    }
    const names = listed();
    return [
      state.viewed === "main" ? RULE : `────────────────────── ${state.viewed} ─`,
      "❯ ",
      RULE,
      "  status",
      ...(names.length < 2 ? [] : names.map((name, index) => {
        const mark = state.focus === "list" && state.cursor === index ? "❯" : " ";
        const dot = state.viewed === name ? "●" : "◯";
        const shown = agents.find((agent) => agent.task === name)?.summary ?? name;
        return index === 0 ? `${mark} ${dot} main` : `${mark} ${dot} ${kindOf(name)}  ${shown}     3s · ↓ 1k tokens`;
      })),
    ];
  };
  const key = async (k: string) => {
    const names = listed();
    if (state.focus === "tasks") {
      if (k === "\u001b[B") state.cursor = Math.min(agents.length - 1, state.cursor + 1);
      else if (k === "\u001b[A") state.cursor = Math.max(0, state.cursor - 1);
      else if (k === "\r") { state.viewed = agents[state.cursor].task; state.focus = "box"; }
      else if (k === "\u001b") state.focus = "box";
      else if (k === "x") state.stopped.push(agents[state.cursor].task);
      return true;
    }
    if (state.focus === "list") {
      if (k === "\u001b[B") state.cursor = Math.min(names.length - 1, state.cursor + 1);
      else if (k === "\u001b[A") {
        if (state.cursor === 0) state.focus = pills > 0 ? "pill" : "box";
        else state.cursor -= 1;
      } else if (k === "\r") state.viewed = names[state.cursor];
      else if (k === "\u001b") state.focus = "box";
      else if (k === "x" && state.cursor > 0) state.stopped.push(names[state.cursor]);
      return true;
    }
    if (state.focus === "pill") {
      if (k === "\u001b[B") {
        if (state.pill + 1 < pills) state.pill += 1;
        else { state.focus = "list"; state.cursor = 0; }
      } else if (k === "\u001b[A") {
        if (state.pill === 0) state.focus = "box";
        else state.pill -= 1;
      }
      return true;
    }
    if (k === "\u001b[B" && names.length > 1) {
      if (pills > 0) { state.focus = "pill"; state.pill = 0; } else { state.focus = "list"; state.cursor = 0; }
    } else if (k === "\u001b") state.escInBox += 1;
    return true;
  };
  const typeText = (text: string) => async () => {
    if (state.focus === "list") {
      // What the footer would do with the message's keys.
      for (const ch of text) await key(ch);
      return true;
    }
    state.sent.push({ to: state.viewed, text });
    return true;
  };
  const command = async (text: string) => {
    if (state.focus !== "box") return false;
    state.commands.push(text);
    if (text === "/tasks") { state.focus = "tasks"; state.cursor = 0; }
    return true;
  };
  const driver = (text: string): SubagentDriver => ({ rows, key, command, type: typeText(text) });
  return { state, driver };
}

describe("readAgentList", () => {
  it("reads Claude Code's agent list under the input box", () => {
    expect(readAgentList(CAPTURED)).toEqual([
      { cursor: false, viewed: true, main: true, kind: "", task: "" },
      { cursor: true, viewed: false, main: false, kind: "general-purpose", task: "Alpha sleeper" },
      { cursor: false, viewed: false, main: false, kind: "general-purpose", task: "Beta sleeper" },
    ]);
  });

  it("is null when the bottom of the screen is a dialog, not the list", () => {
    expect(readAgentList([" Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel · Tab to amend"])).toBeNull();
    expect(readAgentList(["❯ ", "  ⏸ manual mode on"])).toBeNull();
    expect(readAgentList(TASKS)).toBeNull();
  });
});

describe("readTasksDialog", () => {
  it("reads the subagent rows of /tasks, its section titles aside", () => {
    expect(readTasksDialog(TASKS)).toEqual([
      { cursor: true, task: "Epsilon writer" },
      { cursor: false, task: "Delta waiter" },
    ]);
  });

  it("is null when the bottom of the screen is anything else", () => {
    expect(readTasksDialog(CAPTURED)).toBeNull();
  });
});

describe("viewLabel", () => {
  it("reads the subagent viewed off the rule over the box", () => {
    expect(viewLabel([`──────── Theta long ─`, "❯ Message @general-purpose…", RULE, "  status"])).toBe("Theta long");
    expect(viewLabel(CAPTURED)).toBe("");
    expect(viewLabel(TASKS)).toBeNull();
  });
});

describe("inputBoxShown", () => {
  it("finds the box between its rules, and not a dialog's ❯ row", () => {
    expect(inputBoxShown(CAPTURED)).toBe(true);
    expect(inputBoxShown([" Do you want to proceed?", " ❯ 1. Yes", "   2. No"])).toBe(false);
    expect(inputBoxShown(TASKS)).toBe(false);
  });
});

describe("rowMatches", () => {
  const row = { cursor: false, viewed: false, main: false, kind: "Explore", task: "Map the backend" };
  it("matches the description and type, whitespace aside", () => {
    expect(rowMatches(row, { task: "Map the\nbackend", role: "Explore" })).toBe(true);
    expect(rowMatches(row, { task: "Map the backend", role: "general-purpose" })).toBe(false);
    expect(rowMatches(row, { task: "Map the frontend" })).toBe(false);
  });
  it("matches a row cut short by a narrow screen on what it still shows", () => {
    expect(rowMatches({ ...row, kind: "Expl…", task: "Map the b…" }, { task: "Map the backend", role: "Explore" })).toBe(true);
    expect(rowMatches({ ...row, task: "Map the f…" }, { task: "Map the backend" })).toBe(false);
  });
  it("never matches the session's own row", () => {
    expect(rowMatches({ ...row, main: true, kind: "", task: "" }, { task: "" })).toBe(false);
  });
});

describe("sendToSubagent", () => {
  const agents = [
    { kind: "general-purpose", task: "Alpha sleeper" },
    { kind: "general-purpose", task: "Beta sleeper" },
  ];

  it("types the message into the subagent's view, then views the session again", async () => {
    const { state, driver } = fakeClaude(agents, 2);
    const result = await sendToSubagent(driver("x marks the spot"), { task: "Beta sleeper", role: "general-purpose" }, FAST);
    expect(result).toEqual({ ok: true, backToMain: true });
    expect(state.sent).toEqual([{ to: "Beta sleeper", text: "x marks the spot" }]);
    // The footer gave the keyboard back before the message's `x`.
    expect(state.stopped).toEqual([]);
    expect(state.viewed).toBe("main");
    expect(state.focus).toBe("box");
    expect(state.escInBox).toBe(0);
    expect(state.commands).toEqual([]);
  });

  it("goes straight into a list with no pills before it", async () => {
    const { state, driver } = fakeClaude(agents, 0);
    expect(await sendToSubagent(driver("hi"), { task: "Alpha sleeper" }, FAST)).toEqual({ ok: true, backToMain: true });
    expect(state.sent).toEqual([{ to: "Alpha sleeper", text: "hi" }]);
  });

  it("finds a subagent whose row prints a summary by the label over its view", async () => {
    const { state, driver } = fakeClaude([
      { kind: "general-purpose", task: "Alpha sleeper", summary: "Running tests" },
      { kind: "Explore", task: "Map the backend", summary: "Reading files" },
      { kind: "general-purpose", task: "Theta long", summary: "Writing numbers.py script" },
    ]);
    expect(await sendToSubagent(driver("stop"), { task: "Theta long", role: "general-purpose" }, FAST)).toEqual({ ok: true, backToMain: true });
    expect(state.sent).toEqual([{ to: "Theta long", text: "stop" }]);
    expect(state.viewed).toBe("main");
    expect(state.commands).toEqual([]);
    expect(state.stopped).toEqual([]);
  });

  it("opens a finished background subagent from /tasks", async () => {
    const { state, driver } = fakeClaude([agents[0], { kind: "general-purpose", task: "Delta waiter", listed: false }]);
    expect(await sendToSubagent(driver("one more thing"), { task: "Delta waiter", role: "general-purpose" }, FAST)).toEqual({ ok: true, backToMain: true });
    expect(state.commands).toEqual(["/tasks"]);
    expect(state.sent).toEqual([{ to: "Delta waiter", text: "one more thing" }]);
    expect(state.viewed).toBe("main");
    expect(state.stopped).toEqual([]);
    expect(state.escInBox).toBe(0);
  });

  it("closes /tasks and types nothing for a subagent it does not list either", async () => {
    const { state, driver } = fakeClaude(agents);
    expect(await sendToSubagent(driver("hi"), { task: "Gamma counter" }, FAST)).toEqual({ ok: false, reason: "not_listed" });
    expect(state.sent).toEqual([]);
    expect(state.focus).toBe("box");
    expect(state.escInBox).toBe(0);
  });

  it("types nothing when two rows read the same", async () => {
    const { state, driver } = fakeClaude([...agents, agents[0]]);
    expect(await sendToSubagent(driver("hi"), { task: "Alpha sleeper" }, FAST)).toEqual({ ok: false, reason: "ambiguous" });
    expect(state.sent).toEqual([]);
  });

  it("types nothing, not even /tasks, while a dialog holds the bottom of the screen", async () => {
    const keys: string[] = [];
    const driver: SubagentDriver = {
      rows: () => [" Do you want to proceed?", " ❯ 1. Yes", "   2. No"],
      key: async (k) => { keys.push(k); return true; },
      command: async (k) => { keys.push(k); return true; },
      type: async () => { throw new Error("typed"); },
    };
    expect(await sendToSubagent(driver, { task: "Alpha sleeper" }, FAST)).toEqual({ ok: false, reason: "not_opened" });
    expect(keys).toEqual([]);
  });

  it("walks back up out of the pills when the list never takes the cursor", async () => {
    const { state, driver } = fakeClaude(agents, 9);
    expect(await sendToSubagent(driver("hi"), { task: "Alpha sleeper" }, FAST)).toEqual({ ok: false, reason: "not_opened" });
    expect(state.focus).toBe("box");
    expect(state.sent).toEqual([]);
  });

  it("stops without typing when Enter does not view the row", async () => {
    const { state, driver } = fakeClaude(agents);
    const real = driver("hi");
    const stuck: SubagentDriver = { ...real, key: async (k) => (k === "\r" ? true : real.key(k)) };
    expect(await sendToSubagent(stuck, { task: "Beta sleeper" }, FAST)).toEqual({ ok: false, reason: "not_opened" });
    expect(state.sent).toEqual([]);
    expect(state.focus).toBe("box");
    expect(state.escInBox).toBe(0);
  });
});
