import { useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { sanitizeVoiceTranscript, spokenSend } from "../../../shared/voice";
import type { Language } from "../../lib/i18n";
import { ProvisionalDraft, shiftOffset, type Splice } from "../../lib/voice/provisionalDraft";
import { mayEditDraft } from "../../lib/voice/voiceCommands";

/** What `useReaderVoice` asks of the composer while it dictates: the words of
 * a segment still being said are written into the draft as they are heard
 * (`useLiveDictation`). */
export interface LiveDictation {
  /** `segment`'s newest partial (the transcript of the segment so far) goes
   * in as its provisional text. False when it is held back and the caller
   * shows it elsewhere: a spoken edit or send in the making, or nothing yet. */
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
export function useLiveDictation({ draftRef, setDraft, boxRef, language }: {
  draftRef: MutableRefObject<string>;
  setDraft: Dispatch<SetStateAction<string>>;
  boxRef: RefObject<HTMLTextAreaElement | null>;
  /** The language spoken edits are matched in. */
  language: Language;
}) {
  const spans = useRef(new ProvisionalDraft());
  const languageRef = useRef(language);
  languageRef.current = language;
  /** Where the user's selection goes once the draft is rendered. */
  const selection = useRef<{ start: number; end: number } | null>(null);

  const track = (splice: Splice) => {
    const box = boxRef.current;
    if (!selection.current && box && document.activeElement === box) {
      selection.current = { start: box.selectionStart, end: box.selectionEnd };
    }
    const kept = selection.current;
    if (kept) selection.current = { start: shiftOffset(kept.start, splice), end: shiftOffset(kept.end, splice) };
  };
  const write = (next: string, splices: Splice[]) => {
    if (next === draftRef.current) return;
    for (const splice of splices) track(splice);
    draftRef.current = next;
    setDraft(next);
  };

  const remove = (segment: number) => {
    const settled = spans.current.settle(draftRef.current, segment);
    if (settled.splice) write(settled.draft, [settled.splice]);
  };

  const live: LiveDictation = {
    show(segment, text) {
      const clean = sanitizeVoiceTranscript(text);
      // A spoken send is no text; a spoken edit, while it may still turn out
      // one, is held back like a navigation is.
      const words = spokenSend(clean) ?? clean;
      if (!words || mayEditDraft(clean, languageRef.current)) {
        remove(segment);
        return false;
      }
      const shown = spans.current.show(draftRef.current, segment, words);
      // A segment the user took over keeps their words; the Heard line still says what is heard.
      if (!shown) return false;
      write(shown.draft, [shown.splice]);
      return true;
    },
    remove,
    removeAll() {
      const cleared = spans.current.clear(draftRef.current);
      write(cleared.draft, cleared.splices);
    },
  };

  return {
    live,
    /** A final of `segment` is in: its provisional text leaves the draft.
     * `at` is where its words go (null: the end); `taken`: the user made the
     * provisional text their own, so those words must not go in again. */
    settle(segment: number): { at: number | null; taken: boolean } {
      const settled = spans.current.settle(draftRef.current, segment);
      if (settled.splice) write(settled.draft, [settled.splice]);
      return { at: settled.at, taken: settled.taken };
    },
    /** `before` became `after` by the settled words put in at `at`. */
    inserted(before: string, after: string, at: number) {
      const splice = { at, removed: 0, inserted: after.length - before.length };
      track(splice);
      spans.current.spliced(before, after, splice);
    },
    /** The draft as the user has written it: dictated-so-far words not counted. */
    settledDraft: () => spans.current.settled(draftRef.current),
    /** The draft was rendered: reconcile with it, and put the caret back. */
    rendered(draft: string, caretMoved: boolean) {
      spans.current.sync(draft);
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
