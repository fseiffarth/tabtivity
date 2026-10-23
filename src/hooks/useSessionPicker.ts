import { useCallback, useEffect, useRef, useState } from "react";
import { OPENCODE_MODEL_KEYS, OpenCodePickerWalk, isOpenCodeTab, openCodeDialogCloseKeys } from "../../mobile-web/src/terminal/openCodeMini";
import { antigravityEffortKeys, isAntigravityTab, type AntigravityEffort } from "../../mobile-web/src/terminal/antigravity";
import { sameSelectStep, selectMoveKeys, type SelectPrompt, type SelectStep } from "../../mobile-web/src/terminal/selectPrompt";
import { bufferRows } from "../../mobile-web/src/terminal/subagentInput";
import { modelPickKeys, readAntigravitySlider, readModelPicker, readOpenCodeModelPage } from "../lib/agents/readerLive";
import { useT } from "../lib/i18n";
import { holdSessionPicker, submitScheduledAgentCommand } from "../lib/agents/scheduledAgentInput";
import { terminalFor } from "../lib/terminal/terminalRegistry";
import type { TabEntry } from "../stores/tabs";

/** How often the picker is read while it is open, how long a picker that is
 * never drawn (or an answer that never lands) is waited for, and how long an
 * answered step is given to draw the next one (Codex's reasoning level). */
const PICKER_POLL_MS = 150;
const PICKER_WAIT_MS = 6_000;
const NEXT_STEP_WAIT_MS = 700;

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
  /** The step to list: the one on screen, or the answered one still up. */
  shownStep: SelectStep | null;
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
    setAnswered(null);
    setPicker(null);
    setSlider(null);
    setEffortFor(null);
    const sent = isOpenCodeTab(agentLabel)
      ? typeKeys(OPENCODE_MODEL_KEYS)
      : tab.scheduleTargetId
        ? submitScheduledAgentCommand(tab.scheduleTargetId, next)
        : Promise.reject(new Error("no agent input"));
    setPicking(true);
    void sent.catch(finish);
  };
  const choose = (index: number) => {
    if (!step) return;
    const option = step.options.find((entry) => entry.index === index);
    if (!option) return;
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
  const close = () => {
    walk.current?.hold();
    // The picker is the session's own: close it there too.
    if (picker) void typeKeys(["\u001b"]).catch(() => {});
    else closeUnread();
    finish();
  };

  return {
    picking,
    command,
    picker,
    step,
    // The model list stays up while the highlight walks to a tapped model.
    shownStep: step ?? (effortFor && picker ? { title: picker.title, options: picker.options } : answered && picker ? answered : null),
    busy: !!answered || !step,
    listing: isOpenCodeTab(agentLabel) && !!step?.hidden,
    open,
    choose,
    close,
  };
}
