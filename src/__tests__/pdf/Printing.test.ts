/**
 * The print manager's pure helpers (`lib/window/printing.ts`). Two things are pinned
 * here, both of them the reason the helpers exist rather than being inlined into
 * the pane:
 *
 *  1. **A state word is rendered, never guessed.** The backend maps CUPS and the
 *     Windows spooler onto one small closed set; anything else must degrade to
 *     "unknown", never to something that looks healthy. A future print system
 *     inventing a word must not be able to paint a broken printer green.
 *  2. **A queued job is always reachable.** Jobs are grouped by printer, so a job
 *     whose printer the snapshot did not list would silently vanish — and a job
 *     nobody can see is a job nobody can cancel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  followPrintJob,
  jobTitleMatches,
  printEtaSecs,
  JOB_APPEAR_TIMEOUT_MS,
  jobStateLabelKey,
  jobsFor,
  orphanJobs,
  printerStateKey,
  printerStateLabelKey,
  printerTone,
  printPdfNative,
} from "../../lib/window/printing";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { PrintJob, PrintJobState, PrintSnapshot, PrinterInfo } from "../../types/printing";
import { NAMES } from "../../lib/brand";

function printer(over: Partial<PrinterInfo> = {}): PrinterInfo {
  return {
    name: "Office",
    description: "",
    location: "",
    state: "idle",
    state_message: "",
    accepting: true,
    is_default: false,
    ...over,
  };
}

function job(over: Partial<PrintJob> = {}): PrintJob {
  return {
    id: "Office-1",
    number: 1,
    printer: "Office",
    user: "ada",
    title: "report.pdf",
    size_bytes: 1024,
    submitted: "Mon 28 Jul 2026 09:12:00 AM CEST",
    state: "pending",
    ...over,
  };
}

describe("printer state", () => {
  it("keeps the states we have wording for", () => {
    expect(printerStateKey("idle")).toBe("idle");
    expect(printerStateKey("printing")).toBe("printing");
    expect(printerStateKey("stopped")).toBe("stopped");
  });

  it("degrades an unrecognized state to unknown, not to idle", () => {
    expect(printerStateKey("toner-low-but-fine")).toBe("unknown");
    expect(printerStateKey("")).toBe("unknown");
    // The label follows the same way round: no wording is invented for a word
    // we do not know.
    expect(printerStateLabelKey(printer({ state: "brand-new-word" as never }))).toBe(
      "printing.stateUnknown",
    );
  });

  it("tones a stopped printer AND one that refuses jobs as bad", () => {
    expect(printerTone(printer())).toBe("good");
    expect(printerTone(printer({ state: "printing" }))).toBe("busy");
    expect(printerTone(printer({ state: "stopped" }))).toBe("bad");
    // The case a single status word hides: the printer says it is ready, but
    // nothing sent to it will ever come out.
    expect(printerTone(printer({ state: "idle", accepting: false }))).toBe("bad");
    expect(printerTone(printer({ state: "unknown" as never }))).toBe("unknown");
  });

  it("labels a job's state from the same closed set", () => {
    expect(jobStateLabelKey(job({ state: "printing" }))).toBe("printing.jobPrinting");
    expect(jobStateLabelKey(job({ state: "held" }))).toBe("printing.jobHeld");
    expect(jobStateLabelKey(job({ state: "pending" }))).toBe("printing.jobPending");
    expect(jobStateLabelKey(job({ state: "nonsense" as never }))).toBe("printing.stateUnknown");
  });
});

describe("grouping jobs", () => {
  const snapshot: PrintSnapshot = {
    supported: true,
    backend: "cups",
    default_printer: "Office",
    printers: [printer(), printer({ name: "Lab-Plotter" })],
    jobs: [
      job({ id: "Office-1", number: 1 }),
      job({ id: "Lab-Plotter-7", number: 7, printer: "Lab-Plotter" }),
      // A queue that was removed while its jobs were still draining.
      job({ id: "Removed-9", number: 9, printer: "Removed" }),
    ],
    note: "",
  };

  it("keeps the print system's own order within a printer", () => {
    expect(jobsFor(snapshot.jobs, "Office").map((j) => j.id)).toEqual(["Office-1"]);
    expect(jobsFor(snapshot.jobs, "Lab-Plotter").map((j) => j.id)).toEqual(["Lab-Plotter-7"]);
    expect(jobsFor(snapshot.jobs, "Nothing")).toEqual([]);
  });

  it("surfaces a job whose printer is not listed rather than dropping it", () => {
    expect(orphanJobs(snapshot).map((j) => j.id)).toEqual(["Removed-9"]);
  });

  it("reports no orphans when every job's printer is listed", () => {
    expect(orphanJobs({ ...snapshot, jobs: snapshot.jobs.slice(0, 2) })).toEqual([]);
  });
});

describe("following a print job", () => {
  const queue = (jobs: PrintJob[]): PrintSnapshot => ({
    supported: true,
    backend: "cups",
    default_printer: "Office",
    printers: [printer()],
    jobs,
    note: "",
  });
  const before = new Set(["Office-1"]);
  const theirs = job({ id: "Office-1", number: 1, title: "someone-else.odt" });

  it("waits for a job to appear, then gives up after the timeout", () => {
    expect(followPrintJob(queue([theirs]), before, [], "notes.md", 1000).progress).toEqual({
      phase: "waiting",
    });
    expect(
      followPrintJob(queue([theirs]), before, [], "notes.md", JOB_APPEAR_TIMEOUT_MS + 1).progress,
    ).toEqual({ phase: "unseen" });
  });

  it("follows the new job named like the document, counting the jobs ahead", () => {
    const stranger = job({ id: "Office-2", number: 2, title: "other-app.pdf" });
    const mine = job({ id: "Office-3", number: 3, title: "notes.md" });
    const step = followPrintJob(queue([theirs, stranger, mine]), before, [], "notes.md", 1500);
    expect(step.tracked).toEqual(["Office-3"]);
    expect(step.progress).toEqual({ phase: "queued", printer: "Office", ahead: 2 });
  });

  it("moves through printing and held, and is done once the job leaves", () => {
    const mine = (state: PrintJobState) => job({ id: "Office-3", number: 3, title: "notes.md", state });
    const tracked = ["Office-3"];
    expect(followPrintJob(queue([mine("printing")]), before, tracked, "notes.md", 0).progress)
      .toMatchObject({ phase: "printing", printer: "Office", page: null, etaSecs: null, behind: 0 });
    expect(followPrintJob(queue([mine("held")]), before, tracked, "notes.md", 0).progress)
      .toEqual({ phase: "held", printer: "Office" });
    // A stranger arriving later does not take the finished job's place.
    const later = job({ id: "Office-4", number: 4, title: "notes.md" });
    expect(followPrintJob(queue([theirs, later]), before, tracked, "notes.md", 0).progress)
      .toEqual({ phase: "done" });
  });

  it("says which page is under way, what is left, and who waits behind", () => {
    const mine = job({
      id: "Office-3",
      number: 3,
      title: "notes.md",
      state: "printing",
      pages_done: 3,
      pages_total: 12,
      printing_secs: 60,
    });
    const next = job({ id: "Office-4", number: 4, title: "other.pdf" });
    expect(followPrintJob(queue([mine, next]), before, ["Office-3"], "notes.md", 0).progress).toEqual({
      phase: "printing",
      printer: "Office",
      page: 4,
      total: 12,
      etaSecs: 180, // 20 s a page so far, nine pages to go
      behind: 1,
    });
  });

  it("takes the page count it printed when the queue has none", () => {
    const mine = job({ id: "Office-3", number: 3, state: "printing", pages_done: 1, printing_secs: 30 });
    const step = followPrintJob(queue([mine]), before, ["Office-3"], "notes.md", 0, 4);
    expect(step.progress).toMatchObject({ page: 2, total: 4, etaSecs: 90 });
    // A count past the total is counted differently: no fraction, no estimate.
    const over = { ...mine, pages_done: 9 };
    expect(followPrintJob(queue([over]), before, ["Office-3"], "notes.md", 0, 4).progress)
      .toMatchObject({ page: 10, total: null, etaSecs: null });
  });

  it("estimates nothing before a page has gone out", () => {
    expect(printEtaSecs(0, 10, 30)).toBeNull();
    expect(printEtaSecs(10, 10, 30)).toBeNull();
    expect(printEtaSecs(2, 10, 0)).toBeNull();
    expect(printEtaSecs(2, 10, 30)).toBe(120);
  });

  it("follows any new job when none carries the title", () => {
    const untitled = job({ id: "Office-5", number: 5, title: "Office-5" });
    const step = followPrintJob(queue([untitled]), before, [], "notes.md", 0);
    expect(step.tracked).toEqual(["Office-5"]);
    expect(step.progress.phase).toBe("queued");
  });

  it("matches a title lpq cut short, but not a bare fragment", () => {
    expect(jobTitleMatches("Quarterly report dra", "Quarterly report draft v2.md")).toBe(true);
    expect(jobTitleMatches("notes.md", "notes.md")).toBe(true);
    expect(jobTitleMatches("no", "notes.md")).toBe(false);
    expect(jobTitleMatches("", "notes.md")).toBe(false);
  });
});

describe("printPdfNative", () => {
  const mocked = vi.mocked(invoke);
  beforeEach(() => mocked.mockReset());

  it("sends the bytes and a title, never a path", async () => {
    mocked.mockResolvedValue("sent");
    await expect(printPdfNative(new Uint8Array([37, 80]), "a.pdf")).resolves.toBe("sent");
    expect(mocked).toHaveBeenCalledWith("print_pdf_native", {
      bytes: [37, 80],
      title: "a.pdf",
      setup: null,
    });
  });

  it("passes Windows' fire-and-forget print window through as opened", async () => {
    mocked.mockResolvedValue("opened");
    await expect(printPdfNative(new Uint8Array([1]), "a.pdf")).resolves.toBe("opened");
  });

  it("reads a closed dialog as cancelled", async () => {
    mocked.mockResolvedValue("cancelled");
    await expect(printPdfNative(new Uint8Array([1]), "a.pdf")).resolves.toBe("cancelled");
  });

  it("falls back when the platform or the running backend has no native path", async () => {
    mocked.mockRejectedValueOnce(NAMES.nativePrintUnsupported);
    await expect(printPdfNative(new Uint8Array([1]), "a.pdf")).resolves.toBe("unsupported");
    mocked.mockRejectedValueOnce("Command print_pdf_native not found");
    await expect(printPdfNative(new Uint8Array([1]), "a.pdf")).resolves.toBe("unsupported");
  });

  it("surfaces a real print failure", async () => {
    mocked.mockRejectedValueOnce("this printer does not accept PDF documents");
    await expect(printPdfNative(new Uint8Array([1]), "a.pdf")).rejects.toThrow(/accept PDF/);
  });
});
