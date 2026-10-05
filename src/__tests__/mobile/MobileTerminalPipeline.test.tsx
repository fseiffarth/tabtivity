/**
 * The phone terminal's pipeline around the emulator: the replay boundary, the
 * reading view's tail while the Terminal view is up, the composer's Enter, and
 * a retryable close. Each of these is a Terminal.tsx behaviour the pure
 * parsers cannot see.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** xterm's trim emitter, as the lazy history rides it: `onTrim(listener)`. */
class FakeTrimEmitter {
  listeners: ((amount: number) => void)[] = [];
  onTrim = (listener: (amount: number) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((entry) => entry !== listener); } };
  };
}

const terminalState = vi.hoisted(() => ({
  lines: [] as string[],
  /** The row count the next emulator opens with — short on purpose, so the
   * history absorbs everything above rows + margin. */
  rows: 5,
  resized: [] as [number, number][],
  emitters: [] as { listeners: unknown[]; onTrim: unknown }[],
  /** Drops the oldest `amount` rows the way xterm's circular list does, telling
   * its trim listeners first. */
  trim: (_amount: number) => {},
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = terminalState.rows;
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
    _core = { _bufferService: { buffers: { normal: { lines: new FakeTrimEmitter() } } } };
    constructor() {
      const emitter = this._core._bufferService.buffers.normal.lines;
      terminalState.emitters.push(emitter);
      terminalState.trim = (amount) => {
        for (const listener of this._core._bufferService.buffers.normal.lines.listeners) listener(amount);
        terminalState.lines.splice(0, amount);
      };
    }
    loadAddon() {}
    open() {}
    write(value: Uint8Array | string, callback?: () => void) {
      const text = typeof value === "string" ? value : new TextDecoder().decode(value);
      terminalState.lines.push(...text.split("\n"));
      callback?.();
    }
    reset() {
      // What xterm does: a brand-new normal buffer, with its own emitter.
      terminalState.lines = [];
      const emitter = new FakeTrimEmitter();
      this._core = { _bufferService: { buffers: { normal: { lines: emitter } } } };
      terminalState.emitters.push(emitter);
    }
    resize(cols: number, rows: number) {
      terminalState.resized.push([cols, rows]);
      this.cols = cols;
      this.rows = rows;
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
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  sent: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) { this.sent.push(value); }
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND, storageKey } from "../../lib/brand";

const TAB = { id: "tab-3", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };

const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

/** Appends `rows` to the session and lets the throttled reading view rebuild. */
async function paint(...rows: string[]) {
  const bytes = new TextEncoder().encode(rows.join("\n"));
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => socket().onmessage?.({ data: payload } as MessageEvent));
  await settle(200);
}

const control = (frame: object) => act(() => socket().onmessage?.({ data: JSON.stringify(frame) } as MessageEvent));
const settle = (ms: number) => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, ms)); });
const composer = () => screen.getByLabelText("Message agent") as HTMLTextAreaElement;
const sentText = () => socket().sent.filter((value): value is string => typeof value === "string");
const sentBytes = () => socket().sent.filter((value) => typeof value !== "string");
const sentAgentInput = () => sentBytes().map((value) => new TextDecoder().decode(value as Uint8Array)).join("");

describe(`${BRAND.display} Mobile terminal pipeline`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    terminalState.rows = 5;
    terminalState.resized = [];
    terminalState.emitters = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    // These read the Focus view; the phone opens on Terminal until the
    // reader chose Focus for the agent, so the stored choice is preset.
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    localStorage.setItem(storageKey("mobile.view.shell"), "focus");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps following scrollback trims after a replay reset the emulator", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    expect(terminalState.emitters).toHaveLength(1);
    expect(terminalState.emitters[0].listeners).toHaveLength(1);

    // A reconnect: the server announces the replay, the phone resets xterm,
    // which builds a new buffer with a new trim emitter.
    control({ type: "replay" });
    expect(terminalState.emitters).toHaveLength(2);
    expect(terminalState.emitters[0].listeners).toHaveLength(0);
    expect(terminalState.emitters[1].listeners).toHaveLength(1);

    // 30 rows arrive; everything above the 13-row tail is absorbed. Then the
    // buffer trims its oldest 12 as 12 more come in — the log must shift with
    // it, or the rows between the old and new boundary vanish.
    await paint(...Array.from({ length: 30 }, (_, index) => `line ${index}`));
    act(() => terminalState.trim(12));
    await paint(...Array.from({ length: 12 }, (_, index) => `line ${30 + index}`));

    const shown = Array.from(document.querySelectorAll(".readable-line")).map((row) => row.textContent);
    expect(shown).toEqual(Array.from({ length: 42 }, (_, index) => `line ${index}`));
  });

  it("keeps the model and mode facts current while the Terminal view is up", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.queryByLabelText("Session output")).toBeNull();

    // The session switches to plan mode with the reading view unmounted. The
    // mode chip — and the walk that confirms a switch against it — read the
    // same status line, so it must still be rebuilt here.
    await paint("Done.", "> ", "⏸ plan mode on (shift+tab to cycle)");
    expect(screen.getByTitle("Choose the permission mode").textContent).toBe("plan");
  });

  it("lets Enter confirm an IME candidate instead of sending the draft", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    fireEvent.change(composer(), { target: { value: "日本語" } });

    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true });
    expect(sentBytes()).toHaveLength(0);
    fireEvent.keyDown(composer(), { key: "Enter", keyCode: 229 });
    expect(sentBytes()).toHaveLength(0);
    expect(composer().value).toBe("日本語");

    // The same key outside a composition sends.
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(sentBytes().length).toBeGreaterThan(0);
    expect(composer().value).toBe("");
  });

  it("starts a Codex conversation with /clear, not the /new that asks where to run", async () => {
    const codex = { ...TAB, id: "tab-codex", label: "Codex", agent_label: "Codex" };
    render(<Terminal tab={codex} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await settle(350);
    expect(sentAgentInput()).toContain("/clear\r");
    expect(sentAgentInput()).not.toContain("/new");
  });

  it("drops a retryable close's explanation once the session is back", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    const first = socket();

    control({ type: "closing", reason: "idle_timeout", retry: true });
    expect(screen.getByText(/released after a period without contact/)).toBeTruthy();

    // The socket closes and the reconnect (first attempt: one second) opens a
    // new one; the explanation belongs to the outage, not to the session.
    act(() => first.onclose?.());
    await settle(1_100);
    expect(socket()).not.toBe(first);
    expect(sentText().some((frame) => frame.includes('"ready"'))).toBe(true);
    expect(screen.queryByText(/released after a period without contact/)).toBeNull();
  });

  it("clamps a fitted size to what the desktop accepts before sending it", async () => {
    // No `window` frame from the desktop yet: the fitted size is what goes
    // out, and a landscape phone with its keyboard up fits fewer rows than the
    // protocol's floor — which the desktop answers with a close that never
    // retries.
    terminalState.rows = 3;
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    expect(terminalState.resized).toEqual([[80, 5]]);
    const frames = sentText().map((frame) => JSON.parse(frame) as { type: string; cols?: number; rows?: number });
    expect(frames.find((frame) => frame.type === "resize")).toEqual({ type: "resize", cols: 80, rows: 5 });

    // The desktop's window geometry, once it arrives, is adopted as it is.
    control({ type: "window", cols: 180, rows: 48 });
    expect(terminalState.resized[terminalState.resized.length - 1]).toEqual([180, 48]);
  });
});
