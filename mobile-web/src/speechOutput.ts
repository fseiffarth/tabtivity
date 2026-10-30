// Reading the Focus chat aloud: the browser's own speech synthesis, so an
// answer's text never leaves the phone to be spoken.
//
// An agent's answers are read through the reading model
// (`shared/voiceReading.ts`): each answer an outline of sections and short
// chunks, walked by a cursor that the spoken navigation moves (next section,
// next answer, back, repeat, where, summary, read all, read the code). There
// is one cursor per tab, kept here in module state: that is the read
// position, so it survives a reconnect, a tab switch and a remount, but not a
// reload. It holds tab ids, so it is never written to storage.
//
// Anything else (a question read out, the probe's lines) is plain text spoken
// in sentence-sized pieces, queued behind what is already being said.
//
// The moves are plain functions (`readNext`, `readBack`, …, and
// `runReadingCommand` for a `matchReading` result), so the hands-free session,
// the Media Session buttons and the listening gaps call the same ones. A
// listening gap hooks in through `onSectionEnd`. Every move bumps
// `generation`, so the utterance it cut off starts nothing when it ends.

import { speechChunks } from "../../shared/voice";
import {
  createReadingCursor, DRIVING_LIMITS, KITCHEN_LIMITS, MAX_SPEECH_CHUNK, readingLabels, type ReadingAnswer,
  type ReadingChunk, type ReadingCursor, type ReadingOptions, type ReadingPosition,
} from "../../shared/voiceReading";
import { loadDict, translate, type Language } from "../../src/lib/i18n";
import type { VoiceReadId } from "../../src/lib/voice/voiceCommands";
import { readChoice, readFlag, writeChoice, writeFlag } from "./prefs";
import { speechLanguage } from "./speechLang";

/** Chrome on Android cuts an utterance off after about fifteen seconds, and an
 * utterance it cut never ends — the queue behind it hangs. Sentence-sized
 * pieces stay well under that. */
const MAX_CHUNK = MAX_SPEECH_CHUNK;

/** More new answers than this at once is a session that was swapped in or
 * caught up on, not one that is talking: read-aloud leaves those to the eye. */
export const MAX_SPOKEN_AT_ONCE = 3;

/** The rate steps "faster" / "slower" walk, 1 being the voice's own pace. */
export const READING_RATES = [0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2] as const;

export function speechOutputSupported(scope: Window = window): boolean {
  return "speechSynthesis" in scope && "SpeechSynthesisUtterance" in scope;
}

// ---------------------------------------------------------------------------
// Settings: rate, brief, driving

function isRate(value: unknown): value is string {
  return READING_RATES.some((rate) => String(rate) === value);
}

let rate: number | null = null;

/** The speaking rate, persisted (`voiceRate`). */
export function readingRate(): number {
  rate ??= Number(readChoice("voiceRate", isRate, "1"));
  return rate;
}

/** Whether answers are read in brief (headings and first sentences) by
 * default, persisted (`voiceBrief`). "read all" reads one answer in full. */
export function readBrief(): boolean {
  return readFlag("voiceBrief");
}

/** Driving mode reads briefly, with long answers only announced. Set by the
 * hands-free session (`voiceDriving`); not stored here. */
let driving = false;

// ---------------------------------------------------------------------------
// Per-tab readings

/** A cursor and what feeds it. `key` is the tab id, or `MESSAGE` for a
 * message read from its menu that is not one of a tab's answers. */
interface Reading {
  key: string;
  cursor: ReadingCursor;
  answers: ReadingAnswer[];
  /** The BCP-47 tag it speaks in. */
  lang: string;
  language: Language;
  /** Whether it was started to go on into later answers (auto read-aloud). */
  follow: boolean;
  /** An answer to start once the one being read ends: a new answer arrived
   * while a single message was read from its menu. */
  then: string | null;
  /** The keys of every turn last fed, to tell a new answer from history. */
  heard: Set<string> | null;
  /** A one-off reading is always full: the reader asked for that message. */
  oneOff: boolean;
}

const MESSAGE = "\u0000message";

const readings = new Map<string, Reading>();
/** The tab whose Focus feeds a reading now: Read aloud on one of its answers
 * moves its cursor. */
let activeTab: string | null = null;
/** The reading a command goes to when nothing is being said. */
let lastReading: Reading | null = null;
const dictReady = new Set<Language>(["en"]);

function optionsFor(reading: Pick<Reading, "language" | "oneOff">): ReadingOptions {
  const { language } = reading;
  const brief = !reading.oneOff && (driving || readBrief());
  return {
    labels: readingLabels((key, params) => translate(language, key, params)),
    mode: brief ? "brief" : "full",
    limits: driving && !reading.oneOff ? DRIVING_LIMITS : KITCHEN_LIMITS,
    maxChunk: MAX_CHUNK,
  };
}

function refreshOptions(only?: Language) {
  for (const reading of readings.values()) {
    if (!only || reading.language === only) reading.cursor.setOptions(optionsFor(reading));
  }
}

/** The labels are said in the speech language. Until its dictionary has
 * loaded, the English ones stand in; then the readings re-render. */
function ensureDict(language: Language) {
  if (dictReady.has(language)) return;
  dictReady.add(language);
  void loadDict(language).then((ok) => {
    if (ok) refreshOptions(language);
    else dictReady.delete(language);
  });
}

function setLang(reading: Reading, lang: string) {
  if (reading.lang === lang) return;
  reading.lang = lang;
  const language = speechLanguage(lang);
  if (language === reading.language) return;
  reading.language = language;
  ensureDict(language);
  reading.cursor.setOptions(optionsFor(reading));
}

function makeReading(key: string, lang: string, oneOff: boolean): Reading {
  const language = speechLanguage(lang);
  ensureDict(language);
  const base = { language, oneOff };
  return {
    key, cursor: createReadingCursor(optionsFor(base)), answers: [], lang, language, follow: false, then: null,
    heard: null, oneOff,
  };
}

function readingFor(tab: string, lang: string): Reading {
  let reading = readings.get(tab);
  if (!reading) {
    reading = makeReading(tab, lang, false);
    readings.set(tab, reading);
  }
  setLang(reading, lang);
  return reading;
}

// ---------------------------------------------------------------------------
// The one voice

type Item =
  | { kind: "plain"; id: string; chunks: string[]; lang: string }
  | { kind: "reading"; reading: Reading };

/** What is being said, by the id its caller gave it (an answer's turn key
 * for a reading). One voice for the whole app: a second message waits for
 * the first rather than talking over it. */
let speakingId: string | null = null;
let queue: Item[] = [];
/** Bumped by every stop and every move, so an utterance that ends afterwards
 * starts nothing. */
let generation = 0;
/** Paused (a play/pause button): the queue and the position stay, nothing
 * is said until `resumeReading`. */
let paused = false;
const listeners = new Set<() => void>();

type SectionEndHook = (at: { tab: string; position: ReadingPosition; sectionEnd: boolean }) => Promise<void> | void;
let sectionEnd: { hook: SectionEndHook; everyChunk: boolean } | null = null;

function notify() {
  listeners.forEach((listener) => listener());
}

function announce(id: string | null) {
  if (speakingId === id) {
    // The chunk moved on within the same answer: readers of `readingNow`
    // (the lock-screen card) want that too; the snapshot of
    // `currentSpeechId` is unchanged, so React does not re-render for it.
    if (id !== null) notify();
    return;
  }
  speakingId = id;
  notify();
}

function itemId(item: Item): string | null {
  return item.kind === "plain" ? item.id : item.reading.cursor.position()?.id ?? null;
}

function itemText(item: Item): string | undefined {
  return item.kind === "plain" ? item.chunks[0] : item.reading.cursor.current()?.text;
}

function isHead(reading: Reading): boolean {
  const head = queue[0];
  return head?.kind === "reading" && head.reading === reading;
}

function isQueued(reading: Reading): boolean {
  return queue.some((item) => item.kind === "reading" && item.reading === reading);
}

function cancelVoice() {
  generation += 1;
  if (speechOutputSupported()) window.speechSynthesis.cancel();
}

function sayNext() {
  if (paused) return;
  const head = queue[0];
  if (!head) {
    announce(null);
    return;
  }
  const text = itemText(head);
  if (text === undefined) {
    queue = queue.slice(1);
    sayNext();
    return;
  }
  announce(itemId(head));
  const run = generation;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = head.kind === "plain" ? head.lang : head.reading.lang;
  utterance.rate = readingRate();
  utterance.onend = () => {
    if (run === generation) void said(head);
  };
  // A refused or interrupted piece must not leave the button saying "stop"
  // over silence; the rest of that message goes with it.
  utterance.onerror = () => {
    if (run !== generation) return;
    queue = queue.slice(1);
    sayNext();
  };
  window.speechSynthesis.speak(utterance);
}

/** The next chunk, or the answer queued behind a single message (`then`).
 *
 * A skip past the end ("next answer" in the last answer, "next" in its last
 * section) parks the cursor at that answer's end and ends the reading. Only
 * an explicit move (repeat, back) goes on from a parked cursor; new answers
 * begin with `start`, so an answer skipped while it still streamed is never
 * read on when it grows. */
function advanceReading(reading: Reading): ReadingChunk | null {
  const { cursor } = reading;
  let chunk = cursor.advance();
  if (!chunk && reading.then) {
    const id = reading.then;
    reading.then = null;
    reading.follow = true;
    chunk = cursor.start(id, { follow: true });
  }
  return chunk;
}

/** The head's current chunk was said: the listening gap, if one is hooked
 * in, then the next chunk. */
async function said(head: Item) {
  if (queue[0] !== head) return;
  if (head.kind === "plain") {
    head.chunks.shift();
    sayNext();
    return;
  }
  const { reading } = head;
  const position = reading.cursor.position();
  const atEnd = reading.cursor.atSectionEnd();
  if (sectionEnd && position && (atEnd || sectionEnd.everyChunk)) {
    const run = generation;
    try {
      await sectionEnd.hook({ tab: reading.key, position, sectionEnd: atEnd });
    } catch {
      // A gap that failed is a gap that ended: reading goes on.
    }
    // A command heard in the gap moved the cursor itself.
    if (run !== generation || queue[0] !== head) return;
  }
  if (!advanceReading(reading)) queue = queue.slice(1);
  sayNext();
}

function enqueue(item: Item) {
  queue = [...queue, item];
  if (queue.length === 1) sayNext();
}

/** Says `text` after whatever is already queued; `replace` says it instead. */
export function speak(id: string, text: string, lang: string, replace = false): void {
  if (!speechOutputSupported()) return;
  const chunks = speechChunks(text, MAX_CHUNK);
  if (replace) stopSpeaking();
  if (chunks.length === 0) return;
  enqueue({ kind: "plain", id, chunks, lang });
}

/** Stops the voice and drops what was queued. Every tab's read position
 * stays, so "repeat" or "next" goes on from where it stopped. */
export function stopSpeaking(): void {
  cancelVoice();
  queue = [];
  paused = false;
  for (const reading of readings.values()) reading.then = null;
  announce(null);
}

/** Called from a tap: a browser that only lets a page speak after a gesture
 * (Safari) counts this silent utterance as the page having spoken. */
export function unlockSpeech(): void {
  if (!speechOutputSupported() || queue.length > 0) return;
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
}

export function currentSpeechId(): string | null {
  return speakingId;
}

/** Called when what is said changes: another message, or the next chunk of
 * the same answer. */
export function subscribeSpeech(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Feeding a tab's answers

/**
 * Hands the tab's session to its cursor: every turn's key in order (to tell
 * what is new) and its answers (the agent's own messages, never a tool call).
 * Returns the answers that arrived since the last feed, by id, or `null` on a
 * tab's first feed — what that brought is history.
 */
export function feedReading(tab: string, turnKeys: readonly string[], answers: readonly ReadingAnswer[], lang: string): string[] | null {
  const reading = readingFor(tab, lang);
  activeTab = tab;
  reading.answers = [...answers];
  reading.cursor.setAnswers(reading.answers);
  const seen = reading.heard;
  reading.heard = new Set(turnKeys);
  if (!seen) return null;
  let known = -1;
  turnKeys.forEach((key, index) => { if (seen.has(key)) known = index; });
  const after = new Set(turnKeys.slice(known + 1));
  return answers.filter((answer) => after.has(answer.id)).map((answer) => answer.id);
}

/** The tab's Focus went away: Read aloud on a message no longer moves its
 * cursor. The position stays. */
export function leaveReading(tab: string): void {
  if (activeTab === tab) activeTab = null;
}

function begin(reading: Reading, id: string, follow: boolean): boolean {
  reading.follow = follow;
  reading.then = null;
  const chunk = reading.cursor.start(id, { follow });
  if (!chunk) return false;
  lastReading = reading;
  enqueue({ kind: "reading", reading });
  return true;
}

/**
 * Reads the tab's answers from `id` on, into the ones that arrive later
 * (auto read-aloud). While the tab is already being read on, the new answer
 * is reached when the cursor gets there; while one message is read from its
 * menu, this one starts after it. False when there is nothing to say.
 */
export function readAnswers(tab: string, id: string): boolean {
  const reading = readings.get(tab);
  if (!reading || !speechOutputSupported()) return false;
  if (isQueued(reading)) {
    if (!reading.follow) reading.then ??= id;
    return true;
  }
  return begin(reading, id, true);
}

/** Holds a tab's auto read-aloud until its turn is over (hands-free: the
 * answer is read at the end of the turn, not entry by entry). */
const heldTabs = new Set<string>();

export function holdReadingForTurn(tab: string, hold: boolean): void {
  if (hold) heldTabs.add(tab);
  else heldTabs.delete(tab);
}

export function readingHeld(tab: string): boolean {
  return heldTabs.has(tab);
}

/**
 * The turn is over: reads the answers that came after `sinceKey` (the newest
 * answer when the turn began; `null` when there was none) — the last
 * `MAX_SPOKEN_AT_ONCE` of them, from the first of those on. True when
 * something is being said.
 */
export function readTurn(tab: string, sinceKey: string | null): boolean {
  const reading = readings.get(tab);
  if (!reading) return false;
  const since = sinceKey === null ? -1 : reading.answers.findIndex((answer) => answer.id === sinceKey);
  // The answer the turn began after is gone (the session was cleared or
  // swapped): only the newest answer can be this turn's.
  const fresh = since < 0 && sinceKey !== null ? reading.answers.slice(-1) : reading.answers.slice(since + 1);
  const read = fresh.slice(-MAX_SPOKEN_AT_ONCE);
  if (read.length === 0) return false;
  return readAnswers(tab, read[0].id);
}

/**
 * Read aloud on one message (its menu): instead of whatever is being said.
 * One of the active tab's answers is read on its cursor, so the spoken moves
 * and the position go on from it; anything else (a prompt, a subagent's
 * message, a shell's screen) is read as a message of its own.
 */
export function readMessage(id: string, text: string, lang: string): void {
  if (!speechOutputSupported()) return;
  stopSpeaking();
  const tab = activeTab === null ? undefined : readings.get(activeTab);
  if (tab && tab.answers.some((answer) => answer.id === id)) {
    setLang(tab, lang);
    begin(tab, id, false);
    return;
  }
  const reading = makeReading(MESSAGE, lang, true);
  reading.answers = [{ id, text, agent: "" }];
  reading.cursor.setAnswers(reading.answers);
  readings.set(MESSAGE, reading);
  begin(reading, id, false);
}

// ---------------------------------------------------------------------------
// The spoken moves

function target(tab?: string): Reading | null {
  const head = queue[0];
  if (head?.kind === "reading" && (tab === undefined || head.reading.key === tab)) return head.reading;
  if (tab !== undefined) return readings.get(tab) ?? null;
  return lastReading;
}

/** Plays `chunk` of `reading` now, cutting off whatever was being said (the
 * cut-off item is dropped; the queue behind it stays). `null` ends that
 * reading. */
function play(reading: Reading, chunk: ReadingChunk | null): boolean {
  const head = isHead(reading);
  if (!chunk && !head) return false;
  cancelVoice();
  paused = false;
  const rest = queue.slice(1).filter((item) => !(item.kind === "reading" && item.reading === reading));
  queue = chunk ? [{ kind: "reading", reading }, ...rest] : rest;
  if (chunk) lastReading = reading;
  sayNext();
  return chunk !== null;
}

type Move = "next" | "nextAnswer" | "back" | "repeat" | "summary" | "readAll" | "readCode";

function move(kind: Move, tab?: string): boolean {
  const reading = target(tab);
  if (!reading || !speechOutputSupported()) return false;
  return play(reading, reading.cursor[kind]());
}

/** "next": the next section, else the next answer. False at the end. */
export const readNext = (tab?: string) => move("next", tab);
/** "next answer" / "skip this answer"; past the last answer it ends the
 * reading (see `advanceReading`). */
export const readNextAnswer = (tab?: string) => move("nextAnswer", tab);
/** "back": the previous chunk; again before reading moved on, the section
 * before. */
export const readBack = (tab?: string) => move("back", tab);
/** "repeat": the current chunk again (the last one after the end). */
export const readRepeat = (tab?: string) => move("repeat", tab);
/** "summary": this answer's own summary section, else its outline. */
export const readSummary = (tab?: string) => move("summary", tab);
/** "read all": this answer in full, from the section the cursor is in. */
export const readAll = (tab?: string) => move("readAll", tab);
/** "read the code": the code block at or before the cursor. */
export const readCode = (tab?: string) => move("readCode", tab);

/** "where": says "answer 2 of 3, section 2 of 4", then goes on with the
 * chunk it cut off. False before anything was read. */
export function sayWhere(tab?: string): boolean {
  const reading = target(tab);
  const text = reading?.cursor.where();
  if (!reading || !text || !speechOutputSupported()) return false;
  cancelVoice();
  paused = false;
  queue = [{ kind: "plain", id: `where:${reading.key}`, chunks: speechChunks(text, MAX_CHUNK), lang: reading.lang }, ...queue];
  sayNext();
  return true;
}

/** Sets the speaking rate (one of `READING_RATES`), persisted. What is
 * being said starts again at the new rate. */
export function setReadingRate(next: number): void {
  if (!READING_RATES.some((step) => step === next)) return;
  const changed = readingRate() !== next;
  rate = next;
  writeChoice("voiceRate", String(next));
  if (changed && queue.length > 0 && !paused) {
    cancelVoice();
    sayNext();
  }
}

/** "faster" (+1) / "slower" (-1): one rate step, persisted. Returns the
 * rate. */
export function stepRate(delta: 1 | -1): number {
  let index = READING_RATES.findIndex((step) => step === readingRate());
  if (index < 0) index = READING_RATES.indexOf(1);
  const next = READING_RATES[Math.max(0, Math.min(READING_RATES.length - 1, index + delta))];
  setReadingRate(next);
  return next;
}

/** Brief ⇄ full for every tab's reading, persisted. */
export function setReadBrief(on: boolean): void {
  writeFlag("voiceBrief", on);
  refreshOptions();
}

/** Driving mode's reading: brief, long answers only announced. */
export function setReadingDriving(on: boolean): void {
  if (driving === on) return;
  driving = on;
  refreshOptions();
}

/** Play/pause: the voice stops, the position and the queue stay. */
export function pauseReading(): boolean {
  if (paused || queue.length === 0) return false;
  cancelVoice();
  paused = true;
  announce(null);
  return true;
}

/** Goes on with the chunk the pause cut off. */
export function resumeReading(): boolean {
  if (!paused) return false;
  paused = false;
  sayNext();
  return queue.length > 0;
}

export function readingPaused(): boolean {
  return paused;
}

/**
 * Runs a reading command as `matchReading` heard it. Rate steps with nothing
 * being said repeat the current chunk, so the new pace is heard. True when
 * the command did something.
 */
export function runReadingCommand(id: VoiceReadId, tab?: string): boolean {
  switch (id) {
    case "next": return readNext(tab);
    case "nextAnswer": return readNextAnswer(tab);
    case "back": return readBack(tab);
    case "repeat": return readRepeat(tab);
    case "summary": return readSummary(tab);
    case "readAll": return readAll(tab);
    case "readCode": return readCode(tab);
    case "where": return sayWhere(tab);
    case "faster":
    case "slower": {
      const speaking = queue.length > 0;
      stepRate(id === "faster" ? 1 : -1);
      return speaking || readRepeat(tab);
    }
    case "stop": {
      const speaking = queue.length > 0;
      stopSpeaking();
      return speaking;
    }
  }
}

/** Whether `tab` (or the last reading) has a read position a command can
 * move from. */
export function hasReadPosition(tab?: string): boolean {
  return target(tab)?.cursor.position() != null;
}

/** What is being read: the tab, who answered, and where — for the lock-screen
 * card ("Claude · Alpha · 2/4"). `null` while nothing of a tab is read. */
export function readingNow(): { tab: string; agent: string; position: ReadingPosition } | null {
  const head = queue[0];
  if (paused || head?.kind !== "reading" || head.reading.oneOff) return null;
  const position = head.reading.cursor.position();
  if (!position) return null;
  const agent = head.reading.answers.find((answer) => answer.id === position.id)?.agent ?? "";
  return { tab: head.reading.key, agent, position };
}

/**
 * The listening gap: `hook` runs after each section's last chunk (each
 * chunk, with `everyChunk`), and reading goes on once it settles. A move it
 * makes (a command heard in the gap) replaces that. One hook at a time;
 * returns its removal.
 */
export function onSectionEnd(hook: SectionEndHook, opts: { everyChunk?: boolean } = {}): () => void {
  const entry = { hook, everyChunk: opts.everyChunk ?? false };
  sectionEnd = entry;
  return () => {
    if (sectionEnd === entry) sectionEnd = null;
  };
}

/** Forgets every read position (tests; nothing in the app needs it: the
 * positions live only as long as the page). */
export function forgetReadings(): void {
  stopSpeaking();
  readings.clear();
  heldTabs.clear();
  activeTab = null;
  lastReading = null;
  rate = null;
  driving = false;
  sectionEnd = null;
}
