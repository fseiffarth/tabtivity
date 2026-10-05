import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import {
  answersOf, NO_PICK, toggleOption, toggleOther, type MarkupQuestion, type QuestionPick,
} from "../../../src/lib/viewers/markupQuestionPicks";
import { answerMarkupQuestions, ApiError, dismissMarkupQuestions, type PhoneMarkupAsk, type PhoneMarkupQuestion } from "../api";
import { AGENT_STATUS_GLYPH } from "./AgentStatusPill";
import { QuestionRows, type QuestionRow } from "./QuestionRows";

/** The longest typed **Other…** answer (`markup_mcp::MAX_OTHER_CHARS`). */
const MAX_OTHER = 500;
/** The Other… row's key among a question's option indices. */
const OTHER = "other";
/** How long a card that just opened for a new ask takes no taps: the reader
 * may be mid-stroke where it lands, and a pen or finger already on its way
 * down must not pick or send for them. */
export const ARRIVAL_GUARD_MS = 1_200;

/** Why the desktop did not take an answer, in the reader's words. */
const REASONS: Record<string, TranslationKey> = {
  superseded: "mobile.markup.questions.reason.superseded",
  answered: "mobile.markup.questions.reason.answered",
  gone: "mobile.markup.questions.reason.gone",
  invalid_answer: "mobile.markup.questions.reason.invalid",
  delivery_failed: "mobile.markup.questions.reason.deliveryFailed",
  not_delivered: "mobile.markup.questions.reason.notDelivered",
  desktop_unavailable: "mobile.markup.reason.desktop",
  offline: "mobile.markup.reason.offline",
  timeout: "mobile.markup.reason.timeout",
};

/** The pick model's view of a phone question (`markupQuestionPicks.ts`). */
export function pickQuestion(question: PhoneMarkupQuestion): MarkupQuestion {
  return { question: question.question, header: question.header, options: question.options, multiSelect: question.multi_select, page: question.page, quote: question.quote };
}

/** Which question a pin asked the card to show, and a nonce so the same pin
 * tapped twice scrolls twice. */
export type QuestionFocus = { askId: string; index: number; nonce: number };

/**
 * The agent's markup questions (`markup_ask`, `docs/markup_questions_mcp_plan.md`
 * P3), docked above the markup palette: a collapsible card, "The agent asks
 * · n", that opens by itself when a new ask arrives. Its rows are the Focus
 * list's (`QuestionRows`), so the two read alike. Rows are picked (ticked for
 * multiSelect) and only **Send answers** sends — never a single tap, even for
 * one single-select question: the card opens under a pen that is busy
 * marking, and a stroke landing on a row must not answer. For the same reason
 * it takes no taps for `ARRIVAL_GUARD_MS` after a new ask opened it. **Other…** takes typed words; **Answer in chat
 * instead** closes the ask. An ask of several questions shows one at a time,
 * paged with ‹ › (the Focus list's stepped tab row); a pin turns to its page. The desktop builds the prompt and queues it into
 * the tab — the phone sends only the picks — and a failed delivery leaves the
 * card open (the desktop reopened the ask).
 */
export function MarkupQuestionsCard({ tabId, asks, online, focus, onShowPin, onAnswered, onClosed, onRefresh, onBusy }: {
  tabId: string;
  asks: readonly PhoneMarkupAsk[];
  online: boolean;
  /** A pin tapped on the page: open the card at that question. */
  focus: QuestionFocus | null;
  /** The question's page chip: scroll the page to its pin. Absent where the
   * view has no pins (a picture). */
  onShowPin?: (askId: string, index: number) => void;
  /** Taken and queued: the card drops the ask, the view starts a round. */
  onAnswered: (askId: string) => void;
  /** Dismissed: the card drops the ask. */
  onClosed: (askId: string) => void;
  /** Read the asks again (after a refusal). */
  onRefresh: () => void;
  /** An answer or a dismissal is on its way (the view pauses its polling). */
  onBusy?: (busy: boolean) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const [picks, setPicks] = useState<Record<string, QuestionPick[]>>({});
  /** The question on show in each ask: one at a time, paged with ‹ ›. */
  const [shown, setShown] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  /** When a new ask last opened the card (`ARRIVAL_GUARD_MS`). */
  const arrivedAt = useRef(0);
  const rowsAt = useRef(new Map<string, HTMLDivElement>());
  const [flash, setFlash] = useState<string | null>(null);
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => { onBusyRef.current?.(busy !== null); }, [busy]);
  useEffect(() => () => onBusyRef.current?.(false), []);

  // A new ask opens the card, however the reader left it. Before paint: the
  // guard must stand before a tap can land on the new rows.
  useLayoutEffect(() => {
    const fresh = asks.filter((ask) => !seen.current.has(ask.id));
    for (const ask of fresh) seen.current.add(ask.id);
    if (fresh.length) { setOpen(true); setNote(null); arrivedAt.current = Date.now(); }
  }, [asks]);

  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    setShown((was) => ({ ...was, [focus.askId]: focus.index }));
    const key = `${focus.askId}/${focus.index}`;
    setFlash(key);
    const timer = window.setTimeout(() => setFlash(null), 1600);
    // After the card has opened and laid out.
    const frame = window.requestAnimationFrame(() => rowsAt.current.get(key)?.scrollIntoView?.({ block: "nearest" }));
    return () => { window.clearTimeout(timer); window.cancelAnimationFrame(frame); };
  }, [focus]);

  const count = asks.reduce((sum, ask) => sum + ask.questions.length, 0);
  if (!count) return null;
  const settling = () => Date.now() - arrivedAt.current < ARRIVAL_GUARD_MS;

  const reason = (error: unknown) => {
    const code = error instanceof ApiError ? error.code : "";
    return REASONS[code] ? t(REASONS[code]) : t("mobile.markup.reason.other", { code: code || "error" });
  };
  const refused = (error: unknown) => {
    const code = error instanceof ApiError ? error.code : "";
    // The ask moved on under the card: show what it is now.
    if (code === "superseded" || code === "answered" || code === "gone") onRefresh();
  };

  const send = async (ask: PhoneMarkupAsk, chosen: QuestionPick[]) => {
    const answers = answersOf(ask.questions.map(pickQuestion), chosen);
    if (!answers || busy || settling()) return;
    setBusy(ask.id);
    setNote(null);
    try {
      await answerMarkupQuestions(tabId, ask.id, answers);
    } catch (error) {
      setBusy(null);
      setNote(t("mobile.markup.questions.answerFailed", { reason: reason(error) }));
      refused(error);
      return;
    }
    setBusy(null);
    setPicks((was) => { const next = { ...was }; delete next[ask.id]; return next; });
    onAnswered(ask.id);
  };

  const dismiss = async (ask: PhoneMarkupAsk) => {
    if (busy || settling()) return;
    setBusy(ask.id);
    setNote(null);
    try {
      await dismissMarkupQuestions(tabId, ask.id);
    } catch (error) {
      setBusy(null);
      setNote(t("mobile.markup.questions.dismissFailed", { reason: reason(error) }));
      refused(error);
      return;
    }
    setBusy(null);
    onClosed(ask.id);
  };

  const untested = isUntested("mobile.markup.questions");
  return <section className={`markup-questions${open ? " open" : ""}`} aria-label={t("mobile.markup.questions.title")}>
    <button className="markup-questions-head" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
      <span className="agent-status question" aria-hidden="true"><span className="agent-status-glyph">{AGENT_STATUS_GLYPH.question}</span></span>
      <span className="markup-questions-title">{t("mobile.markup.questions.head", { count })}</span>
      {untested && <span className="untested">{t("mobile.outbox.untested")}</span>}
      <span className="markup-questions-fold" aria-hidden="true">{open ? "▾" : "▴"}</span>
    </button>
    {open && <div className="markup-questions-body">
      {asks.map((ask) => {
        const questions = ask.questions.map(pickQuestion);
        const chosen = picks[ask.id] ?? questions.map(() => NO_PICK);
        const ready = answersOf(questions, chosen) !== null;
        const sending = busy === ask.id;
        const setPick = (index: number, pick: QuestionPick) =>
          setPicks((was) => ({ ...was, [ask.id]: chosen.map((other, i) => (i === index ? pick : other)) }));
        const total = ask.questions.length;
        const at = Math.min(shown[ask.id] ?? 0, total - 1);
        const turn = (index: number) => setShown((was) => ({ ...was, [ask.id]: index }));
        return <div key={ask.id} className="markup-questions-ask">
          {total > 1 && <div className="question-tabs stepped markup-questions-pager" role="toolbar" aria-label={t("terminal.reader.questionSteps")}>
            <button className="question-step" aria-label={t("mobile.markup.questions.previous")} disabled={at === 0} onClick={() => turn(at - 1)}>‹</button>
            <span aria-live="polite">{t("mobile.markup.questions.position", { index: at + 1, count: total })}</span>
            <button className="question-step" aria-label={t("mobile.markup.questions.next")} disabled={at === total - 1} onClick={() => turn(at + 1)}>›</button>
          </div>}
          {ask.questions.map((question, index) => {
            if (index !== at) return null;
            const pick = chosen[index] ?? NO_PICK;
            const key = `${ask.id}/${index}`;
            const rows: QuestionRow[] = [
              ...question.options.map((option, oi): QuestionRow => ({
                key: oi,
                label: option.label,
                description: option.description,
                checked: pick.options.includes(oi),
                box: question.multi_select,
              })),
              {
                key: OTHER,
                label: t("mobile.markup.questions.other"),
                freeText: true,
                ...(pick.other ? { description: pick.other } : {}),
                checked: pick.other !== null && pick.other !== "",
                box: question.multi_select,
              },
            ];
            return <div key={key} ref={(element) => { if (element) rowsAt.current.set(key, element); else rowsAt.current.delete(key); }}
              className={`markup-question${flash === key ? " flash" : ""}`}>
              <div className="question-tabs">
                <span className="markup-question-n">?{index + 1}</span>
                {question.header && <span>{question.header}</span>}
                {question.page !== undefined && onShowPin && <button className="markup-question-page" onClick={() => onShowPin(ask.id, index)}>
                  {t("mobile.markup.questions.showOnPage", { page: question.page })}
                </button>}
              </div>
              <div className="question-ask"><div className="readable-line">{question.question}</div></div>
              {question.multi_select && <small className="markup-questions-hint">{t("mobile.markup.questions.pickAny")}</small>}
              <QuestionRows
                rows={rows}
                disabled={busy !== null || !online}
                sendingLabel={t("mobile.markup.questions.sending")}
                onPick={(row) => {
                  if (settling()) return;
                  // A ticked Other… tapped again: untick it (`QuestionRows`).
                  if (row.key === OTHER) { setPick(index, toggleOther(questions[index], pick)); return; }
                  setPick(index, toggleOption(questions[index], pick, row.key as number));
                }}
                onType={(_row, text) => {
                  setPick(index, { ...toggleOther(questions[index], { ...pick, other: null }), other: text.trim() });
                }}
                typeLabel={t("mobile.markup.questions.keep")}
                typeMax={MAX_OTHER}
              />
            </div>;
          })}
          <div className="markup-questions-actions">
            <button className="markup-submit" disabled={!ready || busy !== null || !online} onClick={() => void send(ask, chosen)}>
              {sending ? t("mobile.markup.questions.sending") : t("mobile.markup.questions.sendAll")}
            </button>
            <button className="outbox-action" disabled={busy !== null || !online} onClick={() => void dismiss(ask)}
              title={t("mobile.markup.questions.inChatTitle")}>{t("mobile.markup.questions.inChat")}</button>
          </div>
        </div>;
      })}
      {note && <p role="alert">{note}</p>}
    </div>}
  </section>;
}
