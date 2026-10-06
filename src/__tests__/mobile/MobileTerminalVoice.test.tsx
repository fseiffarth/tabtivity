import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function finalResult(transcript: string): MobileSpeechRecognitionResultEvent {
  return {
    resultIndex: 0,
    results: { 0: { 0: { transcript }, isFinal: true, length: 1 }, length: 1 },
  } as unknown as MobileSpeechRecognitionResultEvent;
}

/** Chromium's `userAgentData`, the mark of a browser whose on-device
 * recognizer is asked at all (`onDeviceSpeechAsked`). */
function asChromium() {
  Object.defineProperty(window.navigator, "userAgentData", { configurable: true, value: {} });
}

/** The composer's status line — not the Focus chat's "starting" row, which a
 * blank agent tab shows over the empty screen. */
function composerStatus(): HTMLElement {
  const rows = screen.getAllByRole("status").filter((row) => row.dataset.testid !== "session-starting");
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe(`${BRAND.display} Mobile terminal dictation`, () => {
  beforeEach(() => {
    // The composer's draft is kept on the phone now (`drafts.ts`), and the
    // unmount that flushes it runs in Testing Library's own cleanup — after this
    // file's `afterEach` — so the slate is wiped here rather than there.
    localStorage.clear();
    FakeRecognition.instances = [];
    FakeWebSocket.instances = [];
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: FakeRecognition });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    // These read the Focus view; the phone opens on Terminal until the
    // reader chose Focus for the agent, so the stored choice is preset.
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    localStorage.setItem(storageKey("mobile.view.shell"), "focus");
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    terminalModes.bracketedPasteMode = false;
    vi.useRealTimers();
    delete (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    delete (window.navigator as Navigator & { userAgentData?: unknown }).userAgentData;
    vi.unstubAllGlobals();
  });

  it("offers phone dictation for any agent and stages final text without submitting", async () => {
    render(<Terminal tab={{ id: "opaque-tab", label: "Codex", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    const speech = FakeRecognition.instances[0];
    expect(speech).toMatchObject({ continuous: true, interimResults: true, maxAlternatives: 1 });

    act(() => speech.onresult?.(finalResult("fix the mobile voice input")));

    const binary = FakeWebSocket.instances[0].sent.filter((value): value is ArrayBufferView => ArrayBuffer.isView(value));
    expect(binary).toHaveLength(0);
    expect((screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement).value).toBe("fix the mobile voice input");
    expect(composerStatus().textContent).toContain("Heard: fix the mobile voice input");
  });

  it("listens in the phone's language, or in the one the Reader's picker chose", async () => {
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-GB" });
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    expect(FakeRecognition.instances[0].lang).toBe("en-GB");

    // The picker writes one choice for both directions of voice.
    localStorage.setItem(storageKey("mobile.speechLang"), "de");
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    expect(FakeRecognition.instances[1].lang).toBe("de-DE");
  });

  it("stops listening once the dictated words are sent", async () => {
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    const speech = FakeRecognition.instances[0];
    const abort = vi.spyOn(speech, "abort");
    act(() => speech.onresult?.(finalResult("fix the login")));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(abort).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Heard:/)).toBeNull();
    expect(screen.queryByText(/Listening/)).toBeNull();
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    // The aborted recognizer's handlers are gone: nothing more reaches the draft.
    expect(speech.onresult).toBeNull();
    expect((screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("sends the dictated words when \"go on\" or \"los\" is said last", async () => {
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    const speech = FakeRecognition.instances[0];
    const abort = vi.spyOn(speech, "abort");
    act(() => speech.onresult?.(finalResult("fix the login")));
    expect(FakeWebSocket.instances[0].sent.filter((value) => ArrayBuffer.isView(value))).toHaveLength(0);
    act(() => speech.onresult?.({
      resultIndex: 1,
      results: {
        0: { 0: { transcript: "fix the login" }, isFinal: true, length: 1 },
        1: { 0: { transcript: "los" }, isFinal: true, length: 1 },
        length: 2,
      },
    } as unknown as MobileSpeechRecognitionResultEvent));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    const sent = FakeWebSocket.instances[0].sent
      .filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
      .map((value) => new TextDecoder().decode(value as Uint8Array));
    expect(sent.join("")).toContain("fix the login");
    expect(sent.join("")).not.toContain("los");
    expect(sent[sent.length - 1]).toBe("\r");
    expect(abort).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("forgets the dictated words once they are cleared, while it keeps listening", async () => {
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    const speech = FakeRecognition.instances[0];
    act(() => speech.onresult?.(finalResult("fix the login")));
    fireEvent.click(screen.getByRole("button", { name: "Clear the message" }));

    expect(screen.queryByText(/Heard:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeTruthy();
    act(() => speech.onresult?.(finalResult("and add a test")));
    expect((screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement).value).toBe("and add a test");
    expect(composerStatus().textContent).toBe("Heard: and add a test");
  });

  it("keeps listening through the pause that ends the phone's recognizer", async () => {
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    const speech = FakeRecognition.instances[0];
    act(() => speech.onresult?.(finalResult("fix the login")));

    // Chrome on Android ends a `continuous` recognizer after a breath.
    act(() => speech.onend?.());
    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    // The new result list starts empty; its words join the draft, not replace it.
    act(() => speech.onresult?.(finalResult("and add a test")));
    expect((screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement).value).toBe("fix the login and add a test");
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
  });

  it("dictates on the device where it can, and with the phone's service once the Reader menu says so", async () => {
    const available = vi.fn(() => Promise.resolve("available" as const));
    class LocalRecognition extends FakeRecognition {
      static available = available;
      processLocally?: boolean;
    }
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: LocalRecognition });
    asChromium();
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    expect((FakeRecognition.instances[0] as LocalRecognition).processLocally).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /phone's speech service/ }));
    expect(localStorage.getItem(storageKey("mobile.voiceRemote"))).toBe("1");
    available.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    // The on-device model is not even asked about: no download is started for it.
    expect(available).not.toHaveBeenCalled();
    expect((FakeRecognition.instances[1] as LocalRecognition).processLocally).toBe(false);
  });

  it("dictates with Safari's speech service without asking its on-device check, which hung on an iPad", async () => {
    const available = vi.fn(() => new Promise<"available">(() => {}));
    class SafariRecognition extends FakeRecognition {
      static available = available;
      processLocally?: boolean;
    }
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: SafariRecognition });
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    expect(available).not.toHaveBeenCalled();
    expect((FakeRecognition.instances[0] as SafariRecognition).processLocally).toBe(false);
  });

  it("takes back an on-device check that does not finish when Dictate is tapped again", async () => {
    class DownloadingRecognition extends FakeRecognition {
      static available = vi.fn(() => Promise.resolve("downloadable" as const));
      static install = vi.fn(() => new Promise<boolean>(() => {}));
    }
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: DownloadingRecognition });
    asChromium();
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    const preparing = screen.getByRole("button", { name: "Preparing dictation" });
    expect(preparing.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Checking for on-device dictation…")).toBeTruthy();
    fireEvent.click(preparing);
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    expect(screen.queryByText("Checking for on-device dictation…")).toBeNull();
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("offers no on-device choice where the phone has no on-device model", async () => {
    // Android's Chrome: the API is there, the model is not.
    class RemoteOnlyRecognition extends FakeRecognition {
      static available = vi.fn(() => Promise.resolve("unavailable" as const));
      processLocally?: boolean;
    }
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: RemoteOnlyRecognition });
    asChromium();
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    const choice = screen.getByRole("menuitemcheckbox", { name: /phone's speech service/ });
    expect(choice.getAttribute("aria-disabled")).toBe("true");
    expect(choice.textContent).toContain("always dictates with the phone's speech service");
    fireEvent.click(choice);
    expect(localStorage.getItem(storageKey("mobile.voiceRemote"))).toBeNull();
  });

  it("does not stage cleared dictation again when the phone re-reads its results", async () => {
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    const speech = FakeRecognition.instances[0];
    const composer = screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement;
    // Chrome on Android: every event carries the whole result list from index 0.
    const reading = (...items: [string, boolean][]) => ({
      resultIndex: 0,
      results: Object.assign(
        Object.fromEntries(items.map(([transcript, isFinal], index) => [index, { 0: { transcript }, isFinal, length: 1 }])),
        { length: items.length },
      ),
    }) as unknown as MobileSpeechRecognitionResultEvent;

    act(() => speech.onresult?.(reading(["fix the login", true])));
    fireEvent.click(screen.getByRole("button", { name: "Clear the message" }));
    act(() => speech.onresult?.(reading(["fix the login", true], ["and add a test", false])));
    expect(composerStatus().textContent).toBe("Heard: and add a test");
    act(() => speech.onresult?.(reading(["fix the login", true], ["and add a test", true])));
    expect(composer.value).toBe("and add a test");

    // And a final that repeats everything before it as its head.
    act(() => speech.onresult?.(reading(["fix the login", true], ["and add a test", true], ["Fix the login and add a test please", true])));
    expect(composer.value).toBe("and add a test please");
  });

  it("leaves dictation behind when React reuses the screen for another tab", async () => {
    const { rerender } = render(<Terminal tab={{ id: "agent-a", label: "Claude A", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    act(() => FakeRecognition.instances[0].onresult?.(finalResult("words meant for tab a")));

    rerender(<Terminal tab={{ id: "agent-b", label: "Claude B", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    // The recognizer is detached before it is aborted, so its own onend never
    // ran: tab b showed tab a's transcript and a mic stuck on "listening".
    expect(screen.queryByText(/words meant for tab a/)).toBeNull();
    const dictate = screen.getByRole("button", { name: "Dictate" }) as HTMLButtonElement;
    expect(dictate.getAttribute("aria-pressed")).toBe("false");
    expect(dictate.disabled).toBe(false);
  });

  it("does not add dictation to ordinary shell tabs", async () => {
    render(<Terminal tab={{ id: "opaque-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Dictate/ })).toBeNull();
  });

  it("submits shell commands from Focus view and keeps visible sent feedback", async () => {
    render(<Terminal tab={{ id: "opaque-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const composer = screen.getByRole("textbox", { name: "Shell command" });
    fireEvent.change(composer, { target: { value: "npm test" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    const binary = FakeWebSocket.instances[0].sent.filter((value): value is ArrayBufferView => ArrayBuffer.isView(value));
    expect(new TextDecoder().decode(binary[binary.length - 1] as Uint8Array)).toBe("npm test\r");
    expect((composer as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText("Sent")).toBeTruthy();
  });

  it("keeps the native shell composer available beside the read-only terminal", async () => {
    // No choice stored for shells: the tab opens on the terminal itself.
    localStorage.removeItem(storageKey("mobile.view.shell"));
    render(<Terminal tab={{ id: "opaque-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const focus = screen.getByRole("button", { name: "Reader" });
    const terminal = screen.getByRole("button", { name: "Terminal" });
    expect(terminal.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Shell command" })).toBeTruthy();
    fireEvent.click(focus);
    expect(focus.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(storageKey("mobile.view.shell"))).toBe("focus");
    expect(screen.getByRole("textbox", { name: "Shell command" })).toBeTruthy();
  });

  it("replaces the active agent prompt from the native composer in Terminal view", async () => {
    render(<Terminal tab={{ id: "opaque-agent", label: "Codex", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    const send = screen.getByRole("button", { name: "Send" });
    const dictate = screen.getByRole("button", { name: "Dictate" });
    expect(dictate.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((send as HTMLButtonElement).disabled).toBe(true);

    const composer = screen.getByRole("textbox", { name: "Message agent" });
    fireEvent.change(composer, { target: { value: "fix the mobile terminal" } });
    expect((send as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(send);
    // A control byte and the text may not share one write: the agent TUI reads
    // the chunk as a single keypress and drops the rest, which delivered a bare
    // Enter and no message at all. Line reset, text and submit go out spaced.
    const decode = () => FakeWebSocket.instances[0].sent
      .filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
      .map((value) => new TextDecoder().decode(value as Uint8Array));
    expect(decode()).toEqual(["\u0001\u000b"]);
    expect((composer as HTMLTextAreaElement).value).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(decode()).toEqual(["\u0001\u000b", "fix the mobile terminal", "\r"]);
  });

  it("sends a multi-line agent draft as one message with soft newlines", async () => {
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const composer = screen.getByRole("textbox", { name: "Message agent" });
    fireEvent.change(composer, { target: { value: "first line\nsecond line" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    const sent = FakeWebSocket.instances[0].sent
      .filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
      .map((value) => new TextDecoder().decode(value as Uint8Array));
    // Ctrl-J between the lines, a single carriage return at the end: the agent
    // receives one two-line message instead of submitting each line.
    expect(sent).toEqual(["\u0001\u000b", "first line", "\n", "second line", "\r"]);
  });

  it("sends a bracketed paste when the agent's pane has the mode on", async () => {
    terminalModes.bracketedPasteMode = true;
    render(<Terminal tab={{ id: "opaque-agent", label: "Codex", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const composer = screen.getByRole("textbox", { name: "Message agent" });
    fireEvent.change(composer, { target: { value: "first line\nsecond line" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    const sent = FakeWebSocket.instances[0].sent
      .filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
      .map((value) => new TextDecoder().decode(value as Uint8Array));
    // The closing marker ends the message, so the carriage return still submits
    // even when the link delivers both writes to the TUI in one chunk.
    expect(sent).toEqual([
      "\u0001\u000b",
      "\u001b[200~first line\nsecond line\u001b[201~",
      "\r",
    ]);
  });

  it("clears Focus state when React reuses the screen for another tab", async () => {
    const { rerender } = render(<Terminal tab={{ id: "shell-a", label: "Shell A", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    const composer = screen.getByRole("textbox", { name: "Shell command" });
    fireEvent.change(composer, { target: { value: "secret for tab a" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.change(composer, { target: { value: "unsent draft" } });

    rerender(<Terminal tab={{ id: "shell-b", label: "Shell B", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    expect(screen.queryByText("secret for tab a")).toBeNull();
    expect((screen.getByRole("textbox", { name: "Shell command" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Reader" }).getAttribute("aria-pressed")).toBe("true");
  });
});
