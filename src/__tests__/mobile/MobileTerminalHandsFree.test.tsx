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

function result(transcript: string, isFinal: boolean): MobileSpeechRecognitionResultEvent {
  return reading([transcript, isFinal]);
}

/** One recognizer's whole result list, as Chrome hands it over each time. */
function reading(...items: [string, boolean][]): MobileSpeechRecognitionResultEvent {
  const results: Record<number, unknown> & { length: number } = { length: items.length };
  items.forEach(([transcript, isFinal], index) => { results[index] = { 0: { transcript }, isFinal, length: 1 }; });
  return { resultIndex: 0, results } as unknown as MobileSpeechRecognitionResultEvent;
}

const AGENT = { id: "opaque-agent", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };

describe(`${BRAND.display} Mobile hands-free`, () => {
  beforeEach(() => {
    localStorage.clear();
    chime.calls = 0;
    FakeRecognition.instances = [];
    FakeWebSocket.instances = [];
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: FakeRecognition });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubTerminalSideChannels();
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    localStorage.setItem(storageKey("mobile.focusHandsFree"), "1");
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    vi.unstubAllGlobals();
  });

  async function dictate() {
    render(<Terminal tab={AGENT} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    return FakeRecognition.instances[0];
  }
  const box = () => screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement;

  it("sends after the pause, a chime and the cancel window", async () => {
    const speech = await dictate();
    const abort = vi.spyOn(speech, "abort");
    act(() => speech.onresult?.(result("fix the login", true)));
    expect(box().value).toBe("fix the login");
    await act(async () => { vi.advanceTimersByTime(1_500); });
    expect(chime.calls).toBe(1);
    expect(screen.getByRole("button", { name: /Sending/ })).toBeTruthy();
    expect(abort).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1_500); });
    // Sent: the draft is empty and the mic closed for the answer.
    expect(box().value).toBe("");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Waiting for the answer/)).toBeTruthy();
  });

  it("holds no pause while words are still being heard", async () => {
    const speech = await dictate();
    act(() => speech.onresult?.(result("fix the login", true)));
    act(() => speech.onresult?.(result("and the", false)));
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(chime.calls).toBe(0);
    expect(box().value).toBe("fix the login");
  });

  it("keeps the draft on a spoken stop in the window, and drops the stop", async () => {
    const speech = await dictate();
    act(() => speech.onresult?.(result("fix the login", true)));
    await act(async () => { vi.advanceTimersByTime(1_500); });
    act(() => speech.onresult?.(reading(["fix the login", true], ["st", false])));
    await act(async () => { vi.advanceTimersByTime(3_000); });
    act(() => speech.onresult?.(reading(["fix the login", true], ["stop", true])));
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(box().value).toBe("fix the login");
    expect(screen.queryByRole("button", { name: /Sending/ })).toBeNull();
  });

  it("is cancelled by a tap on the line", async () => {
    const speech = await dictate();
    act(() => speech.onresult?.(result("fix the login", true)));
    await act(async () => { vi.advanceTimersByTime(1_500); });
    fireEvent.click(screen.getByRole("button", { name: /Sending/ }));
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(box().value).toBe("fix the login");
  });

  it("is off unless the Focus menu turned it on", async () => {
    localStorage.removeItem(storageKey("mobile.focusHandsFree"));
    const speech = await dictate();
    act(() => speech.onresult?.(result("fix the login", true)));
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(chime.calls).toBe(0);
    expect(box().value).toBe("fix the login");
  });
});
