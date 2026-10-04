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
import type { MarkupAnswer, MarkupQuestion } from "./markupQuestionPicks";

/** Rung by the backend (no payload) whenever an ask opens, closes or expires
 * (`services::markup_mcp::CHANGED_EVENT`). */
export const MARKUP_MCP_CHANGED = "markup-mcp-changed";

export {
  answersOf, NO_PICK, splitRecommended, toggleOption, toggleOther,
  type MarkupAnswer, type MarkupChoice, type MarkupQuestion, type QuestionPick,
} from "./markupQuestionPicks";
/** An open ask as `markup_mcp_list` gives it (`services::markup_mcp::AskView`). */
export type MarkupAsk = {
  id: string;
  /** Project-relative path it is bound to; null shows on every file. */
  file: string | null;
  fileName: string | null;
  createdAt: string;
  questions: MarkupQuestion[];
};
export type MarkupAnswered = { prompt: string; receipt: string };

/** The tab's open asks for the PDF at `path` (absolute, or project-relative
 * from the phone's bridge); every open ask of the tab without one. */
export async function listMarkupQuestions(projectId: string, scheduleTargetId: string, path?: string): Promise<MarkupAsk[]> {
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
