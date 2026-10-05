import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({
  lines: [] as string[],
  options: undefined as Record<string, unknown> | undefined,
  textarea: undefined as HTMLTextAreaElement | undefined,
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
    constructor(options: Record<string, unknown>) {
      terminalState.options = options;
      terminalState.textarea = this.textarea;
    }
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

describe(`${BRAND.display} Mobile readable terminal view`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    terminalState.options = undefined;
    terminalState.textarea = undefined;
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    // These read the Focus view; the phone opens on Terminal until the
    // reader chose Focus for the agent, so the stored choice is preset.
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    localStorage.setItem(storageKey("mobile.view.shell"), "focus");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders the session text as it was emitted", async () => {
    render(<Terminal tab={{ id: "tab", label: "Codex", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const bytes = new TextEncoder().encode("╭────────╮\n│ Read src/App.tsx │\n╰────────╯\nI found the layout.\n1. Keep it\n2. Change it");
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);
    act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });

    // Frame decoration is gone, the text inside it is not, and a numbered list
    // stays text: the view never offers to type an answer it inferred.
    expect(screen.getByText("Read src/App.tsx")).toBeTruthy();
    expect(screen.getByText("I found the layout.")).toBeTruthy();
    expect(screen.getByText("1. Keep it")).toBeTruthy();
    expect(screen.queryByText("╭────────╮")).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep it" })).toBeNull();

    // An agent's chat acts on one message at a time, through the menu a
    // bubble opens; raw rows are no message, so a hold on one opens nothing.
    expect(screen.queryByRole("button", { name: "Copy the session text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
    fireEvent.contextMenu(screen.getByText("I found the layout."));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lays an agent tab out as a chat: the echoed prompt on the right, the answer on the left", async () => {
    render(<Terminal tab={{ id: "tab", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const bytes = new TextEncoder().encode("> fix the failing test\n\n⏺ Reading the test first.\n  It fails on the second assertion.\n\n> ");
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);
    act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });

    // The prompt is its own bubble, marker stripped; the answer is an agent
    // turn; the live input box at the bottom is not a turn at all.
    const prompt = screen.getByRole("group", { name: "Your prompt" });
    expect(prompt.className).toBe("readable-turn user");
    expect(prompt.textContent).toBe("fix the failing test");
    // The answer is its own turn, its ⏺ bullet and indent removed from what is shown.
    const answer = screen.getByText("Reading the test first.").closest(".readable-turn");
    expect(answer?.className).toBe("readable-turn agent answer");
    expect(answer?.textContent).toBe("Reading the test first.It fails on the second assertion.");
    expect(screen.getAllByRole("group", { name: "Your prompt" })).toHaveLength(1);
    expect(document.querySelector(".readable-lines")?.className).toBe("readable-lines chat");

    // A bubble carries no buttons; the menu it opens copies that one message,
    // as shown — the prompt's as readily as the answer's.
    expect(within(answer as HTMLElement).queryByRole("button")).toBeNull();
    fireEvent.contextMenu(answer as HTMLElement);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Message" })).getByRole("button", { name: "Copy message" }));
    await act(async () => {});
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Reading the test first.\nIt fails on the second assertion.");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Message" })).getByRole("button", { name: "Close" }));
    fireEvent.contextMenu(prompt);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Message" })).getByRole("button", { name: "Copy message" }));
    await act(async () => {});
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("fix the failing test");
  });

  it("opens a message's menu on a click-hold, and leaves a flick of the chat alone", async () => {
    render(<Terminal tab={{ id: "tab", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const bytes = new TextEncoder().encode("> fix the failing test\n\n⏺ Reading the test first.\n\n> ");
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);
    act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    const prompt = screen.getByRole("group", { name: "Your prompt" });

    // A finger that wanders is scrolling the chat, and the hold is off.
    fireEvent.pointerDown(prompt, { button: 0, pointerId: 1, clientX: 40, clientY: 200 });
    fireEvent.pointerMove(prompt, { button: 0, pointerId: 1, clientX: 44, clientY: 130 });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 500)); });
    expect(screen.queryByRole("dialog")).toBeNull();

    // A finger that stays opens the menu for that bubble.
    fireEvent.pointerDown(prompt, { button: 0, pointerId: 1, clientX: 40, clientY: 200 });
    fireEvent.pointerMove(prompt, { button: 0, pointerId: 1, clientX: 42, clientY: 203 });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 500)); });
    const sheet = within(screen.getByRole("dialog", { name: "Message" }));
    sheet.getByText("fix the failing test");
    sheet.getByRole("button", { name: "Copy message" });
  });

  it("paints a shell tab flat, with no turns", async () => {
    render(<Terminal tab={{ id: "tab", label: "Shell", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const bytes = new TextEncoder().encode("$ cat notes\n> not a prompt, a shell's here-doc continuation");
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);
    act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });

    expect(screen.queryByRole("group", { name: "Your prompt" })).toBeNull();
    expect(document.querySelector(".readable-turn")).toBeNull();
    expect(document.querySelector(".readable-lines")?.className).toBe("readable-lines");
    // A shell has no messages, so it keeps the one Copy for what is shown.
    fireEvent.click(screen.getByRole("button", { name: "Copy the session text" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("$ cat notes\n> not a prompt, a shell's here-doc continuation");
  });

  it("keeps xterm output-only and disables its hidden text entry", async () => {
    render(<Terminal tab={{ id: "tab", label: "Codex", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    expect(terminalState.options).toMatchObject({
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorInactiveStyle: "bar",
      cursorWidth: 2,
      theme: { background: "#000000", cursor: "#000000", cursorAccent: "#000000" },
    });
    expect(terminalState.textarea).toMatchObject({ disabled: true, tabIndex: -1 });
    expect(terminalState.textarea?.getAttribute("aria-hidden")).toBe("true");
  });
});
