import { beforeEach, describe, expect, it } from "vitest";
import { feedTypedLine, type TypedLine } from "../../lib/agents/typedPrompt";
import { buildPromptTrail, TRAIL_PAIR_MS } from "../../lib/agents/prompt/trail";
import type { SentAgentPrompt } from "../../stores/agents/agentPrompts";
import type { TabEntry } from "../../stores/tabs";
import {
  TYPED_TRAIL_MAX,
  _resetPromptTrailForTest,
  forgetPromptTrail,
  notePromptTrailInput,
  usePromptTrailStore,
} from "../../stores/agents/promptTrail";

/** Feed chunks in order; every prompt submitted, and the line left. */
function type(...chunks: string[]): { submitted: string[]; line: TypedLine } {
  let line: TypedLine = { text: "", cursor: 0 };
  let pasting = false;
  const submitted: string[] = [];
  for (const chunk of chunks) {
    const out = feedTypedLine(line, chunk, pasting);
    line = out.line;
    pasting = out.pasting;
    submitted.push(...out.submitted);
  }
  return { submitted, line };
}

describe("following a typed prompt from the keystrokes", () => {
  it("submits what was typed, one Enter at a time", () => {
    expect(type("h", "i", " there", "\r").submitted).toEqual(["hi there"]);
    expect(type("one\rtwo\r").submitted).toEqual(["one", "two"]);
    // A bare Enter asks nothing.
    expect(type("\r", "  \r").submitted).toEqual([]);
  });

  it("edits the line the way a line editor does", () => {
    expect(type("helo", "\x7f\x7f", "llo\r").submitted).toEqual(["hello"]);
    // ← moves the cursor, so the insert lands mid-line; Delete takes the next char.
    expect(type("wrld", "\x1b[D\x1b[D\x1b[D", "o", "\r").submitted).toEqual(["world"]);
    expect(type("abc", "\x1b[D\x1b[D", "\x1b[3~", "\r").submitted).toEqual(["ac"]);
    // Home / Ctrl+E on one line.
    expect(type("bc", "\x1b[H", "a", "\x05", "d\r").submitted).toEqual(["abcd"]);
    // Ctrl+W drops a word, Ctrl+U the head, Ctrl+K the tail.
    expect(type("fix the tests", "\x17", "docs\r").submitted).toEqual(["fix the docs"]);
    expect(type("junk", "\x15", "real\r").submitted).toEqual(["real"]);
    expect(type("keep drop", "\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D", "\x0b", "\r").submitted).toEqual(["keep"]);
  });

  it("keeps a bracketed paste whole, lines and all, even split across chunks", () => {
    expect(type("see: ", "\x1b[200~line one\r\nline two\x1b[201~", "\r").submitted).toEqual(["see: line one\nline two"]);
    expect(type("\x1b[200~part", " two\x1b[201~\r").submitted).toEqual(["part two"]);
    // An Enter inside the paste is text, not a submit.
    expect(type("\x1b[200~a\rb\x1b[201~").submitted).toEqual([]);
  });

  it("Alt+Enter and CSI-u Shift+Enter put a newline in the box", () => {
    expect(type("first", "\x1b\r", "second\r").submitted).toEqual(["first\nsecond"]);
    expect(type("first", "\x1b[13;2u", "second\r").submitted).toEqual(["first\nsecond"]);
  });

  it("gives up on a line only the CLI knows, until the next Enter", () => {
    // History recall, completion, Esc over typed text.
    expect(type("\x1b[A", "\r").submitted).toEqual([]);
    expect(type("src/fo", "\t", " please\r").submitted).toEqual([]);
    expect(type("draft", "\x1b", "more\r").submitted).toEqual([]);
    // ...and the next line is followed again.
    expect(type("\x1b[A\r", "fresh\r").submitted).toEqual(["fresh"]);
    // Ctrl+C empties the box, known or not.
    expect(type("\x1b[A", "\x03", "again\r").submitted).toEqual(["again"]);
    // A bare Esc on an empty box (interrupting the agent) edits nothing.
    expect(type("\x1b", "next\r").submitted).toEqual(["next"]);
  });

  it("ignores focus and mouse reports", () => {
    expect(type("ab", "\x1b[I", "\x1b[<0;10;5M", "c\r").submitted).toEqual(["abc"]);
  });
});

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1" };
const row = (message: string, at: number, extra: Partial<SentAgentPrompt> = {}): SentAgentPrompt => {
  const iso = new Date(at).toISOString();
  return { id: iso, message, created_at: iso, sent_at: iso, tab_label: "Claude", tab_id: "launch-1", ...extra };
};
const T0 = Date.parse("2026-09-30T10:00:00Z");

describe("joining the history and the typed prompts", () => {
  it("orders both sources oldest first and marks what only the keystrokes saw", () => {
    const trail = buildPromptTrail([row("sent by schedule", T0)], [{ text: "typed later", at: T0 + 10 * 60_000 }], tab);
    expect(trail.map((p) => [p.text, p.source])).toEqual([
      ["sent by schedule", "history"],
      ["typed later", "typed"],
    ]);
  });

  it("a typed prompt the history also holds is shown once, with the typed lines when the words agree", () => {
    const typed = [{ text: "fix\nthe tests", at: T0 }];
    expect(buildPromptTrail([row("fix the tests", T0 + 3_000)], typed, tab)).toEqual([
      { text: "fix\nthe tests", at: T0 + 3_000, source: "history" },
    ]);
    // A transcript line cut short still pairs, and the typed text is whole.
    const long = "a ".repeat(200).trim();
    expect(buildPromptTrail([row(`${"a ".repeat(50).trim()}…`, T0)], [{ text: long, at: T0 }], tab)[0].text).toBe(long);
    // The words disagree (a completion the CLI filled in): the record wins.
    expect(buildPromptTrail([row("look at src/foo.ts", T0)], [{ text: "look at src/fo", at: T0 }], tab)).toEqual([
      { text: "look at src/foo.ts", at: T0, source: "history" },
    ]);
  });

  it("pairs one to one and only within the window", () => {
    const typed = [{ text: "a", at: T0 }, { text: "b", at: T0 + 30_000 }];
    const trail = buildPromptTrail([row("b", T0 + 31_000)], typed, tab);
    expect(trail.map((p) => [p.text, p.source])).toEqual([["a", "typed"], ["b", "history"]]);
    const apart = buildPromptTrail([row("x", T0 + TRAIL_PAIR_MS + 1)], [{ text: "x", at: T0 }], tab);
    expect(apart).toHaveLength(2);
  });

  it("leaves out other tabs' rows and prompts that never arrived", () => {
    const history = [
      row("other tab", T0, { tab_id: "launch-2", tab_label: "Codex" }),
      row("missed", T0, { result: "missed" }),
      row("failed", T0, { result: "failed" }),
      row("delivered", T0, { result: "delivered" }),
    ];
    expect(buildPromptTrail(history, [], tab).map((p) => p.text)).toEqual(["delivered"]);
  });

  it("keeps apart tabs that share the default label", () => {
    const history = [
      row("second Claude tab", T0, { tab_id: "launch-2" }),
      row("second, before tab ids", T0 + 1, { tab_id: undefined, session_id: "launch-2" }),
      row("mine, before tab ids", T0 + 2, { tab_id: undefined, session_id: "launch-1" }),
      // A row with no id at all could be any "Claude" tab's: none takes it.
      row("no ids", T0 + 3, { tab_id: undefined }),
      row("mine", T0 + 4),
    ];
    expect(buildPromptTrail(history, [], tab).map((p) => p.text)).toEqual(["mine, before tab ids", "mine"]);
    const second: TabEntry = { ...tab, key: "agent-2", sessionId: "launch-2" };
    expect(buildPromptTrail(history, [], second).map((p) => p.text)).toEqual(["second Claude tab", "second, before tab ids"]);
  });

  it("keeps apart tabs without a session id by their schedule target", () => {
    const gemini: TabEntry = { key: "agent-3", label: "Gemini", cmd: "gemini", cwd: "/p", kind: "agent", scheduleTargetId: "target-3" };
    const other: TabEntry = { ...gemini, key: "agent-4", scheduleTargetId: "target-4" };
    const history = [
      row("to the first", T0, { tab_id: "target-3", tab_label: "Gemini" }),
      row("to the second", T0 + 1, { tab_id: "target-4", tab_label: "Gemini" }),
      row("no ids", T0 + 2, { tab_id: undefined, tab_label: "Gemini" }),
    ];
    expect(buildPromptTrail(history, [], gemini).map((p) => p.text)).toEqual(["to the first"]);
    expect(buildPromptTrail(history, [], other).map((p) => p.text)).toEqual(["to the second"]);
  });
});

describe("the per-pane typed trail", () => {
  beforeEach(() => _resetPromptTrailForTest());
  const accept = (text: string) => text.length > 1;

  it("records submitted prompts, trimmed, and drops what accept refuses", () => {
    notePromptTrailInput("p:agent-1", "  hello  \r", false, accept);
    notePromptTrailInput("p:agent-1", "y\r", false, accept);
    expect(usePromptTrailStore.getState().typedByPty["p:agent-1"].map((p) => p.text)).toEqual(["hello"]);
  });

  it("a line begun on a decision answers it and is not a prompt", () => {
    notePromptTrailInput("p:agent-1", "no, use the other file", true, accept);
    notePromptTrailInput("p:agent-1", "\r", false, accept);
    notePromptTrailInput("p:agent-1", "now the real prompt\r", false, accept);
    expect(usePromptTrailStore.getState().typedByPty["p:agent-1"].map((p) => p.text)).toEqual(["now the real prompt"]);
  });

  it("an Esc that declines the decision frees the next line", () => {
    notePromptTrailInput("p:agent-1", "\x1b", true, accept);
    notePromptTrailInput("p:agent-1", "do it differently\r", false, accept);
    expect(usePromptTrailStore.getState().typedByPty["p:agent-1"].map((p) => p.text)).toEqual(["do it differently"]);
  });

  it("keeps a bounded tail and forgets a closed tab", () => {
    for (let i = 0; i < TYPED_TRAIL_MAX + 5; i++) notePromptTrailInput("p:agent-1", `prompt ${i}\r`, false, accept);
    const kept = usePromptTrailStore.getState().typedByPty["p:agent-1"];
    expect(kept).toHaveLength(TYPED_TRAIL_MAX);
    expect(kept[kept.length - 1].text).toBe(`prompt ${TYPED_TRAIL_MAX + 4}`);
    forgetPromptTrail("p:agent-1");
    expect(usePromptTrailStore.getState().typedByPty["p:agent-1"]).toBeUndefined();
  });
});
