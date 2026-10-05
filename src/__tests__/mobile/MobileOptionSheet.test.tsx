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
  /** Everything the phone typed into the session, decoded. */
  static keys: string[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(value: unknown) {
    // Control frames go out as JSON strings; keystrokes as encoded bytes.
    if (typeof value === "string") return;
    FakeWebSocket.keys.push(new TextDecoder().decode(value as ArrayBufferView));
  }
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND } from "../../lib/brand";

const ESC = String.fromCharCode(27);
const TAB = { id: "tab", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };

/** Repaints the session with `screen` and lets the reading view rebuild. */
async function paint(screenText: string) {
  const bytes = new TextEncoder().encode(screenText);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await settle(200);
}

/** Advances the clock by `ms`. Fake timers, not wall time: the mode walk waits
 * MODE_SETTLE between two Shift+Tabs and the assertions here sit inside that
 * gap, which a loaded CI runner would otherwise overrun. */
const settle = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const PICKER = [
  "Select Model",
  "",
  "  1. Default (recommended)   Opus, then Sonnet",
  "❯ 2. Opus                    For complex tasks",
  "  3. Sonnet                  Most efficient for everyday tasks",
  "",
  "Esc to cancel",
].join("\n");

describe(`${BRAND.display} Mobile composer sheets`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    FakeWebSocket.keys = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lists the session's own model picker and answers it with a tap", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByTitle("Choose the model (/model)"));
    await settle(400);
    expect(FakeWebSocket.keys.join("")).toContain("/model");
    // The sheet is up before the picker is: it says so rather than listing
    // models Tabtivity made up.
    expect(screen.getByText("Waiting for the session's model picker…")).toBeTruthy();

    await paint(PICKER);
    const rows = screen.getAllByRole("button").filter((button) => button.querySelector("strong"));
    expect(rows.map((row) => row.querySelector("strong")?.textContent))
      .toEqual(["Default (recommended)", "Opus", "Sonnet"]);
    // The highlighted row is the session's current model.
    expect(rows[1].getAttribute("aria-current")).toBe("true");

    FakeWebSocket.keys = [];
    fireEvent.click(rows[2]);
    await settle(400);
    // One step down from the highlight, then Enter — the keys the arrow row
    // sends, never a guessed slash command.
    expect(FakeWebSocket.keys).toEqual([`${ESC}[B`, "\r"]);
    // The tap does not close the sheet — `/model` is two questions in Codex,
    // which asks for a reasoning level next — so it holds the answered list,
    // untappable, until the session says what comes after it.
    expect(screen.queryByRole("dialog")).toBeTruthy();
    expect(rows[2].hasAttribute("disabled")).toBe(true);

    // Here it was the only question: the dialog is gone and so is the sheet.
    await paint(`❯ \n\n  ~/projects/${BRAND.slug} · Sonnet 4`);
    await settle(1_000);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the picker in the session when the sheet is dismissed", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByTitle("Choose the model (/model)"));
    await settle(400);
    await paint(PICKER);

    FakeWebSocket.keys = [];
    fireEvent.click(screen.getByLabelText("Close"));
    await settle(50);
    expect(FakeWebSocket.keys).toEqual([ESC]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("walks Shift+Tab to the tapped permission mode and stops when it lands", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint("> \n⏵⏵ accept edits on (shift+tab to cycle)");

    fireEvent.click(screen.getByTitle("Choose the permission mode"));
    const modes = screen.getAllByRole("button").filter((button) => button.querySelector("strong"));
    expect(modes.map((row) => row.querySelector("strong")?.textContent))
      .toEqual(["Default", "Accept edits", "Plan", "Auto", "Bypass permissions"]);
    expect(modes[1].getAttribute("aria-current")).toBe("true");

    FakeWebSocket.keys = [];
    fireEvent.click(modes[2]);
    await settle(100);
    expect(FakeWebSocket.keys).toEqual([`${ESC}[Z`]);
    // The walk believes the status line, not its own count: the sheet closes
    // when the session reports the mode that was asked for.
    await paint("> \nplan mode on (shift+tab to cycle)");
    await settle(500);
    expect(FakeWebSocket.keys).toEqual([`${ESC}[Z`]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers Claude's modes from the silent default mode", async () => {
    // Claude Code prints no mode line at all while in default mode; the tab's
    // label is what earns the sheet, and the frame's silence is the readout.
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint("> \n? for shortcuts");

    fireEvent.click(screen.getByTitle("Choose the permission mode"));
    const modes = screen.getAllByRole("button").filter((button) => button.querySelector("strong"));
    expect(modes.map((row) => row.querySelector("strong")?.textContent))
      .toEqual(["Default", "Accept edits", "Plan", "Auto", "Bypass permissions"]);
    expect(modes[0].getAttribute("aria-current")).toBe("true");

    FakeWebSocket.keys = [];
    fireEvent.click(modes[2]);
    await settle(100);
    expect(FakeWebSocket.keys).toEqual([`${ESC}[Z`]);
    await paint("> \nplan mode on (shift+tab to cycle)");
    await settle(500);
    expect(FakeWebSocket.keys).toEqual([`${ESC}[Z`]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirms Codex Working to Auto from its permission update row", async () => {
    // Codex keeps its ordinary mode silent in the footer. Shift+Tab confirms
    // the applied permission profile in history, above the input box; Reader
    // must see that row or it presses Shift+Tab again and cycles away from it.
    render(<Terminal tab={{ ...TAB, id: "tab-codex", label: "Codex", agent_label: "Codex" }} back={() => {}} />);
    await act(async () => {});
    await paint("› \n? for shortcuts");

    fireEvent.click(screen.getByTitle("Choose the permission mode"));
    const modes = screen.getAllByRole("button").filter((button) => button.querySelector("strong"));
    expect(modes.map((row) => row.querySelector("strong")?.textContent))
      .toEqual(["Working", "Plan", "Read only", "Auto", "Full access"]);
    expect(modes[0].getAttribute("aria-current")).toBe("true");

    FakeWebSocket.keys = [];
    fireEvent.click(modes[3]);
    await settle(100);
    expect(FakeWebSocket.keys).toEqual([`${ESC}[9;2u`]);
    await paint("• Permissions updated to Ask for approval\n\n› \n? for shortcuts");
    await settle(500);
    expect(FakeWebSocket.keys).toEqual([`${ESC}[9;2u`]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps cycling as before for a session no mode family claims", async () => {
    // Goose switches modes with a slash command, not Shift+Tab, so no family
    // lists it and the chip only presses the key.
    render(<Terminal tab={{ ...TAB, id: "tab-g", label: "Goose" }} back={() => {}} />);
    await act(async () => {});
    await paint("> \n? for shortcuts");

    FakeWebSocket.keys = [];
    fireEvent.click(screen.getByTitle("Switch mode (Shift+Tab)"));
    expect(FakeWebSocket.keys).toEqual([`${ESC}[Z`]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers Gemini CLI's modes, read from the row above its box", async () => {
    // Gemini draws its mode over the input box, and in default mode only the
    // hint — the family's silent default.
    render(<Terminal tab={{ ...TAB, id: "tab-gm", label: "Google Gemini" }} back={() => {}} />);
    await act(async () => {});
    await paint("Shift+Tab to accept edits\n> \n~/proj  25% used");

    fireEvent.click(screen.getByTitle("Choose the permission mode"));
    const modes = screen.getAllByRole("button").filter((button) => button.querySelector("strong"));
    expect(modes.map((row) => row.querySelector("strong")?.textContent))
      .toEqual(["Default", "Accept edits", "Plan", "YOLO"]);
    expect(modes[0].getAttribute("aria-current")).toBe("true");

    FakeWebSocket.keys = [];
    fireEvent.click(modes[1]);
    await settle(100);
    expect(FakeWebSocket.keys).toEqual([`${ESC}[Z`]);
    await paint("auto-accept edits Shift+Tab to plan\n> \n~/proj  25% used");
    await settle(500);
    expect(FakeWebSocket.keys).toEqual([`${ESC}[Z`]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
