import type { TranslationKey } from "../i18n";
import { lastSpokenSpan, type SpokenDraftEdit } from "./voiceCommands";

// Spoken corrections of the composer's draft ("Tabby scratch that", "Tabby
// replace X by Y", "Tabby correction …", "Tabby clear all", "Tabby plan"):
// what each does to the text, for the phone's dictation (`useVoiceInput`) and
// the desktop Chat's (`TerminalReaderView`). Pure — the phone imports it.
//
// Voice keeps its own short history of what it did to the draft: each
// dictated piece and each edit, with the draft before and after. It holds
// only while the draft is still what voice left: typing, a send or a clear in
// between makes it stale, and "scratch that" then says there is nothing to
// take back rather than guess at text the user wrote.

/** What the composer's voice line says after an edit. */
export interface DraftEditNote {
  key: TranslationKey;
  params?: Record<string, string>;
}

export interface DraftEditOutcome {
  /** The new draft, or `null` when it stays as it is. */
  draft: string | null;
  note: DraftEditNote;
}

/** The draft led by `command` (`/plan`, `/goal`) as the chip leads it, or
 * `null` when this agent offers no such chip. */
export type LeadDraft = (draft: string, command: "/plan" | "/goal") => string | null;

interface DraftStep {
  kind: "piece" | "edit";
  before: string;
  after: string;
  /** A piece's words, for "Removed …". */
  text: string;
}

const MAX_STEPS = 50;
/** A note quotes at most this many characters of the draft. */
const NOTE_CHARS = 60;

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > NOTE_CHARS ? `${flat.slice(0, NOTE_CHARS - 1)}…` : flat;
}

/** `text` after `before`, a space between, as dictation joins pieces. */
export function joinDictated(before: string, text: string): string {
  return `${before}${before && !/\s$/u.test(before) ? " " : ""}${text}`;
}

/** The replacement spelled to fit where it goes: a capital stays a capital
 * ("Fix the parser", "replace fix with check" → "Check the parser"). */
function fitCase(replaced: string, to: string): string {
  return /^\p{Lu}/u.test(replaced) && /^\p{Ll}/u.test(to) ? `${to[0].toLocaleUpperCase()}${to.slice(1)}` : to;
}

export class DraftVoiceHistory {
  private steps: DraftStep[] = [];

  /** A dictated piece went into the draft: `before` → `after`. */
  piece(before: string, after: string, text: string): void {
    this.push({ kind: "piece", before, after, text });
  }

  /** Forget everything: the draft went another way (a send). */
  clear(): void {
    this.steps = [];
  }

  private push(step: DraftStep): void {
    // A step on a draft voice did not leave starts a new history.
    const top = this.steps[this.steps.length - 1];
    if (top && top.after !== step.before) this.steps = [];
    this.steps.push(step);
    if (this.steps.length > MAX_STEPS) this.steps.shift();
  }

  /** The last step, while the draft is still what it left; else none, and
   * the history is dropped. */
  private live(draft: string): DraftStep | null {
    const top = this.steps[this.steps.length - 1];
    if (top && top.after === draft) return top;
    this.steps = [];
    return null;
  }

  /** What `edit` does to `draft`. A change is recorded, so the next
   * "scratch that" takes it back. */
  apply(edit: SpokenDraftEdit, draft: string, lead: LeadDraft): DraftEditOutcome {
    switch (edit.kind) {
      case "prefix": {
        const next = lead(draft, edit.command);
        if (next === null) return { draft: null, note: { key: "voice.editNote.noPrefix", params: { command: edit.command } } };
        if (next !== draft) this.push({ kind: "edit", before: draft, after: next, text: "" });
        return { draft: next === draft ? null : next, note: { key: "voice.editNote.prefix", params: { command: edit.command } } };
      }
      case "undo": {
        const top = this.live(draft);
        if (!top) return { draft: null, note: { key: "voice.editNote.nothingToUndo" } };
        this.steps.pop();
        return {
          draft: top.before,
          note: top.kind === "piece" ? { key: "voice.editNote.removed", params: { text: clip(top.text) } } : { key: "voice.editNote.undone" },
        };
      }
      case "clear": {
        if (!draft.trim()) return { draft: null, note: { key: "voice.editNote.empty" } };
        this.push({ kind: "edit", before: draft, after: "", text: "" });
        return { draft: "", note: { key: "voice.editNote.cleared" } };
      }
      case "replace": {
        for (const { from, to } of edit.splits) {
          const span = lastSpokenSpan(draft, from, edit.lang);
          if (!span) continue;
          const replaced = draft.slice(span.start, span.end);
          const next = `${draft.slice(0, span.start)}${fitCase(replaced, to)}${draft.slice(span.end)}`;
          this.push({ kind: "edit", before: draft, after: next, text: "" });
          return { draft: next, note: { key: "voice.editNote.replaced", params: { from: clip(replaced), to: clip(to) } } };
        }
        // The shortest reading is the likeliest one meant.
        const shortest = edit.splits[edit.splits.length - 1];
        return { draft: null, note: { key: "voice.editNote.notFound", params: { text: clip(shortest?.from ?? "") } } };
      }
      case "restate": {
        // The last dictated piece, said again; with none to correct, the words
        // still go in rather than being lost.
        const top = this.live(draft);
        const base = top?.kind === "piece" ? top.before : draft;
        if (top?.kind === "piece") this.steps.pop();
        const next = joinDictated(base, edit.text);
        this.push({ kind: "piece", before: base, after: next, text: edit.text });
        return {
          draft: next,
          note: { key: top?.kind === "piece" ? "voice.editNote.restated" : "voice.editNote.added", params: { text: clip(edit.text) } },
        };
      }
    }
  }
}
