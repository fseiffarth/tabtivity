import { describe, expect, it } from "vitest";

import { LEGACY_NAMES, NAMES } from "../../lib/brand";
import { inboxLeaves, withoutInboxReferences } from "../../../mobile-web/src/terminal/inboxRefs";

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
});
