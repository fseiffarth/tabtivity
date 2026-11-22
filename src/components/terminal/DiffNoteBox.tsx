import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../../lib/i18n";
import { PencilIcon, TrashIcon } from "../common/icons/Icon";

/**
 * The note UI under the lines of a Diffs card (`docs/done/diff_notes_plan.md`): the
 * box a note is written or edited in, and a saved note's row. The notes
 * themselves live in `stores/agents/diffNotes`; the lines they sit under are
 * `TerminalReaderChanges`'s.
 */

/** The inline box under the last selected row: a text area, Save (Ctrl+Enter)
 * and Cancel (Esc). It takes the keyboard when it opens. */
export function DiffNoteBox({ initial, onChange, onSave, onCancel }: {
  initial: string;
  /** The text as it is typed. */
  onChange?: (text: string) => void;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = field.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, []);
  const ready = text.trim().length > 0;
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (ready) onSave(text);
    }
  };
  return (
    <div className="terminal-changes-notebox">
      <textarea
        ref={field}
        data-steering-field=""
        className="terminal-changes-notefield"
        value={text}
        rows={3}
        placeholder={t("diffNotes.placeholder")}
        aria-label={t("diffNotes.placeholder")}
        onChange={(event) => {
          setText(event.target.value);
          onChange?.(event.target.value);
        }}
        onKeyDown={onKey}
      />
      <div className="terminal-changes-notebox-actions">
        <small>{t("diffNotes.hint")}</small>
        <button type="button" className="btn-quiet" onClick={onCancel}>{t("common.cancel")}</button>
        <button type="button" className="btn-primary" disabled={!ready} onClick={() => onSave(text)}>{t("common.save")}</button>
      </div>
    </div>
  );
}

/** A saved note under its lines: the text, edit and delete. */
export function SavedDiffNote({ id, text, onEdit, onDelete }: {
  id: string;
  text: string;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="terminal-changes-savednote" data-note-id={id}>
      <span>{text}</span>
      <button type="button" className="terminal-changes-open" title={t("common.edit")} aria-label={t("common.edit")} onClick={() => onEdit(id)}>
        <PencilIcon />
      </button>
      <button type="button" className="terminal-changes-open" title={t("common.delete")} aria-label={t("common.delete")} onClick={() => onDelete(id)}>
        <TrashIcon />
      </button>
    </div>
  );
}
