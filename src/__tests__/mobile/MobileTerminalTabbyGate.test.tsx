import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTerminalSideChannels } from "../helpers/mobileTerminalHost";
import type {
  MobileSpeechRecognition,
  MobileSpeechRecognitionErrorEvent,
  MobileSpeechRecognitionResultEvent,
} from "../../../mobile-web/src/voiceInput";

// The pane's live bracketed-paste state, which the screen reads off xterm.
const terminalModes = vi.hoisted(() => ({ bracketedPasteMode: false }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = terminalModes;
    loadAddon() {}
    open() {}
    write() {}
    onData() { return { dispose() {} }; }
    scrollLines() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
// No Web Audio in jsdom; the send guard's chime is only counted.
const chime = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../lib/voice/chime", () => ({ playChime: () => { chime.calls += 1; } }));

class FakeRecognition implements MobileSpeechRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: MobileSpeechRecognitionResultEvent) => void) | null = null;
  onerror: ((event: MobileSpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() { FakeRecognition.instances.push(this); }
  start() { this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() { this.onend?.(); }
}

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
  close() { this.readyState = 3; this.onclose?.(); }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND, storageKey } from "../../lib/brand";

/** One recognizer's whole result list, as Chrome hands it over each time. */
function reading(...items: [string, boolean][]): MobileSpeechRecognitionResultEvent {
  const results: Record<number, unknown> & { length: number } = { length: items.length };
  items.forEach(([transcript, isFinal], index) => { results[index] = { 0: { transcript }, isFinal, length: 1 }; });
  return { resultIndex: 0, results } as unknown as MobileSpeechRecognitionResultEvent;
}

const AGENT = { id: "opaque-agent", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };
const T = BRAND.assistant;

describe(`${BRAND.display} Mobile Tabby gate`, () => {
  beforeEach(() => {
    localStorage.clear();
    chime.calls = 0;
    FakeRecognition.instances = [];
    FakeWebSocket.instances = [];
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: FakeRecognition });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubTerminalSideChannels();
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    vi.unstubAllGlobals();
  });

  async function dictate(handsFree = true) {
    if (handsFree) localStorage.setItem(storageKey("mobile.focusHandsFree"), "1");
    render(<Terminal tab={AGENT} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    return FakeRecognition.instances[0];
  }
  const box = () => screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement;
  const sentText = () => FakeWebSocket.instances[0].sent
    .filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
    .map((value) => new TextDecoder().decode(value as Uint8Array)).join("");
  /** The recognizer finalizes the same utterance again as it grows. */
  const say = async (speech: FakeRecognition, ...items: [string, boolean][]) => {
    act(() => speech.onresult?.(reading(...items)));
    await act(async () => {});
  };
  const cue = `Sent — say ${T} for your next prompt`;

  /** A first prompt sent with "go on": the gate is on and the cue shows. */
  async function sentOnce() {
    const speech = await dictate();
    await say(speech, ["fix the login go on", true]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    return speech;
  }

  it("chimes and says to go on after a spoken send, and keeps the mic open", async () => {
    const speech = await dictate();
    expect(chime.calls).toBe(0);
    await say(speech, ["fix the login", true], ["go on", true]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(sentText()).toContain("fix the login");
    expect(chime.calls).toBe(1);
    expect(screen.getByText(cue)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeTruthy();
    expect(box().value).toBe("");
  });

  it("drops talk that does not start with the start word, until the next send", async () => {
    const speech = await sentOnce();
    await say(speech, ["fix the login go on", true], ["so I was thinking about lunch", true]);
    expect(box().value).toBe("");
    expect(screen.getByText(cue)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(box().value).toBe("");
  });

  it("drafts the words after the start word, and a spoken send then sends them", async () => {
    const speech = await sentOnce();
    const base: [string, boolean][] = [["fix the login go on", true], ["so I was thinking", true]];
    await say(speech, ...base, [`${T}, and add a test`, true]);
    expect(box().value).toBe("and add a test");
    expect(screen.getByText("Heard: and add a test")).toBeTruthy();
    const before = sentText();
    await say(speech, ...base, [`${T}, and add a test, go on`, true]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(sentText().slice(before.length)).toContain("and add a test");
    expect(sentText().slice(before.length)).not.toContain(T);
    expect(box().value).toBe("");
    expect(chime.calls).toBe(2);
  });

  it("edits the draft on a spoken edit in hands-free, holding the words until they settle", async () => {
    const speech = await dictate();
    await say(speech, ["fix the login", true]);
    await say(speech, ["fix the login", true], ["and the logout", true]);
    expect(box().value).toBe("fix the login and the logout");
    await say(speech, ["fix the login", true], ["and the logout", true], [`${T} scratch`, true]);
    expect(box().value).toBe("fix the login and the logout");
    await say(speech, ["fix the login", true], ["and the logout", true], [`${T} scratch that`, true]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(box().value).toBe("fix the login");
    expect(sentText()).toBe("");
  });

  it("judges an utterance once: a growing one is kept, the start word taken off", async () => {
    const speech = await sentOnce();
    const base: [string, boolean][] = [["fix the login go on", true]];
    await say(speech, ...base, [T, true]);
    await say(speech, ...base, [`${T} and`, true]);
    await say(speech, ...base, [`${T} and add`, true]);
    await say(speech, ...base, [`${T} and add a test`, true]);
    expect(box().value).toBe("and add a test");
  });

  it("does not rescue a dropped utterance because it later says the start word", async () => {
    const speech = await sentOnce();
    const base: [string, boolean][] = [["fix the login go on", true]];
    await say(speech, ...base, ["so I said", true]);
    await say(speech, ...base, [`so I said ${T} add a test`, true]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(box().value).toBe("");
  });

  it("says it is listening after the start word alone, and the next utterance starts the draft", async () => {
    const speech = await sentOnce();
    const base: [string, boolean][] = [["fix the login go on", true]];
    chime.calls = 0;
    await say(speech, ...base, [T, true]);
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(chime.calls).toBe(1);
    expect(screen.getByText("Listening for your prompt")).toBeTruthy();
    expect(box().value).toBe("");
    await say(speech, ...base, [T, true], ["add a test", true]);
    expect(box().value).toBe("add a test");
    // The window was taken: back to the cue for the next send.
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.queryByText("Listening for your prompt")).toBeNull();
  });

  it("closes the wait for a prompt after about ten seconds", async () => {
    const speech = await sentOnce();
    const base: [string, boolean][] = [["fix the login go on", true]];
    await say(speech, ...base, [T, true]);
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(screen.getByText("Listening for your prompt")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    expect(screen.queryByText("Listening for your prompt")).toBeNull();
    await say(speech, ...base, [T, true], ["too late", true]);
    expect(box().value).toBe("");
  });

  it("keeps listening for the rest of a prompt without the start word once it has begun", async () => {
    const speech = await sentOnce();
    const base: [string, boolean][] = [["fix the login go on", true]];
    await say(speech, ...base, [`${T} fix the parser`, true]);
    await say(speech, ...base, [`${T} fix the parser`, true], ["and the tests", true]);
    expect(box().value).toBe("fix the parser and the tests");
  });

  it("is turned off by a tap on the mic", async () => {
    const speech = await sentOnce();
    expect(screen.getByText(cue)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(screen.queryByText(cue)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    const next = FakeRecognition.instances[FakeRecognition.instances.length - 1];
    expect(next).not.toBe(speech);
    await say(next, ["no start word needed now", true]);
    expect(box().value).toBe("no start word needed now");
  });

  it("is turned off by typing in the box", async () => {
    const speech = await sentOnce();
    fireEvent.change(box(), { target: { value: "typed" } });
    expect(screen.queryByText(cue)).toBeNull();
    await say(speech, ["fix the login go on", true], ["and then spoken", true]);
    expect(box().value).toBe("typed and then spoken");
  });

  it("starts nothing with hands-free off: the start word is dictation, \"go on\" has no cue", async () => {
    const speech = await dictate(false);
    await say(speech, [`${T} navigate`, true]);
    expect(box().value).toBe(`${T} navigate`);
    await say(speech, [`${T} navigate`, true], ["fix the login go on", true]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(sentText()).toContain("fix the login");
    expect(chime.calls).toBe(0);
    expect(screen.queryByText(cue)).toBeNull();
    // Mic still open, nothing gated: talk lands as it always did.
    await say(speech, [`${T} navigate`, true], ["fix the login go on", true], ["plain talk", true]);
    expect(box().value).toBe("plain talk");
  });

  it("holds a possible command back from the draft, and types it as heard once it settles unclaimed", async () => {
    const speech = await dictate();
    await say(speech, [T, true]);
    expect(box().value).toBe("");
    await say(speech, [`${T} nav`, true]);
    expect(box().value).toBe("");
    expect(screen.getByText(`Heard: ${T} nav`)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    // Not the navigate word after all: it is dictation.
    expect(box().value).toBe(`${T} nav`);
  });

  it("opens navigation mode, not the draft, when the held words settle as the navigate phrase", async () => {
    // The mode reads the project list when it opens.
    const sideChannels = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (
      typeof input === "string" && input.startsWith("/api/v1/projects")
        ? Promise.resolve(new Response(JSON.stringify({ projects: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))
        : sideChannels(input, init)
    ));
    const speech = await dictate();
    await say(speech, [`${T} navigate`, true]);
    expect(box().value).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(box().value).toBe("");
    expect(screen.getByText(/^Navigation: say a project/)).toBeTruthy();
  });

  it("types the held start word with the next word when it is dictation", async () => {
    const speech = await dictate();
    await say(speech, [T, true]);
    await say(speech, [`${T}, fix`, true]);
    expect(box().value).toBe(`${T}, fix`);
  });

  it("does not open the pause while an utterance is held back", async () => {
    const speech = await dictate();
    await say(speech, ["fix the login", true]);
    await say(speech, ["fix the login", true], [`${T} navigate`, true]);
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(chime.calls).toBe(0);
  });
});
