/**
 * Prompts waiting in Claude Code's queue, taken back out of it to be edited
 * (the desktop Reader's ↑ in an empty composer). Probed on 2.1.303 —
 *
 *   while messages wait behind a turn, the empty input box reads `Press up
 *     to edit queued messages` (with `, Enter to send them immediately:` on
 *     some screens);
 *   ↑ there takes every queued message out of the queue — none of them is
 *     sent any more — and puts them in the box, one line each in the order
 *     they were queued, the cursor after the last;
 *   Ctrl+U deletes the line up to the cursor and, at a line's start, the
 *     line break before it: pressed often enough it empties the box, and on
 *     an empty box it does nothing. Ctrl+L (bound to clear the input) leaves
 *     the box as it is.
 *
 * Every step is read back off the screen: nothing is pressed unless the box
 * shows that queue hint, and the box is emptied only once ↑ has filled it.
 * Which prompts came back is read off the box too — the newest of those sent
 * that its text ends with — since a prompt sent earlier may already have been
 * taken up by the turn.
 */

/** What the pull drives: the pane's screen and keyboard. */
export interface QueuePullDriver {
  /** The screen's rows as drawn now (`bufferRows`). */
  rows(): readonly string[];
  /** One key press; false when it did not go. */
  key(key: string): Promise<boolean>;
}

export interface QueuePullTiming {
  /** How long a key is given to show on screen. */
  waitMs: number;
  /** How often the screen is read meanwhile. */
  pollMs: number;
}

export type QueuePullResult =
  | {
    ok: true;
    /** What came back, for the composer. */
    text: string;
    /** How many of the newest prompts sent it holds: those left the queue. */
    pulled: number;
    /** The box was emptied again; false leaves some of it in the CLI's box. */
    cleared: boolean;
  }
  | { ok: false; reason: "not_queued" | "not_pulled" };

const UP = "\u001b[A";
const CLEAR_LINE = "\u0015";
const QUEUED_HINT = /^Press up to edit queued messages\b/u;
const RULE = /^\s*─{3,}/u;
const TIMING: QueuePullTiming = { waitMs: 1500, pollMs: 60 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function words(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** The lines in Claude Code's input box — its `❯` row and the rows under it
 * up to the rule closing it, the `❯ ` and continuation indent cut — or null
 * when no box is at the bottom of the screen. */
export function inputBoxLines(rows: readonly string[]): string[] | null {
  const from = Math.max(1, rows.length - 30);
  for (let index = rows.length - 2; index >= from; index -= 1) {
    if (!rows[index].startsWith("❯") || !RULE.test(rows[index - 1])) continue;
    const lines = [rows[index].replace(/^❯ ?/u, "")];
    for (let next = index + 1; next < rows.length; next += 1) {
      if (RULE.test(rows[next])) return lines.map((line) => line.trimEnd());
      lines.push(rows[next].replace(/^ {2}/u, ""));
    }
    return null;
  }
  return null;
}

/** The empty box says messages wait in the queue: ↑ would take them back. */
export function queuedHintShown(rows: readonly string[]): boolean {
  const box = inputBoxLines(rows);
  return !!box && QUEUED_HINT.test(box[0]);
}

/**
 * Takes the queued messages back out of Claude's queue into the caller's
 * hands and empties the box ↑ put them in. `sent` is what was sent to the
 * tab and not yet seen recorded, oldest first.
 */
export async function pullQueuedPrompts(
  driver: QueuePullDriver,
  sent: readonly string[],
  timing: QueuePullTiming = TIMING,
): Promise<QueuePullResult> {
  /** Reads the box until `done` holds or the wait is over. */
  const until = async (done: (box: string[] | null) => boolean): Promise<string[] | null> => {
    const deadline = Date.now() + timing.waitMs;
    for (;;) {
      const box = inputBoxLines(driver.rows());
      if (done(box) || Date.now() >= deadline) return box;
      await sleep(timing.pollMs);
    }
  };
  const filled = (box: string[] | null) => !!box && !QUEUED_HINT.test(box[0]) && box.some((line) => line.trim());

  if (!queuedHintShown(driver.rows())) return { ok: false, reason: "not_queued" };
  if (!(await driver.key(UP))) return { ok: false, reason: "not_pulled" };
  const box = await until(filled);
  if (!box || !filled(box)) return { ok: false, reason: "not_pulled" };

  const shown = words(box.join(" "));
  let pulled = 0;
  for (let count = sent.length; count > 0; count -= 1) {
    const tail = words(sent.slice(-count).join(" "));
    if (shown === tail || shown.endsWith(` ${tail}`)) {
      pulled = count;
      break;
    }
  }
  // Anything else the box holds (a message typed into the terminal and
  // queued there) comes along as drawn, so nothing is lost by emptying it.
  const known = sent.slice(sent.length - pulled).join("\n");
  const text = pulled > 0 && shown === words(known) ? known : box.join("\n").trim();

  // Two presses per drawn row covers each line and the break before it;
  // a box taller than the screen shows takes another round.
  const last = shown.slice(-24);
  const emptied = (now: string[] | null) => !!now && !words(now.join(" ")).includes(last);
  let cleared = false;
  for (let round = 0; round < 3 && !cleared; round += 1) {
    const rows = inputBoxLines(driver.rows())?.length ?? box.length;
    for (let press = 0; press < 2 * rows + 2; press += 1) {
      if (!(await driver.key(CLEAR_LINE))) break;
    }
    cleared = emptied(await until(emptied));
  }
  return { ok: true, text, pulled, cleared };
}
