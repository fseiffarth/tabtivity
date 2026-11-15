// The phone terminal's dictation: the composer's microphone, from the
// on-device check to the dictation session and its end.
// Their effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import { useEffect, useRef, useState, type Dispatch, type SetStateAction, type MutableRefObject, type RefObject } from "react";
import { type TabRow } from "../../api";
import { readFlag } from "../../prefs";
import { speechLanguage, speechTag } from "../../speechLang";
import { leadDraft } from "../../slashCommands";
import { loadDict } from "../../../../src/lib/i18n";
import {
  prepareOnDeviceSpeech, speechRecognitionConstructor, advanceDictation, DICTATION_START,
  dictationPreview, dictationProvisional, scanDictation, scanSeen, settleUtterances, stepUtterances, UTTERANCES_START, UTTERANCE_SETTLE_MS,
  type DictationProgress, type DictationScan, type UtteranceLedger, type UtteranceOptions, type UtteranceStep,
} from "../../voiceInput";
import { startLexicon } from "../../startLexicon";
import { matchDraftEdit, matchNavigate, type SpokenDraftEdit } from "../../../../src/lib/voice/voiceCommands";
import { DraftVoiceHistory, type DraftEditNote } from "../../../../src/lib/voice/draftEdit";
import { type TabbyGate } from "./useTabbyGate";
import { startDictation, type DictationSession } from "../../voiceSession";
import { paintMicLevel, spokenSend, isStopWord } from "../../../../shared/voice";
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
  /** Whether words still being said may show in the composer as provisional
   * text: false while the words may be a spoken pick, a "stop" in the send
   * guard's window or a reading command. */
  previewOk: MutableRefObject<(words: string) => boolean>;
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
  /** The recognizer produced words while navigation mode was open (a command
   * begun, still being said): the mode's quiet timer starts over. */
  activity: MutableRefObject<() => void>;
}

/** What a mic start may say about the Tabby gate: `true` sets it (navigation,
 * a landing), `false` clears it (a tap, hands-free's reopen); left out, the
 * gate stays as it is. */
export interface StartVoiceOptions {
  gate?: boolean;
}

/** How long a spoken edit's note ("Removed …") stays on the voice line. */
const EDIT_NOTE_MS = 4_000;

/** Dictation into the composer: the on-device check, the dictation session, and
 * its end with the tab. */
export function useVoiceInput({
  tab, recognition, dictateButton, connectedRef, voiceRequest, voiceProgress, settleTimer, setDraft, draftRef,
  setListening, setPreparingVoice, preparingVoice, setVoicePreview, setVoiceInterim, setVoiceStatus, setVoiceFailure,
  forgetDictation, submitSpokenRef, tabbyGate, utterances, prefixCommands, handsFree,
}: {
  tab: TabRow;
  recognition: MutableRefObject<DictationSession | undefined>;
  dictateButton: RefObject<HTMLButtonElement>;
  connectedRef: MutableRefObject<boolean>;
  voiceRequest: MutableRefObject<number>;
  voiceProgress: MutableRefObject<DictationProgress>;
  /** The settle timer below; `endDictation` (`useComposer`) clears it too. */
  settleTimer: MutableRefObject<number>;
  setDraft: Dispatch<SetStateAction<string>>;
  draftRef: MutableRefObject<string>;
  setListening: Dispatch<SetStateAction<boolean>>;
  setPreparingVoice: Dispatch<SetStateAction<boolean>>;
  preparingVoice: boolean;
  /** Clears the "Heard:" line, and with it any provisional words. */
  setVoicePreview: Dispatch<SetStateAction<string>>;
  /** The words still being guessed at, shown after the draft in the field
   * (never in the draft): replaced by every reading, "" once none. */
  setVoiceInterim: (text: string) => void;
  setVoiceStatus: Dispatch<SetStateAction<VoiceNote | null>>;
  setVoiceFailure: Dispatch<SetStateAction<VoiceNote | null>>;
  forgetDictation: () => void;
  /** Sends the draft and leaves the mic open (`useComposer`). */
  submitSpokenRef: MutableRefObject<(text: string) => boolean>;
  /** The Tabby gate: on from a spoken send, hands-free only. */
  tabbyGate: TabbyGate;
  utterances: UtteranceHooks;
  /** The Plan / Goal chips' commands this CLI offers ("Tabby plan"). */
  prefixCommands: readonly string[];
  handsFree: HandsFreeHooks;
}) {
  const { voiceOpen, voiceStopping } = handsFree;
  /** What voice did to the draft, for "Tabby scratch that" (`draftEdit.ts`). */
  const [edits] = useState(() => new DraftVoiceHistory());
  /** The utterances of the recognizer's current result list (hands-free). */
  const ledger = useRef<UtteranceLedger>(UTTERANCES_START);
  /** The last reading's live words: a quiet that follows them is not an end. */
  const lastScan = useRef<DictationScan | undefined>(undefined);
  /** Settles the live utterance now: the pending words are released or handed
   * to a command. Set by the session; a stop calls it before the recognizer
   * finalizes what it holds. */
  const settleNow = useRef<() => void>(() => {});
  /** What the layer stood in when the user stopped the mic: words still in
   * flight (the recognizer finalizes them after the stop) are routed by it, not
   * by the gate the stop has just cleared. Null while the mic is not stopping. */
  const stopped = useRef<{ gate: boolean; capture: boolean; open: boolean } | null>(null);
  /** The user's stop also ends the hands-free loop until the mic is tapped
   * again. Call it before `nav.end()`: the mode the words were said in is read here. */
  const stopVoice = () => {
    settleNow.current();
    stopped.current = { gate: tabbyGate.on.current, capture: utterances.capture.current, open: tabbyGate.windowOpen() };
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
    // What a past mic was still guessing at is not this one's.
    lastScan.current = undefined;
    voiceStopping.current = false;
    stopped.current = null;
    if (options.gate !== undefined) tabbyGate.set(options.gate);
    setVoicePreview("");
    setVoiceFailure(null);
    // The session restarts the browser's recognizer through pauses, so
    // "listening" holds from the tap until the stop (`voiceSession.ts`).
    let listeningNote: VoiceNote | null = null;
    /** An edit's note on the voice line, until the listening line comes back. */
    const showEditNote = (note: DraftEditNote) => {
      const shown: VoiceNote = { key: note.key, params: note.params };
      setVoiceStatus(shown);
      window.setTimeout(() => setVoiceStatus((current) => (current === shown ? listeningNote : current)), EDIT_NOTE_MS);
    };
    /** Hands-free listens to utterances: the gate and the hold-back apply. */
    const layered = () => handsFree.on.current;
    const utteranceOptions = (flush: boolean): UtteranceOptions => {
      // After the user's stop the words still in flight are judged as the mic
      // was when it was stopped (the gate, the mode), never typed raw; and no
      // command opens anything on a mic that is closing.
      const after = voiceStopping.current ? stopped.current : null;
      return {
        // Asked as each utterance begins: a command taken from one utterance can
        // open navigation mode or set the gate for the next, in the same event.
        gate: () => (after ? after.gate : tabbyGate.on.current),
        holdBack: true,
        capture: () => (after ? after.capture : utterances.capture.current),
        // The prompt has begun, or the start word was just said alone: the next
        // utterance needs no start word.
        open: (after ? after.open : tabbyGate.windowOpen()) || draftRef.current.trim() !== "",
        flush,
        onWithheld: (text) => (after ? after.capture || matchNavigate(text, spokenIn) !== null || matchDraftEdit(text, spokenIn) !== null : dispatch(text)),
      };
    };
    /** A spoken send ("go on" last): it skips the hands-free window, so the
     * guard goes back to idle first; `beforeSubmit` runs between that reset and
     * the submit. Sent, the draft empties and hands-free waits for the turn. */
    const sendSpoken = (text: string, guard: SendGuard | undefined, beforeSubmit?: () => void) => {
      guard?.reset();
      beforeSubmit?.();
      if (submitSpokenRef.current(text)) {
        draftRef.current = "";
        if (guard) {
          handsFree.awaitTurn.current();
          // The mic is open for the next prompt: say so, and from here on
          // only an utterance that starts with the start word is dictated.
          tabbyGate.arm();
        }
      }
    };
    /** "Tabby scratch that", "Tabby replace X by Y", "Tabby plan" …: the draft is
     * edited, and the words never go into it (`draftEdit.ts`). */
    const applyEdit = (edit: SpokenDraftEdit, text: string) => {
      const guard = handsFree.on.current && !voiceStopping.current ? handsFree.guard() : undefined;
      voiceOpen.current = false;
      forgetDictation();
      const outcome = edits.apply(edit, draftRef.current, (draft, command) => leadDraft(draft, command, prefixCommands));
      if (outcome.draft !== null) {
        draftRef.current = outcome.draft;
        setDraft(outcome.draft);
      }
      showEditNote(outcome.note);
      if (edit.send && draftRef.current.trim()) {
        // "… go on" after the edit: sent as a spoken send is.
        sendSpoken(draftRef.current, guard);
      } else {
        // Hands-free: the pause before a send counts again from here; an
        // emptied draft sends nothing.
        guard?.settled(text);
      }
    };
    /** A held utterance has settled: the one ordered route it takes before it
     * can be dictation, first match wins.
     *   1. navigation mode, if open: a leave word ("stop", "cancel") ends it,
     *      any other utterance is a navigation command (`useVoiceNav`);
     *   2. "{assistant} navigate …" opens the mode (the same `take`);
     *   3. the spoken draft edits ("Tabby scratch that" …, `matchDraftEdit`):
     *      utterances that start with the start word, so one that may be
     *      an edit is held until it settles (`startLexicon.ts`);
     *   4. not claimed: the Tabby gate, then hands-free's guard and `pick`,
     *      then dictation — all in `consume`, below. */
    const dispatch = (text: string): boolean => {
      if (utterances.take.current(text)) return true;
      const edit = matchDraftEdit(text, spokenIn);
      if (!edit) return false;
      applyEdit(edit, text);
      return true;
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
      consume(step.insert, live?.interim ?? "", step.preview, step.held, step.provisional);
    };
    settleNow.current = () => settle();
    /** What the words of one reading do: the hands-free guard, a spoken send,
     * the draft, the "Heard:" line. */
    const consume = (insert: string, interim: string, preview: string, held: boolean, guess: string) => {
      // Navigation mode owns the mic: every word is a command (never typed),
      // and none of it may start the send guard's pause.
      if (utterances.capture.current) {
        utterances.activity.current();
        voiceOpen.current = false;
        handsFree.sendGuard.current?.reset();
        setVoicePreview("");
        return;
      }
      // Without hands-free, each event's new words are matched as one utterance
      // for a spoken edit (hands-free does it in `dispatch`, on whole ones).
      if (insert && !layered()) {
        const edit = matchDraftEdit(insert, spokenIn);
        if (edit) {
          applyEdit(edit, insert);
          return;
        }
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
        if (spoken === null) edits.piece(current, next, insert);
        draftRef.current = spoken ?? next;
        setDraft(spoken ?? next);
        if (spoken !== null) {
          // Deliberate: it skips the hands-free window. The mic stays open
          // for the next prompt; hands-free still holds the turn's answers
          // back so the mic never takes down the voice reading them. The
          // dictation is forgotten after the reset, before the submit.
          sendSpoken(spoken, guard, forgetDictation);
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
      // The live words go into the field as provisional text, replaced by the
      // next reading and committed by the final one (the draft takes them
      // above, as `insert`). Nothing a command may take is ever shown.
      setVoiceInterim(provisional(guess));
    };
    /** `guess` if it may show in the field now. */
    const provisional = (guess: string): string => {
      if (!guess || voiceStopping.current) return "";
      if (!layered()) return guess;
      return !isStopWord(guess) && handsFree.previewOk.current(guess) ? guess : "";
    };
    const session: DictationSession = startDictation(Recognition, { lang: language, local: mode === "local" }, {
      onStart: () => {
        setListening(true);
        listeningNote = { key: handsFree.on.current ? "mobile.voice.listeningHandsFree" : mode === "local" ? "mobile.voice.listeningLocal" : "mobile.voice.listeningRemote" };
        setVoiceStatus(listeningNote);
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
          consume(step.insert, scan.interim, step.preview, step.held, step.provisional);
          settleTimer.current = window.setTimeout(() => settle(), UTTERANCE_SETTLE_MS);
          return;
        }
        tabbyGate.clear();
        const step = advanceDictation(voiceProgress.current, scan.heard, scanSeen(scan));
        voiceProgress.current = step.progress;
        consume(step.insert, scan.interim, dictationPreview(step.progress, scan.interim), false, dictationProvisional(step.progress, scan, lexicon));
      },
      // A new recognizer's result list starts empty: everything the last one
      // heard is in the draft already, and none of it is read back. Words it
      // had not settled are gone, so hands-free counts its pause from here.
      onRestart: () => {
        // The utterance in flight ends here, whole.
        settle(true);
        // The guess was not finalized: it is not text.
        setVoiceInterim("");
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
        // The last words the recognizer finalized for a stop are still held.
        settle(true);
        setVoiceInterim("");
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
