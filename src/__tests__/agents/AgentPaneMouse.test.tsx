/**
 * The two mouse gestures an agent pane adds to xterm (TerminalView):
 *
 *  - **double-click pastes** the clipboard at the agent's prompt. The press must
 *    never reach xterm's selection service: a word-select there would be picked
 *    up by copy-on-select and would overwrite the clipboard *being pasted*.
 *  - **a plain drag still selects** while the TUI holds the mouse. Full-screen
 *    agents turn on mouse tracking, after which xterm reports every press to the
 *    program and selects nothing — "can't copy out of an agent tab". The press is
 *    handed to xterm wearing the force-selection modifier instead.
 *
 * Both are agent-pane only (`zoomable`), and the paste goes through `term.paste`
 * so a multi-line clipboard arrives as one bracketed paste rather than a burst of
 * Enters.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen, within } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

// TerminalView opens xterm only into a container that is actually laid out, and
// every jsdom element measures 0×0 with no offsetParent. Give them a box so the
// terminal really does `open()` into the pane — these gestures are all about the
// element xterm creates in there.
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get: () => document.body,
});
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

const { termSpy } = vi.hoisted(() => ({
  termSpy: {
    paste: vi.fn(),
    focus: vi.fn(),
    // The live mode the running program sets; flipped per test.
    mouseTrackingMode: "none" as "none" | "any",
    // What `getSelection()` answers, and the listener the pane registered for
    // selection changes — a "drag" is: set the text, fire the listener.
    selection: "",
    onSelection: null as null | (() => void),
    // Whatever xterm's own mousedown listener would have seen, recorded by a
    // stand-in listener the stub installs on the element it is "opened" into.
    seen: [] as MouseEvent[],
    // The key handler the pane attached — the Ctrl+Shift chords live there.
    keyHandler: null as null | ((e: KeyboardEvent) => boolean),
    // Buttonless moves that reached xterm's own element.
    moves: 0,
    // The buffer rows keyboard select reads, the terminal cursor's row, and the
    // last `term.select(column, row, length)` it drew.
    lines: [] as string[],
    cursorY: 0,
    selected: null as null | { column: number; row: number; length: number },
  },
}));

/** An xterm buffer row holding `text`, 80 columns wide. */
function fakeLine(text: string) {
  const row = text.padEnd(80);
  return {
    isWrapped: false,
    translateToString: (trim?: boolean, start = 0, end = 80) => (trim ? row.slice(start, end).trimEnd() : row.slice(start, end)),
    getCell: (x: number) => ({ getChars: () => (row[x] === " " ? "" : row[x]), getWidth: () => 1 }),
  };
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open(parent: HTMLElement) {
      // xterm builds its own element INSIDE the container and binds the
      // selection service to it — so mirror that shape, since the production
      // handler's whole job is to run before a listener living down there.
      const el = document.createElement("div");
      parent.appendChild(el);
      el.addEventListener("mousedown", (e) => termSpy.seen.push(e as MouseEvent));
      el.addEventListener("mousemove", () => termSpy.moves++);
    }
    write() {}
    onData() {}
    onResize() {}
    onBell() {}
    onTitleChange() {}
    onSelectionChange(cb: () => void) { termSpy.onSelection = cb; }
    get buffer() {
      return {
        active: {
          length: termSpy.lines.length,
          viewportY: 0,
          baseY: 0,
          cursorX: 0,
          cursorY: termSpy.cursorY,
          getLine: (y: number) => (termSpy.lines[y] === undefined ? undefined : fakeLine(termSpy.lines[y])),
        },
      };
    }
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) { termSpy.keyHandler = h; }
    getSelection() { return termSpy.selection; }
    hasSelection() { return termSpy.selection !== "" || termSpy.selected !== null; }
    clearSelection() { termSpy.selection = ""; termSpy.selected = null; }
    select(column: number, row: number, length: number) { termSpy.selected = { column, row, length }; }
    scrollToLine() {}
    getSelectionPosition() { return undefined; }
    focus() { termSpy.focus(); }
    paste(text: string) { termSpy.paste(text); }
    dispose() {}
    options = {};
    get modes() { return { mouseTrackingMode: termSpy.mouseTrackingMode }; }
    registerLinkProvider() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    parser = { registerOscHandler: () => ({ dispose() {} }), registerCsiHandler: () => ({ dispose() {} }) };
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
// The link handler and hover callbacks the pane hands the web-links addon.
const { linkSpy } = vi.hoisted(() => ({
  linkSpy: {
    activate: null as null | ((e: MouseEvent, url: string) => void),
    options: null as null | { hover?: (e: MouseEvent, url: string) => void; leave?: () => void },
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(activate: typeof linkSpy.activate, options: typeof linkSpy.options) {
      linkSpy.activate = activate;
      linkSpy.options = options;
    }
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: Object.assign(
    vi.fn((sel: (s: object) => unknown) => sel({ settings: { color_scheme: "dark" } })),
    { getState: () => ({ settings: { color_scheme: "dark" } }) },
  ),
  resolveTheme: (s: string) => s,
}));

import { TerminalView } from "../../components/terminal/TerminalView";
import { useProjectsStore } from "../../stores/projects";

/** Render an agent pane (`zoomable`) and hand back its container element. */
async function agentPane(id: string): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    container = render(
      <TerminalView id={id} cmd="claude" cwd="/p" kind="agent" zoomable visible focused />,
    ).container;
  });
  // Read the pane AFTER the act: React 18 flushes the render when the act block
  // closes, so inside it the container is still empty.
  return container.firstElementChild as HTMLElement;
}

/** Press inside the pane the way a real click lands: on the element xterm built
 *  inside the container, so the container's capture-phase handler runs first and
 *  the selection service's own listener runs last — the ordering the gestures
 *  depend on. */
function press(pane: HTMLElement, detail: number, init: MouseEventInit = {}): MouseEvent {
  const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail, ...init });
  act(() => {
    (pane.firstElementChild ?? pane).dispatchEvent(ev);
  });
  return ev;
}

describe("agent pane mouse gestures", () => {
  beforeEach(() => {
    termSpy.paste.mockClear();
    termSpy.focus.mockClear();
    termSpy.seen.length = 0;
    termSpy.mouseTrackingMode = "none";
    termSpy.selection = "";
    termSpy.onSelection = null;
    termSpy.moves = 0;
    termSpy.lines = [];
    termSpy.cursorY = 0;
    termSpy.selected = null;
    invoke.mockReset();
    invoke.mockImplementation(() => Promise.resolve(undefined));
    useProjectsStore.setState({ switchToast: null });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.resolve("from the clipboard"), writeText: () => Promise.resolve() },
    });
  });

  /** Drag `text` out of the pane: the selection settles, the button comes up. */
  async function drag(text: string) {
    termSpy.selection = text;
    await act(async () => {
      termSpy.onSelection?.();
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  }

  /** The texts the pane handed the backend clipboard. */
  const backendCopies = () => invoke.mock.calls.filter(([cmd]) => cmd === "copy_text_to_clipboard").map(([, a]) => (a as { text: string }).text);

  it("copies a drag on mouse-up and says so", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.resolve(""), writeText },
    });
    await agentPane("p:copy");
    await drag("one\ntwo\nthree");
    // Through the backend, which needs no user gesture: the webview's own
    // clipboard dropped some mouse-up copies ("copy works sometimes").
    expect(backendCopies()).toEqual(["one\ntwo\nthree"]);
    expect(writeText).not.toHaveBeenCalled();
    // Under an agent TUI the highlight is repainted away within milliseconds,
    // so the copy has to announce itself — in the same toast OSC 52 uses.
    expect(useProjectsStore.getState().switchToast).toBe("Copied 3 lines to the clipboard");

    await drag("a path");
    expect(useProjectsStore.getState().switchToast).toBe("Copied 6 characters to the clipboard");
  });

  it("falls back to the webview clipboard when the backend has none", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.resolve(""), writeText },
    });
    invoke.mockImplementation((cmd) => (cmd === "copy_text_to_clipboard" ? Promise.reject(new Error("no display")) : Promise.resolve(undefined)));
    await agentPane("p:fallback");
    await drag("kept");
    expect(writeText).toHaveBeenCalledWith("kept");
    expect(useProjectsStore.getState().switchToast).toBe("Copied 4 characters to the clipboard");
  });

  it("says so when no clipboard took the copy", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.resolve(""), writeText: () => Promise.reject(new Error("no focus")) },
    });
    invoke.mockImplementation((cmd) => (cmd === "copy_text_to_clipboard" ? Promise.reject(new Error("no display")) : Promise.resolve(undefined)));
    await agentPane("p:refused");
    await drag("lost");
    // Never silent: a user who pastes the old contents must know why.
    expect(useProjectsStore.getState().switchToast).toBe("Couldn't copy: the clipboard refused the text");
  });

  it("right-click on a selection copies it, clears it, and opens no menu", async () => {
    termSpy.mouseTrackingMode = "any";
    const pane = await agentPane("p:rclick");
    termSpy.selection = "picked";
    const ev = press(pane, 1, { button: 2 });
    await act(async () => {});
    expect(backendCopies()).toEqual(["picked"]);
    expect(termSpy.selection).toBe("");
    expect(ev.defaultPrevented).toBe(true);
    // Not reported to the program: Claude Code would paste on it.
    expect(termSpy.seen).toHaveLength(0);
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    act(() => {
      pane.firstElementChild!.dispatchEvent(menu);
    });
    expect(menu.defaultPrevented).toBe(true);
  });

  it("right-click with nothing selected still goes to the program", async () => {
    termSpy.mouseTrackingMode = "any";
    const pane = await agentPane("p:rclick-empty");
    press(pane, 1, { button: 2 });
    await act(async () => {});
    expect(backendCopies()).toEqual([]);
    expect(termSpy.seen).toHaveLength(1);
  });

  it("keeps hover moves from wiping a selection while the program tracks motion", async () => {
    termSpy.mouseTrackingMode = "any";
    const pane = await agentPane("p:hover");
    const move = () =>
      act(() => {
        pane.firstElementChild!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 0 }));
      });
    move();
    expect(termSpy.moves).toBe(1);
    // xterm would report this move as user input, which clears its selection.
    termSpy.selection = "held";
    move();
    expect(termSpy.moves).toBe(1);
  });

  describe("keyboard select (Ctrl+Shift+X)", () => {
    const key = (init: KeyboardEventInit) => {
      const ev = new KeyboardEvent("keydown", { cancelable: true, ...init });
      let handled: boolean | undefined;
      act(() => {
        handled = termSpy.keyHandler?.(ev);
      });
      return { ev, handled };
    };

    it("walks a cursor, selects whole lines and copies them on Enter", async () => {
      termSpy.lines = ["hello world", "second line"];
      termSpy.cursorY = 1;
      const pane = await agentPane("p:keysel");
      expect(key({ code: "KeyX", key: "X", ctrlKey: true, shiftKey: true }).handled).toBe(false);
      expect(pane.querySelector(".terminal-key-select")).not.toBeNull();
      // The cursor alone, on the terminal cursor's cell.
      expect(termSpy.selected).toEqual({ column: 0, row: 1, length: 1 });

      // Keys belong to the mode: none reaches the program.
      const v = key({ key: "V", shiftKey: true });
      expect(v.handled).toBe(false);
      expect(v.ev.defaultPrevented).toBe(true);
      key({ key: "ArrowUp" });
      expect(termSpy.selected).toEqual({ column: 0, row: 0, length: 160 });

      key({ key: "Enter" });
      await act(async () => {});
      expect(backendCopies()).toEqual(["hello world\nsecond line"]);
      expect(pane.querySelector(".terminal-key-select")).toBeNull();
      // Out of the mode, keys go to the program again.
      expect(key({ key: "a" }).handled).toBe(true);
    });

    it("Esc leaves without copying", async () => {
      termSpy.lines = ["text"];
      const pane = await agentPane("p:keysel-esc");
      key({ code: "KeyX", key: "X", ctrlKey: true, shiftKey: true });
      key({ key: "Escape" });
      await act(async () => {});
      expect(backendCopies()).toEqual([]);
      expect(termSpy.selected).toBeNull();
      expect(pane.querySelector(".terminal-key-select")).toBeNull();
    });

    it("a mouse press hands selecting back to the mouse", async () => {
      termSpy.lines = ["text"];
      const pane = await agentPane("p:keysel-click");
      key({ code: "KeyX", key: "X", ctrlKey: true, shiftKey: true });
      press(pane, 1);
      expect(pane.querySelector(".terminal-key-select")).toBeNull();
    });
  });

  it("double-click pastes the clipboard and never reaches xterm", async () => {
    const pane = await agentPane("p:dbl");
    // The opening single click is xterm's own business (it places the caret /
    // clears the selection) — only the second press is the gesture.
    press(pane, 1);
    expect(termSpy.paste).not.toHaveBeenCalled();

    const ev = press(pane, 2);
    await act(async () => {});

    expect(termSpy.paste).toHaveBeenCalledWith("from the clipboard");
    // Taken away from the selection service: no word-select, so copy-on-select
    // cannot overwrite the clipboard this very gesture is pasting.
    expect(termSpy.seen.some((e) => e.detail === 2)).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Ctrl+Shift+V pastes once: the webview's own paste is cancelled", async () => {
    await agentPane("p:chord");
    const ev = new KeyboardEvent("keydown", { code: "KeyV", key: "V", ctrlKey: true, shiftKey: true, cancelable: true });
    let handled: boolean | undefined;
    await act(async () => {
      handled = termSpy.keyHandler?.(ev);
    });
    expect(handled).toBe(false);
    expect(termSpy.paste).toHaveBeenCalledTimes(1);
    // Without this WebKitGTK runs its own paste command too, whose native
    // `paste` event xterm's textarea turns into a second copy of the text.
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does not paste when a modifier is held", async () => {
    const pane = await agentPane("p:mod");
    press(pane, 2, { shiftKey: true });
    await act(async () => {});
    expect(termSpy.paste).not.toHaveBeenCalled();
  });

  it("forces a selection on a plain press while the program holds the mouse", async () => {
    termSpy.mouseTrackingMode = "any";
    const pane = await agentPane("p:grab");
    const ev = press(pane, 1);
    // xterm reads the force-selection modifier off the event object itself.
    expect(ev.shiftKey).toBe(true);
    // …and still gets the press: it is the selection service that must act on it.
    expect(termSpy.seen).toHaveLength(1);
  });

  it("leaves the press alone when the program is not tracking the mouse", async () => {
    const pane = await agentPane("p:free");
    const ev = press(pane, 1);
    // Forcing here would flip xterm into its shift-EXTENDS-the-selection branch,
    // so every new drag would grow the last selection instead of starting one.
    expect(ev.shiftKey).toBe(false);
    expect(termSpy.seen).toHaveLength(1);
  });

  it("is an agent-pane gesture: a shell tab keeps its word-select", async () => {
    let container!: HTMLElement;
    await act(async () => {
      container = render(
        <TerminalView id="p:shell" cmd="bash" cwd="/p" kind="shell" visible focused />,
      ).container;
    });
    press(container.firstElementChild as HTMLElement, 2);
    await act(async () => {});
    expect(termSpy.paste).not.toHaveBeenCalled();
    expect(termSpy.seen.some((e) => e.detail === 2)).toBe(true);
  });
});

describe("terminal links", () => {
  const URL = "https://example.org/a";
  const click = (detail: number) => new MouseEvent("mouseup", { button: 0, detail });
  const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

  beforeEach(() => {
    invoke.mockClear();
    termSpy.paste.mockClear();
    termSpy.seen.length = 0;
    termSpy.mouseTrackingMode = "none";
    useProjectsStore.setState({ switchToast: null });
  });

  it("a click asks first, then opens the link in the real browser", async () => {
    vi.useFakeTimers();
    try {
      await agentPane("p:link-open");
      linkSpy.activate?.(click(1), URL);
      // Held back for the double-click window, then asked about — never opened
      // on the click alone.
      expect(calls("open_external_url")).toHaveLength(0);
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain(URL);
      expect(calls("open_external_url")).toHaveLength(0);
      // Confirmed → opened through the backend (the webview's own
      // `window.open` does nothing).
      await act(async () => {
        within(dialog).getByRole("button", { name: "Open link" }).click();
      });
      expect(calls("open_external_url")).toEqual([["open_external_url", { url: URL }]]);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("declining the question opens nothing", async () => {
    vi.useFakeTimers();
    try {
      await agentPane("p:link-decline");
      linkSpy.activate?.(click(1), URL);
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      await act(async () => {
        within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }).click();
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(calls("open_external_url")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a double-click copies the link instead: no open, no paste, no word-select", async () => {
    vi.useFakeTimers();
    try {
      const pane = await agentPane("p:link-copy");
      linkSpy.options?.hover?.(click(0), URL);
      press(pane, 1);
      linkSpy.activate?.(click(1), URL);
      const ev = press(pane, 2);
      linkSpy.activate?.(click(2), URL);
      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      expect(calls("copy_text_to_clipboard")).toEqual([["copy_text_to_clipboard", { text: URL }]]);
      expect(useProjectsStore.getState().switchToast).toBe("Link copied to the clipboard");
      expect(calls("open_external_url")).toHaveLength(0);
      expect(termSpy.paste).not.toHaveBeenCalled();
      expect(termSpy.seen.some((e) => e.detail === 2)).toBe(false);
      expect(ev.defaultPrevented).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("off a link, a double-click is still the pane's own gesture", async () => {
    const pane = await agentPane("p:link-off");
    linkSpy.options?.hover?.(click(0), URL);
    linkSpy.options?.leave?.();
    press(pane, 2);
    await act(async () => {});
    expect(calls("copy_text_to_clipboard")).toHaveLength(0);
    expect(termSpy.paste).toHaveBeenCalled();
  });
});
