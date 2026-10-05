import type { TranscriptEntry } from "../api";

/**
 * A prompt the composer sent, shown in the session chat the moment it leaves
 * the phone. A bubble never changes once shown: this one takes its place
 * after whatever the session held when it was sent — so the answers to it
 * come below it — and it keeps that place and those words. When the agent's
 * own record of the prompt arrives, the record is the one hidden, not the
 * bubble; a prompt typed while the agent works is recorded only once the
 * agent takes it in, often after more of its messages, and swapping the
 * bubble for the record would move it. What is held lives as long as the
 * view: reopened, the chat is simply the session's record — save the prompts
 * the desktop still holds, which the record lacks until the agent takes them
 * in; those come back with the tab (`heldPrompts.ts`).
 */
export interface PendingPrompt {
  id: number;
  text: string;
  /** How many prompts with the same words the session held when it was
   * sent — a repeated "continue" is not taken for its own arrival. */
  seen: number;
  /** The newest record time the session held then (the desktop's clock, as
   * written): the bubble's place, and what tells its record from an older
   * copy of the same words after older turns left the window the phone
   * reads. */
  after?: string;
  /** The last record visible when sent. Codex rollouts can contain records
   * without timestamps, so the clock alone cannot hold this insertion point. */
  anchor?: TranscriptEntry;
  /** Which copy of that record was the anchor, if its text repeated. */
  anchorSeen: number;
  /** When it left this phone (RFC 3339): the time its bubble shows. */
  sentAt?: string;
  /** The link never acknowledged one of its input frames: the words did not
   * reach the session. The bubble stays where it is and says so, with a
   * resend beside it — it is never removed or moved. The session's own
   * record of the prompt overrules this (`withPending`). */
  failed?: boolean;
  /** A resend is on its way and waiting for its acknowledgement. */
  retrying?: boolean;
  /** Sent while the agent worked: the desktop holds it, by this id, and
   * types it at the agent's next idle point. Until the session records it
   * the reader can still change its words (`reworded`) — the one change a
   * shown bubble takes, and only because the reader made it. `""` while the
   * desktop has not answered with the id yet. */
  held?: string;
}

/** At most this many are held; the oldest goes first. */
export const MAX_PENDING = 50;

/** Words as the session and the composer both carry them: the record trims
 * and drops control characters, a paste may rewrap. */
function words(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isCopy(entry: TranscriptEntry, text: string): boolean {
  return entry.kind === "prompt" && entry.pending === undefined && words(entry.text) === words(text);
}

/** `prompt` with the reader's new words. It keeps its place; only what tells
 * its record apart is counted again, against the session as it stands. */
export function reworded(prompt: PendingPrompt, text: string, entries: readonly TranscriptEntry[]): PendingPrompt {
  return { ...prompt, text: text.trim(), seen: entries.filter((entry) => isCopy(entry, text)).length };
}

/** The pending prompt for `text`, sent against `entries`. */
export function pendingPrompt(id: number, text: string, entries: readonly TranscriptEntry[]): PendingPrompt {
  const stamps = entries.map((entry) => entry.at).filter((at): at is string => !!at);
  const anchor = entries[entries.length - 1];
  return {
    id,
    text: text.trim(),
    seen: entries.filter((entry) => isCopy(entry, text)).length,
    after: stamps.length ? stamps.reduce((a, b) => (b > a ? b : a)) : undefined,
    anchor,
    anchorSeen: anchor ? entries.filter((entry) => entry.kind === anchor.kind
      && entry.text === anchor.text && entry.at === anchor.at).length : 0,
    sentAt: new Date().toISOString(),
  };
}

/** Where `prompt`'s own record sits in `entries`, or -1 while it has not
 * arrived: a copy stamped after it was sent, or one more copy than it saw.
 * RFC 3339 stamps from one writer order as strings. */
function recordOf(prompt: PendingPrompt, entries: readonly TranscriptEntry[]): number {
  const copies = entries.flatMap((entry, index) => (isCopy(entry, prompt.text) ? [index] : []));
  const after = prompt.after;
  const stamped = after === undefined ? undefined : copies.find((index) => (entries[index].at ?? "") > after);
  if (stamped !== undefined) return stamped;
  return copies.length > prompt.seen ? copies[copies.length - 1] : -1;
}

/** `entries` without the records of the held prompts that have arrived, and
 * which those are. A prompt the session recorded reached it, whatever the
 * link said. A prompt the desktop held is the exception: it went in at the
 * agent's idle point, after every answer it had waited below, so its bubble
 * takes its record's place instead. */
function takeRecords(entries: readonly TranscriptEntry[], pending: readonly PendingPrompt[]): { shown: TranscriptEntry[]; arrived: Set<number> } {
  const shown = [...entries];
  const arrived = new Set<number>();
  for (const prompt of pending) {
    const record = recordOf(prompt, shown);
    if (record >= 0) {
      if (prompt.held !== undefined) shown[record] = bubble(prompt, true);
      else shown.splice(record, 1);
      arrived.add(prompt.id);
    }
  }
  return { shown, arrived };
}

/** `prompt`'s bubble, stamped with its place's time so the chat keys it the
 * same wherever it stands. `queued` while the desktop still holds it. */
function bubble(prompt: PendingPrompt, arrived: boolean): TranscriptEntry {
  return {
    kind: "prompt",
    text: prompt.text,
    at: prompt.after,
    pending: prompt.id,
    ...(prompt.sentAt ? { sentAt: prompt.sentAt } : {}),
    ...(prompt.failed && !arrived ? { failed: true } : {}),
    ...(prompt.retrying && !arrived ? { retrying: true } : {}),
    ...(prompt.held && !arrived ? { held: true } : {}),
    ...(prompt.held !== undefined && !arrived ? { queued: true } : {}),
  };
}

/** The ids of the pending prompts the session has recorded: the agent has
 * them, and their words are final. */
export function arrivedPending(entries: readonly TranscriptEntry[], pending: readonly PendingPrompt[]): Set<number> {
  return takeRecords(entries, pending).arrived;
}

/**
 * The session's entries as the chat shows them: each held prompt in its
 * place, its record — once there — left out. A held prompt is an ordinary
 * prompt entry stamped with its place's time, so the chat keys it, and
 * places the agent's files around it, the way it does a recorded one.
 * A prompt the desktop holds and has not typed yet waits at the end,
 * `queued`, below everything the agent still says before taking it in — the
 * chat draws the agent at work above it — and, typed, stands where its
 * record does, which is that same spot.
 */
export function withPending(entries: readonly TranscriptEntry[], pending: readonly PendingPrompt[]): TranscriptEntry[] {
  if (pending.length === 0) return entries as TranscriptEntry[];
  const { shown, arrived } = takeRecords(entries, pending);
  let lastSlot = -1;
  const queued: TranscriptEntry[] = [];
  for (const prompt of pending) {
    if (prompt.held !== undefined) {
      if (!arrived.has(prompt.id)) queued.push(bubble(prompt, false));
      continue;
    }
    // After the last entry at or before the send — an entry without a stamp
    // stands at the one before it (as `outboxPosts` reads them), and an
    // earlier held prompt carries the same stamp, so two sent in a row keep
    // their order. Nothing stamped to go by: the end.
    let slot = shown.length;
    const after = prompt.after;
    if (after !== undefined) {
      slot = 0;
      let time: string | undefined;
      shown.forEach((entry, index) => {
        time = entry.at ?? time;
        if (time !== undefined && time <= after) slot = index + 1;
      });
    }
    // An unstamped answer written after the send inherits an older record's
    // timestamp in the scan above. Use the actual last visible record when it
    // is still present; the timestamp path remains useful if the bounded
    // transcript has since dropped that record. With no anchor or timestamp,
    // the session was empty when sent: every later record belongs below it.
    if (!prompt.anchor && after === undefined) slot = 0;
    if (prompt.anchor) {
      let anchor = -1;
      let seen = 0;
      shown.forEach((entry, index) => {
        if (entry.kind === prompt.anchor?.kind && entry.text === prompt.anchor?.text
          && entry.at === prompt.anchor?.at && ++seen === prompt.anchorSeen) anchor = index;
      });
      if (anchor >= 0) slot = anchor + 1;
    }
    slot = Math.max(slot, lastSlot + 1);
    shown.splice(slot, 0, bubble(prompt, arrived.has(prompt.id)));
    lastSlot = slot;
  }
  return queued.length ? [...shown, ...queued] : shown;
}
