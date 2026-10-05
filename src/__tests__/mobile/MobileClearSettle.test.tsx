/**
 * A prompt sent right after `/clear` — or any slash command — waits for it to
 * settle.
 *
 * The agent does not read stdin while it clears (it redraws; Claude runs its
 * session hooks), so a prompt typed then reached it in one read, text and CR
 * together — a paste, whose CR is a new line: the prompt sat in the agent's
 * composer, unsent. The phone now holds the next message until the pane's
 * output has been quiet for a moment, and types it then, gaps intact.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = { active: { type: "normal", length: 0, getLine: () => undefined } };
    loadAddon() {}
    open() {}
    write(_value: Uint8Array | string, callback?: () => void) { callback?.(); }
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
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(value: unknown) {
    if (ArrayBuffer.isView(value)) this.input.push(new TextDecoder().decode(value));
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

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const typed = () => socket().input.join("");

function send(text: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Message agent" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe(`${BRAND.display} Mobile prompt after a clear`, () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    localStorage.clear();
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
      if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript: { available: true, version: "1:1", truncated: false, entries: [] } }));
      return Promise.resolve(jsonResponse(200, {}));
    }));
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("types a prompt only once the clear's redraw has gone quiet, as separate writes", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await tick(400);
    expect(typed()).toContain("/clear\r");

    const before = socket().input.length;
    send("also the tests");
    // The agent is still redrawing: nothing goes in yet.
    for (let step = 0; step < 8; step += 1) {
      socket().output("\u001b[2J redraw");
      await tick(250);
    }
    expect(socket().input.length).toBe(before);

    // Quiet: the prompt goes, text and submit as writes of their own.
    await tick(1_500);
    const writes = socket().input.slice(before);
    expect(writes).toContain("also the tests");
    expect(writes[writes.length - 1]).toBe("\r");
  });

  it("gives up waiting on a pane that never goes quiet", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    send("/clear");
    await tick(400);
    const before = socket().input.length;
    send("still there?");
    for (let step = 0; step < 30; step += 1) {
      socket().output("spinner");
      await tick(250);
    }
    expect(socket().input.slice(before)).toContain("still there?");
  });

  it("keeps two prompts sent while it waits, in order", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    send("/clear");
    await tick(400);
    send("first");
    send("second");
    await tick(4_000);
    const text = typed();
    expect(text.indexOf("first\r")).toBeGreaterThan(text.indexOf("/clear\r"));
    expect(text.indexOf("second\r")).toBeGreaterThan(text.indexOf("first\r"));
  });

  it("waits after any slash command, not only /clear", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    send("/compact");
    await tick(400);
    const before = socket().input.length;
    send("go on");
    socket().output("Compacting…");
    await tick(500);
    expect(socket().input.length).toBe(before);
    await tick(2_000);
    expect(socket().input.slice(before)).toContain("go on");
  });

  it("lets a queued command hold the prompt behind it in turn", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    send("/clear");
    await tick(400);
    send("/model opus");
    send("after the swap");
    // The clear settles (1.2 s), the model command goes; the prompt waits
    // for that one to settle as well.
    await tick(1_600);
    expect(typed()).toContain("/model opus\r");
    expect(typed()).not.toContain("after the swap");
    await tick(2_000);
    const text = typed();
    expect(text.indexOf("after the swap\r")).toBeGreaterThan(text.indexOf("/model opus\r"));
  });

  it("types at once when no command went before", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    send("hello");
    await tick(400);
    expect(typed()).toContain("hello\r");
  });
});
