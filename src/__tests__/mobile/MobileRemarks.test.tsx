/**
 * The phone PDF reader's **Annotate** (`MarkupView`, `saveRemarks`): on a
 * project PDF the desktop lets the phone write into (the listing's
 * `remarks`), highlights and notes are drawn on a layer of their own and
 * **Save** writes them into the PDF itself — the layer then clears and the
 * file loads again. A PDF changed since it was opened is refused, and the
 * marks stay. Without the switch there is no Annotate.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_LAYER, addMark, type Layer } from "../../../mobile-web/src/markup/layer";

const store = vi.hoisted(() => ({
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async () => true),
  clearLayer: vi.fn(async () => true),
  moveLayer: vi.fn(async () => true),
}));
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  ...store,
}));

import { MarkupView } from "../../../mobile-web/src/components/MarkupView";
import { writeMarkupOpen } from "../../../mobile-web/src/markupOpen";

const PDF = { name: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_790_000_000, ref: "sealed-paper" };
const HIGHLIGHT = { kind: "box" as const, color: "yellow" as const, rect: [50, 60, 200, 14] as [number, number, number, number], comment: "check this" };
const REMARKS = addMark(EMPTY_LAYER, 1, [600, 800], HIGHLIGHT);

type Call = { url: string; method: string; body?: BodyInit | null };

function desktop({ remarks = true, refuse }: { remarks?: boolean; refuse?: string } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (url.includes("/files/remarks")) {
      if (refuse) return new Response(JSON.stringify({ error: refuse }), { status: 409 });
      return new Response(JSON.stringify({ file: { token: "sealed-paper-2", name: "paper.pdf", kind: "application/pdf", size: 9_400, modified: 1_790_000_100 } }), { status: 200 });
    }
    if (url.includes("/files/raw")) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
    if (url.includes("/files")) return new Response(JSON.stringify({ entries: [], truncated: false, remarks }), { status: 200 });
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  }));
  return calls;
}

function open() {
  const { container } = render(<MarkupView projectId="p1" scope={{ files: "p1" }} file={PDF} place="docs" folder="sealed-docs" onClose={() => {}} reader={{ actions: null }} />);
  const frame = (container.querySelector("iframe.markup-frame") as HTMLIFrameElement).contentWindow!;
  const say = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: frame }));
  vi.spyOn(frame, "postMessage").mockImplementation(() => {});
  act(() => { say({ type: "ready" }); say({ type: "meta", pages: [{ w: 600, h: 800 }] }); });
}

const lastSaved = (): unknown[] | undefined => {
  const calls = store.saveLayer.mock.calls as unknown as unknown[][];
  return calls[calls.length - 1];
};

beforeEach(() => {
  localStorage.clear();
  writeMarkupOpen("reading");
  store.saveLayer.mockClear();
  store.loadLayer.mockReset();
  store.loadLayer.mockImplementation(async (key: string) =>
    key.endsWith("#remarks") ? { layer: REMARKS, fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 } : null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Annotate", () => {
  it("saves the remarks into the PDF, then clears its layer and loads the file again", async () => {
    const calls = desktop();
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Annotate paper.pdf" }));
    // Its own layer, and only the tools that become remarks.
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalledWith("p1:files:docs/paper.pdf#remarks"));
    expect(screen.queryByRole("button", { name: /^Pen/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Stamp/ })).toBeNull();
    const save = screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((call) => call.url.includes("/files/remarks"))).toBe(true));
    const post = calls.find((call) => call.url.includes("/files/remarks"))!;
    expect(post.url).toBe("/api/v1/projects/p1/files/remarks?f=sealed-paper");
    expect(post.method).toBe("POST");
    expect(JSON.parse(String(post.body))).toEqual({
      size: PDF.size,
      modified: PDF.modified,
      pages: [{ n: 1, size: [600, 800], marks: [HIGHLIGHT] }],
    });
    // The PDF holds them now: the remarks layer is emptied, under its own key,
    // stamped with the file as saved.
    await waitFor(() => expect(lastSaved()?.slice(0, 3)).toEqual(["p1:files:docs/paper.pdf#remarks", EMPTY_LAYER, { size: 9_400, modified: 1_790_000_100 }]));
    // Done goes back to reading.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(await screen.findByRole("button", { name: "Annotate paper.pdf" })).toBeTruthy();
  });

  it("keeps the remarks when the PDF changed since it was opened", async () => {
    desktop({ refuse: "file_changed" });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Annotate paper.pdf" }));
    const save = screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    store.saveLayer.mockClear();
    fireEvent.click(save);
    expect(await screen.findByText(/changed since you opened it/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload PDF" })).toBeTruthy();
    const saves = store.saveLayer.mock.calls as unknown as [string, Layer][];
    expect(saves.some(([, layer]) => layer.pages[1] === undefined)).toBe(false);
  });

  it("never writes the agent's marks under the remarks key, or back", async () => {
    desktop();
    const INK = { kind: "ink" as const, color: "red" as const, width: 2, points: [[10, 10, 0.5], [40, 30, 0.5]] as [number, number, number][] };
    const AGENT = addMark(EMPTY_LAYER, 1, [600, 800], INK);
    store.loadLayer.mockImplementation(async (key: string) => ({
      layer: key.endsWith("#remarks") ? REMARKS : AGENT, fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1,
    }));
    const { container } = render(<MarkupView tabId="t1" projectId="p1" scope={{ files: "p1" }} file={PDF} place="docs" folder="sealed-docs"
      onSend={() => "sent"} onClose={() => {}} reader={{ actions: null }} />);
    const frame = (container.querySelector("iframe.markup-frame") as HTMLIFrameElement).contentWindow!;
    vi.spyOn(frame, "postMessage").mockImplementation(() => {});
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "ready" }, origin: "null", source: frame }));
      window.dispatchEvent(new MessageEvent("message", { data: { type: "meta", pages: [{ w: 600, h: 800 }] }, origin: "null", source: frame }));
    });
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalledWith("p1:files:docs/paper.pdf"));
    fireEvent.click(await screen.findByRole("button", { name: "Annotate paper.pdf" }));
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalledWith("p1:files:docs/paper.pdf#remarks"));
    expect(screen.getByRole("button", { name: /^Save/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(store.loadLayer).toHaveBeenLastCalledWith("p1:files:docs/paper.pdf"));
    await act(async () => {});
    for (const [key, layer] of store.saveLayer.mock.calls as unknown as [string, Layer][]) {
      const marks = layer.pages[1]?.marks ?? [];
      if (key.endsWith("#remarks")) expect(marks).not.toContainEqual(INK);
      else expect(marks).not.toContainEqual(HIGHLIGHT);
    }
  });

  it("is not offered while the desktop keeps PDFs read-only", async () => {
    const calls = desktop({ remarks: false });
    open();
    await waitFor(() => expect(calls.some((call) => /\/files(\?|$)/.test(call.url))).toBe(true));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Annotate paper.pdf" })).toBeNull();
  });
});
