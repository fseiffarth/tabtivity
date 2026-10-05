/** Ctrl-A, Ctrl-K: move to the start of the agent composer and remove its draft. */
export const AGENT_LINE_RESET = "\u0001\u000b";

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
 * The distinct writes that safely replace an agent composer draft and submit a
 * single message. Keep these split: some TUIs discard the remainder of a stdin
 * chunk that starts with a control key, and some absorb a CR into pasted text.
 */
export function agentInputWrites(draft: string, bracketedPaste = false): string[] {
  const text = sanitizeAgentMessage(draft);
  if (!text) return [];
  // A lone character is a key press, never a paste: a TUI screen that reads
  // keys — Codex's pager ("q close"), an approval's "y" — ignores pasted text,
  // and one character cannot form the burst the markers guard against.
  if (bracketedPaste && Array.from(text).length > 1) return [AGENT_LINE_RESET, `${PASTE_START}${text}${PASTE_END}`, "\r"];
  const writes = [AGENT_LINE_RESET];
  text.split("\n").forEach((line, index) => {
    if (index) writes.push("\n");
    if (line) writes.push(line);
  });
  writes.push("\r");
  return writes;
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
  [/opencode/iu, "opencode"],
  [/aider/iu, "aider"],
  [/kimi/iu, "kimi"],
  [/copilot/iu, "copilot"],
  [/cursor/iu, "cursor"],
  [/antigravity/iu, "antigravity"],
  // The new-tab menu labels Mistral's `vibe` "Mistral".
  [/mistral|\bvibe\b/iu, "vibe"],
];

export function agentFamily(agentLabel: string): string {
  for (const [pattern, key] of AGENT_FAMILIES) if (pattern.test(agentLabel)) return key;
  const word = agentLabel.trim().toLowerCase().split(/\s+/u)[0]?.replace(/[^\p{L}\p{N}_-]/gu, "");
  return word || "agent";
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
