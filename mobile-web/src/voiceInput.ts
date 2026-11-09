import type { TranslationKey } from "../../src/lib/i18n";
import { sanitizeVoiceTranscript } from "../../shared/voice";

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

/** Where the live (interim) words of a reading stand against the finalized
 * ones: `extends` the last utterance (it is still growing), `new` (a next
 * utterance has begun, or the first one has no final yet), or `none`. */
export type InterimTail = "none" | "extends" | "new";

/** What one recognizer event says, utterance by utterance. */
export interface DictationScan {
  /** The finalized words of the whole result list. */
  heard: string[];
  /** The live words past the finalized ones (what "Heard:" adds). */
  interim: string;
  /** Where each utterance begins in `heard` (ascending). An utterance is one
   * stretch of speech the recognizer grew into, however often it finalized
   * it on the way. */
  starts: number[];
  tail: InterimTail;
  /** The live utterance as it stands, finalized words and interim together:
   * the last utterance with its live words, or the new one; empty with no
   * utterance at all. */
  live: string[];
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
export function scanDictation(event: MobileSpeechRecognitionResultEvent): DictationScan {
  let heard: string[] = [];
  /** Where each utterance starts in `heard`. */
  const starts: number[] = [];
  let interim: string[] = [];
  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    const words = wordsOf(result?.[0]?.transcript ?? "");
    if (words.length === 0) continue;
    const utterance = starts.length > 0 ? starts[starts.length - 1] : 0;
    if (!result.isFinal) interim = [...interim, ...words];
    else if (heard.length > 0 && startsWithWords(words, heard)) heard = words;
    else if (sameSpeech(heard.slice(utterance), words)) heard = [...heard.slice(0, utterance), ...words];
    else {
      starts.push(heard.length);
      heard = [...heard, ...words];
    }
  }
  const last = heard.slice(starts.length > 0 ? starts[starts.length - 1] : 0);
  let tail: InterimTail = "none";
  let live = last;
  if (interim.length > 0) {
    if (heard.length === 0) {
      tail = "new";
      live = interim;
    } else if (startsWithWords(interim, heard)) {
      tail = "extends";
      live = [...last, ...interim.slice(heard.length)];
      interim = interim.slice(heard.length);
    } else if (startsWithWords(interim, last)) {
      tail = "extends";
      live = [...last, ...interim.slice(last.length)];
      interim = interim.slice(last.length);
    } else if (sameSpeech(last, interim)) {
      tail = "extends";
      live = interim;
    } else {
      tail = "new";
      live = interim;
    }
  }
  return { heard, interim: interim.join(" "), starts, tail, live };
}

/** What `scanDictation` says without the utterances: the finalized words and
 * the live guess. */
export function readDictation(
  event: MobileSpeechRecognitionResultEvent,
): { heard: string[]; interim: string } {
  const { heard, interim } = scanDictation(event);
  return { heard, interim };
}

/** Whether `heard` is a result list starting over (Chrome on Android starts
 * one after a pause), against the last reading `prev`. */
function resultListRestarted(prev: string[], heard: string[]): boolean {
  return prev.length > 0 && heard.length > 0
    && (sharedHead(heard, prev) === 0 || heard.length < prev.length)
    && wordsInOrder(prev, heard) * 5 < prev.length * 3;
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
  const restarted = resultListRestarted(progress.heard, heard);
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

// ---------------------------------------------------------------- utterances

/** No result for this long and the live utterance is whole: a command is
 * matched on it only then, never on one still growing. */
export const UTTERANCE_SETTLE_MS = 800;
/** After a bare start word, the next utterance is the prompt for this long. */
export const GATE_WINDOW_MS = 10_000;

/** What the utterance layer needs to know of the start word, in the spoken
 * language (built from `matchStartWord` / `mayNavigate`, which read the
 * dictionary; this file stays free of both). */
export interface StartLexicon {
  /** How many leading words of `words` are the start word, 0 when they do not
   * begin with it (two words run together count as 2). */
  start(words: readonly string[]): number;
  /** Whether `words` may still turn out a "start word + navigate" command: the
   * start word alone, with the first letters of the navigate word, or with
   * the whole phrase and more. Such an utterance is held back from the draft
   * until it settles. */
  mayNavigate(words: readonly string[]): boolean;
}

/** What is known of one utterance, judged once when it was first heard. */
export interface UtteranceRecord {
  /** The Tabby gate was on when it began: only an utterance with the start
   * word first (or one the gate was open to) is kept. */
  gated: boolean;
  /** Navigation mode was open: the utterance is a command, never typed. */
  captured: boolean;
  /** The gate was open to it at its start (a bare start word just before, or a
   * draft already under way). */
  open: boolean;
  /** `null` while one word cannot tell yet, then kept or dropped for good. */
  keep: boolean | null;
  /** How many leading words are the start word, left out of the draft. */
  skip: number;
  /** Some of it was held back because it may be a command. */
  withheld: boolean;
  /** A command took it. */
  handled: boolean;
  /** It was offered to `onWithheld`. */
  reported: boolean;
  /** Its bare start word was announced (`UtteranceStep.bare`). */
  announced: boolean;
}

/** The utterances of one result list, by where each starts in its `heard`. */
export interface UtteranceLedger {
  records: Readonly<Record<number, UtteranceRecord>>;
  starts: readonly number[];
}

export const UTTERANCES_START: UtteranceLedger = { records: {}, starts: [] };

export interface UtteranceOptions {
  now?: number;
  /** The Tabby gate is on (hands-free only). A function is asked as each new
   * utterance begins: a command taken from an earlier utterance of the same
   * event may have set or cleared it. */
  gate: boolean | (() => boolean);
  /** Hold back utterances that may be a command ("Tabby navigate"). */
  holdBack: boolean;
  /** Navigation mode is open: every new utterance is a command, held until it
   * settles, offered to `onWithheld` and never typed. A function is asked as
   * each new utterance begins (see `gate`): two utterances finalized in one
   * event are each judged by the mode as the one before it left it. */
  capture?: boolean | (() => boolean);
  /** The gate lets a new utterance through without the start word: a bare start
   * word was just said, or the draft already holds the prompt's start. */
  open?: boolean;
  /** Settle the live utterance too: the timer, a recognizer restart, a stop. */
  flush?: boolean;
  /** A held utterance has settled, as one whole text. True when a command took
   * it (it is then not typed). Called once per utterance. */
  onWithheld?: (utterance: string) => boolean;
}

export interface UtteranceStep {
  ledger: UtteranceLedger;
  progress: DictationProgress;
  /** The words to put in the composer (empty for most events). */
  insert: string;
  /** What "Heard:" quotes: the kept words since the last send, then the live ones. */
  preview: string;
  /** A bare start word settled: the next utterance is the prompt. */
  bare: boolean;
  /** A new utterance took the gate's open window (or the draft's). */
  opened: boolean;
  /** Words are being held back (a possible command, or a first word that
   * cannot tell yet): speech is still open as far as hands-free's pause goes. */
  held: boolean;
}

/** The live utterance as words ("how are you today"), finalized and interim
 * together. */
export function currentUtterance(scan: DictationScan): string[] {
  return scan.live;
}

/** A flag that may be asked late. */
function flag(value: boolean | (() => boolean) | undefined): boolean {
  return typeof value === "function" ? value() : value === true;
}

interface Run {
  records: Record<number, UtteranceRecord>;
  cursor: number;
  inserts: string[];
  kept: string[];
  bare: boolean;
  opened: boolean;
  /** The live words belong to an utterance that is not kept (yet). */
  hideLive: boolean;
  held: boolean;
}

function runUtterances(
  prev: UtteranceLedger,
  progress: DictationProgress,
  scan: DictationScan,
  lex: StartLexicon,
  opts: UtteranceOptions,
): Run {
  const records: Record<number, UtteranceRecord> = { ...prev.records };
  const { heard, starts } = scan;
  const run: Run = { records, cursor: progress.inserted, inserts: [], kept: [], bare: false, opened: false, hideLive: false, held: false };
  const flush = opts.flush === true;
  starts.forEach((s, index) => {
    const e = starts[index + 1] ?? heard.length;
    const words = heard.slice(s, e);
    const last = index === starts.length - 1;
    // A later utterance, or a live one that began after it, ends this one.
    const settled = !last || scan.tail === "new" || flush;
    let rec = records[s];
    if (!rec) {
      if (e <= run.cursor) return;
      const captured = flag(opts.capture);
      rec = {
        gated: flag(opts.gate) && !captured, captured, open: opts.open === true, keep: null, skip: 0,
        withheld: captured, handled: false, reported: false, announced: false,
      };
    } else rec = { ...rec };
    records[s] = rec;
    if (rec.keep === null) {
      if (!rec.gated) rec.keep = true;
      else {
        const skip = lex.start(words);
        if (skip > 0) { rec.keep = true; rec.skip = skip; }
        else if (rec.open) { rec.keep = true; run.opened = true; }
        else if (words.length > 1 || settled) rec.keep = false;
      }
    }
    if (last && rec.keep !== true) run.hideLive = true;
    if (rec.keep === false) {
      run.cursor = Math.max(run.cursor, e);
      return;
    }
    if (rec.handled) {
      run.cursor = Math.max(run.cursor, e);
      return;
    }
    const view = last && scan.tail === "extends" ? scan.live : words;
    const holds = rec.captured || (opts.holdBack && rec.keep === true && lex.mayNavigate(view));
    if (holds) rec.withheld = true;
    const quote = (from: number) => {
      const begin = Math.max(progress.shownFrom, s + rec.skip, from);
      if (begin < e) run.kept.push(...heard.slice(begin, e));
    };
    if (rec.keep === null || (!settled && holds)) {
      // Held back: nothing of it reaches the draft yet.
      run.held = true;
      if (rec.keep !== null) quote(0);
      return;
    }
    if (settled && rec.withheld && !rec.reported) {
      rec.reported = true;
      if (opts.onWithheld?.(view.join(" ")) === true) rec.handled = true;
      if (rec.handled || rec.captured) {
        run.cursor = Math.max(run.cursor, e);
        if (rec.captured) quote(0);
        return;
      }
    }
    if (settled && rec.gated && rec.keep === true && rec.skip > 0 && words.length === rec.skip && !rec.announced) {
      rec.announced = true;
      run.bare = true;
    }
    const from = Math.max(run.cursor, s + rec.skip);
    if (from < e) run.inserts.push(heard.slice(from, e).join(" "));
    run.cursor = Math.max(run.cursor, e);
    quote(0);
  });
  return run;
}

/**
 * The utterance layer. Folds one recognizer reading into the composer: which
 * of its words are new (`insert`), which utterances the Tabby gate drops, and
 * which are held back because they may be a command — judged per *utterance*,
 * not per delta, since "Tabby" and "Tabby navigate" arrive as the same
 * utterance finalized twice, and `advanceDictation`'s words-since-last-event
 * cannot tell where an utterance began.
 *
 * - **Gate** (`opts.gate`): an utterance is kept only if the start word is
 *   its first word (the start word itself is left out) or the gate is open to
 *   it (`opts.open`); anything else is dropped, whole. The verdict is made
 *   once, from the utterance's first words, and kept while it grows.
 * - **Hold-back** (`opts.holdBack`): while the utterance so far may become
 *   "start word + navigate …" (`StartLexicon.mayNavigate`), none of it is
 *   inserted, gate on or off. When it settles it is offered to
 *   `opts.onWithheld`; a command takes it, otherwise it is inserted as heard.
 * - **Capture** (`opts.capture`): every new utterance is held and offered,
 *   never inserted — navigation mode's answers.
 * - **Settle**: an utterance is whole once a later one begins, or on
 *   `opts.flush` (no result for `UTTERANCE_SETTLE_MS`, a restart, a stop).
 *
 * With `gate`, `holdBack` and `capture` all off this is `advanceDictation`.
 */
export function stepUtterances(
  prev: UtteranceLedger,
  progress: DictationProgress,
  scan: DictationScan,
  lex: StartLexicon,
  opts: UtteranceOptions,
): UtteranceStep {
  // A reading that starts a new result list: the old list's last utterance is
  // over, and nothing of the new one is in the composer yet.
  if (resultListRestarted(progress.heard, scan.heard)) {
    const closed = settleUtterances(prev, progress, lex, opts);
    const next = stepUtterances(
      UTTERANCES_START, { heard: [], inserted: 0, shownFrom: 0 }, scan, lex, { ...opts, open: opts.open || closed.bare },
    );
    return {
      ...next,
      insert: [closed.insert, next.insert].filter(Boolean).join(" "),
      bare: closed.bare || next.bare,
      opened: closed.opened || next.opened,
      held: next.held,
    };
  }
  const run = runUtterances(prev, progress, scan, lex, opts);
  const tailQuote = scan.tail === "new"
    ? scan.live.slice(!flag(opts.gate) || opts.open || flag(opts.capture) ? 0 : lex.start(scan.live) || scan.live.length)
    : scan.tail === "extends" && !run.hideLive ? scan.interim.split(" ").filter(Boolean) : [];
  return {
    ledger: { records: run.records, starts: scan.starts },
    progress: { heard: scan.heard, inserted: run.cursor, shownFrom: progress.shownFrom },
    insert: run.inserts.join(" "),
    preview: [...run.kept, ...tailQuote].join(" "),
    bare: run.bare,
    opened: run.opened,
    held: run.held,
  };
}

/** The live utterance is whole: the timer ran out, the recognizer restarted or
 * the mic stopped. Held words are offered to `onWithheld` and, unless a
 * command took them, inserted. `last` is the reading the quiet followed, so the
 * live words it showed stay in the preview. */
export function settleUtterances(
  ledger: UtteranceLedger,
  progress: DictationProgress,
  lex: StartLexicon,
  opts: UtteranceOptions,
  last?: DictationScan,
): UtteranceStep {
  const scan: DictationScan = {
    interim: "", tail: "none", live: [], ...last, heard: progress.heard, starts: [...ledger.starts],
  };
  return stepUtterances(ledger, progress, scan, lex, { ...opts, flush: true });
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
