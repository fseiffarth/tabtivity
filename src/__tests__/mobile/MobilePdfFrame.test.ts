/**
 * The phone's sealed PDF frame (`mobile-web/src/pdfFrame/main.ts`) against the
 * REAL pdf.js legacy build it ships with.
 *
 * The frame runs pdf.js on its own thread through `globalThis.pdfjsWorker` and
 * answers the PWA by message only. What it takes from pdf.js — the page sizes
 * it reports, the error NAME that tells an encrypted file from a broken one,
 * and the text geometry a markup question is pinned to — is pinned here
 * through the same messages the PWA sends. Painting needs a canvas jsdom does
 * not have, so `render`/`snapshot`/`text` are not covered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FromFrame } from "../../../mobile-web/src/markup/frameProtocol";
import { encryptedPdf, onePagePdf } from "../helpers/pdfFixture";

let posted: FromFrame[] = [];
let listener: EventListener | null = null;

/** The frame's entry. Through a variable: the module is type-checked by the
 *  mobile project, whose declarations (the legacy worker's) this one lacks. */
const FRAME_MODULE: string = "../../../mobile-web/src/pdfFrame/main";

/** A fresh frame: the module's state is one document per load. */
async function loadFrame(): Promise<void> {
  vi.resetModules();
  const add = vi.spyOn(window, "addEventListener");
  await import(/* @vite-ignore */ FRAME_MODULE);
  listener = add.mock.calls.find(([type]) => type === "message")?.[1] as EventListener;
  add.mockRestore();
}

/** Send the frame a message as its parent (the PWA) would, and wait for `type`. */
async function send(data: unknown, type: FromFrame["type"]): Promise<FromFrame> {
  const before = posted.length;
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));
  await vi.waitFor(() => expect(posted.slice(before).map((m) => m.type)).toContain(type));
  return posted.slice(before).find((m) => m.type === type)!;
}

/** The bytes in an ArrayBuffer of this realm — what the frame's `instanceof`
 *  check accepts (`TextEncoder` hands back another realm's buffer here). */
function buffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

beforeEach(async () => {
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message as FromFrame);
  });
  await loadFrame();
});

afterEach(() => {
  if (listener) window.removeEventListener("message", listener);
  listener = null;
  vi.restoreAllMocks();
});

describe("the sealed PDF frame", () => {
  it("says it is ready, then reports each page's size in points", async () => {
    expect(posted).toEqual([{ type: "ready" }]);
    const meta = await send({ type: "open", bytes: buffer(onePagePdf("Hello", 300, 400)) }, "meta");
    expect(meta).toEqual({ type: "meta", pages: [{ w: 300, h: 400 }] });
  });

  it("tells an encrypted file from a broken one by pdf.js's error name", async () => {
    const failed = await send({ type: "open", bytes: buffer(encryptedPdf("secret")) }, "failed");
    expect(failed).toEqual({ type: "failed", code: "encrypted" });
  });

  it("calls bytes that are no PDF at all unreadable", async () => {
    const failed = await send({ type: "open", bytes: buffer(new TextEncoder().encode("not a pdf")) }, "failed");
    expect(failed).toEqual({ type: "failed", code: "unreadable" });
  });

  it("pins a quoted phrase to its words in page points, top-left origin", async () => {
    await send({ type: "open", bytes: buffer(onePagePdf("See the results")) }, "meta");
    const found = await send({ type: "findText", id: 7, page: 1, quote: "the results" }, "found");
    expect(found).toMatchObject({ type: "found", id: 7, page: 1 });
    const rects = (found as Extract<FromFrame, { type: "found" }>).rects;
    expect(rects).toHaveLength(1);
    const [r] = rects;
    // 12pt baseline at y=700 on a 792pt page: the run's top is 792 − 700 − 0.8·12.
    expect(r.y).toBeCloseTo(792 - 700 - 9.6, 3);
    expect(r.h).toBeCloseTo(12, 3);
    // Starts after "See " and ends inside the run (Helvetica "See the results"
    // is 80 pt wide at 12 pt, from x = 72).
    expect(r.x).toBeGreaterThan(72);
    expect(r.x + r.w).toBeLessThanOrEqual(72 + 80.1);
  });
});
