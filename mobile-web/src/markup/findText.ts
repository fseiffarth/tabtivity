import { MAX_FOUND_RECTS } from "./frameProtocol";

/**
 * Where a question's `quote` sits on its page, from the page's text runs —
 * the sealed frame's answer to `findText` (`frameProtocol.ts`). It runs inside
 * the frame, beside pdf.js, and leans on nothing but the protocol's bounds.
 *
 * A PDF's runs split words wherever its producer kerned them, so the search
 * ignores whitespace altogether (both the runs' and the quote's), folds case
 * and compatibility forms (ligatures, full-width), and drops the hyphen that
 * ends a line. An agent's quote can run past a line the PDF broke elsewhere:
 * when the whole quote is not found, its first six words are tried, as the
 * desktop's pins do (`quoteRects` in `src/lib/viewers/markupQuestions.ts`).
 */

/** One text run in page points, top-left origin (pdf.js text content under
 * the page's own viewport at scale 1). */
export type TextRun = { str: string; x: number; y: number; w: number; h: number; eol?: boolean };
export type FoundRect = { x: number; y: number; w: number; h: number };

type Haystack = { text: string; at: { run: number; char: number }[] };

function fold(char: string): string {
  return char.normalize("NFKC").toLowerCase();
}

function haystack(runs: readonly TextRun[]): Haystack {
  let text = "";
  const at: Haystack["at"] = [];
  runs.forEach((run, index) => {
    const chars = [...run.str];
    chars.forEach((char, offset) => {
      // A hyphen that ends a line joins the word it broke.
      if (run.eol && offset === chars.length - 1 && (char === "-" || char === "­")) return;
      for (const folded of fold(char)) {
        if (/\s/u.test(folded)) continue;
        text += folded;
        // One entry per UTF-16 unit, so `indexOf`'s positions index it.
        for (let unit = 0; unit < folded.length; unit++) at.push({ run: index, char: offset });
      }
    });
  });
  return { text, at };
}

function needle(quote: string): string {
  return [...quote].map(fold).join("").replace(/\s+/gu, "");
}

function rectsOf(runs: readonly TextRun[], hay: Haystack, start: number, length: number): FoundRect[] {
  const spans = new Map<number, [number, number]>();
  for (let i = start; i < start + length; i++) {
    const { run, char } = hay.at[i];
    const span = spans.get(run);
    spans.set(run, span ? [Math.min(span[0], char), Math.max(span[1], char)] : [char, char]);
  }
  const out: FoundRect[] = [];
  for (const [index, [from, to]] of spans) {
    const run = runs[index];
    const count = Math.max(1, [...run.str].length);
    const rect = { x: run.x + (run.w * from) / count, y: run.y, w: Math.abs((run.w * (to + 1 - from)) / count), h: Math.abs(run.h) };
    if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) continue;
    out.push(rect);
    if (out.length >= MAX_FOUND_RECTS) break;
  }
  return out;
}

/** The boxes of `quote` on the page whose runs are `runs`; empty when not
 * found. */
export function findQuote(runs: readonly TextRun[], quote: string): FoundRect[] {
  const words = quote.trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return [];
  const hay = haystack(runs);
  const tries = [needle(words.join(" "))];
  if (words.length > 6) tries.push(needle(words.slice(0, 6).join(" ")));
  for (const sought of tries) {
    if (!sought) continue;
    const start = hay.text.indexOf(sought);
    if (start >= 0) return rectsOf(runs, hay, start, sought.length);
  }
  return [];
}
