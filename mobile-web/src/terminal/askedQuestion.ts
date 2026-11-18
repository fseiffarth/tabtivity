import { agentFamily } from "../../../shared/agentComposer";
import type { AskedQuestion, TranscriptEntry } from "../api";
import { agentWork } from "./agentBusy";
import type { ReadableLine } from "./readableScreen";
import { selectSignature, type QuestionStepKeys, type QuestionTab, type SelectOption, type SelectPrompt } from "./selectPrompt";
import { inputFrameStart } from "./statusLine";

/**
 * The question Claude's `AskUserQuestion` waits on, from two sources that each
 * hold half of it: the transcript's `blocking` entry (what was asked, in full:
 * the text, headers, rows, descriptions, previews, multi-select) and the live
 * screen (where the cursor is: the focused tab, the highlighted row, the
 * ticked boxes, the review step). Shared by the desktop Reader and the phone.
 *
 * Either may come first. Screen only: today's reading of it, unchanged (the
 * caller keeps it — `mergeAskedQuestion` answers `null`). Entry only, for the
 * moment before the dialog draws: a read-only card. Both: the entry's words on
 * the screen's rows. What a tap sends is always computed from the screen's
 * reading (`answerKeys`, `tabStepKeys`), never from the entry — the merged
 * options keep the screen's `index`/`number` and the prompt its `current`.
 */

/** The dialog the screen shows, as the merge reads it: what `readReaderLive`
 * (desktop) and `readLiveQuestion` + `questionParts` (phone) give. */
export interface LiveDialog {
  question: SelectPrompt;
  /** Its own question text. */
  ask: readonly string[];
  context: readonly string[];
  tabs: readonly QuestionTab[];
  tabFocus: number | null;
  tabSubmit: boolean;
  tabKeys: QuestionStepKeys;
}

/** The card both readers draw. */
export interface AskedCard {
  /** `merged`: the entry laid over the screen's reading. `entry`: no dialog
   * on screen yet, a read-only card (`question.readOnly`). */
  kind: "merged" | "entry";
  question: SelectPrompt;
  ask: string[];
  context: string[];
  tabs: QuestionTab[];
  tabFocus: number | null;
  tabSubmit: boolean;
  tabKeys: QuestionStepKeys;
  /** What the dialog step *is*, for the caller's answered/held bookkeeping: the
   * screen's own (`selectSignature` of its reading) when merged, so a merge
   * arriving does not read as a redraw; `entry:<time>` for an entry-only card. */
  signature: string;
}

/** A preview's bounds on this side, whatever the desktop sent (it bounds it
 * the same: `MAX_PREVIEW_LINES`/`MAX_PREVIEW_CHARS`). */
const PREVIEW_LINES = 40;
const PREVIEW_CHARS = 2_000;

/** The Claude question the agent is blocked on, if `entries` end in one: the
 * last `blocking` entry that has questions. A prompt this phone has sent and
 * the session has not recorded yet may come after it. */
export function waitingQuestion(entries: readonly TranscriptEntry[]): TranscriptEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.blocking === true && entry.questions && entry.questions.length > 0) return entry;
  }
  return null;
}

const clean = (text: string): string => text.replace(/\s+/gu, " ").trim();
/** A multi-select row's box, in front of its label. */
const BOX = /^\[([^\]])\]\s+/u;

/** The preview as shown: its breaks kept, bounded. */
function boundedPreview(text: string | undefined): string | undefined {
  if (!text || !text.trim()) return undefined;
  const lines = text.split("\n");
  const kept = (lines.length > PREVIEW_LINES ? lines.slice(0, PREVIEW_LINES) : lines).join("\n");
  return kept.length > PREVIEW_CHARS ? kept.slice(0, PREVIEW_CHARS) : kept;
}

/** Whether the screen's row label is the entry's answer: the same words, or
 * the pane's cut of them (`…`). */
function sameLabel(screen: string, entry: string): boolean {
  const seen = clean(screen.replace(BOX, ""));
  const asked = clean(entry);
  if (seen === asked) return true;
  const cut = /(?:…|\.\.\.)$/u.exec(seen);
  return !!cut && cut.index > 0 && asked.startsWith(seen.slice(0, cut.index).trimEnd());
}

/** The step of the dialog on screen as an index into the entry's questions:
 * the focused tab; else, where the row paints none, the question whose text is
 * on screen (a lone question needs no telling). Null when it is none of them
 * (the Submit step, a page the entry does not hold). */
function pageOf(asked: readonly AskedQuestion[], live: LiveDialog): number | null {
  if (live.tabFocus !== null) return live.tabFocus < asked.length ? live.tabFocus : null;
  if (asked.length === 1) return 0;
  const text = clean(live.ask.join(" "));
  const found = asked.findIndex((question) => clean(question.question) === text);
  return found >= 0 ? found : null;
}

function mergedCard(asked: readonly AskedQuestion[], live: LiveDialog): AskedCard | null {
  const { question, tabs } = live;
  // The tab row is the dialog's identity: its labels are the entry's headers.
  if (question.review || tabs.length !== asked.length) return null;
  if (!asked.every((entry, index) => entry.header !== undefined && clean(entry.header) === clean(tabs[index].label))) return null;
  const page = pageOf(asked, live);
  if (page === null) return null;
  const entryOptions = asked[page].options ?? [];
  if (entryOptions.length === 0 || question.options.length < entryOptions.length) return null;
  const multi = asked[page].multiSelect === true;
  const options: SelectOption[] = [];
  for (let row = 0; row < entryOptions.length; row += 1) {
    const screen = question.options[row];
    const entry = entryOptions[row];
    if (!sameLabel(screen.label, entry.label)) return null;
    const preview = boundedPreview(entry.preview);
    const box = BOX.exec(screen.label);
    options.push({
      index: screen.index,
      number: screen.number,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
      ...(screen.keys ? { keys: screen.keys } : {}),
      ...(preview ? { preview } : {}),
      ...(multi && box ? { ticked: box[1] !== " " } : {}),
    });
  }
  return {
    kind: "merged",
    question: {
      ...question,
      source: "entry",
      ...(multi ? { multiSelect: true as const } : {}),
      options: [...options, ...question.options.slice(entryOptions.length)],
    },
    ask: asked[page].question.split("\n").map((line) => line.trimEnd()).filter((line) => line !== ""),
    context: [...live.context],
    tabs: [...tabs],
    tabFocus: live.tabFocus,
    tabSubmit: live.tabSubmit,
    tabKeys: live.tabKeys,
    signature: selectSignature(question),
  };
}

/** The read-only card of the entry's first question: the dialog opens on it,
 * and the screen has not drawn it yet. Nothing here is a row of the screen. */
function entryCard(entry: TranscriptEntry, asked: readonly AskedQuestion[]): AskedCard | null {
  const first = asked[0];
  const rows = first.options ?? [];
  if (rows.length === 0) return null;
  const multi = first.multiSelect === true;
  return {
    kind: "entry",
    question: {
      source: "entry",
      readOnly: true,
      ...(multi ? { multiSelect: true as const } : {}),
      options: rows.map((row, index): SelectOption => {
        const preview = boundedPreview(row.preview);
        return {
          index, number: index + 1, label: row.label,
          ...(row.description ? { description: row.description } : {}),
          ...(preview ? { preview } : {}),
        };
      }),
      current: -1,
      title: first.question,
      start: 0,
      question: 0,
      context: 0,
    },
    ask: first.question.split("\n").map((line) => line.trimEnd()).filter((line) => line !== ""),
    context: [],
    tabs: asked.map((entryQuestion) => ({ label: entryQuestion.header ?? "", answered: false })),
    tabFocus: 0,
    tabSubmit: false,
    tabKeys: "arrows",
    signature: `entry:${entry.at ?? ""}`,
  };
}

/**
 * The card for `entry` (the waiting question, `waitingQuestion`) over `live`
 * (what the screen shows, or null when it shows no dialog).
 *
 * - Screen and entry agree (the dialog's tab labels are the entry's headers,
 *   and its rows start with the entry's answers): the merged card.
 * - The screen shows a dialog that is not this question (a permission prompt,
 *   another set of headers, the review step): `null`, the caller keeps the
 *   screen's reading unchanged.
 * - The screen shows none: the read-only card of the entry, only where the
 *   caller says an entry may stand alone (`entryOnly`: its lamp says the agent
 *   asks — a dangling call in a dead or resumed session keeps a `blocking`
 *   entry for good).
 */
export function mergeAskedQuestion(entry: TranscriptEntry | null, live: LiveDialog | null, entryOnly = false): AskedCard | null {
  const asked = entry?.blocking === true ? entry.questions : undefined;
  if (!entry || !asked || asked.length === 0) return null;
  if (live) return mergedCard(asked, live);
  return entryOnly ? entryCard(entry, asked) : null;
}

/**
 * Whether the phone's live screen leaves room for an entry-only card. The
 * phone has no live lamp (`tab.agent_status` is the tab list's snapshot from
 * when the screen was opened), so the screen stands in: Claude Code hides its
 * input box while a dialog is up, and the dialog is drawn a moment after the
 * `tool_use` lands in the transcript while a busy row is still on screen. A
 * screen with a box and no busy row is an idle session — whatever `blocking`
 * entry it still has is a leftover. A blank screen says nothing yet.
 */
export function entryCardAllowed(screen: readonly ReadableLine[], agentLabel: string): boolean {
  if (agentFamily(agentLabel) !== "claude") return false;
  if (!screen.some((line) => line.text.trim() !== "")) return false;
  return inputFrameStart(screen, agentLabel) >= screen.length || agentWork(screen) !== null;
}
