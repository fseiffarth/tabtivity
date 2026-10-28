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
// No Web Audio in jsdom; the send guard's chime is only counted.
vi.mock("../../lib/voice/chime", () => ({ playChime: () => {} }));

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() { FakeRecognition.instances.push(this); }
  start() { this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() { this.onend?.(); }
}

/** One settled recognizer result, as Chrome hands it over. */
function heard(transcript: string) {
  return { resultIndex: 0, results: { length: 1, 0: { 0: { transcript }, isFinal: true, length: 1 } } };
}

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
import { forgetReadings } from "../../../mobile-web/src/speechOutput";

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
  rate = 1;
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
    // The read positions live in module state, per tab, for the page's life.
    forgetReadings();
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
    fireEvent.click(sheet().getByRole("button", { name: /^Read aloud/ }));
    // The reading model: the prose, then the code block by its length.
    expect(spoken.map((utterance) => utterance.text)).toEqual(["Done: the ✕ empties the draft."]);
    act(() => { spoken[0].onend?.(); });
    expect(spoken.map((utterance) => utterance.text)).toEqual(["Done: the ✕ empties the draft.", "code block, one line"]);

    // The row that started the voice is the one that stops it.
    fireEvent.click(sheet().getByRole("button", { name: /^Stop reading/ }));
    expect(cancel).toHaveBeenCalled();
    sheet().getByRole("button", { name: /^Read aloud/ });
  });

  it("reads the reader's own prompt back, not only the agent's answers", async () => {
    const prompt = { kind: "prompt", text: "add a clear button to the composer", at: "2026-09-15T05:49:30.000Z" };
    vi.stubGlobal("fetch", sidecarFetch(() => ({ available: true, version: "1:1", truncated: false, entries: [prompt, FIRST] })));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const bubble = screen.getByTestId("session-transcript").querySelector(".readable-turn.user") as HTMLElement;
    fireEvent.contextMenu(bubble);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Message" })).getByRole("button", { name: /^Read aloud/ }));
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
    expect(spoken.map((utterance) => utterance.text)).toEqual(["", "Done: the ✕ empties the draft."]);
  });

  it("hands-free: reads the turn's answer at its end, then a spoken \"repeat\" moves the reading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      FakeRecognition.instances = [];
      Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: FakeRecognition });
      localStorage.setItem(storageKey("mobile.focusHandsFree"), "1");
      localStorage.setItem(storageKey("mobile.focusReadAloud"), "1");
      let entries = [FIRST];
      vi.stubGlobal("fetch", sidecarFetch(() => ({ available: true, version: `${entries.length}:1`, truncated: false, entries })));
      render(<Terminal tab={TAB} back={() => {}} />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
      await act(async () => {});
      act(() => FakeRecognition.instances[0].onresult?.(heard("fix the login")));
      // The pause, the chime and the cancel window: sent.
      await act(async () => { vi.advanceTimersByTime(3_000); });

      // The answer lands while the turn is awaited: held, not read entry by entry.
      entries = [FIRST, SECOND];
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await settle();
      expect(spoken.map((utterance) => utterance.text)).toEqual([]);
      await act(async () => { vi.advanceTimersByTime(1_600); });
      expect(spoken.map((utterance) => utterance.text)).toEqual(["Done: the ✕ empties the draft."]);
      act(() => { spoken[0].onend?.(); });
      act(() => { spoken[1].onend?.(); });
      expect(spoken.map((utterance) => utterance.text)).toEqual(["Done: the ✕ empties the draft.", "code block, one line"]);

      // Read: the mic opens again, and a whole "repeat" is a reading command.
      await act(async () => { vi.advanceTimersByTime(1_600); });
      expect(FakeRecognition.instances).toHaveLength(2);
      act(() => FakeRecognition.instances[1].onresult?.(heard("repeat")));
      expect(spoken.map((utterance) => utterance.text).slice(-1)).toEqual(["code block, one line"]);
      expect((screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement).value).toBe("");
    } finally {
      vi.useRealTimers();
      delete (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    }
  });

  // Before the hold, each answer was read as it arrived. A wait that ends
  // without its read (hands-free switched off, the link lost) must not leave
  // the answers it held unread: they were marked heard while it held them.
  it.each(["hands-free switched off", "the link lost"])("hands-free: a turn wait that ends early (%s) still reads the answers it held", async (how) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      FakeRecognition.instances = [];
      Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: FakeRecognition });
      localStorage.setItem(storageKey("mobile.focusHandsFree"), "1");
      localStorage.setItem(storageKey("mobile.focusReadAloud"), "1");
      let entries = [FIRST];
      vi.stubGlobal("fetch", sidecarFetch(() => ({ available: true, version: `${entries.length}:1`, truncated: false, entries })));
      render(<Terminal tab={TAB} back={() => {}} />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
      await act(async () => {});
      act(() => FakeRecognition.instances[0].onresult?.(heard("fix the login")));
      await act(async () => { vi.advanceTimersByTime(3_000); });

      entries = [FIRST, SECOND];
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await settle();
      expect(spoken.map((utterance) => utterance.text)).toEqual([]);

      if (how === "the link lost") {
        act(() => { FakeWebSocket.instances.forEach((socket) => socket.close()); });
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Chat" }));
        fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Hands-free/ }));
      }
      await settle();
      expect(spoken.map((utterance) => utterance.text).filter((text) => text !== "")).toEqual(["Done: the ✕ empties the draft."]);
    } finally {
      vi.useRealTimers();
      delete (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    }
  });

  it("hands-free: a send dictated over a held turn reads that turn's answers with the next", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      FakeRecognition.instances = [];
      Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: FakeRecognition });
      localStorage.setItem(storageKey("mobile.focusHandsFree"), "1");
      localStorage.setItem(storageKey("mobile.focusReadAloud"), "1");
      const third = { kind: "answer", text: "And the logout too.", at: "2026-09-15T05:50:10.000Z" };
      let entries = [FIRST];
      vi.stubGlobal("fetch", sidecarFetch(() => ({ available: true, version: `${entries.length}:1`, truncated: false, entries })));
      render(<Terminal tab={TAB} back={() => {}} />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
      await act(async () => {});
      act(() => FakeRecognition.instances[0].onresult?.(heard("fix the login")));
      await act(async () => { vi.advanceTimersByTime(3_000); });
      entries = [FIRST, SECOND];
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await settle();

      // The reader dictates again before the wait was over, and sends.
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
      await act(async () => {});
      act(() => FakeRecognition.instances[FakeRecognition.instances.length - 1].onresult?.(heard("and the logout")));
      await act(async () => { vi.advanceTimersByTime(3_000); });
      expect(spoken.map((utterance) => utterance.text)).toEqual([]);

      entries = [FIRST, SECOND, third];
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await settle();
      await act(async () => { vi.advanceTimersByTime(1_600); });
      act(() => { spoken[0].onend?.(); });
      act(() => { spoken[1].onend?.(); });
      expect(spoken.map((utterance) => utterance.text)).toEqual(["Done: the ✕ empties the draft.", "code block, one line", "And the logout too."]);
    } finally {
      vi.useRealTimers();
      delete (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    }
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
      fireEvent.click(sheet.getByRole("button", { name: /^Read aloud/ }));
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
