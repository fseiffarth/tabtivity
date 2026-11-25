import { describe, expect, it } from "vitest";
import { CURSOR_FRAMES as F } from "../fixtures/cursorFrames";
import { answerKeys, readReaderLive } from "../../lib/agents/readerLive";
import { chatAgent, changesOffered, readerOffered, READER_AGENTS } from "../../lib/agents/agentReader";
import { UNTESTED_CHAT_AGENTS, chatsOffered } from "../../lib/agents/agentChats";
import { looksLikeDecisionPromptStripped } from "../../lib/agents/prompt/prompt";
import { agentInputWrites, agentFamily, bracketsAgentMessage } from "../../../shared/agentComposer";
import { agentWork, stopKey } from "../../../mobile-web/src/terminal/agentBusy";
import { cursorModel, isCursorTab } from "../../../mobile-web/src/terminal/cursorAgent";
import { currentMode, modeChoices, modeFixed, modeOffered, shiftTabKey } from "../../../mobile-web/src/terminal/agentModes";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import { readLiveQuestion } from "../../../mobile-web/src/terminal/liveDialog";
import { inputFrameStart } from "../../../mobile-web/src/terminal/statusLine";
import { MAX_SUGGESTIONS, slashCatalog, slashSuggestions } from "../../../mobile-web/src/slashCommands";
import { newerNotice } from "../../stores/agents/agentVersionNotice";

/**
 * Cursor agent (`cursor-agent` 2026.11.22-e9042b2) as the desktop Reader and
 * the phone read its live screen. The frames are the real ones
 * (`fixtures/cursorFrames.ts`), at the widths the app meets: 120, 60 and 42
 * columns.
 */

const LABEL = "Cursor";
const buffer = (rows: readonly string[]) => ({
  length: rows.length,
  getLine: (row: number) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }),
});
const live = (frame: string, columns = 120, label = LABEL) => readReaderLive(buffer(F[frame]), label, columns);
const rowsOf = (frame: string) => readableScreen(buffer(F[frame]), 300).lines;
const PATH = "/home/devuser/myproj/projects/projectmyproj/tmp/verify-cli/cursor/proj-tui";

describe("Cursor tab label", () => {
  it("is the registry's label and the command", () => {
    expect(isCursorTab("Cursor")).toBe(true);
    expect(isCursorTab("cursor-agent")).toBe(true);
    expect(isCursorTab("Claude")).toBe(false);
    expect(agentFamily("cursor-agent")).toBe("cursor");
  });
});

describe("Cursor's idle frame", () => {
  it("is a ready box with its facts: model, folder and branch, no context before a turn", () => {
    const read = live("idleFresh");
    expect(read.question).toBeNull();
    expect(read.working).toBeNull();
    expect(read.stray).toBe(false);
    expect(read.status).toEqual({ model: "Auto", path: PATH, branch: "master" });
  });

  it("gives the context left, flipped from the figure the footer prints as used", () => {
    expect(live("idleAfter120").status).toEqual({ model: "Auto", context: "94.5%", path: PATH, branch: "master" });
  });

  it("puts the folder back together where the pane wrapped it, at 60 and 42 columns", () => {
    for (const [frame, columns] of [["idleAfter60", 60], ["idleAfter42", 42]] as const) {
      expect(live(frame, columns).status).toEqual({ model: "Auto", context: "94.5%", path: PATH, branch: "master" });
    }
  });

  it("reads the frame whatever the draft holds", () => {
    const read = live("draft60", 60);
    expect(read.status?.model).toBe("Auto");
    expect(read.working).toBeNull();
  });

  it("cuts the frame at the box, and leaves the answer over it with the busy row's ghost", () => {
    const rows = rowsOf("idleAfter120");
    const start = inputFrameStart(rows, LABEL);
    expect(rows.slice(start).find((row) => row.text.trim())?.text).toMatch(/^\s*→ Add a follow-up/u);
    expect(rows.slice(0, start).some((row) => row.text.trim() === "ok")).toBe(true);
    // The ghost `Working` row is no busy turn: the box has no stop hint.
    expect(agentWork(rows)).toBeNull();
  });

  it("leaves the screen to the terminal while Ctrl+C asks again to exit", () => {
    const read = live("exitHint");
    expect(read.status).toBeNull();
    expect(read.working).toBeNull();
  });
});

describe("Cursor's own words in an answer", () => {
  const FOOTER = ["", "", "  Auto · 5.5%", "  /home/devuser/myproj · master"];
  const over = (answer: string[], box = "  → Add a follow-up") => ["   what do the keys do?", "", ...answer, "", "", box, ...FOOTER];

  it("is no dialog: rows naming keys above an idle box answer nothing", () => {
    const rows = over(["  The dialog looks like:", "", "    → Run (once) (y)", "    Skip & tell the agent what to do instead (esc or n)"]);
    expect(readReaderLive(buffer(rows), LABEL, 120).question).toBeNull();
    const lines = readableScreen(buffer(rows), 300).lines;
    expect(readLiveQuestion(lines.slice(0, inputFrameStart(lines, LABEL)), lines, LABEL, 120)).toBeNull();
    // The same rows with no box under them are the dialog.
    expect(live("shell120").question?.options.map((option) => option.keys)).toEqual([["y"], ["\t"], ["\u001b[Z"], ["n"]]);
  });

  it("is no busy turn: a quoted stop hint over an idle box is not a Stop button", () => {
    const rows = readableScreen(buffer(over(["  Press this:", "  → quit now      ctrl+c to stop"])), 300).lines;
    expect(agentWork(rows)).toBeNull();
    expect(readReaderLive(buffer(over(["  → quit now      ctrl+c to stop"])), LABEL, 120).working).toBeNull();
  });

  it("is no busy turn on another CLI's screen", () => {
    const claude = ["  Keys:", "  → Press ctrl+c to stop", "", "╭──────────╮", "│ >        │", "╰──────────╯", "  ? for shortcuts"];
    expect(agentWork(readableScreen(buffer(claude), 300).lines)).toBeNull();
    expect(readReaderLive(buffer(claude), "Claude", 120).working).toBeNull();
  });

  it("keeps a folder with a space in its name in the facts row", () => {
    const rows = ["   x", "", "", "  → Add a follow-up", "", "", "  Auto · 5.5%", "  /home/devuser/My Project · main"];
    expect(live("idleFresh").status?.path).toBe(PATH);
    expect(readReaderLive(buffer(rows), LABEL, 120).status).toEqual({ model: "Auto", context: "94.5%", path: "/home/devuser/My Project", branch: "main" });
  });
});

describe("Cursor's footer", () => {
  it("names the mode over the model only when it is not the agent's own", () => {
    expect(live("planMode").status?.mode).toBe("plan");
    expect(live("debugMode").status?.mode).toBe("debug");
    expect(live("askMode").status?.mode).toBe("ask");
    expect(live("idleFresh").status?.mode).toBeUndefined();
  });

  it("splits a parameterised model from its window and level", () => {
    expect(live("sonnet").status).toMatchObject({ model: "Claude Sonnet 5.5", effort: "high" });
    expect(cursorModel("Grok 4.7 256K High Fast")).toEqual({ model: "Grok 4.7", effort: "high" });
    expect(cursorModel("Composer 2.5 Fast")).toEqual({ model: "Composer 2.5" });
    expect(cursorModel("Auto")).toEqual({ model: "Auto" });
  });

  it("reads the approval setting at the row's right end as no mode", () => {
    const status = live("forced").status;
    expect(status).toMatchObject({ model: "Claude Sonnet 5.5", effort: "high" });
    expect(status?.mode).toBeUndefined();
  });
});

describe("Cursor's modes", () => {
  it("offers the Shift+Tab cycle as a list, the agent's own mode silent", () => {
    expect(modeOffered(LABEL)).toBe(true);
    expect(modeFixed(LABEL)).toBe(false);
    const choices = modeChoices("plan", LABEL);
    expect(choices.map((choice) => choice.value)).toEqual(["agent", "plan", "debug", "ask"]);
    expect(currentMode(choices, "debug", true)).toBe("debug");
    expect(currentMode(modeChoices(undefined, LABEL), undefined, true)).toBe("agent");
    expect(currentMode(modeChoices(undefined, LABEL), undefined, false)).toBeUndefined();
  });

  it("does not claim another family's plan, or hand Cursor's modes to another family", () => {
    expect(modeChoices("plan", "Claude").map((choice) => choice.value)).not.toContain("debug");
    expect(modeChoices("debug", "Claude")).toEqual([]);
    expect(modeChoices("ask")).toEqual([]);
  });

  it("presses the legacy backtab, which the TUI cycles on", () => {
    expect(shiftTabKey(LABEL)).toBe("\u001b[Z");
  });
});

describe("Cursor's busy turn", () => {
  it("is read off the box's stop hint, with the tokens the busy row counts", () => {
    for (const [frame, columns] of [["busy120", 120], ["busy60", 60], ["busy42", 42]] as const) {
      const read = live(frame, columns);
      expect(read.working).toEqual({ tokens: "73" });
      expect(read.question).toBeNull();
      expect(read.stray).toBe(false);
      expect(read.status).toMatchObject({ model: "Auto", context: "94.5%", branch: "master" });
    }
  });

  it("stays busy while a draft is typed, which takes the hint away", () => {
    const rows = rowsOf("busyTyped");
    expect(rows.some((row) => row.text.includes("ctrl+c to stop"))).toBe(false);
    expect(live("busyTyped").working).toEqual({ tokens: "73" });
  });

  it("keeps the follow-ups box and the busy row out of the output", () => {
    const rows = rowsOf("busyQueued");
    const start = inputFrameStart(rows, LABEL);
    expect(rows.slice(0, start).map((row) => row.text.trim()).filter(Boolean).pop()).toBe("$ sleep 25; echo hi 11s");
    expect(live("busyQueued").working).toEqual({ tokens: "73" });
  });

  it("stops on Ctrl+C: Esc does nothing to a running turn", () => {
    expect(stopKey(agentFamily("cursor-agent"))).toBe("\u0003");
    expect(stopKey("claude")).toBe("\u001b");
  });

  it("is a turn, not an idle box, while the field to tell the agent what to do instead waits", () => {
    const read = live("tellAgent");
    expect(read.question).toBeNull();
    expect(read.working).not.toBeNull();
  });
});

describe("Cursor's approvals", () => {
  const labels = (frame: string, columns = 120) => live(frame, columns).question?.options.map((option) => option.label);

  it("reads a shell command's four answers, each with the key its row names", () => {
    for (const [frame, columns] of [["shell120", 120], ["shell60", 60], ["shell42", 42]] as const) {
      const question = live(frame, columns).question!;
      expect(question.title).toBe("Run this command?");
      expect(question.options.map((option) => option.label)).toEqual([
        "Run (once)",
        "Add Shell(sleep), Shell(echo) to allowlist?",
        "Run Everything",
        "Skip & tell the agent what to do instead",
      ]);
      expect(question.options.map((option) => option.keys)).toEqual([["y"], ["\t"], ["\u001b[Z"], ["n"]]);
      expect(question.current).toBe(0);
    }
  });

  it("says what is asked: the command and why", () => {
    const read = live("shell120");
    expect(read.ask).toEqual(["Run this command?", "Not in allowlist: echo, sleep"]);
    expect(read.context.join("\n")).toContain("$  sleep 25; echo hi in .");
    expect(read.working).toBeNull();
  });

  it("follows the highlight, which the keys do not need", () => {
    expect(live("shellThird").question?.current).toBe(2);
  });

  it("answers by the row's key, not by walking to it", () => {
    const question = live("shell120").question!;
    expect(answerKeys(question, question.options[0])).toEqual(["y"]);
    expect(answerKeys(question, question.options[3])).toEqual(["n"]);
    const third = live("shellThird").question!;
    expect(answerKeys(third, third.options[0])).toEqual(["y"]);
  });

  it("reads a write outside the workspace, its hint cut mid-word at 60 columns", () => {
    for (const [frame, columns] of [["write120", 120], ["write60", 60], ["write42", 42]] as const) {
      const question = live(frame, columns).question!;
      expect(question.title).toBe("Write to this file?");
      expect(question.options.map((option) => option.keys)).toEqual([["y"], ["n"], ["\t"], ["\u001b[Z"]]);
      expect(question.options[0].label).toBe("Proceed");
      expect(question.options[1].label).toBe("Reject & propose changes");
      expect(question.options[3].label).toBe("Run Everything");
    }
    expect(labels("write60", 60)?.[2]).toBe("Add Write(/home/.../outside-hello.txt) to allowlist?");
    expect(labels("write42", 42)?.[2]).toBe("Add Write(/home/.../outside-hello.txt) to allowlist?");
  });

  it("reads the workspace trust page, answered with the letter on the row", () => {
    for (const [frame, columns] of [["trust120", 120], ["trust42", 42]] as const) {
      const question = live(frame, columns).question!;
      expect(question.title).toBe("Do you trust the contents of this directory?");
      expect(question.options.map((option) => option.label)).toEqual(["Trust this workspace", "Quit"]);
      expect(question.options.map((option) => option.keys)).toEqual([["a"], ["q"]]);
      expect(question.current).toBe(0);
    }
  });

  it("lights the decision lamp for each, and for no other screen", () => {
    for (const frame of ["shell120", "shell42", "write120", "write60", "trust120", "trust42"]) {
      expect(looksLikeDecisionPromptStripped(F[frame].join("\n")), frame).toBe(true);
    }
    for (const frame of ["idleFresh", "idleAfter120", "busy120", "busyQueued", "tellAgent", "planMode", "model120"]) {
      expect(looksLikeDecisionPromptStripped(F[frame].join("\n")), frame).toBe(false);
    }
  });

  it("reads nothing as a dialog from another family's screen", () => {
    expect(readReaderLive(buffer(F.shell120), "Claude", 120).question?.options.map((option) => option.keys)).not.toContainEqual(["y"]);
  });
});

describe("Cursor's composer", () => {
  it("sends a multi-line prompt as one paste, then Enter, where the pane has the mode on", () => {
    expect(bracketsAgentMessage("cursor-agent", true)).toBe(true);
    expect(agentInputWrites("Reply with exactly ok.\nSecond line.", true)).toEqual([
      "\u0001\u000b", "\u001b[200~Reply with exactly ok.\nSecond line.\u001b[201~", "\r",
    ]);
  });

  it("types the lines apart with Ctrl+J, which Cursor takes as a line break", () => {
    expect(agentInputWrites("one\ntwo")).toEqual(["\u0001\u000b", "one", "\n", "two", "\r"]);
  });
});

describe("Cursor's slash menu", () => {
  /** What the real `/` menu lists (`slash`, scrolled to its end). */
  const MENU = [
    "/model", "/goal", "/add-dir", "/save-workspace", "/load-workspace", "/run-everything", "/auto-review", "/plan", "/ask", "/debug",
    "/update", "/max-mode", "/fast", "/rename", "/clear", "/resume", "/fork", "/summarize", "/vim", "/line-numbers", "/show-thinking",
    "/status-indicators", "/shell", "/about", "/setup-terminal", "/help", "/open", "/cursor", "/copy-request-id", "/copy-conversation-id",
    "/team", "/logout", "/quit", "/exit", "/plugin", "/config", "/copy", "/sandbox", "/bedrock",
  ];

  it("offers only commands the real menu has", () => {
    expect(F.slash.join("\n")).toContain("/model [filter]");
    const catalog = slashCatalog("cursor").map((entry) => entry.command);
    expect(catalog.length).toBeGreaterThan(5);
    for (const command of catalog) expect(MENU, command).toContain(command);
  });

  it("completes a typed prefix", () => {
    expect(slashSuggestions("/mo", "cursor", []).map((row) => row.line)).toEqual(["/model"]);
    expect(slashSuggestions("/", "cursor", [], MAX_SUGGESTIONS)).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe("Cursor's gates", () => {
  it("is a chat CLI with a Reader and Diffs, here and on the phone", () => {
    expect(chatAgent("cursor-agent")).toBe(true);
    expect(READER_AGENTS.has("cursor-agent")).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "cursor-agent" })).toBe(true);
    expect(changesOffered("cursor-agent")).toBe(true);
  });

  it("is not read on a remote host, where nothing finds its chat", () => {
    expect(readerOffered({ kind: "agent", cmd: "cursor-agent" }, true)).toBe(false);
  });

  it("offers its Resume menu once the tab has its launch id, marked untested", () => {
    expect(UNTESTED_CHAT_AGENTS.has("cursor-agent")).toBe(true);
    const tab = { kind: "agent", cmd: "cursor-agent", sessionId: "7f0c" } as Parameters<typeof chatsOffered>[1];
    expect(chatsOffered("root", tab)).toBe(true);
    expect(chatsOffered("root", { ...tab, sessionId: undefined } as typeof tab)).toBe(false);
  });

  it("is a verified release in the frontend's table too: the build under test raises no newer-than-verified card", () => {
    const report = (version: string) => ({
      agent: "cursor-agent", label: "Cursor", version, state: "moved" as const, dismissed: false,
      stale: [{ version: "2026.09.28-64d2043", surface: "tui", direction: "newer" as const }],
    });
    expect(newerNotice(report("2026.11.22-e9042b2"))).toBeNull();
    expect(newerNotice(report("2026.12.01-aaaaaaa"))).not.toBeNull();
  });
});
