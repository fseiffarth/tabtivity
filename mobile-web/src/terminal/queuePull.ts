/**
 * Prompts waiting in an agent CLI's queue, taken back out of it to be edited
 * (the desktop Reader's ↑ in an empty composer on Claude), and sent at once.
 * Codex and OpenCode's mini have their own walks below. Claude Code, probed
 * on 2.1.303 —
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

/** The CLIs whose queue can be read off the screen. Copilot and OpenCode's
 * full TUI mark nothing, and `ctrl+x q` quits the full TUI: only the mini
 * footer's count may ever lead to that key. Mirrors `queue_hint` in
 * `src-tauri/src/services/mobile_control/pty_bridge.rs`. */
export type QueueFamily = "claude" | "codex" | "opencode";

export function queueFamily(family: string): QueueFamily | null {
  return family === "claude" || family === "codex" || family === "opencode" ? family : null;
}

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
    /** How many of the prompts sent it holds: those left the queue. */
    pulled: number;
    /** They are the oldest of those sent, not the newest (`takenPrompts`). */
    oldest?: boolean;
    /** The box was emptied again; false leaves some of it in the CLI's box. */
    cleared: boolean;
  }
  | { ok: false; reason: "not_queued" | "not_pulled" };

const UP = "\u001b[A";
const CLEAR_LINE = "\u0015";
const QUEUED_HINT = /^Press up to edit queued messages\b/u;
const RULE = /^\s*─{3,}/u;
/** Codex 0.166.0: the heading over what Tab queued, its input box's `›` row
 * (a braille blank may stand for the space, `readableScreen`), and the key its
 * hint names: `shift+←` under tmux, `alt+↑` or `⌥ + ↑` elsewhere. */
const CODEX_QUEUED = /^• Queued follow-up inputs\s*$/u;
const CODEX_BOX = /^›(?:[\s\u2800-\u28ff]|$)/u;
const CODEX_EDIT = /(shift|alt|⌥)\s*\+\s*[←↑]\s+edit last queued message/u;
const SHIFT_LEFT = "\u001b[1;2D";
const ALT_UP = "\u001b[1;3A";
/** OpenCode 2.2.5 mini: the footer's count, and its `ctrl+x q` panel — a
 * header, a Search row, then one row a prompt, words left and kind right,
 * down to a rule. */
const OPENCODE_PENDING = /· ctrl\+x q \d+ pending\b/u;
const OPENCODE_PANEL = /^\s*Pending prompts (\d+)\b/u;
const OPENCODE_SEARCH = /^\s*Search\s*$/u;
const OPENCODE_RULE = /^\s*▀{3,}/u;
const OPENCODE_KIND = /\s{2,}\S+\s*$/u;
const CTRL_X = "\u0018";
const CTRL_D = "\u0004";
const ESCAPE = "\u001b";
/** Claude's own `chat:sendNow`, Ctrl+X Ctrl+S, in one write (probed on
 * 2.1.322, `scripts/verify-cli/claude/send_now.py`): a running Bash command
 * moves to the background instead of being killed, a streaming answer stops
 * unmarked, and a turn not yet answering keeps its prompt — where Esc hands
 * it back into the box, unsent. Claude draws `ctrl+x ctrl+s to send now`
 * under a queued message. */
const CLAUDE_SEND_NOW = "\u0018\u0013";
/** Most prompts a walk takes: `MAX_PENDING`. */
const MAX_QUEUED = 50;
const TIMING: QueuePullTiming = { waitMs: 1500, pollMs: 60 };
/** Between OpenCode's two Escs. Longer than `ESC_GAP` in `pty_bridge.rs`:
 * these go through a tmux client, which joins two inside its `escape-time`. */
const ESC_GAP_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function words(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** The lines in Claude Code's input box — its `❯` row and the rows under it
 * up to the rule closing it, the `❯ ` and continuation indent cut (2.1.310
 * draws the live box's space after the `❯` as a no-break space) — or null
 * when no box is at the bottom of the screen. */
export function inputBoxLines(rows: readonly string[]): string[] | null {
  const from = Math.max(1, rows.length - 30);
  for (let index = rows.length - 2; index >= from; index -= 1) {
    if (!rows[index].startsWith("❯") || !RULE.test(rows[index - 1])) continue;
    const lines = [rows[index].replace(/^❯[ \u00a0]?/u, "")];
    for (let next = index + 1; next < rows.length; next += 1) {
      if (RULE.test(rows[next])) return lines.map((line) => line.trimEnd());
      lines.push(rows[next].replace(/^[ \u00a0]{2}/u, ""));
    }
    return null;
  }
  return null;
}

/** The screen says messages wait in `family`'s queue: on Claude the empty
 * box, where ↑ would take them back. */
export function queuedHintShown(rows: readonly string[], family: QueueFamily = "claude"): boolean {
  if (family === "codex") return rows.some((row) => CODEX_QUEUED.test(row));
  if (family === "opencode") return rows.slice(-6).some((row) => OPENCODE_PENDING.test(row));
  const box = inputBoxLines(rows);
  return !!box && QUEUED_HINT.test(box[0]);
}

/** The lines in Codex's input box — its last `›` row and the rows under it up
 * to the blank one closing it — or null when none is on the screen. */
export function codexBoxLines(rows: readonly string[]): string[] | null {
  for (let index = rows.length - 1; index >= Math.max(0, rows.length - 40); index -= 1) {
    if (!CODEX_BOX.test(rows[index])) continue;
    const lines = [rows[index].replace(/^›[\s\u2800-\u28ff]?/u, "")];
    for (let next = index + 1; next < rows.length && rows[next].trim(); next += 1) {
      lines.push(rows[next].replace(/^ {2}/u, ""));
    }
    return lines.map((line) => line.trimEnd());
  }
  return null;
}

/** The key Codex's hint names for taking back the last queued message. */
function codexEditKey(rows: readonly string[]): string | null {
  for (const row of rows) {
    const named = CODEX_EDIT.exec(row);
    if (named) return named[1] === "shift" ? SHIFT_LEFT : ALT_UP;
  }
  return null;
}

/** The prompts OpenCode's panel lists, or null while it is not up. */
export function openCodePanelRows(rows: readonly string[]): string[] | null {
  const header = rows.findIndex((row) => OPENCODE_PANEL.test(row));
  if (header < 0) return null;
  const listed: string[] = [];
  for (const row of rows.slice(header + 1)) {
    if (OPENCODE_RULE.test(row)) break;
    if (row.trim() && !OPENCODE_SEARCH.test(row)) listed.push(row.replace(OPENCODE_KIND, "").trim());
  }
  return listed;
}

/** Whitespace out: a box wraps long words wherever it likes. */
function bare(text: string): string {
  return text.replace(/\s+/gu, "");
}

/** What a queued message came back as, and how many of the newest prompts
 * `sent` it was, compared from the newest back. A prompt known by its words
 * comes back exactly as sent, not as the box wrapped it; a box only shows the
 * end of what is taller than it. */
function matchSent(taken: readonly string[], sent: readonly string[]): { texts: string[]; pulled: number } {
  const texts = [...taken];
  let pulled = 0;
  while (pulled < taken.length && pulled < sent.length) {
    const at = taken.length - 1 - pulled;
    const prompt = sent[sent.length - 1 - pulled];
    const shown = bare(taken[at]);
    if (!shown || !bare(prompt).endsWith(shown)) break;
    texts[at] = prompt;
    pulled += 1;
  }
  return { texts, pulled };
}

/** Reads the screen until `done` holds or the wait is over. */
async function pollUntil<T>(read: () => T, done: (value: T) => boolean, timing: QueuePullTiming): Promise<T> {
  const deadline = Date.now() + timing.waitMs;
  for (;;) {
    const value = read();
    if (done(value) || Date.now() >= deadline) return value;
    await sleep(timing.pollMs);
  }
}

/** Codex hands queued messages back one at a time, newest first, and each
 * replaces what its box held: every one is read and the box emptied before
 * the next. */
async function pullCodex(driver: QueuePullDriver, sent: readonly string[], timing: QueuePullTiming): Promise<QueuePullResult> {
  const taken: string[] = [];
  let cleared = true;
  for (let round = 0; round < MAX_QUEUED && cleared && queuedHintShown(driver.rows(), "codex"); round += 1) {
    const rows = driver.rows();
    const key = codexEditKey(rows);
    const before = words((codexBoxLines(rows) ?? []).join(" "));
    if (!key || !(await driver.key(key))) break;
    const box = await pollUntil(() => codexBoxLines(driver.rows()), (now) => !!now && words(now.join(" ")) !== before, timing);
    if (!box || words(box.join(" ")) === before) break;
    taken.unshift(box.join("\n").trim());
    const emptied = (now: string[] | null) => !!now && words(now.join(" ")) === before;
    for (let press = 0; press < 2 * box.length + 2; press += 1) {
      if (!(await driver.key(CLEAR_LINE))) break;
    }
    cleared = emptied(await pollUntil(() => codexBoxLines(driver.rows()), emptied, timing));
  }
  if (taken.length === 0) return { ok: false, reason: "not_pulled" };
  const { texts, pulled } = matchSent(taken, sent);
  return { ok: true, text: texts.join("\n"), pulled, cleared };
}

/** OpenCode's panel deletes from its top row. Each row must be one of the
 * prompts sent, or nothing is touched: its rows are cut to the width, so
 * what was sent is what comes back. */
async function pullOpenCode(driver: QueuePullDriver, sent: readonly string[], timing: QueuePullTiming): Promise<QueuePullResult> {
  if (!(await driver.key(CTRL_X)) || !(await driver.key("q"))) return { ok: false, reason: "not_pulled" };
  const listed = await pollUntil(() => openCodePanelRows(driver.rows()), (rows) => !!rows && rows.length > 0, timing);
  const panelUp = () => openCodePanelRows(driver.rows()) !== null;
  const close = async () => { if (panelUp()) await driver.key(ESCAPE); };
  if (!listed || listed.length === 0) {
    await close();
    return { ok: false, reason: "not_pulled" };
  }
  const prompts = sent.slice(-listed.length);
  const known = prompts.length === listed.length
    && listed.every((row, index) => bare(prompts[index]).startsWith(bare(row).replace(/…$/u, "")));
  if (!known) {
    await close();
    return { ok: false, reason: "not_pulled" };
  }
  let left = listed.length;
  while (left > 0) {
    if (!(await driver.key(CTRL_D))) break;
    const now = await pollUntil(() => openCodePanelRows(driver.rows()), (rows) => (rows?.length ?? 0) < left, timing);
    if ((now?.length ?? 0) >= left) break;
    left = now?.length ?? 0;
  }
  await close();
  const pulled = listed.length - left;
  if (pulled === 0) return { ok: false, reason: "not_pulled" };
  // Deleted from the top: the oldest went first, the newest may be left.
  return { ok: true, text: prompts.slice(0, pulled).join("\n"), pulled, oldest: left > 0, cleared: true };
}

/** Which of `sent` (oldest first) a pull took out of the queue. */
export function takenPrompts<T>(sent: readonly T[], result: { pulled: number; oldest?: boolean }): T[] {
  return result.oldest ? sent.slice(0, result.pulled) : sent.slice(sent.length - result.pulled);
}

/** What a stop leaves to do once the desktop has pressed Esc. Codex drops
 * what Tab queued back into its box: Enter sends it, once the list is gone,
 * and does nothing if the turn had ended and sent it first. */
export async function finishSendNow(driver: QueuePullDriver, family: QueueFamily, timing: QueuePullTiming = TIMING): Promise<void> {
  if (family !== "codex") return;
  const gone = (rows: readonly string[]) => !queuedHintShown(rows, family);
  if (gone(await pollUntil(() => driver.rows(), gone, { ...timing, waitMs: 4000 }))) await driver.key("\r");
}

/** Send now off the desktop's own copy of the pane, while the screen still
 * shows the queue: Claude's own send-now chord, Esc as the other CLIs' stop
 * takes it. Also any plain stop of a Codex turn with a queue, which would
 * otherwise leave it in a box the chat does not show. */
export async function sendQueuedNow(driver: QueuePullDriver, family: QueueFamily): Promise<boolean> {
  if (!queuedHintShown(driver.rows(), family)) return false;
  if (family === "claude") return driver.key(CLAUDE_SEND_NOW);
  if (!(await driver.key(ESCAPE))) return false;
  if (family === "opencode") {
    await sleep(ESC_GAP_MS);
    if (!(await driver.key(ESCAPE))) return false;
  }
  await finishSendNow(driver, family);
  return true;
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
  family: QueueFamily = "claude",
): Promise<QueuePullResult> {
  if (family !== "claude" && !queuedHintShown(driver.rows(), family)) return { ok: false, reason: "not_queued" };
  if (family === "codex") return pullCodex(driver, sent, timing);
  if (family === "opencode") return pullOpenCode(driver, sent, timing);
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

  return { ok: true, text, pulled, cleared: await emptyClaudeBox(driver, box, timing) };
}

/** Empties Claude's input box, which holds `box`: two Ctrl+U per drawn row
 * cover each line and the break before it, and a box taller than the screen
 * shows takes another round. True once its words are gone. */
async function emptyClaudeBox(driver: QueuePullDriver, box: readonly string[], timing: QueuePullTiming): Promise<boolean> {
  const last = words(box.join(" ")).slice(-24);
  const emptied = (now: string[] | null) => !!now && !words(now.join(" ")).includes(last);
  for (let round = 0; round < 3; round += 1) {
    const rows = inputBoxLines(driver.rows())?.length ?? box.length;
    for (let press = 0; press < 2 * rows + 2; press += 1) {
      if (!(await driver.key(CLEAR_LINE))) break;
    }
    if (emptied(await pollUntil(() => inputBoxLines(driver.rows()), emptied, timing))) return true;
  }
  return false;
}

/** How long a stop is watched for a prompt Claude hands back. */
const STOP_TIMING: QueuePullTiming = { waitMs: 3000, pollMs: 80 };

/** Claude's box as a stop is pressed, for {@link takeBackStopped}. */
export function claudeBoxWords(rows: readonly string[]): string {
  return words((inputBoxLines(rows) ?? []).join(" "));
}

/**
 * Claude 2.1.318: an Esc that lands before the turn has answered stops it
 * and puts its prompt back in the input box, unsent — with a queue behind
 * it, the queue goes and the first prompt comes back
 * (`scripts/verify-cli/claude/esc_early.py`). The next prompt a chat sends
 * empties that box first, so the words would be lost. Watches the box after
 * such an Esc (`before`: its words as the Esc went, `claudeBoxWords`); when
 * it fills with one of `sent` (oldest first; its words, or their end when the
 * box is taller than the screen), empties it and says which came back. Null
 * when nothing of `sent` did: anything else in the box is the user's own,
 * and stays.
 */
export async function takeBackStopped(
  driver: QueuePullDriver,
  sent: readonly string[],
  before: string,
  timing: QueuePullTiming = STOP_TIMING,
): Promise<{ index: number; cleared: boolean } | null> {
  if (sent.length === 0) return null;
  const known = sent.map(bare);
  const found = (box: string[] | null): number => {
    if (!box || QUEUED_HINT.test(box[0]) || words(box.join(" ")) === before) return -1;
    const shown = bare(box.join(""));
    if (!shown) return -1;
    for (let index = known.length - 1; index >= 0; index -= 1) {
      if (known[index] === shown || (shown.length >= 24 && known[index].endsWith(shown))) return index;
    }
    return -1;
  };
  const box = await pollUntil(() => inputBoxLines(driver.rows()), (now) => found(now) >= 0, timing);
  const index = found(box);
  if (index < 0 || !box) return null;
  return { index, cleared: await emptyClaudeBox(driver, box, timing) };
}
