import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTerminalSideChannels } from "../helpers/mobileTerminalHost";

// The harness is MobileTerminalReadableView.test.tsx's: xterm faked down to a
// buffer the test writes whole, and a WebSocket that opens on its own.
const terminalState = vi.hoisted(() => ({
  lines: [] as string[],
}));

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
import { BRAND, storageKey } from "../../lib/brand";

const SCREEN = ["> fix the failing test", "", "⏺ Fixed it.", ""].join("\n");

async function openAgent() {
  render(<Terminal tab={{ id: "tab", label: "Claude", kind: "agent", available: true, viewer_busy: false }} project="p1" back={() => {}} />);
  await act(async () => {});
  const bytes = new TextEncoder().encode(SCREEN);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
}

const CHANGES = {
  available: true,
  version: "c1",
  truncated: false,
  outside: 1,
  changes: [
    { path: "src/a.rs", kind: "edit", diff: "@@ -9,2 +9,2 @@\n keep\n-old line\n+new line\n", added: 1, removed: 1, at: "2026-10-25T09:00:00Z" },
    { path: "b.md", worktree: { label: "topic", branch: "topic" }, kind: "add", diff: "@@ -0,0 +1,1 @@\n+# B\n", added: 1, removed: 0, at: "2026-10-25T09:01:00Z" },
  ],
};

function hostAnswering(changes: unknown, status = 200) {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/v1/tabs/tab/changes")) return new Response(JSON.stringify(changes), { status });
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The view pill: named after the view on screen, titled "Output view". */
const pill = () => document.querySelector<HTMLButtonElement>(".terminal-view-switch button")!;

function pick(name: RegExp) {
  fireEvent.click(pill());
  fireEvent.click(within(screen.getByRole("menu", { name: "Output view" })).getByRole("menuitemradio", { name }));
}

describe(`${BRAND.display} Mobile — the chat's Diffs view`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubTerminalSideChannels();
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists Chat, Diffs and Terminal, and shows the chat's changes newest first", async () => {
    const fetch = hostAnswering(CHANGES);
    await openAgent();
    fireEvent.click(pill());
    const rows = within(screen.getByRole("menu", { name: "Output view" })).getAllByRole("menuitemradio");
    // The views first; the chat's source rows (Session, Screen) follow.
    expect(rows.slice(0, 3).map((row) => row.querySelector("strong")?.textContent?.replace(/Untested$/u, ""))).toEqual(["Chat", "Diffs", "Terminal"]);
    fireEvent.click(rows[1]);

    const view = await screen.findByTestId("chat-changes");
    await within(view).findByText("b.md");
    expect(fetch).toHaveBeenCalledWith("/api/v1/tabs/tab/changes", expect.anything());
    expect(pill().textContent).toBe("Diffs");
    const cards = [...view.querySelectorAll<HTMLElement>(".chat-change")];
    expect(cards.map((card) => card.querySelector(".chat-change-path strong")?.textContent)).toEqual(["b.md", "src/a.rs"]);
    expect(cards[0].querySelector(".chat-change-path em")?.textContent).toBe("topic");
    // The newest is open, the older folded until tapped.
    expect(cards[0].querySelector(".chat-change-diff")).not.toBeNull();
    expect(cards[1].querySelector(".chat-change-diff")).toBeNull();
    fireEvent.click(within(cards[1]).getByRole("button", { expanded: false }));
    const lines = [...cards[1].querySelectorAll<HTMLElement>(".chat-diff-line")];
    expect(lines.map((line) => line.className.replace("chat-diff-line ", ""))).toEqual(["note", "context", "del", "add"]);
    expect(lines[3].querySelector("span")?.textContent).toBe("10");
    expect(view.textContent).toContain("1 changes to files outside the project are not shown.");
    // A file filter narrows the list.
    fireEvent.change(within(view).getByRole("combobox", { name: "Changed files" }), { target: { value: "src/a.rs" } });
    expect(view.querySelectorAll(".chat-change").length).toBe(1);

    pick(/^Chat/);
    expect(screen.queryByTestId("chat-changes")).toBeNull();
  });

  it("names the desktop switch while project files are off on the phone", async () => {
    hostAnswering({ error: "files_off" }, 404);
    await openAgent();
    pick(/^Diffs/);
    const view = await screen.findByTestId("chat-changes");
    expect(await within(view).findByText(/Project files on the phone/)).toBeTruthy();
  });
});
