/**
 * The model sheet against Antigravity's picker, which is one dialog for two
 * choices: a list of models, and, under it, the reasoning-effort slider of
 * whichever model its highlight is on. Enter applies both at once.
 *
 * So the sheet asks in two steps where the dialog draws one: the tap walks the
 * highlight to the model — nothing is accepted — the dialog redraws its slider
 * for *that* model, and the stops it then offers are the second step. A model
 * with no slider (every Claude model Antigravity offers) is accepted as soon
 * as the walk lands, because there is nothing left to ask.
 *
 * The screens below are the ones `agy` 1.2.7 actually paints, captured from a
 * live session at 80×24.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          return value == null ? undefined : { isWrapped: false, translateToString: () => value };
        },
      },
    };
    loadAddon() {}
    open() {}
    write(value: Uint8Array, callback?: () => void) {
      terminalState.lines = new TextDecoder().decode(value).split("\n");
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
  /** Keystrokes go out as bytes; the control frames the screen also sends
   * (resize, attach) are JSON strings and are not what these tests read. */
  send(data: unknown) {
    if (ArrayBuffer.isView(data)) FakeWebSocket.sent.push(new TextDecoder().decode(data as Uint8Array));
  }
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND } from "../../lib/brand";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;
const RIGHT = `${ESC}[C`;

/** The dialog with a Gemini model highlighted: its slider takes the room the
 * seventh model would have had, so six of seven rows are drawn. */
const picker = (rows: string[], effort?: string[]) => [
  ">",
  "Switch Model",
  "",
  "  Search:",
  "",
  ...rows,
  "",
  ...(effort ?? []),
  "",
  `Keyboard: ↑/↓ Navigate  ${effort ? "←/→ Effort  " : ""}enter Select  esc Go Back`,
  "",
  "                                                       Gemini 3.6 Flash · medium",
].join("\n");

const MEDIUM = [
  "  Effort  ◂        ●━━━━━━━━━━━━━━◉──────────────○        ▸",
  "                  low          medium          high",
  "            Balanced speed and reasoning quality for most tasks",
  "  [1-6 of 7 items]",
];
const SIX = (marked: number) => [
  "  Gemini 3.8 Flash",
  "  Gemini 3.7 Flash",
  "  Gemini 3.6 Flash             (current)",
  "  Gemini 3.1 Pro",
  "  Claude Sonnet 4.6 (Thinking)",
  "  Claude Opus 4.6 (Thinking)",
].map((row, index) => (index === marked ? `>${row.slice(1)}` : row));
const SEVEN = (marked: number) => [
  ...[
    "  Gemini 3.8 Flash",
    "  Gemini 3.7 Flash",
    "  Gemini 3.6 Flash             (current)",
    "  Gemini 3.1 Pro",
    "  Claude Sonnet 4.6 (Thinking)",
    "  Claude Opus 4.6 (Thinking)",
    "  GPT-OSS 120B (Medium)",
  ].map((row, index) => (index === marked ? `>${row.slice(1)}` : row)),
];

/** The session once the dialog is answered. */
const DONE = [
  "> /model",
  "  ⎿  Model set to Gemini 3.8 Flash (High)",
  "",
  ">",
  "? for shortcuts                                          Gemini 3.8 Flash · high",
].join("\n");

const paint = async (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
};

const settle = async (ms: number) => {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, ms)); });
};

const rows = () => Array.from(document.querySelectorAll(".option-list strong"), (row) => row.textContent ?? "");

const pick = (label: string) => {
  const row = Array.from(document.querySelectorAll(".option-list button"))
    .find((button) => (button.textContent ?? "").includes(label));
  if (!row) throw new Error(`no sheet row for ${label}`);
  fireEvent.click(row);
};

const antigravityTab = {
  id: "tab",
  label: "agy",
  agent_label: "Google Antigravity",
  kind: "agent" as const,
  available: true,
  viewer_busy: false,
};

describe(`${BRAND.display} Mobile — Antigravity's model and effort sheet`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("walks to the model, then asks for the effort the dialog draws for it", async () => {
    render(<Terminal tab={antigravityTab} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await settle(400);
    expect(FakeWebSocket.sent.slice(-2)).toEqual(["/model", "\r"]);
    FakeWebSocket.sent = [];

    // Six rows of seven: the highlight is walked onto the one the dialog hides
    // and back, so the sheet can list every model. Arrows only.
    await paint(picker(SIX(2), MEDIUM));
    await settle(600);
    expect(FakeWebSocket.sent).toEqual([DOWN, DOWN, DOWN, DOWN]);
    FakeWebSocket.sent = [];
    await paint(picker(SEVEN(6)));
    await settle(600);
    expect(FakeWebSocket.sent).toEqual([UP, UP, UP, UP]);
    await paint(picker(SIX(2), MEDIUM));
    await settle(300);

    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Switch Model");
    expect(rows()).toEqual([
      "Gemini 3.8 Flash",
      "Gemini 3.7 Flash",
      "Gemini 3.6 Flash",
      "Gemini 3.1 Pro",
      "Claude Sonnet 4.6 (Thinking)",
      "Claude Opus 4.6 (Thinking)",
      "GPT-OSS 120B (Medium)",
    ]);
    expect(document.querySelector(".option-list button.current")?.textContent).toContain("Gemini 3.6 Flash");

    // The tap walks the highlight two rows up — and accepts nothing: the
    // effort belongs to the same Enter.
    FakeWebSocket.sent = [];
    pick("Gemini 3.8 Flash");
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([UP, UP]);

    // The dialog redraws with its slider on the model now highlighted, and the
    // sheet asks for the stop.
    FakeWebSocket.sent = [];
    await paint(picker(SIX(0), MEDIUM));
    await settle(300);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Effort for Gemini 3.8 Flash");
    expect(rows()).toEqual(["low", "medium", "high"]);
    expect(document.querySelector(".option-list button.current")?.textContent).toContain("medium");
    expect(FakeWebSocket.sent).toEqual([]);

    pick("high");
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([RIGHT, "\r"]);

    // The dialog is gone: the sheet steps aside, and the chip reads the model
    // and the effort the session now prints.
    await paint(DONE);
    await settle(900);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Gemini 3.8 Flash · high" })).toBeTruthy();
  });

  it("accepts a model whose dialog draws no effort as soon as the walk lands", async () => {
    render(<Terminal tab={antigravityTab} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await settle(400);
    FakeWebSocket.sent = [];
    // A model with no slider is highlighted, so the dialog has room for all
    // seven rows and hides none: nothing is walked to reveal.
    await paint(picker(SEVEN(4)));
    await settle(300);
    expect(FakeWebSocket.sent).toEqual([]);

    pick("Claude Opus 4.6 (Thinking)");
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([DOWN]);

    // The walk has landed and the dialog draws no slider: there is nothing
    // left to ask, so this is the Enter that applies it.
    FakeWebSocket.sent = [];
    await paint(picker(SEVEN(5)));
    await settle(300);
    expect(FakeWebSocket.sent).toEqual(["\r"]);
  });
});
