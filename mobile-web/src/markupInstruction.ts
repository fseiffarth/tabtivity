// What a Mark up Submit tells the agent to do with the marks — the one part
// of its prompt the reader words, and only here, in the phone's settings: the
// desktop builds the rest (the file, the marked copy, the layers, the typed
// notes) and puts this text after it (`markup.rs`). It is this phone's own,
// like the voice language, and is sent with each Submit only once edited, so
// an untouched phone gets the desktop's default for the round's mode. With
// **Apply marks directly** on (the default, `readMarkupDirect`) that has the
// agent make the changes at once, and the desktop keeps an undo snapshot the
// pill's **Undo** puts back (`docs/pdf_markup_direct_apply_plan.md`); where it
// can take none — or with the switch off — the default asks the agent to list
// the changes first, because "apply my marks" on a PDF built from a `.tex`
// beside it had the agent edit that file unasked with nothing to undo it.

import { readChoice, readFlag, writeChoice, writeFlag } from "./prefs";
import { NAMES } from "../../src/lib/brand";

/** The desktop's default, shown as the setting's starting point. Equal to
 * `DEFAULT_INSTRUCTION` in `markup.rs` (a test there checks this file). */
export const DEFAULT_MARKUP_INSTRUCTION = "Read every mark (strike-throughs, insertions, circled parts, margin notes) and list the changes they ask for, and any mark you could not read. Do not change any file yet — not this one, not the sources it is built from, not any other file — until I tell you which changes to make.";

/** The desktop's default for an `apply` round (**Apply marks directly**,
 * `docs/pdf_markup_direct_apply_plan.md`): the agent makes the changes and an
 * Undo backs them. Equal to `DEFAULT_APPLY_INSTRUCTION` in `markup.rs` (the
 * same test checks it). */
export const DEFAULT_MARKUP_APPLY_INSTRUCTION = "Make the changes these marks ask for (strike-throughs, insertions, circled parts, margin notes): edit the sources the PDF is built from — not the PDF itself and not the marked copy — and rebuild it. Afterwards list what you changed, and any mark you could not read.";

/** The desktop refuses a longer one (`MAX_INSTRUCTION`). */
export const MAX_MARKUP_INSTRUCTION = 2_000;

function isText(value: unknown): value is string {
  return typeof value === "string";
}

/** Either of the desktop's defaults — each mode's, so a default kept from
 * the other mode never pins a round to it. */
function isDefaultInstruction(text: string): boolean {
  return text === DEFAULT_MARKUP_INSTRUCTION || text === DEFAULT_MARKUP_APPLY_INSTRUCTION;
}

/** The reader's own instruction, or `null` while a default stands. */
export function readMarkupInstruction(): string | null {
  const stored = readChoice("markupInstruction", isText, "").trim();
  return stored && !isDefaultInstruction(stored) ? stored : null;
}

/** Keeps `text` as this phone's instruction; blank (or either default)
 * goes back to the default. Control characters other than line breaks and
 * tabs are dropped — the desktop would refuse the whole Submit over one. */
export function writeMarkupInstruction(text: string): void {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").trim();
  writeChoice("markupInstruction", isDefaultInstruction(clean) ? "" : [...clean].slice(0, MAX_MARKUP_INSTRUCTION).join(""));
}

/** **Apply marks directly** (Home → ⚙ This device → Mark up prompt): a Submit
 * asks for an `apply` round — the desktop decides whether it can back it
 * with an undo, and answers the mode the round got. On unless switched off. */
export function readMarkupDirect(): boolean {
  return readFlag("markupDirect", true);
}

export function writeMarkupDirect(on: boolean): void {
  writeFlag("markupDirect", on);
}

/** The instruction the settings field starts from: the default of the mode
 * the switch asks for. */
export function defaultMarkupInstruction(direct: boolean): string {
  return direct ? DEFAULT_MARKUP_APPLY_INSTRUCTION : DEFAULT_MARKUP_INSTRUCTION;
}

/** What goes into the agent's chat once **Undo** put its edits back — a note,
 * not a new round: no marks, nothing to do. `files` are the project-relative
 * names the desktop answered (never a backtick in one), `more` how many it did
 * not name. */
export function markupUndoNote(files: readonly string[], more: number): string {
  const named = files.map((path) => `\`${path}\``);
  if (more > 0) named.push(more === 1 ? "1 other file" : `${more} other files`);
  const one = files.length + Math.max(0, more) === 1;
  const list = named.length === 0 ? "the files you changed"
    : named.length === 1 ? named[0]
      : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return `I undid your edits from my last marks: ${list} ${one ? "is" : "are"} back as ${one ? "it was" : "they were"} before that round. Don't redo them; no need to reply.`;
}

/** How often the agent may stop to ask about the marks: a stop of the
 * desktop's `ASK_LINES` (`markup.rs`), 0 = about every mark … 4 = never. The
 * desktop words each stop and puts it after the instruction; the phone only
 * picks one. Equal to `DEFAULT_ASK` there (a test checks this file). */
export const MARKUP_ASK_STOPS = 5;
export const DEFAULT_MARKUP_ASK = 2;

function isAskStop(value: unknown): value is string {
  return typeof value === "string" && /^[0-4]$/.test(value);
}

/** This phone's stop of the asking dial. */
export function readMarkupAsk(): number {
  return Number(readChoice("markupAsk", isAskStop, String(DEFAULT_MARKUP_ASK)));
}

/** Keeps `stop` as this phone's asking dial, clamped to the five stops. */
export function writeMarkupAsk(stop: number): void {
  const clamped = Math.min(MARKUP_ASK_STOPS - 1, Math.max(0, Math.round(stop)));
  writeChoice("markupAsk", String(Number.isFinite(clamped) ? clamped : DEFAULT_MARKUP_ASK));
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

/** Subagent mode (default off — the phone's ⋯ switch `markupSubagents`, the
 * desktop's `pdf_markup_subagents`): each Submit's prompt starts with this,
 * so the tab's agent hands the round to a fresh subagent of its own and is
 * free for the next round at once instead of working through them one after
 * the other. Rounds then run side by side on the same sources — hence the
 * re-read and own-marks-only lines. Answers to a round's markup questions and
 * **Make these changes** arrive at the master session as plain prompts; this
 * line, still in its context, tells it where to pass them. A CLI without
 * subagents does the round itself. Added on the viewer's side, after the
 * desktop built the prompt, so an older desktop needs nothing new. */
export const MARKUP_SUBAGENT_LINE = "Subagent mode: do not work on this markup round yourself. Hand this whole message to a new subagent of yours — one new subagent for each markup round I send — running in the background if you can, and end your turn once it has started, so my next round can go out at once. Earlier rounds' subagents may still be editing the same files: tell it to re-read a file right before each edit and to change only what its own marks ask for. If I answer one of its markup questions or tell you to make its changes, pass that to the same subagent if you can still reach it, else to a new one together with this round's message. If you cannot start subagents, do the round yourself.";

/** A Submit's prompt as subagent mode sends it. */
export function markupForSubagent(prompt: string): string {
  return `${MARKUP_SUBAGENT_LINE}\n\n${prompt}`;
}
