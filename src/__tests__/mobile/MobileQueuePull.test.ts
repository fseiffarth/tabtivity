import { describe, expect, it } from "vitest";
import { inputBoxLines, pullQueuedPrompts, queuedHintShown } from "../../../mobile-web/src/terminal/queuePull";

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
