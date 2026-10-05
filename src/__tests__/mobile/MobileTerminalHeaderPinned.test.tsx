/**
 * The terminal's header is the only way out of a session, and the document
 * underneath it must never be able to scroll it away.
 *
 * A session is usually opened from a project screen scrolled well down its tab
 * cards, so the tap that opens it happens with a page offset — and nothing in a
 * single-page app resets that on the way into the next screen. The terminal is
 * sized to the visual viewport while `body` keeps a 100dvh floor, so the
 * leftover offset had a real overflow to sit in: the header scrolled off the
 * top, and the terminal body hands vertical drags to the history scroller, so
 * there was no gesture left that brought it back.
 *
 * An agent tab reaches the same overflow by a route of its own — the ＋ sheet
 * and the @ chip focus the composer for the reader, and the browser answers a
 * focus by scrolling it into view — which is why it went the same way only
 * sometimes. Both are cured by the same thing: while a session is open there is
 * no overflow to scroll.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = { active: { length: 0, getLine() { return undefined; } } };
    loadAddon() {}
    open() {}
    write(_: Uint8Array, callback?: () => void) { callback?.(); }
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
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import type { TabRow } from "../../../mobile-web/src/api";
import { BRAND } from "../../lib/brand";

const shell: TabRow = { id: "tab-3", label: "Shell", kind: "shell", available: true, viewer_busy: false };
const agent: TabRow = { id: "tab-4", label: "Claude", kind: "agent", available: true, viewer_busy: false };

describe(`${BRAND.display} Mobile — the terminal header stays on screen`, () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    document.body.classList.remove("terminal-open");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([["shell", shell], ["agent", agent]] as const)(
    "takes the document's scroll away while a %s session is open, and gives it back",
    async (_kind, row) => {
      const { unmount } = render(<Terminal tab={row} back={() => {}} />);
      await act(async () => {});
      expect(document.body.classList.contains("terminal-open")).toBe(true);
      unmount();
      expect(document.body.classList.contains("terminal-open")).toBe(false);
    },
  );

  it("holds the lock while an agent's composer is focused from the ＋ sheet", async () => {
    render(<Terminal tab={agent} back={() => {}} />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add to the message" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /A project file/ })); });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message agent" }));
    expect(document.body.classList.contains("terminal-open")).toBe(true);
  });

  it("pulls a page scrolled down the project's cards back to the top on the way in", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 480 });
    vi.stubGlobal("scrollTo", scrollTo);
    render(<Terminal tab={shell} back={() => {}} />);
    await act(async () => {});
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });
});
