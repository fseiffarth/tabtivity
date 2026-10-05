/**
 * A pocketed phone says so, and only to a desktop that asked.
 *
 * The desktop holds an agent's "finished" / "needs your answer" push back for
 * a tab a phone is watching. A hidden page keeps its terminal socket (sending
 * `detached` would cost a history replay on every app switch), so the socket
 * alone made a phone in a pocket look like a reader. The phone now reports its
 * page visibility over the socket — but only after the desktop's opening
 * `features` frame named the control, because a sidecar that predates it
 * closes the socket on an unknown control and never retries.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVisibilityReporter } from "../../../mobile-web/src/terminal/visibility";

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
    write(_value: Uint8Array | string, callback?: () => void) { callback?.(); }
    reset() {}
    resize() {}
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
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(value: unknown) { this.sent.push(typeof value === "string" ? value : "<bytes>"); }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  control(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  get visibility() { return this.sent.filter((frame) => frame.includes('"visibility"')); }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND } from "../../lib/brand";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

let pageState: DocumentVisibilityState = "visible";
function setPage(state: DocumentVisibilityState) {
  pageState = state;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

describe("the visibility reporter", () => {
  const link = () => ({ readyState: 1, sent: [] as string[], send(data: string) { this.sent.push(data); } });

  it("sends nothing until the desktop has announced the control", () => {
    let visible = true;
    const reporter = createVisibilityReporter(() => visible);
    visible = false;
    reporter.changed();
    visible = true;
    reporter.changed();
    // No link was ever named, so there was nowhere it could have gone.
    const announced = link();
    reporter.supported(announced);
    expect(announced.sent).toEqual([]);
  });

  it("reports each change once, and the state at open only when it is not the default", () => {
    let visible = true;
    const reporter = createVisibilityReporter(() => visible);
    const first = link();
    reporter.supported(first);
    // A viewer counts as visible until told otherwise.
    expect(first.sent).toEqual([]);
    visible = false;
    reporter.changed();
    reporter.changed();
    visible = true;
    reporter.changed();
    expect(first.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "visibility", visible: false },
      { type: "visibility", visible: true },
    ]);

    // A socket opened while the page is hidden — a reconnect from a pocket —
    // says so at once: the new viewer would otherwise count as watching.
    visible = false;
    const second = link();
    reporter.supported(second);
    expect(second.sent.map((frame) => JSON.parse(frame))).toEqual([{ type: "visibility", visible: false }]);
    expect(first.sent).toHaveLength(2);
  });

  it("never writes to a socket that is no longer open", () => {
    let visible = true;
    const reporter = createVisibilityReporter(() => visible);
    const closed = link();
    reporter.supported(closed);
    closed.readyState = 3;
    visible = false;
    reporter.changed();
    expect(closed.sent).toEqual([]);
  });
});

describe(`${BRAND.display} Mobile terminal visibility`, () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    localStorage.clear();
    pageState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => pageState);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
      return Promise.resolve(jsonResponse(200, {}));
    }));
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tells a desktop that announced the control when the page hides and returns, and keeps the socket", async () => {
    const view = render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    act(() => socket().control({ type: "replay" }));
    act(() => socket().control({ type: "features", visibility: true }));
    expect(socket().visibility).toEqual([]);

    setPage("hidden");
    expect(socket().visibility.map((frame) => JSON.parse(frame))).toEqual([{ type: "visibility", visible: false }]);
    // Hidden is not gone: no `detached`, and the socket is the same one.
    expect(socket().sent.some((frame) => frame.includes('"detached"'))).toBe(false);
    expect(socket().readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.instances).toHaveLength(1);

    setPage("visible");
    expect(socket().visibility.map((frame) => JSON.parse(frame))).toEqual([
      { type: "visibility", visible: false },
      { type: "visibility", visible: true },
    ]);
    view.unmount();
  });

  it("sends an older desktop nothing it would close the socket over", async () => {
    const view = render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    // The opening frames of a sidecar that predates `features`.
    act(() => socket().control({ type: "replay" }));
    act(() => socket().control({ type: "window", cols: 120, rows: 40 }));
    setPage("hidden");
    setPage("visible");
    expect(socket().visibility).toEqual([]);
    // And one that names features without this one is taken at its word.
    act(() => socket().control({ type: "features", visibility: false }));
    setPage("hidden");
    expect(socket().visibility).toEqual([]);
    view.unmount();
  });

  it("ignores an event type it does not know, so a newer desktop can add one", async () => {
    const view = render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    const sentBefore = socket().sent.length;
    act(() => socket().control({ type: "something_newer", value: 1 }));
    expect(socket().readyState).toBe(FakeWebSocket.OPEN);
    expect(socket().sent).toHaveLength(sentBefore);
    expect(FakeWebSocket.instances).toHaveLength(1);
    view.unmount();
  });
});
