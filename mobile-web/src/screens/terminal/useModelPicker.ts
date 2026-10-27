// The phone terminal's model sheet: reading the agent's own `/model` picker
// off the screen, and answering it with the keys the session reads.
// Their effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import {
  useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type MutableRefObject,
} from "react";
import { getModelRows, rememberModelRows, type TabRow } from "../../api";
import { type ReadableLine } from "../../terminal/readableScreen";
import {
  mergeSelectRows, readSelectPrompt, revealSelectRow, sameSelectStep, selectKeys, selectMoveKeys,
  type SelectPrompt, type SelectStep,
} from "../../terminal/selectPrompt";
import { liveModelPick, modelRowsOf, modelRowsStep, sameModelRows } from "../../terminal/modelRows";
import {
  openCodeDialogCloseKeys, openCodePickKeys, OpenCodePickerWalk, readOpenCodePickerPage,
  OPENCODE_MODEL_KEYS,
} from "../../terminal/openCodeMini";
import {
  antigravityEffortKeys, readAntigravityEffort, readAntigravityPicker, type AntigravityEffort,
} from "../../terminal/antigravity";
import { readCursorPicker } from "../../terminal/cursorAgent";
import { MODEL_PICKER_WAIT } from "./terminalShared";

/** How long a model list stays unchanged before it is kept for the next
 * opening (`rememberModelRows`): a frame split across reads is not the list. */
const MODEL_KEEP_SETTLE = 500;

/** How long the sheet waits, after a tap, for the step *after* the one it
 * answered: Codex follows the model list with a reasoning-level list, and that
 * one is drawn only once the session has read the Enter. Past it the dialog is
 * done and the sheet steps aside. */
const SELECT_NEXT_WAIT = 700;

/** The model sheet's reading of the picker on screen: OpenCode's walk, the rows
 * put together, and the reveal walk. */
export function useModelPicker({
  write, viewportRows, liveScreen, modelSheet, setModelSheet, answered, setAnswered, knownStep,
  setKnownStep, rememberedStep, setReveal, reveal, revealStuck, effortFor, effortStep, sawPicker,
  clearPending, deliver, agentLabel, openCode, antigravity, cursorAgent,
}: {
  write: MutableRefObject<(value: string, prompt?: number) => boolean>;
  viewportRows: MutableRefObject<() => string[]>;
  liveScreen: ReadableLine[];
  modelSheet: boolean;
  setModelSheet: Dispatch<SetStateAction<boolean>>;
  answered: SelectStep | null;
  setAnswered: Dispatch<SetStateAction<SelectStep | null>>;
  knownStep: SelectStep | null;
  setKnownStep: Dispatch<SetStateAction<SelectStep | null>>;
  rememberedStep: SelectStep | null;
  setReveal: Dispatch<SetStateAction<{ origin: number; target: number; } | null>>;
  reveal: { origin: number; target: number; } | null;
  revealStuck: MutableRefObject<boolean>;
  effortFor: { number: number; label: string; } | null;
  effortStep: string | null;
  sawPicker: MutableRefObject<boolean>;
  clearPending: () => void;
  deliver: (writes: string[], prompt?: number) => boolean;
  agentLabel: string;
  openCode: boolean;
  antigravity: boolean;
  cursorAgent: boolean;
}) {
  /** The picker the model chip opened, read off the screen while the sheet is
   * up — a list of the session's own rows, not a list of models Tabtivity
   * believes in. None of OpenCode's, Antigravity's or Cursor's is the numbered
   * dialog the others draw, so each is read by its own shape (`openCodeMini`,
   * `antigravity`, `cursorAgent`). */
  const openCodePage = useMemo(
    () => (modelSheet && openCode ? readOpenCodePickerPage(liveScreen) : null),
    [modelSheet, openCode, liveScreen],
  );
  /** OpenCode's list is a scroll box that draws a slice of itself: the walk
   * scrolls it with ↓ and lists the slices put together. Fed every frame;
   * `walked` re-reads it when it ends without one. */
  const deliverNow = useRef(deliver);
  deliverNow.current = deliver;
  const [walked, setWalked] = useState(0);
  const openCodeWalk = useRef<OpenCodePickerWalk | null>(null);
  if (!openCodeWalk.current) {
    openCodeWalk.current = new OpenCodePickerWalk(
      (keys) => { deliverNow.current(keys); },
      () => setWalked((count) => count + 1),
    );
  }
  useEffect(() => () => openCodeWalk.current?.reset(), []);
  const [walkedPicker, setWalkedPicker] = useState<SelectPrompt | null>(null);
  useEffect(() => {
    const walk = openCodeWalk.current;
    if (!walk) return;
    if (!modelSheet || !openCode) {
      walk.reset();
      setWalkedPicker(null);
      return;
    }
    walk.read(openCodePage);
    setWalkedPicker(walk.prompt());
  }, [modelSheet, openCode, openCodePage, walked]);
  const picker = useMemo(
    () => {
      if (!modelSheet) return null;
      if (openCode) return walkedPicker;
      if (antigravity) return readAntigravityPicker(liveScreen);
      if (cursorAgent) return readCursorPicker(liveScreen);
      return readSelectPrompt(liveScreen, agentLabel);
    },
    [modelSheet, openCode, walkedPicker, antigravity, cursorAgent, liveScreen, agentLabel],
  );
  /** The step the sheet is showing: the picker on screen, unless it is the one
   * a tap just answered and the session has not redrawn yet. */
  const pickerStep = picker && answered && sameSelectStep(answered, picker) ? null : picker;
  /** The step as far as it is known: the rows on screen plus those an earlier
   * slice of the same picker drew. OpenCode's slices are put together by its
   * own walk (`openCodeWalk`), which already is the whole list. */
  const listedStep = useMemo<SelectStep | null>(
    () => (!pickerStep ? null : openCode ? pickerStep : mergeSelectRows(knownStep, pickerStep)),
    [pickerStep, openCode, knownStep],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (listedStep && !openCode) setKnownStep(listedStep); }, [listedStep, openCode]);
  /** The remembered rows, listed until the session draws its picker — for
   * OpenCode until its walk has listed the whole of it. */
  const modelPreview = modelSheet && !answered && !effortFor && !effortStep && (!listedStep || (openCode && !!picker?.hidden))
    ? rememberedStep
    : null;
  /** The printed number of the row the dialog highlights right now. */
  const pickerAt = pickerStep?.options[pickerStep.current]?.number;
  /** The effort stops Antigravity's dialog is offering right now — the ones
   * belonging to the model its highlight is on, which is why they are read
   * again after every walk rather than kept with the row. */
  const effortSlider = useMemo<AntigravityEffort | null>(
    () => (modelSheet && antigravity ? readAntigravityEffort(liveScreen) : null),
    [modelSheet, antigravity, liveScreen],
  );
  useEffect(() => {
    if (!modelSheet) return;
    if (pickerStep) {
      sawPicker.current = true;
      // A step is up, so nothing is left to hold for: a dialog that comes back
      // to a list already answered (Codex's "More reasoning…" has an esc back)
      // is a step again, not the stale paint of the answer.
      if (answered) setAnswered(null);
      return;
    }
    // The answered list, still on screen: the session has not read the Enter
    // yet. Hold — the next step, if there is one, replaces it in place. If the
    // session never moves off it, the answer did not land: give the list back
    // rather than hold a sheet the tap can no longer leave.
    if (answered && picker) {
      const stuck = window.setTimeout(() => setAnswered(null), MODEL_PICKER_WAIT);
      return () => window.clearTimeout(stuck);
    }
    if (sawPicker.current) {
      // Gone after it was listed: answered here, on the desktop, or dismissed.
      // After a tap the gap is given to the step that may still follow.
      if (!answered) {
        // A reveal walk's keys still queued would land in the composer the
        // picker gave back, where ↑ recalls old prompts from history.
        clearPending();
        setReveal(null);
        setModelSheet(false);
        return;
      }
      const next = window.setTimeout(() => {
        setModelSheet(false);
        setAnswered(null);
      }, SELECT_NEXT_WAIT);
      return () => window.clearTimeout(next);
    }
    // Never drawn: the session may have no `/model` picker at all. Step out of
    // the way rather than hold an empty sheet over its output. OpenCode's was
    // opened by the chip's own keys, and one this could not read is still up
    // in the session, where the next message would land in it: closed there.
    const timer = window.setTimeout(() => {
      if (openCode) openCodeDialogCloseKeys(viewportRows.current()).forEach((key) => write.current(key));
      setModelSheet(false);
    }, MODEL_PICKER_WAIT);
    return () => window.clearTimeout(timer);
    // `clearPending` is a fresh closure every render; it only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSheet, picker, pickerStep, answered, openCode]);
  /** A windowed picker says how many rows it is not drawing: the highlight is
   * walked to each one it hides, which scrolls it into view, and back. Only
   * arrow keys — nothing is accepted — and only while nothing was tapped. */
  useEffect(() => {
    if (!modelSheet || openCode || answered || !pickerStep || !listedStep || pickerAt === undefined || revealStuck.current) return;
    if (reveal && pickerAt !== reveal.target) {
      // The keys have not landed yet. If they never do, stop walking.
      const stuck = window.setTimeout(() => {
        revealStuck.current = true;
        setReveal(null);
      }, MODEL_PICKER_WAIT);
      return () => window.clearTimeout(stuck);
    }
    const target = revealSelectRow(listedStep, pickerStep) ?? reveal?.origin;
    if (target === undefined || target === pickerAt) {
      if (reveal) setReveal(null);
      return;
    }
    if (!deliver(selectMoveKeys(pickerAt, target))) {
      setReveal(null);
      return;
    }
    setReveal({ origin: reveal?.origin ?? pickerAt, target });
    // `deliver` is a fresh closure every render; the walk runs on the frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSheet, openCode, answered, pickerStep, listedStep, pickerAt, reveal]);
  return { openCodeWalk, picker, pickerStep, listedStep, modelPreview, pickerAt, effortSlider };
}

/** Opens the model sheet and answers it: a tap, a held remembered row, Antigravity's effort. */
export function useModelPickerAnswers({
  tab, pickModel, bare, connected, liveScreen, modelSheet, setModelSheet, setAnswered, answered,
  setKnownStep, setRememberedStep, rememberedStep, setHeldPick, heldPick, sheetAnswered, keptStep,
  setReveal, reveal, revealStuck, effortFor, setEffortFor, setEffortStep, effortStep, sawPicker,
  clearPending, deliver, sendAgentText, openCode, antigravity, openCodeWalk, picker, pickerStep,
  listedStep, modelPreview, pickerAt, effortSlider,
}: {
  tab: TabRow;
  pickModel: boolean;
  bare: boolean;
  connected: boolean;
  liveScreen: ReadableLine[];
  modelSheet: boolean;
  setModelSheet: Dispatch<SetStateAction<boolean>>;
  setAnswered: Dispatch<SetStateAction<SelectStep | null>>;
  answered: SelectStep | null;
  setKnownStep: Dispatch<SetStateAction<SelectStep | null>>;
  setRememberedStep: Dispatch<SetStateAction<SelectStep | null>>;
  rememberedStep: SelectStep | null;
  setHeldPick: Dispatch<SetStateAction<string | null>>;
  heldPick: string | null;
  sheetAnswered: MutableRefObject<boolean>;
  keptStep: MutableRefObject<SelectStep | null>;
  setReveal: Dispatch<SetStateAction<{ origin: number; target: number; } | null>>;
  reveal: { origin: number; target: number; } | null;
  revealStuck: MutableRefObject<boolean>;
  effortFor: { number: number; label: string; } | null;
  setEffortFor: Dispatch<SetStateAction<{ number: number; label: string; } | null>>;
  setEffortStep: Dispatch<SetStateAction<string | null>>;
  effortStep: string | null;
  sawPicker: MutableRefObject<boolean>;
  clearPending: () => void;
  deliver: (writes: string[], prompt?: number) => boolean;
  sendAgentText: (text: string, prompt?: number) => boolean;
  openCode: boolean;
  antigravity: boolean;
  openCodeWalk: MutableRefObject<OpenCodePickerWalk | null>;
  picker: SelectPrompt | null;
  pickerStep: SelectPrompt | null;
  listedStep: SelectStep | null;
  modelPreview: SelectStep | null;
  pickerAt: number | undefined;
  effortSlider: AntigravityEffort | null;
}) {
  /** The highlight has reached the model an Antigravity tap chose, so the
   * dialog has redrawn its slider for *that* model: a model with stops asks
   * for one here, and a model with none — every Claude model it offers — is
   * accepted now, because there is nothing left to ask. Until the walk lands
   * the screen still shows the row it left, so nothing is pressed on a frame
   * that has not caught up; a walk whose keys never show gives the list back. */
  useEffect(() => {
    if (!effortFor) return;
    if (!pickerStep || pickerAt !== effortFor.number) {
      const stuck = window.setTimeout(() => setEffortFor(null), MODEL_PICKER_WAIT);
      return () => window.clearTimeout(stuck);
    }
    if (effortSlider && effortSlider.stops.length > 1) {
      setEffortStep(effortFor.label);
      setEffortFor(null);
      return;
    }
    if (deliver(["\r"]) && listedStep) setAnswered(listedStep);
    setEffortFor(null);
    // `deliver` is a fresh closure every render; the step runs on the frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effortFor, pickerStep, pickerAt, effortSlider, listedStep]);
  /** `/model` opens the agent's own picker in the session; the sheet lists the
   * rows it drew, and a tap answers it with the same keys the arrow row sends —
   * so nothing here decides what the models are.
   *
   * Neither OpenCode interface has a `/model`. In mini the words would be
   * submitted to the model as a prompt, a turn the reader never asked for; in
   * the full TUI the command is `/models`, so `/model` only opened the slash
   * completion and left it sitting in the composer. Both open the same picker
   * from the command palette, so the chip presses the keys that get there
   * (`OPENCODE_MODEL_KEYS`) instead of typing a command. */
  const selectModel = () => {
    if (modelSheet) return;
    sawPicker.current = false;
    revealStuck.current = false;
    sheetAnswered.current = false;
    keptStep.current = null;
    setAnswered(null);
    setKnownStep(null);
    setRememberedStep(null);
    setHeldPick(null);
    setReveal(null);
    setEffortFor(null);
    setEffortStep(null);
    if (openCode) {
      clearPending();
      if (!deliver(OPENCODE_MODEL_KEYS)) return;
    } else if (!sendAgentText("/model")) return;
    setModelSheet(true);
    // Refused for a tab whose CLI runs elsewhere: the sheet waits as before.
    getModelRows(tab.id).then((rows) => setRememberedStep((now) => now ?? modelRowsStep(rows)), () => {});
  };
  /** The card's model tap, answered once the socket is up and the session has
   * drawn its first frame: sent any earlier, `/model` lands before the agent's
   * prompt exists, and the sheet's own wait for the picker would run out on
   * the attach rather than on the agent. */
  const pickModelPending = useRef(pickModel && tab.kind === "agent" && !tab.local_model && !bare);
  useEffect(() => {
    if (!pickModelPending.current || !connected || liveScreen.length === 0) return;
    pickModelPending.current = false;
    selectModel();
  });
  /** Answers the step on screen. The sheet does not close on the tap: `/model`
   * is one step in Claude Code and two in Codex, which asks for a reasoning
   * level next, and which it is, is the session's answer to give — the sheet
   * lists whatever it draws next, and closes when it draws nothing.
   *
   * OpenCode's picker is answered by typing into its search field rather than
   * by walking a highlight this cannot see (`openCodePickKeys`); tapping one of
   * its group headings narrows the list, which the sheet reads as the next
   * step. */
  const answerModel = (key: string) => {
    // Mid-walk the highlight is not where the frame says; the sheet is busy.
    if (!pickerStep || !listedStep || reveal || effortFor) return;
    clearPending();
    const picked = listedStep.options.find((option) => option.number === Number(key));
    if (!picked) return;
    // Antigravity's dialog applies the model and its effort together, on one
    // Enter: the tap only walks the highlight there, and what happens next is
    // the effort the dialog then draws for it.
    if (antigravity) {
      if (pickerAt === undefined || !deliver(selectMoveKeys(pickerAt, picked.number))) return;
      sheetAnswered.current = true;
      setEffortFor({ number: picked.number, label: picked.label });
      return;
    }
    // No walk key may follow the answer's into the session.
    if (openCode) openCodeWalk.current?.hold();
    // Walked by printed number: a windowed picker's rows on screen are a slice.
    const writes = openCode
      ? picked.keys ?? openCodePickKeys(picked.label)
      : pickerAt === undefined ? [] : selectKeys(pickerAt, picked.number);
    if (writes.length === 0 || !deliver(writes)) return;
    sheetAnswered.current = true;
    setAnswered(listedStep);
  };
  /** A tap on the sheet: a remembered row is held for the live picker. */
  const chooseModel = (key: string) => {
    if (!modelPreview) {
      answerModel(key);
      return;
    }
    const row = modelPreview.options.find((option) => option.number === Number(key));
    if (row) setHeldPick(row.label);
  };
  const answerModelNow = useRef(answerModel);
  answerModelNow.current = answerModel;
  /** Whether the live list is all there: OpenCode's walk has listed it, or a
   * windowed picker's reveal walk has nothing left to show. */
  const listSettled = !!pickerStep && !!listedStep && !reveal && (openCode
    ? !picker?.hidden
    : revealStuck.current || revealSelectRow(listedStep, pickerStep) === undefined);
  // The opening's model list, kept for the next one once it is all there and
  // has stopped changing (a frame split across reads is not the list), and
  // only before anything was answered in it.
  useEffect(() => {
    if (!modelSheet || !listSettled || !listedStep || sheetAnswered.current || answered || effortFor || effortStep) return;
    const keep = window.setTimeout(() => {
      const kept = keptStep.current ?? rememberedStep;
      if (kept && sameModelRows(kept, listedStep)) return;
      keptStep.current = listedStep;
      rememberModelRows(tab.id, modelRowsOf(listedStep)).catch(() => {});
    }, MODEL_KEEP_SETTLE);
    return () => window.clearTimeout(keep);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSheet, listSettled, listedStep, answered, effortFor, effortStep, rememberedStep, tab.id]);
  // The held remembered row, answered in the live list by its label once the
  // walks are done (their keys must not follow the answer's), or dropped when
  // the whole list is in without it. OpenCode's search answer needs no walk.
  useEffect(() => {
    if (!heldPick || !pickerStep || !listedStep || reveal || effortFor) return;
    const index = liveModelPick(listedStep, { label: heldPick });
    if (!listSettled && !(openCode && index !== null)) return;
    setHeldPick(null);
    const row = listedStep.options.find((option) => option.index === index);
    if (row) answerModelNow.current(String(row.number));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldPick, pickerStep, listedStep, reveal, effortFor, listSettled, openCode]);
  /** Answers Antigravity's effort step: the slider is moved with the same
   * ←/→ its own keyboard row names, and the Enter that follows is the one
   * that applies the model and the effort at once. */
  const chooseEffort = (key: string) => {
    if (!effortSlider || !listedStep) return;
    clearPending();
    const target = Number(key);
    if (!effortSlider.stops[target]) return;
    if (!deliver([...antigravityEffortKeys(effortSlider.current, target), "\r"])) return;
    sheetAnswered.current = true;
    setAnswered(listedStep);
    setEffortStep(null);
  };
  return { selectModel, chooseModel, chooseEffort };
}
