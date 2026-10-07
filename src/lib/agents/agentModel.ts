import { readableScreen, type ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { sessionStatus } from "../../../mobile-web/src/terminal/statusLine";

/**
 * The model tag beside an agent tab: the transcript's model id, shortened for
 * a pill. `claude-opus-4-1-20250805` → `opus-4-1`; a name with no vendor
 * prefix or date (`gpt-5-codex`, `o3`) is shown as it is. Nothing is mapped
 * through a table — a model this file has never heard of still gets an honest
 * tag, which is the point of reading the transcript instead of guessing.
 */
export function shortModelName(id: string): string {
  const trimmed = id.trim();
  const short = trimmed.replace(/-\d{8}$/, "").replace(/^claude-/, "");
  return short || trimmed;
}

/**
 * A Claude tag in the words Claude's own status line uses: `opus-4-1` →
 * `Opus 4.1`, `fable-5` → `Fable 5`. The transcript's id and the `/model`
 * confirmation both arrive as that slug (`shortModelName`), while the screen
 * says `Opus 4.1` — without this the same tab's tag changed case with the
 * source it was read from. A slug of any other shape is left as it is.
 */
export function claudeModelLabel(tag: string): string {
  const match = /^([a-z]+)((?:-\d+)+)$/.exec(tag);
  if (!match) return tag;
  return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2].slice(1).replace(/-/g, ".")}`;
}

/**
 * The model an agent session is *showing* — the one it prints under its own
 * input box, read off the pane's screen with the parser the phone's Focus
 * status line uses (`mobile-web/src/terminal/statusLine`), so the tag beside a
 * tab and the chip over its keyboard say the same words. The effort joins it
 * where the session prints one beside the model (Antigravity), exactly as the
 * chip composes it.
 *
 * It is the transcript's answer (`shortModelName` above) that this stands in
 * front of, and for two reasons: the transcript names the model of the last
 * *answer*, so a `/model` switch is invisible until the next one, and it names
 * it as an API id (`claude-opus-4-1-20250805`) rather than as the session's own
 * words. A pane this window does not hold — a popped-out tab, a tab whose view
 * has never mounted — has no screen to read, and the transcript answers.
 */
export function screenModelTag(buffer: ReadableBufferLike, agentLabel?: string): string | undefined {
  const status = sessionStatus(readableScreen(buffer, MARK_ROWS, PLAIN).lines, agentLabel);
  if (!status?.model) return undefined;
  return status.effort ? `${status.model} · ${status.effort}` : status.model;
}

/** `screenModelTag` over a plain-text screen — the rows `tmux capture-pane -p`
 * prints for the live pane (`local_tmux_screen`). */
export function textScreenModelTag(screen: string, agentLabel?: string): string | undefined {
  return screenModelTag(textBuffer(screen), agentLabel);
}

/** A `capture-pane -p` screen as the buffer shape the parsers read. */
function textBuffer(screen: string): ReadableBufferLike {
  const rows = screen.replace(/\r/g, "").replace(/\n$/, "").split("\n");
  return {
    length: rows.length,
    getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }),
  };
}

/** The session modes an agent tab is marked for: planning (the CLI's own plan
 * mode) and a running `/goal`. Either, both or neither. */
export interface AgentModeMarks { plan: boolean; goal: boolean }

/** Rows read for the marks and the model tag: the footer is the bottom of the
 * screen, so a tall window's worth is plenty, and the read stays cheap enough
 * for a timer. Words only (`plain`): `sessionStatus` reads no style, and the
 * per-cell walk was the cost of that timer. */
const MARK_ROWS = 80;
const PLAIN = { plain: true } as const;

/**
 * Which modes the session's own status line says it is in, read with the same
 * parser as the model tag and the phone's Mode chip — so a tab is marked
 * exactly when its footer says `plan mode on` or `/goal active`. `null` when
 * the bottom of the screen is not the agent's input frame (a dialog, the
 * `/model` picker): unreadable is not "neither", and the caller keeps what it
 * last read.
 */
export function screenModeMarks(buffer: ReadableBufferLike, agentLabel?: string): AgentModeMarks | null {
  const status = sessionStatus(readableScreen(buffer, MARK_ROWS, PLAIN).lines, agentLabel);
  if (!status) return null;
  return { plan: status.mode === "plan", goal: status.goal === true };
}

/** `screenModeMarks` over a plain-text screen (`local_tmux_screen`). */
export function textScreenModeMarks(screen: string, agentLabel?: string): AgentModeMarks | null {
  return screenModeMarks(textBuffer(screen), agentLabel);
}
