/**
 * The phone's model sheet before the session has drawn its `/model` picker:
 * it lists the rows the same CLI build's picker drew last time
 * (`GET …/model-rows`), holds a tap on one of them, answers it in the live
 * picker by its label once that is drawn, and keeps the live list
 * (`POST …/model-rows`) once it has settled, when it differs.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTerminalSideChannels } from "../helpers/mobileTerminalHost";

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
const UP = `${ESC}[A`;


/** Claude Code's `/model` picker, its highlight on the current model. */
const PICKER = [
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new sessions.",
  "",
  "     1.  Default (recommended)  Sonnet 5.5 \u00b7 Efficient for routine tasks",
  "     2.  Fable 5.1              For your toughest challenges",
  "     3.  Opus 5.5               For complex work and everyday tasks",
  "   \u276f 4.  Sonnet 5.5 \u2714           Most efficient for simpler tasks",
  "",
  "   Enter to set as default \u00b7 s to use this session only \u00b7 Esc to cancel",
].join("\n");

/** What an earlier opening of the same build kept: Opus listed second. */
const REMEMBERED = {
  title: "Select model",
  rows: [
    { label: "Default (recommended)", description: "Sonnet 5.5 \u00b7 Efficient for routine tasks", number: 1 },
    { label: "Opus 5.5", description: "For complex work and everyday tasks", number: 2 },
    { label: "Sonnet 5.5", description: "Most efficient for simpler tasks", number: 3 },
  ],
};

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

const claudeTab = {
  id: "tab",
  label: "claude",
  agent_label: "Claude",
  kind: "agent" as const,
  available: true,
  viewer_busy: false,
};

/** The remembered-rows route answered with `REMEMBERED`; what the phone keeps
 * is recorded; every other side request meets an unreachable desktop. */
let kept: unknown[] = [];
function stubModelRows() {
  stubTerminalSideChannels();
  const offline = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/v1/tabs/tab/model-rows") {
      if ((init?.method ?? "GET") === "POST") {
        kept.push(JSON.parse(String(init?.body)));
        return Promise.resolve(new Response(JSON.stringify({ kept: true }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(REMEMBERED), { status: 200 }));
    }
    return offline(input, init);
  });
}

describe(`${BRAND.display} Mobile — the model sheet before the session draws its picker`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    kept = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubModelRows();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists the rows this build drew last time, and answers a tapped one in the live picker by its label", async () => {
    render(<Terminal tab={claudeTab} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await settle(400);
    expect(FakeWebSocket.sent.slice(-2)).toEqual(["/model", "\r"]);
    FakeWebSocket.sent = [];

    // Nothing drawn yet, and the sheet already lists the remembered rows.
    expect(rows()).toEqual(["Default (recommended)", "Opus 5.5", "Sonnet 5.5"]);
    expect(screen.getByText(/Last list from this CLI version/u)).toBeTruthy();
    pick("Opus 5.5");
    await settle(300);
    expect(FakeWebSocket.sent).toEqual([]);

    // The live picker lists Opus third: the walk goes there, from row 4.
    await paint(PICKER);
    await settle(600);
    expect(FakeWebSocket.sent).toEqual([UP, "\r"]);
    // Answered as soon as it was drawn: a list that never settled is not kept.
    await settle(700);
    expect(kept).toEqual([]);
  });

  it("keeps the live list once it has settled, when it differs from the remembered one", async () => {
    render(<Terminal tab={claudeTab} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await settle(400);
    await paint(PICKER);
    expect(rows()).toEqual(["Default (recommended)", "Fable 5.1", "Opus 5.5", "Sonnet 5.5 \u2714"]);
    await settle(700);
    expect(kept).toEqual([{
      title: "Select model",
      rows: [
        { label: "Default (recommended)", description: "Sonnet 5.5 \u00b7 Efficient for routine tasks", number: 1 },
        { label: "Fable 5.1", description: "For your toughest challenges", number: 2 },
        { label: "Opus 5.5", description: "For complex work and everyday tasks", number: 3 },
        { label: "Sonnet 5.5", description: "Most efficient for simpler tasks", number: 4 },
      ],
    }]);
  });
});
