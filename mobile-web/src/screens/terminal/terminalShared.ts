// What the phone terminal screen (`screens/Terminal.tsx`) and its hooks under
// `screens/terminal/` share: the composer's upload rows, the draft's
// attachment line, and the timings more than one of them waits on.
import { NAMES } from "../../../../src/lib/brand";
import { type TranslationKey } from "../../../../src/lib/i18n";
import { leafName } from "../../components/InboxPreview";
import { type OutboxFile } from "../../api";
import { inboxLeaves, withoutInboxReferences } from "../../terminal/inboxRefs";

/** A line the dictation strip shows: a key, not a sentence, so switching the
 * language retranslates what is already on screen. */
export type VoiceNote = { key: TranslationKey; language?: string };

/** Turns fetched at first, and added per "Show earlier turns" tap. */
export const TRANSCRIPT_STEP = 120;

/** When the Reader reads the session again after an Undo: a relaunched agent
 * takes a few seconds to come back onto the conversation it resumes. */
export const UNDO_RELOADS = [2_000, 5_000, 10_000];

export const CODEX_AGENT = /codex/iu;

/** How long the model sheet waits for the session to draw the picker `/model`
 * opens. Past it the sheet steps aside: the dialog — or the reason there is
 * none — is in the session output, and the arrow keys still answer it. */
export const MODEL_PICKER_WAIT = 6_000;

/** How long after asking a CLI for its sign-in link (`askForLink`) its
 * clipboard copy is taken as the answer. */
export const LINK_WAIT_MS = 5_000;

/** A file on its way into the project inbox — from the phone, or copied on
 * the desktop's side — one that landed, or one that did not make it. A
 * landed one waits beside the composer with its `@` reference until the
 * message goes: writing the reference into the draft while the reader types
 * would pull the text out from under their keyboard. */
export interface InboxUpload {
  id: number;
  name: string;
  /** Where the bytes come from; a desktop copy never leaves the desktop. */
  source: "phone" | "desktop";
  /** The desktop's project-relative reference, once the file has landed. */
  reference?: string;
  /** Why it did not land, said after its name. */
  failure?: TranslationKey;
  /** The phone's own copy of a picture (an object URL), shown while it
   * travels and after; the inbox's copy stands in for the others. */
  preview?: string;
}

/** The inbox leaf a landed file's reference names. */
export const leafOfReference = (reference: string) => reference.slice(reference.lastIndexOf("/") + 1);

/** A stored draft as the composer shows it: the inbox references it carried
 * (`withAttachments` folded them in when the screen went away) lifted back
 * out as landed files beside the draft, not as `@` text in it. */
export function liftedDraft(stored: string): { text: string; uploads: InboxUpload[] } {
  const leaves = inboxLeaves(stored);
  if (leaves.length === 0) return { text: stored, uploads: [] };
  const lifted = withoutInboxReferences(stored);
  return {
    text: lifted && /\s$/u.test(stored) ? `${lifted} ` : lifted,
    // Negative ids: never one `uploadSeq` hands out.
    uploads: leaves.map((leaf, index) => ({ id: -1 - index, name: leafName(leaf), source: "phone", reference: `${NAMES.inboxDir}/${leaf}` })),
  };
}

/** Whether a file is still on its way — Send waits for it. */
export const uploadInFlight = (upload: InboxUpload) => !upload.failure && upload.reference === undefined;

/** The draft with the landed files' `@` references after it — what Send
 * sends, and what the draft store keeps when the screen goes away. */
export function withAttachments(text: string, uploads: readonly InboxUpload[]): string {
  const references = uploads.flatMap((upload) => upload.reference === undefined || upload.failure ? [] : [`@${upload.reference}`]);
  if (references.length === 0) return text;
  return `${text}${text && !/\s$/u.test(text) ? " " : ""}${references.join(" ")} `;
}

/** Where a prompt bubble's inbox files come from and go to. */
export interface ChatInbox {
  tabId: string;
  files: ReadonlyMap<string, OutboxFile | null>;
  onOpen: (file: OutboxFile) => void;
  onSettle?: () => void;
}
