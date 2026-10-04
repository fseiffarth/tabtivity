import type { TranslationKey } from "../../src/lib/i18n";

export interface MobileSpeechRecognitionAlternative {
  transcript: string;
}

export interface MobileSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: MobileSpeechRecognitionAlternative;
}

export interface MobileSpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: MobileSpeechRecognitionResult;
}

export interface MobileSpeechRecognitionResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: MobileSpeechRecognitionResultList;
}

export interface MobileSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

export interface MobileSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  processLocally?: boolean;
  onstart: (() => void) | null;
  onresult: ((event: MobileSpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: MobileSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onspeechstart?: (() => void) | null;
  onspeechend?: (() => void) | null;
  /** With a track, the recognizer hears that capture instead of opening its own. */
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}

export interface MobileSpeechRecognitionOptions {
  langs: string[];
  processLocally: boolean;
  quality?: "command" | "dictation" | "conversation";
}

export type MobileSpeechRecognitionAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

export interface MobileSpeechRecognitionConstructor {
  new (): MobileSpeechRecognition;
  available?(
    options: MobileSpeechRecognitionOptions,
  ): Promise<MobileSpeechRecognitionAvailability>;
  install?(options: MobileSpeechRecognitionOptions): Promise<boolean>;
}

export type OnDeviceSpeechPreparation = "local" | "remote" | "installed";

type SpeechWindow = Window & {
  SpeechRecognition?: MobileSpeechRecognitionConstructor;
  webkitSpeechRecognition?: MobileSpeechRecognitionConstructor;
};

/** The Web Speech API is still vendor-prefixed in several mobile browsers. */
export function speechRecognitionConstructor(
  scope: Window = window,
): MobileSpeechRecognitionConstructor | undefined {
  const speechWindow = scope as SpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

export function speechRecognitionSupported(scope: Window = window): boolean {
  return speechRecognitionConstructor(scope) !== undefined;
}

/** How long the on-device check may take before dictation gives up on it and
 * uses the phone's speech service. Chromium answers at once. */
export const ON_DEVICE_CHECK_LIMIT_MS = 3_000;

/**
 * Whether this browser's on-device recognizer (`available`/`install`) is one
 * to ask. Only Chromium's is: Safari on an iPad has the same methods, and its
 * `available()` never settled — the dictate button sat on "Checking for
 * on-device dictation…", disabled, for good. `userAgentData` is Chromium's
 * alone, and every iOS browser is WebKit underneath.
 */
export function onDeviceSpeechAsked(
  Recognition: MobileSpeechRecognitionConstructor,
  scope: Window = window,
): boolean {
  return typeof Recognition.available === "function" && "userAgentData" in scope.navigator;
}

/** `promise`, or `fallback` once `ms` pass without it settling. */
function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T, scope: Window): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = scope.setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { scope.clearTimeout(timer); resolve(value); },
      (error: unknown) => { scope.clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Prefer Chromium's on-device dictation model. Other browsers, older ones,
 * unsupported languages, a check that does not answer, failed downloads, and
 * policy/API errors safely retain the normal browser recognition service
 * instead of making voice input disappear.
 */
export async function prepareOnDeviceSpeech(
  Recognition: MobileSpeechRecognitionConstructor,
  lang: string,
  scope: Window = window,
): Promise<OnDeviceSpeechPreparation> {
  if (!Recognition.available || !onDeviceSpeechAsked(Recognition, scope)) return "remote";
  const options: MobileSpeechRecognitionOptions = {
    langs: [lang],
    processLocally: true,
    quality: "dictation",
  };
  try {
    const availability = await settleWithin(
      Recognition.available(options),
      ON_DEVICE_CHECK_LIMIT_MS,
      "unavailable" as const,
      scope,
    );
    if (availability === "available") return "local";
    if (availability === "unavailable" || !Recognition.install) return "remote";
    // A language-pack download can outlive the transient user activation that
    // opened it. Ask for a second tap after installation so microphone capture
    // always starts from a fresh user gesture.
    return await Recognition.install(options) ? "installed" : "remote";
  } catch {
    return "remote";
  }
}

/** What one recognition session has finalized, and how much of it is already
 * in the composer. */
export interface DictationProgress {
  /** The finalized words of the recognizer's current result list. */
  heard: string[];
  /** How many of `heard` were already put into the composer. */
  inserted: number;
  /** Where the "Heard:" preview starts: the words before it were sent or cleared. */
  shownFrom: number;
}

export const DICTATION_START: DictationProgress = { heard: [], inserted: 0, shownFrom: 0 };

/** A word as two readings are compared: case and punctuation ignored, since a
 * recognizer repeating "fix the login" may repeat it as "Fix the login,". */
function wordKey(word: string): string {
  return word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** How many leading words two readings agree on. */
function sharedHead(a: string[], b: string[]): number {
  let count = 0;
  while (count < a.length && count < b.length && wordKey(a[count]) === wordKey(b[count])) count += 1;
  return count;
}

function startsWithWords(words: string[], head: string[]): boolean {
  return sharedHead(words, head) === head.length;
}

function wordsOf(text: string): string[] {
  const clean = sanitizeVoiceTranscript(text);
  return clean ? clean.split(" ") : [];
}

/** How many of `a`'s words turn up in `b`, in order. */
function wordsInOrder(a: string[], b: string[]): number {
  let count = 0;
  let from = 0;
  for (const word of a) {
    const at = b.findIndex((other, index) => index >= from && wordKey(other) === wordKey(word));
    if (at < 0) continue;
    count += 1;
    from = at + 1;
  }
  return count;
}

/** Whether `next` is `prev` said again: extended, or re-read with a word or
 * two revised. One word is too little to call a revision of. */
function sameSpeech(prev: string[], next: string[]): boolean {
  if (prev.length === 0) return false;
  if (startsWithWords(next, prev)) return true;
  return prev.length > 1 && wordsInOrder(prev, next) * 5 >= prev.length * 3;
}

/**
 * Everything the recognizer has said in this session, read off the WHOLE
 * result list and never from `resultIndex` alone. Chrome on Android hands back
 * results it already finalized with every later event, and finalizes one
 * utterance several times over as it grows ("how are", "how are you", each
 * final). A final that repeats the whole list so far, or only the utterance
 * before it, replaces what it repeats: comparing against the whole list alone
 * caught the first utterance of a session and doubled every later one.
 */
export function readDictation(
  event: MobileSpeechRecognitionResultEvent,
): { heard: string[]; interim: string } {
  let heard: string[] = [];
  /** Where the last utterance starts in `heard`. */
  let utterance = 0;
  let interim: string[] = [];
  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    const words = wordsOf(result?.[0]?.transcript ?? "");
    if (words.length === 0) continue;
    if (!result.isFinal) interim = [...interim, ...words];
    else if (heard.length > 0 && startsWithWords(words, heard)) heard = words;
    else if (sameSpeech(heard.slice(utterance), words)) heard = [...heard.slice(0, utterance), ...words];
    else {
      utterance = heard.length;
      heard = [...heard, ...words];
    }
  }
  const last = heard.slice(utterance);
  if (interim.length > 0 && startsWithWords(interim, heard)) interim = interim.slice(heard.length);
  else if (interim.length > 0 && startsWithWords(interim, last)) interim = interim.slice(last.length);
  return { heard, interim: interim.join(" ") };
}

/**
 * Folds a new reading into the progress: the words not yet in the composer
 * (`insert`, possibly empty) and the progress once they are. A reading that
 * is the last one extended or revised is the same speech, so only the words
 * past the inserted count are new — a revised word already in the composer
 * stays as it was put there, rather than the whole sentence going in a second
 * time. A reading that starts elsewhere, or came back shorter, and has little
 * in common with the last is a new result list (Chrome on Android starts one
 * after a pause), so none of it is inserted yet.
 */
export function advanceDictation(
  progress: DictationProgress,
  heard: string[],
): { progress: DictationProgress; insert: string } {
  const restarted = progress.heard.length > 0 && heard.length > 0
    && (sharedHead(heard, progress.heard) === 0 || heard.length < progress.heard.length)
    && wordsInOrder(progress.heard, heard) * 5 < progress.heard.length * 3;
  const inserted = restarted ? 0 : progress.inserted;
  return {
    insert: heard.slice(inserted).join(" "),
    progress: { heard, inserted: Math.max(inserted, heard.length), shownFrom: restarted ? 0 : progress.shownFrom },
  };
}

/** After a send or a clear. The heard words stay counted as inserted — the
 * recognizer will read them back — but the preview stops quoting them. */
export function settleDictation(progress: DictationProgress): DictationProgress {
  return { ...progress, shownFrom: progress.inserted };
}

/** What "Heard:" quotes: the words since the last send or clear, then the live guess. */
export function dictationPreview(progress: DictationProgress, interim: string): string {
  return [...progress.heard.slice(progress.shownFrom), ...(interim ? [interim] : [])].join(" ");
}

/** "go on", or German "los", said last sends the draft. Only after a word
 * boundary, so "ziellos" or a "Los Angeles" mid-draft stays text. */
const SPOKEN_SEND = /(^|[\s\p{P}])(go\s+on|los)[\s\p{P}]*$/iu;

/**
 * The draft without its spoken send, when it ends in one; `null` otherwise.
 * German "was ist los" is a question, not a send, so a "los" right after
 * "ist" stays in the draft.
 */
export function spokenSend(draft: string): string | null {
  const match = SPOKEN_SEND.exec(draft);
  if (!match) return null;
  const before = draft.slice(0, match.index);
  if (match[2].toLowerCase() === "los" && /(^|[\s\p{P}])ist$/iu.test(before.trimEnd())) return null;
  return before.replace(/[\s,;:–-]+$/u, "");
}

/** Voice text is terminal input, so never forward terminal control bytes. */
export function sanitizeVoiceTranscript(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The message for a recognizer error, as an i18n key; `null` for an abort,
 * which is the app stopping it and nothing to tell the user about. */
export function speechRecognitionError(error: string): TranslationKey | null {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "mobile.voice.errDenied";
    case "audio-capture":
      return "mobile.voice.errNoMic";
    case "network":
      return "mobile.voice.errNetwork";
    case "language-not-supported":
      return "mobile.voice.errLanguage";
    case "no-speech":
      return "mobile.voice.errNoSpeech";
    case "aborted":
      return null;
    default:
      return "mobile.voice.errStopped";
  }
}
