import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The phone's composer and its keyboard both take height from the output above
 * them. Neither moves a scroll offset, so a view that was showing the newest
 * output is left showing the same pixels with its bottom under the composer —
 * the live prompt and everything after it cut away. Both views have to follow
 * the shrink back down, and neither may do it to a reader who scrolled up.
 */

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
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() { this.readyState = 3; }
}

/** Every observer the screen installed, so a test can fire the one watching a
 * given element the way a phone's keyboard would. */
const observers: { target?: Element; run: () => void }[] = [];

class FakeResizeObserver {
  private entry: { target?: Element; run: () => void };
  constructor(callback: () => void) {
    this.entry = { run: callback };
    observers.push(this.entry);
  }
  observe(target: Element) { this.entry.target = target; }
  disconnect() {
    const index = observers.indexOf(this.entry);
    if (index >= 0) observers.splice(index, 1);
  }
}

/** More than one observer watches the terminal box — the wide-output hint has
 * its own — so a resize runs every callback registered for it, as a browser
 * would. */
const resizeOf = (target: Element | null) => {
  const watching = observers.filter((watch) => watch.target === target);
  if (watching.length === 0) throw new Error("nothing is observing that element");
  return () => watching.forEach((watch) => watch.run());
};

/** jsdom lays nothing out, so the box has the sizes a phone would report. */
const sizeBox = (box: HTMLElement, clientHeight: number, scrollHeight: number) => {
  Object.defineProperty(box, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => scrollHeight });
};

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND, storageKey } from "../../lib/brand";

const tab = { id: "tab", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };
/** Long enough for the resize debounce and the frame it defers the scroll by. */
const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });

describe(`${BRAND.display} Mobile: the output follows the composer`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    observers.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("keeps Terminal view on the newest rows when the composer takes the height", async () => {
    localStorage.setItem(storageKey("mobile.view.agent"), "terminal");
    render(<Terminal tab={tab} back={() => {}} />);
    await settle();

    const box = document.querySelector(".terminal") as HTMLElement;
    // A desktop-sized screen in a phone-sized box, panned to its last row.
    sizeBox(box, 340, 640);
    box.scrollTop = 300;
    fireEvent.scroll(box);

    // The keyboard opens: the same 640px of screen in 200px of box.
    sizeBox(box, 200, 640);
    act(() => resizeOf(box)());
    await settle();

    expect(box.scrollTop).toBe(640);
  });

  it("leaves Terminal view where a reader panned it", async () => {
    localStorage.setItem(storageKey("mobile.view.agent"), "terminal");
    render(<Terminal tab={tab} back={() => {}} />);
    await settle();

    const box = document.querySelector(".terminal") as HTMLElement;
    sizeBox(box, 340, 640);
    // Panned up into the screen — the rows below are not what is being read.
    box.scrollTop = 80;
    fireEvent.scroll(box);

    sizeBox(box, 200, 640);
    act(() => resizeOf(box)());
    await settle();

    expect(box.scrollTop).toBe(80);
  });

  it("keeps Focus on the newest turn when the composer takes the height", async () => {
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    render(<Terminal tab={tab} back={() => {}} />);
    await settle();

    const stream = document.querySelector(".readable-output") as HTMLElement;
    sizeBox(stream, 340, 640);
    (HTMLElement.prototype.scrollTo as ReturnType<typeof vi.fn>).mockClear();

    sizeBox(stream, 200, 640);
    act(() => resizeOf(stream)());
    await settle();

    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: 640 });
  });

  it("leaves Focus where a reader scrolled it", async () => {
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    render(<Terminal tab={tab} back={() => {}} />);
    await settle();

    const stream = document.querySelector(".readable-output") as HTMLElement;
    // Well clear of the bottom: the reader is reading back through the session.
    sizeBox(stream, 340, 640);
    stream.scrollTop = 100;
    fireEvent.scroll(stream);
    (HTMLElement.prototype.scrollTo as ReturnType<typeof vi.fn>).mockClear();

    sizeBox(stream, 200, 640);
    act(() => resizeOf(stream)());
    await settle();

    expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
  });
});
