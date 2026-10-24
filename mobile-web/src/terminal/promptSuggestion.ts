import { agentFamily } from "../../../shared/agentComposer";
import type { ReadableSpan } from "./readableScreen";
import { inputFrameStart, type StatusLineLike } from "./statusLine";

/**
 * Claude Code's prompt suggestion — the likely next message it draws dimmed in
 * its empty input box after a turn (Tab takes it). Probed on 2.1.310:
 *
 *   ❯ make it ask for my name     every character after the `❯` has the dim
 *                                 attribute, the cursor sits on the first one
 *
 * It is on the screen only: no record of the session carries it, so the Chat
 * view reads it here. A typed draft is not dim, which is what tells the two
 * apart; the empty box's own hints are dim as well and are not suggestions
 * (`Try "…"`, the queued-messages line).
 */

type SuggestionLine = StatusLineLike & { spans?: readonly ReadableSpan[] };

const MARKER = /^\s*❯\s*/u;
/** Dim hints Claude Code puts in an empty box: its example prompt and the line
 * naming the queue. Whole-text matches, so a suggestion that merely opens with
 * those words still counts. */
const BOX_HINT = /^(?:try\s+["'“”‘’].*["'“”‘’][?.!]?|press up to edit queued messages\b.*)$/iu;

function isDim(span: ReadableSpan): boolean {
  return (span.className ?? "").split(" ").includes("d");
}

/** Keys and glyphs the rows under the box are made of: a dimmed status line
 * there must not be read as the suggestion's next row. */
const FOOTER = /[⏵⏸⏎⌃⇧]|\?\s*for shortcuts|\bshift\s*\+\s*tab\b|\besc to\b|\bctrl\s*\+/iu;

/** Whether every non-blank character of `line` after its first `skip` ones is
 * dim — the row holds nothing the user typed. */
function dimFrom(line: SuggestionLine, skip: number): boolean {
  let left = skip;
  for (const span of line.spans ?? []) {
    const own = span.text.length;
    const body = left >= own ? "" : span.text.slice(left);
    left = Math.max(0, left - own);
    if (body.trim() && !isDim(span)) return false;
  }
  return (line.spans?.length ?? 0) > 0;
}

/** The suggestion in the bottom input box of a Claude Code screen, or "".
 * A long one wraps in the box on two-space-indented rows, all of them dim. */
export function readPromptSuggestion(lines: readonly SuggestionLine[], agentLabel: string): string {
  if (agentFamily(agentLabel) !== "claude") return "";
  const frame = inputFrameStart(lines, agentLabel);
  for (let index = frame; index < lines.length; index += 1) {
    const marker = MARKER.exec(lines[index].text);
    if (!marker) continue;
    const first = lines[index].text.slice(marker[0].length).trim();
    if (!first || BOX_HINT.test(first) || !dimFrom(lines[index], marker[0].length)) return "";
    const parts = [first];
    for (let next = index + 1; next < lines.length; next += 1) {
      const row = lines[next];
      if (!/^ {2}\S/u.test(row.text) || FOOTER.test(row.text) || !dimFrom(row, 0)) break;
      parts.push(row.text.trim());
    }
    return parts.join(" ");
  }
  return "";
}
