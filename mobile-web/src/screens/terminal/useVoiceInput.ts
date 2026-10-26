// The phone terminal's dictation: the composer's microphone, from the
// on-device check to the dictation session and its end.
// Their effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import { useEffect, type Dispatch, type SetStateAction, type MutableRefObject, type RefObject } from "react";
import { type TabRow } from "../../api";
import { readFlag } from "../../prefs";
import { speechTag } from "../../speechLang";
import {
  prepareOnDeviceSpeech, speechRecognitionConstructor, advanceDictation, DICTATION_START,
  dictationPreview, readDictation, type DictationProgress,
} from "../../voiceInput";
import { startDictation, type DictationSession } from "../../voiceSession";
import { paintMicLevel, spokenSend } from "../../../../shared/voice";
import { type VoiceNote } from "./terminalShared";

/** Dictation into the composer: the on-device check, the dictation session, and
 * its end with the tab. */
export function useVoiceInput({
  tab, recognition, dictateButton, connectedRef, voiceRequest, voiceProgress, setDraft, draftRef,
  setListening, setPreparingVoice, preparingVoice, setVoicePreview, setVoiceStatus, setVoiceFailure,
  forgetDictation, submitDraftRef,
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
  submitDraftRef: MutableRefObject<(text?: string, fromComposer?: boolean, interrupt?: boolean) => boolean>;
}) {
  const stopVoice = () => recognition.current?.stop();
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
    setVoicePreview("");
    setVoiceFailure(null);
    // The session restarts the browser's recognizer through pauses, so
    // "listening" holds from the tap until the stop (`voiceSession.ts`).
    const session: DictationSession = startDictation(Recognition, { lang: language, local: mode === "local" }, {
      onStart: () => {
        setListening(true);
        setVoiceStatus({ key: mode === "local" ? "mobile.voice.listeningLocal" : "mobile.voice.listeningRemote" });
      },
      onResult: (event) => {
        const reading = readDictation(event);
        const step = advanceDictation(voiceProgress.current, reading.heard);
        voiceProgress.current = step.progress;
        // Speech is inserted into the current prompt, not submitted: the user
        // reviews it and presses Send — or says "go on" / "los" last, which
        // leaves the draft and sends the rest (`spokenSend`). The ref, not
        // the state, is read and moved: two results can land in one render.
        if (step.insert) {
          const current = draftRef.current;
          const next = `${current}${current && !current.endsWith(" ") ? " " : ""}${step.insert}`;
          const spoken = spokenSend(next);
          draftRef.current = spoken ?? next;
          setDraft(spoken ?? next);
          if (spoken !== null) {
            forgetDictation();
            submitDraftRef.current(spoken);
            return;
          }
        }
        setVoicePreview(dictationPreview(step.progress, reading.interim));
      },
      // A new recognizer's result list starts empty: everything the last one
      // heard is in the draft already, and none of it is read back.
      onRestart: () => { voiceProgress.current = DICTATION_START; },
      onError: (message) => setVoiceFailure({ key: message }),
      onLevel: (level) => paintMicLevel(dictateButton.current, level),
      onEnd: () => {
        if (recognition.current === session) recognition.current = undefined;
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
