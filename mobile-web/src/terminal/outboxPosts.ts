import type { OutboxFile, TranscriptEntry } from "../api";

/**
 * The files the agent sent (`tabtivity-send`, the project's `.tabtivity/outbox/`)
 * as messages in the stored-session chat, the way a messenger shows them: one
 * picture is one message, and what one send put out together — a plot and its
 * table, three screenshots — is one message holding all of it. The gallery
 * behind the 🖼 still lists every file; this only places the ones that belong
 * to the conversation on screen — the caller passes only the files this tab
 * sent (`OutboxFile.from_tab`), so a picture reaches the one chat it was sent
 * from and no other in the project.
 *
 * Placement is by time: every stored record carries one (`TranscriptEntry.at`)
 * and every file its mtime, so a post goes after the last record written at or
 * before it — between the "I'll send it" and the "sent" the agent wrote around
 * its `tabtivity-send` call. A record without a time stands at the one before it.
 *
 * A file older than the first shown record is left to the gallery: it belongs
 * to a turn not shown (the answer was truncated) or to another session in the
 * same project, and posting it at the top would open a chat with a picture
 * nobody asked for in it. Records with no times at all place nothing — a guess
 * from positions is what Focus never does.
 *
 * Files whose mtimes lie within `POST_GAP` of each other, with no record
 * between them, are one post: `tabtivity-send a b c` publishes all three within
 * the same second, and an agent sending them one call after another does so
 * seconds apart. A post is keyed by its oldest file, so a shown post keeps its
 * place as later posts and records arrive.
 */

/** Seconds between two files that still count as one send. */
export const POST_GAP = 10;

export interface OutboxPost {
  /** Stable across polls: the oldest file's name, which the outbox never reuses. */
  key: string;
  /** Oldest first, as they were sent. */
  files: OutboxFile[];
}

/** Whole unix seconds of an entry's `at` — file mtimes are whole seconds, so a
 * record written 400 ms into the second a file was sent still precedes it. */
function entrySeconds(entry: TranscriptEntry): number | null {
  if (!entry.at) return null;
  const ms = Date.parse(entry.at);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The posts to draw after each of `entries`, by the entry's index; an index
 * with none is absent. */
export function outboxPosts(entries: readonly TranscriptEntry[], files: readonly OutboxFile[]): Map<number, OutboxPost[]> {
  const posts = new Map<number, OutboxPost[]>();
  if (files.length === 0 || entries.length === 0) return posts;
  let last: number | null = null;
  // A prompt still queued on the desktop stands at the end with its send's
  // time: nothing the agent sent meanwhile belongs below it.
  const times = entries.map((entry) => (entry.queued ? null : (last = entrySeconds(entry) ?? last)));
  const oldestFirst = [...files].sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
  let open: { index: number; post: OutboxPost; last: number } | null = null;
  for (const file of oldestFirst) {
    let index = -1;
    for (let i = 0; i < times.length; i += 1) {
      const time = times[i];
      if (time !== null && time <= file.modified) index = i;
    }
    if (index < 0) continue;
    if (open && open.index === index && file.modified - open.last <= POST_GAP) {
      open.post.files.push(file);
      open.last = file.modified;
      continue;
    }
    const post: OutboxPost = { key: `outbox:${file.name}`, files: [file] };
    const list = posts.get(index);
    if (list) list.push(post);
    else posts.set(index, [post]);
    open = { index, post, last: file.modified };
  }
  return posts;
}
