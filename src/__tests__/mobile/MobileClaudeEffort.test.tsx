/**
 * Claude's effort on the phone: no chip of its own, a row of the levels
 * Claude's `/effort` takes in the model sheet, under the models as the CLI's
 * own `/model` dialog draws its effort line. A tap closes the sheet (and the
 * session's dialog) and sends `/effort <level>`; the model chip then carries
 * the level. Other CLIs set their effort on the model sheet's next step, so
 * they get no row.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keysSent, stubTerminalSideChannels } from "../helpers/mobileTerminalHost";

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

const tabOf = (agent_label: string) => ({
  id: "tab",
  label: agent_label.toLowerCase(),
  agent_label,
  kind: "agent" as const,
  available: true,
  viewer_busy: false,
});

const ESC = String.fromCharCode(27);

const paint = async (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
};

const levels = () => Array.from(document.querySelectorAll(".model-effort-levels button"), (button) => button.textContent ?? "");
const level = (name: string) => {
  const button = Array.from(document.querySelectorAll(".model-effort-levels button")).find((entry) => entry.textContent === name);
  if (!button) throw new Error(`no effort level ${name}`);
  return button;
};

describe(`${BRAND.display} Mobile — Claude's effort in the model sheet`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubTerminalSideChannels();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists the levels under the models and sends /effort for the one tapped", async () => {
    render(<Terminal tab={tabOf("Claude")} back={() => {}} />);
    await act(async () => {});
    // No chip of its own any more.
    expect(screen.queryByRole("button", { name: "Effort" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("region", { name: "Reasoning effort" })).toBeTruthy();
    expect(levels()).toEqual(["low", "medium", "high", "xhigh", "max", "auto"]);

    FakeWebSocket.sent = [];
    fireEvent.click(level("high"));
    // The sheet steps aside at once; the command waits for `/model` to settle.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((await keysSent(() => FakeWebSocket.sent, 2, 400)).slice(-2)).toEqual(["/effort high", "\r"]);

    // The model chip names the level that went in.
    expect(screen.getByRole("button", { name: "Model · high effort" })).toBeTruthy();
  }, 10_000);

  it("closes the session's /model dialog before sending the level", async () => {
    render(<Terminal tab={tabOf("Claude")} back={() => {}} />);
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

    FakeWebSocket.sent = [];
    fireEvent.click(level("max"));
    const sent = await keysSent(() => FakeWebSocket.sent, 3, 400);
    expect(sent[0]).toBe(ESC);
    expect(sent.slice(-2)).toEqual(["/effort max", "\r"]);
  }, 10_000);

  it("keeps the sheet, and its effort row, over a redraw frame that shows no dialog", async () => {
    // Claude erases its dialog and paints it again on every arrow; a frame
    // sampled between the two read as "dismissed" and closed the sheet.
    const dialog = [
      "   Select model",
      "   Switch between Claude models.",
      "",
      "     1.  Default (recommended)  Sonnet 5.5",
      "   ❯ 2.  Opus 5.5               For complex work",
      "",
      "   ● High effort ←/→ to adjust",
      "   Enter to set as default · s to use this session only · Esc to cancel",
    ].join("\n");
    render(<Terminal tab={tabOf("Claude")} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await paint(dialog);
    await paint("❯ ");
    await paint(dialog);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 1500)); });
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Select model");
    expect(levels()).toEqual(["low", "medium", "high", "xhigh", "max", "auto"]);

    // Gone for good (dismissed in the session), the sheet does step aside.
    await paint("❯ ");
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 1500)); });
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 15_000);

  it("shows a tag's own level once, as the gauge, and swaps it for the one sent", async () => {
    render(<Terminal tab={{ ...tabOf("Claude"), agent_model: "Opus 5 · medium" }} back={() => {}} />);
    await act(async () => {});
    const chip = screen.getByRole("button", { name: "Opus 5 · medium effort" });
    expect(chip.querySelector(".fact-action-label")?.textContent).toBe("Opus 5");
    expect(chip.querySelector(".fact-effort")?.textContent).toBe("medium");

    fireEvent.click(chip);
    expect(level("medium").getAttribute("aria-current")).toBe("true");
    FakeWebSocket.sent = [];
    fireEvent.click(level("xhigh"));
    expect((await keysSent(() => FakeWebSocket.sent, 2, 400)).slice(-2)).toEqual(["/effort xhigh", "\r"]);
    expect(screen.getByRole("button", { name: "Opus 5 · xhigh effort" })).toBeTruthy();
  }, 10_000);

  it("offers no effort row on another CLI, whose effort is a step of its model sheet", async () => {
    render(<Terminal tab={tabOf("Codex")} back={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Effort" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(document.querySelector(".model-effort")).toBeNull();
  });
});
