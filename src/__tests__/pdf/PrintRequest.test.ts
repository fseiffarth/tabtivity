/**
 * Agent print requests (`services::print_mcp`) on the window side: the
 * agent's options as preview options, the summary line, and the preview's
 * approval mode — titled with the asking tab, its note shown as text, Reject
 * deciding and closing, and the agent's options never saved as the user's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { printDocument, buildPrintDoc, loadPrintOptions, type PrintApproval } from "../../lib/viewers/print";
import { presetFor, reviewFailure } from "../../lib/viewers/printRequest";
import { optionsSummary } from "../../components/printing/PrintRequests";
import { decidePrintRequest, printRequests, type PrintRequest } from "../../lib/window/printMcp";
import { translateNow } from "../../lib/i18n";

function request(patch: Partial<PrintRequest["options"]> = {}): PrintRequest {
  return {
    id: "print-1", tab: "p:abc", projectId: "proj", file: "build/report.pdf", size: 10, sha256: "x",
    options: { copies: 1, grayscale: false, booklet: false, ...patch }, createdAt: "", state: "pending",
  };
}

describe("the agent's options", () => {
  it("become a custom range, copies and grayscale for this job", () => {
    expect(presetFor(request({ copies: 3, pages: "1-2, 5", grayscale: true }).options))
      .toEqual({ copies: 3, grayscale: true, pages: "custom", range: "1-2, 5" });
    expect(presetFor(request().options)).toEqual({ copies: 1, grayscale: false, pages: "all", range: "" });
  });

  it("read as one line", () => {
    const t = (key: Parameters<typeof translateNow>[0], params?: Record<string, string | number>) => translateNow(key, params);
    expect(optionsSummary(request({ copies: 2, pages: "1-3", duplex: "long", pagesPerSheet: 4 }), t))
      .toBe("2× · pages 1-3 · 4 per sheet · two-sided (long edge)");
    expect(optionsSummary(request({ booklet: true, pagesPerSheet: 2, grayscale: true }), t))
      .toBe("1× · all pages · grayscale · booklet");
  });

  it("a request that ended reads as no longer waiting", () => {
    expect(reviewFailure(new Error("gone"))).toBe(translateNow("printRequest.gone"));
  });
});

describe("the invoke surface", () => {
  beforeEach(() => invoke.mockReset());

  it("lists nothing on a backend without the command", async () => {
    invoke.mockRejectedValueOnce(new Error("command print_mcp_requests not found"));
    expect(await printRequests()).toEqual([]);
  });

  it("decides by id and outcome", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await decidePrintRequest("print-9", "rejected");
    expect(invoke).toHaveBeenCalledWith("print_mcp_decide", { id: "print-9", outcome: "rejected" });
  });
});

describe("the preview's approval mode", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ supported: false, backend: "none", default_printer: null, printers: [], jobs: [], note: "" });
    document.body.innerHTML = "";
  });

  function approval(patch: Partial<PrintApproval> = {}): PrintApproval {
    return {
      requester: "Report agent",
      note: "<b>for the meeting</b>",
      preset: { copies: 4 },
      stillPending: vi.fn(async () => true),
      onPrinted: vi.fn(async () => {}),
      onReject: vi.fn(async () => {}),
      ...patch,
    };
  }

  it("names the asking tab, shows the note as text and offers Reject", () => {
    void printDocument(buildPrintDoc("<p>x</p>", ""), undefined, approval());
    expect(document.querySelector(".print-preview-title")?.textContent)
      .toBe(translateNow("printRequest.title", { who: "Report agent" }));
    const line = document.querySelector(".print-preview-request");
    expect(line?.textContent).toContain("<b>for the meeting</b>");
    expect(line?.querySelector("b")).toBeNull();
    expect(document.querySelector(".print-preview-reject")?.textContent).toBe(translateNow("printRequest.reject"));
  });

  it("Reject records the decision and closes the preview", async () => {
    const a = approval();
    const closed = printDocument(buildPrintDoc("<p>x</p>", ""), undefined, a);
    (document.querySelector(".print-preview-reject") as HTMLButtonElement).click();
    await closed;
    expect(a.onReject).toHaveBeenCalledTimes(1);
    expect(a.onPrinted).not.toHaveBeenCalled();
    expect(document.querySelector(".print-preview-dialog")).toBeNull();
  });

  it("a plain preview has no request line and no Reject", () => {
    void printDocument(buildPrintDoc("<p>x</p>", ""));
    expect(document.querySelector(".print-preview-request")).toBeNull();
    expect(document.querySelector(".print-preview-reject")).toBeNull();
    expect(document.querySelector(".print-preview-title")?.textContent).toBe(translateNow("print.title"));
  });

  it("never saves the agent's options as the user's", () => {
    const before = loadPrintOptions("flow");
    void printDocument(buildPrintDoc("<p>x</p>", ""), undefined, approval({ preset: { copies: 7 } }));
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    frame.onload?.(new Event("load"));
    expect(loadPrintOptions("flow")).toEqual(before);
  });
});
