import { notePtyOutput } from "../../stores/activity";

/** One hidden PTY's digest inside a `terminal-activity-batch` event: the
 *  tail of what it wrote since the last tick (the same fields the former
 *  per-PTY `terminal-activity` event carried). */
export interface ActivityDigest {
  id: string;
  data: string;
}

/** Feed one batch of hidden-pane digests to the activity store.
 *
 *  A HIDDEN pane's PTY emits no `terminal-output` at all (visible-only
 *  streaming): the backend condenses its output into throttled digests, which
 *  carry the tail the classifier needs — so background agent tabs keep their
 *  working/decision/done pills without their full streams ever crossing IPC.
 *  Every digest due in a 500 ms window arrives in ONE event (performance plan
 *  §7.6) and is noted per PTY, in order, exactly as the single events were. */
export function noteActivityDigests(batch: readonly ActivityDigest[]): void {
  for (const digest of batch) notePtyOutput(digest.id, digest.data);
}
