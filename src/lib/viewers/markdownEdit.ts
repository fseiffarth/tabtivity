/**
 * Pure text transforms backing the Markdown editing toolbar (bold/italic/code/
 * heading/link/list) and the "Insert table of contents" action. Each transform
 * takes the buffer plus a selection `[start, end)` and returns the new buffer
 * with an updated selection, so the editor can apply it through its normal
 * set-value path (keeping undo/redo and highlighting consistent). Exported
 * for unit testing; the only dependency is the renderer's heading pass, which
 * the TOC must agree with.
 */

import { markdownHeadings, slugify } from "./markdown";

export interface EditResult {
  value: string;
  selStart: number;
  selEnd: number;
}

/**
 * Toggle an inline `marker` (e.g. `**`, `_`, `` ` ``) around the selection. If
 * the selection is already wrapped — either the markers sit just outside it, or
 * they are the first/last characters of the selection — they are removed;
 * otherwise they are added. The selection is kept on the inner text.
 */
export function toggleInline(
  value: string,
  start: number,
  end: number,
  marker: string,
): EditResult {
  const sel = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const m = marker.length;

  // Markers immediately outside the selection → unwrap them.
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return {
      value: before.slice(0, -m) + sel + after.slice(m),
      selStart: start - m,
      selEnd: end - m,
    };
  }
  // Markers are the outermost chars of the selection → strip them.
  if (sel.length >= m * 2 && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(m, sel.length - m);
    return { value: before + inner + after, selStart: start, selEnd: start + inner.length };
  }
  // Otherwise wrap.
  return {
    value: before + marker + sel + marker + after,
    selStart: start + m,
    selEnd: end + m,
  };
}

/** The `[lineStart, lineEnd)` of the line containing offset `pos`. */
function lineBounds(value: string, pos: number): [number, number] {
  const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = value.indexOf("\n", pos);
  if (lineEnd === -1) lineEnd = value.length;
  return [lineStart, lineEnd];
}

/**
 * Cycle the heading level of the line at `pos`: none → `#` → `##` → `###` →
 * none. The caret is kept at the same place within the line text.
 */
export function cycleHeading(value: string, pos: number): EditResult {
  const [ls, le] = lineBounds(value, pos);
  const line = value.slice(ls, le);
  const m = line.match(/^(#{1,6})\s+/);
  const cur = m ? m[1].length : 0;
  const rest = m ? line.slice(m[0].length) : line.replace(/^\s+/, "");
  const next = cur >= 3 ? 0 : cur + 1;
  const newLine = next === 0 ? rest : `${"#".repeat(next)} ${rest}`;
  const delta = newLine.length - line.length;
  const caret = Math.max(ls, pos + delta);
  return {
    value: value.slice(0, ls) + newLine + value.slice(le),
    selStart: caret,
    selEnd: caret,
  };
}

/**
 * Toggle a line `prefix` (e.g. `"- "` for a bullet list) on every line the
 * selection touches: if all such lines already carry it, remove it; otherwise
 * add it. The selection is expanded to cover the affected lines.
 */
export function toggleLinePrefix(
  value: string,
  start: number,
  end: number,
  prefix: string,
): EditResult {
  const blockStart = value.lastIndexOf("\n", start - 1) + 1;
  let blockEnd = value.indexOf("\n", end > start ? end - 1 : end);
  if (blockEnd === -1) blockEnd = value.length;
  const block = value.slice(blockStart, blockEnd);
  const lines = block.split("\n");
  const allPrefixed = lines.every((l) => l.startsWith(prefix));
  const next = lines
    .map((l) => (allPrefixed ? l.slice(prefix.length) : prefix + l))
    .join("\n");
  return {
    value: value.slice(0, blockStart) + next + value.slice(blockEnd),
    selStart: blockStart,
    selEnd: blockStart + next.length,
  };
}

/**
 * Wrap the selection as a Markdown link `[text](url)`. With a non-empty
 * selection it becomes the link text and the `url` placeholder is selected;
 * with no selection a `text` placeholder is selected so the user can type it.
 */
export function makeLink(value: string, start: number, end: number): EditResult {
  const sel = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  if (sel) {
    const inserted = `[${sel}](url)`;
    const urlStart = start + sel.length + 3; // after "[sel]("
    return { value: before + inserted + after, selStart: urlStart, selEnd: urlStart + 3 };
  }
  const inserted = "[text](url)";
  return { value: before + inserted + after, selStart: start + 1, selEnd: start + 5 };
}

/** The heading slug lives with the renderer, which ids the headings a TOC
 *  links to; re-exported for callers that already import it from here. */
export { slugify };

/**
 * Generate a Markdown table-of-contents list from the document's headings,
 * nested by level (relative to the shallowest heading) and linking to each
 * heading's GitHub-style anchor. The headings and their anchors come from the
 * renderer's own pass (`markdownHeadings`), so every link names an id the
 * preview has — punctuation, setext headings and repeats (`-1`, `-2`, …)
 * included. Returns an empty string when there are no headings.
 */
export function generateToc(markdown: string): string {
  const headings = markdownHeadings(markdown).filter((h) => h.text.trim());
  if (headings.length === 0) return "";
  const min = Math.min(...headings.map((h) => h.level));
  return headings
    .map((h) => {
      const indent = "  ".repeat(h.level - min);
      return `${indent}- [${h.text.trim()}](#${h.id})`;
    })
    .join("\n");
}

/** The list/quote marker a Markdown line opens with, split into its parts.
 *  `indent` is the leading whitespace, `marker` the bullet/number/`>` plus the
 *  space after it, and `body` what the user actually wrote on the line. */
export interface LineMarker {
  indent: string;
  marker: string;
  body: string;
  /** The number of an ordered item (`3.` → 3), null for bullets and quotes. */
  ordinal: number | null;
  /** A task item's checkbox (`[ ] `/`[x] `), "" when the item has none. */
  checkbox: string;
}

/** Read the list/quote marker opening the line containing `pos`, or null when
 *  the line is ordinary prose. Bullets, ordered items (`1.` / `1)`), task boxes
 *  and block quotes are all markers, because all four are structure a prompt
 *  continues onto the next line. */
export function markerAt(value: string, pos: number): LineMarker | null {
  const [ls, le] = lineBounds(value, pos);
  const line = value.slice(ls, le);
  const list = line.match(/^(\s*)([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?(.*)$/);
  if (list) {
    const ordered = list[2].match(/^(\d+)/);
    return {
      indent: list[1],
      marker: `${list[2]} `,
      body: list[4],
      ordinal: ordered ? Number(ordered[1]) : null,
      checkbox: list[3] ? "[ ] " : "",
    };
  }
  const quote = line.match(/^(\s*)(>[ \t]?)(.*)$/);
  if (quote) {
    return { indent: quote[1], marker: quote[2], body: quote[3], ordinal: null, checkbox: "" };
  }
  return null;
}

/**
 * Enter inside a list item or quote: carry the marker onto the next line
 * (incrementing an ordered item, emptying a task's checkbox) so a structured
 * prompt keeps its structure while it is being typed. On an item whose body is
 * already empty the marker is dropped instead — the usual way out of a list.
 * Returns null when the line carries no marker, leaving Enter alone.
 */
export function continueList(value: string, pos: number): EditResult | null {
  const m = markerAt(value, pos);
  if (!m) return null;
  const [ls] = lineBounds(value, pos);
  // An empty item ends the list: the whole marker goes, the caret stays put.
  if (!m.body.trim()) {
    const rest = ls + m.indent.length + m.marker.length + m.checkbox.length;
    if (pos < rest) return null; // caret is inside the marker itself — leave it.
    return { value: value.slice(0, ls) + value.slice(rest), selStart: ls, selEnd: ls };
  }
  const marker = m.ordinal != null ? `${m.ordinal + 1}${m.marker.slice(-2)}` : m.marker;
  const inserted = `\n${m.indent}${marker}${m.checkbox}`;
  const caret = pos + inserted.length;
  return {
    value: value.slice(0, pos) + inserted + value.slice(pos),
    selStart: caret,
    selEnd: caret,
  };
}

/**
 * Indent (or, with `outdent`, unindent) every line the selection touches by two
 * spaces — how a nested list level is made. A collapsed selection moves its own
 * line and keeps the caret where it was relative to the text.
 */
export function indentLines(
  value: string,
  start: number,
  end: number,
  outdent: boolean,
): EditResult {
  const unit = "  ";
  const blockStart = value.lastIndexOf("\n", start - 1) + 1;
  let blockEnd = value.indexOf("\n", end > start ? end - 1 : end);
  if (blockEnd === -1) blockEnd = value.length;
  const lines = value.slice(blockStart, blockEnd).split("\n");
  let firstDelta = 0;
  let total = 0;
  const next = lines
    .map((line, i) => {
      let out: string;
      if (outdent) {
        const strip = line.startsWith(unit) ? unit.length : line.startsWith(" ") ? 1 : 0;
        out = line.slice(strip);
      } else {
        out = unit + line;
      }
      const delta = out.length - line.length;
      if (i === 0) firstDelta = delta;
      total += delta;
      return out;
    })
    .join("\n");
  const caret = Math.max(blockStart, start + firstDelta);
  return {
    value: value.slice(0, blockStart) + next + value.slice(blockEnd),
    selStart: caret,
    selEnd: start === end ? caret : Math.max(caret, end + total),
  };
}
