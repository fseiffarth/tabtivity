import { useCallback, useEffect, useRef, useState } from "react";
import { OPENCODE_MODEL_KEYS, isOpenCodeTab } from "../../mobile-web/src/terminal/openCodeMini";
import { sameSelectStep, type SelectPrompt, type SelectStep } from "../../mobile-web/src/terminal/selectPrompt";
import { modelPickKeys, readModelPicker } from "../lib/agents/readerLive";
import { submitScheduledAgentCommand } from "../lib/agents/scheduledAgentInput";
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
  const sawPicker = useRef(false);

  useEffect(() => {
    if (!picking) return;
    const read = () => {
      const term = terminalFor(ptyId);
      const next = term ? readModelPicker(term.buffer.active, agentLabel) : null;
      setPicker((previous) => (previous && next && sameSelectStep(previous, next) && previous.current === next.current ? previous : next));
    };
    read();
    const timer = setInterval(read, PICKER_POLL_MS);
    return () => clearInterval(timer);
  }, [picking, ptyId, agentLabel]);

  const finish = useCallback(() => {
    setPicking(false);
    setPicker(null);
    setAnswered(null);
  }, []);

  // The step on screen, unless it is the one just answered and the session
  // has not redrawn yet.
  const step = picker && answered && sameSelectStep(answered, picker) ? null : picker;
  useEffect(() => {
    if (!picking) return;
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
    const never = setTimeout(finish, PICKER_WAIT_MS);
    return () => clearTimeout(never);
  }, [picking, step, picker, answered, finish]);

  const open = (next: SessionPickerCommand = "/model") => {
    if (picking) return;
    setCommand(next);
    sawPicker.current = false;
    setAnswered(null);
    setPicker(null);
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
    setAnswered({ title: step.title, options: step.options });
    void typeKeys(modelPickKeys(step, option, agentLabel)).catch(() => setAnswered(null));
  };
  const close = () => {
    // The picker is the session's own: close it there too.
    if (picker) void typeKeys(["\u001b"]).catch(() => {});
    finish();
  };

  return {
    picking,
    command,
    picker,
    step,
    shownStep: step ?? (answered && picker ? answered : null),
    busy: !!answered || !step,
    open,
    choose,
    close,
  };
}
