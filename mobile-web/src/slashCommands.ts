// The slash commands the composer offers as the reader types a `/`.
//
// A phone composer is not the CLI's own input line: nothing reaches the
// session until Send, so the menu a TUI opens under a typed `/` never shows up
// on the phone. The composer draws its own instead, from two sources:
//
//   - the commands the reader has sent to this CLI from the phone before, kept
//     here per CLI — newest first, with their arguments, because `/model opus`
//     is the line worth repeating, not `/model`;
//   - a short built-in list per CLI of the commands it documents, so a CLI the
//     phone has never talked to still offers something.
//
// Keyed by CLI, never by tab: a command belongs to the CLI that understands it,
// and Codex's `/new` offered to a Claude Code session is a command that CLI
// does not have. Kept beside the drafts (`drafts.ts`) and like them never sent
// across the bridge.

import { agentDraftPrefixes, agentFamily } from "../../shared/agentComposer";
import { storageKey } from "../../src/lib/brand";
import { translate, useI18nStore, type TranslationKey } from "../../src/lib/i18n";

const KEY = storageKey("mobile.slashCommands");

/** Lines kept per CLI; past it the oldest goes. */
const MAX_PER_CLI = 30;
/** CLIs kept; past it the one used longest ago goes, with its lines. */
const MAX_CLIS = 20;
/** The longest line kept. A slash command with a paragraph after it is a
 * prompt, not a command worth offering again. */
const MAX_LINE = 200;
/** Rows the menu shows at once. */
export const MAX_SUGGESTIONS = 8;

type SlashStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface StoredLine {
  line: string;
  at: number;
}

interface CatalogEntry {
  /** The command, slash included. */
  command: string;
  /** What the menu says it does, in the phone's language. */
  description: TranslationKey;
  /** Placeholders `description` fills in (the CLI's name). */
  vars?: Record<string, string>;
  /** The command reads an argument, so picking it leaves a space after it. */
  args?: boolean;
}

export interface SlashSuggestion {
  /** What picking it puts in the composer (before any trailing space). */
  line: string;
  description?: string;
  /** Sent from this phone before — the row can be forgotten. */
  used: boolean;
  /** Picking it leaves the cursor after a space, for the argument. */
  args: boolean;
}

/** Which CLI a tab runs, as the store keys it (`agentFamily`, shared with the
 * desktop's steering keys). */
export function slashCli(agentLabel: string): string {
  return agentFamily(agentLabel);
}

/** Only commands each CLI documents; anything unsure is left for the reader's
 * own history to supply — an invented command typed into an agent is worse
 * than no row at all. */
const CATALOG: Record<string, CatalogEntry[]> = {
  claude: [
    { command: "/clear", description: "mobile.slash.cmd.newConversation" },
    { command: "/compact", description: "mobile.slash.cmd.compact", args: true },
    { command: "/context", description: "mobile.slash.cmd.context" },
    { command: "/model", description: "mobile.slash.cmd.model", args: true },
    { command: "/plan", description: "mobile.slash.cmd.plan", args: true },
    { command: "/goal", description: "mobile.slash.cmd.goal", args: true },
    { command: "/usage", description: "mobile.slash.cmd.usage" },
    { command: "/cost", description: "mobile.slash.cmd.cost" },
    { command: "/resume", description: "mobile.slash.cmd.resume" },
    { command: "/rewind", description: "mobile.slash.cmd.rewind" },
    { command: "/review", description: "mobile.slash.cmd.reviewPr", args: true },
    { command: "/init", description: "mobile.slash.cmd.initClaude" },
    { command: "/memory", description: "mobile.slash.cmd.memoryEdit" },
    { command: "/mcp", description: "mobile.slash.cmd.mcpServers" },
    { command: "/agents", description: "mobile.slash.cmd.subagents" },
    { command: "/permissions", description: "mobile.slash.cmd.permissions" },
    { command: "/status", description: "mobile.slash.cmd.status" },
    { command: "/login", description: "mobile.slash.cmd.login" },
    { command: "/logout", description: "mobile.slash.cmd.logout" },
    { command: "/config", description: "mobile.slash.cmd.settings" },
    { command: "/export", description: "mobile.slash.cmd.export", args: true },
    { command: "/add-dir", description: "mobile.slash.cmd.addDir", args: true },
    { command: "/doctor", description: "mobile.slash.cmd.doctor" },
    { command: "/help", description: "mobile.slash.cmd.help" },
  ],
  codex: [
    { command: "/clear", description: "mobile.slash.cmd.newConversation" },
    { command: "/new", description: "mobile.slash.cmd.newCheckout" },
    { command: "/compact", description: "mobile.slash.cmd.compact" },
    { command: "/model", description: "mobile.slash.cmd.modelEffort" },
    { command: "/plan", description: "mobile.slash.cmd.plan", args: true },
    { command: "/goal", description: "mobile.slash.cmd.goal", args: true },
    { command: "/approvals", description: "mobile.slash.cmd.approvals" },
    { command: "/review", description: "mobile.slash.cmd.reviewTree" },
    { command: "/diff", description: "mobile.slash.cmd.diff" },
    { command: "/status", description: "mobile.slash.cmd.sessionConfig" },
    { command: "/mention", description: "mobile.slash.cmd.mention", args: true },
    { command: "/resume", description: "mobile.slash.cmd.resume" },
    { command: "/init", description: "mobile.slash.cmd.initAgents" },
    { command: "/mcp", description: "mobile.slash.cmd.mcpTools" },
    { command: "/quit", description: "mobile.slash.cmd.exit", vars: { name: "Codex" } },
  ],
  gemini: [
    { command: "/clear", description: "mobile.slash.cmd.clearScreen" },
    { command: "/compress", description: "mobile.slash.cmd.compact" },
    { command: "/model", description: "mobile.slash.cmd.model" },
    { command: "/plan", description: "mobile.slash.cmd.plan", args: true },
    { command: "/stats", description: "mobile.slash.cmd.stats" },
    { command: "/memory", description: "mobile.slash.cmd.memoryShow", args: true },
    { command: "/chat", description: "mobile.slash.cmd.chat", args: true },
    { command: "/restore", description: "mobile.slash.cmd.restore", args: true },
    { command: "/tools", description: "mobile.slash.cmd.tools" },
    { command: "/mcp", description: "mobile.slash.cmd.mcpServers" },
    { command: "/directory", description: "mobile.slash.cmd.directory", args: true },
    { command: "/init", description: "mobile.slash.cmd.initGemini" },
    { command: "/settings", description: "mobile.slash.cmd.settings" },
    { command: "/auth", description: "mobile.slash.cmd.auth" },
    { command: "/help", description: "mobile.slash.cmd.help" },
    { command: "/quit", description: "mobile.slash.cmd.exit", vars: { name: "Gemini CLI" } },
  ],
  qwen: [
    { command: "/clear", description: "mobile.slash.cmd.clearScreen" },
    { command: "/compress", description: "mobile.slash.cmd.compact" },
    { command: "/stats", description: "mobile.slash.cmd.stats" },
    { command: "/memory", description: "mobile.slash.cmd.memoryShow", args: true },
    { command: "/tools", description: "mobile.slash.cmd.tools" },
    { command: "/mcp", description: "mobile.slash.cmd.mcpServers" },
    { command: "/init", description: "mobile.slash.cmd.initQwen" },
    { command: "/auth", description: "mobile.slash.cmd.auth" },
    { command: "/help", description: "mobile.slash.cmd.help" },
    { command: "/quit", description: "mobile.slash.cmd.exit", vars: { name: "Qwen Code" } },
  ],
  opencode: [
    { command: "/new", description: "mobile.slash.cmd.newSession" },
    { command: "/compact", description: "mobile.slash.cmd.compactSession" },
    { command: "/models", description: "mobile.slash.cmd.model" },
    { command: "/sessions", description: "mobile.slash.cmd.sessions" },
    { command: "/undo", description: "mobile.slash.cmd.undo" },
    { command: "/redo", description: "mobile.slash.cmd.redo" },
    { command: "/share", description: "mobile.slash.cmd.share" },
    { command: "/init", description: "mobile.slash.cmd.initAgents" },
    { command: "/help", description: "mobile.slash.cmd.help" },
    { command: "/exit", description: "mobile.slash.cmd.exit", vars: { name: "OpenCode" } },
  ],
  aider: [
    { command: "/add", description: "mobile.slash.cmd.add", args: true },
    { command: "/drop", description: "mobile.slash.cmd.drop", args: true },
    { command: "/ls", description: "mobile.slash.cmd.ls" },
    { command: "/ask", description: "mobile.slash.cmd.ask", args: true },
    { command: "/code", description: "mobile.slash.cmd.code", args: true },
    { command: "/architect", description: "mobile.slash.cmd.architect", args: true },
    { command: "/run", description: "mobile.slash.cmd.run", args: true },
    { command: "/test", description: "mobile.slash.cmd.test", args: true },
    { command: "/undo", description: "mobile.slash.cmd.undoAider" },
    { command: "/diff", description: "mobile.slash.cmd.diffAider" },
    { command: "/commit", description: "mobile.slash.cmd.commitAider", args: true },
    { command: "/model", description: "mobile.slash.cmd.switchModel", args: true },
    { command: "/tokens", description: "mobile.slash.cmd.tokens" },
    { command: "/clear", description: "mobile.slash.cmd.clearHistory" },
    { command: "/reset", description: "mobile.slash.cmd.reset" },
    { command: "/help", description: "mobile.slash.cmd.help" },
  ],
};

/** The commands the composer bar offers as chips beside ＋ (`agentDraftPrefixes`,
 * shared with the desktop's steering keys). */
export function draftPrefixes(cli: string): readonly string[] {
  return agentDraftPrefixes(cli);
}

/** The draft's leading command when it is one of `commands`, else null. */
export function draftPrefix(draft: string, commands: readonly string[]): string | null {
  const head = /^\s*(\/[^\s/]+)(?:\s|$)/u.exec(draft)?.[1];
  return head && commands.includes(head) ? head : null;
}

/** A chip's tap: the draft led by `command`, or — when it already is — the
 * draft without it. Another chip's command is replaced, never stacked; the
 * reader's words are kept either way. Nothing is sent. */
export function toggleDraftPrefix(draft: string, command: string, commands: readonly string[]): string {
  const current = draftPrefix(draft, commands);
  const words = current ? draft.replace(/^\s*\/[^\s/]+\s?/u, "") : draft.replace(/^\s+/u, "");
  return current === command ? words : `${command} ${words}`;
}

/** The built-in list for a CLI, empty for one without. */
export function slashCatalog(cli: string): readonly CatalogEntry[] {
  return CATALOG[cli] ?? [];
}

/**
 * The command a bare `/prefix` runs once the CLI's own popup completes it at
 * Enter (`/clea` → `/clear`): the one command — built in, or sent to this CLI
 * before — whose name starts with it. The draft itself when it is a whole
 * command or not a bare `/word`; null when no known command, or more than one,
 * continues it — the popup's pick is then not known here.
 */
export function completedSlashCommand(draft: string, cli: string, used: readonly string[]): string | null {
  const typed = draft.trim();
  if (!/^\/[\w-]+$/u.test(typed)) return typed;
  const prefix = typed.toLowerCase();
  const names = new Set([
    ...slashCatalog(cli).map((entry) => entry.command),
    ...used.map((line) => line.split(" ")[0].toLowerCase()),
  ]);
  if (names.has(prefix)) return typed;
  const matches = [...names].filter((name) => name.startsWith(prefix));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The whole store, or `{}`. Anything not written in this shape is read as
 * absent: a stored line is text the composer offers to send to an agent, so a
 * bad value must mean "nothing was kept", never an odd line in the menu.
 */
function load(storage: SlashStorage): Record<string, StoredLine[]> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const kept: Record<string, StoredLine[]> = {};
    for (const [cli, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const lines = value.filter((entry): entry is StoredLine => !!entry && typeof entry === "object"
        && typeof (entry as StoredLine).line === "string" && isSlashLine((entry as StoredLine).line)
        && typeof (entry as StoredLine).at === "number" && Number.isFinite((entry as StoredLine).at));
      if (lines.length > 0) kept[cli] = lines;
    }
    return kept;
  } catch {
    // A private browser can refuse the store; the menu then offers the
    // built-in list alone.
    return {};
  }
}

function save(storage: SlashStorage, store: Record<string, StoredLine[]>): void {
  const kept = Object.entries(store)
    .filter(([, lines]) => lines.length > 0)
    .sort(([, a], [, b]) => (b[0]?.at ?? 0) - (a[0]?.at ?? 0))
    .slice(0, MAX_CLIS);
  if (kept.length === 0) storage.removeItem(KEY);
  else storage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
}

/** A line the store keeps: one line, a slash, a command name right after it. */
function isSlashLine(line: string): boolean {
  return /^\/[^\s/]/u.test(line) && !/[\r\n]/u.test(line) && line.length <= MAX_LINE;
}

/** The lines sent to this CLI from the phone, newest first. */
export function readSlashCommands(cli: string, storage?: SlashStorage): string[] {
  return (load(storage ?? localStorage)[cli] ?? []).map((entry) => entry.line);
}

/** Keep a slash command the reader just sent to this CLI. Anything that is not
 * a one-line slash command is ignored, so the caller can hand over any draft. */
export function rememberSlashCommand(cli: string, draft: string, storage?: SlashStorage, now: number = Date.now()): void {
  const line = draft.trim().replace(/\s+/gu, " ");
  if (!isSlashLine(line) || /[\r\n]/u.test(draft.trim())) return;
  const store = storage ?? localStorage;
  try {
    const all = load(store);
    const lines = (all[cli] ?? []).filter((entry) => entry.line !== line);
    all[cli] = [{ line, at: now }, ...lines].slice(0, MAX_PER_CLI);
    save(store, all);
  } catch {
    // A full or blocked store costs the menu a row, not the message.
  }
}

/** Drop one kept line — the menu's ✕ on a row the reader no longer wants. */
export function forgetSlashCommand(cli: string, line: string, storage?: SlashStorage): void {
  const store = storage ?? localStorage;
  try {
    const all = load(store);
    if (!all[cli]) return;
    all[cli] = all[cli].filter((entry) => entry.line !== line);
    save(store, all);
  } catch {
    // See rememberSlashCommand.
  }
}

/**
 * What the menu offers for this draft: nothing unless the draft is one line
 * that starts with `/`; then the reader's own lines that continue it, newest
 * first, followed by the built-in commands that do — first those whose name
 * starts with what was typed, then those that merely contain it. The line the
 * draft already is exactly is not offered again.
 */
export function slashSuggestions(draft: string, cli: string, used: readonly string[], limit = MAX_SUGGESTIONS): SlashSuggestion[] {
  const typed = draft.trimStart();
  if (!typed.startsWith("/") || /[\r\n]/u.test(typed)) return [];
  const query = typed.toLowerCase();
  const exact = typed.trimEnd().toLowerCase();
  const catalog = slashCatalog(cli);
  // Read in the language live now: the menu is worked out afresh as the
  // draft changes, and the desktop's slash menu calls this too.
  const lang = useI18nStore.getState().lang;
  const text = (entry: CatalogEntry) => translate(lang, entry.description, entry.vars);
  const describe = (line: string) => {
    const command = line.split(" ")[0].toLowerCase();
    const entry = catalog.find((known) => known.command === command);
    return entry && text(entry);
  };
  const out: SlashSuggestion[] = [];
  const seen = new Set<string>();
  const add = (suggestion: SlashSuggestion) => {
    const key = suggestion.line.toLowerCase();
    if (seen.has(key) || key === exact) return;
    seen.add(key);
    out.push(suggestion);
  };
  for (const line of used) {
    if (line.toLowerCase().startsWith(query)) add({ line, description: describe(line), used: true, args: false });
  }
  for (const entry of catalog) {
    if (entry.command.startsWith(query)) add({ line: entry.command, description: text(entry), used: false, args: !!entry.args });
  }
  // One letter inside a name matches half the list; the fallback waits for two.
  const bare = query.slice(1);
  if (bare.length >= 2 && !/\s/u.test(bare)) {
    for (const entry of catalog) {
      if (entry.command.includes(bare)) add({ line: entry.command, description: text(entry), used: false, args: !!entry.args });
    }
  }
  return out.slice(0, limit);
}
