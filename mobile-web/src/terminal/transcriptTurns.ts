import type { AskedQuestion, TabWorktree, TranscriptEntry } from "../api";

/**
 * One bubble of the stored-session chat: a prompt, or one message the agent
 * wrote. A bubble never changes once shown — the next thing the agent writes
 * is the next bubble — so each record is one bubble, never text appended to
 * the one before it.
 */
export interface TranscriptTurn {
  /** Stable across polls: the record's own time, not its position. The
   * desktop sends the newest N records and drops the oldest as new ones come,
   * so a position-based key re-keyed — and re-mounted — every bubble on every
   * new record, which is what made the chat jump while the agent worked. */
  key: string;
  kind: TranscriptEntry["kind"];
  text: string;
  /** Some of the text was bounded by the desktop. */
  cut: boolean;
  /** The record's index in `entries`, which is where the files sent after it are placed. */
  index: number;
  /** When it was said, for the bubble's time and the day chips
   * (`chatTimes`): the record's own stamp, or — on a prompt still pending —
   * when this phone sent it. Absent when neither is known. */
  stamp?: string;
  /** A prompt that is a slash command, drawn as a divider (`slashCommand`). */
  command: SlashCommand | null;
  /** On a subagent (`agent`): the handle that opens its conversation, absent
   * until its CLI has recorded where that lives, and its kind. */
  subagent?: string;
  role?: string;
  /** On a subagent: it has reported back, where its CLI records that. */
  finished?: boolean;
  /** On a subagent: not reported back yet, and sent to the background — read
   * with the session's own state by `subagentAtWork`. */
  running?: boolean;
  background?: boolean;
  /** On a subagent: a Claude `Workflow` run whose handle lists its agents. */
  workflow?: boolean;
  /** On a subagent: the linked worktree it works in, when not the project folder. */
  worktree?: TabWorktree;
  /** On an `answer`: the plan the agent put up for approval. */
  plan?: boolean;
  /** On an `answer`: the questions it asked, as answered. */
  questions?: readonly AskedQuestion[];
  /** On a `questions` turn: still waiting for the reply (Codex's async question). */
  asking?: boolean;
  /** A prompt sent from this phone the session has not recorded yet, by its
   * id; `failed` once the link lost it, `retrying` while a resend waits;
   * `held` while the desktop still holds it and its words can change;
   * `queued` until the desktop types it (the agent's work draws above it). */
  pending?: number;
  failed?: boolean;
  retrying?: boolean;
  held?: boolean;
  queued?: boolean;
}

/** A slash command split into its name and what follows it. */
export interface SlashCommand {
  name: string;
  args: string;
  /** What it left set, as the CLI confirmed it (`/model` → `Fable 5.2`):
   * the picker the bare command opens is where the choice was made. */
  setting?: string;
}

/** A prompt that is a slash command (`/clear`, `/model opus`, `/goal …`,
 * `/plugin:skill x`) — steering the CLI, not words to the agent — so the
 * Reader draws it as a divider across the chat rather than a bubble. The name
 * must end at a space or the end, so a prompt opening with a path
 * (`/home/me/x is broken`) stays a bubble. */
export function slashCommand(text: string): SlashCommand | null {
  const match = /^(\/[A-Za-z][\w-]*(?::[\w-]+)*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], args: match[2] ?? "" } : null;
}

/** A prompt as a pinned bubble reads it (`data-prompt`): a slash command as
 * its name and arguments, as its rule names it. */
export function pinnedPromptText(text: string): string {
  const command = slashCommand(text);
  return command ? (command.args ? `${command.name} ${command.args}` : command.name) : text;
}

/** The words on a command's divider: its name, a one-word argument beside
 * it (`commandArgsInline`), and what it left set (`/model → Fable 5.2`). */
export function commandLabel(command: SlashCommand): string {
  const typed = commandArgsInline(command.args) && command.args ? `${command.name} ${command.args}` : command.name;
  return command.setting ? `${typed} → ${command.setting}` : typed;
}

/** The words on a command's rule in both chats (desktop Reader and phone):
 * a setting by its name and value (`Model: Fable 5.2`, `Effort: high`),
 * anything else by its bare name (`clear`). `names` are the translated
 * "Model" and "Effort". */
export function readableCommandLabel(command: SlashCommand, names: { model: string; effort: string }): string {
  const name = command.name === "/model" || command.name === "/models" ? names.model
    : command.name === "/effort" ? names.effort : command.name.slice(1);
  const value = command.setting || (commandArgsInline(command.args) ? command.args : "");
  return value ? `${name}: ${value}` : name;
}

/** Whether a command's arguments ride on the divider beside its name: a
 * one-word setting does (`/model opus`, `/effort high`); anything with words
 * — the text of a `/goal` or `/plan` — is the reader's own message and reads
 * as a prompt bubble under it. */
export function commandArgsInline(args: string): boolean {
  return args.length <= 24 && !/\s/.test(args);
}

/** Known session controls. Unrecognised commands remain individual events:
 * a custom skill must never be presented as a lasting setting. */
export function commandSettingKey(command: SlashCommand): string | null {
  if (command.name === "/model" || command.name === "/models") return "model";
  return ["/effort", "/plan", "/goal", "/permissions"].includes(command.name) ? command.name.slice(1) : null;
}

/** Consecutive slash commands drawn as one rule (`commandRuns`). */
export interface CommandRuns {
  /** Turns whose rule is drawn on a later command's line instead. */
  folded: ReadonlySet<number>;
  /** A run's last turn → the labels of the commands folded into it. */
  lead: ReadonlyMap<number, string>;
}

/** Joins the commands on one rule (`/model → Fable 5.2 · /effort high · /plan`). */
export const COMMAND_SEPARATOR = " · ";

/** Runs of slash commands sent one after another read as one line: a command
 * whose arguments ride on its rule (no bubble under it) folds into the
 * command right after it. A day chip between them (`breaks`) or a prompt
 * still sending ends the run; the run's last command keeps its bubble. Model
 * changes within a run show only the final choice, including `/models`.
 * One-off actions always keep their own row and end a settings run. */
export function commandRuns(
  turns: readonly TranscriptTurn[],
  breaks: ReadonlySet<number> = new Set(),
  label: (command: SlashCommand) => string = commandLabel,
): CommandRuns {
  const folded = new Set<number>();
  const lead = new Map<number, string>();
  let run: { index: number; label: string; setting: string }[] = [];
  turns.forEach((turn, index) => {
    const command = turn.pending === undefined ? turn.command : null;
    const setting = command && commandSettingKey(command);
    if (!setting || breaks.has(index)) run = [];
    if (!command || !setting) return;
    if (run.length > 0) {
      for (const { index: at } of run) {
        folded.add(at);
        lead.delete(at);
      }
      // Keep the final value of each setting. One-off actions never enter
      // the run, so repeated actions remain separate historical events.
      run = run.filter((entry) => entry.setting !== setting);
      if (run.length > 0) lead.set(index, run.map(({ label }) => label).join(COMMAND_SEPARATOR));
    }
    run = commandArgsInline(command.args) ? [...run, { index, label: label(command), setting }] : [];
  });
  return { folded, lead };
}

/** `transcriptTurns` by the `entries` array it was given. Every reader of a
 * session (the chat, read-aloud, hands-free, the voice landing, the link
 * list) asks for the turns of the same array on each update; an entries array
 * is never changed in place once built (a change is a new array), and no
 * caller changes the turns it gets back, so one pass serves them all. */
const turnsCache = new WeakMap<readonly TranscriptEntry[], readonly TranscriptTurn[]>();

export function transcriptTurns(entries: readonly TranscriptEntry[]): readonly TranscriptTurn[] {
  const cached = turnsCache.get(entries);
  if (cached) return cached;
  const turns = buildTurns(entries);
  turnsCache.set(entries, turns);
  return turns;
}

function buildTurns(entries: readonly TranscriptEntry[]): TranscriptTurn[] {
  const seen = new Map<string, number>();
  return entries.flatMap((entry, index): TranscriptTurn[] => {
    // The question the agent is blocked on is the live card's (`askedQuestion`):
    // a bubble of it beside the card would show it twice. Once answered the
    // record loses the mark and is the ordinary card.
    if (entry.blocking === true) return [];
    // A record without a time falls back to its position; two records that
    // share one stay apart by a count.
    const base = entry.at ? `${entry.kind}:${entry.at}` : `${entry.kind}#${index}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return [{
      key: count === 0 ? base : `${base}~${count}`,
      kind: entry.kind,
      text: entry.text,
      cut: entry.cut === true,
      index,
      ...((entry.pending !== undefined ? entry.sentAt : entry.at) ? { stamp: entry.pending !== undefined ? entry.sentAt : entry.at } : {}),
      command: entry.kind === "prompt" ? withSetting(slashCommand(entry.text), entry.setting) : null,
      ...(entry.kind === "agent" ? { subagent: entry.subagent, role: entry.role, ...(entry.finished ? { finished: true } : {}), ...(entry.running ? { running: true } : {}), ...(entry.background ? { background: true } : {}), ...(entry.workflow ? { workflow: true } : {}), ...(entry.worktree ? { worktree: entry.worktree } : {}) } : {}),
      ...(entry.kind === "answer" && entry.plan === true ? { plan: true } : {}),
      ...(entry.kind === "answer" && entry.questions?.length ? { questions: entry.questions, ...(entry.asking ? { asking: true } : {}) } : {}),
      ...(entry.pending !== undefined ? { pending: entry.pending, failed: entry.failed === true, retrying: entry.retrying === true, ...(entry.held ? { held: true } : {}), ...(entry.queued ? { queued: true } : {}) } : {}),
    }];
  });
}

function withSetting(command: SlashCommand | null, setting: string | undefined): SlashCommand | null {
  return command && setting ? { ...command, setting } : command;
}
