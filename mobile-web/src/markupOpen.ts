// How a PDF the phone can mark up opens — Home → This phone → PDFs open in.
// Wherever it opens, the pen switches Mark up on as it touches a page, as
// the phone's own Markup and Notes have it (`MarkupView`); this choice only
// picks the mode the view starts in. Automatic, where an untouched phone
// starts, opens marking once only the pen draws (fingers scroll there, so
// reading loses nothing) or when marks wait to be submitted, and reading
// otherwise.

import { readChoice, writeChoice } from "./prefs";

export const MARKUP_OPENS = ["auto", "reading", "markup"] as const;
export type MarkupOpen = (typeof MARKUP_OPENS)[number];

function isMarkupOpen(value: unknown): value is MarkupOpen {
  return typeof value === "string" && (MARKUP_OPENS as readonly string[]).includes(value);
}

export function readMarkupOpen(): MarkupOpen {
  return readChoice("markupOpen", isMarkupOpen, "auto");
}

export function writeMarkupOpen(choice: MarkupOpen): void {
  writeChoice("markupOpen", choice);
}
