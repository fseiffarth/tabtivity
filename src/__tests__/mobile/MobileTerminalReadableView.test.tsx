import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTerminalSideChannels } from "../helpers/mobileTerminalHost";

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
    stubTerminalSideChannels();
    // These read the Focus view; the phone opens on Terminal until the
    // reader chose Focus for the agent, so the stored choice is preset.
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    localStorage.setItem(storageKey("mobile.view.shell"), "focus");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders the session text as it was emitted", async () => {
    render(<Terminal tab={{ id: "tab", label: "Shell", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
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
  });

  // An agent tab's Focus is its stored session, never the screen: its chat
  // layout and message menus are `MobileTerminalTranscript`'s.

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
