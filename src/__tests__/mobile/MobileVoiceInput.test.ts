import { beforeAll, describe, expect, it, vi } from "vitest";
import { en, loadDict } from "../../lib/i18n";
import {
  ON_DEVICE_CHECK_LIMIT_MS,
  onDeviceSpeechAsked,
  prepareOnDeviceSpeech,
  speechRecognitionConstructor,
  speechRecognitionError,
  speechRecognitionSupported,
  advanceDictation,
  DICTATION_START,
  dictationPreview,
  scanDictation,
  settleDictation,
  settleUtterances,
  stepUtterances,
  UTTERANCES_START,
  type DictationProgress,
  type DictationScan,
  type UtteranceLedger,
  type UtteranceOptions,
  type MobileSpeechRecognition,
  type MobileSpeechRecognitionConstructor,
  type MobileSpeechRecognitionResultEvent,
} from "../../../mobile-web/src/voiceInput";
import { BRAND } from "../../lib/brand";
import { startLexicon } from "../../../mobile-web/src/startLexicon";

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

    expect(scanDictation(event)).toMatchObject({
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

    expect(scanDictation(event)).toMatchObject({ heard: ["Fix", "the", "login,", "and", "test"], interim: "and" });
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

    expect(scanDictation(event)).toMatchObject({
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

    expect(scanDictation(event).heard).toEqual(["fix", "the", "login", "page", "now"]);
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
});

// ---------------------------------------------------------------- the utterance layer

const T = BRAND.assistant;

/** One recognizer event: the whole result list, as Chrome on Android sends it. */
function listing(...items: [string, boolean][]): MobileSpeechRecognitionResultEvent {
  return {
    resultIndex: 0,
    results: Object.assign(
      Object.fromEntries(items.map(([transcript, isFinal], index) => [index, result(transcript, isFinal)])),
      { length: items.length },
    ),
  } as unknown as MobileSpeechRecognitionResultEvent;
}

/** A recognition session fed event by event, the way the dictation hook does. */
class Session {
  progress: DictationProgress = DICTATION_START;
  ledger: UtteranceLedger = UTTERANCES_START;
  typed: string[] = [];
  offered: string[] = [];
  bare = 0;
  preview = "";
  scan: DictationScan | undefined;
  constructor(private options: Partial<UtteranceOptions> & { take?: (text: string) => boolean } = {}, private lang: "en" | "de" = "en") {}
  private opts(extra: Partial<UtteranceOptions>): UtteranceOptions {
    const { take, ...rest } = this.options;
    return {
      gate: false, holdBack: true, ...rest, ...extra,
      onWithheld: (text) => { this.offered.push(text); return take?.(text) ?? false; },
    };
  }
  private take(step: ReturnType<typeof stepUtterances>) {
    this.progress = step.progress;
    this.ledger = step.ledger;
    if (step.insert) this.typed.push(step.insert);
    if (step.bare) this.bare += 1;
    return step;
  }
  hear(...items: [string, boolean][]) {
    this.scan = scanDictation(listing(...items));
    const step = this.take(stepUtterances(this.ledger, this.progress, this.scan, startLexicon(this.lang), this.opts({})));
    this.preview = step.preview;
    return step.insert;
  }
  /** The timer ran out, or the recognizer restarted: the live utterance is whole. */
  settle() {
    const step = this.take(settleUtterances(this.ledger, this.progress, startLexicon(this.lang), this.opts({})));
    this.preview = step.preview;
    return step.insert;
  }
  restart() {
    const inserted = this.settle();
    this.progress = DICTATION_START;
    this.ledger = UTTERANCES_START;
    return inserted;
  }
  get draft() { return this.typed.join(" "); }
}

describe(`${BRAND.display} Mobile utterance layer`, () => {
  beforeAll(async () => {
    expect(await loadDict("en")).toBe(true);
    expect(await loadDict("de")).toBe(true);
  });

  it("finds where each utterance of a result list starts", () => {
    const scan = scanDictation(listing(
      ["fix the login", true], ["how are", true], ["how are you", true], ["How are you today", true], ["and add", false],
    ));
    expect(scan.heard).toEqual(["fix", "the", "login", "How", "are", "you", "today"]);
    expect(scan.starts).toEqual([0, 3]);
    expect(scan.interim).toBe("and add");
    expect(scan.tail).toBe("new");
    expect(scan.live).toEqual(["and", "add"]);
    // An interim that goes on with the last utterance is part of it.
    const growing = scanDictation(listing(["fix the login", true], ["how are", true], ["how are you", false]));
    expect(growing.starts).toEqual([0, 3]);
    expect(growing.tail).toBe("extends");
    expect(growing.live).toEqual(["how", "are", "you"]);
    expect(growing.interim).toBe("you");
    // The first utterance, nothing final yet.
    expect(scanDictation(listing(["fix the", false]))).toMatchObject({ starts: [], tail: "new", live: ["fix", "the"] });
  });

  it("is advanceDictation, event for event, with every rule off", () => {
    const events: [string, boolean][][] = [
      [["fix the login", true]],
      [["fix the login", true], ["how are", true]],
      [["fix the login", true], ["how are", true], ["how are you", true]],
      [["fix the login", true], ["how are", true], ["how are you", true], ["How are you today", true], ["and", false]],
      // a result list that starts over after a pause
      [["add a test", true]],
      [["add a test", true], ["please", false]],
    ];
    const session = new Session({ holdBack: false });
    let old = DICTATION_START;
    for (const event of events) {
      const step = advanceDictation(old, scanDictation(listing(...event)).heard);
      old = step.progress;
      expect(session.hear(...event), JSON.stringify(event)).toBe(step.insert);
      expect(session.progress.inserted).toBe(old.inserted);
    }
  });

  describe("the Tabby gate", () => {
    it("drops talk that does not start with the start word, and the start word itself", () => {
      const session = new Session({ gate: true });
      session.hear(["so I was thinking", true]);
      expect(session.draft).toBe("");
      expect(session.preview).toBe("");
      session.hear(["so I was thinking", true], [`${T} and add a test`, true]);
      expect(session.draft).toBe("and add a test");
      expect(session.preview).toBe("and add a test");
    });

    it("types a growing utterance a few words at a time, without the start word", () => {
      const session = new Session({ gate: true });
      session.hear([T, true]);
      session.hear([T, true], [`${T} and`, true]);
      session.hear([T, true], [`${T} and`, true], [`${T} and add`, true]);
      session.hear([`${T} and add a test`, true]);
      expect(session.typed).toEqual(["and", "add", "a test"]);
    });

    it("judges an utterance once, by its first words, however it grows", () => {
      const dropped = new Session({ gate: true });
      dropped.hear(["so I", true]);
      dropped.hear(["so I", true], [`so I said ${T} add a test`, true]);
      dropped.settle();
      expect(dropped.draft).toBe("");

      const kept = new Session({ gate: true });
      kept.hear([`${T} fix the login`, true]);
      // Later growth is the same utterance: judged as its first part was.
      kept.hear([`${T} fix the login and the ${T} page`, true]);
      expect(kept.draft).toBe(`fix the login and the ${T} page`);
    });

    it("waits on a single word that cannot tell yet, then drops it when the utterance settles", () => {
      const session = new Session({ gate: true });
      session.hear(["so", true]);
      expect(session.draft).toBe("");
      session.settle();
      expect(session.draft).toBe("");
      // A second utterance is judged by itself.
      session.hear(["so", true], [`${T} add a test`, true]);
      expect(session.draft).toBe("add a test");
    });

    it("hears the start word run together from two words", () => {
      const session = new Session({ gate: true });
      session.hear(["Tab bi add a test", true]);
      expect(session.draft).toBe("add a test");
    });

    it("lets the next utterance through after the start word alone, once it settled", () => {
      const session = new Session({ gate: true });
      session.hear([T, true]);
      expect(session.bare).toBe(0);
      session.settle();
      expect(session.bare).toBe(1);
      expect(session.draft).toBe("");
      // The next utterance counts as the prompt (the host passes the open window).
      const open = new Session({ gate: true, open: true });
      open.hear(["add a test", true]);
      expect(open.draft).toBe("add a test");
      const stepOpen = stepUtterances(UTTERANCES_START, DICTATION_START, scanDictation(listing(["add a test", true])), startLexicon("en"), { gate: true, holdBack: true, open: true });
      expect(stepOpen.opened).toBe(true);
      // Without it the same talk is dropped.
      const closed = new Session({ gate: true });
      closed.hear(["add a test", true]);
      expect(closed.draft).toBe("");
    });

    it("announces the bare start word once, not again as the utterance is re-read", () => {
      const session = new Session({ gate: true });
      session.hear([T, true]);
      session.settle();
      session.hear([T, true]);
      session.settle();
      expect(session.bare).toBe(1);
    });

    it("tells two utterances apart when they come back to back", () => {
      const session = new Session({ gate: true });
      session.hear(["fix the login", true], [`${T} add a test`, true]);
      expect(session.draft).toBe("add a test");
      session.hear(["fix the login", true], [`${T} add a test`, true], ["and then talk", true]);
      expect(session.draft).toBe("add a test");
    });

    it("ends the utterance at a recognizer restart, and the next list starts clean", () => {
      const session = new Session({ gate: true });
      session.hear([`${T} fix the login`, true]);
      session.restart();
      session.hear(["with no start word", true]);
      expect(session.draft).toBe("fix the login");
      session.hear(["with no start word", true], [`${T} and a test`, true]);
      expect(session.draft).toBe("fix the login and a test");
    });

    it("takes a result list that starts over after a pause as a new utterance, gate on", () => {
      const session = new Session({ gate: true });
      session.hear([`${T} fix the login`, true]);
      session.hear(["something else entirely", true]);
      expect(session.draft).toBe("fix the login");
      session.hear([`${T} add a test`, true]);
      expect(session.draft).toBe("fix the login add a test");
    });

    it("does not preview talk it is dropping, nor a start word", () => {
      const session = new Session({ gate: true });
      session.hear(["so what about", true], ["the weather", false]);
      expect(session.preview).toBe("");
      session.hear([`${T} fix`, true], [`${T} fix the`, false]);
      expect(session.preview).toBe("fix the");
      session.hear([`${T} fix`, true], [`${T} fix the`, true], ["and the", false]);
      expect(session.preview).toBe("fix the");
    });
  });

  describe("holding back a possible command", () => {
    it("holds the start word, and it and the start of the navigate word, out of the draft", () => {
      const session = new Session();
      session.hear([T, true]);
      session.hear([T, true], [`${T} nav`, true]);
      expect(session.draft).toBe("");
      expect(session.preview).toBe(`${T} nav`);
    });

    it("hands a settled navigate utterance to the command, whole, and types none of it", () => {
      const session = new Session({ take: () => true });
      session.hear([T, true]);
      session.hear([T, true], [`${T} navigate`, true]);
      session.hear([`${T} navigate go to`, true]);
      session.hear([`${T} navigate go to project Alpha`, true]);
      expect(session.draft).toBe("");
      expect(session.offered).toEqual([]);
      session.settle();
      expect(session.offered).toEqual([`${T} navigate go to project Alpha`]);
      expect(session.draft).toBe("");
      // Re-read late (the recognizer finalizing it again): still not typed, not offered twice.
      session.hear([`${T} navigate go to project Alpha`, true]);
      session.settle();
      expect(session.offered).toHaveLength(1);
      expect(session.draft).toBe("");
    });

    it("types the held words as heard when no command took them, gate off", () => {
      const session = new Session();
      session.hear([T, true]);
      session.hear([`${T} navigate`, true]);
      expect(session.draft).toBe("");
      session.settle();
      expect(session.offered).toEqual([`${T} navigate`]);
      expect(session.draft).toBe(`${T} navigate`);
    });

    it("types the held words as soon as the next word shows it is dictation, gate off", () => {
      const session = new Session();
      session.hear([T, true]);
      expect(session.draft).toBe("");
      session.hear([`${T} write`, true]);
      expect(session.draft).toBe(`${T} write`);
      session.hear([`${T} write that`, true]);
      expect(session.draft).toBe(`${T} write that`);
      expect(session.offered).toEqual([]);
    });

    it("types the start word's following words without it when the gate is on", () => {
      const session = new Session({ gate: true });
      session.hear([T, true]);
      session.hear([`${T} write`, true]);
      expect(session.typed).toEqual(["write"]);
    });

    it("lets an ordinary utterance through at once", () => {
      const session = new Session();
      expect(session.hear(["fix the login", true])).toBe("fix the login");
    });

    it("holds nothing back with the rule off", () => {
      const session = new Session({ holdBack: false });
      expect(session.hear([T, true])).toBe(T);
    });

    it("settles the held utterance when a new one begins", () => {
      const session = new Session({ take: () => true });
      session.hear([`${T} navigate`, true]);
      session.hear([`${T} navigate`, true], ["go to", false]);
      expect(session.offered).toEqual([`${T} navigate`]);
      expect(session.draft).toBe("");
    });

    it("settles the held utterance of the old list when a new list starts, and gives it the new words", () => {
      const session = new Session({ take: () => true });
      session.hear([`${T} navigate`, true]);
      session.hear(["something unrelated now", true]);
      expect(session.offered).toEqual([`${T} navigate`]);
      expect(session.draft).toBe("something unrelated now");
    });
  });

  describe("navigation mode (capture)", () => {
    it("holds every utterance until it settles, offers it, and types none of it", () => {
      const session = new Session({ capture: true, take: () => true });
      session.hear(["go to", true]);
      expect(session.preview).toBe("go to");
      session.hear(["go to project alpha", true]);
      session.settle();
      expect(session.offered).toEqual(["go to project alpha"]);
      expect(session.draft).toBe("");
      session.hear(["go to project alpha", true], ["yes", true]);
      session.settle();
      expect(session.offered).toEqual(["go to project alpha", "yes"]);
    });

    it("types none of an utterance the command did not take either", () => {
      const session = new Session({ capture: true, take: () => false });
      session.hear(["blah blah", true]);
      session.settle();
      expect(session.offered).toEqual(["blah blah"]);
      expect(session.draft).toBe("");
    });
  });

  describe("two utterances finalized in one event", () => {
    it("judges the second by the mode the first left, not the one the event began in", () => {
      const mode = { open: false };
      const session = new Session({
        capture: () => mode.open,
        take: (text) => {
          if (text === `${T} navigate`) mode.open = true;
          return true;
        },
      });
      // Navigation mode was closed when the event began; its first utterance opens it.
      session.hear([`${T} navigate`, true], ["go to the done tab", true]);
      expect(session.draft).toBe("");
      session.settle();
      expect(session.offered).toEqual([`${T} navigate`, "go to the done tab"]);
      expect(session.draft).toBe("");
    });

    it("judges the second by the gate the first left", () => {
      const mode = { open: true, gate: false };
      const session = new Session({
        capture: () => mode.open,
        gate: () => mode.gate,
        take: (text) => {
          // A leave word: the mode ends and the gate turns on.
          if (text === "stop") { mode.open = false; mode.gate = true; }
          return true;
        },
      });
      session.hear(["stop", true], ["chatter that is not for the agent", true]);
      session.settle();
      // Dropped by the gate, not taken for a navigation command that is over.
      expect(session.offered).toEqual(["stop"]);
      expect(session.draft).toBe("");
    });
  });

  it("takes the start word in German too", () => {
    const session = new Session({ gate: true }, "de");
    session.hear(["ich überlege noch", true], [`${T} und füge einen Test hinzu`, true]);
    expect(session.draft).toBe("und füge einen Test hinzu");
    const navigate = new Session({ take: () => true }, "de");
    navigate.hear([`${T} navigiere`, true]);
    navigate.settle();
    expect(navigate.offered).toEqual([`${T} navigiere`]);
  });
});
