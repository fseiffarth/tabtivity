/** Ctrl-A, Ctrl-K: move to the start of the agent composer and remove its draft. */
export const AGENT_LINE_RESET = "\u0001\u000b";

/** How many lines above the cursor {@link openCodeBoxReset} empties by default. */
const OPENCODE_RESET_LINES = 32;

/**
 * Empties OpenCode 2's input box from the cursor's line up: per line Ctrl-E
 * (`input_line_end`), Ctrl-U (`input_delete_to_line_start`) and Backspace,
 * which joins the line onto the one above, then {@link AGENT_LINE_RESET}.
 * The line reset alone empties only the cursor's line, and the box holds more:
 * a draft typed over several lines, or the prompt 2.4.2 hands back when a
 * stop lands before its first token, so the next prompt went out with those
 * lines in front of it. A Backspace on an empty box does nothing. Its own
 * `input_clear` (Ctrl+C) is not used: on an empty box it quits. Probed 2.4.1
 * and 2.4.2, full TUI and mini, 2026-11-26
 * (`scripts/verify-cli/opencode/takeback.py`). `lines` covers `lines + 1`.
 */
export function openCodeBoxReset(lines = OPENCODE_RESET_LINES): string {
  return "\u0005\u0015\u007f".repeat(Math.max(0, lines)) + AGENT_LINE_RESET;
}

/** DECSET 2004 bracketed-paste markers. */
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

/** Maximum UTF-8 payload accepted by the scheduled-prompt store. */
export const MAX_AGENT_MESSAGE_BYTES = 16 * 1024;

const ENCODER = new TextEncoder();

/**
 * Sanitize text before it becomes terminal input. Newlines are preserved, while
 * every other C0/DEL byte is removed so a stored message cannot smuggle a key
 * press or close its own bracketed-paste run. Blank lines before the first
 * words go, like the trailing ones: typed, the first of them is a lone Ctrl-J
 * into an empty composer, which an agent can read as a submit of nothing —
 * the phone showed the prompt as sent while the agent never got it.
 */
export function sanitizeAgentMessage(draft: string): string {
  const text = draft
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "");
  if (!text.trim()) return "";
  return text;
}

/** UTF-8 byte length, used for the cross-language 16 KiB bound. */
export function agentMessageBytes(message: string): number {
  return ENCODER.encode(message).byteLength;
}

const CLAUDE_AGENT = /claude/iu;

/**
 * Whether a message submitted to an agent goes in inside bracketed-paste
 * markers. `agent` is whatever names the family where this is asked: the
 * phone's tab label, the desktop's launch command.
 *
 * Claude Code turns every bracketed paste — one short line too — into a
 * `[Pasted text]` block and hands the model `<pasted_content>` instead of the
 * user's own words, so its messages are typed and the submit rides the write
 * gap. The other families keep the markers where the pane has the mode on:
 * they are what stops Codex reading a coalesced `text CR` as one paste.
 *
 * Both deliveries ask this, and for a while only the phone's did — a prompt
 * filed or chained from the desktop went in bracketed and reached the model
 * quoted as something pasted from elsewhere rather than as the question
 * (2026-09-20).
 */
export function bracketsAgentMessage(agent: string | undefined, paneBracketed: boolean): boolean {
  return paneBracketed && !(agent !== undefined && CLAUDE_AGENT.test(agent));
}

/**
 * The most characters one typed write carries. Claude Code reads a key event
 * longer than 800 UTF-16 units as a paste (2.1.309) and records a paste over
 * 800 characters as a `<pasted_content>` block — the model is handed the
 * words as something pasted from elsewhere, and the chat's sending bubble
 * never finds its record (2026-10-23). 256 code points stay under the bound
 * even when three writes coalesce and every one is astral.
 */
const TYPED_CHUNK = 256;

/** `line` in writes of at most {@link TYPED_CHUNK} code points. */
function typedPieces(line: string): string[] {
  const chars = Array.from(line);
  const pieces: string[] = [];
  for (let start = 0; start < chars.length; start += TYPED_CHUNK) {
    pieces.push(chars.slice(start, start + TYPED_CHUNK).join(""));
  }
  return pieces;
}

/**
 * The distinct writes that safely replace an agent composer draft and submit a
 * single message. Keep these split: some TUIs discard the remainder of a stdin
 * chunk that starts with a control key, and some absorb a CR into pasted text.
 * A typed line longer than {@link TYPED_CHUNK} goes in several writes.
 * `agent` (the launch command or tab label) lets a CLI's own quirks in: see
 * {@link OPENCODE_MENTION_OPEN}.
 */
export function agentInputWrites(draft: string, bracketedPaste = false, agent?: string): string[] {
  const text = sanitizeAgentMessage(draft);
  if (!text) return [];
  // OpenCode's `@` picker takes the Enter (a pick, or nothing when no file
  // matches), so the words stay in the box. A space closes the picker first;
  // OpenCode keeps it at the stored prompt's end (probed 2.4.2, full TUI and
  // mini, 2026-11-26, `scripts/verify-cli/opencode/chat_send.py`).
  const openCode = agent !== undefined && agentFamily(agent) === "opencode";
  const closeMention = openCode && OPENCODE_MENTION_OPEN.test(text);
  const submit = closeMention ? [" ", "\r"] : ["\r"];
  const reset = openCode ? openCodeBoxReset() : AGENT_LINE_RESET;
  // A lone character is a key press, never a paste: a TUI screen that reads
  // keys — Codex's pager ("q close"), an approval's "y" — ignores pasted text,
  // and one character cannot form the burst the markers guard against.
  if (bracketedPaste && Array.from(text).length > 1) return [reset, `${PASTE_START}${text}${PASTE_END}`, ...submit];
  const writes = [reset];
  text.split("\n").forEach((line, index) => {
    if (index) writes.push("\n");
    writes.push(...typedPieces(line));
  });
  writes.push(...submit);
  return writes;
}

/** A last word that opens OpenCode's `@` file/agent picker. */
const OPENCODE_MENTION_OPEN = /(?:^|\s)@\S*$/u;

/** Words Codex's Tab would act on instead of queueing them: a `/command`, or
 * a last word opening its `@` or `$` picker, whose highlighted row Tab takes. */
const CODEX_TAB_TAKES = /^\s*\/|(?:^|\s)[@$]\S*\s*$/u;

/**
 * {@link agentInputWrites} for a prompt that may land while the agent works.
 * Codex keeps two lists of those (0.166.0): Enter puts one in `Messages to be
 * submitted after next tool call`, out of anyone's reach, and Tab in `Queued
 * follow-up inputs`, which can be taken back (`queuePull.ts`), so a chat's
 * prompt goes in with Tab. Tab on an idle Codex leaves the words in the box
 * and Enter on an empty one does nothing, so the Enter after it delivers the
 * prompt either way. OpenCode 2.4.2's full TUI takes a plain Enter mid-turn
 * as a steer, into the running turn, which nothing can take back, and marks
 * nowhere; its `queue prompt` (Ctrl+X Enter) lists the prompt (`N queued`)
 * where the panel can delete or send it. The mini takes the same chord and
 * counts it as pending, and an idle OpenCode just submits it
 * (`scripts/verify-cli/opencode/queue.py`). Every other CLI queues on Enter.
 */
export function agentQueueWrites(writes: readonly string[], agent: string | undefined, message: string): string[] {
  if (writes.length === 0 || agent === undefined) return [...writes];
  const family = agentFamily(agent);
  if (family === "opencode") return [...writes.slice(0, -1), "\x18", "\r"];
  if (family !== "codex" || CODEX_TAB_TAKES.test(message)) return [...writes];
  return [...writes.slice(0, -1), "\t", "\r"];
}

/** Which CLI an agent label names: the phone's tab label or the desktop's
 * agent-item label. The families are matched on the label; any other label
 * keys by its first word, so a CLI with no entry here still keeps its own
 * commands apart from every other one's. */
const AGENT_FAMILIES: [RegExp, string][] = [
  [/claude/iu, "claude"],
  [/codex/iu, "codex"],
  [/gemini/iu, "gemini"],
  [/qwen/iu, "qwen"],
  [/open\s*code/iu, "opencode"],
  [/aider/iu, "aider"],
  [/kimi/iu, "kimi"],
  [/copilot/iu, "copilot"],
  [/cursor/iu, "cursor"],
  [/antigravity|\bagy\b/iu, "antigravity"],
  // The new-tab menu labels Mistral's `vibe` "Mistral".
  [/mistral|\bvibe\b/iu, "vibe"],
];

export function agentFamily(agentLabel: string): string {
  for (const [pattern, key] of AGENT_FAMILIES) if (pattern.test(agentLabel)) return key;
  const word = agentLabel.trim().toLowerCase().split(/\s+/u)[0]?.replace(/[^\p{L}\p{N}_-]/gu, "");
  return word || "agent";
}

/** What a composer's Clear types: `/clear`, every CLI's new conversation —
 * but OpenCode's `mini` lists no `/clear`: its slash popup took the word for
 * `/goal`, which printed its usage and kept the conversation (2.4.2,
 * 2026-11-26, `scripts/verify-cli/opencode/chat_send.py`). `/new` starts one
 * in the full TUI and in `mini`. `agent` is a family or a label. */
export function newConversationCommand(agent: string): string {
  return agentFamily(agent) === "opencode" ? "/new" : "/clear";
}

/** The commands a composer offers to lead a draft with — the phone's Plan /
 * Goal chips, the desktop's steering keys — each followed by the user's own
 * words. Each CLI (`agentFamily`) gets only the ones it documents (checked
 * 2026-09-27); a CLI with neither gets none. */
const DRAFT_PREFIXES: Record<string, readonly string[]> = {
  claude: ["/plan", "/goal"],
  codex: ["/plan", "/goal"],
  antigravity: ["/plan", "/goal"],
  gemini: ["/plan"],
  copilot: ["/plan"],
  cursor: ["/plan"],
  kimi: ["/plan"],
};

export function agentDraftPrefixes(family: string): readonly string[] {
  return DRAFT_PREFIXES[family] ?? [];
}
