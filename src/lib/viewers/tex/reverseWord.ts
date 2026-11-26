import type { CaretPhrase } from "./tex";

/** The PDF word under the pointer and a short reading-order context. Only this
 * snippet crosses windows. The destination matches against its own live draft. */
export type PdfWordPhrase = Pick<CaretPhrase, "words" | "index">;

export const proseWord = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:[-'’][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

/** Case, ligatures, accents and hyphens folded: the PDF shows `Trémaux` where
 * the source may spell `Tr\'emaux`, a font may hand back `ﬁ` for `fi`, and a
 * compound broken at its hyphen across rows reads `walkbased`. */
function normalized(word: string) {
  return word.normalize("NFKC").replace(/’/g, "'").toLowerCase().normalize("NFD").replace(/\p{M}|-/gu, "");
}

/** A TeX accent (`\'e`, `\"{o}`) keeps its word whole: the command's characters
 * become combining marks, which `proseWord` takes inside a word and
 * `normalized` drops, so columns into the line stay put. */
const ACCENT = /\\['"^`~=.](?:\{([\p{L}])\}|(?=\p{L}))/gu;
const MARK = "\u0301";

/** SyncTeX can assign every output row to the end of its TeX paragraph.
 * Rank literal words within that paragraph by contiguous neighbours, using
 * the mapped line to break ties. An indistinguishable hit keeps the line jump.
 * A clicked token the source does not spell (a citation's number) lands on the
 * nearest context word that it does. */
export function locateSourceWord(source: string, line: number, phrase: PdfWordPhrase) {
  const lines = source.split("\n");
  const anchor = Math.min(Math.max(0, line - 1), lines.length - 1);
  let first = anchor;
  let last = anchor;
  while (first > 0 && lines[first - 1].trim()) first--;
  while (last + 1 < lines.length && lines[last + 1].trim()) last++;

  const words: { text: string; line: number; column: number; length: number }[] = [];
  for (let row = first; row <= last; row++) {
    // Blank comments and control sequences in place so offsets into the draft
    // stay UTF-16 columns, even through formatting and escaped percent signs.
    const prose = lines[row]
      .replace(ACCENT, (m, letter?: string) =>
        letter ? MARK.repeat(m.indexOf("{") + 1) + letter + MARK : MARK.repeat(m.length))
      .replace(/\\(?:[a-zA-Z@]+\*?|.)|%.*/g, (m) => " ".repeat(m.length));
    for (const m of prose.matchAll(proseWord)) {
      // A word opening on an accent (`\'Etude`) starts at its backslash.
      let start = m.index;
      while (start > 0 && prose[start - 1] === MARK) start--;
      const end = m.index + m[0].length;
      words.push({ text: normalized(m[0]), line: row + 1, column: start + 1, length: end - start });
    }
  }
  const context = phrase.words.map(normalized);
  const rank = (index: number) => {
    let best: typeof words[number] | undefined;
    let bestScore = -1;
    let bestDistance = Infinity;
    for (const [p, word] of words.entries()) {
      if (word.text !== context[index]) continue;
      let score = 0;
      for (const step of [-1, 1]) {
        let neighbor = index + step;
        let candidate = p + step;
        while (neighbor >= 0 && neighbor < context.length && words[candidate]?.text === context[neighbor]) {
          score++;
          neighbor += step;
          candidate += step;
        }
      }
      const distance = Math.abs(line - word.line);
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        best = word;
        bestScore = score;
        bestDistance = distance;
      } else if (score === bestScore && distance === bestDistance) {
        best = undefined;
      }
    }
    return { best, found: bestScore >= 0 };
  };
  const clicked = rank(phrase.index);
  if (clicked.found) return clicked.best;
  // Not in the source at all: the closest neighbour, the one before first.
  for (let d = 1; d <= 3; d++) {
    for (const index of [phrase.index - d, phrase.index + d]) {
      if (index < 0 || index >= context.length) continue;
      const near = rank(index);
      if (near.found) return near.best;
    }
  }
  return undefined;
}
