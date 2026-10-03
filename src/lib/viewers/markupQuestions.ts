/**
 * The markup questions MCP's window side, the parts with no React in them
 * (`docs/markup_questions_mcp_plan.md` P2): the typed calls into
 * `commands/markup_mcp.rs`, the card's picks as the answers those calls take,
 * the refusal codes in the reader's words, and where a question's pin goes on
 * its page (its `quote` found in the page's text runs, `pageText.ts`).
 *
 * An agent asks with `markup_ask`; the ask does not block it. The window lists
 * the tab's open ask for the file on screen, and an answer comes back here as
 * the prompt to queue into the tab — the same delivery as the markup Submit.
 */
import { invoke } from "@tauri-apps/api/core";
import type { TranslationKey } from "../i18n";
import { pdfPageMatches, type SyncRect, type TextItemBox } from "./tex/tex";
import { markupReasonKey } from "./pdfMarkup";

/** Rung by the backend (no payload) whenever an ask opens, closes or expires
 * (`services::markup_mcp::CHANGED_EVENT`). */
export const MARKUP_MCP_CHANGED = "markup-mcp-changed";

export type MarkupChoice = { label: string; description?: string };
export type MarkupQuestion = {
  question: string;
  header?: string;
  options: MarkupChoice[];
  multiSelect: boolean;
  /** 1-based. */
  page?: number;
  /** Words on that page the question is about. */
  quote?: string;
};
/** An open ask as `markup_mcp_list` gives it (`services::markup_mcp::AskView`). */
export type MarkupAsk = {
  id: string;
  /** Project-relative path it is bound to; null shows on every file. */
  file: string | null;
  fileName: string | null;
  createdAt: string;
  questions: MarkupQuestion[];
};
/** One question's answer: option indices and/or a typed **Other…**. */
export type MarkupAnswer = { options: number[]; other?: string };
export type MarkupAnswered = { prompt: string; receipt: string };

/** The tab's open asks for the PDF at `path` (absolute). */
export async function listMarkupQuestions(projectId: string, scheduleTargetId: string, path: string): Promise<MarkupAsk[]> {
  const rows = await invoke<MarkupAsk[] | null>("markup_mcp_list", { projectId, scheduleTargetId, path });
  return Array.isArray(rows) ? rows : [];
}

/** Closes the ask and answers the prompt to queue, with the receipt that
 * reopens it should queueing fail. */
export function answerMarkupQuestions(projectId: string, scheduleTargetId: string, askId: string, answers: MarkupAnswer[]): Promise<MarkupAnswered> {
  return invoke<MarkupAnswered>("markup_mcp_answer", { projectId, scheduleTargetId, askId, answers });
}

/** The answer's prompt never reached the tab: open the ask again. */
export function reopenMarkupQuestions(projectId: string, scheduleTargetId: string, askId: string, receipt: string): Promise<void> {
  return invoke<void>("markup_mcp_reopen", { projectId, scheduleTargetId, askId, receipt });
}

/** **Answer in chat instead**. */
export function dismissMarkupQuestions(projectId: string, scheduleTargetId: string, askId: string): Promise<void> {
  return invoke<void>("markup_mcp_dismiss", { projectId, scheduleTargetId, askId });
}

const ASK_REASONS: Record<string, TranslationKey> = {
  superseded: "pdfMarkup.questions.reason.superseded",
  answered: "pdfMarkup.questions.reason.answered",
  gone: "pdfMarkup.questions.reason.gone",
  invalid_answer: "pdfMarkup.questions.reason.invalid",
};

/** The words for an answer's refusal code — the ask's own codes first, then
 * the markup Submit's (a queue refusal such as the per-tab schedule cap). */
export function questionReasonKey(code: string): TranslationKey {
  return ASK_REASONS[code] ?? markupReasonKey(code);
}

/** The mark Claude Code asks agents to put on the option they would pick,
 * shown as a tag beside the label (the reader's `LiveQuestion` and the phone's
 * `QuestionList` do the same). */
const RECOMMENDED = /\s+\(Recommended\)$/u;

export function splitRecommended(label: string): { label: string; recommended: boolean } {
  const hit = RECOMMENDED.exec(label);
  return hit ? { label: label.slice(0, hit.index), recommended: true } : { label, recommended: false };
}

/** What the card holds for one question: the rows picked, and the typed
 * **Other…** text (`null` while Other is not chosen). */
export type QuestionPick = { options: number[]; other: string | null };

export const NO_PICK: QuestionPick = { options: [], other: null };

/** A row clicked: single-select takes it alone (dropping Other), multiSelect
 * toggles it. */
export function toggleOption(question: MarkupQuestion, pick: QuestionPick, index: number): QuestionPick {
  if (!question.multiSelect) return { options: [index], other: null };
  const options = pick.options.includes(index)
    ? pick.options.filter((i) => i !== index)
    : [...pick.options, index].sort((a, b) => a - b);
  return { ...pick, options };
}

/** **Other…** clicked: single-select drops the rows, multiSelect keeps them;
 * a second click takes it back. */
export function toggleOther(question: MarkupQuestion, pick: QuestionPick): QuestionPick {
  if (pick.other !== null) return { ...pick, other: null };
  return { options: question.multiSelect ? pick.options : [], other: "" };
}

/** The picks as `markup_mcp_answer` takes them — one per question, in order —
 * or `null` while a question has no answer or an Other… is chosen but blank. */
export function answersOf(questions: readonly MarkupQuestion[], picks: readonly QuestionPick[]): MarkupAnswer[] | null {
  const out: MarkupAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const pick = picks[i] ?? NO_PICK;
    const other = pick.other?.trim();
    if (pick.other !== null && !other) return null;
    if (pick.options.length === 0 && !other) return null;
    out.push(other ? { options: pick.options, other } : { options: pick.options });
  }
  return out;
}

/** The boxes (big points) of `quote` on `page`, from the page's text runs:
 * the whole quote, else its first six words (an agent's quote can run past
 * the end of a line the PDF broke differently). Empty when not found. */
export function quoteRects(items: TextItemBox[], page: number, quote: string): SyncRect[] {
  const text = quote.replace(/\s+/gu, " ").trim();
  if (!text) return [];
  const whole = pdfPageMatches(items, page, text, false)[0];
  if (whole?.length) return whole;
  const words = text.split(" ");
  if (words.length <= 6) return [];
  return pdfPageMatches(items, page, words.slice(0, 6).join(" "), false)[0] ?? [];
}

/** A question's badge on its page: at the quoted words (`rects`, big points),
 * or — no quote, or not found — in the page's top margin, `slot` badges in. */
export type QuestionPin = {
  askId: string;
  /** The question's index in its ask; the badge reads `?{index + 1}`. */
  index: number;
  rects: SyncRect[];
  slot: number;
};

/** Where each question of `asks` sits on `page`, given that page's text runs
 * (`null` while they are not read: every pin goes to the margin). Questions
 * without a page get no pin. */
export function pagePins(asks: readonly MarkupAsk[], page: number, items: TextItemBox[] | null): QuestionPin[] {
  const pins: QuestionPin[] = [];
  let slot = 0;
  for (const ask of asks) {
    ask.questions.forEach((question, index) => {
      if (question.page !== page) return;
      const rects = question.quote && items ? quoteRects(items, page, question.quote) : [];
      pins.push({ askId: ask.id, index, rects, slot: rects.length ? 0 : slot++ });
    });
  }
  return pins;
}
