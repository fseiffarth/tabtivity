import { Fragment, useRef, type ReactNode } from "react";
import { ChevronRightIcon, CloseIcon } from "../glyphs";
import { useT } from "../../../src/lib/i18n";
import { useBackLayer } from "../backStack";
import { useModalFocus } from "../modalFocus";

export interface SheetOption {
  key: string;
  label: string;
  description?: string;
  /** Optional visual section heading; the key and selection stay the same. */
  group?: string;
  /** The option the session is in right now. */
  current: boolean;
  /** The option a switch is being applied to. */
  pending?: boolean;
  /** Starts a new unlabelled run of rows (an inset group of its own) when it
   * differs from the previous option's; `group` does the same with a heading. */
  section?: string;
  /** A leading glyph, drawn in the accent (or the danger colour). */
  icon?: ReactNode;
  /** What the row stands at, right-aligned before the chevron: a count, a swatch. */
  trailing?: ReactNode;
  /** The row opens another sheet: a › at its end. */
  more?: boolean;
  /** A destructive act (close, delete): drawn in the danger colour. */
  danger?: boolean;
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
export function OptionSheet({ title, subtitle, note, children, footer, options, waiting, busy, onPick, onClose }: {
  title: string;
  /** One line of context under the title (the model a tab runs, its colour). */
  subtitle?: ReactNode;
  note?: { text: string; error?: boolean };
  /** What the choice is about, shown under the note and above the rows. */
  children?: ReactNode;
  /** Shown under the rows. */
  footer?: ReactNode;
  options: SheetOption[];
  /** Shown while the list is still empty. */
  waiting: string;
  busy: boolean;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  useBackLayer(onClose);
  const t = useT();
  const dialog = useRef<HTMLElement>(null);
  useModalFocus(dialog);
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section ref={dialog} className="option-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("common.close")}><CloseIcon size="1em" /></button>
        {subtitle ? <div className="sheet-heading"><h2>{title}</h2><p className="sheet-sub">{subtitle}</p></div> : <h2>{title}</h2>}
        <span className="sheet-close" aria-hidden="true" />
      </header>
      {note && <p className={note.error ? "sheet-note error" : "sheet-note"} role={note.error ? "alert" : undefined}>{note.text}</p>}
      {children}
      {options.length === 0
        ? <p className="sheet-note">{waiting}</p>
        : <ul className="option-list">{options.map((option, index) => {
            const prev = options[index - 1];
            const heading = option.group && option.group !== prev?.group;
            const gap = !heading && index > 0 && option.section !== prev?.section;
            const classes = [option.current ? "current" : "", option.danger ? "danger-row" : ""].filter(Boolean).join(" ");
            return <Fragment key={option.key}>
            {heading && <li className="option-list-group">{option.group}</li>}
            {gap && <li className="option-list-group option-list-gap" aria-hidden="true" />}
            <li>
            <button className={classes} aria-current={option.current || undefined} data-steer-confirm={option.key === "confirm" ? "" : undefined} disabled={busy} onClick={() => onPick(option.key)}>
              {option.icon && <i className="option-icon" aria-hidden="true">{option.icon}</i>}
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              {option.trailing !== undefined && <span className="option-trail">{option.trailing}</span>}
              {option.pending
                ? <span className="sheet-pending" role="status">{t("mobile.optionSheet.switching")}</span>
                : option.current && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
              {option.more && <ChevronRightIcon className="option-chevron" size="1em" />}
            </button>
            </li>
          </Fragment>;
          })}</ul>}
      {footer}
    </section>
  </div>;
}
