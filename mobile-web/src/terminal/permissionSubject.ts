import type { TranslationKey } from "../../../src/lib/i18n";
import { basename } from "../../../src/lib/paths";
import type { SessionTranscript } from "../api";
import type { SelectPrompt } from "./selectPrompt";

/**
 * What a Claude permission dialog is about, from the stored session: the call
 * that has no result yet. The screen's dialog says what it asks (`Do you want
 * to proceed?`) and draws the command or diff it can fit; the transcript holds
 * the whole call, so the card can name it in full.
 *
 * A running, already approved `Bash` call has no result either, so a call
 * heads a dialog only when the dialog on screen is about it (`permissionSubject`
 * matches the dialog's own text); the desktop also asks only while its lamp
 * says the agent asks, the phone while a permission dialog is on its screen. The phone's transcript
 * carries the subjects masked by the desktop (`shell_mask`): a command is
 * project-relative with secrets hidden, a path is project-relative or its
 * leaf, a URL is its host. Nothing here masks anything itself.
 */
export interface PermissionSubject {
  /** What the subject is: a command, a file path, a URL, or no subject (the tool's name only). */
  kind: "command" | "file" | "url" | "tool";
  /** The call's tool (`Bash`, `Edit`, `WebFetch`, …). */
  tool: string;
  /** Plain text, one bounded line or a short command; empty for `tool`. */
  subject: string;
}

/** The subject as shown: bounded (the desktop bounds it too). */
const SUBJECT_CHARS = 500;
const SUBJECT_LINES = 8;

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function bounded(text: string): string {
  const lines = text.split("\n");
  const kept = (lines.length > SUBJECT_LINES ? lines.slice(0, SUBJECT_LINES) : lines).join("\n");
  return (kept.length > SUBJECT_CHARS ? kept.slice(0, SUBJECT_CHARS) : kept).trimEnd();
}

/** `at` as a sortable stamp: records carry ISO times; a missing one sorts first. */
const stamp = (at: string | undefined): string => at ?? "";

const squash = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** How many of a command's leading words are checked against the dialog (a
 * dialog may cut a long command short). */
const COMMAND_WORDS = 12;

/**
 * Whether the dialog prints this command. The phone's command arrives masked
 * (a project path made relative, other paths cut to `…/leaf`, secrets as
 * `•••`), so it is compared word by word: a masked word is stripped of its
 * `…/` prefix or skipped, every other one has to be on screen. A command with
 * nothing left to check matches nothing.
 */
function dialogPrints(command: string, dialog: string): boolean {
  let checked = 0;
  for (const word of squash(command).split(" ").slice(0, COMMAND_WORDS)) {
    if (word.includes("•")) continue;
    const bare = word.replace(/^(?:…|\.\.\.)\//u, "");
    if (!bare) continue;
    if (!dialog.includes(bare)) return false;
    checked += 1;
  }
  return checked > 0;
}

/** The dialog's own wording for what it asks to change: Claude Code's edit,
 * create and overwrite prompts (`Do you want to make this edit to …?`, `Do you
 * want to create …?`), and their `Edit file` / `Create file` headings. */
const FILE_DIALOG = /make this edit|want to (?:create|overwrite)|\b(?:edit|create|write|overwrite) (?:file|notebook)\b|allow all edits/iu;
/** A fetch prompt (`Do you want to allow Claude to fetch this content?`). */
const FETCH_DIALOG = /\bfetch\b/iu;

const newest = <T extends { at?: string }>(list: readonly T[]): T | undefined => {
  let found: T | undefined;
  // Oldest first: of a tie, the later in the list.
  for (const item of list) if (!found || stamp(item.at) >= stamp(found.at)) found = item;
  return found;
};

/**
 * The waiting call a permission dialog is about, from the stored session —
 * only a call that belongs to the dialog on screen (`dialog`: its lines, the
 * text above it and its option labels):
 *
 * - a `Bash` call (not sent to the background) whose command the dialog
 *   prints; of several, the newest;
 * - else a file tool's call when the dialog is an edit / create prompt, a
 *   `WebFetch` when it is a fetch prompt — the newest of that family, one
 *   whose file the dialog names first;
 * - else nothing: a call in flight that the dialog is not about (an `Agent`
 *   run, a running approved command) never heads it.
 */
export function permissionSubject(
  transcript: Pick<SessionTranscript, "shells" | "waitingTools"> | null | undefined,
  dialog: readonly string[],
): PermissionSubject | null {
  if (!transcript) return null;
  const text = squash(dialog.join(" "));
  const shell = newest((transcript.shells ?? []).filter((candidate) => !candidate.background && dialogPrints(candidate.command ?? "", text)));
  if (shell) {
    const command = bounded(shell.command ?? "");
    return command ? { kind: "command", tool: "Bash", subject: command } : { kind: "tool", tool: "Bash", subject: "" };
  }
  const family = FILE_DIALOG.test(text) ? (name: string) => FILE_TOOLS.has(name) : FETCH_DIALOG.test(text) ? (name: string) => name === "WebFetch" : null;
  if (!family) return null;
  const same = (transcript.waitingTools ?? []).filter((candidate) => family(candidate.name));
  const named = same.filter((candidate) => {
    const leaf = candidate.subject ? basename(candidate.subject) : "";
    return !!leaf && text.includes(leaf);
  });
  const tool = newest(named.length > 0 ? named : same);
  if (!tool) return null;
  const subject = bounded(tool.subject ?? "");
  if (subject && FILE_TOOLS.has(tool.name)) return { kind: "file", tool: tool.name, subject };
  if (subject && tool.name === "WebFetch") return { kind: "url", tool: tool.name, subject };
  return { kind: "tool", tool: tool.name, subject: "" };
}

/** The words that head the subject: what the agent waits for approval to do. */
export function permissionSubjectLabel(kind: PermissionSubject["kind"]): TranslationKey {
  switch (kind) {
    case "command": return "terminal.reader.permissionRun";
    case "file": return "terminal.reader.permissionFile";
    case "url": return "terminal.reader.permissionUrl";
    default: return "terminal.reader.permissionTool";
  }
}

/**
 * Whether `question` is a permission dialog (a call the agent wants approved)
 * rather than an agent's own question: neither a tab row, nor the transcript's
 * entry, nor another dialog's reading (OpenCode's), nor the review step.
 */
export function isPermissionDialog(question: SelectPrompt | null, tabCount: number): boolean {
  return !!question && tabCount === 0 && !question.review && question.source === undefined && !question.navigation;
}
