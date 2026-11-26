/** `locateSourceWord`: where a PDF Ctrl+click's word sits in the TeX draft. */
import { describe, it, expect } from "vitest";
import { locateSourceWord } from "../../lib/viewers/tex/reverseWord";

const SOURCE = [
  "Random walks turn a graph into sequences for node",
  "embeddings~\\cite{grover2016node2vec}, walk-based networks. SMILES",
  "and maze traversals (Tarry, Tr\\'emaux~\\cite{tarry1895}) do so with",
  "local rules and \\\"{O}rdnung.",
].join("\n");

/** The word at a hit, read back out of the source. */
function at(hit: { line: number; column: number; length: number } | undefined) {
  if (!hit) return undefined;
  return SOURCE.split("\n")[hit.line - 1].slice(hit.column - 1, hit.column - 1 + hit.length);
}

describe("locateSourceWord", () => {
  it("finds a word on an earlier row than the paragraph-end line SyncTeX names", () => {
    const hit = locateSourceWord(SOURCE, 4, { words: ["Random", "walks", "turn", "a"], index: 2 });
    expect(hit?.line).toBe(1);
    expect(at(hit)).toBe("turn");
  });

  it("matches an accented PDF word to its TeX accent spelling", () => {
    const hit = locateSourceWord(SOURCE, 4, { words: ["(Tarry", "Trémaux", "16", "do"].map((w) => w.replace("(", "")), index: 1 });
    expect(hit?.line).toBe(3);
    expect(at(hit)).toBe("Tr\\'emaux");
    const braced = locateSourceWord(SOURCE, 4, { words: ["and", "Ordnung"], index: 1 });
    expect(at(braced)).toBe("\\\"{O}rdnung");
  });

  it("matches a compound the PDF broke at its hyphen", () => {
    const hit = locateSourceWord(SOURCE, 4, { words: ["1", "walkbased", "networks"], index: 1 });
    expect(at(hit)).toBe("walk-based");
  });

  it("lands a citation number on the nearest word the source spells", () => {
    const hit = locateSourceWord(SOURCE, 4, { words: ["Tarry", "Trémaux", "16", "do", "so"], index: 2 });
    expect(at(hit)).toBe("Tr\\'emaux");
  });

  it("keeps the line jump for an indistinguishable word", () => {
    expect(locateSourceWord("b a b", 1, { words: ["b"], index: 0 })).toBeUndefined();
  });
});

describe("phraseAtPoint", () => {
  // Two rows of 10pt text, 5pt per character.
  const items = [
    { str: "Abstract. Random tours or", x: 100, y: 100, w: 125, h: 10, eol: true },
    { str: "walks in (molecular) graphs", x: 100, y: 112, w: 135, h: 10 },
  ];

  it("reads the word under the point with its reading-order context", async () => {
    const { phraseAtPoint } = await import("../../lib/viewers/tex/tex");
    // "Random" spans x 150–180 on the first row.
    const phrase = phraseAtPoint(items, 160, 105);
    expect(phrase && phrase.words[phrase.index]).toBe("random");
    expect(phrase?.words).toEqual(["abstract", "random", "tours", "or", "walks", "in", "molecular", "graphs"]);
    // And it is what the editor matches against the draft.
    const hit = locateSourceWord("\\begin{abstract}\nRandom tours or walks in (molecular) graphs", 1, phrase!);
    expect(hit?.line).toBe(2);
  });

  it("takes the nearest word on the row, and nothing far off it", async () => {
    const { phraseAtPoint } = await import("../../lib/viewers/tex/tex");
    const phrase = phraseAtPoint(items, 228, 115);
    expect(phrase && phrase.words[phrase.index]).toBe("graphs");
    expect(phraseAtPoint(items, 400, 105)).toBeUndefined();
    expect(phraseAtPoint(items, 150, 300)).toBeUndefined();
  });
});
