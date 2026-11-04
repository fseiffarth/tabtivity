/**
 * The phone's Effort chip on a Claude tab: the facts row offers the levels
 * Claude's `/effort` takes, and a tap sends `/effort <level>` — the desktop
 * Reader's effort list, on the phone. Other CLIs set their effort on the
 * model sheet's next step, so they get no chip.
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

const rows = () => Array.from(document.querySelectorAll(".option-list strong"), (row) => row.textContent ?? "");

describe(`${BRAND.display} Mobile — Claude's effort chip`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubTerminalSideChannels();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists the levels and sends /effort for the one tapped", async () => {
    render(<Terminal tab={tabOf("Claude")} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Effort" }));
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Reasoning effort");
    expect(rows()).toEqual([
      "low effort",
      "medium effort",
      "high effort",
      "xhigh effort",
      "max effort",
      "auto — the model's default",
    ]);

    FakeWebSocket.sent = [];
    const high = Array.from(document.querySelectorAll(".option-list button"))
      .find((button) => (button.textContent ?? "").includes("high effort") && !(button.textContent ?? "").includes("xhigh"));
    fireEvent.click(high as Element);
    expect((await keysSent(() => FakeWebSocket.sent, 2, 400)).slice(-2)).toEqual(["/effort high", "\r"]);

    // The sheet steps aside and the chip names the level that went in.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "high effort" })).toBeTruthy();
  });

  it("offers no chip on another CLI, whose effort is a step of its model sheet", async () => {
    render(<Terminal tab={tabOf("Codex")} back={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Effort" })).toBeNull();
  });
});
