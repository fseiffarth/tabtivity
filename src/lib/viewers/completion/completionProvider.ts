import type { AutocompleteMode } from "../../../types";

export type CompletionProviderId = "ollama" | "copilot";
export type Position = { line: number; character: number };
export type CompletionRange = { start: Position; end: Position };
export type InlineCompletionItem = {
  insertText: string;
  range?: CompletionRange;
  command?: { command: string; arguments?: unknown[]; title?: string };
  [key: string]: unknown;
};

/** Keep the original server item intact, including opaque extension fields.
 * Offsets and ghost text belong to the editor; feedback belongs to the item. */
export type CompletionCandidate = {
  provider: CompletionProviderId;
  id: string;
  version: number;
  text: string;
  at: number;
  range: CompletionRange;
  model?: string;
  mode?: AutocompleteMode;
  original?: InlineCompletionItem;
  /** Original insertText offset corresponding to the first ghost character. */
  acceptedPrefix: number;
};

/** `text-completion-stats-<requestId>`: emitted once by a backend that has it,
 * before `complete_text` returns successfully. An older backend sends none,
 * so every reader treats it as optional. The last five fields are absent when
 * the stream was cut before Ollama's final record. */
export type CompletionStats = {
  endpoint: "generate" | "chat";
  model: string;
  stop: "done" | "line" | "budget";
  firstTokenMs: number | null;
  totalMs: number;
  referenceBytes: number;
  /** True for every FIM request to a model without a known reference layout. */
  referencesDropped: boolean;
  promptEvalCount?: number;
  promptEvalMs?: number;
  evalCount?: number;
  evalMs?: number;
  loadMs?: number;
};

export type CompletionDocument = {
  path: string;
  projectId?: string;
  version: number;
  text: string;
  caret: number;
  language: string;
};

export interface CompletionProvider {
  readonly id: CompletionProviderId;
  readonly capabilities: { streaming: boolean; lengthModes: boolean; references: boolean };
  complete(document: CompletionDocument, signal: AbortSignal,
    publish: (candidates: CompletionCandidate[]) => void): Promise<CompletionCandidate[]>;
}

function validBoundary(text: string, offset: number): boolean {
  return Number.isInteger(offset) && offset >= 0 && offset <= text.length &&
    !(offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset] ?? "")) &&
    !(offset > 0 && text[offset - 1] === "\r" && text[offset] === "\n");
}

/** LSP characters and textarea indices both count UTF-16 code units. Reject
 * invalid boundaries instead of clamping a server edit onto unrelated text. */
export function offsetToPosition(text: string, offset: number): Position | null {
  if (!validBoundary(text, offset)) return null;
  const prefix = text.slice(0, offset);
  const line = (prefix.match(/\n/g) ?? []).length;
  return { line, character: offset - (prefix.lastIndexOf("\n") + 1) };
}

export function positionToOffset(text: string, position: Position): number | null {
  if (!Number.isInteger(position.line) || position.line < 0 ||
      !Number.isInteger(position.character) || position.character < 0) return null;
  let start = 0;
  for (let line = 0; line < position.line; line++) {
    const end = text.indexOf("\n", start);
    if (end < 0) return null;
    start = end + 1;
  }
  const newline = text.indexOf("\n", start);
  let end = newline < 0 ? text.length : newline;
  if (newline >= 0 && end > start && text[end - 1] === "\r") end--;
  const offset = start + position.character;
  return offset <= end && validBoundary(text, offset) ? offset : null;
}

/** Ghost UI can only insert. A replacement is safe only when its existing
 * prefix AND suffix are unchanged around the caret. Snippets are unsupported. */
export function inlineCandidate(document: CompletionDocument, item: InlineCompletionItem,
  id: string): CompletionCandidate | null {
  const position = offsetToPosition(document.text, document.caret);
  if (!position || typeof item.insertText !== "string") return null;
  const range = item.range ?? { start: position, end: position };
  const start = positionToOffset(document.text, range.start);
  const end = positionToOffset(document.text, range.end);
  if (start === null || end === null || start > document.caret || end < document.caret) return null;
  const newline = document.text.includes("\r\n") ? "\r\n" : "\n";
  const insert = item.insertText.replace(/\r\n|\r|\n/g, newline);
  const prefix = document.text.slice(start, document.caret);
  const suffix = document.text.slice(document.caret, end);
  if (!insert.startsWith(prefix) || !insert.endsWith(suffix) || insert.length <= prefix.length + suffix.length) return null;
  // Prefix is measured in the server's original newline representation.
  const normalizedPrefix = prefix.replace(/\r\n|\r/g, "\n");
  let acceptedPrefix = 0;
  let normalized = "";
  while (normalized.length < normalizedPrefix.length && acceptedPrefix < item.insertText.length) {
    const char = item.insertText[acceptedPrefix++];
    if (char === "\r" && item.insertText[acceptedPrefix] === "\n") acceptedPrefix++;
    normalized += char === "\r" ? "\n" : char;
  }
  return { provider: "copilot", id, version: document.version, text: insert.slice(prefix.length, insert.length - suffix.length),
    at: document.caret, range, original: item, acceptedPrefix };
}

/** Feedback is cumulative from the start of the original insertText, even
 * after several word/line/type-through accepts and newline normalization. */
export class CompletionAcceptance {
  private accepted = 0;
  private finished = false;
  constructor(private candidate: CompletionCandidate) {}
  accept(text: string): { full: boolean; acceptedLength: number } | null {
    if (this.finished || !text || !this.candidate.text.slice(this.accepted).startsWith(text)) return null;
    this.accepted += text.length;
    this.finished = this.accepted === this.candidate.text.length;
    const original = this.candidate.original?.insertText ?? this.candidate.text;
    let offset = this.candidate.acceptedPrefix;
    const consumed = this.candidate.text.slice(0, this.accepted).replace(/\r\n|\r/g, "\n");
    let normalized = "";
    while (normalized.length < consumed.length && offset < original.length) {
      const char = original[offset++];
      if (char === "\r" && original[offset] === "\n") offset++;
      normalized += char === "\r" ? "\n" : char;
    }
    return { full: this.finished, acceptedLength: offset };
  }
}
