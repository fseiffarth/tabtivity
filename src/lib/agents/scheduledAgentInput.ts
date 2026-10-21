import { agentInputWrites, bracketsAgentMessage } from "../../../shared/agentComposer";
import { writePtyInput } from "../terminal/terminalInput";

const ENCODER = new TextEncoder();
const WRITE_GAP_MS = 24;
/**
 * How long a prefix command is given before the next submission goes in, when
 * the caller supplies no settle of its own. A slash command owns a whole turn:
 * `/clear` empties the conversation, `/model` swaps the model, and typing the
 * prompt into a composer that is still redrawing loses it. `AgentScheduleHost`
 * passes a real output-settle waiter; this is only the floor for a caller
 * without one (and for tests).
 */
const PREFACE_GAP_MS = 400;

export interface ScheduledAgentInput {
  ptyId: string;
  ready: () => boolean;
  /** The pane is up and taking keystrokes, busy or not (`ready` also wants the
   *  agent quiet). Unset reads as `ready`. */
  started?: () => boolean;
  bracketedPaste: () => boolean;
  /** What launches the agent, for {@link bracketsAgentMessage}: the markers are
   *  per family, and Claude Code reads a pasted prompt as quoted content rather
   *  than as the question asked. Unset takes the pane's answer as it stands. */
  agent?: string;
  /** Stamps input AND counts one asked prompt — the message, never a prefix. */
  recordAuthorizedInput: () => void;
  /** Stamps input only. Used for prefix commands, which are not prompts: the
   *  usage recap counts what the user asked, and `/clear` is not a question. */
  noteInput?: () => void;
  /** Keys that close a dialog the CLI has up over its composer, typed before
   *  anything goes in — OpenCode's (`openCodeDialogCloseKeys`), which would
   *  otherwise take the words instead of the agent. Unset or empty: none. */
  dialogCloseKeys?: () => string[];
}

export interface SubmitOptions {
  /** Called at the message, after any prefix commands have settled. */
  beforeMessage?: () => void;
  /** Slash commands submitted one at a time, in order, before the message. */
  preface?: string[];
  /** Awaited between submissions instead of the fixed {@link PREFACE_GAP_MS}. */
  settle?: (ptyId: string) => Promise<void>;
  /** Go in while the agent works, as a prompt typed then would (the CLI queues
   *  it): only a pane that is not up yet refuses. */
  whileBusy?: boolean;
}

const inputs = new Map<string, ScheduledAgentInput>();

/** Targets whose CLI has a session picker (`/model`, `/permissions`) up over its
 * composer, counted: the Reader's facts row, steering's prompt box and the
 * markup model chip may each hold one for the same tab. */
const pickersOpen = new Map<string, number>();

/** Mark `scheduleTargetId`'s picker as up until the returned release is
 * called. While it is, the CLI's keyboard belongs to the picker: a prompt
 * typed then lands in the picker — a digit in it can even pick a model — and
 * is never seen by the agent, so the target takes no message (`ready` and
 * `started` read false, and a scheduled delivery waits rather than being
 * claimed and lost). */
export function holdSessionPicker(scheduleTargetId: string): () => void {
  pickersOpen.set(scheduleTargetId, (pickersOpen.get(scheduleTargetId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (pickersOpen.get(scheduleTargetId) ?? 1) - 1;
    if (left > 0) pickersOpen.set(scheduleTargetId, left);
    else pickersOpen.delete(scheduleTargetId);
  };
}

/** Whether a session picker is up in `scheduleTargetId`'s CLI ({@link holdSessionPicker}). */
export function sessionPickerOpen(scheduleTargetId: string): boolean {
  return pickersOpen.has(scheduleTargetId);
}

/** A message was refused because a session picker is up in the CLI. */
export class SessionPickerOpenError extends Error {
  constructor() {
    super("a model or mode list is open in the agent: choose from it or close it first");
    this.name = "SessionPickerOpenError";
  }
}

export function registerScheduledAgentInput(
  scheduleTargetId: string,
  registered: ScheduledAgentInput,
): () => void {
  // Readiness is the one gate every sender and scheduler asks first.
  const input: ScheduledAgentInput = {
    ...registered,
    ready: () => !sessionPickerOpen(scheduleTargetId) && registered.ready(),
    ...(registered.started ? { started: () => !sessionPickerOpen(scheduleTargetId) && registered.started!() } : {}),
  };
  inputs.set(scheduleTargetId, input);
  return () => {
    if (inputs.get(scheduleTargetId) === input) inputs.delete(scheduleTargetId);
  };
}

export function scheduledAgentInput(scheduleTargetId: string): ScheduledAgentInput | undefined {
  return inputs.get(scheduleTargetId);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gap(): Promise<void> {
  return wait(WRITE_GAP_MS);
}

/**
 * Safe composer replacement used after the occurrence has been claimed.
 *
 * The prefix commands are SEPARATE submissions, in order, then the message —
 * never extra lines of one message, because a CLI's `/clear` or `/model` takes
 * the whole line and would swallow the prompt appended to it. A prefix that
 * sanitized away upstream is skipped rather than submitted as a bare newline.
 */
export async function submitScheduledAgentMessage(
  scheduleTargetId: string,
  message: string,
  options: SubmitOptions = {},
): Promise<string> {
  const input = inputs.get(scheduleTargetId);
  if (input && sessionPickerOpen(scheduleTargetId)) throw new SessionPickerOpenError();
  const takesInput = options.whileBusy ? (input?.started ?? input?.ready) : input?.ready;
  if (!input || !takesInput?.()) throw new Error("agent terminal is not ready");
  const bracketed = bracketsAgentMessage(input.agent, input.bracketedPaste());
  const messageWrites = agentInputWrites(message, bracketed);
  if (messageWrites.length === 0) throw new Error("scheduled prompt is empty");
  const prefaceWrites = (options.preface ?? [])
    .map((command) => agentInputWrites(command, bracketed))
    .filter((writes) => writes.length > 0);

  const submissions = [...prefaceWrites, messageWrites];
  submissions[0] = [...(input.dialogCloseKeys?.() ?? []), ...submissions[0]];
  for (let submission = 0; submission < submissions.length; submission += 1) {
    // Only the message counts as a prompt asked; a prefix command still stamps
    // input, or the output it provokes would not read as this tab working.
    if (submission === submissions.length - 1) { options.beforeMessage?.(); input.recordAuthorizedInput(); }
    else input.noteInput?.();
    const writes = submissions[submission];
    for (let index = 0; index < writes.length; index += 1) {
      await writePtyInput(input.ptyId, ENCODER.encode(writes[index]));
      if (index + 1 < writes.length) await gap();
    }
    if (submission + 1 < submissions.length) {
      await (options.settle ? options.settle(input.ptyId) : wait(PREFACE_GAP_MS));
    }
  }
  return input.ptyId;
}

/**
 * One session command (`/resume <id>`, …) submitted on its own, the way a
 * prefix command goes in: it stamps input so its output reads as the tab
 * working, but is not counted as a prompt asked.
 */
export async function submitScheduledAgentCommand(scheduleTargetId: string, command: string): Promise<string> {
  const input = inputs.get(scheduleTargetId);
  if (!input || !input.ready()) throw new Error("agent terminal is not ready");
  const typed = agentInputWrites(command, bracketsAgentMessage(input.agent, input.bracketedPaste()));
  if (typed.length === 0) throw new Error("command is empty");
  const writes = [...(input.dialogCloseKeys?.() ?? []), ...typed];
  input.noteInput?.();
  for (let index = 0; index < writes.length; index += 1) {
    await writePtyInput(input.ptyId, ENCODER.encode(writes[index]));
    if (index + 1 < writes.length) await gap();
  }
  return input.ptyId;
}

/** Enter alone, for a submit the CLI dropped (`AgentScheduleHost`'s
 *  `confirmFreshSubmit`). False when the tab's input is gone. */
export async function pressScheduledAgentSubmit(scheduleTargetId: string): Promise<boolean> {
  const input = inputs.get(scheduleTargetId);
  if (!input) return false;
  await writePtyInput(input.ptyId, ENCODER.encode("\r"));
  return true;
}

export function _clearScheduledAgentInputsForTest(): void {
  inputs.clear();
  pickersOpen.clear();
}
