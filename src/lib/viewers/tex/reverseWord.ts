import type { CaretPhrase } from "./tex";

/** The PDF word under the pointer and a short reading-order context. Only this
 * snippet crosses windows. The destination matches against its own live draft. */
export type PdfWordPhrase = Pick<CaretPhrase, "words" | "index">;

export const proseWord = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:[-'’][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

function normalized(word: string) {
  return word.normalize("NFKC").replace(/’/g, "'").toLowerCase();
}

/** SyncTeX can assign every output row to the end of its TeX paragraph.
 * Rank literal words within that paragraph by contiguous neighbours, using
 * the mapped line to break ties. An indistinguishable hit keeps the line jump. */
export function locateSourceWord(source: string, line: number, phrase: PdfWordPhrase) {
  const lines = source.split("\n");
  const anchor = Math.min(Math.max(0, line - 1), lines.length - 1);
  let first = anchor;
  let last = anchor;
  while (first > 0 && lines[first - 1].trim()) first--;
  while (last + 1 < lines.length && lines[last + 1].trim()) last++;

  const words: { text: string; line: number; column: number }[] = [];
  for (let row = first; row <= last; row++) {
    // Blank comments and control sequences in place so offsets into the draft
    // stay UTF-16 columns, even through formatting and escaped percent signs.
    const prose = lines[row].replace(/\\(?:[a-zA-Z@]+\*?|.)|%.*/g, (m) => " ".repeat(m.length));
    for (const m of prose.matchAll(proseWord)) {
      words.push({ text: normalized(m[0]), line: row + 1, column: m.index + 1 });
    }
  }
  const context = phrase.words.map(normalized);
  const index = phrase.index;
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
  return best;
}
