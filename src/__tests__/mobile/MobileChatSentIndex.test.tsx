import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
import { BRAND, NAMES, storageKey } from "../../lib/brand";
import { resetInboxFiles } from "../../../mobile-web/src/terminal/inboxRefs";
import { sentFiles } from "../../../mobile-web/src/components/SentFilesIndex";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };
const secs = (iso: string) => Date.parse(iso) / 1000;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

function sidecarFetch(files: unknown[], transcript: unknown, inbox: unknown[] = []) {
  return vi.fn((url: string) => {
    if (url.includes("/inbox?names=")) return Promise.resolve(jsonResponse(200, { files: inbox }));
    if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files }));
    if (url.includes("/transcript") && transcript) return Promise.resolve(jsonResponse(200, { transcript }));
    return Promise.resolve(jsonResponse(404, { error: "not_found" }));
  });
}

const PHOTO = "20261004-101500-photo.jpg";
const TRANSCRIPT = {
  available: true,
  version: "1:1",
  truncated: false,
  entries: [
    { kind: "prompt", text: `what is on this? @${NAMES.inboxDir}/${PHOTO}`, at: "2026-10-04T10:15:05Z" },
    { kind: "answer", text: "A whiteboard. Here is it typed up.", at: "2026-10-04T10:16:00Z" },
  ],
};

describe(`${BRAND.display} Mobile lists the files a conversation carried`, () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    localStorage.clear();
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    resetInboxFiles();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists both directions newest first in the strip over the chat, and opens a row in the viewer", async () => {
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "board.md", kind: "text/markdown", size: 900, modified: secs("2026-10-04T10:16:10Z"), from_tab: true },
      { name: "theirs.png", kind: "image/png", size: 9_000, modified: secs("2026-10-04T10:17:00Z") },
    ], TRANSCRIPT, [
      { name: PHOTO, original: "photo.jpg", kind: "image/jpeg", size: 300_000, modified: secs("2026-10-04T10:15:00Z") },
    ]));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    await settle();

    const index = screen.getByRole("navigation", { name: "Files in this conversation" });
    const toggle = within(index).getByRole("button", { name: /^Files \(2\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    // Another tab's file stays in the gallery; this chat's two, newest first.
    const rows = within(index).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["board.md", "photo.jpg"]);
    expect(rows[0].textContent).toContain("From the agent");
    expect(rows[1].textContent).toContain("From you");
    expect(rows[1].querySelector("img")?.getAttribute("src")).toBe(`/api/v1/tabs/tab-7/inbox/${PHOTO}`);

    fireEvent.click(within(rows[1]).getByRole("button", { name: "Open photo.jpg" }));
    expect(screen.getByRole("dialog", { name: "photo.jpg" })).toBeTruthy();
  });

  it("keeps one list open at a time beside the subagent index", async () => {
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "plot.png", kind: "image/png", size: 9_000, modified: secs("2026-10-04T10:16:10Z"), from_tab: true },
    ], {
      ...TRANSCRIPT,
      entries: [
        ...TRANSCRIPT.entries,
        { kind: "agent", role: "Explore", text: "Find the data", at: "2026-10-04T10:15:30Z" },
      ],
    }));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    const agents = within(screen.getByRole("navigation", { name: "Subagents in this conversation" })).getByRole("button", { name: /^Subagents \(1\)/ });
    const files = within(screen.getByRole("navigation", { name: "Files in this conversation" })).getByRole("button", { name: /^Files \(1\)/ });
    fireEvent.click(agents);
    fireEvent.click(files);
    expect(files.getAttribute("aria-expanded")).toBe("true");
    expect(agents.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(agents);
    expect(files.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows no list when the conversation carried no file", async () => {
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "theirs.png", kind: "image/png", size: 9_000, modified: secs("2026-10-04T10:17:00Z") },
    ], { ...TRANSCRIPT, entries: [TRANSCRIPT.entries[1]] }));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.queryByRole("navigation", { name: "Files in this conversation" })).toBeNull();
  });

  it("leaves out a leaf the inbox no longer holds or has not described", () => {
    const sent = { name: "a.png", kind: "image/png", size: 1, modified: 10, from_tab: true };
    const kept = { name: "b.jpg", kind: "image/jpeg", size: 1, modified: 20 };
    const rows = sentFiles([sent], ["b.jpg", "gone.jpg", "asking.jpg"], new Map([["b.jpg", kept], ["gone.jpg", null]]));
    expect(rows).toEqual([{ file: kept, from: "phone" }, { file: sent, from: "agent" }]);
  });
});
