import { useEffect, useRef, useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import {
  answersOf, answersOnTap, NO_PICK, toggleOption, toggleOther, type MarkupQuestion, type QuestionPick,
} from "../../../src/lib/viewers/markupQuestionPicks";
import { answerMarkupQuestions, ApiError, dismissMarkupQuestions, type PhoneMarkupAsk, type PhoneMarkupQuestion } from "../api";
import { AGENT_STATUS_GLYPH } from "./AgentStatusPill";
import { QuestionRows, type QuestionRow } from "./QuestionRows";

/** The longest typed **Other…** answer (`markup_mcp::MAX_OTHER_CHARS`). */
const MAX_OTHER = 500;
/** The Other… row's key among a question's option indices. */
const OTHER = "other";

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
 * list's (`QuestionRows`), so the two read alike. One single-select question
 * answers on the tap; otherwise rows are picked (ticked for multiSelect) and
 * **Send answers** sends. **Other…** takes typed words; **Answer in chat
 * instead** closes the ask. The desktop builds the prompt and queues it into
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
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  const rowsAt = useRef(new Map<string, HTMLDivElement>());
  const [flash, setFlash] = useState<string | null>(null);
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => { onBusyRef.current?.(busy !== null); }, [busy]);
  useEffect(() => () => onBusyRef.current?.(false), []);

  // A new ask opens the card, however the reader left it.
  useEffect(() => {
    const fresh = asks.filter((ask) => !seen.current.has(ask.id));
    for (const ask of fresh) seen.current.add(ask.id);
    if (fresh.length) { setOpen(true); setNote(null); }
  }, [asks]);

  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    const key = `${focus.askId}/${focus.index}`;
    setFlash(key);
    const timer = window.setTimeout(() => setFlash(null), 1600);
    // After the card has opened and laid out.
    const frame = window.requestAnimationFrame(() => rowsAt.current.get(key)?.scrollIntoView?.({ block: "nearest" }));
    return () => { window.clearTimeout(timer); window.cancelAnimationFrame(frame); };
  }, [focus]);

  const count = asks.reduce((sum, ask) => sum + ask.questions.length, 0);
  if (!count) return null;

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
    if (!answers || busy) return;
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
    if (busy) return;
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
        const onTap = answersOnTap(questions);
        const ready = answersOf(questions, chosen) !== null;
        const sending = busy === ask.id;
        const setPick = (index: number, pick: QuestionPick) => {
          const next = chosen.map((was, i) => (i === index ? pick : was));
          setPicks((was) => ({ ...was, [ask.id]: next }));
          return next;
        };
        return <div key={ask.id} className="markup-questions-ask">
          {ask.questions.map((question, index) => {
            const pick = chosen[index] ?? NO_PICK;
            const key = `${ask.id}/${index}`;
            const rows: QuestionRow[] = [
              ...question.options.map((option, oi): QuestionRow => ({
                key: oi,
                label: option.label,
                description: option.description,
                ...(onTap ? {} : { checked: pick.options.includes(oi), box: question.multi_select }),
                pending: sending && onTap && pick.options.includes(oi),
              })),
              {
                key: OTHER,
                label: t("mobile.markup.questions.other"),
                freeText: true,
                ...(pick.other ? { description: pick.other } : {}),
                ...(onTap ? {} : { checked: pick.other !== null && pick.other !== "", box: question.multi_select }),
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
                  // A ticked Other… tapped again: untick it (`QuestionRows`).
                  if (row.key === OTHER) { setPick(index, toggleOther(questions[index], pick)); return; }
                  const next = setPick(index, toggleOption(questions[index], pick, row.key as number));
                  if (onTap) void send(ask, next);
                }}
                onType={(_row, text) => {
                  const typed = { ...toggleOther(questions[index], { ...pick, other: null }), other: text.trim() };
                  const next = setPick(index, typed);
                  if (onTap) void send(ask, next);
                }}
                typeLabel={onTap ? undefined : t("mobile.markup.questions.keep")}
                typeMax={MAX_OTHER}
              />
            </div>;
          })}
          <div className="markup-questions-actions">
            {!onTap && <button className="markup-submit" disabled={!ready || busy !== null || !online} onClick={() => void send(ask, chosen)}>
              {sending ? t("mobile.markup.questions.sending") : t("mobile.markup.questions.sendAll")}
            </button>}
            <button className="outbox-action" disabled={busy !== null || !online} onClick={() => void dismiss(ask)}
              title={t("mobile.markup.questions.inChatTitle")}>{t("mobile.markup.questions.inChat")}</button>
          </div>
        </div>;
      })}
      {note && <p role="alert">{note}</p>}
    </div>}
  </section>;
}
