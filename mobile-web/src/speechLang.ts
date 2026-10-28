// Which language the phone speaks in, and listens in. Both sides of voice —
// the Reader's read-aloud (`speechOutput`) and the composer's dictation
// (`voiceInput`) — took the browser's own `navigator.language` and nothing
// else, which is right until the phone and the session disagree: a phone held
// in one language while its owner dictates in another had no way to say so,
// and a recognizer handed the wrong language either mishears or refuses
// outright ("language-not-supported"). So the phone keeps a choice of its own,
// defaulting to the browser's language, and one setting covers both
// directions: a reader who dictates German wants German read back.

import { LANGUAGES, type Language } from "../../src/lib/i18n";
import { readChoice, writeChoice } from "./prefs";

/** The region-tagged form each app language is asked for. A bare "de" is
 * legal BCP-47 and most engines take it, but Android's recognizer picks its
 * packs by the full tag, so the one with a region is the one that resolves. */
const SPOKEN_TAG: Record<Language, string> = {
  en: "en-US",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  it: "it-IT",
};

/** `auto` is the browser's own language — what this was before there was a
 * choice, and what a phone that never opens the picker keeps. */
export type SpeechLang = "auto" | Language;

/** The picker's rows. The languages are labelled in their own tongue, as in
 * the desktop's switcher; `auto` is the one row that needs translating. */
export const SPEECH_LANGS: readonly SpeechLang[] = ["auto", ...LANGUAGES.map((language) => language.value)];

/** The endonym for a row, or `null` for `auto` — whose label is an i18n key
 * the caller resolves, since "the phone's language" is a sentence, not a name. */
export function speechLangLabel(choice: SpeechLang): string | null {
  return LANGUAGES.find((language) => language.value === choice)?.label ?? null;
}

function isSpeechLang(value: unknown): value is SpeechLang {
  return value === "auto" || LANGUAGES.some((language) => language.value === value);
}

export function readSpeechLang(): SpeechLang {
  return readChoice("speechLang", isSpeechLang, "auto");
}

export function writeSpeechLang(choice: SpeechLang): void {
  writeChoice("speechLang", choice);
}

/**
 * The BCP-47 tag to speak and listen in. `scope` is the navigator to ask,
 * for the tests; a browser that reports no language at all (or reports it
 * empty) is read as US English rather than left to the engine's guess.
 */
export function speechTag(choice: SpeechLang = readSpeechLang(), scope: { language?: string } = navigator): string {
  if (choice !== "auto") return SPOKEN_TAG[choice];
  return scope.language || "en-US";
}

/** The app language a BCP-47 tag speaks (`de-AT` → `de`), for the lines and
 * the command phrases said and heard in it; English for any other. */
export function speechLanguage(tag: string = speechTag()): Language {
  const base = tag.toLowerCase().split("-")[0];
  return LANGUAGES.find((language) => language.value === base)?.value ?? "en";
}
