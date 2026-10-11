/**
 * Print in the phone's file viewer (`print.ts`): a picture, a text or a PDF's
 * pages laid out in a `.print-root` beside the app, then the browser's own
 * dialog; everything goes again once the dialog closes. A PDF's pages are
 * drawn afresh by the sealed frame at paper width. The iPhone/iPad Home
 * Screen app gets no Print — Share → Print does it there.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shots = vi.hoisted(() => ({ made: 0 }));
vi.mock("../../../mobile-web/src/print", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/print")>()),
  // jsdom draws no canvas: each page stands in as a numbered picture.
  bitmapDataUrl: vi.fn(async (bitmap: ImageBitmap) => { bitmap.close(); return `data:image/png;base64,page${++shots.made}`; }),
}));
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  loadLayer: vi.fn(async () => null),
  saveLayer: vi.fn(async () => true),
}));

import { canPrint, clearPrint, MAX_PRINT_PAGES, PRINT_WIDTH, printContent } from "../../../mobile-web/src/print";
import { OutboxViewer } from "../../../mobile-web/src/components/OutboxViewer";
import { MarkupView } from "../../../mobile-web/src/components/MarkupView";

const PICTURE = { name: "20261001-120000-plot.png", original: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000 };
const TEXT = { name: "notes.txt", kind: "text/plain; charset=utf-8", size: 11, modified: 1_790_000_000 };
const PDF = { name: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_790_000_000 };

class FakeBitmap {
  width = PRINT_WIDTH;
  height = 2_000;
  close = vi.fn();
}

let print: ReturnType<typeof vi.fn>;
const root = () => document.querySelector(".print-root");

beforeEach(() => {
  shots.made = 0;
  print = vi.fn();
  vi.stubGlobal("print", print);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => new Response(String(input).includes("notes") ? "hello world" : new Uint8Array([37, 80, 68, 70]), { status: 200 })));
});
afterEach(() => {
  cleanup();
  clearPrint();
  vi.unstubAllGlobals();
});

describe("printContent", () => {
  it("lays the text out beside the app, names the job, and clears up after the dialog", async () => {
    document.title = "App";
    await printContent({ text: "line one\nline two" }, "notes.txt");
    expect(print).toHaveBeenCalledTimes(1);
    expect(root()?.parentElement).toBe(document.body);
    expect(root()?.querySelector("pre")?.textContent).toBe("line one\nline two");
    expect(document.title).toBe("notes.txt");
    window.dispatchEvent(new Event("afterprint"));
    expect(root()).toBeNull();
    expect(document.title).toBe("App");
  });

  it("puts each picture on a sheet of its own, and a new print replaces one still up", async () => {
    await printContent({ text: "first" }, "a");
    await printContent({ pictures: ["data:image/png;base64,a", "data:image/png;base64,b"] }, "b");
    expect(document.querySelectorAll(".print-root")).toHaveLength(1);
    expect([...document.querySelectorAll(".print-page img")].map((img) => img.getAttribute("src")))
      .toEqual(["data:image/png;base64,a", "data:image/png;base64,b"]);
  });

  it("offers no Print in the iPhone's Home Screen app, but does in its browser", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5, standalone: true });
    expect(canPrint()).toBe(false);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5, standalone: false });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(canPrint()).toBe(true);
  });
});

describe("OutboxViewer · Print", () => {
  it("prints the picture on show", async () => {
    render(<OutboxViewer scope={{ tab: "t1" }} file={PICTURE} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Print plot.png" }));
    await waitFor(() => expect(print).toHaveBeenCalled());
    expect(root()?.querySelector("img")?.getAttribute("src")).toBe((screen.getByAltText("plot.png") as HTMLImageElement).getAttribute("src"));
  });

  it("prints a text once it is read in, and only the whole of it", async () => {
    const { rerender } = render(<OutboxViewer scope={{ tab: "t1" }} file={TEXT} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Print notes.txt" }));
    await waitFor(() => expect(print).toHaveBeenCalled());
    expect(root()?.querySelector("pre")?.textContent).toBe("hello world");
    window.dispatchEvent(new Event("afterprint"));
    // Longer than the preview reads in: no Print until Open the whole file.
    rerender(<OutboxViewer scope={{ tab: "t1" }} file={{ ...TEXT, size: 2 * 1024 * 1024 }} onClose={() => {}} />);
    await screen.findByText("hello world");
    expect(screen.queryByRole("button", { name: /^Print/ })).toBeNull();
  });

  it("takes a print still up away with the viewer", async () => {
    const { unmount } = render(<OutboxViewer scope={{ tab: "t1" }} file={PICTURE} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Print plot.png" }));
    await waitFor(() => expect(root()).not.toBeNull());
    unmount();
    expect(root()).toBeNull();
  });
});

describe("MarkupView · Print", () => {
  function openPdf(pages: number) {
    vi.stubGlobal("ImageBitmap", FakeBitmap);
    const { container } = render(<MarkupView projectId="p1" scope={{ tab: "t1" }} file={PDF} onClose={() => {}} reader={{ actions: null }} />);
    const frame = (container.querySelector("iframe.markup-frame") as HTMLIFrameElement).contentWindow!;
    const say = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: frame }));
    const asked: { type: string; id?: number; n?: number; width?: number }[] = [];
    vi.spyOn(frame, "postMessage").mockImplementation((message: unknown) => { asked.push(message as (typeof asked)[number]); });
    act(() => { say({ type: "ready" }); say({ type: "meta", pages: Array.from({ length: pages }, () => ({ w: 600, h: 800 })) }); });
    return { say, asked };
  }

  it("draws every page afresh at paper width, then prints them in order", async () => {
    const { say, asked } = openPdf(2);
    fireEvent.click(await screen.findByRole("button", { name: "Print paper.pdf" }));
    for (const n of [1, 2]) {
      await waitFor(() => expect(asked.filter((m) => m.type === "snapshot")).toHaveLength(n));
      const ask = asked.filter((m) => m.type === "snapshot")[n - 1];
      expect(ask).toMatchObject({ n, width: PRINT_WIDTH });
      expect(screen.getByRole("status").textContent).toContain(`Preparing page ${n} of 2`);
      act(() => say({ type: "snapshot", id: ask.id, n, bitmap: new FakeBitmap() }));
    }
    await waitFor(() => expect(print).toHaveBeenCalled());
    expect([...document.querySelectorAll(".print-page img")].map((img) => img.getAttribute("src")))
      .toEqual(["data:image/png;base64,page1", "data:image/png;base64,page2"]);
  });

  it("says so when a page cannot be drawn, and prints nothing", async () => {
    const { say, asked } = openPdf(1);
    fireEvent.click(await screen.findByRole("button", { name: "Print paper.pdf" }));
    await waitFor(() => expect(asked.some((m) => m.type === "snapshot")).toBe(true));
    const ask = asked.find((m) => m.type === "snapshot")!;
    act(() => say({ type: "snapshot", id: ask.id, n: 1 }));
    expect(await screen.findByText(/could not be prepared for printing/)).toBeTruthy();
    expect(print).not.toHaveBeenCalled();
  });

  it("leaves a PDF too long for the phone to the PDF app", async () => {
    const { asked } = openPdf(MAX_PRINT_PAGES + 1);
    fireEvent.click(await screen.findByRole("button", { name: "Print paper.pdf" }));
    expect(await screen.findByText(new RegExp(`up to ${MAX_PRINT_PAGES} pages`))).toBeTruthy();
    expect(asked.some((m) => m.type === "snapshot")).toBe(false);
  });
});
