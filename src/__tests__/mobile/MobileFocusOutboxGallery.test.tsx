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
import { BRAND, storageKey } from "../../lib/brand";

/** A bubble's words, without the time a messenger puts in its corner. */
function said(bubble: Element | null | undefined): string | null {
  if (!bubble) return null;
  const copy = bubble.cloneNode(true) as Element;
  copy.querySelectorAll(".transcript-time").forEach((time) => time.remove());
  return copy.textContent;
}


const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };
const secs = (iso: string) => Date.parse(iso) / 1000;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
/** One finger down on the full-screen viewer's picture, moved, and lifted. */
function drag(viewer: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  const stage = viewer.querySelector(".outbox-viewer-stage")!;
  fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(stage, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(stage, { pointerId: 1, clientX: to.x, clientY: to.y });
}

function sidecarFetch(files: unknown[], transcript?: unknown) {
  return vi.fn((url: string) => {
    if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files }));
    if (url.includes("/transcript") && transcript) return Promise.resolve(jsonResponse(200, { transcript }));
    return Promise.resolve(jsonResponse(404, { error: "not_found" }));
  });
}

describe(`${BRAND.display} Mobile shows the files the agent sent in the chat and in the gallery`, () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    localStorage.clear();
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts the picture in the stored chat after the answer it followed, and in the gallery beside the tab name", async () => {
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "run12.png", kind: "image/png", size: 48_000, modified: secs("2026-09-15T05:03:00Z"), from_tab: true },
    ], {
      available: true,
      version: "1:1",
      truncated: false,
      entries: [
        { kind: "prompt", text: "plot run 12", at: "2026-09-15T05:00:00Z" },
        { kind: "answer", text: "Here is the plot.", at: "2026-09-15T05:02:00Z" },
        { kind: "prompt", text: "thanks", at: "2026-09-15T06:00:00Z" },
      ],
    }));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    // A picture message between the answer it followed and the next prompt,
    // and no strip above the composer.
    const chat = screen.getByTestId("session-transcript");
    const turns = Array.from(chat.querySelectorAll(".readable-turn"));
    expect(turns.map((turn) => turn.classList.contains("outbox-post") ? "picture" : said(turn)))
      .toEqual(["plot run 12", "Here is the plot.", "picture", "thanks"]);
    const post = within(chat).getByRole("group", { name: "Pictures and files from the agent (1)" });
    expect(post.classList.contains("pictures-only")).toBe(true);
    expect(post.querySelectorAll("img")).toHaveLength(1);
    expect(post.querySelector("img")?.getAttribute("src")).toBe("/api/v1/tabs/tab-7/outbox/run12.png");
    expect(post.textContent).not.toContain("run12.png");
    expect(screen.queryByRole("region", { name: "Files from the agent" })).toBeNull();
    fireEvent.click(within(post).getByRole("button", { name: "Open run12.png" }));
    expect(screen.getByRole("dialog", { name: "run12.png" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog", { name: "run12.png" })).getAllByRole("button", { name: "Close" })[0]);

    fireEvent.click(screen.getByRole("button", { name: "Files from the agent (1)" }));
    const gallery = screen.getByRole("dialog", { name: "Files from the agent" });
    expect(gallery.textContent).toContain("run12.png");
    expect(gallery.querySelector("img")?.getAttribute("src")).toBe("/api/v1/tabs/tab-7/outbox/run12.png");

    fireEvent.click(within(gallery).getByRole("button", { name: "Open run12.png" }));
    expect(screen.getByRole("dialog", { name: "run12.png" }).querySelector("img")?.getAttribute("src")).toBe("/api/v1/tabs/tab-7/outbox/run12.png");
  });

  it("posts only what this tab sent in its chat; a file from another tab is in the gallery alone", async () => {
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "theirs.png", kind: "image/png", size: 9_000, modified: secs("2026-09-15T05:02:40Z") },
      { name: "mine.png", kind: "image/png", size: 9_000, modified: secs("2026-09-15T05:02:30Z"), from_tab: true },
    ], {
      available: true,
      version: "1:1",
      truncated: false,
      entries: [
        { kind: "prompt", text: "plot it", at: "2026-09-15T05:00:00Z" },
        { kind: "answer", text: "Here it is.", at: "2026-09-15T05:02:00Z" },
      ],
    }));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    const chat = screen.getByTestId("session-transcript");
    const imgs = Array.from(chat.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(imgs).toEqual(["/api/v1/tabs/tab-7/outbox/mine.png"]);
    fireEvent.click(screen.getByRole("button", { name: "Files from the agent (2)" }));
    const gallery = screen.getByRole("dialog", { name: "Files from the agent" });
    expect(gallery.textContent).toContain("theirs.png");
    expect(gallery.textContent).toContain("mine.png");
  });

  it("posts one send as one album, and leaves files from before the conversation to the gallery", async () => {
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "notes.pdf", kind: "application/pdf", size: 2_048, modified: secs("2026-09-15T05:10:00Z"), from_tab: true },
      { name: "c.png", kind: "image/png", size: 9_000, modified: secs("2026-09-15T05:02:33Z"), from_tab: true },
      { name: "b.png", kind: "image/png", size: 9_000, modified: secs("2026-09-15T05:02:31Z"), from_tab: true },
      { name: "a.png", kind: "image/png", size: 9_000, modified: secs("2026-09-15T05:02:30Z"), from_tab: true },
      { name: "old.png", kind: "image/png", size: 9_000, modified: secs("2026-09-14T20:00:00Z"), from_tab: true },
    ], {
      available: true,
      version: "1:1",
      truncated: false,
      entries: [
        { kind: "prompt", text: "send me the three runs", at: "2026-09-15T05:00:00Z" },
        { kind: "answer", text: "Sending them.", at: "2026-09-15T05:02:00Z" },
        { kind: "answer", text: "Sent; the notes follow.", at: "2026-09-15T05:03:00Z" },
      ],
    }));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    const chat = screen.getByTestId("session-transcript");
    const posts = within(chat).getAllByRole("group", { name: /^Pictures and files from the agent/ });
    expect(posts.map((post) => post.getAttribute("aria-label")))
      .toEqual(["Pictures and files from the agent (3)", "Pictures and files from the agent (1)"]);
    // The three pictures of one send are one album, oldest first.
    expect(posts[0].querySelector(".outbox-post-album")?.classList.contains("tiles-3")).toBe(true);
    expect(Array.from(posts[0].querySelectorAll("img")).map((img) => img.getAttribute("src")))
      .toEqual(["a.png", "b.png", "c.png"].map((name) => `/api/v1/tabs/tab-7/outbox/${name}`));
    // A PDF later on is its own message, a card with its name.
    expect(posts[1].classList.contains("pictures-only")).toBe(false);
    expect(posts[1].textContent).toContain("notes.pdf");
    // The picture from before this conversation is in the gallery only.
    expect(chat.innerHTML).not.toContain("old.png");
    screen.getByRole("button", { name: "Files from the agent (5)" });
  });

  it("steps through the gallery's pictures in the full-screen viewer, skipping the other kinds", async () => {
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "c.png", kind: "image/png", size: 3_000, modified: 300 },
      { name: "paper.pdf", kind: "application/pdf", size: 400, modified: 250 },
      { name: "b.png", kind: "image/png", size: 2_000, modified: 200 },
      { name: "a.jpg", kind: "image/jpeg", size: 1_000, modified: 100 },
    ]));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Files from the agent (4)" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Files from the agent" })).getByRole("button", { name: "Open c.png" }));
    const shown = () => screen.getByRole("dialog", { name: /\.(png|jpg)$/ });
    const src = () => shown().querySelector("img")?.getAttribute("src");

    // The newest picture: nothing before it, the PDF not counted.
    expect(shown().textContent).toContain("1 / 3");
    expect(within(shown()).queryByRole("button", { name: "Previous picture" })).toBeNull();
    fireEvent.click(within(shown()).getByRole("button", { name: "Next picture" }));
    expect(src()).toBe("/api/v1/tabs/tab-7/outbox/b.png");
    expect(shown().textContent).toContain("2 / 3");

    // A swipe to the left is the next (older) one; the last has no Next.
    drag(shown(), { x: 300, y: 400 }, { x: 120, y: 410 });
    expect(src()).toBe("/api/v1/tabs/tab-7/outbox/a.jpg");
    expect(within(shown()).queryByRole("button", { name: "Next picture" })).toBeNull();

    // A mostly vertical drag is not a step.
    drag(shown(), { x: 100, y: 100 }, { x: 170, y: 400 });
    expect(src()).toBe("/api/v1/tabs/tab-7/outbox/a.jpg");

    // The arrow keys step as well, and Escape still closes back to the grid.
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(src()).toBe("/api/v1/tabs/tab-7/outbox/b.png");
    fireEvent.keyDown(window, { key: "Escape" });
    screen.getByRole("dialog", { name: "Files from the agent" });
  });

  it("zooms a picture on a double tap, and a drag then pans it instead of stepping", async () => {
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "b.png", kind: "image/png", size: 2_000, modified: 200 },
      { name: "a.png", kind: "image/png", size: 1_000, modified: 100 },
    ]));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Files from the agent (2)" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Files from the agent" })).getByRole("button", { name: "Open b.png" }));
    const shown = () => screen.getByRole("dialog", { name: "b.png" });
    const img = () => shown().querySelector("img")!;
    expect(img().style.transform).toBe("");

    drag(shown(), { x: 200, y: 300 }, { x: 200, y: 300 });
    drag(shown(), { x: 202, y: 301 }, { x: 202, y: 301 });
    expect(img().style.transform).toContain("scale(2.5)");

    // Zoomed in, a sideways drag moves the picture; it does not step.
    drag(shown(), { x: 300, y: 400 }, { x: 120, y: 410 });
    expect(img().getAttribute("src")).toBe("/api/v1/tabs/tab-7/outbox/b.png");

    // A second double tap fits the picture again, and a swipe steps once more.
    drag(shown(), { x: 200, y: 300 }, { x: 200, y: 300 });
    drag(shown(), { x: 200, y: 300 }, { x: 200, y: 300 });
    expect(img().style.transform).toBe("");
    drag(shown(), { x: 300, y: 400 }, { x: 120, y: 410 });
    screen.getByRole("dialog", { name: "a.png" });
  });

  it("saves any file from its tile, the picture that has no ⋯ included", async () => {
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "run12.png", kind: "image/png", size: 48_000, modified: 200 },
      { name: "paper.pdf", kind: "application/pdf", size: 400, modified: 100 },
    ]));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Files from the agent (2)" }));
    const gallery = screen.getByRole("dialog", { name: "Files from the agent" });
    for (const name of ["run12.png", "paper.pdf"]) {
      const save = within(gallery).getByRole("link", { name: `Save ${name}` });
      expect(save.getAttribute("href")).toBe(`/api/v1/tabs/tab-7/outbox/${name}?download=1`);
      expect(save.getAttribute("download")).toBe(name);
    }
  });

  it("deletes one of the agent's files from the gallery, through this tab's scope", async () => {
    const calls: string[] = [];
    let files: unknown[] = [
      { name: "run12.png", kind: "image/png", size: 48_000, modified: 200 },
      { name: "paper.pdf", kind: "application/pdf", size: 400, modified: 100 },
    ];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files }));
      if (url.includes("/outbox/")) {
        files = (files as { name: string }[]).filter((file) => !url.endsWith(`/${file.name}`));
        return Promise.resolve(jsonResponse(200, { removed: true }));
      }
      return Promise.resolve(jsonResponse(404, { error: "not_found" }));
    }));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Files from the agent (2)" }));
    const gallery = screen.getByRole("dialog", { name: "Files from the agent" });
    fireEvent.click(within(gallery).getByRole("button", { name: "Delete run12.png" }));
    fireEvent.click(within(within(gallery).getByRole("group", { name: "Delete run12.png?" })).getByRole("button", { name: "Delete" }));
    await settle();

    expect(calls).toContain("DELETE /api/v1/tabs/tab-7/outbox/run12.png");
    expect(Array.from(gallery.querySelectorAll(".outbox-entry strong")).map((name) => name.textContent))
      .toEqual(["paper.pdf"]);
    // The button beside the tab name counts what is left.
    screen.getByRole("button", { name: "Files from the agent (1)" });
  });

  it("keeps the files out of the screen's chat, which has no times to place them by, and the button in both views", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "paper.pdf", kind: "application/pdf", size: 400, modified: 200 },
      { name: "plot.png", kind: "image/png", size: 9_000, modified: 100 },
    ]));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    expect(screen.queryAllByRole("group", { name: /^Pictures and files from the agent/ })).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Files from the agent (2)" }));
    const gallery = screen.getByRole("dialog", { name: "Files from the agent" });
    // Listed as the sidecar listed them, newest first.
    expect(Array.from(gallery.querySelectorAll(".outbox-entry strong")).map((name) => name.textContent))
      .toEqual(["paper.pdf", "plot.png"]);
    fireEvent.click(within(gallery).getByRole("button", { name: "Open paper.pdf" }));
    // An agent tab's PDF opens in the app's page view, with Mark up there.
    const viewer = await screen.findByRole("dialog", { name: "paper.pdf" });
    expect(within(viewer).getByRole("button", { name: "Mark up paper.pdf" })).toBeTruthy();
    expect(within(viewer).getByRole("link", { name: "Save" })).toBeTruthy();
    expect(within(viewer).queryByRole("button", { name: "Open paper.pdf" })).toBeNull();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(gallery).getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await settle();
    expect(screen.queryAllByRole("group", { name: /^Pictures and files from the agent/ })).toEqual([]);
    expect(screen.queryByRole("region", { name: "Files from the agent" })).toBeNull();
    screen.getByRole("button", { name: "Files from the agent (2)" });
  });
});
