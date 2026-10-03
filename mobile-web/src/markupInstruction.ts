// What a Mark up Submit tells the agent to do with the marks — the one part
// of its prompt the reader words, and only here, in the phone's settings: the
// desktop builds the rest (the file, the marked copy, the layers, the typed
// notes) and puts this text after it (`markup.rs`). It is this phone's own,
// like the voice language, and is sent with each Submit only once edited, so
// an untouched phone gets the desktop's default — which asks before changing
// any file, because "apply my marks" on a PDF built from a `.tex` beside it
// had the agent edit that file unasked.

import { readChoice, writeChoice } from "./prefs";
import { NAMES } from "../../src/lib/brand";

/** The desktop's default, shown as the setting's starting point. Equal to
 * `DEFAULT_INSTRUCTION` in `markup.rs` (a test there checks this file). */
export const DEFAULT_MARKUP_INSTRUCTION = "Read every mark (strike-throughs, insertions, circled parts, margin notes) and list the changes they ask for, and any mark you could not read. Do not change any file yet — not this one, not the sources it is built from, not any other file — until I tell you which changes to make. If a mark leaves you a choice, ask me with the `markup_ask` tool if you have it — give the page and the words the mark is on — rather than in prose.";

/** The desktop refuses a longer one (`MAX_INSTRUCTION`). */
export const MAX_MARKUP_INSTRUCTION = 2_000;

function isText(value: unknown): value is string {
  return typeof value === "string";
}

/** The reader's own instruction, or `null` while the default stands. */
export function readMarkupInstruction(): string | null {
  const stored = readChoice("markupInstruction", isText, "").trim();
  return stored && stored !== DEFAULT_MARKUP_INSTRUCTION ? stored : null;
}

/** Keeps `text` as this phone's instruction; blank (or the default itself)
 * goes back to the default. Control characters other than line breaks and
 * tabs are dropped — the desktop would refuse the whole Submit over one. */
export function writeMarkupInstruction(text: string): void {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").trim();
  writeChoice("markupInstruction", clean === DEFAULT_MARKUP_INSTRUCTION ? "" : [...clean].slice(0, MAX_MARKUP_INSTRUCTION).join(""));
}

/** What **Make these changes** sends once the agent has listed the changes
 * (`docs/pdf_markup_rounds_plan.md` §2.8): a plain prompt the phone words —
 * the desktop adds nothing to it. Kept beside the instruction, and like it
 * this phone's own. */
export const DEFAULT_MARKUP_APPLY = `Make the changes you listed from my marks now: edit the sources the PDF is built from, rebuild it, and send me the rebuilt PDF with \`${NAMES.sendCli} <file>\`.`;

/** The reader's own **Make these changes** prompt, or `null` while the
 * default stands. */
export function readMarkupApply(): string | null {
  const stored = readChoice("markupApply", isText, "").trim();
  return stored && stored !== DEFAULT_MARKUP_APPLY ? stored : null;
}

/** Keeps `text` as this phone's **Make these changes** prompt, cleaned and
 * bounded as the instruction is; blank (or the default) goes back to it. */
export function writeMarkupApply(text: string): void {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").trim();
  writeChoice("markupApply", clean === DEFAULT_MARKUP_APPLY ? "" : [...clean].slice(0, MAX_MARKUP_INSTRUCTION).join(""));
}
