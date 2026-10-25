import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OPENCODE_MODEL_KEYS, OpenCodePickerWalk, isOpenCodeTab, openCodeDialogCloseKeys } from "../../mobile-web/src/terminal/openCodeMini";
import { antigravityEffortKeys, isAntigravityTab, type AntigravityEffort } from "../../mobile-web/src/terminal/antigravity";
import { sameSelectStep, selectMoveKeys, type SelectPrompt, type SelectStep } from "../../mobile-web/src/terminal/selectPrompt";
import { bufferRows } from "../../mobile-web/src/terminal/subagentInput";
import { liveModelPick, modelRowsOf, modelRowsStep, sameModelRows, type ModelRows } from "../../mobile-web/src/terminal/modelRows";
import { modelPickKeys, readAntigravitySlider, readModelPicker, readOpenCodeModelPage } from "../lib/agents/readerLive";
import { useT } from "../lib/i18n";
import { holdSessionPicker, submitScheduledAgentCommand } from "../lib/agents/scheduledAgentInput";
import { terminalFor } from "../lib/terminal/terminalRegistry";
import { effectiveTabLocation, type TabEntry } from "../stores/tabs";

/** How often the picker is read while it is open, how long a picker that is
 * never drawn (or an answer that never lands) is waited for, and how long an
 * answered step is given to draw the next one (Codex's reasoning level). */
const PICKER_POLL_MS = 150;
const PICKER_WAIT_MS = 6_000;
const NEXT_STEP_WAIT_MS = 700;
/** How long a model list stays unchanged before it is kept for the next
 * opening: a frame split across reads is not the list. */
const KEEP_SETTLE_MS = 500;

/** The levels Claude Code's `/effort` takes (2.1.288); the session lowers one
 * its model does not support and says so. `auto` hands it back to the model. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max", "auto"] as const;

export type SessionPickerCommand = "/model" | "/permissions";

/** Whether `tab`'s model can be picked from its own `/model` list. Not on a
 * local-model tab: its model is the Ollama one it was launched on, and the
 * driver's list (OpenCode's providers, Claude's or Codex's cloud models) would
 * only offer to move the tab off it. */
export function modelPickOffered(tab: Pick<TabEntry, "kind">): boolean {
  return tab.kind !== "local_agent";
}

/** The effort slider as a list of its own, one row per stop. */
function sliderPrompt(slider: AntigravityEffort, title: string): SelectPrompt {
  return {
    options: slider.stops.map((stop, index) => ({ index, number: index + 1, label: stop.label, ...(stop.description ? { description: stop.description } : {}) })),
    current: slider.current,
    title,
    start: 0,
    question: 0,
    context: 0,
  };
}

function sameSlider(a: AntigravityEffort | null, b: AntigravityEffort | null): boolean {
  if (!a || !b) return a === b;
  return a.current === b.current && a.stops.length === b.stops.length
    && a.stops.every((stop, at) => stop.label === b.stops[at].label && stop.description === b.stops[at].description);
}

export interface SessionPicker {
  /** The command's picker was asked for and has not gone yet. */
  picking: boolean;
  command: SessionPickerCommand;
  /** The picker as the pane draws it right now. */
  picker: SelectPrompt | null;
  /** The step to answer — null while an answered one waits for its redraw. */
  step: SelectPrompt | null;
  /** The step to list: the one on screen, the answered one still up, or
   * until the picker is drawn the rows this CLI build's picker drew last
   * time (`remembered_model_rows`). */
  shownStep: SelectStep | null;
  /** `shownStep` is the remembered rows: a tap on one waits for the live
   * picker and is answered there by its label. */
  remembered: boolean;
  /** No answer can go in right now. */
  busy: boolean;
  /** OpenCode's list is still being scrolled through and put together. */
  listing: boolean;
  open: (command?: SessionPickerCommand) => void;
  choose: (index: number) => void;
  /** Close it here and, when it is up, in the session (its own Escape). */
  close: () => void;
}

/**
 * A session's own picker — `/model` (its effort the next step, outside
 * Claude), Codex's `/permissions` — opened in the pane and listed off its live
 * screen (`readModelPicker`), an option answered with the keys the session
 * takes (`modelPickKeys`). The Reader's facts row and steering's prompt box
 * both list it. Tabtivity picks nothing itself: each answer is the user's.
 *
 * A local tab's `/model` sheet lists the rows its CLI build's picker drew last
 * time at once (`services::model_rows`), and remembers the live ones once
 * they are drawn; a remembered row tapped before then is held and answered in
 * the live picker by its label, or dropped when the live picker lacks it.
 */
export function useSessionPicker({ tab, ptyId, agentLabel, typeKeys }: {
  tab: TabEntry;
  ptyId: string;
  agentLabel: string;
  typeKeys: (keys: string[]) => Promise<void>;
}): SessionPicker {
  const [picking, setPicking] = useState(false);
  const [command, setCommand] = useState<SessionPickerCommand>("/model");
  const [picker, setPicker] = useState<SelectPrompt | null>(null);
  const [answered, setAnswered] = useState<SelectStep | null>(null);
  const t = useT();
  /** Antigravity keeps the model and its effort on one dialog and draws the
   * slider only under the highlighted row. A model tap walks the highlight
   * there (`effortFor`, by the row's printed number) and nothing is accepted
   * until the slider the dialog then draws for it has been read and answered. */
  const antigravity = isAntigravityTab(agentLabel);
  const [slider, setSlider] = useState<AntigravityEffort | null>(null);
  const [effortFor, setEffortFor] = useState<{ number: number; label: string } | null>(null);
  const sawPicker = useRef(false);
  /** The rows remembered for this CLI build, while the picker is not drawn;
   * the one tapped among them; whether this opening has answered or kept a
   * live list yet (only an opening's first list is the model list — Codex's
   * next step is its reasoning levels). */
  const [rememberedStep, setRememberedStep] = useState<SelectStep | null>(null);
  const [heldPick, setHeldPick] = useState<string | null>(null);
  const answeredOnce = useRef(false);
  const rowsKept = useRef(false);
  const rememberRows = command === "/model" && !!tab.cmd && effectiveTabLocation(tab) === "local";
  const typeKeysNow = useRef(typeKeys);
  useEffect(() => { typeKeysNow.current = typeKeys; });
  /** OpenCode's list is a scroll box that shows a slice of itself: the walk
   * scrolls it and lists the slices put together (`OpenCodePickerWalk`). */
  const walk = useRef<OpenCodePickerWalk | null>(null);
  if (!walk.current) walk.current = new OpenCodePickerWalk((keys) => { void typeKeysNow.current(keys).catch(() => {}); });
  useEffect(() => () => walk.current?.reset(), []);

  // While the picker is up it owns the CLI's keyboard: no prompt may be typed
  // into the session (it would land in the picker and be lost).
  const scheduleTargetId = tab.scheduleTargetId;
  useEffect(() => {
    if (!picking || !scheduleTargetId) return;
    return holdSessionPicker(scheduleTargetId);
  }, [picking, scheduleTargetId]);

  useEffect(() => {
    if (!picking) return;
    const openCode = isOpenCodeTab(agentLabel);
    const read = () => {
      const term = terminalFor(ptyId);
      let next: SelectPrompt | null;
      if (openCode) {
        walk.current?.read(term ? readOpenCodeModelPage(term.buffer.active) : null);
        next = walk.current?.prompt() ?? null;
      } else {
        next = term ? readModelPicker(term.buffer.active, agentLabel) : null;
        if (antigravity) {
          const drawn = term && next ? readAntigravitySlider(term.buffer.active) : null;
          setSlider((previous) => (sameSlider(previous, drawn) ? previous : drawn));
        }
      }
      setPicker((previous) => (previous && next && sameSelectStep(previous, next)
        && previous.current === next.current
        && previous.options.length === next.options.length
        && previous.hidden === next.hidden ? previous : next));
    };
    read();
    const timer = setInterval(read, PICKER_POLL_MS);
    return () => {
      clearInterval(timer);
      walk.current?.reset();
    };
  }, [picking, ptyId, agentLabel, antigravity]);

  const finish = useCallback(() => {
    setPicking(false);
    setPicker(null);
    setAnswered(null);
    setSlider(null);
    setEffortFor(null);
    setRememberedStep(null);
    setHeldPick(null);
  }, []);
  /** OpenCode's picker is opened by keys, not a command: one this never read
   * is still up in the session, where the next prompt would land in it
   * (`openCodeDialogCloseKeys`). Closed there; nothing is sent without one. */
  const closeUnread = useCallback(() => {
    const term = terminalFor(ptyId);
    if (!term || !isOpenCodeTab(agentLabel)) return;
    const keys = openCodeDialogCloseKeys(bufferRows(term.buffer.active, term.rows));
    if (keys.length > 0) void typeKeysNow.current(keys).catch(() => {});
  }, [ptyId, agentLabel]);

  // The step on screen, unless it is the one just answered and the session
  // has not redrawn yet.
  const modelStep = picker && answered && sameSelectStep(answered, picker) ? null : picker;
  /** Whether the highlight has reached the model a tap chose, so the slider on
   * screen is that model's. */
  const landed = !!effortFor && !!picker && picker.options[picker.current]?.number === effortFor.number;
  const effortStep = effortFor && landed && slider && slider.stops.length > 1
    ? sliderPrompt(slider, t("mobile.model.effortTitle", { model: effortFor.label }))
    : null;
  const step = effortFor ? effortStep : modelStep;
  // The remembered rows stand in until the session draws its picker — for
  // OpenCode until its walk has listed the whole of it.
  const openCodeTab = isOpenCodeTab(agentLabel);
  const preview = picking && !answered && !effortFor && (!picker || (openCodeTab && !!step?.hidden)) ? rememberedStep : null;
  // A model with no slider (every Claude model Antigravity offers) is accepted
  // as soon as the walk lands: there is nothing left to ask.
  useEffect(() => {
    if (!picking || !effortFor || !landed || !picker || effortStep) return;
    setEffortFor(null);
    setAnswered({ title: picker.title, options: picker.options });
    void typeKeysNow.current(["\r"]).catch(() => setAnswered(null));
  }, [picking, effortFor, landed, picker, effortStep]);
  useEffect(() => {
    if (!picking) return;
    if (effortFor && picker && !step) {
      // The walk's keys have not landed: if they never do, give the list back.
      const stuck = setTimeout(() => setEffortFor(null), PICKER_WAIT_MS);
      return () => clearTimeout(stuck);
    }
    if (step) {
      sawPicker.current = true;
      if (answered) setAnswered(null);
      return;
    }
    // The answered list is still up: the keys have not landed. Give it back
    // if they never do.
    if (answered && picker) {
      const stuck = setTimeout(() => setAnswered(null), PICKER_WAIT_MS);
      return () => clearTimeout(stuck);
    }
    if (sawPicker.current) {
      // Gone: answered (a next step may still come), picked in the terminal,
      // or dismissed there.
      if (!answered) {
        finish();
        return;
      }
      const next = setTimeout(finish, NEXT_STEP_WAIT_MS);
      return () => clearTimeout(next);
    }
    // Never drawn: the session may have no picker, or was busy.
    const never = setTimeout(() => {
      closeUnread();
      finish();
    }, PICKER_WAIT_MS);
    return () => clearTimeout(never);
  }, [picking, step, picker, answered, effortFor, finish, closeUnread]);

  const open = (next: SessionPickerCommand = "/model") => {
    if (picking) return;
    setCommand(next);
    sawPicker.current = false;
    answeredOnce.current = false;
    rowsKept.current = false;
    setAnswered(null);
    setPicker(null);
    setSlider(null);
    setEffortFor(null);
    setRememberedStep(null);
    setHeldPick(null);
    if (next === "/model" && tab.cmd && effectiveTabLocation(tab) === "local") {
      void invoke<ModelRows | null>("remembered_model_rows", { agent: tab.cmd }).then(
        (rows) => setRememberedStep((now) => now ?? modelRowsStep(rows)),
        () => {},
      );
    }
    const sent = isOpenCodeTab(agentLabel)
      ? typeKeys(OPENCODE_MODEL_KEYS)
      : tab.scheduleTargetId
        ? submitScheduledAgentCommand(tab.scheduleTargetId, next)
        : Promise.reject(new Error("no agent input"));
    setPicking(true);
    void sent.catch(finish);
  };
  /** Answer row `index` of the live step. */
  const answerLive = (index: number) => {
    if (!step) return;
    const option = step.options.find((entry) => entry.index === index);
    if (!option) return;
    answeredOnce.current = true;
    if (antigravity && picker) {
      if (effortStep && slider) {
        // The slider's own ←/→, then the Enter that applies model and effort.
        setAnswered({ title: picker.title, options: picker.options });
        setEffortFor(null);
        void typeKeys([...antigravityEffortKeys(slider.current, index), "\r"]).catch(() => setAnswered(null));
        return;
      }
      // The tap only walks the highlight to the model; the effort it offers is
      // the next step.
      const at = picker.options[picker.current]?.number;
      if (at === undefined) return;
      setEffortFor({ number: option.number, label: option.label });
      const keys = selectMoveKeys(at, option.number);
      if (keys.length > 0) void typeKeys(keys).catch(() => setEffortFor(null));
      return;
    }
    // No walk key may follow the answer's into the session.
    walk.current?.hold();
    setAnswered({ title: step.title, options: step.options });
    void typeKeys(modelPickKeys(step, option, agentLabel)).catch(() => setAnswered(null));
  };
  const choose = (index: number) => {
    if (!preview) {
      answerLive(index);
      return;
    }
    // A remembered row: held until the live picker draws it.
    const row = preview.options.find((entry) => entry.index === index);
    if (row) setHeldPick(row.label);
  };
  const close = () => {
    walk.current?.hold();
    // The picker is the session's own: close it there too.
    if (picker) void typeKeys(["\u001b"]).catch(() => {});
    else closeUnread();
    finish();
  };

  // Keep the opening's model list for the next one once it has stopped
  // changing, and only before anything was answered in it (a held row answered
  // at once leaves the kept list as it was). OpenCode's is kept once its walk
  // has listed all of it.
  useEffect(() => {
    if (!picking || !rememberRows || !step || effortFor || answeredOnce.current || rowsKept.current) return;
    if (openCodeTab && step.hidden) return;
    const keep = setTimeout(() => {
      rowsKept.current = true;
      if (rememberedStep && sameModelRows(rememberedStep, step)) return;
      void invoke("remember_model_rows", { agent: tab.cmd, rows: modelRowsOf(step) }).catch(() => {});
    }, KEEP_SETTLE_MS);
    return () => clearTimeout(keep);
  }, [picking, rememberRows, step, effortFor, openCodeTab, rememberedStep, tab.cmd]);
  const answerNow = useRef(answerLive);
  answerNow.current = answerLive;
  // The live list is in: answer the remembered row held for it, by label —
  // or drop it once the whole list is in without it.
  useEffect(() => {
    if (!heldPick || !step) return;
    const index = liveModelPick(step, { label: heldPick });
    if (index === null && openCodeTab && step.hidden) return;
    setHeldPick(null);
    if (index !== null) answerNow.current(index);
  }, [heldPick, step, openCodeTab]);

  const liveShown = step ?? (effortFor && picker ? { title: picker.title, options: picker.options } : answered && picker ? answered : null);
  return {
    picking,
    command,
    picker,
    step,
    // The model list stays up while the highlight walks to a tapped model.
    shownStep: preview ?? liveShown,
    remembered: !!preview,
    busy: !!answered || !!heldPick || (!step && !preview),
    listing: openCodeTab && !!step?.hidden,
    open,
    choose,
    close,
  };
}
