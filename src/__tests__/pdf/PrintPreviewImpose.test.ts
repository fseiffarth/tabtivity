/**
 * The preview's own DOM under imposition: `printDocument` wraps the arranged
 * pages into `.app-sheet` wrappers (the sheet a printer would get), in the plan's
 * order, copies and all — and takes them apart again when imposition goes off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPrintDoc, printDocument, IMAGE_PRINT_CSS, savePrintOptions, PAGED_PRINT_OPTIONS } from "../../lib/viewers/print";
import type { NativePrint } from "../../lib/viewers/print";

// The queue reading the preview takes at open: no print system here.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.reject(new Error("no print system"))) }));

// jsdom does not load a frame's `srcdoc`: write it in and fire `load` ourselves.
Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", {
  configurable: true,
  set(this: HTMLIFrameElement, html: string) {
    setTimeout(() => {
      const d = this.contentDocument!;
      d.open();
      d.write(html);
      d.close();
      this.dispatchEvent(new Event("load"));
    }, 0);
  },
});

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

const pagesHtml = (n: number) =>
  Array.from({ length: n }, (_, i) => `<div class="print-page" id="p${i + 1}"><img src="${PIXEL}" alt=""></div>`).join("");

async function open(n: number, native?: NativePrint) {
  const closed = printDocument(buildPrintDoc(pagesHtml(n), IMAGE_PRINT_CSS, "t"), native);
  const iframe = document.querySelector<HTMLIFrameElement>(".print-preview-frame")!;
  await new Promise<void>((resolve) => iframe.addEventListener("load", () => resolve(), { once: true }));
  // Past the image-decode round the preview waits for before it is ready.
  await new Promise((r) => setTimeout(r, 30));
  return { closed, doc: iframe.contentDocument!, iframe };
}

const select = (label: string) =>
  Array.from(document.querySelectorAll<HTMLLabelElement>(".print-opt")).find(
    (l) => l.querySelector(".print-opt-label")?.textContent === label,
  )!;

const choose = (label: string, value: string) => {
  const el = select(label).querySelector("select")!;
  el.value = value;
  el.dispatchEvent(new Event("change"));
};

const sheets = (doc: Document) =>
  Array.from(doc.querySelectorAll(".app-sheet")).map((s) =>
    Array.from(s.children).map((c) => (c.classList.contains("app-blank") ? "_" : c.id.replace("p", ""))).join(","),
  );

beforeEach(() => {
  localStorage.clear();
  savePrintOptions({ ...PAGED_PRINT_OPTIONS }, "page");
});
afterEach(() => {
  document.querySelectorAll(".print-preview-backdrop").forEach((el) => el.remove());
});

describe("printDocument under imposition", () => {
  it("wraps the pages of an N-up into sheets, in reading order", async () => {
    const { doc } = await open(5);
    expect(sheets(doc)).toEqual([]);
    choose("Pages per sheet", "4");
    expect(sheets(doc)).toEqual(["1,2,3,4", "5,_,_,_"]);
    choose("Pages per sheet", "1");
    expect(sheets(doc)).toEqual([]);
    // The pages are back in the document, directly, in order.
    expect(Array.from(doc.querySelectorAll(".print-page")).map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("folds a booklet, pads it, and forces landscape and short-edge duplex", async () => {
    const { doc } = await open(5, async () => "sent");
    const bookletBox = select("Booklet").querySelector("input")!;
    bookletBox.checked = true;
    bookletBox.dispatchEvent(new Event("change"));
    expect(sheets(doc)).toEqual(["_,1", "2,_", "_,3", "4,5"]);
    expect(select("Pages per sheet").querySelector("select")!.disabled).toBe(true);
    expect(select("Layout").querySelector("select")!.value).toBe("landscape");
    expect(select("Two-sided").querySelector("select")!.value).toBe("short");
    // Switching it off restores what it displaced.
    bookletBox.checked = false;
    bookletBox.dispatchEvent(new Event("change"));
    expect(sheets(doc)).toEqual([]);
    expect(select("Two-sided").querySelector("select")!.value).toBe("none");
  });

  it("repeats the imposed sheets per copy", async () => {
    const { doc } = await open(3);
    choose("Pages per sheet", "2");
    const copies = select("Copies").querySelector("input")!;
    copies.value = "2";
    copies.dispatchEvent(new Event("change"));
    expect(sheets(doc)).toEqual(["1,2", "3,_", "1,2", "3,_"]);
  });

  it("applies the page selection before it imposes", async () => {
    const { doc } = await open(6);
    choose("Pages", "odd");
    choose("Pages per sheet", "2");
    expect(sheets(doc)).toEqual(["1,3", "5,_"]);
  });

  it("offers two-sided printing only where a native print path exists", async () => {
    await open(2);
    expect(select("Two-sided").querySelector("select")!.disabled).toBe(true);
    document.querySelectorAll(".print-preview-backdrop").forEach((el) => el.remove());
    await open(2, async () => "sent");
    expect(select("Two-sided").querySelector("select")!.disabled).toBe(false);
  });
});
