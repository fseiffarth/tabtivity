// What the composer was holding when its screen went away. Going back to the
// tab list unmounts the terminal, a PWA is killed and cold-started by the phone
// whenever it feels like it, and neither takes the draft anywhere: a message
// half-typed while walking to the desk was gone by the time the reader came
// back to finish it. So the text is kept here, beside the view preferences
// (`prefs.ts`) and like them never sent across the bridge — an unsent message
// is not something the desktop should be told about.
//
// Keyed by tab, because that is what the reader means by "where I was typing":
// two agent tabs each hold their own half-finished thought, and a draft must
// never surface in the session it was not meant for.

import { storageKey } from "../../src/lib/brand";

const KEY = storageKey("mobile.drafts");

/** How many tabs' drafts are kept. A phone opens a lot of sessions over a
 * month and every one of them would otherwise keep its last words forever;
 * past this many the oldest is dropped, which is the one least likely to still
 * be wanted. */
const MAX_DRAFTS = 20;

/** The longest draft stored, in characters. A pasted logfile in a composer is
 * a legitimate draft but not something to carry in a 5 MB store; past this it
 * is kept as far as it goes, and the reader still has the whole text in the
 * field they typed it into until they leave. */
const MAX_LENGTH = 20_000;

/** How long after the last keystroke the draft is written. A write is
 * synchronous and the store is re-serialized whole, so doing it per character
 * would put that work between the reader and their next letter. */
export const DRAFT_SAVE_DELAY = 400;

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface StoredDraft {
  /** The composer's text, as typed. */
  text: string;
  /** When it was last written, for deciding which draft to drop at the cap. */
  at: number;
}

/**
 * The whole store, or `{}`. Anything that is not the shape written here — a
 * hand-edited value, a half-written record, an entry from a future version —
 * is read as absent rather than trusted into a composer: a draft is text that
 * gets sent to an agent, so a bad value must mean "nothing was kept", never
 * "something odd is now in the field".
 */
function load(storage: DraftStorage): Record<string, StoredDraft> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const kept: Record<string, StoredDraft> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const { text, at } = value as Partial<StoredDraft>;
      if (typeof text !== "string" || !text || typeof at !== "number" || !Number.isFinite(at)) continue;
      kept[id] = { text, at };
    }
    return kept;
  } catch {
    // Storage can be unavailable in a private browser; the composer simply
    // opens empty, which is what it did before this existed.
    return {};
  }
}

/** The draft left in this tab's composer, or `""` when there is none. */
export function readDraft(tabId: string, storage?: DraftStorage): string {
  return load(storage ?? localStorage)[tabId]?.text ?? "";
}

/**
 * Keep this tab's draft — or forget it, which is what an empty field means: a
 * sent message and a cleared one both leave the composer empty, and in both
 * cases there is nothing left to come back to.
 */
export function writeDraft(tabId: string, text: string, storage?: DraftStorage, now: number = Date.now()): void {
  const store = storage ?? localStorage;
  try {
    const drafts = load(store);
    if (text) drafts[tabId] = { text: text.slice(0, MAX_LENGTH), at: now };
    else delete drafts[tabId];
    const kept = Object.entries(drafts)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_DRAFTS);
    if (kept.length === 0) store.removeItem(KEY);
    else store.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // See load(): a blocked or full store costs the draft, not the message the
    // reader is in the middle of typing.
  }
}
