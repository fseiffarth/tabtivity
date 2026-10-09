/**
 * The agent's markup questions on the desktop (`markup_ask`,
 * `docs/markup_questions_mcp_plan.md` P2): the card under the markup strip
 * (`PdfMarkupBar`) and the numbered pins over the pages.
 *
 * The card is the reader's question card (`TerminalReaderView`'s
 * `LiveQuestion`: `terminal-reader-question` / `terminal-reader-option`), which
 * is the phone's `QuestionList` look on the desktop — label, description, the
 * `(Recommended)` tag. A click picks a row (checkboxes for multiSelect) and
 * only **Send answers** sends — never a single click, even for one
 * single-select question: the card turns up while the reader is marking, and
 * a stroke ending on a row must not answer. For the same reason a new card
 * takes no clicks for its first `ARRIVAL_GUARD_MS`.
 * Every question offers **Other…**; **Answer in chat instead** dismisses.
 * An ask of several questions shows one at a time, paged with ‹ ›.
 *
 * A pin (`?1`…) sits at the words the question quotes, found in the page's
 * text runs (`pageText.ts`, the extraction search and links use), else in the
 * page's top margin. A pin turns the card to its question; a question's
 * chip scrolls the page to its pin.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { CheckboxIcon, SquareIcon } from "../../common/icons/Icon";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useT } from "../../../lib/i18n";
import {
  answersOf,
  NO_PICK,
  pagePins,
  splitRecommended,
  toggleOption,
  toggleOther,
  type MarkupAsk,
  type QuestionPick,
  type QuestionPin,
} from "../../../lib/viewers/markupQuestions";
import { bigPointsToCssRect, type TextItemBox } from "../../../lib/viewers/tex/tex";
import { UntestedTag } from "../../common/UntestedTag";
import { pageTextItemBoxes } from "./pageText";
import { scrollIntoPdfBox } from "./scrollBox";
import type { MarkupQuestions, QuestionFocus } from "./usePdfMarkup";

/** The longest an **Other…** answer may be (`markup_mcp::MAX_OTHER_CHARS`). */
const MAX_OTHER = 500;
/** How long a newly shown ask takes no clicks (the phone card's rule). */
export const ARRIVAL_GUARD_MS = 1_200;

/** Where a pin's key in the card's `pinned` set comes from. */
export const pinKey = (askId: string, index: number) => `${askId}:${index}`;

export function PdfMarkupQuestions({
  questions,
  pinned,
}: {
  questions: MarkupQuestions;
  /** The questions that have a pin on a page (`pinKey`): their chip shows it. */
  pinned: ReadonlySet<string>;
}) {
  const t = useT();
  const { asks, failure } = questions;
  if (asks.length === 0 && !failure) return null;
  return (
    <div className="file-viewer-pdf-markup-questions">
      {asks.map((ask) => (
        <AskCard key={ask.id} ask={ask} questions={questions} pinned={pinned} />
      ))}
      {failure && (
        <div className="file-viewer-pdf-redact-warn" role="alert">
          {failure.text}{" "}
          <button type="button" className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={questions.dismissFailure}>
            {t("pdfViewer.dismiss")}
          </button>
          {failure.prompt && <pre className="terminal-reader-question-context">{failure.prompt}</pre>}
        </div>
      )}
    </div>
  );
}

function AskCard({ ask, questions, pinned }: { ask: MarkupAsk; questions: MarkupQuestions; pinned: ReadonlySet<string> }) {
  const t = useT();
  const [picks, setPicks] = useState<QuestionPick[]>(() => ask.questions.map(() => NO_PICK));
  const [flash, setFlash] = useState<number | null>(null);
  /** The question on show: one at a time, paged with ‹ ›. */
  const [shown, setShown] = useState(0);
  const count = ask.questions.length;
  const qi = Math.min(shown, count - 1);
  const cardRef = useRef<HTMLDivElement>(null);
  const busy = questions.answering !== null;
  const sending = questions.answering === ask.id;
  const [arrivedAt] = useState(() => Date.now());
  const settling = () => Date.now() - arrivedAt < ARRIVAL_GUARD_MS;
  const answers = answersOf(ask.questions, picks);

  // A pin was clicked: turn the card to its question and bring it into view.
  const focus = questions.focus;
  useEffect(() => {
    if (!focus || focus.on !== "card" || focus.askId !== ask.id) return;
    setShown(focus.index);
    const card = cardRef.current;
    const box = card?.parentElement;
    // The box is positioned: the card's offsetTop is measured from it.
    if (box && card) box.scrollTop = Math.max(0, card.offsetTop - 6);
    setFlash(focus.index);
    const timer = window.setTimeout(() => setFlash(null), 1_200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const setPick = (index: number, next: QuestionPick) => {
    if (!settling()) setPicks((now) => now.map((pick, i) => (i === index ? next : pick)));
  };
  const send = () => {
    if (answers && !settling()) void questions.answer(ask, answers);
  };
  const question = ask.questions[qi];
  const pick = picks[qi] ?? NO_PICK;
  const hasPin = pinned.has(pinKey(ask.id, qi));

  return (
    <div ref={cardRef} className="terminal-reader-question" role="group" aria-label={t("pdfMarkup.questions.title")}>
      <div className="file-viewer-pdf-markup-question-head">
        <small className="terminal-reader-question-head">
          {ask.fileName ? t("pdfMarkup.questions.headFile", { file: ask.fileName }) : t("pdfMarkup.questions.head")}{" "}
          <UntestedTag id="desktop.markup.questions" />
        </small>
        {count > 1 && (
          <div className="file-viewer-pdf-markup-question-pager" role="toolbar" aria-label={t("terminal.reader.questionSteps")}>
            <button
              type="button"
              className="file-viewer-zoom-btn"
              disabled={qi === 0}
              title={t("pdfMarkup.questions.previous")}
              aria-label={t("pdfMarkup.questions.previous")}
              onClick={() => setShown(qi - 1)}
            >
              ‹
            </button>
            <span aria-live="polite">{t("pdfMarkup.questions.position", { index: qi + 1, count })}</span>
            <button
              type="button"
              className="file-viewer-zoom-btn"
              disabled={qi === count - 1}
              title={t("pdfMarkup.questions.next")}
              aria-label={t("pdfMarkup.questions.next")}
              onClick={() => setShown(qi + 1)}
            >
              ›
            </button>
          </div>
        )}
      </div>
      {question && (
        <div
          key={qi}
          data-question={qi}
          className={`file-viewer-pdf-markup-question${flash === qi ? " is-focus" : ""}`}
        >
          {(question.header || hasPin) && (
            <div className="terminal-reader-question-tabs">
              {hasPin && (
                <button
                  type="button"
                  className="file-viewer-pdf-question-pin is-inline"
                  title={t("pdfMarkup.questions.showOnPage", { page: question.page ?? 0 })}
                  aria-label={t("pdfMarkup.questions.showOnPage", { page: question.page ?? 0 })}
                  onClick={() => questions.show(ask.id, qi, "page")}
                >
                  ?{qi + 1}
                </button>
              )}
              {question.header && <span>{question.header}</span>}
            </div>
          )}
          <p className="terminal-reader-question-ask">{question.question}</p>
          <div className="terminal-reader-options" role="group" aria-label={question.question}>
            {question.options.map((option, oi) => {
              const chosen = pick.options.includes(oi);
              const { label, recommended } = splitRecommended(option.label);
              return (
                <button
                  key={oi}
                  type="button"
                  className={`terminal-reader-option${chosen ? " chosen" : ""}`}
                  aria-pressed={chosen}
                  disabled={busy}
                  onClick={() => setPick(qi, toggleOption(question, pick, oi))}
                >
                  <span className="terminal-reader-option-number">
                    {question.multiSelect ? (chosen ? <CheckboxIcon /> : <SquareIcon />) : chosen ? "✓" : oi + 1}
                  </span>
                  <span className="terminal-reader-option-label">
                    <span>
                      {label}
                      {recommended && <em className="terminal-reader-recommended">{t("terminal.reader.recommended")}</em>}
                    </span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              className={`terminal-reader-option${pick.other !== null ? " chosen" : ""}`}
              aria-pressed={pick.other !== null}
              disabled={busy}
              onClick={() => setPick(qi, toggleOther(question, pick))}
            >
              <span className="terminal-reader-option-number">{pick.other !== null ? "✓" : "…"}</span>
              <span className="terminal-reader-option-label">
                <span>{t("pdfMarkup.questions.other")}</span>
              </span>
            </button>
            {pick.other !== null && (
              <form
                className="file-viewer-pdf-markup-question-other"
                onSubmit={(event) => {
                  // Enter is typed on purpose: it sends, as Send answers
                  // does — or, with questions still open, turns the page.
                  event.preventDefault();
                  if (answers === null && qi < count - 1) setShown(qi + 1);
                  else send();
                }}
              >
                <input
                  autoFocus
                  type="text"
                  value={pick.other}
                  maxLength={MAX_OTHER}
                  disabled={busy}
                  placeholder={t("pdfMarkup.questions.otherPlaceholder")}
                  aria-label={t("pdfMarkup.questions.otherPlaceholder")}
                  onChange={(event) => setPick(qi, { ...pick, other: event.target.value })}
                />
              </form>
            )}
          </div>
          {question.multiSelect && <small className="terminal-reader-question-more">{t("pdfMarkup.questions.pickAny")}</small>}
        </div>
      )}
      <div className="file-viewer-pdf-markup-question-actions">
        <button
          type="button"
          className="file-viewer-zoom-btn file-viewer-zoom-text active"
          disabled={busy || answers === null}
          onClick={send}
        >
          {t("pdfMarkup.questions.sendAll")}
        </button>
        <button
          type="button"
          className="file-viewer-zoom-btn file-viewer-zoom-text"
          disabled={busy}
          title={t("pdfMarkup.questions.inChatTitle")}
          onClick={() => void questions.dismiss(ask)}
        >
          {t("pdfMarkup.questions.inChat")}
        </button>
        {sending && <small className="terminal-reader-question-more" role="status">{t("pdfMarkup.questions.sending")}</small>}
      </div>
    </div>
  );
}

/**
 * The pins of every open question, by 1-based page: placed at the quoted
 * words once the page's text runs are read, in the top margin until then (and
 * when the words are not found). Reads only the pages a question names, once
 * per document.
 */
export function useQuestionPins(doc: PDFDocumentProxy | null, asks: readonly MarkupAsk[]): Map<number, QuestionPin[]> {
  const [texts, setTexts] = useState<{ doc: PDFDocumentProxy; pages: Map<number, TextItemBox[]> } | null>(null);
  const pageList = useMemo(
    () => [...new Set(asks.flatMap((ask) => ask.questions.flatMap((q) => (q.page ? [q.page] : []))))]
      .filter((page) => doc !== null && page <= doc.numPages)
      .sort((a, b) => a - b),
    [asks, doc],
  );
  const wanted = pageList.join(",");
  useEffect(() => {
    if (!doc || !wanted) return;
    let live = true;
    const have = texts?.doc === doc ? texts.pages : null;
    const missing = wanted.split(",").map(Number).filter((page) => !have?.has(page));
    if (!missing.length) return;
    void Promise.all(missing.map((page) => pageTextItemBoxes(doc, page).then((items): [number, TextItemBox[]] => [page, items], (): [number, TextItemBox[]] => [page, []])))
      .then((read) => {
        if (!live) return;
        setTexts((now) => {
          const pages = new Map(now?.doc === doc ? now.pages : []);
          for (const [page, items] of read) pages.set(page, items);
          return { doc, pages };
        });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, wanted]);
  // Matching the quotes walks every named page's text runs: only again when
  // the asks or the read text change, not on every render of the viewer.
  return useMemo(() => {
    const out = new Map<number, QuestionPin[]>();
    for (const page of pageList) {
      const items = texts?.doc === doc ? texts.pages.get(page) ?? null : null;
      out.set(page, pagePins(asks, page, items));
    }
    return out;
  }, [pageList, texts, doc, asks]);
}

/** A pin badge's size (CSS px), for placing it above the quoted words. */
const PIN = 22;

/** One page's question pins, over the markup layer. */
export function PdfQuestionPins({
  pins,
  scale,
  focus,
  onPick,
}: {
  pins: readonly QuestionPin[];
  scale: number;
  /** The question the card asked to see: its pin scrolls into view and its
   *  words light up as the current search hit does. */
  focus: QuestionFocus | null;
  onPick: (pin: QuestionPin) => void;
}) {
  const t = useT();
  const focusRef = useRef<HTMLButtonElement>(null);
  const focused = (pin: QuestionPin) =>
    focus !== null && focus.on === "page" && focus.askId === pin.askId && focus.index === pin.index;
  useEffect(() => {
    if (focusRef.current) scrollIntoPdfBox(focusRef.current, "center");
  }, [focus?.nonce]);
  return (
    <>
      {pins.map((pin) => {
        const on = focused(pin);
        const first = pin.rects[0];
        const at = first ? bigPointsToCssRect(first, scale) : null;
        const left = at ? Math.max(0, at.left - PIN / 2) : 6 + pin.slot * (PIN + 4);
        const top = at ? Math.max(0, at.top - PIN - 2) : 4;
        return (
          <Fragment key={pinKey(pin.askId, pin.index)}>
            {on &&
              pin.rects.map((rect, ri) => {
                const css = bigPointsToCssRect(rect, scale);
                return (
                  <div
                    key={`q-${ri}`}
                    className="file-viewer-pdf-search-hit current"
                    style={{ left: css.left, top: css.top, width: css.width, height: css.height }}
                  />
                );
              })}
            <button
              ref={on ? focusRef : undefined}
              type="button"
              className={`file-viewer-pdf-question-pin${on ? " is-focus" : ""}`}
              style={{ left, top }}
              title={t("pdfMarkup.questions.pinTitle", { n: pin.index + 1 })}
              aria-label={t("pdfMarkup.questions.pinTitle", { n: pin.index + 1 })}
              onClick={() => onPick(pin)}
            >
              ?{pin.index + 1}
            </button>
          </Fragment>
        );
      })}
    </>
  );
}
