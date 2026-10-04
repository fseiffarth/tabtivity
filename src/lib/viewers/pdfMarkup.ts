/**
 * The desktop PDF viewer's markup mode, the parts with no React in them
 * (`docs/pdf_markup_rounds_plan.md` §2.6): when the Mark up button shows and
 * when it is held back, where an on-disk change of the PDF goes while marks are
 * on it, which viewer of a window may mark a given file, and the typed call
 * into `pdf_markup_submit` with its refusal codes in the reader's words.
 *
 * The layer itself — marks, rounds, storage, the pill's machine — is the
 * phone's pure core in `mobile-web/src/markup/`, imported as is.
 */
import { invoke } from "@tauri-apps/api/core";
import type { TranslationKey } from "../i18n";
import type { Mark } from "../../../mobile-web/src/markup/layer";
import type { Anchor } from "../../../mobile-web/src/markup/anchors";
import { BOX_SCOPE_PREFIX } from "../terminal/ptyId";

/** The largest PDF the backend reads for a bake (`outbox::MAX_OUTBOX_FILE`,
 * what `files::read` serves). */
export const MAX_MARKUP_PDF = 24 * 1024 * 1024;

/** Why the Mark up button is not offered, or offered but held back. */
export type MarkupGate =
  | { show: false }
  | { show: true; blocked: null | "arranged" | "claimed" };

/**
 * Whether this viewer offers Mark up. Hidden — not merely disabled — where v1
 * has no answer: the root scope and boxes (no one project's agent tab to send
 * to), a remote project (the bake reads the local tree), a popout window (the
 * scheduler's hold that types the prompt in lives in the main window), and a
 * PDF past what the backend reads. Held back where it would mark the wrong
 * pages: an arrangement that is not the file's own page order, or unsaved
 * edits — sheet *i* must be file page *i*. And one viewer per file per window.
 */
export function markupGate(input: {
  scope: string | null;
  source: "remote" | "local" | "none";
  detached: boolean;
  /** The loaded file's size in bytes; `null` until a document is loaded. */
  size: number | null;
  /** The arrangement is the file's own pages, in order, unturned. */
  pristine: boolean;
  dirty: boolean;
  claimedElsewhere: boolean;
}): MarkupGate {
  const { scope } = input;
  if (!scope || scope === "root" || scope.startsWith(BOX_SCOPE_PREFIX)) return { show: false };
  if (input.source !== "none" || input.detached) return { show: false };
  if (input.size === null || input.size > MAX_MARKUP_PDF) return { show: false };
  if (!input.pristine || input.dirty) return { show: true, blocked: "arranged" };
  if (input.claimedElsewhere) return { show: true, blocked: "claimed" };
  return { show: true, blocked: null };
}

/** Where an on-disk change of the open PDF goes. */
export type DiskChange = "stale" | "markup" | "underMarks" | "reload";

/**
 * The one rule for all three ways the viewer learns its file changed — the
 * mtime poll, a compile's plain re-read request, and a SyncTeX reveal after a
 * compile. Unsaved page edits keep the stale banner they always had. Marks on
 * screen (or a round in flight) take the new pages under them on their own
 * (`underMarks`, Reload PDF's path) — the agent rebuilt the PDF the marks were
 * sent for — unless the setting turned that off (`pdf_markup_auto_reload`) or a
 * note is being typed or a Submit is going out: then the markup strip offers
 * Reload instead. Otherwise the PDF reloads as without markup.
 */
export function diskChangeAction(state: { dirty: boolean; markupHolds: boolean; autoReload?: boolean; noteOpen?: boolean }): DiskChange {
  if (state.dirty) return "stale";
  if (state.markupHolds) return state.autoReload && !state.noteOpen ? "underMarks" : "markup";
  return "reload";
}

// ── One marking viewer per file per window ────────────────────────────────
// Two panes marking one PDF would both write its one IndexedDB record, each
// over the other's strokes. Module state, so it is per window — which is the
// scope of that risk: a popout never offers Mark up.

const claims = new Map<string, string>();
const claimListeners = new Set<() => void>();
let claimVersion = 0;

function claimsChanged(): void {
  claimVersion += 1;
  for (const listener of claimListeners) listener();
}

/** Takes `key` for `owner`; `false` when another viewer holds it. */
export function claimMarkup(key: string, owner: string): boolean {
  const holder = claims.get(key);
  if (holder !== undefined && holder !== owner) return false;
  if (holder === undefined) {
    claims.set(key, owner);
    claimsChanged();
  }
  return true;
}

/** Gives `key` back — only by the viewer that holds it. */
export function releaseMarkup(key: string, owner: string): void {
  if (claims.get(key) !== owner) return;
  claims.delete(key);
  claimsChanged();
}

/** Who marks `key` in this window, if anyone. */
export function markupHolder(key: string): string | undefined {
  return claims.get(key);
}

/** For `useSyncExternalStore`: hear a claim change. */
export function subscribeMarkupClaims(listener: () => void): () => void {
  claimListeners.add(listener);
  return () => {
    claimListeners.delete(listener);
  };
}

export function markupClaimsVersion(): number {
  return claimVersion;
}

export function _clearMarkupClaimsForTest(): void {
  claims.clear();
  claimsChanged();
}

// ── The command ───────────────────────────────────────────────────────────

/** One marked page as `pdf_markup_submit` takes it: the phone's own shape,
 * with the layer PNG inline (standard base64, no `data:` prefix). */
/** One marked page for `pdf_markup_submit`: `layerPng` is the page with its
 *  marks drawn on (`composed`) or the marks alone; `anchors` the page's words
 *  each mark is on (`mobile-web/src/markup/anchors.ts`). */
export type PdfMarkupPage = { n: number; size: [number, number]; marks: Mark[]; layerPng: string; composed?: boolean; anchors?: Anchor[] };
/** `apply`: the agent makes the changes and an undo snapshot backs them;
 *  `list`: it lists them first (**Make these changes**). */
export type PdfMarkupMode = "apply" | "list";
/** `mode` is the one the round got — `apply` only with an `undo` snapshot id
 *  — and `noUndo` why an asked-for `apply` runs as `list` (the phone's codes:
 *  `not_git`, `no_git`, `too_big`, `filtered`, `git_failed`, `not_pdf`). */
export type PdfMarkupResult = { prompt: string; marked: string | null; mode?: PdfMarkupMode; undo?: string | null; noUndo?: string | null };

/**
 * Bakes the marked copy of `path` into the project's `.tabtivity/inbox/` and
 * answers the prompt to queue (`commands/pdf_markup.rs`). Rejects with the
 * backend's plain code string (see `markupReasonKey`). `mode` is what
 * Settings → PDF markup → Apply marks directly asks for.
 */
export function submitPdfMarkup(projectId: string, path: string, pages: PdfMarkupPage[], instruction?: string | null, ask?: number | null, mode?: PdfMarkupMode): Promise<PdfMarkupResult> {
  return invoke<PdfMarkupResult>("pdf_markup_submit", { projectId, path, pages, ...(instruction ? { instruction } : {}), ...(ask != null ? { ask } : {}), ...(mode ? { mode } : {}) });
}

// ── The undo of an `apply` round (`docs/pdf_markup_direct_apply_plan.md`) ──

/** What an undo would do (preview) or did: the project-relative files, how
 *  many more it did not name, and the PDF's fate. */
export type PdfMarkupUndoChanges = {
  files: { path: string; change: "added" | "modified" | "deleted" | "changed" }[];
  more: number;
  pdf: "restored" | "kept" | "none";
};
/** How the undo commands refuse: the phone's error codes (`undo_conflict`
 *  with the files changed since, `undo_gone`, `round_not_found`,
 *  `undo_not_ready`, `undo_failed`, `markup_failed`). */
export type PdfMarkupUndoFailure = { code: string; files: string[]; more: number };

/** The round's after-snapshot, each time it finishes (the last one wins). */
export function settlePdfMarkupUndo(projectId: string, undoId: string): Promise<null> {
  return invoke<null>("pdf_markup_undo_settle", { projectId, undoId });
}

/** What an undo would put back. */
export function previewPdfMarkupUndo(projectId: string, undoId: string): Promise<PdfMarkupUndoChanges> {
  return invoke<PdfMarkupUndoChanges>("pdf_markup_undo_preview", { projectId, undoId });
}

/** Puts the round's changes back — or refuses, changing nothing, with the
 *  files changed since (`undo_conflict`). */
export function runPdfMarkupUndo(projectId: string, undoId: string): Promise<PdfMarkupUndoChanges> {
  return invoke<PdfMarkupUndoChanges>("pdf_markup_undo", { projectId, undoId });
}

/** An undo command's refusal, whatever shape it arrived in. */
export function pdfMarkupUndoFailure(error: unknown): PdfMarkupUndoFailure {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    const { code, files, more } = error as { code: string; files?: unknown; more?: unknown };
    return {
      code,
      files: Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [],
      more: typeof more === "number" ? more : 0,
    };
  }
  return { code: markupErrorCode(error), files: [], more: 0 };
}

/** What a desktop Submit tells the agent after the file references, as the
 * backend's `markup::DEFAULT_INSTRUCTION` words it — the setting's starting
 * point (the phone keeps the same default, `markupInstruction.ts`). */
export { DEFAULT_MARKUP_INSTRUCTION as DEFAULT_PDF_MARKUP_INSTRUCTION, MAX_MARKUP_INSTRUCTION as MAX_PDF_MARKUP_PROMPT } from "../../../mobile-web/src/markupInstruction";
/** The same for an `apply` round (`markup::DEFAULT_APPLY_INSTRUCTION`), and
 *  the note an Undo puts into the agent's chat — worded once for both hosts. */
export { DEFAULT_MARKUP_APPLY_INSTRUCTION as DEFAULT_PDF_MARKUP_APPLY_INSTRUCTION, markupUndoNote } from "../../../mobile-web/src/markupInstruction";
import { DEFAULT_MARKUP_APPLY_INSTRUCTION, DEFAULT_MARKUP_INSTRUCTION } from "../../../mobile-web/src/markupInstruction";

/** The desktop's instruction as a Submit sends it: `null` while it is blank
 *  or either mode's default — the backend then words the round's own. */
export function pdfMarkupInstruction(value: string | undefined | null): string | null {
  const text = pdfMarkupPrompt(value);
  return text === DEFAULT_MARKUP_INSTRUCTION || text === DEFAULT_MARKUP_APPLY_INSTRUCTION ? null : text;
}
import { DEFAULT_MARKUP_ASK, MARKUP_ASK_STOPS } from "../../../mobile-web/src/markupInstruction";
export { DEFAULT_MARKUP_ASK as DEFAULT_PDF_MARKUP_ASK, MARKUP_ASK_STOPS as PDF_MARKUP_ASK_STOPS };
/** Subagent mode's wrapper (`pdf_markup_subagents`), worded once for both. */
export { markupForSubagent } from "../../../mobile-web/src/markupInstruction";

/** The desktop's asking dial as a Submit sends it: a stop 0–4, `null` at the
 * default (or for a stored value that is not a stop). */
export function pdfMarkupAsk(value: number | undefined | null): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MARKUP_ASK_STOPS && value !== DEFAULT_MARKUP_ASK ? value : null;
}

/** What **Make these changes** sends on the desktop: no `tabtivity-send` line —
 * the viewer reloads the rebuilt file from disk. */
export const DEFAULT_PDF_MARKUP_APPLY = "Make the changes you listed from my marks now: edit the sources the PDF is built from and rebuild it.";

/** A prompt setting as it is used: trimmed, `null` when blank. */
export function pdfMarkupPrompt(value: string | undefined | null): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/** A refusal's code, from whatever the call threw: the command rejects with
 * a bare code; queueing the prompt throws an `Error` whose message is one, or
 * the backend's sentence for the per-tab schedule cap. */
export function markupErrorCode(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/at most \d+ schedules/.test(text)) return "schedule_cap";
  return /^[a-z_]+$/.test(text) ? text : "other";
}

const REASONS: Record<string, TranslationKey> = {
  remote_project: "pdfMarkup.reason.remote",
  project_not_found: "pdfMarkup.reason.project",
  project_unavailable: "pdfMarkup.reason.project",
  outside_project: "pdfMarkup.reason.outside",
  hidden_path: "pdfMarkup.reason.hidden",
  file_not_found: "pdfMarkup.reason.gone",
  file_too_large: "pdfMarkup.reason.tooLarge",
  read_failed: "pdfMarkup.reason.read",
  empty_file: "pdfMarkup.reason.read",
  unsupported_source: "pdfMarkup.reason.unsupported",
  invalid_markup: "pdfMarkup.reason.invalid",
  invalid_layer: "pdfMarkup.reason.invalid",
  layer_missing: "pdfMarkup.reason.invalid",
  inbox_full: "pdfMarkup.reason.inboxFull",
  write_failed: "pdfMarkup.reason.write",
  markup_failed: "pdfMarkup.reason.failed",
  message_too_long: "pdfMarkup.reason.tooLong",
  schedule_cap: "pdfMarkup.reason.scheduleCap",
};

/** The words for a refusal code; `other` (with the code) for one this build
 * does not know. */
export function markupReasonKey(code: string): TranslationKey {
  return REASONS[code] ?? "pdfMarkup.reason.other";
}

/** A blob as standard base64, no `data:` prefix — how a layer PNG crosses IPC. */
export function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.readAsDataURL(blob);
  });
}
