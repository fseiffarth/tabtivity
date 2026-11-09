// The phone terminal's dictation: the composer's microphone, from the
// on-device check to the dictation session and its end.
// Their effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import { useEffect, useState, type Dispatch, type SetStateAction, type MutableRefObject, type RefObject } from "react";
import { type TabRow } from "../../api";
import { readFlag } from "../../prefs";
import { speechLanguage, speechTag } from "../../speechLang";
import { leadDraft } from "../../slashCommands";
import { loadDict } from "../../../../src/lib/i18n";
import { matchDraftEdit } from "../../../../src/lib/voice/voiceCommands";
import { DraftVoiceHistory, type DraftEditNote } from "../../../../src/lib/voice/draftEdit";
import {
  prepareOnDeviceSpeech, speechRecognitionConstructor, advanceDictation, DICTATION_START,
  dictationPreview, readDictation, type DictationProgress,
} from "../../voiceInput";
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

/** How long a spoken edit's note ("Removed …") stays on the voice line. */
const EDIT_NOTE_MS = 4_000;

/** Dictation into the composer: the on-device check, the dictation session, and
 * its end with the tab. */
export function useVoiceInput({
  tab, recognition, dictateButton, connectedRef, voiceRequest, voiceProgress, setDraft, draftRef,
  setListening, setPreparingVoice, preparingVoice, setVoicePreview, setVoiceStatus, setVoiceFailure,
  forgetDictation, submitSpokenRef, prefixCommands, handsFree,
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
  /** The Plan / Goal chips' commands this CLI offers ("Tabby plan"). */
  prefixCommands: readonly string[];
  handsFree: HandsFreeHooks;
}) {
  const { voiceOpen, voiceStopping } = handsFree;
  /** What voice did to the draft, for "Tabby scratch that" (`draftEdit.ts`). */
  const [edits] = useState(() => new DraftVoiceHistory());
  /** The user's stop also ends the hands-free loop until the mic is tapped
   * again. */
  const stopVoice = () => {
    handsFree.stopLoop();
    voiceStopping.current = true;
    recognition.current?.stop();
  };
  /** A tap while the on-device check runs takes the check back, so a browser
   * whose check hangs (or a long language download) never locks the button. */
  const cancelVoicePrep = () => {
    voiceRequest.current += 1;
    setPreparingVoice(false);
    setVoiceStatus(null);
  };
  const startVoice = async () => {
    if (!connectedRef.current || recognition.current || preparingVoice) return;
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setVoiceFailure({ key: "mobile.voice.unavailable" });
      return;
    }
    const request = voiceRequest.current + 1;
    voiceRequest.current = request;
    const language = speechTag();
    // Spoken edits are matched in the language spoken, not the screen's.
    const spokenIn = speechLanguage(language);
    void loadDict(spokenIn);
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
    voiceStopping.current = false;
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
    const session: DictationSession = startDictation(Recognition, { lang: language, local: mode === "local" }, {
      onStart: () => {
        setListening(true);
        listeningNote = { key: handsFree.on.current ? "mobile.voice.listeningHandsFree" : mode === "local" ? "mobile.voice.listeningLocal" : "mobile.voice.listeningRemote" };
        setVoiceStatus(listeningNote);
      },
      onResult: (event) => {
        const reading = readDictation(event);
        const step = advanceDictation(voiceProgress.current, reading.heard);
        voiceProgress.current = step.progress;
        // Hands-free: settled words go through the send guard first. A stop
        // word cancels its window and never reaches the draft; on a question
        // the agent waits on, "two" / "option two" picks that row.
        const guard = handsFree.on.current && !voiceStopping.current ? handsFree.guard() : undefined;
        // "Tabby scratch that", "Tabby replace X by Y", "Tabby plan" …: the
        // draft is edited, and the words never go into it (`draftEdit.ts`).
        const edit = step.insert ? matchDraftEdit(step.insert, spokenIn) : null;
        if (edit) {
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
            guard?.reset();
            if (submitSpokenRef.current(draftRef.current)) {
              draftRef.current = "";
              if (guard) handsFree.awaitTurn.current();
            }
          } else {
            // Hands-free: the pause before a send counts again from here; an
            // emptied draft sends nothing.
            guard?.settled(step.insert);
          }
          return;
        }
        if (step.insert && guard) {
          const picked = handsFree.pick.current(step.insert);
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
            guard.settled(picked === "staged" ? step.insert : "");
            forgetDictation();
            return;
          }
          voiceOpen.current = false;
          if (!guard.settled(step.insert)) {
            forgetDictation();
            if (reading.interim) {
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
        if (step.insert) {
          const current = draftRef.current;
          const next = `${current}${current && !current.endsWith(" ") ? " " : ""}${step.insert}`;
          const spoken = spokenSend(next);
          if (spoken === null) edits.piece(current, next, step.insert);
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
              if (guard) handsFree.awaitTurn.current();
            }
            return;
          }
        }
        if (guard && reading.interim) {
          voiceOpen.current = true;
          guard.speechStarted();
        } else if (guard && voiceOpen.current && !step.insert) {
          // What was being heard settled into nothing new (a re-read): the
          // window, or the pause, goes on.
          voiceOpen.current = false;
          guard.settled("");
        }
        setVoicePreview(dictationPreview(step.progress, reading.interim));
      },
      // A new recognizer's result list starts empty: everything the last one
      // heard is in the draft already, and none of it is read back. Words it
      // had not settled are gone, so hands-free counts its pause from here.
      onRestart: () => {
        voiceProgress.current = DICTATION_START;
        if (voiceOpen.current && handsFree.on.current) {
          voiceOpen.current = false;
          handsFree.guard().settled("");
        }
      },
      onError: (message) => setVoiceFailure({ key: message }),
      onLevel: (level) => paintMicLevel(dictateButton.current, level),
      onEnd: () => {
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
