// The phone terminal's hands-free loop (docs/desktop_voice_plan.md step 5):
// a pause sends the dictation through the shared send guard, the turn's
// answers are read once it is over (not entry by entry), and the mic opens
// again after that. A whole utterance that is a reading command ("repeat",
// "back", "next answer", "faster", …, `matchReading`) moves the read-aloud
// cursor instead of being dictated.
// Its effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useT } from "../../../../src/lib/i18n";
import { type TabRow, type SessionTranscript } from "../../api";
import { readFlag } from "../../prefs";
import { speechLanguage, speechTag } from "../../speechLang";
import {
  currentSpeechId, hasReadPosition, holdReadingForTurn, readTurn, runReadingCommand, speak, stopSpeaking,
  subscribeSpeech,
} from "../../speechOutput";
import { matchReading } from "../../../../src/lib/voice/voiceCommands";
import { transcriptTurns } from "../../terminal/transcriptTurns";
import { type SelectOption, type SelectPrompt } from "../../terminal/selectPrompt";
import { type ReadableLine } from "../../terminal/readableScreen";
import { createPickStage, createSendGuard, type GuardPhase, type SendGuard, type VoicePick } from "../../../../shared/handsFree";
import { isStopWord } from "../../../../shared/voice";
import { playChime } from "../../../../src/lib/voice/chime";
import { HANDS_FREE_PAUSE_MS, TURN_SETTLE_MS, handsFreeTurnOver, questionSpeech, voicePick, voicePickable } from "../../handsFree";
import { type DictationSession } from "../../voiceSession";

/** Hands-free (`focusHandsFree`): the send guard the dictation feeds, the wait
 * for the turn a send started, and the question read out to be answered. */
export function useHandsFree({
  tab, t, sendGuard, voiceOpen, recognition, draftRef, submitDraftRef, startVoiceRef, endDictation,
  connected, listening, preparingVoice, readAloud, liveBusy, liveQuestion, questionHeld,
  questionSignature, questionAsk, answerQuestion, transcript,
}: {
  tab: TabRow;
  t: ReturnType<typeof useT>;
  sendGuard: MutableRefObject<SendGuard | undefined>;
  /** Whether the recognizer is hearing words not settled yet. */
  voiceOpen: MutableRefObject<boolean>;
  recognition: MutableRefObject<DictationSession | undefined>;
  draftRef: MutableRefObject<string>;
  submitDraftRef: MutableRefObject<(text?: string, fromComposer?: boolean, interrupt?: boolean) => boolean>;
  startVoiceRef: MutableRefObject<() => Promise<void>>;
  endDictation: () => void;
  connected: boolean;
  listening: boolean;
  preparingVoice: boolean;
  readAloud: boolean;
  liveBusy: boolean;
  liveQuestion: SelectPrompt | null;
  questionHeld: boolean;
  questionSignature: string;
  questionAsk: ReadableLine[];
  answerQuestion: (option: SelectOption) => void;
  transcript: SessionTranscript | null;
}) {
  const [handsFree, setHandsFree] = useState(() => readFlag("focusHandsFree"));
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;
  const [guardPhase, setGuardPhase] = useState<GuardPhase>("idle");
  /** A spoken pick of a row waits here for the guard's chime and cancel
   * window (gap 80); `pickHeard` is what the line shows meanwhile. */
  const staged = useRef(createPickStage<VoicePick>());
  const [pickHeard, setPickHeard] = useState("");
  /** Hands-free sent at this time and waits for the turn to end, to open the
   * mic again; `sawWork` once the agent was seen at work on it, `answer` the
   * newest answer's key at the send, `since` the answer its reading starts
   * after, `read` once its answers were read, `reading` for a wait on a
   * spoken reading command alone. */
  const [handsFreeWait, setHandsFreeWait] = useState<number | null>(null);
  const handsFreeTurn = useRef<{ sawWork: boolean; answer: string | null; since: string | null; read: boolean; reading: boolean }>({ sawWork: false, answer: null, since: null, read: false, reading: false });
  /** Whether read-aloud is saying something now (`speechOutput`). */
  const [speaking, setSpeaking] = useState(() => currentSpeechId() !== null);
  useEffect(() => subscribeSpeech(() => setSpeaking(currentSpeechId() !== null)), []);
  /** The newest answer in the stored session, by key: hands-free tells a
   * turn that ended too fast for its busy row by a new one. */
  const lastAnswerKey = useMemo(() => {
    const turns = transcript ? transcriptTurns(transcript.entries) : [];
    for (let index = turns.length - 1; index >= 0; index -= 1) if (turns[index].kind === "answer") return turns[index].key;
    return null;
  }, [transcript]);

  /** Hands-free sent: the mic opens again once the turn is over and its
   * answers were read. Read-aloud holds them until then. */
  const awaitTurn = () => {
    // A send while the last turn's answers are still held unread (dictated
    // over the wait) reads those too: they were held, never heard.
    const held = handsFreeWait !== null && !handsFreeTurn.current.read;
    const since = held ? handsFreeTurn.current.since : lastAnswerKey;
    handsFreeTurn.current = { sawWork: false, answer: lastAnswerKey, since, read: false, reading: false };
    holdReadingForTurn(tab.id, true);
    setHandsFreeWait(Date.now());
  };
  /** A reading command moved the voice: the mic opens again once it is quiet. */
  const awaitReading = () => {
    handsFreeTurn.current = { sawWork: false, answer: lastAnswerKey, since: lastAnswerKey, read: true, reading: true };
    setHandsFreeWait(Date.now());
  };
  /** The turn's answers, read once: at its end, or before a question it
   * ended on is read out. True when the voice is saying them. */
  const readTheTurn = () => {
    if (!readAloud || handsFreeTurn.current.read) return false;
    handsFreeTurn.current.read = true;
    return readTurn(tab.id, handsFreeTurn.current.since);
  };
  const awaitTurnRef = useRef(awaitTurn);
  awaitTurnRef.current = awaitTurn;
  /** The send guard (`shared/handsFree.ts`), made on first use: its pause
   * ends in the chime and the cancel window, the window in a send. */
  const handsFreeGuard = () => {
    if (!sendGuard.current) {
      const guard = createSendGuard(HANDS_FREE_PAUSE_MS, {
        hasDraft: () => staged.current.pending() !== null || draftRef.current.trim() !== "",
        onWindow: () => playChime(),
        onSend: () => {
          const pick = staged.current.take();
          if (pick) commitPickRef.current(pick);
          else if (submitDraftRef.current()) awaitTurnRef.current();
        },
        onCancel: () => staged.current.clear(),
        onPhase: (next) => {
          setGuardPhase(next);
          if (next === "idle") setPickHeard("");
        },
      });
      // Whatever resets the guard (a typed send, the mic's stop) drops a
      // staged pick with it.
      const reset = guard.reset;
      guard.reset = () => {
        staged.current.clear();
        reset();
      };
      const cancel = guard.cancel;
      guard.cancel = () => {
        staged.current.clear();
        cancel();
      };
      sendGuard.current = guard;
    }
    return sendGuard.current;
  };
  /** The window closed on a staged pick: it answers only the dialog it was
   * heard on, and only while that is still a question a voice may answer. */
  const commitPickRef = useRef<(pick: VoicePick) => void>(() => {});
  commitPickRef.current = (pick) => {
    if (!liveQuestion || questionHeld || questionSignature !== pick.key || !voicePickable(liveQuestion)) return;
    const option = liveQuestion.options.find((entry) => entry.index === pick.index);
    if (!option) return;
    answerQuestion(option);
    endDictation();
    awaitTurn();
  };
  /** A settled utterance that picks a row of a question on screen is staged —
   * "Heard: 2", the chime, the cancel window — and answers it as a tap would
   * only when the window closes; the mic then waits for the turn the answer
   * resumes. Voice never answers a dialog that is not positively a question
   * (`voicePickable`): "refused", the words are dropped. False when it picks
   * none — the words are dictation. "done": a reading command ran. */
  const voicePickRef = useRef<(utterance: string) => "done" | "staged" | "refused" | false>(() => false);
  voicePickRef.current = (utterance) => {
    // Any new utterance supersedes a staged pick; "stop" is the guard's.
    staged.current.heard();
    if (liveQuestion && !questionHeld) {
      if (!voicePickable(liveQuestion)) return isStopWord(utterance) ? false : "refused";
      const option = voicePick(utterance, liveQuestion);
      if (!option) return false;
      const heard = `${option.number}. ${option.label.trim()}`;
      staged.current.stage({ key: questionSignature, index: option.index, heard });
      setPickHeard(heard);
      return "staged";
    }
    // A reading command is a whole utterance before anything was dictated,
    // and only where something was read: otherwise "next" is a word to type.
    // "stop" stays the send guard's.
    if (draftRef.current.trim() !== "" || !hasReadPosition(tab.id)) return false;
    const command = matchReading(utterance, speechLanguage());
    if (!command || command === "stop" || !runReadingCommand(command, tab.id)) return false;
    endDictation();
    awaitReading();
    return "done";
  };
  /** The user's stop ends the loop until the mic is tapped again. */
  const stopLoop = () => {
    sendGuard.current?.reset();
    setHandsFreeWait(null);
  };
  /** The Focus menu's row. Switching on unlocks speech in the tap. */
  const toggleHandsFree = (unlock: () => void) => {
    if (handsFree) stopLoop();
    else unlock();
    setHandsFree(!handsFree);
    return !handsFree;
  };

  useEffect(() => () => {
    sendGuard.current?.reset();
    setHandsFreeWait(null);
    holdReadingForTurn(tab.id, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);
  // Read-aloud waits for the turn's end only while a turn is awaited. A wait
  // that ends before its answers were read (hands-free switched off, the link
  // lost, the mic's stop) reads them now: they were marked heard while held,
  // and before the hold each was read as it arrived. Not over dictation.
  const turnWaited = useRef(false);
  useEffect(() => {
    if (handsFreeWait !== null) {
      turnWaited.current = true;
      return;
    }
    holdReadingForTurn(tab.id, false);
    if (!turnWaited.current) return;
    turnWaited.current = false;
    if (!listening && !preparingVoice) readTheTurn();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsFreeWait, tab.id]);
  // Hands-free's turn: the agent seen at work on what was sent.
  useEffect(() => {
    if (handsFreeWait !== null && liveBusy) handsFreeTurn.current.sawWork = true;
  }, [handsFreeWait, liveBusy]);
  /** Bumped when the page comes back, so a turn that ended while it was
   * hidden opens the mic then: a hidden page cannot hold it. */
  const [pageShown, setPageShown] = useState(0);
  useEffect(() => {
    if (handsFreeWait === null) return;
    const shown = () => { if (!document.hidden) setPageShown((n) => n + 1); };
    document.addEventListener("visibilitychange", shown);
    return () => document.removeEventListener("visibilitychange", shown);
  }, [handsFreeWait]);
  // Once the turn is over and the answer has been read — at once with
  // read-aloud off — the mic opens again, after the busy row stayed off a
  // moment (`TURN_SETTLE_MS`). A spoken "go on" left the mic open: with
  // nothing to read the wait just ends; answers to read wait while words are
  // being dictated (the next send carries them), else the mic closes for
  // them and opens again after.
  useEffect(() => {
    if (handsFreeWait === null) return;
    if (!handsFree || !connected) {
      setHandsFreeWait(null);
      return;
    }
    const over = handsFreeTurnOver({
      reading: handsFreeTurn.current.reading,
      busy: liveBusy,
      sawWork: handsFreeTurn.current.sawWork,
      question: liveQuestion !== null && !questionHeld,
      answerAtSend: handsFreeTurn.current.answer,
      answerNow: lastAnswerKey,
    });
    if (!over || speaking || preparingVoice || document.hidden) return;
    if (listening && (!readAloud || handsFreeTurn.current.read)) {
      setHandsFreeWait(null);
      return;
    }
    const dictating = () => voiceOpen.current || guardPhase !== "idle" || draftRef.current.trim() !== "";
    if (listening && dictating()) return;
    const timer = window.setTimeout(() => {
      if (listening) {
        if (dictating()) return;
        endDictation();
      }
      // The answers first; the mic once they were said (this effect runs
      // again when the voice falls quiet).
      if (readTheTurn()) return;
      setHandsFreeWait(null);
      void startVoiceRef.current();
    }, TURN_SETTLE_MS);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsFreeWait, handsFree, connected, liveBusy, liveQuestion, questionHeld, lastAnswerKey, speaking, listening, preparingVoice, pageShown, readAloud, guardPhase]);
  /** Hands-free with read-aloud: a question the agent waits on is read out,
   * its rows by number, once per question, so it can be answered by voice. */
  const spokenQuestion = useRef("");
  useEffect(() => {
    if (!questionSignature) {
      spokenQuestion.current = "";
      return;
    }
    if (!handsFree || !readAloud || !liveQuestion || questionHeld || spokenQuestion.current === questionSignature || !voicePickable(liveQuestion)) return;
    spokenQuestion.current = questionSignature;
    const text = questionSpeech(questionAsk.map((line) => line.text), liveQuestion);
    if (!text) return;
    // What the turn said comes before the question it ended on.
    if (handsFreeWait !== null) readTheTurn();
    // The mic would hear it: it closes, and opens again once it was read.
    if (recognition.current) {
      endDictation();
      awaitTurn();
    }
    speak(`question:${questionSignature}`, text, speechTag());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionSignature, handsFree, readAloud, liveQuestion, questionHeld, questionAsk]);

  /** Hands-free's line where a tap does something: the cancel window (a tap
   * keeps the draft unsent), the answer being read (a tap stops the voice;
   * the agent goes on), or the wait for the turn to end. */
  const handsFreeLine = (voiceProblem: boolean): { text: string; run?: () => void } | null => (
    !handsFree || voiceProblem ? null
      : pickHeard && guardPhase === "pausing" ? { text: t("mobile.voice.handsFreePickHeard", { text: pickHeard }) }
      : pickHeard && (guardPhase === "window" || guardPhase === "holding") ? { text: t("mobile.voice.handsFreePickWindow", { text: pickHeard }), run: () => sendGuard.current?.cancel() }
      : guardPhase === "window" || guardPhase === "holding" ? { text: t("mobile.voice.handsFreeWindow"), run: () => sendGuard.current?.cancel() }
      : handsFreeWait !== null && speaking ? { text: t("mobile.voice.handsFreeSpeaking"), run: stopSpeaking }
      : handsFreeWait !== null && !listening && !preparingVoice ? { text: t("mobile.voice.handsFreeWaiting") }
      : null
  );

  return {
    handsFree, handsFreeRef, speaking, handsFreeGuard, awaitTurnRef, voicePickRef, stopLoop,
    toggleHandsFree, handsFreeLine,
  };
}
