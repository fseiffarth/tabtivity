import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTerminalSideChannels } from "../helpers/mobileTerminalHost";

// The harness is MobileTerminalReadableView.test.tsx's: xterm faked down to a
// buffer the test writes whole, and a WebSocket that opens on its own.
const terminalState = vi.hoisted(() => ({
  lines: [] as string[],
}));

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
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND, storageKey } from "../../lib/brand";

const STATUS_ROW = `~/${BRAND.slug}/projects/demo (develop) · Opus · 42% context`;

/** A Claude Code screen: a turn, then the input box with the statusline the
 * TUI draws under it, which Focus cuts with the frame. */
const CLAUDE_SCREEN = [
  "> fix the failing test",
  "",
  "⏺ Reading the test first.",
  "  It fails on the second assertion.",
  "",
  "╭──────────────────────────────────────╮",
  "│ >                                    │",
  "╰──────────────────────────────────────╯",
  STATUS_ROW,
].join("\n");

async function openAgent(screenText: string, { project, kind = "agent", back = () => {} }: { project?: string; kind?: "agent" | "shell"; back?: () => void } = {}) {
  render(<Terminal tab={{ id: "tab", label: kind === "agent" ? "Claude" : "Shell", kind, available: true, viewer_busy: false }} project={project} back={back} />);
  await act(async () => {});
  const bytes = new TextEncoder().encode(screenText);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
}

/** A one-finger drag from `from` to `to`, released at once (well inside the
 * swipe's time limit). Dispatched the way the implementation listens: touch
 * pointer events where the engine has them, touch events otherwise. */
function drag(target: Element, from: [number, number], to: [number, number]) {
  act(() => {
    if ("PointerEvent" in window) {
      const init = { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 7, isPrimary: true };
      target.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: from[0], clientY: from[1] }));
      target.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: to[0], clientY: to[1] }));
    } else {
      const touchEvent = (type: string, [clientX, clientY]: [number, number]) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        const touch = { identifier: 7, target, clientX, clientY, pageX: clientX, pageY: clientY, screenX: clientX, screenY: clientY };
        const list = type === "touchend" ? [] : [touch];
        Object.defineProperty(event, "touches", { value: list });
        Object.defineProperty(event, "targetTouches", { value: list });
        Object.defineProperty(event, "changedTouches", { value: [touch] });
        return event;
      };
      target.dispatchEvent(touchEvent("touchstart", from));
      target.dispatchEvent(touchEvent("touchend", to));
    }
  });
}

const output = () => screen.getByRole("region", { name: "Session output" });
/** The desktop's answers for project `p1`: its detail with the files switch
 * as given, and a one-folder listing. Everything else the screen asks for
 * is refused, which it rides out. */
function hostWith(files: boolean) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/v1/projects/p1") {
      return new Response(JSON.stringify({ project: { id: "p1", label: "Alpha", status: "active" }, desktop_available: true, agents: [], tabs: [], files }), { status: 200 });
    }
    if (url === "/api/v1/projects/p1/files") {
      return new Response(JSON.stringify({ entries: [{ token: "tok-src", name: "src", kind: "dir", size: 0, modified: 1_770_000_000 }], truncated: false }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  });
}

const drawer = () => screen.queryByRole("dialog", { name: "Files" });

describe(`${BRAND.display} Mobile Focus — the project's files drawer`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubTerminalSideChannels();
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    localStorage.setItem(storageKey("mobile.view.shell"), "focus");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("opens the files on a right→left swipe", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const back = vi.fn();
    await openAgent(CLAUDE_SCREEN, { project: "p1", back });

    drag(output(), [760, 300], [600, 300]);
    expect(back).not.toHaveBeenCalled();
    const files = drawer();
    expect(files).not.toBeNull();
    // With no menu rows of its own the drawer is the files library straight
    // away, its root titled by the project's name, read off its detail.
    expect(await within(files!).findByRole("button", { name: "Open the folder src" })).toBeTruthy();
    expect(within(files!).getByRole("button", { name: "Alpha — show the folders above" }).textContent).toBe("Alpha");

    // At the root, a right swipe from the left edge closes it.
    drag(files!, [100, 300], [300, 300]);
    expect(drawer()).toBeNull();
  });

  it("opens from the screen's right edge", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    await openAgent(CLAUDE_SCREEN, { project: "p1" });

    drag(output(), [window.innerWidth - 4, 300], [window.innerWidth - 200, 300]);
    expect(drawer()).not.toBeNull();
  });

  it("goes back on a left→right swipe from anywhere, its edge included", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const back = vi.fn();
    await openAgent(CLAUDE_SCREEN, { project: "p1", back });

    drag(output(), [100, 300], [260, 300]);
    expect(back).toHaveBeenCalledTimes(1);
    drag(output(), [4, 300], [200, 300]);
    expect(back).toHaveBeenCalledTimes(2);
    drag(output(), [600, 300], [760, 300]);
    expect(back).toHaveBeenCalledTimes(3);
    expect(document.querySelector(".focus-statusline")).toBeNull();
    expect(drawer()).toBeNull();
  });

  it("does not go back on a mostly vertical drag", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const back = vi.fn();
    await openAgent(CLAUDE_SCREEN, { project: "p1", back });
    // Far enough sideways to count, but less than half the vertical travel:
    // that is a scroll, not a swipe.
    drag(output(), [500, 100], [570, 300]);
    expect(back).not.toHaveBeenCalled();
  });

  it("leaves right→left alone while the switch is off", async () => {
    const fetch = hostWith(false);
    vi.stubGlobal("fetch", fetch);
    await openAgent(CLAUDE_SCREEN, { project: "p1" });

    drag(output(), [760, 300], [600, 300]);
    expect(drawer()).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/files"))).toBe(false);
  });

  it("swipes the same on a shell", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const back = vi.fn();
    await openAgent("$ ls\nREADME.md", { project: "p1", kind: "shell", back });

    drag(output(), [600, 300], [760, 300]);
    expect(back).toHaveBeenCalledTimes(1);
    drag(output(), [760, 300], [600, 300]);
    expect(drawer()).not.toBeNull();
  });

  it("opens from the header's ☰ in either view, which is there only while the switch is on", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    await openAgent(CLAUDE_SCREEN, { project: "p1" });

    fireEvent.click(screen.getByTitle("Output view"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Project menu" }));
    expect(drawer()).not.toBeNull();
  });

  it("has no ☰ while the switch is off", async () => {
    vi.stubGlobal("fetch", hostWith(false));
    await openAgent(CLAUDE_SCREEN, { project: "p1" });

    expect(screen.queryByRole("button", { name: "Project menu" })).toBeNull();
  });
});
