/**
 * Claude Code's prompt suggestion in the phone's Focus chat
 * (`mobile-web/src/terminal/promptSuggestion.ts`). The CLI draws it dimmed in
 * its empty input box, which the chat hides; the composer shows it as a row a
 * tap puts into the field. It is never sent on its own.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[] }));

/** Marks a row whose cells after the `❯ ` are dim, as Claude Code paints its
 * suggestion. */
const DIM = "\u0002";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        type: "normal",
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          if (value == null) return undefined;
          if (!value.startsWith(DIM)) return { isWrapped: false, translateToString: () => value };
          const text = value.slice(1);
          const cell = (char: string, dim: boolean) => ({
            getChars: () => char, getWidth: () => 1, isBold: () => 0, isItalic: () => 0, isDim: () => (dim ? 1 : 0),
            isUnderline: () => 0, isStrikethrough: () => 0, isInverse: () => 0, isInvisible: () => 0,
            isFgDefault: () => true, isBgDefault: () => true, isFgPalette: () => false, isBgPalette: () => false,
            isFgRGB: () => false, isBgRGB: () => false, getFgColor: () => 0, getBgColor: () => 0,
          });
          return {
            isWrapped: false,
            length: text.length,
            translateToString: () => text,
            getCell: (x: number) => (x < text.length ? cell(text[x], x >= 2) : undefined),
          };
        },
      },
    };
    loadAddon() {}
    open() {}
    write(value: Uint8Array | string, callback?: () => void) {
      if (typeof value !== "string") terminalState.lines = new TextDecoder().decode(value).split("\n");
      callback?.();
    }
    onData() { return { dispose() {} }; }
    scrollLines() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static sent: string[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: unknown) {
    if (ArrayBuffer.isView(data)) FakeWebSocket.sent.push(new TextDecoder().decode(data as Uint8Array));
  }
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND } from "../../lib/brand";

const TAB = { id: "tab-s", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };
const RULE = "─".repeat(60);
/** The bottom of an idle Claude Code screen with `box` as its input row. */
const idle = (box: string) => [
  "● Done. hello.py prints hello.",
  "",
  RULE,
  box,
  RULE,
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const paint = async (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
};

const suggestionRow = () => screen.queryByRole("group", { name: "Claude suggests" });
const field = () => screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement;

describe(`${BRAND.display} Mobile Focus — Claude's prompt suggestion`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(404, { error: "not_found" }))));
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the dimmed suggestion over the empty field; a tap fills it and sends nothing", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint(idle(`${DIM}❯ make it ask for my name`));
    const row = suggestionRow();
    expect(row?.textContent).toContain("make it ask for my name");
    FakeWebSocket.sent = [];
    fireEvent.click(screen.getByRole("button", { name: "make it ask for my name" }));
    expect(field().value).toBe("make it ask for my name");
    expect(suggestionRow()).toBeNull();
    expect(FakeWebSocket.sent).toEqual([]);
  });

  it("is hidden while the reader has typed something, and shows again once the field is empty", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint(idle(`${DIM}❯ make it ask for my name`));
    fireEvent.change(field(), { target: { value: "no" } });
    expect(suggestionRow()).toBeNull();
    fireEvent.change(field(), { target: { value: "" } });
    expect(suggestionRow()).not.toBeNull();
  });

  it("reads a typed (not dim) draft in the CLI's box as no suggestion", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint(idle("❯ make it ask for my name"));
    expect(suggestionRow()).toBeNull();
  });
});
