import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[], alternate: false }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        get type() { return terminalState.alternate ? "alternate" : "normal"; },
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
      // A reconnect notice arrives as a string; session bytes as an array.
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
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(value: unknown) { this.sent.push(typeof value === "string" ? value : "<bytes>"); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND, storageKey } from "../../lib/brand";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

/** A fetch answering the outbox (empty) and the transcript with whatever
 * `transcript` holds at the time of the call. */
function sidecarFetch(transcript: () => unknown) {
  return vi.fn((url: string) => {
    if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
    if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript: transcript() }));
    return Promise.resolve(jsonResponse(404, { error: "not_found" }));
  });
}

const FIRST = { kind: "answer", text: "Looking at the composer.", at: "2026-09-15T05:49:40.000Z" };
const SECOND = { kind: "answer", text: "Done: the **✕** empties the draft.\n\n```ts\nclear();\n```", at: "2026-09-15T05:49:50.000Z" };

class FakeUtterance {
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

describe(`${BRAND.display} Mobile Reader reads answers aloud`, () => {
  let spoken: FakeUtterance[];
  let cancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    terminalState.lines = [];
    terminalState.alternate = false;
    FakeWebSocket.instances = [];
    localStorage.clear();
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    spoken = [];
    cancel = vi.fn();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", { speak: (utterance: FakeUtterance) => { spoken.push(utterance); }, cancel });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("speaks one message from its menu, and stops on the same row", async () => {
    vi.stubGlobal("fetch", sidecarFetch(() => ({ available: true, version: "1:1", truncated: false, entries: [FIRST, SECOND] })));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const answers = screen.getByTestId("session-transcript").querySelectorAll(".readable-turn.agent.answer");
    fireEvent.contextMenu(answers[1] as HTMLElement);
    const sheet = () => within(screen.getByRole("dialog", { name: "Message" }));
    fireEvent.click(sheet().getByRole("button", { name: "Read aloud" }));
    expect(spoken.map((utterance) => utterance.text)).toEqual(["Done: the ✕ empties the draft. code block."]);

    // The row that started the voice is the one that stops it.
    fireEvent.click(sheet().getByRole("button", { name: "Stop reading" }));
    expect(cancel).toHaveBeenCalled();
    sheet().getByRole("button", { name: "Read aloud" });
  });

  it("reads the reader's own prompt back, not only the agent's answers", async () => {
    const prompt = { kind: "prompt", text: "add a clear button to the composer", at: "2026-09-15T05:49:30.000Z" };
    vi.stubGlobal("fetch", sidecarFetch(() => ({ available: true, version: "1:1", truncated: false, entries: [prompt, FIRST] })));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const bubble = screen.getByTestId("session-transcript").querySelector(".readable-turn.user") as HTMLElement;
    fireEvent.contextMenu(bubble);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Message" })).getByRole("button", { name: "Read aloud" }));
    expect(spoken.map((utterance) => utterance.text)).toEqual(["add a clear button to the composer"]);
  });

  it("with read-aloud on, speaks the answer that arrives and none that were already there", async () => {
    let entries = [FIRST];
    vi.stubGlobal("fetch", sidecarFetch(() => ({ available: true, version: `${entries.length}:1`, truncated: false, entries })));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Read answers aloud/ }));
    expect(localStorage.getItem(storageKey("mobile.focusReadAloud"))).toBe("1");
    // Only the silent utterance that lets the page speak later.
    expect(spoken.map((utterance) => utterance.text)).toEqual([""]);

    entries = [FIRST, SECOND];
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(spoken.map((utterance) => utterance.text)).toEqual(["", "Done: the ✕ empties the draft. code block."]);
  });

  it("speaks in the phone's language until the picker chooses another", async () => {
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-GB" });
    vi.stubGlobal("fetch", sidecarFetch(() => ({ available: true, version: "1:1", truncated: false, entries: [FIRST] })));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const answer = screen.getByTestId("session-transcript").querySelector(".readable-turn.agent.answer") as HTMLElement;
    const read = () => {
      fireEvent.contextMenu(answer);
      const sheet = within(screen.getByRole("dialog", { name: "Message" }));
      fireEvent.click(sheet.getByRole("button", { name: "Read aloud" }));
      fireEvent.click(sheet.getByRole("button", { name: "Close" }));
    };
    read();
    expect(spoken.map((utterance) => utterance.lang)).toEqual(["en-GB"]);

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Voice language/ }));
    // What is still being said was said in the old voice; the picker cuts it.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deutsch" }));
    expect(cancel).toHaveBeenCalled();
    expect(localStorage.getItem(storageKey("mobile.speechLang"))).toBe("de");

    read();
    expect(spoken.map((utterance) => utterance.lang)).toEqual(["en-GB", "de-DE"]);
  });
});
