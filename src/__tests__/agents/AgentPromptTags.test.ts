/**
 * Tags on collected prompts — pure, so what is tested is what a typed line
 * becomes.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_TAGS,
  formatTags,
  normalizeTag,
  parseTags,
  tagCounts,
} from "../../lib/agents/prompt/tags";

describe("parseTags", () => {
  it("normalizes the way the backend does: lowercase tokens, no #, no whitespace", () => {
    expect(normalizeTag(" #Refactor ")).toBe("refactor");
    expect(normalizeTag("Unit   Tests")).toBe("unit-tests");
    expect(normalizeTag("##")).toBe("");
    expect(parseTags("#Refactor, tests,,paper\nTESTS  writing")).toEqual([
      "refactor",
      "tests",
      "paper",
      "tests-writing",
    ]);
    // A `#` starts a new tag even without a comma; a plain space does not.
    expect(parseTags("#a #b c")).toEqual(["a", "b-c"]);
  });

  it("caps the list and the tag length rather than failing the save", () => {
    const many = Array.from({ length: MAX_TAGS + 4 }, (_, i) => `t${i}`).join(", ");
    expect(parseTags(many)).toHaveLength(MAX_TAGS);
    expect(parseTags("x".repeat(80))[0]).toHaveLength(32);
  });

  it("round-trips through the editor's line", () => {
    const tags = parseTags("paper, tex");
    expect(formatTags(tags)).toBe("paper, tex");
    expect(parseTags(formatTags(tags))).toEqual(tags);
    expect(formatTags(undefined)).toBe("");
  });
});

describe("tagCounts", () => {
  it("offers the tags in use, most used first", () => {
    expect(
      tagCounts([
        { tags: ["paper", "writing"] },
        { tags: ["refactor"] },
        {},
        { tags: ["refactor"] },
      ]),
    ).toEqual([
      { tag: "refactor", count: 2 },
      { tag: "paper", count: 1 },
      { tag: "writing", count: 1 },
    ]);
  });
});
