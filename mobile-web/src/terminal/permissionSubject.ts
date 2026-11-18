import type { TranslationKey } from "../../../src/lib/i18n";
import type { RunningShell, SessionTranscript, WaitingTool } from "../api";
import type { SelectPrompt } from "./selectPrompt";

/**
 * What a Claude permission dialog is about, from the stored session: the call
 * that has no result yet. The screen's dialog says what it asks (`Do you want
 * to proceed?`) and draws the command or diff it can fit; the transcript holds
 * the whole call, so the card can name it in full.
 *
 * A running, already approved `Bash` call has no result either, so the caller
 * uses this only while the agent is in `decision` (the desktop's lamp; on the
 * phone, a permission dialog on the live screen). The phone's transcript
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

/**
 * The waiting call a permission dialog is about: the newest of the newest
 * `Bash` call that is still waiting (not sent to the background) and the
 * newest of the other tools' waiting calls (`waitingTools`). Null when there is none.
 */
export function permissionSubject(transcript: Pick<SessionTranscript, "shells" | "waitingTools"> | null | undefined): PermissionSubject | null {
  if (!transcript) return null;
  let shell: RunningShell | undefined;
  for (const candidate of transcript.shells ?? []) {
    if (candidate.background) continue;
    // Oldest first: the last of a tie is the newest.
    if (!shell || stamp(candidate.at) >= stamp(shell.at)) shell = candidate;
  }
  let tool: WaitingTool | undefined;
  for (const candidate of transcript.waitingTools ?? []) {
    if (!tool || stamp(candidate.at) >= stamp(tool.at)) tool = candidate;
  }
  if (shell && (!tool || stamp(shell.at) > stamp(tool.at))) {
    const command = bounded(shell.command ?? "");
    return command ? { kind: "command", tool: "Bash", subject: command } : { kind: "tool", tool: "Bash", subject: "" };
  }
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
