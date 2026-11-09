// The phone terminal's dictation: the composer's microphone, from the
// on-device check to the dictation session and its end.
// Their effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import { useEffect, useRef, type Dispatch, type SetStateAction, type MutableRefObject, type RefObject } from "react";
import { type TabRow } from "../../api";
import { readFlag } from "../../prefs";
import { speechLanguage, speechTag } from "../../speechLang";
import { loadDict } from "../../../../src/lib/i18n";
import {
  prepareOnDeviceSpeech, speechRecognitionConstructor, advanceDictation, DICTATION_START,
  dictationPreview, scanDictation, settleUtterances, stepUtterances, UTTERANCES_START, UTTERANCE_SETTLE_MS,
  type DictationProgress, type DictationScan, type UtteranceLedger, type UtteranceOptions, type UtteranceStep,
} from "../../voiceInput";
import { startLexicon } from "../../startLexicon";
import { type TabbyGate } from "./useTabbyGate";
import { startDictation, type DictationSession } from "../../voiceSession";
import { paintMicLevel, spokenSend } from "../../../../shared/voice";
import { type SendGuard } from "../../../../shared/handsFree";
import { type VoiceNote } from "./terminalShared";

/** What dictation needs of the hands-free loop (`useHandsFree`). */
export interface HandsFreeHooks {
  /** The loop is on. */
  on: MutableRefObject<boolean>;
  /** The send guard, made on first use. */
  guard: () => SendGuard;
  /** The live guard, if one was made: a stop resets it. */
  sendGuard: MutableRefObject<SendGuard | undefined>;
  /** Whether the recognizer holds words it has not settled yet. */
  voiceOpen: MutableRefObject<boolean>;
  /** The user stopped the mic: what it still settles is plain dictation. */
  voiceStopping: MutableRefObject<boolean>;
  /** What an utterance does to the question on screen: "staged" (it picks a
   * row; answered when the guard's window closes), "refused" (a dialog a voice
   * may not answer: the words are dropped), "done" (a reading command ran),
   * false (dictation). */
  pick: MutableRefObject<(utterance: string) => "done" | "staged" | "refused" | false>;
  /** A send went out: wait for its turn before listening again. */
  awaitTurn: MutableRefObject<() => void>;
  /** The user's stop ends the loop until the mic is tapped again. */
  stopLoop: () => void;
}

/** What the utterance layer hands on (navigation mode fills these; `dispatch`
 * below is the one ordered route a held utterance takes). */
export interface UtteranceHooks {
  /** Navigation mode is open: every utterance is a command, none is typed. */
  capture: MutableRefObject<boolean>;
  /** A held utterance settled, as one whole text. True when a command took it. */
  take: MutableRefObject<(utterance: string) => boolean>;
}

/** What a mic start may say about the Tabby gate: `true` sets it (navigation,
 * a landing), `false` clears it (a tap, hands-free's reopen); left out, the
 * gate stays as it is. */
export interface StartVoiceOptions {
  gate?: boolean;
}

/** Dictation into the composer: the on-device check, the dictation session, and
 * its end with the tab. */
export function useVoiceInput({
  tab, recognition, dictateButton, connectedRef, voiceRequest, voiceProgress, setDraft, draftRef,
  setListening, setPreparingVoice, preparingVoice, setVoicePreview, setVoiceStatus, setVoiceFailure,
  forgetDictation, submitSpokenRef, tabbyGate, utterances, handsFree,
}: {
  tab: TabRow;
  recognition: MutableRefObject<DictationSession | undefined>;
  dictateButton: RefObject<HTMLButtonElement>;
  connectedRef: MutableRefObject<boolean>;
  voiceRequest: MutableRefObject<number>;
  voiceProgress: MutableRefObject<DictationProgress>;
  setDraft: Dispatch<SetStateAction<string>>;
  draftRef: MutableRefObject<string>;
  setListening: Dispatch<SetStateAction<boolean>>;
  setPreparingVoice: Dispatch<SetStateAction<boolean>>;
  preparingVoice: boolean;
  setVoicePreview: Dispatch<SetStateAction<string>>;
  setVoiceStatus: Dispatch<SetStateAction<VoiceNote | null>>;
  setVoiceFailure: Dispatch<SetStateAction<VoiceNote | null>>;
  forgetDictation: () => void;
  /** Sends the draft and leaves the mic open (`useComposer`). */
  submitSpokenRef: MutableRefObject<(text: string) => boolean>;
  /** The Tabby gate: on from a spoken send, hands-free only. */
  tabbyGate: TabbyGate;
  utterances: UtteranceHooks;
  handsFree: HandsFreeHooks;
}) {
  const { voiceOpen, voiceStopping } = handsFree;
  /** The utterances of the recognizer's current result list (hands-free). */
  const ledger = useRef<UtteranceLedger>(UTTERANCES_START);
  const settleTimer = useRef(0);
  /** The last reading's live words: a quiet that follows them is not an end. */
  const lastScan = useRef<DictationScan | undefined>(undefined);
  /** Settles the live utterance now: the pending words are released or handed
   * to a command. Set by the session; a stop calls it before the recognizer
   * finalizes what it holds. */
  const settleNow = useRef<() => void>(() => {});
  /** The user's stop also ends the hands-free loop until the mic is tapped
   * again. */
  const stopVoice = () => {
    settleNow.current();
    tabbyGate.clear();
    handsFree.stopLoop();
    voiceStopping.current = true;
    recognition.current?.stop();
  };
  /** A tap while the on-device check runs takes the check back, so a browser
   * whose check hangs (or a long language download) never locks the button. */
  const cancelVoicePrep = () => {
    tabbyGate.clear();
    voiceRequest.current += 1;
    setPreparingVoice(false);
    setVoiceStatus(null);
  };
  const startVoice = async (options: StartVoiceOptions = {}) => {
    if (!connectedRef.current || recognition.current || preparingVoice) return;
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setVoiceFailure({ key: "mobile.voice.unavailable" });
      return;
    }
    const request = voiceRequest.current + 1;
    voiceRequest.current = request;
    const language = speechTag();
    // The utterance layer reads the start word in the language spoken, not the
    // screen's.
    const spokenIn = speechLanguage(language);
    void loadDict(spokenIn);
    const lexicon = startLexicon(spokenIn);
    setPreparingVoice(true);
    setVoiceStatus({ key: "mobile.voice.checking" });
    setVoiceFailure(null);
    // Read at the tap, like the language: the menu's choice applies to the
    // next dictation without this closure having to follow it.
    const mode = readFlag("voiceRemote") ? "remote" : await prepareOnDeviceSpeech(Recognition, language);
    if (voiceRequest.current !== request) return;
    setPreparingVoice(false);
    if (!connectedRef.current) {
      setVoiceStatus(null);
      setVoiceFailure({ key: "mobile.voice.disconnected" });
      return;
    }
    if (mode === "installed") {
      setVoiceStatus({ key: "mobile.voice.installed", language });
      return;
    }
    voiceProgress.current = DICTATION_START;
    ledger.current = UTTERANCES_START;
    voiceStopping.current = false;
    if (options.gate !== undefined) tabbyGate.set(options.gate);
    setVoicePreview("");
    setVoiceFailure(null);
    // The session restarts the browser's recognizer through pauses, so
    // "listening" holds from the tap until the stop (`voiceSession.ts`).
    /** Hands-free listens to utterances: the gate and the hold-back apply. */
    const layered = () => handsFree.on.current && !voiceStopping.current;
    const utteranceOptions = (flush: boolean): UtteranceOptions => ({
      gate: tabbyGate.on.current,
      holdBack: true,
      capture: utterances.capture.current,
      // The prompt has begun, or the start word was just said alone: the next
      // utterance needs no start word.
      open: tabbyGate.windowOpen() || draftRef.current.trim() !== "",
      flush,
      onWithheld: (text) => dispatch(text),
    });
    /** A held utterance has settled: the one ordered route it takes before it
     * can be dictation, first match wins.
     *   1. navigation mode, if open: a leave word ("stop", "cancel") ends it,
     *      any other utterance is a navigation command (`useVoiceNav`);
     *   2. "{assistant} navigate …" opens the mode (the same `take`);
     *   3. SLOT for the spoken draft edits ("Tabby scratch that" …,
     *      `matchDraftEdit`): they are utterances that start with the start
     *      word, so they must also be *held* until they settle — widen
     *      `StartLexicon.mayNavigate` (`startLexicon.ts`) to "any start-word
     *      utterance" and call the matcher here, after 1 and 2;
     *   4. not claimed: the Tabby gate, then hands-free's guard and `pick`,
     *      then dictation — all in `consume`, below. */
    const dispatch = (text: string): boolean => {
      if (utterances.take.current(text)) return true;
      // (3) the draft edits slot in here.
      return false;
    };
    /** What a step did to the layer's state and the gate. */
    const took = (step: UtteranceStep) => {
      voiceProgress.current = step.progress;
      ledger.current = step.ledger;
      if (step.opened) tabbyGate.windowUsed();
      if (step.bare) tabbyGate.listen();
    };
    /** The live utterance is whole: no result for a moment, a restart, a stop. */
    const settle = (ended = false) => {
      window.clearTimeout(settleTimer.current);
      if (!layered()) return;
      // Words the recognizer is still guessing at keep speech open, whatever
      // the quiet; at a restart they are gone.
      const live = ended ? undefined : lastScan.current;
      const step = settleUtterances(ledger.current, voiceProgress.current, lexicon, utteranceOptions(true), live);
      took(step);
      consume(step.insert, live?.interim ?? "", step.preview, step.held);
    };
    settleNow.current = () => settle();
    /** What the words of one reading do: the hands-free guard, a spoken send,
     * the draft, the "Heard:" line. */
    const consume = (insert: string, interim: string, preview: string, held: boolean) => {
      // Navigation mode owns the mic: every word is a command (never typed),
      // and none of it may start the send guard's pause.
      if (utterances.capture.current) {
        voiceOpen.current = false;
        handsFree.sendGuard.current?.reset();
        setVoicePreview("");
        return;
      }
      // Hands-free: settled words go through the send guard first. A stop
      // word cancels its window and never reaches the draft; on a question
      // the agent waits on, "two" / "option two" picks that row.
      const guard = handsFree.on.current && !voiceStopping.current ? handsFree.guard() : undefined;
      if (insert && guard) {
        const picked = handsFree.pick.current(insert);
        if (picked === "done") {
          guard.reset();
          voiceOpen.current = false;
          forgetDictation();
          return;
        }
        if (picked === "staged" || picked === "refused") {
          // A staged pick rides the guard: its pause, chime and cancel
          // window run now; a refused one is dropped, never typed.
          voiceOpen.current = false;
          guard.settled(picked === "staged" ? insert : "");
          forgetDictation();
          return;
        }
        voiceOpen.current = false;
        if (!guard.settled(insert)) {
          forgetDictation();
          if (interim) {
            voiceOpen.current = true;
            guard.speechStarted();
          }
          return;
        }
      }
      // Speech is inserted into the current prompt, not submitted: the user
      // reviews it and presses Send — or says "go on" / "los" last, which
      // leaves the draft and sends the rest (`spokenSend`). The ref, not
      // the state, is read and moved: two results can land in one render.
      if (insert) {
        const current = draftRef.current;
        const next = `${current}${current && !current.endsWith(" ") ? " " : ""}${insert}`;
        const spoken = spokenSend(next);
        draftRef.current = spoken ?? next;
        setDraft(spoken ?? next);
        if (spoken !== null) {
          // Deliberate: it skips the hands-free window. The mic stays open
          // for the next prompt; hands-free still holds the turn's answers
          // back so the mic never takes down the voice reading them.
          guard?.reset();
          forgetDictation();
          if (submitSpokenRef.current(spoken)) {
            draftRef.current = "";
            if (guard) {
              handsFree.awaitTurn.current();
              // The mic is open for the next prompt: say so, and from here on
              // only an utterance that starts with the start word is dictated.
              tabbyGate.arm();
            }
          }
          return;
        }
      }
      // Words held back may still turn out to be a command: speech is open.
      if (guard && (interim || held)) {
        voiceOpen.current = true;
        guard.speechStarted();
      } else if (guard && voiceOpen.current && !insert) {
        // What was being heard settled into nothing new (a re-read): the
        // window, or the pause, goes on.
        voiceOpen.current = false;
        guard.settled("");
      }
      setVoicePreview(preview);
    };
    const session: DictationSession = startDictation(Recognition, { lang: language, local: mode === "local" }, {
      onStart: () => {
        setListening(true);
        setVoiceStatus({ key: handsFree.on.current ? "mobile.voice.listeningHandsFree" : mode === "local" ? "mobile.voice.listeningLocal" : "mobile.voice.listeningRemote" });
      },
      onResult: (event) => {
        const scan = scanDictation(event);
        // Hands-free reads whole utterances (`voiceInput.ts`): the Tabby gate,
        // and words held back while they may be a command. Otherwise each
        // event's new words go straight in, as they always did.
        if (layered()) {
          window.clearTimeout(settleTimer.current);
          lastScan.current = scan;
          const step = stepUtterances(ledger.current, voiceProgress.current, scan, lexicon, utteranceOptions(false));
          took(step);
          consume(step.insert, scan.interim, step.preview, step.held);
          settleTimer.current = window.setTimeout(() => settle(), UTTERANCE_SETTLE_MS);
          return;
        }
        tabbyGate.clear();
        const step = advanceDictation(voiceProgress.current, scan.heard);
        voiceProgress.current = step.progress;
        consume(step.insert, scan.interim, dictationPreview(step.progress, scan.interim), false);
      },
      // A new recognizer's result list starts empty: everything the last one
      // heard is in the draft already, and none of it is read back. Words it
      // had not settled are gone, so hands-free counts its pause from here.
      onRestart: () => {
        // The utterance in flight ends here, whole.
        settle(true);
        lastScan.current = undefined;
        voiceProgress.current = DICTATION_START;
        ledger.current = UTTERANCES_START;
        if (voiceOpen.current && handsFree.on.current) {
          voiceOpen.current = false;
          handsFree.guard().settled("");
        }
      },
      onError: (message) => setVoiceFailure({ key: message }),
      onLevel: (level) => paintMicLevel(dictateButton.current, level),
      onEnd: () => {
        window.clearTimeout(settleTimer.current);
        settleNow.current = () => {};
        tabbyGate.clear();
        if (recognition.current === session) recognition.current = undefined;
        handsFree.sendGuard.current?.reset();
        voiceOpen.current = false;
        setListening(false);
        setVoiceStatus(null);
      },
    });
    recognition.current = session;
  };
  useEffect(() => () => {
    window.clearTimeout(settleTimer.current);
    ledger.current = UTTERANCES_START;
    voiceRequest.current += 1;
    const active = recognition.current;
    recognition.current = undefined;
    if (active) {
      active.abort();
      paintMicLevel(dictateButton.current, null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);
  return { stopVoice, cancelVoicePrep, startVoice };
}
