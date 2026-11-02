import { describe, expect, it } from "vitest";
import { codexBoxLines, inputBoxLines, openCodePanelRows, pullQueuedPrompts, queueFamily, queuedHintShown, sendQueuedNow, takenPrompts } from "../../../mobile-web/src/terminal/queuePull";

const FAST = { waitMs: 30, pollMs: 2 };
const RULE = "────────────────────────────────────────";
const HINT = "Press up to edit queued messages";

/**
 * Claude Code 2.1.303's input box under a busy turn, as probed: the empty box
 * reads the queue hint while messages wait; ↑ there moves them all into the
 * box, one line each, cursor at the end; Ctrl+U deletes to the line's start,
 * or the line break when already there; ↑ with nothing queued recalls the
 * last prompt from the CLI's history.
 */
function fakeClaude(queue: string[], options: { history?: string; hint?: boolean } = {}) {
  const state = { queue: [...queue], box: "", keys: [] as string[] };
  const rows = () => {
    const lines = state.box ? state.box.split("\n") : [state.queue.length && options.hint !== false ? HINT : ""];
    return [
      "✻ Whisking… (5s · thinking)",
      RULE,
      // 2.1.310 draws the live box's space after the `❯` as a no-break space.
      ...lines.map((line, index) => `${index ? "  " : "❯\u00a0"}${line}`),
      RULE,
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ];
  };
  const key = async (pressed: string) => {
    state.keys.push(pressed);
    if (pressed === "\u001b[A" && !state.box) {
      if (state.queue.length) state.box = state.queue.splice(0).join("\n");
      else if (options.history) state.box = options.history;
    } else if (pressed === "\u0015") {
      const start = state.box.lastIndexOf("\n") + 1;
      state.box = start === state.box.length && start > 0 ? state.box.slice(0, -1) : state.box.slice(0, start);
    }
    return true;
  };
  return { state, driver: { rows, key } };
}

describe("queuePull", () => {
  it("reads the box between its rules", () => {
    expect(inputBoxLines([RULE, "❯ one", "  two", RULE, "  footer"])).toEqual(["one", "two"]);
    expect(inputBoxLines(["❯ 1. Yes", "  2. No"])).toBeNull();
    expect(queuedHintShown([RULE, `❯ ${HINT}, Enter to send them immediately:`, RULE])).toBe(true);
    expect(queuedHintShown([RULE, "❯ ", RULE])).toBe(false);
  });

  it("reads the box as 2.1.310 draws it, a no-break space after the ❯", () => {
    expect(inputBoxLines([RULE, "❯\u00a0one", "\u00a0\u00a0two", RULE])).toEqual(["one", "two"]);
    expect(queuedHintShown([RULE, `❯\u00a0${HINT}`, RULE])).toBe(true);
    expect(queuedHintShown([RULE, "❯\u00a0", RULE])).toBe(false);
  });

  it("takes every queued prompt back and empties Claude's box", async () => {
    const { state, driver } = fakeClaude(["first line\nof the first", "second"]);
    const result = await pullQueuedPrompts(driver, ["first line\nof the first", "second"], FAST);
    expect(result).toEqual({ ok: true, text: "first line\nof the first\nsecond", pulled: 2, cleared: true });
    expect(state.queue).toEqual([]);
    expect(state.box).toBe("");
  });

  it("counts only the newest sent prompts the box ends with", async () => {
    // The first was already taken up by the turn; only the second waits.
    const { driver } = fakeClaude(["second"]);
    const result = await pullQueuedPrompts(driver, ["first", "second"], FAST);
    expect(result).toMatchObject({ ok: true, text: "second", pulled: 1, cleared: true });
  });

  it("brings along a message queued in the terminal itself", async () => {
    const { state, driver } = fakeClaude(["typed there", "sent here"]);
    const result = await pullQueuedPrompts(driver, ["sent here"], FAST);
    expect(result).toMatchObject({ ok: true, text: "typed there\nsent here", pulled: 1, cleared: true });
    expect(state.box).toBe("");
  });

  it("presses nothing unless the box says messages wait", async () => {
    const { state, driver } = fakeClaude(["queued"], { hint: false });
    expect(await pullQueuedPrompts(driver, ["queued"], FAST)).toEqual({ ok: false, reason: "not_queued" });
    expect(state.keys).toEqual([]);
  });

  it("drops no bubble for a history recall it did not send", async () => {
    // The queue drained between the check and ↑: the box recalls history.
    const { state, driver } = fakeClaude(["queued"], { history: "older prompt" });
    const rows = driver.rows;
    let drained = false;
    driver.rows = () => {
      const now = rows();
      if (!drained) {
        drained = true;
        state.queue = [];
      }
      return now;
    };
    const result = await pullQueuedPrompts(driver, ["queued"], FAST);
    expect(result).toMatchObject({ ok: true, text: "older prompt", pulled: 0, cleared: true });
  });
});

/**
 * Codex 0.166.0's screen under a busy turn, as probed: Tab queues under a
 * heading; `shift+←` (under tmux) moves the newest one into the box, replacing
 * what the box held; Ctrl+U deletes to the line's start, or the break there;
 * Esc drops the whole list into the box, Enter then sends it.
 */
function fakeCodex(queue: string[], options: { editKey?: string } = {}) {
  const editKey = options.editKey ?? "shift+←";
  const state = { queue: [...queue], box: "", sent: [] as string[], keys: [] as string[] };
  const rows = () => [
    "• Working (5s • esc to interrupt) · 1 background terminal running",
    "",
    ...(state.queue.length ? [
      "• Queued follow-up inputs",
      ...state.queue.flatMap((line) => line.split("\n").map((part, index) => `${index ? "    " : "  ↳ "}${part}`)),
      `    ${editKey} edit last queued message`,
      "",
    ] : []),
    "",
    ...(state.box ? state.box.split("\n").map((line, index) => `${index ? "  " : "› "}${line}`) : ["› Ask Codex to do anything"]),
    "",
    "  gpt default · ~/work",
    "  ? for shortcuts",
  ];
  const key = async (pressed: string) => {
    state.keys.push(pressed);
    if (pressed === "\u001b[1;2D" || pressed === "\u001b[1;3A") state.box = state.queue.pop() ?? state.box;
    else if (pressed === "\u0015") {
      const start = state.box.lastIndexOf("\n") + 1;
      state.box = start === state.box.length && start > 0 ? state.box.slice(0, -1) : state.box.slice(0, start);
    } else if (pressed === "\u001b") {
      state.box = state.queue.splice(0).join("\n");
    } else if (pressed === "\r" && state.box) {
      state.sent.push(state.box);
      state.box = "";
    }
    return true;
  };
  return { state, driver: { rows, key } };
}

describe("queuePull on Codex", () => {
  it("reads its queue and its box off the screen", () => {
    expect(queuedHintShown(fakeCodex(["one"]).driver.rows(), "codex")).toBe(true);
    expect(queuedHintShown(fakeCodex([]).driver.rows(), "codex")).toBe(false);
    expect(codexBoxLines(["› one", "  two", "", "  footer"])).toEqual(["one", "two"]);
    // The conversation's echoes are not the box.
    expect(codexBoxLines(["› asked", "• answer", "", "› Ask Codex to do anything", "", "  footer"])).toEqual(["Ask Codex to do anything"]);
    expect(codexBoxLines(["›⠀Ask Codex"])).toEqual(["Ask Codex"]);
  });

  it("takes every queued prompt back, oldest first, and leaves the box empty", async () => {
    const { state, driver } = fakeCodex(["first", "line A\nline B"]);
    const result = await pullQueuedPrompts(driver, ["first", "line A\nline B"], FAST, "codex");
    expect(result).toEqual({ ok: true, text: "first\nline A\nline B", pulled: 2, cleared: true });
    expect(state).toMatchObject({ queue: [], box: "", sent: [] });
  });

  it("presses the key its hint names", async () => {
    const { state, driver } = fakeCodex(["only"], { editKey: "⌥ + ↑" });
    await pullQueuedPrompts(driver, ["only"], FAST, "codex");
    expect(state.keys[0]).toBe("\u001b[1;3A");
  });

  it("comes back as sent when the box wrapped a long word", async () => {
    const long = "P".repeat(120);
    const { driver } = fakeCodex([`${long.slice(0, 80)}\n${long.slice(80)}`]);
    const result = await pullQueuedPrompts(driver, [long], FAST, "codex");
    expect(result).toMatchObject({ ok: true, text: long, pulled: 1 });
  });

  it("keeps what it cannot match, without dropping a bubble", async () => {
    const { driver } = fakeCodex(["typed in the terminal"]);
    expect(await pullQueuedPrompts(driver, ["sent from the chat"], FAST, "codex"))
      .toMatchObject({ ok: true, text: "typed in the terminal", pulled: 0 });
  });

  it("presses nothing when no queue shows", async () => {
    const { state, driver } = fakeCodex([]);
    expect(await pullQueuedPrompts(driver, ["gone"], FAST, "codex")).toEqual({ ok: false, reason: "not_queued" });
    expect(state.keys).toEqual([]);
  });

  it("sends the queue on: Esc, then Enter once the list has gone", async () => {
    const { state, driver } = fakeCodex(["one", "two"]);
    expect(await sendQueuedNow(driver, "codex")).toBe(true);
    expect(state.sent).toEqual(["one\ntwo"]);
    expect(state.keys).toEqual(["\u001b", "\r"]);
  });

  it("does not press Esc on a turn that took the queue", async () => {
    const { state, driver } = fakeCodex([]);
    expect(await sendQueuedNow(driver, "codex")).toBe(false);
    expect(state.keys).toEqual([]);
  });
});

/**
 * OpenCode 2.2.5 mini, as probed: the footer counts what waits; `ctrl+x q`
 * opens a panel listing it, oldest on top, where ctrl+d deletes the top row
 * and esc closes. Esc twice, apart, stops the turn.
 */
function fakeOpenCode(queue: string[], options: { full?: boolean; refuse?: boolean } = {}) {
  const state = { queue: [...queue], panel: false, leader: false, keys: [] as string[] };
  const rows = () => state.panel
    ? ["› first", `  Pending prompts ${state.queue.length}                      esc`, "  Search", ...state.queue.map((line) => `  ${line}          steering`), "▀▀▀▀▀▀▀▀▀▀"]
    : ["› first", "┃", options.full
      ? "   ■⬝⬝⬝⬝ esc interrupt      ctrl+p commands"
      : `🯦 esc stop${state.queue.length ? ` · ctrl+x q ${state.queue.length} pending` : ""} · Build · stub`];
  const key = async (pressed: string) => {
    state.keys.push(pressed);
    if (pressed === "\u0018") state.leader = true;
    else if (pressed === "q" && state.leader) state.panel = true;
    else if (pressed === "\u0004" && state.panel && !options.refuse) state.queue.shift();
    else if (pressed === "\u001b") state.panel = false;
    return true;
  };
  return { state, driver: { rows, key } };
}

describe("queuePull on OpenCode", () => {
  it("reads the mini footer's count and the panel's rows", () => {
    expect(queuedHintShown(fakeOpenCode(["one"]).driver.rows(), "opencode")).toBe(true);
    expect(queuedHintShown(fakeOpenCode([]).driver.rows(), "opencode")).toBe(false);
    expect(openCodePanelRows(fakeOpenCode([]).driver.rows())).toBeNull();
    expect(openCodePanelRows(["  Pending prompts 2   esc", "  Search", "  one two     steering", "  three     queue", "▀▀▀▀"])).toEqual(["one two", "three"]);
  });

  it("never opens the panel on the full TUI, where ctrl+x q quits", async () => {
    const { state, driver } = fakeOpenCode(["one"], { full: true });
    expect(queuedHintShown(driver.rows(), "opencode")).toBe(false);
    expect(await pullQueuedPrompts(driver, ["one"], FAST, "opencode")).toEqual({ ok: false, reason: "not_queued" });
    expect(await sendQueuedNow(driver, "opencode")).toBe(false);
    expect(state.keys).toEqual([]);
  });

  it("deletes every prompt from the panel into the composer and closes it", async () => {
    const { state, driver } = fakeOpenCode(["one", "two"]);
    const result = await pullQueuedPrompts(driver, ["older", "one", "two"], FAST, "opencode");
    expect(result).toMatchObject({ ok: true, text: "one\ntwo", pulled: 2, oldest: false, cleared: true });
    expect(state).toMatchObject({ queue: [], panel: false });
  });

  it("touches nothing when a row is not a prompt it sent", async () => {
    const { state, driver } = fakeOpenCode(["typed in the terminal"]);
    expect(await pullQueuedPrompts(driver, ["sent from the chat"], FAST, "opencode")).toEqual({ ok: false, reason: "not_pulled" });
    expect(state).toMatchObject({ queue: ["typed in the terminal"], panel: false });
    expect(state.keys).not.toContain("\u0004");
  });

  it("says which prompts left when the panel stops deleting", async () => {
    const { driver } = fakeOpenCode(["one", "two"], { refuse: true });
    expect(await pullQueuedPrompts(driver, ["one", "two"], FAST, "opencode")).toEqual({ ok: false, reason: "not_pulled" });
    expect(takenPrompts(["a", "b", "c"], { pulled: 1, oldest: true })).toEqual(["a"]);
    expect(takenPrompts(["a", "b", "c"], { pulled: 2 })).toEqual(["b", "c"]);
  });

  it("presses Esc twice, apart, for Send now", async () => {
    const { state, driver } = fakeOpenCode(["one"]);
    expect(await sendQueuedNow(driver, "opencode")).toBe(true);
    expect(state.keys).toEqual(["\u001b", "\u001b"]);
  });
});

describe("queueFamily", () => {
  it("names only the CLIs whose queue the screen shows", () => {
    expect(["claude", "codex", "opencode"].map(queueFamily)).toEqual(["claude", "codex", "opencode"]);
    for (const family of ["copilot", "gemini", "qwen", "agent"]) expect(queueFamily(family)).toBeNull();
  });
});
