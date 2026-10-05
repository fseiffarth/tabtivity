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
import { BRAND, LEGACY_NAMES, NAMES, storageKey } from "../../lib/brand";
import { resetInboxFiles } from "../../../mobile-web/src/terminal/inboxRefs";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

const PHOTO = "20261003-101500-IMG_0042.jpg";
const NOTES = "20261003-101501-notes.pdf";
const OLD = "20260901-080000-plot.png";

/** The sidecar: an empty outbox, the given session, and the inbox describing
 * the leaves it holds. */
function sidecarFetch(transcript: unknown, held: Record<string, { kind: string; size: number }>) {
  return vi.fn((url: string) => {
    if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
    if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript }));
    if (url.includes("/inbox?names=")) {
      const names = new URL(url, "http://x").searchParams.get("names")?.split(",") ?? [];
      const files = names.filter((name) => held[name]).map((name) => ({ name, original: name.replace(/^(\d{8}-\d{6}-)+/u, ""), modified: 1, ...held[name] }));
      return Promise.resolve(jsonResponse(200, { files }));
    }
    return Promise.resolve(jsonResponse(404, { error: "not_found" }));
  });
}

describe(`${BRAND.display} Mobile shows what the phone sent in its prompt's bubble`, () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    localStorage.clear();
    resetInboxFiles();
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("draws the files as pictures and cards in place of their @ references", async () => {
    const fetchMock = sidecarFetch({
      available: true,
      version: "1:1",
      truncated: false,
      entries: [
        { kind: "prompt", text: `what is wrong here @${NAMES.inboxDir}/${PHOTO} @${NAMES.inboxDir}/${NOTES} `, at: "2026-10-03T10:15:05Z" },
        { kind: "answer", text: "The axis is flipped.", at: "2026-10-03T10:16:00Z" },
        { kind: "prompt", text: `@${LEGACY_NAMES.inboxDir}/${OLD}`, at: "2026-10-03T10:17:00Z" },
      ],
    }, { [PHOTO]: { kind: "image/jpeg", size: 3 }, [NOTES]: { kind: "application/pdf", size: 2_048 } });
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    await settle();

    const chat = screen.getByTestId("session-transcript");
    const prompts = Array.from(chat.querySelectorAll(".readable-turn.user"));
    expect(prompts).toHaveLength(2);
    // The words read without the references; the picture is the inbox's copy.
    expect(prompts[0].classList.contains("with-files")).toBe(true);
    expect(prompts[0].querySelector(".transcript-md")?.textContent?.trim()).toBe("what is wrong here");
    expect(Array.from(prompts[0].querySelectorAll("img")).map((img) => img.getAttribute("src")))
      .toEqual([`/api/v1/tabs/tab-7/inbox/${PHOTO}`]);
    expect(prompts[0].querySelector(".outbox-post-file")?.textContent).toContain("notes.pdf");
    // Asked once, for every leaf the chat names.
    const asked = fetchMock.mock.calls.filter(([url]) => String(url).includes("/inbox?names="));
    expect(asked).toHaveLength(1);
    expect(new URL(String(asked[0][0]), "http://x").searchParams.get("names")?.split(",")).toEqual([PHOTO, NOTES, OLD]);
    // An older build's reference reads the same; a file gone from the inbox says so.
    expect(prompts[1].querySelector(".transcript-md")).toBeNull();
    expect(prompts[1].querySelector(".outbox-post-file.gone")?.textContent).toContain("plot.png");

    // A tap opens the picture full screen, from the inbox.
    fireEvent.click(within(prompts[0] as HTMLElement).getByRole("button", { name: "Open IMG_0042.jpg" }));
    const viewer = screen.getByRole("dialog", { name: "IMG_0042.jpg" });
    expect(viewer.querySelector("img")?.getAttribute("src")).toBe(`/api/v1/tabs/tab-7/inbox/${PHOTO}`);
  });
});
