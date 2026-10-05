/**
 * The model sheet against a *multi-step* picker.
 *
 * `/model` is one question in Claude Code and two in Codex, which follows the
 * model list with a reasoning-level list for the model just picked. The sheet
 * used to close on the first tap, leaving the second list on the session's own
 * screen with only the arrow keys to answer it. It now lists whatever step the
 * session draws next, and closes when it draws none.
 *
 * The screens below are the ones codex-cli 0.153.4 actually paints.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[] }));

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
  /** Keystrokes go out as bytes; the control frames the screen also sends
   * (resize, attach) are JSON strings and are not what these tests read. */
  send(data: unknown) {
    if (ArrayBuffer.isView(data)) FakeWebSocket.sent.push(new TextDecoder().decode(data as Uint8Array));
  }
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND } from "../../lib/brand";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;

const MODEL_STEP = [
  "  Select Model and Effort",
  "  Access legacy models by running codex -m <model_name> or in your config.toml",
  "",
  "  1. gpt-6-astra (default)  Our most capable model for complex, demanding work.",
  "› 2. gpt-5.6-sol (current)  Reliable agentic workhorse for everyday tasks.",
  "  3. gpt-5.6-terra          Balanced agentic coding model for everyday work.",
  "",
  "  Press enter to confirm or esc to go back",
].join("\n");

const REASONING_STEP = [
  "  Select Reasoning Level for gpt-5.6-sol",
  "",
  "  1. Low (default)    Fast responses with lighter reasoning",
  "  2. Medium           Balances speed and reasoning depth for everyday tasks",
  "› 3. High (current)   Greater reasoning depth for complex problems",
  "",
  "  Press enter to confirm or esc to go back",
].join("\n");

const DONE = "› Ask Codex to do anything\n\n  gpt-5.6-sol medium · /tmp";

const paint = async (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
};

const settle = async (ms: number) => {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, ms)); });
};

const rows = () => Array.from(document.querySelectorAll(".option-list button"), (row) => row.textContent ?? "");

/** Taps the sheet's row by its label. Scoped to the sheet: the session text
 * behind it holds the same model names, as the reading view painted them. */
const pick = (label: string) => {
  const row = Array.from(document.querySelectorAll(".option-list button"))
    .find((button) => (button.textContent ?? "").includes(label));
  if (!row) throw new Error(`no sheet row for ${label}`);
  fireEvent.click(row);
};

describe(`${BRAND.display} Mobile — a multi-step /model picker`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists the reasoning step Codex draws after the model is chosen", async () => {
    render(<Terminal tab={{ id: "tab", label: "Codex", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await paint(MODEL_STEP);

    // The heading is the session's, not Tabtivity's: it says which step this is.
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Select Model and Effort");
    expect(rows()[0]).toContain("gpt-6-astra (default)");

    FakeWebSocket.sent = [];
    pick("gpt-5.6-terra");
    // One row down from the highlight, then Enter — the arrow row's own keys.
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([DOWN, "\r"]);
    // The tap does not close the sheet: the session may have another step.
    expect(screen.queryByRole("dialog")).toBeTruthy();

    await paint(REASONING_STEP);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Select Reasoning Level for gpt-5.6-sol");
    expect(rows()[0]).toContain("Low (default)");
    expect(rows()[1]).toContain("Balances speed and reasoning depth");
    expect(rows()[2]).toContain("High (current)");

    FakeWebSocket.sent = [];
    pick("Medium");
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([UP, "\r"]);

    // The dialog is done: the sheet steps aside rather than sitting over the
    // session's own screen.
    await paint(DONE);
    await settle(900);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reveals GPT-6.1 Sol above a clipped Codex model list", async () => {
    render(<Terminal tab={{ id: "tab", label: "Codex", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await settle(400);
    FakeWebSocket.sent = [];
    await paint([
      "  Select Model and Effort",
      "",
      "  2. gpt-6-astra (current)  Frontier intelligence for the most demanding work.",
      "› 3. gpt-6-sol            Previous generation workhorse model.",
      "  4. gpt-6-luna           Fast and affordable model for easier tasks.",
    ].join("\n"));
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([UP, UP]);

    FakeWebSocket.sent = [];
    await paint([
      "  Select Model and Effort",
      "",
      "› 1. gpt-6.1-sol (default)  Latest workhorse model for coding and everyday work.",
      "  2. gpt-6-astra (current)  Frontier intelligence for the most demanding work.",
      "  3. gpt-6-sol            Previous generation workhorse model.",
    ].join("\n"));
    expect(rows().some((row) => row.includes("gpt-6.1-sol (default)"))).toBe(true);
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([DOWN, DOWN]);
  });

  it("closes on a picker that has only one step", async () => {
    render(<Terminal tab={{ id: "tab", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await paint([
      "Select Model",
      "Switch between Claude models. Applies to this session.",
      "",
      "  1. Default (recommended)   Opus for up to 50% of usage, then Sonnet",
      "❯ 2. Opus                    For complex tasks",
      "",
      "Esc to cancel",
    ].join("\n"));
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Select Model");

    pick("Default (recommended)");
    await paint(`> \n\n  ~/projects/${BRAND.slug} · Opus 5`);
    await settle(900);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists every model of a picker that draws only a window of them", async () => {
    // Claude Code 2.1.278's `/model` in an 80×24 pane: three rows of five,
    // the window following the highlight.
    const claudeWindow = (rows: string[]) => [
      "   Select model",
      "   Switch between Claude models.",
      "",
      ...rows,
      "      … +2 models",
      "",
      "   Enter to set as default · s to use this session only · Esc to cancel",
    ].join("\n");
    const DEFAULT = "1. Default (recommended)  Opus 5 with 1M context";
    const OPUS = "2. Opus (1M context)      Opus 5 with 1M context";
    const FABLE = "3. Fable ✔                Fable 5.1";
    const SONNET = "4. Sonnet                 Sonnet 5";
    const HAIKU = "5. Haiku                  Haiku 4.5";
    render(<Terminal tab={{ id: "tab", label: "Claude", kind: "agent", agent_model: "Fable 5.1", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    // A status line too narrow to name the model: the chip says the last one
    // the tab answered with, not "Model".
    fireEvent.click(screen.getByRole("button", { name: "Fable 5.1" }));
    await settle(400);
    expect(FakeWebSocket.sent.slice(-2)).toEqual(["/model", "\r"]);
    FakeWebSocket.sent = [];
    await paint(claudeWindow([`     ${DEFAULT}`, `     ${OPUS}`, `   ❯ ${FABLE}`]));
    // The highlight is walked onto the first hidden row — arrows only.
    await settle(300);
    expect(FakeWebSocket.sent).toEqual([DOWN]);
    FakeWebSocket.sent = [];
    await paint(claudeWindow([`   ↑ ${OPUS}`, `     ${FABLE}`, `   ❯ ${SONNET}`]));
    await settle(300);
    expect(FakeWebSocket.sent).toEqual([DOWN]);
    FakeWebSocket.sent = [];
    await paint(claudeWindow([`   ↑ ${FABLE}`, `     ${SONNET}`, `   ❯ ${HAIKU}`]));
    // Every row seen: back to where the highlight was.
    await settle(300);
    expect(FakeWebSocket.sent).toEqual([UP, UP]);
    await paint(claudeWindow([`   ❯ ${FABLE}`, `     ${SONNET}`, `     ${HAIKU}`]));

    expect(Array.from(document.querySelectorAll(".option-list strong"), (label) => label.textContent))
      .toEqual(["Default (recommended)", "Opus (1M context)", "Fable ✔", "Sonnet", "Haiku"]);
    expect(document.querySelector(".option-list button.current")?.textContent).toContain("Fable");

    // A hidden row is picked by its number, from where the highlight is.
    FakeWebSocket.sent = [];
    pick("Default (recommended)");
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([UP, UP, "\r"]);
  });

  it("sends /clear from Codex's Clear chip at once, without a confirm dialog", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<Terminal tab={{ id: "tab", label: "Codex", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    // The chip sits in the bar beside the draft's own ✕, draft or not.
    fireEvent.change(screen.getByRole("textbox", { name: "Message agent" }), { target: { value: "hi" } });
    expect(screen.getByRole("button", { name: "Clear the message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start a new conversation" }).textContent).toBe("Clear");
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await settle(300);
    expect(confirm).not.toHaveBeenCalled();
    expect(FakeWebSocket.sent.join("")).toContain("/clear");
  });
});
