import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LANGUAGES, type Language, type TranslationKey } from "../i18n";
import { isServerClient } from "../transport/linkState";

// The renderer's side of the desktop speech engine (`services::voice`,
// docs/desktop_voice_plan.md step 3). The backend owns the audio and hands
// back text; the Chat's composer owns the words and sends them itself.

/** `services::voice::VoiceError`, as the backend serializes it. */
export type VoiceErrorCode =
  | "not-built"
  | "cpu-unsupported"
  | "model-missing"
  | "unknown-model"
  | "bad-argument"
  | "no-device"
  | "permission-denied"
  | "device-busy"
  | "device-failed"
  | "mic-silent"
  | "model-failed"
  | "not-active"
  | "no-speech-server"
  | "speech-failed";

/** Every code the backend can send, said in the UI language: a code added in
 * Rust without a row here fails the build. */
export const VOICE_ERROR_KEYS: Record<VoiceErrorCode, TranslationKey> = {
  "not-built": "terminal.reader.voice.err.notBuilt",
  "cpu-unsupported": "terminal.reader.voice.err.cpu",
  "model-missing": "terminal.reader.voice.err.modelMissing",
  "unknown-model": "terminal.reader.voice.err.failed",
  "bad-argument": "terminal.reader.voice.err.failed",
  "no-device": "terminal.reader.voice.err.noDevice",
  "permission-denied": "terminal.reader.voice.err.denied",
  "device-busy": "terminal.reader.voice.err.busy",
  "device-failed": "terminal.reader.voice.err.device",
  "mic-silent": "terminal.reader.voice.err.silent",
  "model-failed": "terminal.reader.voice.err.model",
  "not-active": "terminal.reader.voice.err.failed",
  "no-speech-server": "terminal.reader.voice.err.noSpeechServer",
  "speech-failed": "terminal.reader.voice.err.speech",
};

function isVoiceErrorCode(value: unknown): value is VoiceErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(VOICE_ERROR_KEYS, value);
}

/** The message for whatever a voice command or event failed with. */
export function voiceErrorKey(error: unknown): TranslationKey {
  const code = error instanceof Error ? error.message : error;
  return isVoiceErrorCode(code) ? VOICE_ERROR_KEYS[code] : "terminal.reader.voice.err.failed";
}

export type ListenMode = "dictate" | "handsFree";

export interface VoiceOwner {
  kind: "tab";
  /** The window label holding the mic. */
  window: string;
  tabKey: string;
}

export interface VoiceSessionInfo {
  session: number;
  owner: VoiceOwner;
  mode: ListenMode;
  paused: boolean;
}

export interface VoiceModelState {
  id: string;
  kind: "whisper" | "vad";
  installed: boolean;
  sizeBytes: number;
}

export interface VoiceStatus {
  cpu: boolean;
  models: VoiceModelState[];
  defaultModel: string;
  listen: VoiceErrorCode | null;
  speak: VoiceErrorCode | null;
  session: VoiceSessionInfo | null;
  /** Whether this build can use a GPU at all. */
  gpuBuilt: boolean;
  /** The last GPU attempt never came back: the CPU until `retryVoiceGpu`. */
  gpuCrashed: boolean;
  /** Where the last load landed, null before the first. */
  device: VoiceDevice | null;
}

/** `services::voice::gpu::CpuReason`. */
export type VoiceCpuReason = "not-built" | "no-gpu" | "off" | "crashed";

/** Where whisper really runs (`services::voice::gpu`, docs/voice_gpu_plan.md):
 * what a load got, never what the setting asked for. */
export type VoiceDevice = { kind: "gpu"; name: string | null } | { kind: "cpu"; reason: VoiceCpuReason };

/** Every reason the backend can send, said in the UI language: one added in
 * Rust without a row here fails the build. */
export const VOICE_CPU_REASON_KEYS: Record<VoiceCpuReason, TranslationKey> = {
  "not-built": "terminal.reader.voice.cpu.notBuilt",
  "no-gpu": "terminal.reader.voice.cpu.noGpu",
  off: "terminal.reader.voice.cpu.off",
  crashed: "terminal.reader.voice.cpu.crashed",
};

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** `GPU · <card>` or `CPU`. */
export function voiceDeviceLabel(device: VoiceDevice, t: Translate): string {
  if (device.kind === "cpu") return t("terminal.reader.voice.deviceCpu");
  return device.name ? t("terminal.reader.voice.deviceGpu", { name: device.name }) : t("terminal.reader.voice.deviceGpuNoName");
}

/** Why a load landed on the CPU; nothing to explain on the GPU. */
export function voiceDeviceWhy(device: VoiceDevice, t: Translate): string | undefined {
  return device.kind === "cpu" ? t(VOICE_CPU_REASON_KEYS[device.reason]) : undefined;
}

export const VOICE_EVENTS = {
  level: "voice:level",
  vad: "voice:vad",
  partial: "voice:partial",
  final: "voice:final",
  state: "voice:state",
  owner: "voice:owner",
  error: "voice:error",
  speaking: "voice:speaking",
} as const;

export type VoiceState = "preparing" | "listening" | "paused" | "stopped";

export interface LevelEvent { session: number; level: number }
export interface VadEvent { session: number; segment: number; state: "start" | "end" }
export interface TextEvent { session: number; segment: number; text: string }
export interface StateEvent { session: number; state: VoiceState; reason?: VoiceErrorCode; device?: VoiceDevice }
export interface ErrorEvent { session: number; code: VoiceErrorCode }
/** What became of a read (`voice_speak`); `done` comes after the mic's mute
 * tail, so the room is quiet by then. */
export interface SpeakingEvent { readId: string; state: "started" | "done" | "stopped" | "failed"; reason?: VoiceErrorCode }
export interface OwnerEvent { session: number | null; owner: VoiceOwner | null; mode: ListenMode | null }

/** The speech models the Settings page offers, smallest first (the catalog's
 * whisper ids; `small` is the default). */
export const VOICE_MODELS = ["base", "small", "large-v3-turbo"] as const;
export type VoiceModel = (typeof VOICE_MODELS)[number];
export const DEFAULT_VOICE_MODEL: VoiceModel = "small";
/** A model's name, size and verdict in a picker (Settings and the Chat's install card). */
export const VOICE_MODEL_LABELS: Record<VoiceModel, TranslationKey> = {
  base: "settings.voice.modelBase",
  small: "settings.voice.modelSmall",
  "large-v3-turbo": "settings.voice.modelLarge",
};

/** The speech language setting: `auto` is the UI language; `detect` lets
 * whisper guess, which it often gets wrong on a short utterance. */
export type VoiceLangChoice = "auto" | "detect" | Language;

/** What the backend is asked to listen in. */
export function voiceLangTag(choice: VoiceLangChoice | undefined, uiLanguage: Language): string {
  if (!choice || choice === "auto") return uiLanguage;
  if (choice === "detect") return "auto";
  return choice;
}

/** The speech language picker's choices (Settings → Voice and the Chat's dictation strip). */
export function voiceLangOptions(t: (key: TranslationKey) => string): { value: VoiceLangChoice; label: string }[] {
  return [
    { value: "auto", label: t("settings.voice.langAuto") },
    ...LANGUAGES.map((language) => ({ value: language.value, label: language.label })),
    { value: "detect", label: t("settings.voice.langDetect") },
  ];
}

/** The hands-free pause (step 4): its range and default, in ms. */
export const VOICE_PAUSE_MS = { min: 800, max: 4000, default: 1500 } as const;

/** A browser client reaches a server, not the machine the user sits at: the
 * microphone is never its (the commands are `client` class). */
export function voiceInputOffered(): boolean {
  return !isServerClient();
}

export function voiceStatus(): Promise<VoiceStatus> {
  return invoke<VoiceStatus>("voice_status");
}

/** The command line that installs `model` (and the voice detector) in an
 * install tab. */
export function voiceModelInstallCommand(model: string): Promise<string> {
  return invoke<string>("voice_model_install_script", { id: model });
}

/** Forget that a GPU attempt crashed the app: the next listen tries it again. */
export function retryVoiceGpu(): Promise<void> {
  return invoke("voice_gpu_retry");
}

/** What the composer is told while a dictation runs. */
export interface DesktopDictationHandlers {
  /** The model is loading. */
  onPreparing(): void;
  /** The model loaded, here. */
  onDevice(device: VoiceDevice): void;
  /** The mic is open. */
  onStart(): void;
  /** Speech started (`open`) or ended; until its final, the segment is unsettled. */
  onSegment(open: boolean, segment: number): void;
  /** The live guess at the open segment. */
  onPartial(text: string): void;
  /** A settled segment: its text, or empty when it was dropped. */
  onFinal(text: string, segment: number): void;
  onLevel(level: number | null): void;
  onPaused(paused: boolean): void;
  onError(key: TranslationKey): void;
  /** The session is over; no more events come. */
  onEnd(): void;
}

export interface DesktopDictationOptions {
  tabKey: string;
  model: string;
  lang: string;
  mode: ListenMode;
  pauseMs: number;
  headset: boolean;
  /** The `voice_gpu` setting. */
  gpu: boolean;
}

export interface DesktopDictation {
  /** Stop listening; what was said so far still arrives. */
  stop(): void;
  /** Stop and drop everything still on its way (a send just emptied the draft). */
  abort(): void;
  pause(paused: boolean): void;
}

type Payload = { session: number };

/**
 * Start dictating into the calling window's tab `options.tabKey`. Listens
 * before it asks, so nothing the new session says is missed, and keeps only
 * its own session's events: a session it replaced may still send a final.
 * Rejects with the backend's code when the mic or model cannot be had.
 */
export async function startDesktopDictation(
  options: DesktopDictationOptions,
  handlers: DesktopDictationHandlers,
): Promise<DesktopDictation> {
  let session: number | null = null;
  let ended = false;
  /** Events that arrived before the session's id did. */
  const early: [string, Payload][] = [];
  const unlisten: UnlistenFn[] = [];

  const finish = () => {
    if (ended) return;
    ended = true;
    for (const off of unlisten.splice(0)) off();
    handlers.onLevel(null);
    handlers.onEnd();
  };

  const handle = (event: string, payload: Payload) => {
    if (ended || payload.session !== session) return;
    switch (event) {
      case VOICE_EVENTS.level:
        handlers.onLevel((payload as LevelEvent).level);
        break;
      case VOICE_EVENTS.vad: {
        const vad = payload as VadEvent;
        handlers.onSegment(vad.state === "start", vad.segment);
        break;
      }
      case VOICE_EVENTS.partial:
        handlers.onPartial((payload as TextEvent).text);
        break;
      case VOICE_EVENTS.final: {
        const final = payload as TextEvent;
        handlers.onFinal(final.text, final.segment);
        break;
      }
      case VOICE_EVENTS.error:
        handlers.onError(voiceErrorKey((payload as ErrorEvent).code));
        break;
      case VOICE_EVENTS.state: {
        const state = payload as StateEvent;
        if (state.device) handlers.onDevice(state.device);
        if (state.state === "preparing") handlers.onPreparing();
        else if (state.state === "listening") {
          handlers.onPaused(false);
          handlers.onStart();
        } else if (state.state === "paused") handlers.onPaused(true);
        else {
          if (state.reason) handlers.onError(voiceErrorKey(state.reason));
          finish();
        }
        break;
      }
    }
  };

  const route = (event: string) => (e: { payload: Payload }) => {
    if (session === null) early.push([event, e.payload]);
    else handle(event, e.payload);
  };
  try {
    for (const event of [VOICE_EVENTS.level, VOICE_EVENTS.vad, VOICE_EVENTS.partial, VOICE_EVENTS.final, VOICE_EVENTS.error, VOICE_EVENTS.state]) {
      unlisten.push(await listen<Payload>(event, route(event)));
    }
    session = await invoke<number>("voice_listen_start", {
      tabKey: options.tabKey,
      model: options.model,
      lang: options.lang,
      mode: options.mode,
      pauseMs: options.pauseMs,
      headset: options.headset,
      gpu: options.gpu,
    });
  } catch (error) {
    for (const off of unlisten.splice(0)) off();
    throw error;
  }
  for (const [event, payload] of early.splice(0)) handle(event, payload);

  const id = session;
  return {
    stop: () => {
      if (!ended) void invoke("voice_listen_stop", { session: id }).catch(finish);
    },
    abort: () => {
      if (ended) return;
      void invoke("voice_listen_stop", { session: id }).catch(() => {});
      finish();
    },
    pause: (paused) => {
      if (!ended) void invoke("voice_listen_pause", { session: id, paused }).catch(() => {});
    },
  };
}

/** `voice_speak`'s bounds (`services::voice`). */
export const SPEAK_LIMITS = { chunks: 200, chunkChars: 1000, rate: { min: 0.5, max: 2 } } as const;

/** Read `chunks` aloud as read `id` (after what is being said; `replace`:
 * instead of it). `voice:speaking` follows it; rejects with the backend's
 * code when there is no voice. */
export function voiceSpeak(id: string, chunks: string[], lang: string, rate = 1, replace = false): Promise<void> {
  return invoke("voice_speak", { id, chunks, lang, rate, replace });
}

/** Stop what is being read, and everything queued. */
export function voiceSpeakStop(): Promise<void> {
  return invoke("voice_speak_stop");
}

/** Stop whichever session holds the mic (the header indicator's click). */
export function stopVoiceSession(session: number): Promise<void> {
  return invoke("voice_listen_stop", { session });
}

/** Follow where the running session's whisper landed, machine-wide:
 * `voice:state` broadcasts; null once the session stopped. */
export function watchVoiceDevice(onChange: (device: VoiceDevice | null) => void): () => void {
  let live = true;
  let off: UnlistenFn | undefined;
  void listen<StateEvent>(VOICE_EVENTS.state, (e) => {
    if (e.payload.state === "stopped") onChange(null);
    else if (e.payload.device) onChange(e.payload.device);
  }).then((unlisten) => {
    if (live) off = unlisten;
    else unlisten();
  });
  void voiceStatus().then(
    (status) => {
      if (live && status.session) onChange(status.device);
    },
    () => {},
  );
  return () => {
    live = false;
    off?.();
  };
}

/** Follow who holds the mic, machine-wide: `voice:owner` broadcasts, after
 * the current answer of `voice_status` (a reloaded window recovers it). */
export function watchVoiceOwner(onChange: (owner: OwnerEvent) => void): () => void {
  let live = true;
  let off: UnlistenFn | undefined;
  void listen<OwnerEvent>(VOICE_EVENTS.owner, (e) => onChange(e.payload)).then((unlisten) => {
    if (live) off = unlisten;
    else unlisten();
  });
  void voiceStatus().then(
    (status) => {
      if (!live || !status.session) return;
      onChange({ session: status.session.session, owner: status.session.owner, mode: status.session.mode });
    },
    () => {},
  );
  return () => {
    live = false;
    off?.();
  };
}
