import { useState, type ReactNode } from "react";
import { useT } from "../../../src/lib/i18n";
import { splitRecommended } from "../../../src/lib/viewers/markupQuestionPicks";

/** One row of a question list: what it says, and how it stands. */
export type QuestionRow = {
  key: number | string;
  /** The option's own label; a trailing `(Recommended)` becomes a tag. */
  label: string;
  /** Shown in place of the label (the review step's Submit), the tag kept. */
  title?: string;
  description?: string;
  /** The row the dialog highlights — the one Enter would take. */
  current?: boolean;
  /** A row the reader picked; `undefined` where rows are not picked but
   * answer on the tap. Shown as a tick box when `box` is set. */
  checked?: boolean;
  box?: boolean;
  /** A row answered by words typed under it rather than by the tap. */
  freeText?: boolean;
  /** The tap that answered with this row is on its way. */
  pending?: boolean;
};

/**
 * The rows of a question the agent asks, as the phone lists them — one tap a
 * row, laid out as the model and mode sheets lay theirs out. Shared by the
 * Focus chat's live dialog (`QuestionList` in `screens/Terminal.tsx`) and the
 * markup view's card of the agent's `markup_ask` (`MarkupQuestionsCard`), so
 * the two read alike. It renders what the caller resolved and reports taps
 * back; a free-text row opens a field under it and reports the words.
 */
export function QuestionRows({ rows, disabled, sendingLabel, onPick, onType, typeLabel, typeMax, typeNote }: {
  rows: readonly QuestionRow[];
  /** No row can be tapped (an answer is on its way). */
  disabled: boolean;
  sendingLabel: string;
  onPick: (row: QuestionRow) => void;
  /** A free-text row answered with the words typed under it. */
  onType: (row: QuestionRow, text: string) => void;
  /** The typed answer's button, Send unless given. */
  typeLabel?: string;
  /** The longest typed answer the field takes. */
  typeMax?: number;
  /** Beside the typed answer's button (an untested pill). */
  typeNote?: ReactNode;
}) {
  const t = useT();
  /** The free-text row tapped: its field is open under it until sent. */
  const [typing, setTyping] = useState<number | string | null>(null);
  const [typed, setTyped] = useState("");
  return <ul className="option-list question-list">{rows.map((row) => {
    const split = splitRecommended(row.label);
    const send = () => {
      if (!typed.trim()) return;
      onType(row, typed);
      setTyping(null);
      setTyped("");
    };
    const picked = row.checked === true;
    return <li key={row.key}>
      <button
        className={row.current || picked ? "current" : ""}
        aria-current={row.current || undefined}
        aria-pressed={row.checked}
        aria-expanded={row.freeText ? typing === row.key : undefined}
        disabled={disabled}
        onClick={() => row.freeText ? setTyping((open) => open === row.key ? null : row.key) : onPick(row)}>
        <span>
          <strong>
            {row.box && <span className="question-box" aria-hidden="true">{picked ? "☑" : "☐"} </span>}
            {row.title ?? split.label}{split.recommended && <em className="question-recommended">Recommended</em>}
          </strong>
          {row.description && <small>{row.description}</small>}
        </span>
        {row.pending && <span className="sheet-pending" role="status">{sendingLabel}</span>}
      </button>
      {row.freeText && typing === row.key && !disabled && <form className="question-type" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <input autoFocus value={typed} maxLength={typeMax} placeholder={t("mobile.question.typePlaceholder")} aria-label={t("mobile.question.typePlaceholder")} enterKeyHint="send" onChange={(event) => setTyped(event.target.value)} />
        <button className="primary" disabled={!typed.trim()}>{typeLabel ?? t("mobile.question.typeSend")}</button>
        {typeNote}
      </form>}
    </li>;
  })}</ul>;
}
