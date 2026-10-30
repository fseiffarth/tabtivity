import type { TranslationKey } from "../../src/lib/i18n";
import {
  speechRecognitionError,
  type MobileSpeechRecognition,
  type MobileSpeechRecognitionConstructor,
  type MobileSpeechRecognitionResultEvent,
} from "./voiceInput";

export interface DictationSessionHandlers {
  /** The microphone opened; once per session, not per restart. */
  onStart(): void;
  onResult(event: MobileSpeechRecognitionResultEvent): void;
  /** The browser ended its recognizer and a new one took over: the next
   * result list starts empty, so nothing of the last one is read back. */
  onRestart(): void;
  onError(message: TranslationKey): void;
  /** How loud the microphone is, 0–1; `null` once nothing is measured. Called
   * many times a second — paint it without a React render. */
  onLevel(level: number | null): void;
  /** The session is over, stopped or failed. Never follows `abort()`. */
  onEnd(): void;
}

export interface DictationSession {
  /** The user's stop: the recognizer finalizes what it holds, then `onEnd`. */
  stop(): void;
  /** The app's teardown: silent, no handler runs again. */
  abort(): void;
}

/** A recognizer that ends sooner than this after starting did not listen. */
const QUICK_END_MS = 1_000;
/** This many of those in a row and the session gives up rather than loop. */
const MAX_QUICK_ENDS = 3;
const RESTART_DELAY_MS = 250;
/** Silence this long ends the session: the screen is held awake meanwhile. */
const IDLE_LIMIT_MS = 120_000;
/** Errors no restart can get past. */
const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"]);

type WakeLockLike = { release(): Promise<void> };
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockLike> } };
type AudioWindow = Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };

/** The screen stays on while dictating: a phone that blanks takes the
 * microphone with it. The browser drops the lock whenever the page is hidden,
 * so it is asked for again each time the page comes back. */
export function holdScreenAwake(scope: Window): () => void {
  const wakeLock = (scope.navigator as WakeLockNavigator).wakeLock;
  if (!wakeLock) return () => {};
  let released = false;
  let lock: WakeLockLike | undefined;
  const acquire = () => {
    if (released || scope.document.hidden) return;
    wakeLock.request("screen").then((next) => {
      if (released) void next.release().catch(() => {});
      else lock = next;
    }).catch(() => {});
  };
  acquire();
  scope.document.addEventListener("visibilitychange", acquire);
  return () => {
    released = true;
    scope.document.removeEventListener("visibilitychange", acquire);
    void lock?.release().catch(() => {});
  };
}

export interface MicMeter {
  track: MediaStreamTrack;
  close(): void;
}

/**
 * One capture feeding both the level meter and the recognizer. Only for the
 * on-device recognizer (`start(track)` shipped with Chromium's on-device API):
 * the phone's speech service handed a track hears nothing on Android — it
 * listens, never errs, and returns no words — and a second capture beside the
 * recognizer's own starves one of the two there.
 */
export async function openMicMeter(scope: Window, onLevel: (level: number) => void): Promise<MicMeter | undefined> {
  const audioWindow = scope as AudioWindow;
  const Context = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  const devices = scope.navigator.mediaDevices;
  if (!Context || !devices?.getUserMedia) return undefined;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  try {
    stream = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("no audio track");
    context = new Context();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const timer = scope.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      // Speech sits around 0.05–0.3 RMS; stretch that over the meter's range.
      onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
    }, 80);
    const opened = stream;
    const running = context;
    return {
      track,
      close() {
        scope.clearInterval(timer);
        for (const each of opened.getTracks()) each.stop();
        void running.close().catch(() => {});
      },
    };
  } catch {
    for (const each of stream?.getTracks() ?? []) each.stop();
    void context?.close().catch(() => {});
    return undefined;
  }
}

/**
 * One dictation, from the tap to the stop. The browser's recognizer gives up
 * after a pause or a minute even when `continuous`; this starts it again for as
 * long as the user has not stopped, so a breath does not end the dictation.
 */
export function startDictation(
  Recognition: MobileSpeechRecognitionConstructor,
  config: { lang: string; local: boolean },
  handlers: DictationSessionHandlers,
  scope: Window = window,
): DictationSession {
  let wanted = true;
  let over = false;
  let announced = false;
  /** Whether a recognizer is live to answer `stop()` with an `onend`. */
  let running = false;
  let startedAt = 0;
  let quickEnds = 0;
  let failure: TranslationKey | null = null;
  let restartTimer: number | undefined;
  let idleTimer: number | undefined;
  let meter: MicMeter | undefined;
  const releaseScreen = holdScreenAwake(scope);

  const recognizer: MobileSpeechRecognition = new Recognition();
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.lang = config.lang;
  recognizer.maxAlternatives = 1;
  recognizer.processLocally = config.local;

  const release = () => {
    over = true;
    wanted = false;
    scope.clearTimeout(restartTimer);
    scope.clearTimeout(idleTimer);
    releaseScreen();
    meter?.close();
    meter = undefined;
    recognizer.onstart = null;
    recognizer.onresult = null;
    recognizer.onerror = null;
    recognizer.onend = null;
    recognizer.onspeechstart = null;
    recognizer.onspeechend = null;
  };
  const finish = () => {
    if (over) return;
    release();
    handlers.onLevel(null);
    if (failure) handlers.onError(failure);
    handlers.onEnd();
  };
  const armIdle = () => {
    scope.clearTimeout(idleTimer);
    idleTimer = scope.setTimeout(() => {
      failure = "mobile.voice.errNoSpeech";
      wanted = false;
      if (running) recognizer.stop();
      else finish();
    }, IDLE_LIMIT_MS);
  };
  const begin = () => {
    try {
      startedAt = Date.now();
      running = true;
      if (meter) recognizer.start(meter.track);
      else recognizer.start();
    } catch {
      running = false;
      failure = "mobile.voice.startFailed";
      finish();
    }
  };

  recognizer.onstart = () => {
    if (announced) return;
    announced = true;
    handlers.onStart();
  };
  recognizer.onresult = (event) => {
    quickEnds = 0;
    armIdle();
    handlers.onResult(event);
  };
  // Without a measured level, the recognizer's own "someone is speaking"
  // events still move the meter, as on and off.
  recognizer.onspeechstart = () => { if (!meter) handlers.onLevel(0.6); };
  recognizer.onspeechend = () => { if (!meter) handlers.onLevel(0); };
  recognizer.onerror = (event) => {
    // A pause is not a failure: the restart below keeps listening through it.
    if (event.error === "no-speech" || event.error === "aborted") return;
    failure = speechRecognitionError(event.error);
    if (FATAL.has(event.error)) wanted = false;
  };
  recognizer.onend = () => {
    running = false;
    if (over) return;
    quickEnds = Date.now() - startedAt < QUICK_END_MS ? quickEnds + 1 : 0;
    const looping = quickEnds >= MAX_QUICK_ENDS;
    // A hidden page cannot hold the microphone; restarting there only fails.
    if (!wanted || looping || scope.document.hidden) {
      if (wanted && looping) failure ??= "mobile.voice.errStopped";
      finish();
      return;
    }
    // The error before this end was one a fresh recognizer gets past.
    failure = null;
    restartTimer = scope.setTimeout(() => {
      if (over) return;
      handlers.onRestart();
      begin();
    }, RESTART_DELAY_MS * (quickEnds + 1));
  };

  armIdle();
  if (config.local && Recognition.available) {
    void openMicMeter(scope, handlers.onLevel).then((opened) => {
      if (over) { opened?.close(); return; }
      meter = opened;
      begin();
    });
  } else begin();

  return {
    stop() {
      if (over) return;
      wanted = false;
      // Between two recognizers nothing is running to answer `stop()`.
      if (running) recognizer.stop();
      else finish();
    },
    abort() {
      if (over) return;
      release();
      recognizer.abort();
    },
  };
}
