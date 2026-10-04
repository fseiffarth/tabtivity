import { useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import {
  DEFAULT_MARKUP_APPLY, DEFAULT_MARKUP_ASK, defaultMarkupInstruction, MARKUP_ASK_STOPS, MAX_MARKUP_INSTRUCTION,
  readMarkupApply, readMarkupAsk, readMarkupDirect, readMarkupInstruction, writeMarkupApply, writeMarkupAsk, writeMarkupDirect, writeMarkupInstruction,
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

/** The one place a Mark up Submit's instruction, its asking dial, **Apply
 * marks directly** and the **Make these changes** follow-up are set
 * (`markupInstruction.ts`) — the markup view sends them as they stand. The
 * instruction starts from the default of the mode the switch asks for, and
 * follows the switch while it is a default. */
export function MarkupInstructionSheet({ onChange, onClose }: {
  onChange: (custom: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [direct, setDirect] = useState(readMarkupDirect);
  const [text, setText] = useState(() => readMarkupInstruction() ?? defaultMarkupInstruction(direct));
  const [apply, setApply] = useState(() => readMarkupApply() ?? DEFAULT_MARKUP_APPLY);
  const [ask, setAsk] = useState(readMarkupAsk);
  const toggleDirect = (on: boolean) => {
    setDirect(on);
    // A default stays the default — of the mode now asked for.
    setText((was) => (was.trim() === defaultMarkupInstruction(!on) ? defaultMarkupInstruction(on) : was));
  };
  const keep = (instruction: string, follow: string, stop: number, directly: boolean) => {
    writeMarkupInstruction(instruction);
    writeMarkupApply(follow);
    writeMarkupAsk(stop);
    writeMarkupDirect(directly);
    onChange(customMarkupPrompts());
    onClose();
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.markup.instruction.title")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("mobile.newTab.close")}>✕</button><h2>{t("mobile.markup.instruction.title")} {isUntested("mobile.markup.instruction") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">{t("mobile.markup.instruction.note")}</p>
      <div className="mobile-schedule-form">
        <div className="mobile-schedule-weekdays"><label><input type="checkbox" checked={direct} onChange={(event) => toggleDirect(event.target.checked)} />
          {t("mobile.markup.direct.label")}{isUntested("mobile.markup.undo") && <small> {t("mobile.newTab.untested")}</small>}</label></div>
        <p className="sheet-note">{t("mobile.markup.direct.note")}</p>
        <label>{t("markup.ask.label")} {isUntested("mobile.markup.ask") && <small>{t("mobile.newTab.untested")}</small>}<input
          type="range"
          className="markup-ask-dial"
          min={0}
          max={MARKUP_ASK_STOPS - 1}
          step={1}
          value={ask}
          aria-valuetext={t(`markup.ask.stop${ask}` as TranslationKey)}
          onChange={(event) => setAsk(Number(event.target.value))}
        /></label>
        <p className="sheet-note"><strong>{t(`markup.ask.stop${ask}` as TranslationKey)}</strong> — {t(`markup.ask.hint${ask}` as TranslationKey)}</p>
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
          {/* The prompts go back to the defaults; the switch stays as set — the
              instruction's default is then that mode's. */}
          <button onClick={() => keep("", "", DEFAULT_MARKUP_ASK, direct)}>{t("mobile.markup.instruction.reset")}</button>
          <button onClick={onClose}>{t("mobile.markup.instruction.cancel")}</button>
          <button className="primary" onClick={() => keep(text, apply, ask, direct)}>{t("mobile.markup.instruction.save")}</button>
        </div>
      </div>
    </section>
  </div>;
}
