import { useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import {
  DEFAULT_MARKUP_APPLY, DEFAULT_MARKUP_INSTRUCTION, MAX_MARKUP_INSTRUCTION, readMarkupApply, readMarkupInstruction, writeMarkupApply, writeMarkupInstruction,
} from "../markupInstruction";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** What the settings row says the prompts are: the defaults, or the
 * reader's own (either of the two). */
export function customMarkupPrompts(): string | null {
  return readMarkupInstruction() ?? readMarkupApply();
}

/** What the settings row says the instruction is: the default, or the
 * reader's own. */
export function markupInstructionSummary(custom: string | null, t: Translate): string {
  return custom === null ? t("mobile.markup.instruction.default") : t("mobile.markup.instruction.custom");
}

/** The one place a Mark up Submit's instruction and the **Make these
 * changes** follow-up are worded (`markupInstruction.ts`) — the markup view
 * sends them as they stand. */
export function MarkupInstructionSheet({ onChange, onClose }: {
  onChange: (custom: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(() => readMarkupInstruction() ?? DEFAULT_MARKUP_INSTRUCTION);
  const [apply, setApply] = useState(() => readMarkupApply() ?? DEFAULT_MARKUP_APPLY);
  const keep = (instruction: string, follow: string) => {
    writeMarkupInstruction(instruction);
    writeMarkupApply(follow);
    onChange(customMarkupPrompts());
    onClose();
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.markup.instruction.title")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("mobile.newTab.close")}>✕</button><h2>{t("mobile.markup.instruction.title")} {isUntested("mobile.markup.instruction") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">{t("mobile.markup.instruction.note")}</p>
      <div className="mobile-schedule-form">
        <label>{t("mobile.markup.instruction.label")}<textarea
          rows={7}
          value={text}
          maxLength={MAX_MARKUP_INSTRUCTION}
          onChange={(event) => setText(event.target.value)}
        /></label>
        <label>{t("mobile.markup.apply.label")} {isUntested("mobile.markup.apply") && <small>{t("mobile.newTab.untested")}</small>}<textarea
          rows={4}
          value={apply}
          maxLength={MAX_MARKUP_INSTRUCTION}
          onChange={(event) => setApply(event.target.value)}
        /></label>
        <p className="sheet-note">{t("mobile.markup.apply.note")}</p>
        <div className="mobile-schedule-actions">
          <button onClick={() => keep("", "")}>{t("mobile.markup.instruction.reset")}</button>
          <button onClick={onClose}>{t("mobile.markup.instruction.cancel")}</button>
          <button className="primary" onClick={() => keep(text, apply)}>{t("mobile.markup.instruction.save")}</button>
        </div>
      </div>
    </section>
  </div>;
}
