import { useT } from "../../../src/lib/i18n";

export interface SheetOption {
  key: string;
  label: string;
  description?: string;
  /** The option the session is in right now. */
  current: boolean;
  /** The option a switch is being applied to. */
  pending?: boolean;
}

/**
 * A choice, as a phone list: the sheet a row opens instead of leaving the
 * reader to walk a TUI dialog with the arrow keys. It renders what the caller
 * resolved — a session dialog's own rows, the modes a status line says it has,
 * the voice languages — and reports taps back. No parsing, no keystrokes.
 *
 * It lived in `screens/Terminal` while the terminal was the only screen with
 * choices to offer; Home's voice-language row opens the same sheet, so it sits
 * here rather than being drawn twice.
 */
export function OptionSheet({ title, note, options, waiting, busy, onPick, onClose }: {
  title: string;
  note?: { text: string; error?: boolean };
  options: SheetOption[];
  /** Shown while the list is still empty. */
  waiting: string;
  busy: boolean;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("common.close")}>✕</button>
        <h2>{title}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      {note && <p className={note.error ? "sheet-note error" : "sheet-note"} role={note.error ? "alert" : undefined}>{note.text}</p>}
      {options.length === 0
        ? <p className="sheet-note">{waiting}</p>
        : <ul className="option-list">{options.map((option) => <li key={option.key}>
            <button className={option.current ? "current" : ""} aria-current={option.current || undefined} disabled={busy} onClick={() => onPick(option.key)}>
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              {option.pending
                ? <span className="sheet-pending" role="status">{t("mobile.optionSheet.switching")}</span>
                : option.current && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
            </button>
          </li>)}</ul>}
    </section>
  </div>;
}
