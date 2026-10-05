/**
 * Locks the "you asked them N things" heuristic.
 *
 * Tabtivity only sees the bytes going into an agent's PTY, so a submitted prompt is
 * inferred: Enter pressed with content typed since the last Enter. The cases that
 * matter are the ones that must NOT count — arrow keys (escape sequences whose
 * payload bytes are printable), Ctrl-C, and a bare Enter on an empty line — and
 * the one that must count as exactly one: paste, then Enter.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetPromptCountForTest,
  forgetPty,
  hasContent,
  hasSubmit,
  noteInput,
} from "../../lib/agents/promptCount";

const PTY = "proj-a:agent-1";

beforeEach(_resetPromptCountForTest);

describe("hasContent", () => {
  it("sees printable text", () => {
    expect(hasContent("hello")).toBe(true);
    expect(hasContent("a")).toBe(true);
  });

  it("does not see an arrow key", () => {
    // "\x1b[A" — a naive scan would count the "[" and "A" as two typed chars, so
    // walking history would look like composing a prompt.
    expect(hasContent("\x1b[A")).toBe(false);
    expect(hasContent("\x1b[B")).toBe(false);
    expect(hasContent("\x1b[1;5C")).toBe(false); // ctrl+right
  });

  it("does not see control characters", () => {
    expect(hasContent("\x03")).toBe(false); // ctrl+c
    expect(hasContent("\t")).toBe(false);
    expect(hasContent("\x7f")).toBe(false); // backspace
    expect(hasContent("\r")).toBe(false);
    expect(hasContent("")).toBe(false);
  });

  it("sees content mixed in with control bytes", () => {
    expect(hasContent("hi\r")).toBe(true);
  });
});

describe("hasSubmit", () => {
  it("recognises carriage return and newline", () => {
    expect(hasSubmit("\r")).toBe(true);
    expect(hasSubmit("\n")).toBe(true);
    expect(hasSubmit("hello")).toBe(false);
  });
});

describe("noteInput", () => {
  it("counts one submit for typing then Enter", () => {
    expect(noteInput(PTY, "f")).toBe(0);
    expect(noteInput(PTY, "i")).toBe(0);
    expect(noteInput(PTY, "x")).toBe(0);
    expect(noteInput(PTY, "\r")).toBe(1);
  });

  it("does not count a bare Enter on an empty line", () => {
    // Scrolling an agent's menu or accepting a default is not a question asked.
    expect(noteInput(PTY, "\r")).toBe(0);
    expect(noteInput(PTY, "\r")).toBe(0);
  });

  it("does not count Enter again after a submit with nothing retyped", () => {
    noteInput(PTY, "hi");
    expect(noteInput(PTY, "\r")).toBe(1);
    expect(noteInput(PTY, "\r")).toBe(0);
  });

  it("counts a paste followed by Enter exactly once", () => {
    // A paste arrives as a single onData chunk.
    expect(noteInput(PTY, "please refactor the parser")).toBe(0);
    expect(noteInput(PTY, "\r")).toBe(1);
  });

  it("counts a chunk that carries both content and Enter as one submit", () => {
    expect(noteInput(PTY, "hello\r")).toBe(1);
  });

  it("counts a multi-line paste as one thing asked, not one per line", () => {
    expect(noteInput(PTY, "line one\nline two\nline three\n")).toBe(1);
  });

  it("does not count arrow keys followed by Enter", () => {
    expect(noteInput(PTY, "\x1b[A")).toBe(0);
    expect(noteInput(PTY, "\r")).toBe(0);
  });

  it("does not count Ctrl-C followed by Enter", () => {
    expect(noteInput(PTY, "\x03")).toBe(0);
    expect(noteInput(PTY, "\r")).toBe(0);
  });

  it("counts two prompts across two rounds", () => {
    noteInput(PTY, "first");
    expect(noteInput(PTY, "\r")).toBe(1);
    noteInput(PTY, "second");
    expect(noteInput(PTY, "\r")).toBe(1);
  });

  it("keeps separate PTYs independent", () => {
    const other = "proj-b:agent-1";
    noteInput(PTY, "typed here");
    // The other terminal has nothing pending, so its Enter must not steal the
    // first one's content.
    expect(noteInput(other, "\r")).toBe(0);
    expect(noteInput(PTY, "\r")).toBe(1);
  });

  it("forgetPty drops pending state so a recycled id does not inherit it", () => {
    noteInput(PTY, "half-typed");
    forgetPty(PTY);
    expect(noteInput(PTY, "\r")).toBe(0);
  });
});
