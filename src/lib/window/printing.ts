/**
 * **The** typed invoke surface for the native print manager — one wrapper per
 * `print_*` command, plus the pure helpers its pane renders through. The
 * convention `lib/mail.ts` and `lib/browser.ts` established: no component calls
 * `invoke("print_*")` itself.
 *
 * Three properties are load-bearing rather than stylistic:
 *
 *  1. **No wrapper takes a filesystem path.** There is no print-this-file
 *     command at all — {@link printTestPage} names a printer and the *backend*
 *     writes the page it sends. Printing a document you are looking at is
 *     already the viewers' job (`lib/viewers/print.ts`, the platform print
 *     dialog); this pane manages queues, so it never needs a path and therefore
 *     never offers one.
 *  2. **Every wrapper tolerates a missing command.** {@link printSnapshot}
 *     resolves to a definite "nothing is supported" answer rather than
 *     rejecting, so a frontend running against an older backend renders its
 *     explanation instead of an empty table.
 *  3. **State words are rendered, never inferred.** The backend maps CUPS and
 *     the Windows spooler onto one small closed set; {@link printerStateKey}
 *     degrades an unrecognized value to "unknown" rather than to something that
 *     looks healthy.
 */

import { invoke } from "@tauri-apps/api/core";
import type { PrintJob, PrintJobState, PrintSnapshot, PrinterInfo, PrinterState } from "../../types/printing";
import type { TranslationKey } from "../i18n";
// One byte formatter, not two: a queued job's size reads exactly like a mail
// attachment's, and the mail module is where that definition already lives.
import { formatSize } from "../mail";
import { NAMES } from "../brand";

export { formatSize };

/** The answer a machine with no reachable print system gets. Also what a
 *  rejected invoke degrades to — a build whose backend predates this feature is
 *  in the same situation as a container with no CUPS, and should say so. */
const NO_PRINT_SYSTEM: PrintSnapshot = {
  supported: false,
  backend: "none",
  default_printer: null,
  printers: [],
  jobs: [],
  note: "",
};

/** One reading of the machine's printers and queues. Resolves, never rejects. */
export async function printSnapshot(): Promise<PrintSnapshot> {
  try {
    return await invoke<PrintSnapshot>("print_system_snapshot");
  } catch {
    return NO_PRINT_SYSTEM;
  }
}

/** What a native PDF print came to. `opened` is Windows: the print window owns
 *  the rest and reports nothing back. `unsupported` means this platform (or an
 *  older backend without the command) has no native path — the caller prints
 *  through its own preview instead. */
export type NativePdfPrint = "sent" | "cancelled" | "opened" | "unsupported";

/** What the system print dialog opens preset to (Linux; ignored elsewhere): the
 *  paper the document was laid out on, and colour off for a grayscale job — the
 *  one print-preview option a vector PDF cannot carry in itself. */
export interface NativePrintSetup {
  paper: string;
  grayscale: boolean;
}

/**
 * Print a PDF the way a PDF app does: the system print dialog, then the PDF
 * itself goes to the printer — vector text, not the raster the in-app preview
 * has to print (`commands/print_native.rs`: GTK on Linux, WebView2's PDF
 * engine on Windows, PDFKit on macOS). Takes the document's BYTES, never a
 * path (rule 1 above). Rejects only on a real print failure.
 */
export async function printPdfNative(
  bytes: Uint8Array,
  title: string,
  setup?: NativePrintSetup,
): Promise<NativePdfPrint> {
  try {
    const outcome = await invoke<string>("print_pdf_native", {
      bytes: Array.from(bytes),
      title,
      setup: setup ?? null,
    });
    return outcome === "sent" || outcome === "opened" ? outcome : "cancelled";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === NAMES.nativePrintUnsupported || /print_pdf_native.*not found/i.test(msg)) {
      return "unsupported";
    }
    throw new Error(msg);
  }
}

/** Cancel one job. `printer` is only read by the Windows backend (its API needs
 *  the queue as well as the id); CUPS cancels by id alone. */
export function printJobCancel(printer: string, jobId: string): Promise<void> {
  return invoke<void>("print_job_cancel", { printer, jobId });
}

/** Cancel everything queued on one printer. */
export function printJobsCancelAll(printer: string): Promise<void> {
  return invoke<void>("print_jobs_cancel_all", { printer });
}

/** Make this the default printer (the *user's* default — no elevation). */
export function printSetDefault(printer: string): Promise<void> {
  return invoke<void>("print_set_default", { printer });
}

/**
 * Resume (`true`) or pause (`false`) a printer's queue. The one action here
 * that commonly needs rights the user may not have — CUPS answers "Forbidden"
 * outside the `lpadmin` group — so its rejection carries the print system's own
 * words and the pane shows them verbatim.
 */
export function printSetEnabled(printer: string, enabled: boolean): Promise<void> {
  return invoke<void>("print_set_enabled", { printer, enabled });
}

/** Send a short text page, so "is this thing connected?" has an answer that
 *  does not involve finding a document first. */
export function printTestPage(printer: string): Promise<void> {
  return invoke<void>("print_test_page", { printer });
}

// ── Pure render helpers ──────────────────────────────────────────────────────

const PRINTER_STATES: readonly PrinterState[] = ["idle", "printing", "stopped", "unknown"];
const JOB_STATES: readonly PrintJobState[] = ["printing", "pending", "held", "unknown"];

/** Narrow a backend state word to the set we have wording and a tone for. An
 *  unrecognized value becomes `unknown` — the direction that admits ignorance,
 *  never `idle`, which would paint a broken printer green. */
export function printerStateKey(state: string): PrinterState {
  return (PRINTER_STATES as readonly string[]).includes(state)
    ? (state as PrinterState)
    : "unknown";
}

export function jobStateKey(state: string): PrintJobState {
  return (JOB_STATES as readonly string[]).includes(state) ? (state as PrintJobState) : "unknown";
}

/** The lamp tone for a printer row. A queue that is stopped **or** refusing new
 *  jobs is "bad": both mean nothing the user sends will come out, and a printer
 *  that is merely not accepting is the case a green dot would hide. */
export function printerTone(printer: PrinterInfo): "good" | "busy" | "bad" | "unknown" {
  const state = printerStateKey(printer.state);
  if (state === "stopped" || !printer.accepting) return "bad";
  if (state === "printing") return "busy";
  if (state === "idle") return "good";
  return "unknown";
}

/** The i18n key for a printer's state word. */
export function printerStateLabelKey(printer: PrinterInfo): TranslationKey {
  const state = printerStateKey(printer.state);
  if (state === "stopped") return "printing.statePaused";
  if (state === "printing") return "printing.statePrinting";
  if (state === "idle") return "printing.stateIdle";
  return "printing.stateUnknown";
}

/** The i18n key for a job's state word. */
export function jobStateLabelKey(job: PrintJob): TranslationKey {
  const state = jobStateKey(job.state);
  if (state === "printing") return "printing.jobPrinting";
  if (state === "held") return "printing.jobHeld";
  if (state === "pending") return "printing.jobPending";
  return "printing.stateUnknown";
}

/** Jobs queued on one printer, in the order the print system reported them
 *  (queue order — deliberately not re-sorted, since that IS the information). */
export function jobsFor(jobs: PrintJob[], printer: string): PrintJob[] {
  return jobs.filter((job) => job.printer === printer);
}

/**
 * Jobs the snapshot listed against a printer it did not list — a real CUPS
 * state (a queue removed while its jobs drain, or a job whose id could not be
 * split back into a printer name). They are shown in their own group rather
 * than dropped: a job nobody can see is a job nobody can cancel.
 */
export function orphanJobs(snapshot: PrintSnapshot): PrintJob[] {
  const known = new Set(snapshot.printers.map((p) => p.name));
  return snapshot.jobs.filter((job) => !known.has(job.printer));
}

// ── Following one print job ──────────────────────────────────────────────────
// The print preview hands its document to the platform dialog, which submits
// the job itself and reports nothing back. What the preview CAN see is the
// queue, so it follows its job there: a job that was not in the queue before
// Print, preferably one carrying the document's title.

/** Where a submitted job is, as far as the queue shows it. */
export type PrintProgress =
  | { phase: "waiting" }
  | { phase: "queued"; printer: string; ahead: number }
  | {
      phase: "printing";
      printer: string;
      /** The page under way (1-based), when the print system counts pages. */
      page: number | null;
      total: number | null;
      /** Seconds left at the pace so far; null until a page has gone out. */
      etaSecs: number | null;
      /** Jobs queued on the same printer after this one. */
      behind: number;
    }
  | { phase: "held"; printer: string }
  /** The job left the queue — printed, or cancelled elsewhere; the queue does
   *  not say which, so the wording must not claim paper. */
  | { phase: "done" }
  /** No new job ever appeared: saved to a file, cancelled in the dialog, or
   *  through the queue before the first look. */
  | { phase: "unseen" };

/** How long after Print a job may take to show up before we stop looking. */
export const JOB_APPEAR_TIMEOUT_MS = 90_000;

/**
 * Whether a queued job's title names this document. `lpq` cuts its file column
 * short, so a job title that is a long enough prefix of the document's counts
 * too; a job whose title could not be recovered carries its id and matches
 * nothing, which leaves the caller's fallback to decide.
 */
export function jobTitleMatches(jobTitle: string, docTitle: string): boolean {
  const job = jobTitle.trim().toLowerCase();
  const doc = docTitle.trim().toLowerCase();
  if (!job || !doc) return false;
  return job.startsWith(doc) || (job.length >= 8 && doc.startsWith(job));
}

/**
 * Seconds left for a job `done` pages into `total`, `elapsedSecs` after it
 * started: the pace so far, carried over the pages still to go. Nothing until a
 * page has gone out — a pace measured over zero pages is the warm-up, not the
 * printer.
 */
export function printEtaSecs(done: number, total: number, elapsedSecs: number): number | null {
  if (!(done >= 1) || !(total > done) || !(elapsedSecs > 0)) return null;
  return Math.round((elapsedSecs / done) * (total - done));
}

/**
 * One step of following a job: given a fresh queue reading, the job ids that
 * existed before Print (`baseline`) and the ids already being followed, say
 * where the job is. Once a job has been picked it stays picked — a later
 * stranger in the queue does not take its place.
 *
 * With no title match among the new jobs, every new job is followed: the title
 * is a preference, not a requirement, because a job whose `lpq` line did not
 * parse must still be followed rather than reported as unseen.
 *
 * `expectedPages` is the page count the caller put into the job, used when the
 * print system does not report one (CUPS often does not).
 */
export function followPrintJob(
  snapshot: PrintSnapshot,
  baseline: ReadonlySet<string>,
  tracked: readonly string[],
  docTitle: string,
  elapsedMs: number,
  expectedPages: number | null = null,
): { progress: PrintProgress; tracked: string[] } {
  let ids = [...tracked];
  if (ids.length === 0) {
    const fresh = snapshot.jobs.filter((job) => !baseline.has(job.id));
    const named = fresh.filter((job) => jobTitleMatches(job.title, docTitle));
    ids = (named.length > 0 ? named : fresh).map((job) => job.id);
    if (ids.length === 0) {
      return {
        progress: { phase: elapsedMs > JOB_APPEAR_TIMEOUT_MS ? "unseen" : "waiting" },
        tracked: [],
      };
    }
  }
  const live = snapshot.jobs.filter((job) => ids.includes(job.id));
  if (live.length === 0) return { progress: { phase: "done" }, tracked: ids };

  const printing = live.find((job) => jobStateKey(job.state) === "printing");
  if (printing) {
    const queue = jobsFor(snapshot.jobs, printing.printer);
    const done = printing.pages_done ?? null;
    let total = printing.pages_total ?? expectedPages ?? null;
    // More pages out than the job has means they are counted differently
    // (n-up, duplex sheets): there is no honest fraction left to show.
    if (total !== null && done !== null && done > total) total = null;
    const page = done === null ? null : total === null ? done + 1 : Math.min(done + 1, total);
    const secs = printing.printing_secs ?? null;
    return {
      progress: {
        phase: "printing",
        printer: printing.printer,
        page,
        total,
        etaSecs: done !== null && total !== null && secs !== null ? printEtaSecs(done, total, secs) : null,
        behind: Math.max(0, queue.length - 1 - queue.findIndex((job) => job.id === printing.id)),
      },
      tracked: ids,
    };
  }
  const held = live.find((job) => jobStateKey(job.state) === "held");
  if (held) return { progress: { phase: "held", printer: held.printer }, tracked: ids };
  const first = live[0];
  const ahead = jobsFor(snapshot.jobs, first.printer).findIndex((job) => job.id === first.id);
  return {
    progress: { phase: "queued", printer: first.printer, ahead: Math.max(0, ahead) },
    tracked: ids,
  };
}
