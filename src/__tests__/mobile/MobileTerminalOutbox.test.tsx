import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };
const NOW = 1_788_609_600; // 2026-09-04 12:00:00 UTC

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

/** A fetch that answers the outbox listing with whatever `images` holds at
 * the time of the call — the folder the agent fills between polls. */
function outboxFetch(images: () => unknown[]) {
  return vi.fn((url: string) => url.endsWith("/outbox")
    ? Promise.resolve(jsonResponse(200, { files: images() }))
    : Promise.resolve(jsonResponse(404, { error: "not_found" })));
}

describe(`${BRAND.display} Mobile reaches the files the agent sent through the gallery`, () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    localStorage.setItem(storageKey("mobile.view.agent"), "terminal");
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The gallery sheet, opened from the button beside the tab name. */
  function openGallery(count: number) {
    fireEvent.click(screen.getByRole("button", { name: `Files from the agent (${count})` }));
    return screen.getByRole("dialog", { name: "Files from the agent" });
  }

  it("lists the outbox on open, renders each image from the tab's own route, and opens one full-screen", async () => {
    const fetchMock = outboxFetch(() => [
      { name: "plot.png", kind: "image/png", size: 48_000, modified: NOW - 90 },
      { name: "shot-1.jpg", kind: "image/jpeg", size: 1_300_000, modified: NOW - 7_200 },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    // The facts row's usage read (`/status`) is not this test's concern.
    expect(fetchMock.mock.calls.map(([url]) => url).filter((url) => !url.endsWith("/status"))).toEqual(["/api/v1/tabs/tab-7/outbox"]);
    const gallery = openGallery(2);
    expect(gallery.textContent).toContain("From the agent");
    expect(gallery.textContent).toContain("2 files");
    // The thumbnails load from the sidecar's own route — same origin, the
    // session cookie is the credential — never from a path.
    const thumbs = Array.from(gallery.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(thumbs).toEqual(["/api/v1/tabs/tab-7/outbox/plot.png", "/api/v1/tabs/tab-7/outbox/shot-1.jpg"]);
    expect(gallery.textContent).toContain("2 min ago");
    expect(gallery.textContent).toContain("2 h ago");

    fireEvent.click(screen.getByRole("button", { name: "Open plot.png" }));
    const viewer = screen.getByRole("dialog", { name: "plot.png" });
    expect(viewer.querySelector("img")?.getAttribute("src")).toBe("/api/v1/tabs/tab-7/outbox/plot.png");
    expect(viewer.textContent).toContain("47 KB");
    // Closing the picture lands back on the grid it was opened from.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    screen.getByRole("dialog", { name: "Files from the agent" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows no button until something arrives, and counts what the next poll brings", async () => {
    const images: unknown[] = [];
    vi.stubGlobal("fetch", outboxFetch(() => images));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.queryByRole("button", { name: /Files from the agent/ })).toBeNull();

    images.unshift({ name: "plot.png", kind: "image/png", size: 48_000, modified: NOW - 90 });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    screen.getByRole("button", { name: "Files from the agent (1)" });

    // Coming back to the page re-reads the folder; a new picture joins the
    // gallery on its own — nothing to dismiss, nothing pushed into the chat.
    images.unshift({ name: "diagram.png", kind: "image/png", size: 9_000, modified: NOW - 5 });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    const gallery = openGallery(2);
    expect(Array.from(gallery.querySelectorAll("img")).map((img) => img.getAttribute("src")))
      .toEqual(["/api/v1/tabs/tab-7/outbox/diagram.png", "/api/v1/tabs/tab-7/outbox/plot.png"]);
  });

  it("opens text as inert text, PDFs in the app's page view, and binary files as downloads", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/outbox")
      ? jsonResponse(200, { files: [
        { name: "notes.svg", kind: "text/plain; charset=utf-8", size: 80, modified: NOW },
        { name: "paper.pdf", kind: "application/pdf", size: 400, modified: NOW },
        { name: "data.zip", kind: "application/octet-stream", size: 400, modified: NOW },
      ] }) : new Response("<svg onload='alert(1)'>inert text</svg>"))));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    openGallery(3);
    fireEvent.click(screen.getByRole("button", { name: "Open notes.svg" }));
    await settle();
    const dialog = screen.getByRole("dialog", { name: "notes.svg" });
    expect(dialog.querySelector("pre")?.textContent).toContain("<svg onload=");
    expect(dialog.querySelector("svg")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Open paper.pdf" }));
    // A PDF is drawn inside the app, never handed to the phone's viewer.
    const viewer = await screen.findByRole("dialog", { name: "paper.pdf" });
    expect(within(viewer).getByTitle("pdf")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    const link = screen.getByRole("link", { name: "Open data.zip" });
    expect(link.getAttribute("href")).toBe("/api/v1/tabs/tab-7/outbox/data.zip?download=1");
    expect(link.getAttribute("download")).toBe("data.zip");
  });

  it("shares the prepared file from the actions sheet when supported", async () => {
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "canShare", { configurable: true, value: vi.fn(() => true) });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    try {
      vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/outbox")
        ? jsonResponse(200, { files: [{ name: "data.zip", kind: "application/octet-stream", size: 4, modified: NOW }] })
        : new Response(new Uint8Array([80, 75, 0, 1])))));
      render(<Terminal tab={TAB} back={() => {}} />);
      await settle();
      openGallery(1);
      fireEvent.click(screen.getByRole("button", { name: "File actions for data.zip" }));
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Share…" }));
      await settle();
      expect(share).toHaveBeenCalledTimes(1);
      const file = (share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0];
      expect(file.name).toBe("data.zip");
      expect(file.type).toBe("application/octet-stream");
      expect(file.size).toBe(4);
    } finally {
      Reflect.deleteProperty(navigator, "canShare");
      Reflect.deleteProperty(navigator, "share");
    }
  });

  it("caps the inline text preview and reads the whole file into the app", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/outbox")
      ? jsonResponse(200, { files: [{ name: "large.log", kind: "text/plain; charset=utf-8", size: 2 * 1024 * 1024, modified: NOW }] })
      : new Response("x".repeat(2 * 1024 * 1024)))));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    openGallery(1);
    fireEvent.click(screen.getByRole("button", { name: "Open large.log" }));
    await settle();
    expect(screen.getByRole("dialog").querySelector("pre")?.textContent?.length).toBe(1024 * 1024);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Open the whole file" }));
    await waitFor(() => expect(screen.getByRole("dialog").querySelector("pre")?.textContent?.length).toBe(2 * 1024 * 1024));
    expect(screen.queryByRole("button", { name: "Open the whole file" })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a text too big for the app in the browser's tab", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/outbox")
      ? jsonResponse(200, { files: [{ name: "huge.log", kind: "text/plain; charset=utf-8", size: 9 * 1024 * 1024, modified: NOW }] })
      : new Response("x".repeat(2 * 1024 * 1024)))));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    openGallery(1);
    fireEvent.click(screen.getByRole("button", { name: "Open huge.log" }));
    await settle();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Open the whole file" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("/api/v1/tabs/tab-7/outbox/huge.log", "_blank", "noopener"));
  });

  it("never sends a text out of the iPad's Home Screen app, where there is no way back", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    try {
      vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/outbox")
        ? jsonResponse(200, { files: [{ name: "huge.log", kind: "text/plain; charset=utf-8", size: 9 * 1024 * 1024, modified: NOW }] })
        : new Response("x".repeat(2 * 1024 * 1024)))));
      render(<Terminal tab={TAB} back={() => {}} />);
      await settle();
      openGallery(1);
      fireEvent.click(screen.getByRole("button", { name: "Open huge.log" }));
      await settle();
      expect(screen.getByRole("dialog").querySelector("pre")?.textContent?.length).toBe(1024 * 1024);
      expect(screen.queryByRole("button", { name: "Open the whole file" })).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, "userAgent");
      Reflect.deleteProperty(navigator, "maxTouchPoints");
      Reflect.deleteProperty(navigator, "standalone");
    }
  });

  it("shows no gallery button for an empty or unreachable outbox", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.queryByRole("button", { name: /Files from the agent/ })).toBeNull();
  });
});
