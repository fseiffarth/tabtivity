/**
 * Approve & print claims the agent's request before anything is laid out or
 * sent (`services::print_mcp::claim`, gap 107): a request withdrawn, expired
 * or closed before the claim — or claimed by another window — never reaches
 * the printer, and a print that sent nothing gives the claim back.
 *
 * Runs the real review path (`reviewPrintRequest` → the preview → its native
 * callback) with pdf.js, the layout and the printer stubbed, and the backend
 * as a small compare-and-set model of the print store.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { invoke, layout, printNative } = vi.hoisted(() => ({
  invoke: vi.fn(),
  layout: vi.fn(),
  printNative: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../lib/viewers/pdfLoad", () => ({
  loadPdf: async () => ({ numPages: 1, loadingTask: { destroy: async () => {} } }),
}));
vi.mock("../../lib/viewers/pdfPrintLayout", () => ({ layoutPrintPdf: (...args: unknown[]) => layout(...args) }));
vi.mock("../../lib/viewers/print", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/viewers/print")>()),
  renderPdfPagesToImages: async () => ["data:image/png;base64,AAAA"],
}));
vi.mock("../../lib/window/printing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/window/printing")>()),
  printPdfNative: (...args: unknown[]) => printNative(...args),
}));

import { reviewPrintRequest } from "../../lib/viewers/printRequest";
import type { PrintRequest } from "../../lib/window/printMcp";
import { translateNow } from "../../lib/i18n";

const REQUEST: PrintRequest = {
  id: "print-1", tab: "p:abc", projectId: "proj", file: "build/report.pdf", size: 10, sha256: "x",
  options: { copies: 1, grayscale: false, booklet: false }, createdAt: "", state: "pending",
};

/** The backend's print store, for one request: claim is a compare-and-set,
 *  and a claimed request is not withdrawn (`print_cancel` → `printing`). */
let state: "pending" | "printing" | "printed" | "rejected" | "withdrawn";
/** Withdraw, as the agent's `print_cancel` would; whether it took. */
const withdraw = () => {
  if (state !== "pending") return false;
  state = "withdrawn";
  return true;
};
/** Held open by a test to land a withdrawal while the claim is on its way. */
let claimGate: Promise<void> | null;
const steps: string[] = [];

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  state = "pending";
  claimGate = null;
  steps.length = 0;
  document.body.innerHTML = "";
  layout.mockReset();
  printNative.mockReset();
  layout.mockImplementation(async () => {
    steps.push("layout");
    return new Uint8Array([1]);
  });
  printNative.mockImplementation(async () => {
    steps.push("print");
    return "opened";
  });
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: { outcome?: string }) => {
    if (cmd === "print_mcp_pdf") return new Uint8Array([37, 80, 68, 70]).buffer;
    if (cmd === "print_mcp_decide") {
      const outcome = args?.outcome ?? "";
      steps.push(outcome);
      if (outcome === "claim") {
        if (claimGate) await claimGate;
        if (state !== "pending") throw new Error("gone");
        state = "printing";
      } else if (outcome === "release") {
        if (state !== "printing") throw new Error("gone");
        state = "pending";
      } else if (outcome === "printed") {
        if (state !== "printing") throw new Error("gone");
        state = "printed";
      } else if (outcome === "rejected") {
        if (state !== "pending") throw new Error("gone");
        state = "rejected";
      }
      return undefined;
    }
    // The print queue snapshot the preview reads in the background.
    return { supported: false, backend: "none", default_printer: null, printers: [], jobs: [], note: "" };
  });
});

/** Open the review and get its preview to the point where Approve is live.
 *  (jsdom does not load `srcdoc`: the sheets are put in by hand.) */
async function openReview() {
  const closed = reviewPrintRequest(REQUEST, "Report agent");
  let frame: HTMLIFrameElement | null = null;
  for (let i = 0; i < 50 && !frame; i++) {
    await flush();
    frame = document.querySelector<HTMLIFrameElement>("iframe.print-preview-frame");
  }
  if (!frame?.contentDocument) throw new Error("no preview");
  frame.contentDocument.body.innerHTML = `<div class="print-page"><img src="data:image/png;base64,AAAA" alt=""></div>`;
  frame.onload?.(new Event("load"));
  const approve = document.querySelector<HTMLButtonElement>(".print-preview-print");
  for (let i = 0; i < 20 && approve?.disabled; i++) await flush();
  if (!approve || approve.disabled) throw new Error("Approve is not live");
  return { approve, closed };
}

const failureText = () => document.querySelector(".print-progress-text")?.textContent ?? "";

describe("Approve & print claims first", () => {
  it("prints nothing for a request withdrawn before the click", async () => {
    const { approve } = await openReview();
    expect(withdraw()).toBe(true);
    approve.click();
    await flush();
    expect(layout).not.toHaveBeenCalled();
    expect(printNative).not.toHaveBeenCalled();
    expect(failureText()).toContain(translateNow("printRequest.gone"));
  });

  it("prints nothing when the withdrawal lands while the claim is on its way", async () => {
    const { approve } = await openReview();
    const gate = deferred<void>();
    claimGate = gate.promise;
    approve.click();
    await flush();
    expect(withdraw()).toBe(true);
    gate.resolve();
    await flush();
    expect(layout).not.toHaveBeenCalled();
    expect(printNative).not.toHaveBeenCalled();
    expect(state).toBe("withdrawn");
  });

  it("claims before the layout starts, so a withdrawal during the layout cannot take", async () => {
    const held = deferred<Uint8Array>();
    layout.mockImplementation(() => {
      steps.push("layout");
      return held.promise;
    });
    const { approve } = await openReview();
    approve.click();
    await flush();
    expect(steps).toEqual(["claim", "layout"]);
    expect(withdraw()).toBe(false);
    expect((document.querySelector(".print-preview-reject") as HTMLButtonElement).disabled).toBe(true);
    held.resolve(new Uint8Array([1]));
    await flush();
    expect(printNative).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(["claim", "layout", "print", "printed"]);
    expect(state).toBe("printed");
  });

  it("a claim another window holds sends nothing here", async () => {
    const { approve } = await openReview();
    state = "printing";
    approve.click();
    await flush();
    expect(layout).not.toHaveBeenCalled();
    expect(printNative).not.toHaveBeenCalled();
    expect(steps).toEqual(["claim"]);
  });

  it("gives the claim back when the layout fails or the dialog is cancelled", async () => {
    layout.mockImplementationOnce(async () => {
      steps.push("layout");
      throw new Error("bad pdf");
    });
    const { approve } = await openReview();
    approve.click();
    await flush();
    expect(printNative).not.toHaveBeenCalled();
    expect(steps).toEqual(["claim", "layout", "release"]);
    expect(state).toBe("pending");
    // Try again; this time the user cancels the system dialog.
    printNative.mockImplementationOnce(async () => {
      steps.push("print");
      return "cancelled";
    });
    expect(approve.disabled).toBe(false);
    approve.click();
    await flush();
    expect(steps.slice(3)).toEqual(["claim", "layout", "print", "release"]);
    expect(state).toBe("pending");
    expect((document.querySelector(".print-preview-reject") as HTMLButtonElement).disabled).toBe(false);
  });
});
