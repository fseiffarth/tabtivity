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
  kind: "prompt" | "answer" | "agent";
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
  /** On a subagent: the linked worktree it works in, when not the project folder. */
  worktree?: TabWorktree;
  /** On an `answer`: the plan the agent put up for approval. */
  plan?: boolean;
  /** On an `answer`: the questions it asked, as answered. */
  questions?: readonly AskedQuestion[];
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

/** Whether a command's arguments ride on the divider beside its name: a
 * one-word setting does (`/model opus`, `/effort high`); anything with words
 * — the text of a `/goal` or `/plan` — is the reader's own message and reads
 * as a prompt bubble under it. */
export function commandArgsInline(args: string): boolean {
  return args.length <= 24 && !/\s/.test(args);
}

export function transcriptTurns(entries: readonly TranscriptEntry[]): TranscriptTurn[] {
  const seen = new Map<string, number>();
  return entries.map((entry, index) => {
    // A record without a time falls back to its position; two records that
    // share one stay apart by a count.
    const base = entry.at ? `${entry.kind}:${entry.at}` : `${entry.kind}#${index}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return {
      key: count === 0 ? base : `${base}~${count}`,
      kind: entry.kind,
      text: entry.text,
      cut: entry.cut === true,
      index,
      ...((entry.pending !== undefined ? entry.sentAt : entry.at) ? { stamp: entry.pending !== undefined ? entry.sentAt : entry.at } : {}),
      command: entry.kind === "prompt" ? slashCommand(entry.text) : null,
      ...(entry.kind === "agent" ? { subagent: entry.subagent, role: entry.role, ...(entry.finished ? { finished: true } : {}), ...(entry.worktree ? { worktree: entry.worktree } : {}) } : {}),
      ...(entry.kind === "answer" && entry.plan === true ? { plan: true } : {}),
      ...(entry.kind === "answer" && entry.questions?.length ? { questions: entry.questions } : {}),
      ...(entry.pending !== undefined ? { pending: entry.pending, failed: entry.failed === true, retrying: entry.retrying === true, ...(entry.held ? { held: true } : {}), ...(entry.queued ? { queued: true } : {}) } : {}),
    };
  });
}
