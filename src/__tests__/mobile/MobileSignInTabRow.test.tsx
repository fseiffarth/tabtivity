/**
 * A sign-in tab stays one however the phone reaches it. The ＋ sheet and the
 * needs-sign-in notice open it with `signInTab`, but that hint is the App's
 * own state: from the tab list, or after the PWA reloaded on the way back
 * from the sign-in page, only the row's `sign_in` flag says so — and without
 * it the sheet lost its retry, its other way in and the Done that closes it.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
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
    write(_value: Uint8Array, callback?: () => void) { callback?.(); }
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
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send() {}
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { storageKey } from "../../lib/brand";

const ROW = { id: "tab-s", label: "Claude sign-in", kind: "agent" as const, agent_label: "Claude", available: true, viewer_busy: false };

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

describe("a sign-in tab reached from the tab list", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }))));
    localStorage.setItem(storageKey("mobile.view.agent"), "terminal");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens on its sign-in sheet from the row's flag alone", async () => {
    render(<Terminal tab={{ ...ROW, sign_in: true }} back={() => {}} />);
    await settle();
    expect(screen.getByRole("dialog").textContent).toContain("Starting Claude's sign-in");
  });

  it("stays an ordinary session without it", async () => {
    render(<Terminal tab={ROW} back={() => {}} />);
    await settle();
    expect(screen.queryByText(/Starting Claude's sign-in/)).toBeNull();
  });
});
