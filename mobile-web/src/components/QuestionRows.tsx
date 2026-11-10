import { useState, type ReactNode } from "react";
import { CheckboxIcon, PaperclipIcon, SquareIcon } from "../../../src/components/common/icons/Icon";
import { useT } from "../../../src/lib/i18n";
import { usePhonePicks, type PickedFile } from "./phonePicks";

/** The mark Claude Code asks agents to put on the option they would pick. It
 * is shown as a tag beside the label rather than as part of it — the agent's
 * own word, as it wrote it. */
const RECOMMENDED = /\s+\((Recommended)\)$/u;

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
   * answer on the tap. Shown as a tick box when `box` is set. A picked
   * free-text row's tap goes to `onPick` (to untick it), not to its field. */
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
 * back; a free-text row opens a field under it and reports the words. Given
 * `attach`, that field also takes files — the 📎 button's picks and an image
 * pasted into it — each sent to the agent's inbox and typed into the answer
 * as its `@` reference.
 */
export function QuestionRows({ rows, disabled, sendingLabel, onPick, onType, typeLabel, typeMax, typeNote, attach }: {
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
  /** Puts one file into the agent's inbox and resolves to its reference (no
   * `@`); rejects with the sentence saying why not. Absent where the answer
   * cannot carry files (a markup question, a tab on another host). */
  attach?: (file: File) => Promise<string>;
}) {
  const t = useT();
  /** The free-text row tapped: its field is open under it until sent. */
  const [typing, setTyping] = useState<number | string | null>(null);
  const [typed, setTyped] = useState("");
  /** Files on their way into the answer: each lands as `@<reference> ` at
   * the end of the words, where it can still be edited out before Send. */
  const picks = usePhonePicks<PickedFile>({
    testId: "question-file-input",
    tooLarge: t("mobile.sendToDesktop.tooLarge"),
    send: async (file, _row, settle) => {
      if (!attach) return;
      try {
        const reference = await attach(file);
        setTyped((current) => `${current}${current && !/\s$/u.test(current) ? " " : ""}@${reference} `);
        settle({ state: "sent" });
      } catch (error) {
        settle({ state: "failed", failure: error instanceof Error ? error.message : String(error) });
      }
    },
  });
  const attaching = picks.rows.some((pick) => pick.state === "sending");
  return <ul className="option-list question-list">{rows.map((row) => {
    const recommended = RECOMMENDED.exec(row.label);
    const send = () => {
      if (!typed.trim() || attaching) return;
      onType(row, typed);
      setTyping(null);
      setTyped("");
      for (const pick of picks.rows) picks.dismiss(pick.id);
    };
    const picked = row.checked === true;
    return <li key={row.key}>
      <button
        className={row.current || picked ? "current" : ""}
        aria-current={row.current || undefined}
        aria-pressed={row.checked}
        aria-expanded={row.freeText ? typing === row.key : undefined}
        disabled={disabled}
        onClick={() => row.freeText && !picked ? setTyping((open) => open === row.key ? null : row.key) : onPick(row)}>
        <span>
          <strong>
            {row.box && <span className="question-box" aria-hidden="true">{picked ? <CheckboxIcon /> : <SquareIcon />} </span>}
            {row.title ?? (recommended ? row.label.slice(0, recommended.index) : row.label)}{recommended && <em className="question-recommended">{recommended[1]}</em>}
          </strong>
          {row.description && <small>{row.description}</small>}
        </span>
        {row.pending && <span className="sheet-pending" role="status">{sendingLabel}</span>}
      </button>
      {row.freeText && typing === row.key && !disabled && <form className="question-type" onSubmit={(event) => { event.preventDefault(); send(); }}>
        {/* A few lines tall and wrapping, so a Pencil's handwriting (iPad
            Scribble) has room to write; still one answer — Enter sends it and
            a line break becomes a space, as the CLI's own field would take it. */}
        <textarea autoFocus rows={4} value={typed} maxLength={typeMax} placeholder={t("mobile.question.typePlaceholder")} aria-label={t("mobile.question.typePlaceholder")} enterKeyHint="send"
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }}
          onChange={(event) => setTyped(event.target.value.replace(/\r?\n/gu, " "))}
          onPaste={attach && ((event) => {
            // A screenshot or a file copied on the phone: into the inbox, not
            // into the words. Text pastes as it always did.
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length === 0) return;
            event.preventDefault();
            picks.add(files);
          })} />
        {attach && <button type="button" className="question-attach" aria-label={t("mobile.question.attach")} title={t("mobile.question.attach")}
          onClick={() => picks.open()}><PaperclipIcon /></button>}
        <button className="primary" disabled={!typed.trim() || attaching}>{typeLabel ?? t("mobile.question.typeSend")}</button>
        {attaching && <small role="status">{t("mobile.question.attaching")}</small>}
        {picks.rows.filter((pick) => pick.state === "failed").map((pick) => <small key={pick.id} role="alert">{pick.name}: {pick.failure}</small>)}
        {typeNote}
        {attach && picks.input}
      </form>}
    </li>;
  })}</ul>;
}
