/**
 * The model sheet against Cursor agent's `/model` dialog, whose rows carry no
 * numbers: before `cursorAgent` read it, the sheet found no list and stepped
 * aside after its wait. The dialog draws ten of its models at a time, so the
 * sheet walks the highlight half a window at a time to name the rest, then
 * back; a tap walks there and presses Enter, which applies the model in one
 * step. Rows as `cursor-agent` 2026.09.26 paints them.
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
    parser = { registerOscHandler() { return { dispose() {} }; } };
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

const MODELS = ["Auto", "Grok 4.7", "Grok 4.6", "Composer 2.5", "Claude Opus 5.5", "Claude Opus 5",
  "Claude Opus 4.8", "GPT-5.6 Sol", "GPT-5.5", "Claude Fable 5.1", "Claude Fable 5", "Grok 4.5"];

/** The dialog with rows `from`…`from + 5` of the twelve drawn and row
 * `marked` highlighted. */
const dialog = (from: number, marked: number) => [
  "  → Plan, search, build anything",
  "",
  " Available models                             Max mode: OFF",
  "",
  " Filter:",
  "",
  ...MODELS.slice(from - 1, from + 5).map((label, at) =>
    from + at === marked ? ` →  ${label.padEnd(25)}High (Tab to modify)` : `    ${label.padEnd(25)}High`),
  "",
  ` ${from}-${from + 5} of 12`,
  "",
  " Type to filter • Enter to select • Tab to edit",
].join("\n");

const DONE = ["  → Plan, search, build anything", "", "  Claude Opus 4.8 High", "  ~/project"].join("\n");

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

const cursorTab = {
  id: "tab",
  label: "cursor-agent",
  agent_label: "Cursor",
  kind: "agent" as const,
  available: true,
  viewer_busy: false,
};

describe(`${BRAND.display} Mobile — Cursor agent's model sheet`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists every model of the windowed dialog and applies a tapped one", async () => {
    render(<Terminal tab={cursorTab} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await settle(400);
    expect(FakeWebSocket.sent.slice(-2)).toEqual(["/model", "\r"]);
    FakeWebSocket.sent = [];

    // Opened on the current model, third of twelve, rows 1–6 drawn: the
    // highlight walks half a window past the first hidden row…
    await paint(dialog(1, 3));
    await settle(600);
    expect(FakeWebSocket.sent).toEqual(Array(6).fill(DOWN));
    FakeWebSocket.sent = [];
    await paint(dialog(4, 9));
    await settle(600);
    expect(FakeWebSocket.sent).toEqual(Array(3).fill(DOWN));
    FakeWebSocket.sent = [];
    // …and, once every row is known, back to where it was. Arrows only.
    await paint(dialog(7, 12));
    await settle(1200);
    expect(FakeWebSocket.sent).toEqual(Array(9).fill(UP));
    await paint(dialog(1, 3));
    await settle(300);

    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Available models");
    expect(rows()).toEqual(MODELS);
    expect(document.querySelector(".option-list button.current")?.textContent).toContain("Grok 4.6");

    FakeWebSocket.sent = [];
    pick("Claude Opus 4.8");
    await settle(600);
    expect(FakeWebSocket.sent).toEqual([DOWN, DOWN, DOWN, DOWN, "\r"]);

    // One step: the dialog is gone, and so is the sheet.
    await paint(DONE);
    await settle(1500);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
