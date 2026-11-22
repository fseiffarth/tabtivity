import { useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { sanitizeVoiceTranscript, spokenSend } from "../../../shared/voice";
import type { Language } from "../../lib/i18n";
import { draftChange, ProvisionalDraft, rebaseRange, replaceDictated, shiftOffset, type DraftRange, type Splice } from "../../lib/voice/provisionalDraft";
import { mayAskHelp, mayEditDraft, mayNavigate } from "../../lib/voice/voiceCommands";

/** What `useReaderVoice` asks of the composer while it dictates: the words of
 * a segment still being said are written into the draft as they are heard
 * (`useLiveDictation`). */
export interface LiveDictation {
  capture?(source: EventTarget | null): void;
  begin?(segment: number): void;
  hide?(segment: number): void;
  fail(segment: number): void;
  dismissRecovery(): void;
  restoreRecovery(): void;
  hasRecovery(): boolean;
  recovery: readonly { segment: number; text: string; ambiguous: boolean }[];
  /** False when the partial is held for command recognition or belongs to the user. */
  show(segment: number, text: string): boolean;
  /** `segment` ended with nothing for the draft: its provisional text goes. */
  remove(segment: number): void;
  /** A session began, ended or was dropped: no provisional text stays. */
  removeAll(): void;
}

/** The composer's side of `LiveDictation`: the provisional spans in its draft
 * (`ProvisionalDraft`), the settled draft they leave, and the caret kept where
 * the user had it. Partials bypass the undo history (only a settled final is a
 * step); the draft's other writers are reconciled through `sync`. */
export function useLiveDictation({ draftRef, setDraft, boxRef, language, record }: {
  draftRef: MutableRefObject<string>;
  setDraft: Dispatch<SetStateAction<string>>;
  boxRef: RefObject<HTMLTextAreaElement | null>;
  /** The language spoken edits are matched in, read when a partial is judged. */
  language: () => Language;
  record(before: string, after: string): void;
}) {
  const spans = useRef(new ProvisionalDraft());
  const languageRef = useRef(language);
  languageRef.current = language;
  /** Where the user's selection goes once the draft is rendered. */
  const selection = useRef<{ start: number; end: number } | null>(null);

  const cursor = useRef<DraftRange | null>(null);
  const seen = useRef(draftRef.current);
  const offers = useRef<{ segment: number; text: string; range: DraftRange | null }[]>([]);
  const [, refresh] = useState(0);
  const dismissRecovery = () => {
    if (!offers.current.length) return;
    offers.current = [];
    refresh(n => n + 1);
  };
  const rebase = (splice: Splice, segment?: number) => {
    if (cursor.current) cursor.current = rebaseRange(cursor.current, splice);
    for (const item of offers.current) {
      // Later speech can start exactly where this failed phrase will be
      // restored. Keep the earlier phrase ahead of that insertion.
      if (segment !== undefined && item.segment < segment && item.range?.end === splice.at) continue;
      if (item.range) {
        item.range = rebaseRange(item.range, splice);
        if (!item.range) refresh(n => n + 1);
      }
    }
  };
  const sync = () => {
    const draft = draftRef.current;
    if (draft !== seen.current) rebase(draftChange(seen.current, draft));
    seen.current = draft;
    spans.current.sync(draft);
  };
  const capture = (source: EventTarget | null) => {
    sync();
    const box = boxRef.current;
    cursor.current = box && source === box ? { start: box.selectionStart, end: box.selectionEnd } : null;
  };

  const track = (splice: Splice) => {
    const box = boxRef.current;
    if (!selection.current && box && document.activeElement === box) {
      selection.current = { start: box.selectionStart, end: box.selectionEnd };
    }
    const kept = selection.current;
    if (kept) selection.current = { start: shiftOffset(kept.start, splice), end: shiftOffset(kept.end, splice) };
  };
  const write = (next: string, splices: Splice[], segment?: number) => {
    if (next === draftRef.current) return;
    for (const splice of splices) {
      track(splice);
      rebase(splice, segment);
    }
    seen.current = next;
    draftRef.current = next;
    setDraft(next);
  };

  const remove = (segment: number) => {
    sync();
    const settled = spans.current.settle(draftRef.current, segment);
    if (settled.splice) write(settled.draft, [settled.splice], segment);
  };

  const hide = (segment: number) => {
    sync();
    const result = spans.current.hide(draftRef.current, segment);
    if (result.splice) write(result.draft, [result.splice], segment);
  };

  const live: LiveDictation = {
    capture,
    hide,
    begin(segment) {
      sync();
      const range = cursor.current ?? { start: draftRef.current.length, end: draftRef.current.length };
      spans.current.begin(draftRef.current, segment, range);
      cursor.current = { start: range.end, end: range.end };
    },
    get recovery() {
      return offers.current.map(item => ({ segment: item.segment, text: item.text, ambiguous: !item.range }));
    },
    hasRecovery: () => offers.current.length > 0,
    dismissRecovery,
    fail(segment) {
      if (offers.current.some(item => item.segment === segment)) return;
      sync();
      const result = spans.current.settle(draftRef.current, segment);
      if (result.splice) write(result.draft, [result.splice], segment);
      if (result.taken) return;
      offers.current.push({ segment, text: result.words, range: result.at === null ? null :
        { start: result.at, end: result.at + result.original.length } });
      offers.current.sort((a, b) => a.segment - b.segment);
      refresh(n => n + 1);
    },
    restoreRecovery() {
      sync();
      const before = spans.current.settled(draftRef.current);
      for (const item of offers.current) {
        if (!item.text) continue;
        const current = draftRef.current;
        const range = item.range ?? { start: current.length, end: current.length };
        const next = replaceDictated(current, range, item.text);
        const removed = range.end - range.start;
        const splice = { at: range.start, removed, inserted: next.length - current.length + removed };
        spans.current.spliced(current, next, splice);
        write(next, [splice], item.segment);
      }
      record(before, spans.current.settled(draftRef.current));
      dismissRecovery();
    },
    show(segment, text) {
      sync();
      const clean = sanitizeVoiceTranscript(text);
      // A spoken send is no text; a spoken edit, "{assistant} navigate" or
      // "{assistant} help", while it may still turn out one, is held back:
      // the Heard line shows it, the draft never does.
      const words = spokenSend(clean) ?? clean;
      const lang = languageRef.current();
      if (!words || mayEditDraft(clean, lang) || mayNavigate(clean, lang) || mayAskHelp(clean, lang)) {
        hide(segment);
        return false;
      }
      const shown = spans.current.show(draftRef.current, segment, words);
      // A segment the user took over keeps their words; the Heard line still says what is heard.
      if (!shown) return false;
      write(shown.draft, [shown.splice], segment);
      return true;
    },
    remove,
    removeAll() {
      sync();
      const cleared = spans.current.clear(draftRef.current);
      write(cleared.draft, cleared.splices);
    },
  };

  return {
    live,
    capture,
    /** A final of `segment` is in: its provisional text leaves the draft.
     * `at` is where its words go (null: the end); `taken`: the user made the
     * provisional text their own, so those words must not go in again. */
    settle(segment: number) {
      sync();
      const settled = spans.current.settle(draftRef.current, segment);
      if (settled.splice) write(settled.draft, [settled.splice], segment);
      return { at: settled.at, taken: settled.taken, removed: settled.original.length };
    },
    /** `before` became `after` by the settled words put in at `at`. */
    inserted(before: string, after: string, at: number, removed: number, segment: number) {
      const splice = { at, removed, inserted: after.length - before.length + removed };
      rebase(splice, segment);
      seen.current = after;
      track(splice);
      spans.current.spliced(before, after, splice);
    },
    /** The draft as the user has written it: dictated-so-far words not counted. */
    settledDraft: () => spans.current.settled(draftRef.current),
    /** The draft was rendered: reconcile with it, and put the caret back. */
    rendered(caretMoved: boolean) {
      sync();
      const kept = selection.current;
      selection.current = null;
      const box = boxRef.current;
      if (kept && !caretMoved && box && document.activeElement === box) {
        const length = box.value.length;
        box.setSelectionRange(Math.min(kept.start, length), Math.min(kept.end, length));
      }
    },
  };
}
