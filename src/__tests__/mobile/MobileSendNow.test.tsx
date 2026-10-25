/**
 * The queued bubbles' Send now never stops the agent.
 *
 * Esc stops Claude's turn and Claude sends its queue at once — mid-thinking
 * too. But Claude takes a queued message into the running turn at its next
 * tool call, and an Esc that lands after that stops the very turn that was to
 * answer it (Claude Code 2.1.310, probed in tmux). The phone's copy of the
 * screen is too late to judge by, so it asks the desktop's bridge
 * (`send_now`), which reads the pane and presses only while the queue hint
 * shows; the phone waits until it does, and gives up once the turn takes the
 * prompt up or ends.
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
        type: "normal",
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          return value == null ? undefined : { isWrapped: false, translateToString: () => value };
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
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  bufferedAmount = 0;
  /** Input frames, decoded. */
  input: string[] = [];
  /** Control frames, parsed. */
  controls: { type: string; family?: string }[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(value: unknown) {
    if (ArrayBuffer.isView(value)) this.input.push(new TextDecoder().decode(value));
    else if (typeof value === "string") this.controls.push(JSON.parse(value));
  }
  event(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
  close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  output(text: string) {
    const bytes = new TextEncoder().encode(text);
    const data = new ArrayBuffer(bytes.length);
    new Uint8Array(data).set(bytes);
    this.onmessage?.({ data } as MessageEvent);
  }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND, storageKey } from "../../lib/brand";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };

const RULE = "─".repeat(60);
/** Claude's screen: the turn so far, its spinner row, and the input box. */
const frame = (spinner: string, box = "") => ["❯ fix it", "", spinner, RULE, `❯ ${box}`, RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
const QUEUE = "Press up to edit queued messages";
const THINKING = frame("✻ Pondering… (9s · ↓ 1.2k tokens · thinking with high effort)", QUEUE);
const WORKING = frame("✻ Pondering… (12s · ↓ 2.0k tokens)");
/** The turn took the queued prompt up at a tool call: the box is empty. */
const TAKEN_UP = ["❯ fix it", "  Ran 1 shell command", "❯ also the docs", "", "✽ Osmosing… (4s · ↓ 49 tokens)", RULE, "❯ ", RULE].join("\n");
const IDLE = frame("✻ Brewed for 2s · done 9:37");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const escapes = () => socket().input.filter((frame) => frame === "\u001b").length;
const asks = () => socket().controls.filter((frame) => frame.type === "send_now");

async function paint(text: string) {
  act(() => socket().output(text));
  await tick(300);
}

/** A prompt sent while Claude thinks: held by the desktop, queued on the phone. */
async function queuePrompt(sendNow = true) {
  render(<Terminal tab={TAB} back={() => {}} />);
  await tick(50);
  act(() => socket().event({ type: "features", visibility: true, send_now: sendNow }));
  await paint(WORKING);
  fireEvent.change(screen.getByRole("textbox", { name: "Message agent" }), { target: { value: "also the docs" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await tick(50);
}

describe(`${BRAND.display} Mobile Send now`, () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    terminalState.lines = [];
    localStorage.clear();
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
      if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript: { available: true, version: "1:1", truncated: false, entries: [{ kind: "prompt", text: "fix it", at: "2026-10-25T10:00:00Z" }] } }));
      if (url.endsWith("/held")) return Promise.resolve(jsonResponse(200, { id: "held-1" }));
      return Promise.resolve(jsonResponse(200, {}));
    }));
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("asks the desktop to send, mid-thinking too, and presses no Esc itself", async () => {
    await queuePrompt();
    await paint(THINKING);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await tick(50);
    expect(asks()).toEqual([{ type: "send_now", family: "claude" }]);
    expect(escapes()).toBe(0);
    expect(screen.getByText("Sends as soon as it can without stopping the agent")).toBeTruthy();
    act(() => socket().event({ type: "send_now", sent: true }));
    await tick(50);
    expect(screen.queryByText("Sends as soon as it can without stopping the agent")).toBeNull();
  });

  it("waits for the prompt to reach Claude's queue before it asks", async () => {
    await queuePrompt();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await tick(50);
    expect(asks()).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement).disabled).toBe(true);
    await paint(THINKING);
    expect(asks()).toHaveLength(1);
  });

  it("keeps waiting when the desktop found the queue already gone, and asks again", async () => {
    await queuePrompt();
    await paint(THINKING);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await tick(50);
    act(() => socket().event({ type: "send_now", sent: false }));
    await tick(50);
    expect(screen.getByText("Sends as soon as it can without stopping the agent")).toBeTruthy();
    await paint(THINKING.replace("9s", "10s"));
    expect(asks()).toHaveLength(2);
  });

  it("never asks while the turn has taken the prompt up, and stops waiting when it ends", async () => {
    await queuePrompt();
    await paint(TAKEN_UP);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await tick(50);
    await paint(TAKEN_UP.replace("4s", "9s"));
    expect(asks()).toHaveLength(0);
    await paint(IDLE);
    expect(asks()).toHaveLength(0);
    expect(escapes()).toBe(0);
  });

  it("offers no Send now where the desktop's bridge cannot check the queue", async () => {
    await queuePrompt(false);
    await paint(THINKING);
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel and edit" })).toBeTruthy();
  });
});
