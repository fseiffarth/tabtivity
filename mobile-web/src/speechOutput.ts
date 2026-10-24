// Reading the Focus chat aloud: the browser's own speech synthesis, so an
// answer's text never leaves the phone to be spoken.

import { speechChunks } from "../../shared/voice";

/** Chrome on Android cuts an utterance off after about fifteen seconds, and an
 * utterance it cut never ends — the queue behind it hangs. Sentence-sized
 * pieces stay well under that. */
const MAX_CHUNK = 220;

export function speechOutputSupported(scope: Window = window): boolean {
  return "speechSynthesis" in scope && "SpeechSynthesisUtterance" in scope;
}

interface QueuedSpeech { id: string; chunks: string[]; lang: string }

/** What is being said, by the id its caller gave it. One voice for the whole
 * app: a second message waits for the first rather than talking over it. */
let speakingId: string | null = null;
let queue: QueuedSpeech[] = [];
/** Bumped by every stop, so an utterance that ends afterwards starts nothing. */
let generation = 0;
const listeners = new Set<() => void>();

function announce(id: string | null) {
  if (speakingId === id) return;
  speakingId = id;
  listeners.forEach((listener) => listener());
}

function sayNext() {
  const current = queue[0];
  if (!current) {
    announce(null);
    return;
  }
  const chunk = current.chunks.shift();
  if (chunk === undefined) {
    queue = queue.slice(1);
    sayNext();
    return;
  }
  announce(current.id);
  const run = generation;
  const utterance = new SpeechSynthesisUtterance(chunk);
  utterance.lang = current.lang;
  const next = () => {
    if (run === generation) sayNext();
  };
  utterance.onend = next;
  // A refused or interrupted piece must not leave the button saying "stop"
  // over silence; the rest of that message goes with it.
  utterance.onerror = () => {
    if (run !== generation) return;
    queue = queue.slice(1);
    sayNext();
  };
  window.speechSynthesis.speak(utterance);
}

/** Says `text` after whatever is already queued; `replace` says it instead. */
export function speak(id: string, text: string, lang: string, replace = false): void {
  if (!speechOutputSupported()) return;
  const chunks = speechChunks(text, MAX_CHUNK);
  if (replace) stopSpeaking();
  if (chunks.length === 0) return;
  queue = [...queue, { id, chunks, lang }];
  if (queue.length === 1) sayNext();
}

export function stopSpeaking(): void {
  generation += 1;
  queue = [];
  if (speechOutputSupported()) window.speechSynthesis.cancel();
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

export function subscribeSpeech(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
