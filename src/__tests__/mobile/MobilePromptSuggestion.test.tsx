/**
 * Claude Code's prompt suggestion in the phone's Focus chat
 * (`mobile-web/src/terminal/promptSuggestion.ts`). The CLI draws it dimmed in
 * its empty input box, which the chat hides; the composer is filled with it
 * once per suggestion. It is never sent on its own.
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
import { BRAND, storageKey } from "../../lib/brand";

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

const hint = () => screen.queryByRole("group", { name: "Claude suggests" });
const field = () => screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement;
const SUGGESTION = "make it ask for my name";

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

  const open = async (box: string) => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    FakeWebSocket.sent = [];
    await paint(idle(box));
  };

  it("puts the dimmed suggestion into the empty field and sends nothing", async () => {
    await open(`${DIM}❯ ${SUGGESTION}`);
    expect(field().value).toBe(SUGGESTION);
    expect(hint()).not.toBeNull();
    expect(FakeWebSocket.sent).toEqual([]);
  });

  it("does not fill it again once the reader has emptied the field", async () => {
    await open(`${DIM}❯ ${SUGGESTION}`);
    fireEvent.change(field(), { target: { value: "" } });
    await paint(idle(`${DIM}❯ ${SUGGESTION}`));
    expect(field().value).toBe("");
    expect(hint()).toBeNull();
  });

  it("leaves a draft the reader typed alone, now and when it is emptied", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    fireEvent.change(field(), { target: { value: "no" } });
    await paint(idle(`${DIM}❯ ${SUGGESTION}`));
    expect(field().value).toBe("no");
    expect(hint()).toBeNull();
    fireEvent.change(field(), { target: { value: "" } });
    expect(field().value).toBe("");
  });

  it("takes an untouched suggestion out again when the CLI no longer shows it; an edited one stays", async () => {
    await open(`${DIM}❯ ${SUGGESTION}`);
    await paint(idle("❯ "));
    expect(field().value).toBe("");
    await paint(idle(`${DIM}❯ run the tests`));
    expect(field().value).toBe("run the tests");
    fireEvent.change(field(), { target: { value: "run the tests twice" } });
    expect(hint()).toBeNull();
    await paint(idle("❯ "));
    expect(field().value).toBe("run the tests twice");
  });

  it("does not keep an untouched suggestion as the tab's saved draft", async () => {
    await open(`${DIM}❯ ${SUGGESTION}`);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 600)); });
    expect(localStorage.getItem(storageKey("mobile.drafts")) ?? "").not.toContain("ask for my name");
  });

  it("reads a typed (not dim) draft in the CLI's box as no suggestion", async () => {
    await open(`❯ ${SUGGESTION}`);
    expect(field().value).toBe("");
    expect(hint()).toBeNull();
  });
});
