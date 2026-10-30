// The phone voice probe page (docs/phone_voice_plan.md, step 0). A developer
// tool, not a feature: `main.tsx` renders it instead of the app only with
// `?voiceProbe` in the URL and the cached "show untested tags" flag on. It
// calls no API and needs no pairing. Each check starts from a tap, logs what
// the browser did and when, and "Copy results" gives a compact text to paste
// back. Its strings are plain English on purpose (the plan's recorded
// exception to the i18n rule): the page is deleted in agent step S11.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BRAND } from "../../src/lib/brand";
import { playChime } from "../../src/lib/voice/chime";
import { BUNDLE_VERSION } from "./buildInfo";
import { speechTag } from "./speechLang";
import { currentSpeechId, speak, speechOutputSupported, stopSpeaking, subscribeSpeech, unlockSpeech } from "./speechOutput";
import { prepareOnDeviceSpeech, speechRecognitionConstructor, type MobileSpeechRecognition } from "./voiceInput";
import { holdScreenAwake, openMicMeter, type MicMeter } from "./voiceSession";

type ProbeId = "env" | "p1a" | "p1b" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7";

const TITLES: Record<ProbeId, string> = {
  env: "Setup",
  p1a: "1a · Restart after speaking, no tap",
  p1b: "1b · Keep listening through speech",
  p2: "2 · Does it hear itself",
  p3: "3 · Silent loop and media buttons",
  p4: "4 · Car: which mic, how a turn sounds",
  p5: "5 · Fan: false triggers",
  p6: "6 · Screen off",
  p7: "7 · Command word",
};
const ORDER: ProbeId[] = ["env", "p1a", "p1b", "p2", "p3", "p4", "p5", "p6", "p7"];

/** Lines kept on screen per probe, and how many of the last ones the copy carries. */
const SCREEN_LINES = 400;
const COPY_LINES = 25;
const SHOWN_LINES = 14;

interface RecConfig { lang: string; local: boolean }

interface ProbeRecord {
  runs: number;
  notes: Map<string, string>;
  lines: string[];
  dropped: number;
}

interface Cell { token: number; split: number; alt: number; miss: number; heard: Map<string, number> }

type ProbeRecognizer = MobileSpeechRecognition & {
  onaudiostart?: (() => void) | null;
  onaudioend?: (() => void) | null;
  onsoundstart?: (() => void) | null;
  onsoundend?: (() => void) | null;
  onnomatch?: (() => void) | null;
};

type AudioWindow = Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function stats(values: number[]): string {
  if (values.length === 0) return "n=0";
  const sorted = [...values].sort((a, b) => a - b);
  return `n=${sorted.length} min=${sorted[0]} med=${sorted[Math.floor(sorted.length / 2)]} max=${sorted[sorted.length - 1]} ms`;
}

function counts(record: Record<string, number>): string {
  const entries = Object.entries(record);
  return entries.length === 0 ? "none" : entries.map(([key, value]) => `${key}×${value}`).join(" ");
}

/** Lowercase words without accents or punctuation. */
function words(text: string): string[] {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
}

/** How a recognizer wrote `candidate`: as itself, split into pieces that join
 * to it ("tab tivity"), only in a lower-ranked alternative, or not at all. */
function classify(candidate: string, alternatives: string[]): "token" | "split" | "alt" | null {
  const want = words(candidate);
  const joined = want.join("");
  if (!joined) return null;
  const kind = (text: string): "token" | "split" | null => {
    const heard = words(text);
    for (let i = 0; i + want.length <= heard.length; i++) {
      if (want.every((word, k) => heard[i + k] === word)) return "token";
    }
    for (let i = 0; i < heard.length; i++) {
      for (let span = 2; span <= 3 && i + span <= heard.length; span++) {
        if (heard.slice(i, i + span).join("") === joined) return "split";
      }
    }
    return null;
  };
  const first = kind(alternatives[0] ?? "");
  if (first) return first;
  return alternatives.slice(1).some((text) => kind(text) !== null) ? "alt" : null;
}

/** A WAV of `seconds` of silence, 8-bit mono at 8 kHz: what `public/silence.wav`
 * holds, built here for the `data:` and `blob:` variants. */
function silentWav(seconds: number): Uint8Array<ArrayBuffer> {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(0x80, 44);
  return bytes;
}

// ---------------------------------------------------------------------------
// Store and runs
// ---------------------------------------------------------------------------

type Controls = Record<string, () => void>;

class Run {
  stopped = false;
  controls: Controls = {};
  readonly t0 = performance.now();
  private stops = new Set<() => void>();

  constructor(readonly id: ProbeId, readonly config: RecConfig, private store: ProbeStore) {}

  ms(): number {
    return Math.round(performance.now() - this.t0);
  }
  log(text: string): void {
    this.store.log(this.id, this.ms(), text);
  }
  note(key: string, value: string | number): void {
    this.store.note(this.id, key, String(value));
  }
  /** Runs at stop; the returned function cancels it. */
  onStop(fn: () => void): () => void {
    this.stops.add(fn);
    return () => this.stops.delete(fn);
  }
  timeout(fn: () => void, ms: number): void {
    const handle = window.setTimeout(() => { cancel(); if (!this.stopped) fn(); }, ms);
    const cancel = this.onStop(() => window.clearTimeout(handle));
  }
  interval(fn: () => void, ms: number): void {
    const handle = window.setInterval(() => { if (!this.stopped) fn(); }, ms);
    this.onStop(() => window.clearInterval(handle));
  }
  delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = window.setTimeout(() => { cancel(); resolve(); }, ms);
      const cancel = this.onStop(() => { window.clearTimeout(handle); resolve(); });
    });
  }
  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.log(`stopped: ${reason}`);
    for (const fn of [...this.stops].reverse()) {
      try { fn(); } catch (error) { this.log(`cleanup threw: ${describe(error)}`); }
    }
    this.stops.clear();
    this.controls = {};
    this.store.ended(this);
  }
}

class ProbeStore {
  records = new Map<ProbeId, ProbeRecord>();
  current: Run | null = null;
  cells = new Map<string, Cell>();
  private listeners = new Set<() => void>();
  private frame = 0;

  record(id: ProbeId): ProbeRecord {
    let record = this.records.get(id);
    if (!record) {
      record = { runs: 0, notes: new Map(), lines: [], dropped: 0 };
      this.records.set(id, record);
    }
    return record;
  }
  log(id: ProbeId, ms: number, text: string): void {
    const record = this.record(id);
    record.lines.push(`+${(ms / 1000).toFixed(2)}s ${text}`);
    if (record.lines.length > SCREEN_LINES) {
      record.lines.shift();
      record.dropped += 1;
    }
    this.changed();
  }
  note(id: ProbeId, key: string, value: string): void {
    this.record(id).notes.set(key, value);
    this.changed();
  }
  start(id: ProbeId, config: RecConfig, body: (run: Run) => void | Promise<void>): void {
    this.current?.stop("another probe started");
    unlockSpeech();
    const run = new Run(id, config, this);
    this.current = run;
    this.record(id).runs += 1;
    run.log(`start · lang=${config.lang} on-device=${config.local ? "on" : "off"}`);
    Promise.resolve().then(() => body(run)).catch((error: unknown) => {
      run.log(`probe threw: ${describe(error)}`);
      run.stop("error");
    });
    this.changed();
  }
  ended(run: Run): void {
    if (this.current === run) this.current = null;
    this.changed();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.listeners.forEach((listener) => listener());
    });
  }
}

// ---------------------------------------------------------------------------
// Speech in and out
// ---------------------------------------------------------------------------

let sayCount = 0;

/** Says `text` through the app's own speech output and resolves when it is
 * over (or the run stops), with the run times it started and ended. */
function say(run: Run, text: string): Promise<{ startMs: number; endMs: number }> {
  return new Promise((resolve) => {
    const startMs = run.ms();
    if (!speechOutputSupported()) {
      run.log("tts: no speechSynthesis");
      resolve({ startMs, endMs: startMs });
      return;
    }
    sayCount += 1;
    const id = `voice-probe-${sayCount}`;
    run.log(`tts:say "${text}"`);
    speak(id, text, run.config.lang, true);
    if (currentSpeechId() !== id) {
      run.log("tts: did not start");
      resolve({ startMs, endMs: startMs });
      return;
    }
    let done = false;
    let unsubscribe = () => {};
    let cancelStop = () => {};
    let limit = 0;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      unsubscribe();
      cancelStop();
      window.clearTimeout(limit);
      const endMs = run.ms();
      run.log(`tts:end ${why} (${endMs - startMs} ms)`);
      resolve({ startMs, endMs });
    };
    unsubscribe = subscribeSpeech(() => { if (currentSpeechId() !== id) finish("done"); });
    limit = window.setTimeout(() => finish("timeout 30 s"), 30_000);
    cancelStop = run.onStop(() => { stopSpeaking(); finish("stopped"); });
  });
}

interface ListenOptions { continuous: boolean; interim: boolean; alternatives: number }

interface ListenHandlers {
  onStart?(): void;
  onAudioStart?(): void;
  onSpeechStart?(): void;
  onSpeechEnd?(): void;
  onFinal?(alternatives: string[]): void;
  onInterim?(text: string): void;
  onError?(error: string): void;
  onEnd?(): void;
}

interface Listener {
  /** False when `start()` threw (logged). */
  start(track?: MediaStreamTrack): boolean;
  stop(): void;
  running(): boolean;
}

/** One recognizer for the run, every event it fires logged with its time. */
function makeListener(run: Run, options: ListenOptions, handlers: ListenHandlers): Listener | null {
  const Recognition = speechRecognitionConstructor();
  if (!Recognition) {
    run.log("no SpeechRecognition in this browser");
    run.stop("unsupported");
    return null;
  }
  let rec: ProbeRecognizer;
  try {
    rec = new Recognition() as ProbeRecognizer;
  } catch (error) {
    run.log(`new SpeechRecognition() threw: ${describe(error)}`);
    run.stop("unsupported");
    return null;
  }
  rec.continuous = options.continuous;
  rec.interimResults = options.interim;
  rec.lang = run.config.lang;
  rec.maxAlternatives = options.alternatives;
  if (run.config.local) rec.processLocally = true;
  let live = false;
  const logged = (name: string, then?: () => void) => () => { run.log(`rec:${name}`); then?.(); };
  rec.onstart = () => { live = true; run.log("rec:start"); handlers.onStart?.(); };
  rec.onaudiostart = logged("audiostart", handlers.onAudioStart);
  rec.onsoundstart = logged("soundstart");
  rec.onspeechstart = logged("speechstart", handlers.onSpeechStart);
  rec.onspeechend = logged("speechend", handlers.onSpeechEnd);
  rec.onsoundend = logged("soundend");
  rec.onaudioend = logged("audioend");
  rec.onnomatch = logged("nomatch");
  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result) continue;
      if (result.isFinal) {
        const alternatives: string[] = [];
        for (let a = 0; a < result.length; a++) alternatives.push((result[a]?.transcript ?? "").trim());
        const rest = alternatives.slice(1).map((text) => `"${text}"`).join(" ");
        run.log(`rec:final "${alternatives[0] ?? ""}"${rest ? ` alts ${rest}` : ""}`);
        handlers.onFinal?.(alternatives);
      } else {
        handlers.onInterim?.(result[0]?.transcript ?? "");
      }
    }
  };
  rec.onerror = (event) => { run.log(`rec:error ${event.error}`); handlers.onError?.(event.error); };
  rec.onend = () => { live = false; run.log("rec:end"); handlers.onEnd?.(); };
  run.onStop(() => {
    rec.onstart = rec.onresult = rec.onerror = rec.onend = null;
    rec.onaudiostart = rec.onaudioend = rec.onsoundstart = rec.onsoundend = rec.onnomatch = null;
    rec.onspeechstart = rec.onspeechend = null;
    try { rec.abort(); } catch { /* already over */ }
  });
  return {
    start(track) {
      if (run.stopped) return false;
      try {
        if (track) rec.start(track);
        else rec.start();
        return true;
      } catch (error) {
        run.log(`rec.start() threw: ${describe(error)}`);
        return false;
      }
    },
    stop() {
      try { rec.stop(); } catch { /* not running */ }
    },
    running: () => live,
  };
}

const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"]);

/** Ends that come this soon after a start, this many times in a row, stop a
 * loop rather than spin. */
const QUICK_END_MS = 300;
const MAX_QUICK_ENDS = 5;

function quickEndGuard(run: Run) {
  let startedAt = 0;
  let quick = 0;
  return {
    started() { startedAt = run.ms(); },
    /** True when the loop must stop. */
    ended(): boolean {
      quick = run.ms() - startedAt < QUICK_END_MS ? quick + 1 : 0;
      if (quick < MAX_QUICK_ENDS) return false;
      run.note("verdict", `recognizer ends at once (${MAX_QUICK_ENDS}× under ${QUICK_END_MS} ms)`);
      run.stop("quick-end loop");
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

/** 1a: the recognizer started again by code after each spoken reply, no tap. */
async function probeRestartAfterTts(run: Run, minutes: number): Promise<void> {
  const holdRelease = holdScreenAwake(window);
  run.onStop(holdRelease);
  const afterTts: number[] = [];
  const audioAfterTts: number[] = [];
  const idle: number[] = [];
  const errors: Record<string, number> = {};
  let cycles = 0;
  let heard: string | null = null;
  let pending: { kind: "tts" | "idle"; at: number } | null = null;
  const until = run.ms() + minutes * 60_000;
  const guard = quickEndGuard(run);
  const update = () => {
    run.note("cycles", cycles);
    run.note("tts end → rec start", stats(afterTts));
    run.note("tts end → audiostart", stats(audioAfterTts));
    run.note("rec end → rec start (nothing heard)", stats(idle));
    run.note("errors", counts(errors));
  };
  const listener = makeListener(run, { continuous: false, interim: false, alternatives: 1 }, {
    onStart() {
      guard.started();
      if (!pending) return;
      const gap = run.ms() - pending.at;
      (pending.kind === "tts" ? afterTts : idle).push(gap);
      run.log(`gap ${pending.kind === "tts" ? "tts end" : "rec end"} → start ${gap} ms`);
    },
    onAudioStart() {
      if (pending?.kind === "tts") audioAfterTts.push(run.ms() - pending.at);
      pending = null;
    },
    onFinal(alternatives) { heard = alternatives[0] || null; },
    onError(error) {
      if (error === "no-speech" || error === "aborted") return;
      errors[error] = (errors[error] ?? 0) + 1;
      update();
      if (FATAL.has(error)) {
        run.note("verdict", `restart refused (${error}) after ${cycles} cycles`);
        run.stop(`fatal ${error}`);
      }
    },
    onEnd() {
      cycles += 1;
      update();
      if (run.stopped || guard.ended()) return;
      if (run.ms() > until) {
        run.note("verdict", `kept restarting for ${minutes} min, ${cycles} cycles`);
        run.stop("duration reached");
        return;
      }
      void next();
    },
  });
  if (!listener) return;
  const begin = (kind: "tts" | "idle", at: number) => {
    pending = { kind, at };
    if (!listener.start()) {
      run.note("verdict", `start() threw after ${cycles} cycles`);
      run.stop("start threw");
    }
  };
  const next = async () => {
    const said = heard;
    heard = null;
    if (!said) {
      begin("idle", run.ms());
      return;
    }
    const spoken = await say(run, `Heard: ${said}`);
    if (!run.stopped) begin("tts", spoken.endMs);
  };
  const intro = await say(run, "Probe one. Talk now and then, and I repeat what I heard.");
  if (!run.stopped) begin("tts", intro.endMs);
}

const THROUGH_SENTENCE = "This is the phone talking while the recognizer listens. Results now are dropped.";
/** A result this long after speech ended still counts as heard during it. */
const DROP_TAIL_MS = 700;

/** 1b: one continuous recognizer kept running while the phone speaks. */
function probeThroughTts(run: Run, minutes: number): void {
  const holdRelease = holdScreenAwake(window);
  run.onStop(holdRelease);
  const gaps: number[] = [];
  const sessions: number[] = [];
  const errors: Record<string, number> = {};
  let ends = 0;
  let endsInTts = 0;
  let finalsInTts = 0;
  let interimsInTts = 0;
  let finalsOutside = 0;
  let sessionStart = 0;
  let endAt: number | null = null;
  let tts: { from: number; to: number | null } | null = null;
  const until = run.ms() + minutes * 60_000;
  const guard = quickEndGuard(run);
  const inTts = () => {
    const now = run.ms();
    return tts !== null && now >= tts.from && (tts.to === null || now <= tts.to + DROP_TAIL_MS);
  };
  const update = () => {
    run.note("recognizer ends", `${ends} (${endsInTts} while speaking)`);
    run.note("restart gap (end → start)", stats(gaps));
    run.note("unbroken recognizer sessions", stats(sessions));
    run.note("finals while speaking (dropped)", finalsInTts);
    run.note("interims while speaking", interimsInTts);
    run.note("finals otherwise", finalsOutside);
    run.note("errors", counts(errors));
  };
  const listener = makeListener(run, { continuous: true, interim: true, alternatives: 1 }, {
    onStart() {
      guard.started();
      sessionStart = run.ms();
      if (endAt !== null) gaps.push(sessionStart - endAt);
      update();
    },
    onFinal(alternatives) {
      if (inTts()) {
        finalsInTts += 1;
        run.log(`DROPPED (during speech): "${alternatives[0] ?? ""}"`);
      } else finalsOutside += 1;
      update();
    },
    onInterim() { if (inTts()) interimsInTts += 1; },
    onError(error) {
      if (error === "no-speech" || error === "aborted") return;
      errors[error] = (errors[error] ?? 0) + 1;
      if (FATAL.has(error)) run.stop(`fatal ${error}`);
    },
    onEnd() {
      ends += 1;
      if (inTts()) endsInTts += 1;
      endAt = run.ms();
      sessions.push(endAt - sessionStart);
      update();
      if (run.stopped || guard.ended()) return;
      if (run.ms() > until) {
        run.note("verdict", `ran ${minutes} min`);
        run.stop("duration reached");
        return;
      }
      if (!listener?.start()) run.stop("start threw");
    },
  });
  if (!listener) return;
  if (!listener.start()) { run.stop("start threw"); return; }
  const speakOnce = async () => {
    tts = { from: run.ms(), to: null };
    const spoken = await say(run, THROUGH_SENTENCE);
    tts = { from: spoken.startMs, to: spoken.endMs };
  };
  run.timeout(() => void speakOnce(), 3_000);
  run.interval(() => void speakOnce(), 15_000);
}

const ECHO_SENTENCE = "The orange bicycle waited beside seven quiet windows near the harbour.";

/** 2: the phone says a known sentence while listening; how much of it comes back. */
async function probeEcho(run: Run, mode: "plain" | "track"): Promise<void> {
  const holdRelease = holdScreenAwake(window);
  run.onStop(holdRelease);
  let meter: MicMeter | undefined;
  let speaking = false;
  let peakSpeaking = 0;
  let peakQuiet = 0;
  if (mode === "track") {
    if (!run.config.local) run.log("warning: start(track) is for the on-device recognizer; the speech service hears nothing from a track on Android");
    meter = await openMicMeter(window, (level) => {
      if (speaking) peakSpeaking = Math.max(peakSpeaking, level);
      else peakQuiet = Math.max(peakQuiet, level);
    });
    if (run.stopped) { meter?.close(); return; }
    if (!meter) {
      run.note(mode, "getUserMedia failed");
      run.stop("no microphone track");
      return;
    }
    const opened = meter;
    run.onStop(() => opened.close());
    const settings = opened.track.getSettings();
    run.log(`track "${opened.track.label}" echoCancellation=${String(settings.echoCancellation)} noiseSuppression=${String(settings.noiseSuppression)} autoGainControl=${String(settings.autoGainControl)}`);
    run.note(`${mode} track`, `echoCancellation=${String(settings.echoCancellation)}`);
  }
  let collecting = false;
  let heard = "";
  let interim = "";
  let ends = 0;
  const listener = makeListener(run, { continuous: true, interim: true, alternatives: 1 }, {
    onFinal(alternatives) { if (collecting) { heard += ` ${alternatives[0] ?? ""}`; interim = ""; } },
    onInterim(text) { if (collecting) interim = text; },
    onError(error) { if (FATAL.has(error)) run.stop(`fatal ${error}`); },
    onEnd() {
      ends += 1;
      if (!run.stopped && ends < 20 && !listener?.start(meter?.track)) run.stop("start threw");
    },
  });
  if (!listener) return;
  if (!listener.start(meter?.track)) { run.stop("start threw"); return; }
  await run.delay(2_000);
  const wanted = new Set(words(ECHO_SENTENCE));
  const ratios: string[] = [];
  for (let round = 1; round <= 3 && !run.stopped; round++) {
    heard = "";
    interim = "";
    collecting = true;
    speaking = true;
    await say(run, ECHO_SENTENCE);
    speaking = false;
    await run.delay(1_500);
    collecting = false;
    const got = words(`${heard} ${interim}`);
    const hits = new Set(got.filter((word) => wanted.has(word))).size;
    const ratio = hits / wanted.size;
    ratios.push(ratio.toFixed(2));
    run.log(`round ${round}: heard ${hits}/${wanted.size} of the sentence's words: "${`${heard} ${interim}`.trim()}"`);
  }
  if (run.stopped) return;
  const levels = meter ? ` · mic peak while speaking ${peakSpeaking.toFixed(2)}, quiet ${peakQuiet.toFixed(2)}` : "";
  run.note(mode, `share of own sentence heard per round: ${ratios.join(" ")}${levels} · recognizer ends ${ends}`);
  run.stop("done");
}

type LoopSource = "webaudio" | "file" | "data" | "blob";

const MEDIA_ACTIONS: string[] = [
  "play", "pause", "stop", "nexttrack", "previoustrack", "seekbackward", "seekforward", "seekto",
  "togglemicrophone", "hangup",
];

/** 3: a silent looping `<audio>` holding media focus; which buttons arrive. */
async function probeSilentLoop(run: Run, source: LoopSource, faint: boolean): Promise<void> {
  const holdRelease = holdScreenAwake(window);
  run.onStop(holdRelease);
  const buttons: Record<string, number> = {};
  const buttonsMicOpen: Record<string, number> = {};
  let micOpen = false;
  let speaking = false;
  const state = () => `audio ${audio.paused ? "paused" : "playing"}${speaking ? ", speaking" : ""}${micOpen ? ", mic open" : ""}`;

  const onViolation = (event: SecurityPolicyViolationEvent) => {
    run.log(`CSP BLOCKED: ${event.effectiveDirective} refused ${event.blockedURI || "(inline)"}`);
    run.note(`csp ${source}`, `BLOCKED by ${event.effectiveDirective}`);
  };
  document.addEventListener("securitypolicyviolation", onViolation);
  run.onStop(() => document.removeEventListener("securitypolicyviolation", onViolation));

  const audio = document.createElement("audio");
  audio.loop = true;
  audio.style.display = "none";
  document.body.appendChild(audio);
  for (const name of ["play", "playing", "pause", "ended", "waiting", "stalled", "emptied"]) {
    audio.addEventListener(name, () => run.log(`audio:${name} (${state()})`));
  }
  audio.addEventListener("error", () => {
    const error = audio.error;
    run.log(`audio:error code=${error?.code ?? "?"} ${error?.message ?? ""}`);
    run.note(`audio error ${source}`, `code=${error?.code ?? "?"} ${error?.message ?? ""}`);
  });
  run.onStop(() => {
    audio.pause();
    audio.srcObject = null;
    audio.removeAttribute("src");
    audio.load();
    audio.remove();
  });

  if (source === "webaudio") {
    const Context = (window as AudioWindow).AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!Context) { run.note("webaudio", "no AudioContext"); run.stop("unsupported"); return; }
    const context = new Context();
    const destination = context.createMediaStreamDestination();
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.frequency.value = 40;
    gain.gain.value = faint ? 0.002 : 0;
    tone.connect(gain).connect(destination);
    tone.start();
    audio.srcObject = destination.stream;
    run.log(`source: Web Audio MediaStreamDestination as srcObject (${faint ? "faint 40 Hz tone" : "digital silence"}), context ${context.state}`);
    run.onStop(() => { tone.stop(); void context.close().catch(() => {}); });
  } else if (source === "file") {
    try {
      const head = await fetch("/silence.wav", { method: "HEAD", cache: "no-store" });
      run.log(`HEAD /silence.wav → ${head.status} content-type=${head.headers.get("content-type") ?? "(none)"}`);
      run.note("silence.wav served as", `${head.status} ${head.headers.get("content-type") ?? "(none)"}`);
    } catch (error) {
      run.log(`HEAD /silence.wav failed: ${describe(error)}`);
    }
    audio.src = "/silence.wav";
    run.log("source: 'self' file /silence.wav (6 s, looped)");
  } else if (source === "data") {
    const bytes = silentWav(6);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    audio.src = `data:audio/wav;base64,${btoa(binary)}`;
    run.log("source: data: URL (expected: blocked by the CSP's default-src 'self')");
  } else {
    const url = URL.createObjectURL(new Blob([silentWav(6)], { type: "audio/wav" }));
    run.onStop(() => URL.revokeObjectURL(url));
    audio.src = url;
    run.log("source: blob: URL (expected: blocked by the CSP's default-src 'self')");
  }
  if (run.stopped) return;

  try {
    await audio.play();
    run.log("audio.play() resolved");
    run.note(`play ${source}`, "ok");
  } catch (error) {
    run.log(`audio.play() rejected: ${describe(error)}`);
    run.note(`play ${source}`, `rejected: ${describe(error)}`);
  }

  const session = navigator.mediaSession;
  if (!session) {
    run.note("media session", "navigator.mediaSession missing");
  } else {
    try {
      session.metadata = new MediaMetadata({ title: `${BRAND.display} voice probe`, artist: "Silent loop" });
    } catch (error) {
      run.log(`MediaMetadata threw: ${describe(error)}`);
    }
    session.playbackState = "playing";
    const supported: string[] = [];
    const refused: string[] = [];
    for (const action of MEDIA_ACTIONS) {
      try {
        session.setActionHandler(action as MediaSessionAction, () => {
          buttons[action] = (buttons[action] ?? 0) + 1;
          if (micOpen) buttonsMicOpen[action] = (buttonsMicOpen[action] ?? 0) + 1;
          run.log(`BUTTON ${action} (${state()})`);
          run.note("buttons", counts(buttons));
          run.note("buttons while mic open", counts(buttonsMicOpen));
          // Keep the focus: whatever arrives, the loop goes on playing.
          if (audio.paused) void audio.play().catch(() => {});
          session.playbackState = "playing";
        });
        supported.push(action);
      } catch {
        refused.push(action);
      }
    }
    run.log(`action handlers set: ${supported.join(" ")}${refused.length ? ` · refused: ${refused.join(" ")}` : ""}`);
    run.note("action handlers", `${supported.join(" ")}${refused.length ? ` (refused ${refused.join(" ")})` : ""}`);
    run.onStop(() => {
      for (const action of supported) {
        try { session.setActionHandler(action as MediaSessionAction, null); } catch { /* gone */ }
      }
      session.playbackState = "none";
      session.metadata = null;
    });
  }
  run.note("buttons", counts(buttons));
  run.interval(() => run.log(`state: ${state()} t=${audio.currentTime.toFixed(1)} playbackState=${navigator.mediaSession?.playbackState ?? "-"}`), 10_000);

  let micListener: Listener | null = null;
  let micTurn = 0;
  run.controls = {
    "Speak 5 s": () => {
      if (speaking) return;
      speaking = true;
      void say(run, "The phone speaks now, for about five seconds, while the silent loop plays.").then(() => {
        speaking = false;
        run.log(`after speaking: ${state()}`);
        run.note("after speaking", state());
      });
    },
    "Open mic 6 s": () => {
      if (micOpen) return;
      micListener ??= makeListener(run, { continuous: true, interim: false, alternatives: 1 }, {
        onStart() { micOpen = true; run.log(`mic open (${state()})`); },
        onEnd() {
          micOpen = false;
          run.log(`mic closed (${state()})`);
          run.timeout(() => { run.log(`2 s after mic closed: ${state()}`); run.note("after mic closed", state()); }, 2_000);
        },
      });
      micTurn += 1;
      const turn = micTurn;
      if (micListener?.start()) run.timeout(() => { if (turn === micTurn) micListener?.stop(); }, 6_000);
    },
  };
  run.log("now: press the earbud or steering-wheel buttons, then try Speak 5 s and Open mic 6 s and press them again");
}

/** 4: which inputs the phone sees, and the timing of one spoken turn. */
async function probeCarTurn(run: Run): Promise<void> {
  const holdRelease = holdScreenAwake(window);
  run.onStop(holdRelease);
  const devices = navigator.mediaDevices;
  const listDevices = async (why: string) => {
    if (!devices?.enumerateDevices) { run.log("no enumerateDevices"); return; }
    try {
      const all = await devices.enumerateDevices();
      const line = (kind: MediaDeviceKind) => all.filter((device) => device.kind === kind).map((device) => `"${device.label || "(no label)"}"${device.deviceId === "default" ? " [default]" : ""}`).join(", ") || "none";
      run.log(`${why}: inputs ${line("audioinput")} · outputs ${line("audiooutput")}`);
      run.note(`devices (${why})`, `in: ${line("audioinput")} · out: ${line("audiooutput")}`);
    } catch (error) {
      run.log(`enumerateDevices failed: ${describe(error)}`);
    }
  };
  if (devices?.getUserMedia) {
    try {
      const stream = await devices.getUserMedia({ audio: true });
      const track = stream.getAudioTracks()[0];
      run.log(`getUserMedia default input: "${track?.label ?? "?"}"`);
      run.note("default getUserMedia input", track?.label ?? "?");
      for (const each of stream.getTracks()) each.stop();
    } catch (error) {
      run.log(`getUserMedia failed: ${describe(error)}`);
    }
  }
  if (run.stopped) return;
  await listDevices("at start");
  const onChange = () => void listDevices("devicechange");
  devices?.addEventListener?.("devicechange", onChange);
  run.onStop(() => devices?.removeEventListener?.("devicechange", onChange));
  run.log("Web Speech does not say which mic it uses: speak quietly towards the car's mic, then towards the phone, and compare. Tap Mark when the music mutes or a call shows.");

  const promptMs: number[] = [];
  const ttsToAudio: number[] = [];
  const speechEndToFinal: number[] = [];
  const turnMs: number[] = [];
  let turnNo = 0;
  let busy = false;
  let current: { ttsEnd: number; audio?: number; speechEnd?: number; final?: number; heard: string; ended: () => void } | null = null;
  const listener = makeListener(run, { continuous: false, interim: false, alternatives: 1 }, {
    onAudioStart() { if (current) current.audio = run.ms(); },
    onSpeechEnd() { if (current) current.speechEnd = run.ms(); },
    onFinal(alternatives) { if (current) { current.final = run.ms(); current.heard = alternatives[0] ?? ""; } },
    onEnd() { current?.ended(); },
  });
  if (!listener) return;
  run.controls = {
    "Turn": () => {
      if (busy) return;
      busy = true;
      turnNo += 1;
      const number = turnNo;
      void (async () => {
        const began = run.ms();
        const prompt = await say(run, "Say a short phrase.");
        if (run.stopped) return;
        promptMs.push(prompt.endMs - prompt.startMs);
        const turn = await new Promise<NonNullable<typeof current>>((resolve) => {
          const entry: NonNullable<typeof current> = { ttsEnd: prompt.endMs, heard: "", ended: () => resolve(entry) };
          current = entry;
          if (!listener.start()) resolve(entry);
          run.timeout(() => { if (current === entry) listener.stop(); }, 12_000);
        });
        current = null;
        if (run.stopped) return;
        if (turn.audio !== undefined) ttsToAudio.push(turn.audio - turn.ttsEnd);
        if (turn.speechEnd !== undefined && turn.final !== undefined) speechEndToFinal.push(turn.final - turn.speechEnd);
        await say(run, turn.heard ? `You said: ${turn.heard}` : "Nothing heard.");
        turnMs.push(run.ms() - began);
        run.log(`turn ${number}: tts end → audiostart ${turn.audio !== undefined ? turn.audio - turn.ttsEnd : "-"} ms, speechend → final ${turn.speechEnd !== undefined && turn.final !== undefined ? turn.final - turn.speechEnd : "-"} ms, heard "${turn.heard}"`);
        run.note("turns", turnNo);
        run.note("prompt speech", stats(promptMs));
        run.note("tts end → audiostart", stats(ttsToAudio));
        run.note("speechend → final", stats(speechEndToFinal));
        run.note("whole turn", stats(turnMs));
        busy = false;
      })();
    },
  };
  run.log("tap Turn for each spoken turn");
}

/** Candidates from the shared field: the app's name first, then the user's. */
function candidateList(extra: string): string[] {
  const all = [BRAND.display, ...extra.split(",").map((each) => each.trim()).filter(Boolean)];
  return [...new Set(all)];
}

/** 5: listen with nobody talking (the fan on); which candidates the noise writes. */
function probeFan(run: Run, minutes: number, candidates: string[]): void {
  const holdRelease = holdScreenAwake(window);
  run.onStop(holdRelease);
  const hits: Record<string, number> = {};
  let finals = 0;
  let restarts = 0;
  const until = run.ms() + minutes * 60_000;
  const guard = quickEndGuard(run);
  run.note("candidates", candidates.join(", "));
  const update = () => {
    run.note("minutes", (run.ms() / 60_000).toFixed(1));
    run.note("finals (anything written)", finals);
    run.note("candidate hits", counts(hits));
    run.note("restarts", restarts);
  };
  const listener = makeListener(run, { continuous: true, interim: false, alternatives: 3 }, {
    onStart() { guard.started(); },
    onFinal(alternatives) {
      finals += 1;
      for (const candidate of candidates) {
        const kind = classify(candidate, alternatives);
        if (kind) {
          hits[`${candidate}/${kind}`] = (hits[`${candidate}/${kind}`] ?? 0) + 1;
          run.log(`FALSE TRIGGER ${candidate} (${kind})`);
        }
      }
      update();
    },
    onError(error) { if (FATAL.has(error)) run.stop(`fatal ${error}`); },
    onEnd() {
      update();
      if (run.stopped || guard.ended()) return;
      if (run.ms() > until) { run.stop("duration reached"); return; }
      restarts += 1;
      if (!listener?.start()) run.stop("start threw");
    },
  });
  if (!listener) return;
  update();
  if (!listener.start()) run.stop("start threw");
}

/** 6: what is left of the mic or the recognizer after the screen goes off. */
async function probeScreenOff(run: Run, mode: "mic" | "recognizer"): Promise<void> {
  // No wake lock here: the screen is meant to go off.
  let hiddenAt: number | null = null;
  let samples = 0;
  let hiddenSamples = 0;
  let hiddenPeak = 0;
  let hiddenEvents: string[] = [];
  const mark = (text: string) => {
    run.log(text);
    if (hiddenAt !== null) hiddenEvents.push(text);
  };
  for (const name of ["freeze", "resume"]) {
    const handler = () => mark(`page:${name}`);
    document.addEventListener(name, handler);
    run.onStop(() => document.removeEventListener(name, handler));
  }
  for (const name of ["pagehide", "pageshow"]) {
    const handler = () => mark(`page:${name}`);
    window.addEventListener(name, handler);
    run.onStop(() => window.removeEventListener(name, handler));
  }
  let meter: MicMeter | undefined;
  let listener: Listener | null = null;
  let restarts = 0;
  const status = () => mode === "mic"
    ? `track ${meter?.track.readyState ?? "-"} muted=${String(meter?.track.muted ?? "-")}`
    : `recognizer ${listener?.running() ? "running" : "not running"}`;
  if (mode === "mic") {
    meter = await openMicMeter(window, (level) => {
      samples += 1;
      if (document.hidden) { hiddenSamples += 1; hiddenPeak = Math.max(hiddenPeak, level); }
    });
    if (run.stopped) { meter?.close(); return; }
    if (!meter) { run.note(mode, "getUserMedia failed"); run.stop("no microphone"); return; }
    const opened = meter;
    run.onStop(() => opened.close());
    for (const name of ["ended", "mute", "unmute"]) opened.track.addEventListener(name, () => mark(`track:${name}`));
    run.log(`mic open: "${opened.track.label}"`);
  } else {
    listener = makeListener(run, { continuous: true, interim: false, alternatives: 1 }, {
      onError(error) { mark(`(error ${error}${document.hidden ? " while hidden" : ""})`); },
      onEnd() {
        if (run.stopped) return;
        if (document.hidden) { mark("rec ended while hidden; not restarted"); return; }
        restarts += 1;
        if (restarts < 200 && !listener?.start()) run.stop("start threw");
      },
    });
    if (!listener || !listener.start()) { run.stop("start threw"); return; }
  }
  const onVisibility = () => {
    if (document.hidden) {
      hiddenAt = run.ms();
      hiddenSamples = 0;
      hiddenPeak = 0;
      hiddenEvents = [];
      run.log(`page hidden (${status()})`);
      return;
    }
    const away = hiddenAt === null ? 0 : run.ms() - hiddenAt;
    const events = hiddenEvents.join("; ") || "none";
    hiddenAt = null;
    const back = mode === "mic"
      ? `${status()}, level samples while hidden ${hiddenSamples}, peak ${hiddenPeak.toFixed(2)}`
      : status();
    run.log(`page visible after ${(away / 1000).toFixed(1)} s: ${back}; events while hidden: ${events}`);
    run.note(`${mode} after ${(away / 1000).toFixed(0)} s hidden`, `${back}; events: ${events}`);
    if (mode === "recognizer" && listener && !listener.running()) {
      run.log("trying to restart the recognizer without a tap");
      listener.start();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  run.onStop(() => document.removeEventListener("visibilitychange", onVisibility));
  run.interval(() => { if (!document.hidden) run.log(`alive: ${status()}${mode === "mic" ? `, samples ${samples}` : ""}`); }, 15_000);
  run.log("now: press the power button, wait about 20 s, turn the screen back on");
}

/** 7: say the candidate again and again; how the recognizer writes it. */
function probeCommandWord(run: Run, store: ProbeStore, candidate: string, distance: string, fan: string): void {
  const holdRelease = holdScreenAwake(window);
  run.onStop(holdRelease);
  const key = `${candidate} · ${distance} · fan ${fan}`;
  let cell = store.cells.get(key);
  if (!cell) {
    cell = { token: 0, split: 0, alt: 0, miss: 0, heard: new Map() };
    store.cells.set(key, cell);
  }
  const counted = cell;
  const guard = quickEndGuard(run);
  run.log(`cell "${key}": say "${candidate}" once, wait for the chime, repeat 10 times`);
  const listener = makeListener(run, { continuous: true, interim: false, alternatives: 3 }, {
    onStart() { guard.started(); },
    onFinal(alternatives) {
      const kind = classify(candidate, alternatives) ?? "miss";
      counted[kind] += 1;
      if (kind !== "token") {
        const as = alternatives[0] || "(empty)";
        counted.heard.set(as, (counted.heard.get(as) ?? 0) + 1);
      }
      const total = counted.token + counted.split + counted.alt + counted.miss;
      run.log(`#${total} ${kind}`);
      playChime();
      if (total === 10) run.log(`cell "${key}" has 10`);
      store.note("p7", key, `${total} said`);
    },
    onError(error) { if (FATAL.has(error)) run.stop(`fatal ${error}`); },
    onEnd() {
      if (run.stopped || guard.ended()) return;
      if (!listener?.start()) run.stop("start threw");
    },
  });
  if (!listener) return;
  if (!listener.start()) run.stop("start threw");
}

// ---------------------------------------------------------------------------
// Results text
// ---------------------------------------------------------------------------

function cellLine(key: string, cell: Cell): string {
  const total = cell.token + cell.split + cell.alt + cell.miss;
  const heard = [...cell.heard.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([text, n]) => `"${text}"×${n}`).join(" ");
  return `${key}: ${cell.token}/${total} token, ${cell.split} split, ${cell.alt} alt-only, ${cell.miss} miss${heard ? ` · heard ${heard}` : ""}`;
}

function environmentLines(config: RecConfig, onDevice: string): string[] {
  const media = typeof navigator.mediaSession !== "undefined";
  const wake = "wakeLock" in navigator;
  const audio = typeof (window as AudioWindow).AudioContext !== "undefined" || typeof (window as AudioWindow).webkitAudioContext !== "undefined";
  const voices = speechOutputSupported() ? window.speechSynthesis.getVoices().length : 0;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches ? "installed app" : "browser tab";
  return [
    `ua: ${navigator.userAgent}`,
    `lang=${config.lang} on-device=${config.local ? "on" : "off"} (check: ${onDevice}) · ${standalone} · secure=${String(window.isSecureContext)}`,
    `SpeechRecognition=${speechRecognitionConstructor() ? "yes" : "no"} speechSynthesis=${speechOutputSupported() ? `yes (${voices} voices)` : "no"} mediaSession=${media ? "yes" : "no"} wakeLock=${wake ? "yes" : "no"} AudioContext=${audio ? "yes" : "no"}`,
  ];
}

function resultsText(store: ProbeStore, config: RecConfig, onDevice: string): string {
  const out = [`VOICE PROBE ${BUNDLE_VERSION} ${new Date().toISOString()}`, ...environmentLines(config, onDevice)];
  for (const id of ORDER) {
    const record = store.records.get(id);
    if (!record && !(id === "p7" && store.cells.size > 0)) continue;
    out.push("", `[${id}] ${TITLES[id]} · runs ${record?.runs ?? 0}`);
    for (const [key, value] of record?.notes ?? []) if (!(id === "p7" && key.includes(" · "))) out.push(`  ${key}: ${value}`);
    if (id === "p7") for (const [key, cell] of store.cells) out.push(`  ${cellLine(key, cell)}`);
    if (record && record.lines.length > 0) {
      const shown = record.lines.slice(-COPY_LINES);
      const earlier = record.lines.length - shown.length + record.dropped;
      out.push(`  log${earlier > 0 ? ` (last ${shown.length}, ${earlier} earlier not copied)` : ""}:`);
      for (const line of shown) out.push(`    ${line}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const COLORS = { page: "#101216", card: "#1b1e25", edge: "#343946", text: "#e8eaf0", dim: "#9aa1b2", accent: "#7cc4ff", warn: "#ffb366" };

const buttonStyle = { font: "inherit", color: COLORS.text, background: "#2a3040", border: `1px solid ${COLORS.edge}`, borderRadius: 8, padding: "10px 14px", minHeight: 44 } as const;
const inputStyle = { font: "inherit", color: COLORS.text, background: COLORS.page, border: `1px solid ${COLORS.edge}`, borderRadius: 6, padding: "8px 10px", minHeight: 40, maxWidth: "100%", boxSizing: "border-box" } as const;

function Button({ onClick, children, accent }: { onClick: () => void; children: ReactNode; accent?: boolean }) {
  return <button type="button" onClick={onClick} style={accent ? { ...buttonStyle, background: "#1f4a6e", borderColor: COLORS.accent } : buttonStyle}>{children}</button>;
}

function Select<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (value: T) => void }) {
  return <select value={value} onChange={(event) => onChange(event.target.value as T)} style={inputStyle}>
    {options.map((option) => <option key={option} value={option}>{option}</option>)}
  </select>;
}

function Card({ id, store, help, children, running, onStop }: { id: ProbeId; store: ProbeStore; help: ReactNode; children?: ReactNode; running: boolean; onStop: () => void }) {
  const record = store.records.get(id);
  const controls = running && store.current ? Object.entries(store.current.controls) : [];
  return <section style={{ background: COLORS.card, border: `1px solid ${running ? COLORS.accent : COLORS.edge}`, borderRadius: 10, padding: 12, margin: "12px 0" }}>
    <h2 style={{ fontSize: 17, margin: "0 0 6px" }}>{TITLES[id]}{running && <span style={{ color: COLORS.accent }}> · running</span>}</h2>
    <div style={{ color: COLORS.dim, fontSize: 14, lineHeight: 1.4 }}>{help}</div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10, alignItems: "center" }}>
      {children}
      {running && <Button onClick={onStop}>Stop</Button>}
      {controls.map(([label, action]) => <Button key={label} accent onClick={action}>{label}</Button>)}
    </div>
    {record && record.notes.size > 0 && <dl style={{ margin: "10px 0 0", fontSize: 13 }}>
      {[...record.notes].map(([key, value]) => <div key={key} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><dt style={{ color: COLORS.dim }}>{key}:</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{value}</dd></div>)}
    </dl>}
    {record && record.lines.length > 0 && <details style={{ marginTop: 8 }} open={running}>
      <summary style={{ color: COLORS.dim, fontSize: 13 }}>log ({record.lines.length + record.dropped} lines)</summary>
      <pre style={{ fontSize: 11, lineHeight: 1.35, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "6px 0 0", maxHeight: 260, overflowY: "auto" }}>
        {(running ? record.lines.slice(-SHOWN_LINES) : record.lines).join("\n")}
      </pre>
    </details>}
  </section>;
}

const MINUTES = ["1", "2", "5", "10"] as const;
type Minutes = (typeof MINUTES)[number];

export function VoiceProbe() {
  const store = useMemo(() => new ProbeStore(), []);
  const [, setVersion] = useState(0);
  const [lang, setLang] = useState(() => speechTag());
  const [local, setLocal] = useState(false);
  const [onDevice, setOnDevice] = useState("not checked");
  const [minutes1, setMinutes1] = useState<Minutes>("5");
  const [minutes5, setMinutes5] = useState<Minutes>("5");
  const [loopSource, setLoopSource] = useState<LoopSource>("webaudio");
  const [faint, setFaint] = useState(false);
  const [extraWords, setExtraWords] = useState("");
  const [candidate, setCandidate] = useState<string>(BRAND.display);
  const [distance, setDistance] = useState<"1 m" | "3 m">("1 m");
  const [fan, setFan] = useState<"off" | "on">("off");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => store.subscribe(() => setVersion((version) => version + 1)), [store]);
  useEffect(() => () => store.current?.stop("page closed"), [store]);
  useEffect(() => {
    const previous = document.title;
    document.title = "Voice probe";
    return () => { document.title = previous; };
  }, []);

  const config: RecConfig = { lang, local };
  const candidates = candidateList(extraWords);
  const chosen = candidates.includes(candidate) ? candidate : BRAND.display;
  const runningId = store.current?.id ?? null;
  const stop = () => store.current?.stop("Stop tapped");
  const start = (id: ProbeId, body: (run: Run) => void | Promise<void>) => store.start(id, config, body);
  const card = (id: ProbeId, help: ReactNode, children: ReactNode) =>
    <Card id={id} store={store} help={help} running={runningId === id} onStop={stop}>{children}</Card>;

  const envLog = (text: string) => store.log("env", Math.round(performance.now()), text);
  const checkOnDevice = () => {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) { setOnDevice("no SpeechRecognition"); return; }
    setOnDevice("checking…");
    const began = performance.now();
    void prepareOnDeviceSpeech(Recognition, lang).then((result) => {
      const took = Math.round(performance.now() - began);
      setOnDevice(`${result} (${took} ms)`);
      envLog(`on-device check for ${lang}: ${result} in ${took} ms`);
      if (result !== "remote") setLocal(true);
    });
  };
  const mark = () => {
    const run = store.current;
    if (run) run.log("MARK ◆");
    else envLog(`MARK ◆ (no probe running) ${new Date().toLocaleTimeString()}`);
  };
  const copy = () => {
    const text = resultsText(store, config, onDevice);
    setCopied(text);
    void navigator.clipboard?.writeText(text).then(
      () => envLog(`results copied (${text.length} chars)`),
      () => envLog("clipboard refused; select the text box below and copy it by hand"),
    );
  };

  return <main style={{ background: COLORS.page, color: COLORS.text, minHeight: "100dvh", padding: "12px 16px 80px", boxSizing: "border-box", fontFamily: "system-ui, sans-serif", fontSize: 15 }}>
    <h1 style={{ fontSize: 20, margin: "4px 0 6px" }}>Voice probe</h1>
    <p style={{ color: COLORS.dim, margin: "0 0 10px", fontSize: 14, lineHeight: 1.4 }}>
      A developer page for the phone hands-free plan. Nothing here talks to the desktop. Run a probe, then tap Copy results and paste the text back.
      One probe runs at a time; starting one stops the other. Mark puts a ◆ in the running probe's log: tap it when you hear a beep, the music mutes, or a call shows.
    </p>
    <div style={{ position: "sticky", top: 0, zIndex: 1, background: COLORS.page, padding: "8px 0", display: "flex", gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${COLORS.edge}` }}>
      <Button accent onClick={mark}>Mark ◆</Button>
      <Button onClick={stop}>Stop</Button>
      <Button onClick={copy}>Copy results</Button>
      <span style={{ color: COLORS.dim, fontSize: 13, alignSelf: "center" }}>{runningId ? `running: ${TITLES[runningId]}` : "idle"}</span>
    </div>
    {copied !== null && <textarea readOnly value={copied} onFocus={(event) => event.currentTarget.select()} rows={8} style={{ ...inputStyle, width: "100%", marginTop: 10, fontSize: 11, fontFamily: "monospace" }} />}

    {card("env", <>
      Recognition language and the on-device recognizer, for every probe below. The check may download a language pack; tap a probe afterwards.
      <br />{environmentLines(config, onDevice).slice(1).join(" · ")}
    </>, <>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>Language <input value={lang} onChange={(event) => setLang(event.target.value)} style={{ ...inputStyle, width: 100 }} /></label>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={local} onChange={(event) => setLocal(event.target.checked)} /> on-device</label>
      <Button onClick={checkOnDevice}>Check on-device</Button>
    </>)}

    {card("p1a", <>
      After each reply the phone starts listening again by itself, with no tap. Talk now and then; it says what it heard. Measures the gaps, and whether a restart without a tap is refused.
      Tap Mark at every beep you hear.
    </>, <>
      <Select value={minutes1} options={MINUTES} onChange={setMinutes1} /> min
      <Button accent onClick={() => start("p1a", (run) => probeRestartAfterTts(run, Number(minutes1)))}>Start</Button>
    </>)}

    {card("p1b", <>
      One recognizer keeps running while the phone speaks a sentence every 15 s. Counts how often it ends, the restart gaps, and what it writes while the phone talks (those results are dropped).
      Stay quiet, or talk only between the phone's sentences. Try 10 min.
    </>, <>
      <Select value={minutes1} options={MINUTES} onChange={setMinutes1} /> min
      <Button accent onClick={() => start("p1b", (run) => probeThroughTts(run, Number(minutes1)))}>Start</Button>
    </>)}

    {card("p2", <>
      The phone says a known sentence three times on the speaker while listening. Stay silent. Shows how much of its own sentence it heard: with the plain recognizer, and with an echo-cancelled mic track handed to it (start(track), on-device only).
    </>, <>
      <Button accent onClick={() => start("p2", (run) => probeEcho(run, "plain"))}>Start: plain</Button>
      <Button accent onClick={() => start("p2", (run) => probeEcho(run, "track"))}>Start: echo-cancelled track</Button>
    </>)}

    {card("p3", <>
      A silent looping audio element holds media focus; earbud and steering-wheel buttons should arrive as BUTTON lines. Then tap Speak 5 s and Open mic 6 s and press the buttons again.
      data: and blob: are expected to be blocked by the phone's security policy (CSP BLOCKED lines); they are here to confirm it. In the car, connect over Bluetooth first.
    </>, <>
      <Select value={loopSource} options={["webaudio", "file", "data", "blob"] as const} onChange={setLoopSource} />
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={faint} onChange={(event) => setFaint(event.target.checked)} /> faint tone (webaudio)</label>
      <Button accent onClick={() => start("p3", (run) => probeSilentLoop(run, loopSource, faint))}>Start</Button>
    </>)}

    {card("p4", <>
      In the car, phone on Bluetooth. Start lists the inputs and outputs. Each Turn: the phone asks for a phrase, listens once, and says what it heard; the log has the timings. Tap Mark when the music mutes, comes back, or the car shows a call.
    </>, <>
      <Button accent onClick={() => start("p4", (run) => probeCarTurn(run))}>Start</Button>
    </>)}

    {card("p5", <>
      Turn the extractor fan on, put the phone where you would cook, stay silent, Start. Anything written counts as a false trigger when it matches a command word candidate (field under probe 7).
    </>, <>
      <Select value={minutes5} options={MINUTES} onChange={setMinutes5} /> min
      <Button accent onClick={() => start("p5", (run) => probeFan(run, Number(minutes5), candidates))}>Start</Button>
    </>)}

    {card("p6", <>
      Start, then press the power button, wait about 20 s and turn the screen back on. Shows whether the mic track or the recognizer survived (expected: no).
    </>, <>
      <Button accent onClick={() => start("p6", (run) => probeScreenOff(run, "mic"))}>Start: mic</Button>
      <Button accent onClick={() => start("p6", (run) => probeScreenOff(run, "recognizer"))}>Start: recognizer</Button>
    </>)}

    {card("p7", <>
      Pick a word, the distance and the fan, Start, then say the word 10 times, waiting for the chime each time. Counts how often the recognizer writes it as one word (token), in pieces (split), only as a lower-ranked guess (alt), or not at all (miss).
      The first candidate is the app's name; add others separated by commas.
      {store.cells.size > 0 && <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: COLORS.text }}>
        {[...store.cells].map(([key, cell]) => <li key={key}>{cellLine(key, cell)}</li>)}
      </ul>}
    </>, <>
      <input value={extraWords} placeholder="other candidates, comma separated" onChange={(event) => setExtraWords(event.target.value)} style={{ ...inputStyle, width: "100%" }} />
      <Select value={chosen} options={candidates} onChange={setCandidate} />
      <Select value={distance} options={["1 m", "3 m"] as const} onChange={setDistance} />
      fan <Select value={fan} options={["off", "on"] as const} onChange={setFan} />
      <Button accent onClick={() => start("p7", (run) => probeCommandWord(run, store, chosen, distance, fan))}>Start</Button>
    </>)}
  </main>;
}
