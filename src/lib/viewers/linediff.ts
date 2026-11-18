/**
 * Pure line-level diff/merge logic for the in-app three-column compare view.
 *
 * Unlike `diff.ts` (which *parses* git's unified-diff output), this diffs two
 * arbitrary strings — the "old" committed version of a file and the live editor
 * content — into aligned rows the compare view renders side-by-side, groups the
 * changes into accept/reject blocks, and assembles/edits the merged result.
 *
 * No DOM, no React — this is the unit-tested logic half of `CompareView.tsx`.
 * Text is preserved verbatim (splitting on "\n" and re-joining round-trips
 * losslessly); the viewer is responsible for HTML-escaping when rendering.
 */

/** One aligned row of the side-by-side diff. `same` rows have equal left/right;
 *  `change` pairs an old line with a new line; `del`/`add` are one-sided. */
export interface AlignRow {
  /** The old-file line, or null for a pure addition. */
  left: string | null;
  /** The new-file line, or null for a pure deletion. */
  right: string | null;
  kind: "same" | "change" | "add" | "del";
}

/** A contiguous run of non-`same` rows — the unit the user accepts or rejects. */
export interface ChangeBlock {
  /** Stable id (its ordinal in the block list). */
  id: number;
  /** Inclusive start index into the `AlignRow[]`. */
  startRow: number;
  /** Exclusive end index into the `AlignRow[]`. */
  endRow: number;
  /** The old-side lines (what "reject" restores). */
  oldLines: string[];
  /** The new-side lines (what "accept" keeps). */
  newLines: string[];
  /** Up to a few unchanged lines immediately before the block (for anchoring
   *  a splice into a hand-edited merge buffer). */
  contextBefore: string[];
  /** Up to a few unchanged lines immediately after the block. */
  contextAfter: string[];
}

/** accept = keep the new (right) side; reject = restore the old (left) side. */
export type Decision = "accept" | "reject";

/** Lines of unchanged context captured on each side of a block for re-anchoring. */
const CONTEXT = 3;

/** Guard against a pathological O(n·m) LCS table. Beyond this the middle region
 *  is treated as a wholesale replace (all old removed, all new added) rather than
 *  risking a huge allocation. */
const LCS_CELL_CAP = 4_000_000;

function splitLines(text: string): string[] {
  return text.split("\n");
}

type Op =
  | { t: "eq"; left: string; right: string }
  | { t: "del"; left: string }
  | { t: "ins"; right: string };

/** Longest-common-subsequence op list between two line arrays. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > LCS_CELL_CAP) {
    // Trivial or too large — emit all deletions then all insertions.
    return [
      ...a.map((left): Op => ({ t: "del", left })),
      ...b.map((right): Op => ({ t: "ins", right })),
    ];
  }
  // dp[i][j] = LCS length of a[i..], b[j..].
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: "eq", left: a[i], right: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "del", left: a[i] });
      i++;
    } else {
      ops.push({ t: "ins", right: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: "del", left: a[i++] });
  while (j < m) ops.push({ t: "ins", right: b[j++] });
  return ops;
}

/** Flush a run of deletions/insertions into rows: pair as many as possible into
 *  `change` rows, then the leftover as one-sided `del`/`add` rows. */
function flushGap(rows: AlignRow[], dels: string[], ins: string[]): void {
  const k = Math.min(dels.length, ins.length);
  for (let x = 0; x < k; x++) rows.push({ left: dels[x], right: ins[x], kind: "change" });
  for (let x = k; x < dels.length; x++) rows.push({ left: dels[x], right: null, kind: "del" });
  for (let x = k; x < ins.length; x++) rows.push({ left: null, right: ins[x], kind: "add" });
}

/**
 * Diff two texts into aligned rows. Trims the common prefix/suffix first (the
 * usual case for an edited file) so the LCS runs only over the changed middle.
 */
export function diffLines(oldText: string, newText: string): AlignRow[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const rows: AlignRow[] = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  for (let i = 0; i < start; i++) rows.push({ left: a[i], right: b[i], kind: "same" });

  const ops = lcsOps(a.slice(start, endA), b.slice(start, endB));
  let dels: string[] = [];
  let ins: string[] = [];
  for (const op of ops) {
    if (op.t === "eq") {
      flushGap(rows, dels, ins);
      dels = [];
      ins = [];
      rows.push({ left: op.left, right: op.right, kind: "same" });
    } else if (op.t === "del") {
      dels.push(op.left);
    } else {
      ins.push(op.right);
    }
  }
  flushGap(rows, dels, ins);

  // Common suffix (a[endA..] and b[endB..] are element-wise equal).
  for (let i = endA, j = endB; i < a.length; i++, j++) {
    rows.push({ left: a[i], right: b[j], kind: "same" });
  }
  return rows;
}

/** Collapse runs of non-`same` rows into accept/reject blocks. */
export function groupChanges(rows: AlignRow[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind === "same") {
      i++;
      continue;
    }
    const startRow = i;
    while (i < rows.length && rows[i].kind !== "same") i++;
    const endRow = i;
    const slice = rows.slice(startRow, endRow);
    const oldLines = slice.filter((r) => r.left != null).map((r) => r.left as string);
    const newLines = slice.filter((r) => r.right != null).map((r) => r.right as string);

    const contextBefore: string[] = [];
    for (let j = startRow - 1; j >= 0 && rows[j].kind === "same" && contextBefore.length < CONTEXT; j--) {
      contextBefore.unshift(rows[j].left as string);
    }
    const contextAfter: string[] = [];
    for (let j = endRow; j < rows.length && rows[j].kind === "same" && contextAfter.length < CONTEXT; j++) {
      contextAfter.push(rows[j].left as string);
    }

    blocks.push({
      id: blocks.length,
      startRow,
      endRow,
      oldLines,
      newLines,
      contextBefore,
      contextAfter,
    });
  }
  return blocks;
}

/**
 * Assemble the merged text from scratch given a decision per block. Unchanged
 * rows contribute their line; each block contributes its new lines (accept, the
 * default) or old lines (reject). With every block accepted this reproduces the
 * new text exactly.
 */
export function buildMerged(
  rows: AlignRow[],
  blocks: ChangeBlock[],
  decisions: Record<number, Decision>,
): string {
  const out: string[] = [];
  let i = 0;
  let bi = 0;
  while (i < rows.length) {
    if (bi < blocks.length && blocks[bi].startRow === i) {
      const b = blocks[bi];
      const dec = decisions[b.id] ?? "accept";
      out.push(...(dec === "accept" ? b.newLines : b.oldLines));
      i = b.endRow;
      bi++;
    } else {
      out.push(rows[i].left as string); // `same` row: left === right
      i++;
    }
  }
  return out.join("\n");
}

/** True when `sub` occurs in `lines` starting at `at` (out-of-range ⇒ false). */
function matchAt(lines: string[], at: number, sub: string[]): boolean {
  if (at < 0 || at + sub.length > lines.length) return false;
  for (let k = 0; k < sub.length; k++) if (lines[at + k] !== sub[k]) return false;
  return true;
}

/**
 * Find where a block's current side sits in a (possibly hand-edited) merge
 * buffer, anchored by its surrounding context. Returns the `{ start, len }`
 * slice range, or null when it can't be located uniquely (e.g. the user edited
 * around it) — in which case the caller disables that block's toggle.
 */
export function locateBlock(
  resultLines: string[],
  block: ChangeBlock,
  decision: Decision,
): { start: number; len: number } | null {
  const side = decision === "accept" ? block.newLines : block.oldLines;
  const before = block.contextBefore;
  const after = block.contextAfter;
  const matches: number[] = [];
  for (let i = 0; i + side.length <= resultLines.length; i++) {
    if (!matchAt(resultLines, i, side)) continue;
    if (!matchAt(resultLines, i - before.length, before)) continue;
    if (!matchAt(resultLines, i + side.length, after)) continue;
    matches.push(i);
    if (matches.length > 1) return null; // ambiguous
  }
  return matches.length === 1 ? { start: matches[0], len: side.length } : null;
}

/** Whether a block can be toggled against the given merge buffer. */
export function canToggle(resultText: string, block: ChangeBlock, decision: Decision): boolean {
  return locateBlock(splitLines(resultText), block, decision) != null;
}

/**
 * Toggle a single block within a hand-editable merge buffer by splicing its
 * region (located via {@link locateBlock}) from its current side to the other.
 * Returns the new text and decision, or null when the block can't be located
 * (the toggle should be disabled). Edits elsewhere in the buffer are preserved.
 */
export function applyBlockToggle(
  resultText: string,
  block: ChangeBlock,
  currentDecision: Decision,
): { text: string; decision: Decision } | null {
  const lines = splitLines(resultText);
  const loc = locateBlock(lines, block, currentDecision);
  if (!loc) return null;
  const next: Decision = currentDecision === "accept" ? "reject" : "accept";
  const replacement = next === "accept" ? block.newLines : block.oldLines;
  lines.splice(loc.start, loc.len, ...replacement);
  return { text: lines.join("\n"), decision: next };
}

/**
 * The 1-based line numbers each change block spans on the left and the right
 * text — the numbers `git blame` reports for that side's file, so a block can be
 * dated per side. A pure addition has no left lines (and a pure deletion no
 * right ones): that side's list is empty, never padded with a neighbour. One
 * pass over the rows serves every block.
 */
export function blockSideLines(
  rows: AlignRow[],
  blocks: ChangeBlock[],
): { left: number[]; right: number[] }[] {
  const out: { left: number[]; right: number[] }[] = [];
  let bi = 0;
  let leftNo = 0;
  let rightNo = 0;
  for (let i = 0; i < rows.length && bi < blocks.length; i++) {
    const b = blocks[bi];
    const left = rows[i].left != null ? ++leftNo : 0;
    const right = rows[i].right != null ? ++rightNo : 0;
    if (i < b.startRow) continue;
    if (i === b.startRow) out[bi] = { left: [], right: [] };
    if (left) out[bi].left.push(left);
    if (right) out[bi].right.push(right);
    if (i === b.endRow - 1) bi++;
  }
  return out;
}
