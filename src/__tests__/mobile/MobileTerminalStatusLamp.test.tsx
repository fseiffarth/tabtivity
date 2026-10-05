/**
 * The composer's status lamp on a tab the phone is *currently looking at*.
 *
 * The row this screen is opened with is frozen for the whole session — it even
 * comes back from `lastPlace` after a restart — so a `done` captured in the
 * project list would sit in the lamp for as long as the tab stayed open. Being
 * on screen is what retires a finished turn (the attach tells the desktop so),
 * and the lamp says the same thing the desktop's tab bar does about the tab
 * under the user's eyes: nothing.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = { active: { length: 0, getLine() { return undefined; } } };
    loadAddon() {}
    open() {}
    write(_: Uint8Array, callback?: () => void) { callback?.(); }
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
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import type { AgentStatus, TabRow } from "../../../mobile-web/src/api";
import { BRAND } from "../../lib/brand";

const tab = (agent_status?: AgentStatus): TabRow =>
  ({ id: "tab-9", label: "Claude", kind: "agent", agent_status, available: true, viewer_busy: false });

const lampClass = () =>
  screen.getByRole("button", { name: "Status" }).querySelector(".fact-lamp")?.className;

describe(`${BRAND.display} Mobile — the composer's status lamp`, () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("drops a finished-turn flag on the tab being read, and keeps the others", async () => {
    const { rerender } = render(<Terminal tab={tab("done")} back={() => {}} />);
    await act(async () => {});
    expect(lampClass()).toBe("fact-lamp idle");

    rerender(<Terminal tab={tab("question")} back={() => {}} />);
    expect(lampClass()).toBe("fact-lamp question");

    rerender(<Terminal tab={tab()} back={() => {}} />);
    expect(lampClass()).toBe("fact-lamp idle");
  });
});
