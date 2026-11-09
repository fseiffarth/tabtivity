/**
 * Keyboard steering inside a tab (`useTerminalSteering`): a digit answers the
 * question the Focus chat lists, the type key puts the caret in the composer
 * and hands the keyboard over, and the arrows scroll the chat. The engine is
 * mounted in a small harness beside the real `Terminal` (there is no `App`
 * here); xterm and the socket are faked as in `MobileFocusQuestion`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[], type: "normal" as "normal" | "alternate" }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        get type() { return terminalState.type; },
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          if (value == null) return undefined;
          if (!value.startsWith("\u0001")) return { isWrapped: false, translateToString: () => value };
          const text = value.slice(1);
          const cell = (char: string) => ({
            getChars: () => char,
            getWidth: () => 1,
            isBold: () => 1,
            isItalic: () => 0,
            isDim: () => 0,
            isUnderline: () => 0,
            isStrikethrough: () => 0,
            isInverse: () => 0,
            isInvisible: () => 0,
            isFgDefault: () => false,
            isBgDefault: () => false,
            isFgPalette: () => false,
            isBgPalette: () => false,
            isFgRGB: () => true,
            isBgRGB: () => true,
            getFgColor: () => 0x24292f,
            getBgColor: () => 0xf4f4f4,
          });
          return {
            isWrapped: false,
            length: text.length,
            translateToString: () => text,
            getCell: (x: number) => (x < text.length ? cell(text[x]) : undefined),
          };
        },
      },
    };
    loadAddon() {}
    open() {}
    write(value: Uint8Array | string, callback?: () => void) {
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
  static instances: FakeWebSocket[] = [];
  static sent: string[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  /** Keystrokes go out as bytes; the control frames (resize, attach) are JSON
   * strings and are not what this test reads. */
  send(data: unknown) {
    if (ArrayBuffer.isView(data)) FakeWebSocket.sent.push(new TextDecoder().decode(data as Uint8Array));
  }
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { optionForDigit, UNNUMBERED, type SelectOption, type SelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";
import { getSteering, type Place } from "../../../mobile-web/src/steering/steeringState";
import { usePhoneSteering } from "../../../mobile-web/src/steering/usePhoneSteering";
import { keysSent } from "../helpers/mobileTerminalHost";
import { press as fire, resetSteering, stubLayout, type KeyMods } from "../helpers/mobileSteering";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;

const TAB = { id: "tab-q", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };
const STORED = { available: true, version: "1200:1", truncated: false, entries: [{ kind: "answer", text: "I'll add the clear button." }] };

const PERMISSION = [
  "Edit file", "  src/lib/i18n.ts", "",
  "Do you want to make this edit to i18n.ts?",
  "❯ 1. Yes",
  "  2. Yes, allow all edits during this session",
  "  3. No, and tell Claude what to do differently",
  "", "  esc to cancel",
].join("\n");

const AGENT_QUESTION = [
  "● My fix is ready and verified, but pushing now would also push four other commits.", "",
  "☐ Push scope", "",
  "How should I land my fix?", "",
  "❯ 1. Fix only (Recommended)",
  "     Put my fix directly on the pushed main.",
  "  2. Push everything",
  "     Push develop with all four commits.",
  "  3. Type something.",
  "  4. Chat about this", "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const sidecarFetch = () => vi.fn((url: string) => {
  if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
  if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript: STORED }));
  return Promise.resolve(jsonResponse(404, { error: "not_found" }));
});
const paint = async (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
};
const settle = async (ms: number) => { await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, ms)); }); };

/** A key press the way the browser delivers it: inside act, so the state it sets renders. */
function press(target: EventTarget | null, key: string, mods: KeyMods = {}): boolean {
  let prevented = false;
  act(() => { prevented = fire(target, key, mods); });
  return prevented;
}

const PLACE: Place = { kind: "terminal", project: "p", tab: TAB };
function Harness() {
  usePhoneSteering({
    enabled: true, base: "inside", sectionLabel: null, place: PLACE,
    openTab: () => {}, openSection: () => {}, restore: () => {}, findProject: () => {},
  });
  return null;
}
const composer = () => document.querySelector<HTMLTextAreaElement>(".composer-field textarea")!;

async function mount() {
  render(<><Terminal tab={TAB} back={() => {}} /><Harness /></>);
  await act(async () => {});
  screen.getByTestId("session-transcript");
}

describe("optionForDigit", () => {
  const option = (index: number, number: number): SelectOption => ({ index, number, label: `row ${index}` });
  const prompt = (options: SelectOption[]): SelectPrompt => ({ options, current: 0, start: 0, question: 0, context: 0 });

  it("takes the option printed with the number", () => {
    const p = prompt([option(0, 3), option(1, 4), option(2, 5)]);
    expect(optionForDigit(p, 4)?.index).toBe(1);
    expect(optionForDigit(p, 1)).toBeNull();
  });

  it("takes the nth row when nothing is numbered", () => {
    const p = prompt([option(0, UNNUMBERED), option(1, UNNUMBERED)]);
    expect(optionForDigit(p, 2)?.index).toBe(1);
    expect(optionForDigit(p, 3)).toBeNull();
  });

  it("does not reach an unnumbered action row by position when others are numbered", () => {
    const p = prompt([option(0, 1), option(1, 2), option(2, UNNUMBERED)]);
    expect(optionForDigit(p, 3)).toBeNull();
  });
});

describe("Mobile steering inside a tab", () => {
  let layout: ReturnType<typeof stubLayout>;
  beforeEach(() => {
    terminalState.lines = [];
    terminalState.type = "normal";
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", sidecarFetch());
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    layout = stubLayout();
  });
  afterEach(() => {
    cleanup();
    resetSteering();
    layout.restore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("answers the question with a digit and says so when there is no such option", async () => {
    await mount();
    expect(getSteering().hasInside).toBe(true);
    expect(getSteering().question).toBe(false);
    await paint(PERMISSION);
    await waitFor(() => expect(getSteering().question).toBe(true));
    expect(press(document.body, " ", { shift: true })).toBe(true);
    expect(getSteering().active).toBe(true);

    FakeWebSocket.sent = [];
    expect(press(document.body, "2")).toBe(true);
    // One row down from the highlight, then Enter: the keys a tap on row 2 sends.
    expect(await keysSent(() => FakeWebSocket.sent, 2, 400)).toEqual([DOWN, "\r"]);

    press(document.body, "9");
    expect(getSteering().flash).toMatchObject({ key: "mobile.steering.noOption", vars: { n: 9 } });
  });

  it("flashes that no question is on screen", async () => {
    await mount();
    press(document.body, " ", { shift: true });
    press(document.body, "1");
    expect(getSteering().flash?.key).toBe("mobile.steering.noQuestion");
    expect(getSteering().question).toBe(false);
  });

  it("opens a free-text option's field and hands the keyboard over", async () => {
    await mount();
    await paint(AGENT_QUESTION);
    press(document.body, " ", { shift: true });
    FakeWebSocket.sent = [];
    press(document.body, "3");
    const field = await screen.findByRole("textbox", { name: "Your answer…" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    await waitFor(() => expect(getSteering().view?.typing).toBe("field"));
    // Nothing was sent for the digit itself, and typing passes through untouched.
    expect(FakeWebSocket.sent).toEqual([]);
    expect(press(field, "5")).toBe(false);
    expect(press(field, "a")).toBe(false);
    // Esc lets go of the field and steering carries on.
    expect(press(field, "Escape")).toBe(true);
    expect(document.activeElement).not.toBe(field);
    expect(getSteering().active).toBe(true);
  });

  it("puts the caret in the composer; typing is never eaten, Esc and Enter resume steering", async () => {
    await mount();
    press(document.body, " ", { shift: true });
    expect(press(document.body, "i")).toBe(true);
    expect(document.activeElement).toBe(composer());
    await waitFor(() => expect(getSteering().view?.typing).toBe("composer"));

    expect(press(composer(), "h")).toBe(false);
    expect(press(composer(), "e")).toBe(false);
    // Space and a digit are text here, not steering.
    expect(press(composer(), " ")).toBe(false);
    expect(press(composer(), "1")).toBe(false);
    fireEvent.change(composer(), { target: { value: "hello" } });
    expect(press(composer(), "Escape")).toBe(true);
    expect(document.activeElement).not.toBe(composer());
    expect(composer().value).toBe("hello");
    expect(getSteering().active).toBe(true);

    // Back in, send with Enter: the draft leaves, the composer lets go.
    press(document.body, "i");
    expect(document.activeElement).toBe(composer());
    FakeWebSocket.sent = [];
    // The composer's own handler takes Enter (it sends); the engine adds nothing.
    press(composer(), "Enter");
    await waitFor(() => expect(composer().value).toBe(""));
    await settle(300);
    expect(document.activeElement).not.toBe(composer());
    expect(getSteering().active).toBe(true);
  });

  it("flashes that the agent waits on a choice instead of focusing a blocked composer", async () => {
    await mount();
    await paint(PERMISSION);
    press(document.body, " ", { shift: true });
    expect(composer().disabled).toBe(true);
    press(document.body, "i");
    expect(getSteering().flash?.key).toBe("mobile.steering.blocked");
    expect(document.activeElement).not.toBe(composer());
  });

  it("scrolls the chat with the arrows and jumps to the latest with F", async () => {
    await mount();
    const chat = document.querySelector<HTMLElement>(".readable-output")!;
    expect(chat.hasAttribute("data-steer-scroll")).toBe(true);
    Object.defineProperty(chat, "scrollHeight", { configurable: true, value: 5000 });
    press(document.body, " ", { shift: true });
    expect(press(document.body, "ArrowDown")).toBe(true);
    expect(chat.scrollTop).toBeGreaterThan(0);
    const after = chat.scrollTop;
    press(document.body, "d");
    expect(chat.scrollTop).toBeGreaterThan(after);
    press(document.body, "ArrowUp");
    expect(chat.scrollTop).toBeLessThan(after * 2);
    press(document.body, "f");
    expect(chat.scrollTop).toBe(5000);
  });

  it("unregisters when the terminal goes away", async () => {
    await mount();
    expect(getSteering().hasInside).toBe(true);
    cleanup();
    expect(getSteering().hasInside).toBe(false);
  });
});
