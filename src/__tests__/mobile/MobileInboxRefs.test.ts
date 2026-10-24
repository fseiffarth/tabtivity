import { describe, expect, it } from "vitest";

import { LEGACY_NAMES, NAMES } from "../../lib/brand";
import { inboxInPlace, inboxLeaves, inboxSegments, withoutInboxReferences } from "../../../mobile-web/src/terminal/inboxRefs";

const ref = (leaf: string) => `@${NAMES.inboxDir}/${leaf}`;

describe("inbox references in a prompt", () => {
  it("reads the leaves the composer appended, once each, in order", () => {
    const text = `look at these ${ref("20261003-101500-a.png")} ${ref("20261003-101501-b.pdf")} ${ref("20261003-101500-a.png")} `;
    expect(inboxLeaves(text)).toEqual(["20261003-101500-a.png", "20261003-101501-b.pdf"]);
    expect(withoutInboxReferences(text)).toBe("look at these");
  });

  it("reads an older build's folder and letters of any script", () => {
    const text = `@${LEGACY_NAMES.inboxDir}/20260901-080000-Größe_Foto.jpg`;
    expect(inboxLeaves(text)).toEqual(["20260901-080000-Größe_Foto.jpg"]);
    expect(withoutInboxReferences(text)).toBe("");
  });

  it("keeps a sentence's dot and the words around a reference inside it", () => {
    const text = `I marked it.\nPage 2: ${ref("x-p2-layer.png")}.\nThanks`;
    expect(inboxLeaves(text)).toEqual(["x-p2-layer.png"]);
    expect(withoutInboxReferences(text)).toBe("I marked it.\nPage 2: .\nThanks");
  });

  it("is not fooled by an address, another folder or a path inside a word", () => {
    for (const text of [
      `mail me@${NAMES.inboxDir}/a.png`,
      `@${NAMES.outboxDir}/a.png`,
      `@src/inbox/a.png`,
      `\`${NAMES.inboxDir}/a.png\``,
    ]) {
      expect(inboxLeaves(text)).toEqual([]);
      expect(withoutInboxReferences(text)).toBe(text.trim());
    }
  });

  it("closes the blank lines a reference on its own line leaves", () => {
    const text = `first\n\n${ref("a.png")}\n\nsecond`;
    expect(withoutInboxReferences(text)).toBe("first\n\nsecond");
  });

  it("splits a markup prompt where its pictures stand, so each sits under its caption", () => {
    const text = [
      "I marked these changes by hand on `renders/corner.png`.",
      "The picture with my marks drawn on it:",
      ref("20261024-191900-corner-marked.png"),
      "My markup layer alone, the size of the picture:",
      ref("20261024-191900-corner-layer.png"),
      "My typed notes:",
      "- m1: red pen mark",
    ].join("\n");
    const segments = inboxSegments(text);
    expect(segments).toEqual([
      { kind: "words", text: "I marked these changes by hand on `renders/corner.png`.\nThe picture with my marks drawn on it:" },
      { kind: "files", leaves: ["20261024-191900-corner-marked.png"] },
      { kind: "words", text: "My markup layer alone, the size of the picture:" },
      { kind: "files", leaves: ["20261024-191900-corner-layer.png"] },
      { kind: "words", text: "My typed notes:\n- m1: red pen mark" },
    ]);
    expect(inboxInPlace(segments)).toBe(true);
  });

  it("keeps the composer's run of references one album, a repeat left out", () => {
    const text = `look at these ${ref("a.png")} ${ref("b.pdf")}\n${ref("a.png")} `;
    const segments = inboxSegments(text);
    expect(segments).toEqual([
      { kind: "words", text: "look at these" },
      { kind: "files", leaves: ["a.png", "b.pdf"] },
    ]);
    expect(inboxInPlace(segments)).toBe(false);
    // A sentence's dot stays with the words after the picture.
    expect(inboxSegments(`Page 1: ${ref("p1.png")}.\nPage 2: ${ref("p2.png")}`)).toEqual([
      { kind: "words", text: "Page 1:" },
      { kind: "files", leaves: ["p1.png"] },
      { kind: "words", text: ".\nPage 2:" },
      { kind: "files", leaves: ["p2.png"] },
    ]);
  });
});
