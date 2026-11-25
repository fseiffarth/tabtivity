/**
 * The local model's next-prompt suggestion on the phone
 * (`mobile-web/src/terminal/nextPrompt.ts`, `GET /api/v1/tabs/{id}/next-prompt`):
 * where the CLI draws no suggestion of its own, the field is filled with the
 * desktop's local model's guess once per ended turn, exactly as Claude's own
 * suggestion is (`MobilePromptSuggestion.test.tsx`). The route is mocked.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[] }));

/** Marks a row whose cells after the `❯ ` are dim, as Claude Code paints its
 * suggestion. */
const DIM = "\u0002";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        type: "normal",
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          if (value == null) return undefined;
          if (!value.startsWith(DIM)) return { isWrapped: false, translateToString: () => value };
          const text = value.slice(1);
          const cell = (char: string, dim: boolean) => ({
            getChars: () => char, getWidth: () => 1, isBold: () => 0, isItalic: () => 0, isDim: () => (dim ? 1 : 0),
            isUnderline: () => 0, isStrikethrough: () => 0, isInverse: () => 0, isInvisible: () => 0,
            isFgDefault: () => true, isBgDefault: () => true, isFgPalette: () => false, isBgPalette: () => false,
            isFgRGB: () => false, isBgRGB: () => false, getFgColor: () => 0, getBgColor: () => 0,
          });
          return {
            isWrapped: false,
            length: text.length,
            translateToString: () => text,
            getCell: (x: number) => (x < text.length ? cell(text[x], x >= 2) : undefined),
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
  send(data: unknown) {
    if (ArrayBuffer.isView(data)) FakeWebSocket.sent.push(new TextDecoder().decode(data as Uint8Array));
  }
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { NEXT_PROMPT_CLAUDE_SETTLE_MS, NEXT_PROMPT_COMPLETE_MS, NEXT_PROMPT_SETTLE_MS } from "../../../mobile-web/src/terminal/nextPrompt";

const CODEX = { id: "tab-x", label: "Codex", kind: "agent" as const, agent_label: "Codex", available: true, viewer_busy: false };
const CLAUDE = { id: "tab-s", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };
const RULE = "─".repeat(60);
/** The bottom of an idle Claude Code screen with `box` as its input row. */
const claudeIdle = (box: string) => ["● Done.", "", RULE, box, RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
const CODEX_IDLE = "• Done.\n\n› ";
const CODEX_BUSY = "• Working (6s • esc to interrupt)\n\n› ";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const paint = async (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
};
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const field = () => screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement;
const SUGGESTION = "run the tests";

/** The phases the route was asked for, in order. */
let asked: string[] = [];
/** The drafts the completion route (the POST) was sent, in order. */
let completed: string[] = [];
let answer: () => unknown = () => ({ text: SUGGESTION, status: "ok", model: "qwen3:4b" });

describe("Mobile composer — the local model's next-prompt suggestion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    asked = [];
    completed = [];
    answer = () => ({ text: SUGGESTION, status: "ok", model: "qwen3:4b" });
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && /\/next-prompt$/.test(String(url))) {
        const { draft } = JSON.parse(String(init.body)) as { draft: string };
        completed.push(draft);
        return Promise.resolve(jsonResponse(200, { text: draft.endsWith("upd") ? "ate the changelog" : " update the changelog", status: "ok", model: "qwen3:4b" }));
      }
      const match = /\/next-prompt\?phase=(\w+)/.exec(String(url));
      if (match) {
        asked.push(match[1]);
        return Promise.resolve(jsonResponse(200, match[1] === "warm" ? { text: null, status: "warmed" } : answer()));
      }
      return Promise.resolve(jsonResponse(404, { error: "not_found" }));
    }));
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const open = async (tab: typeof CODEX, text: string) => {
    render(<Terminal tab={tab} back={() => {}} />);
    await act(async () => {});
    FakeWebSocket.sent = [];
    await paint(text);
  };

  it("fills the empty field once per ended turn on a CLI without suggestions, and sends nothing", async () => {
    await open(CODEX, CODEX_IDLE);
    await wait(NEXT_PROMPT_SETTLE_MS);
    expect(field().value).toBe(SUGGESTION);
    expect(field().getAttribute("aria-description")).toBe("Local model suggests");
    expect(document.querySelector(".composer-suggested-by")?.firstChild?.textContent).toBe("qwen3:4b");
    expect(asked).toEqual(["final"]);
    expect(FakeWebSocket.sent).toEqual([]);
    // Repainted, the same turn is not asked again.
    await paint(`${CODEX_IDLE}\n`);
    await wait(2_000);
    expect(asked).toEqual(["final"]);
  });

  it("offers how a typed draft goes on in a strip over the field; a tap appends it and nothing is sent", async () => {
    answer = () => ({ text: null, status: "ok" });
    await open(CODEX, CODEX_IDLE);
    await wait(NEXT_PROMPT_SETTLE_MS);
    expect(field().value).toBe("");
    fireEvent.change(field(), { target: { value: "run the tests and" } });
    expect(document.querySelector(".composer-complete")).toBeNull();
    await wait(NEXT_PROMPT_COMPLETE_MS);
    expect(completed).toEqual(["run the tests and"]);
    const strip = document.querySelector<HTMLButtonElement>(".composer-complete")!;
    expect(strip.querySelector(".composer-complete-text")?.textContent).toBe("… update the changelog");
    expect(strip.getAttribute("aria-label")).toBe("Take the suggested continuation: update the changelog");
    fireEvent.click(strip);
    expect(field().value).toBe("run the tests and update the changelog");
    expect(FakeWebSocket.sent).toEqual([]);
    // Inside a word, the strip shows the word whole.
    fireEvent.change(field(), { target: { value: "please upd" } });
    await wait(NEXT_PROMPT_COMPLETE_MS);
    expect(document.querySelector(".composer-complete-text")?.textContent).toBe("… update the changelog");
    fireEvent.click(document.querySelector<HTMLButtonElement>(".composer-complete")!);
    expect(field().value).toBe("please update the changelog");
  });

  it("completes nothing for the untouched suggestion filled into the field, a command or one word", async () => {
    await open(CODEX, CODEX_IDLE);
    await wait(NEXT_PROMPT_SETTLE_MS);
    expect(field().value).toBe(SUGGESTION);
    await wait(NEXT_PROMPT_COMPLETE_MS * 3);
    for (const draft of ["/model opus now", "run"]) {
      fireEvent.change(field(), { target: { value: draft } });
      await wait(NEXT_PROMPT_COMPLETE_MS * 3);
    }
    expect(completed).toEqual([]);
    expect(document.querySelector(".composer-complete")).toBeNull();
  });

  it("drops it at the first keystroke: the reader's text stays", async () => {
    await open(CODEX, CODEX_IDLE);
    await wait(NEXT_PROMPT_SETTLE_MS);
    expect(field().value).toBe(SUGGESTION);
    fireEvent.change(field(), { target: { value: "run the tests twice" } });
    await wait(2_000);
    expect(field().value).toBe("run the tests twice");
  });

  it("a new turn takes an untouched one out, and its end asks again", async () => {
    await open(CODEX, CODEX_IDLE);
    await wait(NEXT_PROMPT_SETTLE_MS);
    await paint(CODEX_BUSY);
    expect(field().value).toBe("");
    answer = () => ({ text: "commit it", status: "ok" });
    await paint(CODEX_IDLE);
    await wait(NEXT_PROMPT_SETTLE_MS);
    expect(field().value).toBe("commit it");
    expect(asked.filter((phase) => phase === "final")).toHaveLength(2);
  });

  it("warms once as the agent starts working, and not again while the stored session stands still", async () => {
    await open(CODEX, CODEX_BUSY);
    await wait(10_000);
    expect(asked).toEqual(["warm"]);
  });

  it("never warms a local-model tab, whose turn holds the GPU", async () => {
    await open({ ...CODEX, local_model: true } as typeof CODEX, CODEX_BUSY);
    await wait(10_000);
    expect(asked).toEqual([]);
  });

  it("on Claude, its own suggestion wins: nothing is asked while it shows one", async () => {
    await open(CLAUDE, claudeIdle(`${DIM}❯ make it ask for my name`));
    await wait(NEXT_PROMPT_CLAUDE_SETTLE_MS * 2);
    expect(field().value).toBe("make it ask for my name");
    expect(asked).toEqual([]);
  });

  it("on Claude without one, asks after the settle", async () => {
    await open(CLAUDE, claudeIdle("❯ "));
    await wait(NEXT_PROMPT_CLAUDE_SETTLE_MS - 200);
    expect(asked).toEqual([]);
    await wait(200);
    expect(asked).toEqual(["final"]);
    expect(field().value).toBe(SUGGESTION);
  });

  it("shows nothing when the desktop's model is not running", async () => {
    answer = () => ({ text: null, status: "not_running" });
    await open(CODEX, CODEX_IDLE);
    await wait(NEXT_PROMPT_SETTLE_MS);
    expect(field().value).toBe("");
  });
});
