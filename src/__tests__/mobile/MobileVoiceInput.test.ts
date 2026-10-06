import { describe, expect, it, vi } from "vitest";
import { en } from "../../lib/i18n";
import {
  ON_DEVICE_CHECK_LIMIT_MS,
  onDeviceSpeechAsked,
  prepareOnDeviceSpeech,
  sanitizeVoiceTranscript,
  speechRecognitionConstructor,
  speechRecognitionError,
  speechRecognitionSupported,
  advanceDictation,
  DICTATION_START,
  dictationPreview,
  readDictation,
  settleDictation,
  spokenSend,
  type MobileSpeechRecognition,
  type MobileSpeechRecognitionConstructor,
  type MobileSpeechRecognitionResultEvent,
} from "../../../mobile-web/src/voiceInput";
import { BRAND } from "../../lib/brand";

class FakeRecognition implements MobileSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onstart = null;
  onresult = null;
  onerror = null;
  onend = null;
  start() {}
  stop() {}
  abort() {}
}

function result(transcript: string, isFinal: boolean) {
  return { 0: { transcript }, isFinal, length: 1 };
}

/** A window as Chromium shows it: `userAgentData` is Chromium's alone. Safari's
 * has none. Timers go to the test's own, so fake timers reach them. */
function browserScope(chromium: boolean): Window {
  return {
    navigator: chromium ? { userAgentData: {} } : {},
    setTimeout: (handler: () => void, ms: number) => window.setTimeout(handler, ms),
    clearTimeout: (id: number) => window.clearTimeout(id),
  } as unknown as Window;
}
const CHROMIUM = browserScope(true);
const SAFARI = browserScope(false);

describe(`${BRAND.display} Mobile voice input`, () => {
  it("uses standard or prefixed mobile speech recognition", () => {
    const Constructor = FakeRecognition as MobileSpeechRecognitionConstructor;
    const standard = { SpeechRecognition: Constructor } as unknown as Window;
    const prefixed = { webkitSpeechRecognition: Constructor } as unknown as Window;

    expect(speechRecognitionConstructor(standard)).toBe(Constructor);
    expect(speechRecognitionConstructor(prefixed)).toBe(Constructor);
    expect(speechRecognitionSupported({} as Window)).toBe(false);
  });

  it("prefers an installed on-device dictation model", async () => {
    class LocalRecognition extends FakeRecognition {
      static available = async () => "available" as const;
    }

    await expect(prepareOnDeviceSpeech(LocalRecognition, "de-DE", CHROMIUM)).resolves.toBe("local");
  });

  it("installs a downloadable on-device language pack before retrying", async () => {
    class DownloadableRecognition extends FakeRecognition {
      static available = async () => "downloadable" as const;
      static install = async () => true;
    }

    await expect(prepareOnDeviceSpeech(DownloadableRecognition, "en-US", CHROMIUM)).resolves.toBe("installed");
  });

  it("falls back to the browser speech service when local dictation is unavailable", async () => {
    class RemoteRecognition extends FakeRecognition {
      static available = async () => "unavailable" as const;
    }

    await expect(prepareOnDeviceSpeech(RemoteRecognition, "en-US", CHROMIUM)).resolves.toBe("remote");
  });

  it("never asks Safari's on-device recognizer, whose check hung on an iPad", async () => {
    const available = vi.fn(() => new Promise<"available">(() => {}));
    class SafariRecognition extends FakeRecognition {
      static available = available;
    }

    expect(onDeviceSpeechAsked(SafariRecognition, SAFARI)).toBe(false);
    expect(onDeviceSpeechAsked(SafariRecognition, CHROMIUM)).toBe(true);
    await expect(prepareOnDeviceSpeech(SafariRecognition, "de-DE", SAFARI)).resolves.toBe("remote");
    expect(available).not.toHaveBeenCalled();
  });

  it("uses the speech service when the on-device check does not answer", async () => {
    vi.useFakeTimers();
    try {
      class StuckRecognition extends FakeRecognition {
        static available = () => new Promise<"available">(() => {});
      }
      const prepared = prepareOnDeviceSpeech(StuckRecognition, "en-US", CHROMIUM);
      await vi.advanceTimersByTimeAsync(ON_DEVICE_CHECK_LIMIT_MS);
      await expect(prepared).resolves.toBe("remote");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the whole result list, whatever resultIndex says", () => {
    const event = {
      resultIndex: 1,
      results: {
        0: result("fix the login", true),
        1: result("and add a test", true),
        2: result("please", false),
        length: 3,
      },
    } as unknown as MobileSpeechRecognitionResultEvent;

    expect(readDictation(event)).toEqual({
      heard: ["fix", "the", "login", "and", "add", "a", "test"],
      interim: "please",
    });
  });

  it("collapses a final result that repeats the earlier words as its head", () => {
    const event = {
      resultIndex: 0,
      results: {
        0: result("fix the login", true),
        1: result("Fix the login, and test", true),
        2: result("fix the login and test and", false),
        length: 3,
      },
    } as unknown as MobileSpeechRecognitionResultEvent;

    expect(readDictation(event)).toEqual({ heard: ["Fix", "the", "login,", "and", "test"], interim: "and" });
  });

  it("collapses a later utterance that is finalized again as it grows", () => {
    const event = {
      resultIndex: 3,
      results: {
        0: result("fix the login", true),
        1: result("how are", true),
        2: result("how are you", true),
        3: result("How are you today", true),
        4: result("how are you today and", false),
        length: 5,
      },
    } as unknown as MobileSpeechRecognitionResultEvent;

    expect(readDictation(event)).toEqual({
      heard: ["fix", "the", "login", "How", "are", "you", "today"],
      interim: "and",
    });
  });

  it("takes a re-read utterance with a revised word as the same one", () => {
    const event = {
      resultIndex: 0,
      results: {
        0: result("fix a login page", true),
        1: result("fix the login page now", true),
        length: 2,
      },
    } as unknown as MobileSpeechRecognitionResultEvent;

    expect(readDictation(event).heard).toEqual(["fix", "the", "login", "page", "now"]);
  });

  it("does not take a shorter, unrelated list for the old one because a word matches", () => {
    const before = advanceDictation(DICTATION_START, ["the", "login", "page", "is", "broken"]).progress;
    const step = advanceDictation(before, ["the", "tests"]);
    expect(step.insert).toBe("the tests");
  });

  it("inserts each heard word once, and none of them again after a send", () => {
    let step = advanceDictation(DICTATION_START, ["fix", "the"]);
    expect(step.insert).toBe("fix the");
    step = advanceDictation(step.progress, ["fix", "the", "login"]);
    expect(step.insert).toBe("login");
    step = advanceDictation(step.progress, ["fix", "the", "login"]);
    expect(step.insert).toBe("");

    const sent = settleDictation(step.progress);
    expect(dictationPreview(sent, "and")).toBe("and");
    step = advanceDictation(sent, ["fix", "the", "login", "and", "test"]);
    expect(step.insert).toBe("and test");
    expect(dictationPreview(step.progress, "")).toBe("and test");
  });

  it("keeps counting through a revised word instead of inserting the sentence again", () => {
    const before = advanceDictation(DICTATION_START, ["why", "is", "this", "other"]).progress;
    const step = advanceDictation(before, ["why", "is", "the", "other", "prompt"]);
    expect(step.insert).toBe("prompt");
  });

  it("takes a result list that starts over as new words", () => {
    const before = advanceDictation(DICTATION_START, ["fix", "the", "login"]).progress;
    const step = advanceDictation(settleDictation(before), ["add", "a", "test"]);
    expect(step.insert).toBe("add a test");
    expect(dictationPreview(step.progress, "")).toBe("add a test");
  });

  it("removes control bytes before a transcript reaches the PTY", () => {
    expect(sanitizeVoiceTranscript("  inspect\nthis\u001b[2J  now\u0000 ")).toBe(
      "inspect this [2J now",
    );
  });

  it("turns browser speech failures into actionable phone guidance", () => {
    expect(speechRecognitionError("not-allowed")).toBe("mobile.voice.errDenied");
    expect(speechRecognitionError("service-not-allowed")).toBe("mobile.voice.errDenied");
    expect(speechRecognitionError("audio-capture")).toBe("mobile.voice.errNoMic");
    expect(speechRecognitionError("something-new")).toBe("mobile.voice.errStopped");
    expect(speechRecognitionError("aborted")).toBeNull();
    for (const error of ["not-allowed", "audio-capture", "network", "language-not-supported", "no-speech", "x"]) {
      const key = speechRecognitionError(error);
      expect(key && en[key]).toBeTruthy();
    }
  });

  it("sends on a spoken \"go on\" or \"los\" said last, without those words", () => {
    expect(spokenSend("fix the login go on")).toBe("fix the login");
    expect(spokenSend("Fix the login. Go on.")).toBe("Fix the login.");
    expect(spokenSend("fix the login, go on")).toBe("fix the login");
    expect(spokenSend("Behebe den Fehler los")).toBe("Behebe den Fehler");
    expect(spokenSend("Behebe den Fehler. Los!")).toBe("Behebe den Fehler.");
    expect(spokenSend("go on")).toBe("");
  });

  it("leaves a \"go on\" or \"los\" that is not a send in the draft", () => {
    expect(spokenSend("fix the login")).toBeNull();
    expect(spokenSend("go on and fix the login")).toBeNull();
    expect(spokenSend("what is going on")).toBeNull();
    expect(spokenSend("das ist ziellos")).toBeNull();
    expect(spokenSend("Was ist los?")).toBeNull();
    expect(spokenSend("fly to Los Angeles")).toBeNull();
  });
});
