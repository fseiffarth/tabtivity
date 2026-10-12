import { describe, it, expect } from "vitest";
import { matchAnchorId, renderMarkdown, slugify } from "../../lib/viewers/markdown";
import { generateToc, slugify as editSlugify } from "../../lib/viewers/markdownEdit";
import { useMdAnchorStore } from "../../stores/viewers/mdAnchor";

describe("matchAnchorId", () => {
  const ids = ["project-map", "docs", "agent-instructions", "Config"];

  it("matches an authored slug verbatim", () => {
    expect(matchAnchorId(ids, "docs")).toBe("docs");
  });

  it("slugifies a fragment written as the heading's visible text", () => {
    expect(matchAnchorId(ids, "Agent Instructions")).toBe("agent-instructions");
    expect(slugify("Agent Instructions")).toBe("agent-instructions");
  });

  it("decodes percent-encoded fragments", () => {
    expect(matchAnchorId(ids, "agent%20instructions")).toBe("agent-instructions");
  });

  it("falls back to a case-insensitive match", () => {
    expect(matchAnchorId(ids, "config")).toBe("Config");
    expect(matchAnchorId(ids, "DOCS")).toBe("docs");
  });

  it("returns null when nothing matches, and survives bad escapes", () => {
    expect(matchAnchorId(ids, "nope")).toBeNull();
    expect(matchAnchorId(ids, "%E0%A4%A")).toBeNull(); // malformed escape
  });
});

/** The ids the preview gives its headings, in document order. */
function renderedHeadingIds(md: string): string[] {
  return Array.from(renderMarkdown(md).matchAll(/<h[1-6] id="([^"]*)">/g), (m) => m[1]);
}

/** The `#anchor` of every TOC entry. */
function tocAnchors(md: string): string[] {
  return Array.from(generateToc(md).matchAll(/\]\(#([^)]*)\)$/gm), (m) => m[1]);
}

describe("TOC anchors round-trip to rendered heading ids", () => {
  it("uses one slug for the TOC and the preview (punctuation, edge spaces)", () => {
    expect(editSlugify).toBe(slugify);
    // Trimming after the punctuation is gone: "Q&A ?" is `qa`, not `qa-`.
    expect(slugify("Q&A ?")).toBe("qa");
    expect(tocAnchors("# Q&A ?\n")).toEqual(["qa"]);
    expect(renderedHeadingIds("# Q&A ?\n")).toEqual(["qa"]);
  });

  it("numbers repeated headings the same way on both sides", () => {
    const md = "# Usage\n## Setup\n# Usage\n## Setup\n### Usage!\n";
    expect(renderedHeadingIds(md)).toEqual(["usage", "setup", "usage-1", "setup-1", "usage-2"]);
    expect(tocAnchors(md)).toEqual(renderedHeadingIds(md));
  });

  it("agrees on every heading of a mixed document", () => {
    const md = [
      "# Intro: what & why?",
      "Text.",
      "",
      "Intro: what & why",
      "===",
      "",
      "```",
      "# not a heading",
      "```",
      "## C# notes ##",
      "## `code` and **bold**",
      "## Intro – what & why",
      "- a list",
      "",
      "## Ünïcode Größe",
    ].join("\n");
    const ids = renderedHeadingIds(md);
    expect(ids).toEqual([
      "intro-what-why",
      "intro-what-why-1", // the setext heading counts as a repeat too
      "c-notes",
      "code-and-bold",
      "intro-what-why-2",
      "ncode-gre",
    ]);
    const anchors = tocAnchors(md);
    expect(anchors).toEqual(ids);
    for (const a of anchors) expect(ids).toContain(a);
    // A closing `#` run needs a space before it, so "C#" keeps its hash.
    expect(generateToc(md)).toContain("- [C# notes](#c-notes)");
  });
});

describe("useMdAnchorStore", () => {
  it("records a request per path and bumps the nonce on repeats", () => {
    const store = useMdAnchorStore.getState();
    store.requestAnchor("/p/a.md", "setup");
    let req = useMdAnchorStore.getState().requestsByPath["/p/a.md"];
    expect(req).toEqual({ fragment: "setup", nonce: 1 });

    store.requestAnchor("/p/a.md", "setup");
    req = useMdAnchorStore.getState().requestsByPath["/p/a.md"];
    expect(req.nonce).toBe(2);

    store.requestAnchor("/p/b.md", "other");
    expect(Object.keys(useMdAnchorStore.getState().requestsByPath).sort()).toEqual([
      "/p/a.md",
      "/p/b.md",
    ]);
  });

  it("consume clears only the named path", () => {
    const store = useMdAnchorStore.getState();
    store.requestAnchor("/p/a.md", "x");
    store.requestAnchor("/p/b.md", "y");
    store.consume("/p/a.md");
    const left = useMdAnchorStore.getState().requestsByPath;
    expect(left["/p/a.md"]).toBeUndefined();
    expect(left["/p/b.md"]).toBeDefined();
    store.consume("/p/b.md");
    store.consume("/p/b.md"); // consuming nothing is a no-op
    expect(useMdAnchorStore.getState().requestsByPath).toEqual({});
  });
});
