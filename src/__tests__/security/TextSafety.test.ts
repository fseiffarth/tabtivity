/**
 * The bidi/zero-width strip, and the one thing that can silently break it: the
 * TypeScript list and the Rust list drifting apart.
 *
 * The rule is implemented twice because it is needed on both sides of the IPC
 * boundary — `lib/textSafety.ts` for anything the frontend renders, and
 * `services::web_safety::FORMAT_CHARS` for names the backend cleans before it
 * ever hands them over. Two hand-maintained lists of the same characters is
 * exactly the shape that rots: a character added to one side looks handled
 * everywhere, and the gap only shows up as a display that lies. So this test
 * reads the Rust array out of the Rust source and holds the two to each other,
 * the same way `BrowserTripwire` pins `REASON_TOKENS` to its i18n phrases.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { stripFormatControls } from "../../lib/textSafety";

/** The `FORMAT_CHARS` code points, read from the Rust source. */
function rustFormatChars(): string[] {
  const src = readFileSync("src-core/src/services/web_safety.rs", "utf8");
  const decl = /pub const FORMAT_CHARS: &\[char\] = &\[([\s\S]*?)\];/.exec(src);
  if (!decl) throw new Error("FORMAT_CHARS not found in web_safety.rs");
  return [...decl[1].matchAll(/'\\u\{([0-9A-Fa-f]+)\}'/g)].map((m) =>
    String.fromCodePoint(parseInt(m[1], 16)),
  );
}

describe("stripFormatControls", () => {
  it("removes the disguises it exists for", () => {
    // The canonical RLO filename trick, and its calendar/browser equivalents.
    expect(stripFormatControls("invoice\u202Egnp.exe")).toBe("invoicegnp.exe");
    expect(stripFormatControls("Standup\u200B")).toBe("Standup");
    expect(stripFormatControls("a\u2066b\u2069c")).toBe("abc");
  });

  it("leaves ordinary text — including non-ASCII — completely alone", () => {
    // The failure mode worth guarding is over-stripping: this runs over every
    // event title and mail subject, so mangling normal text would be worse than
    // the attack it prevents.
    for (const s of ["Team sync", "Café ☕ 14:00", "Änderung", "日本語", "a-b_c.d"]) {
      expect(stripFormatControls(s)).toBe(s);
    }
  });

  it("is idempotent", () => {
    const once = stripFormatControls("x\u202Ey\u200Bz");
    expect(stripFormatControls(once)).toBe(once);
  });
});

describe("the TS and Rust format-character lists do not drift", () => {
  const RUST = rustFormatChars();

  it("finds a non-trivial list in the Rust source", () => {
    // Guards the regex above: a silently-empty parse would make the next test
    // vacuously pass and hide any drift it exists to catch.
    expect(RUST.length).toBeGreaterThan(10);
  });

  it("strips every character Rust strips", () => {
    const survivors = RUST.filter((c) => stripFormatControls(`a${c}b`) !== "ab");
    expect(
      survivors.map((c) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase()),
    ).toEqual([]);
  });

  it("strips nothing Rust keeps", () => {
    // The other direction: a character the frontend removes but the backend
    // leaves is drift too — the same string would render differently depending
    // on which side cleaned it.
    const rust = new Set(RUST);
    const extra: string[] = [];
    for (let cp = 0x00a0; cp <= 0xfeff; cp++) {
      const c = String.fromCodePoint(cp);
      const strippedHere = stripFormatControls(`a${c}b`) === "ab";
      if (strippedHere && !rust.has(c)) {
        extra.push("U+" + cp.toString(16).toUpperCase());
      }
    }
    expect(extra).toEqual([]);
  });
});
