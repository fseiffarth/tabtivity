/**
 * Tests for the per-format viewer helpers (Group K extras):
 *  - capability derivation from a path (format lang, validation lang, preview),
 *  - in-process JSON prettify,
 *  - the Markdown toolbar transforms (toggle inline, cycle heading, line prefix,
 *    link) and table-of-contents generation,
 *  - the sandboxed CSS preview document.
 * All pure — no React/Tauri needed.
 */
import { describe, it, expect } from "vitest";
import {
  formatLangForPath,
  isInProcessJson,
  validationLangForPath,
  previewKindForPath,
  formatJsonText,
  buildPreviewDoc,
  PREVIEW_CSP,
  PREVIEW_CSP_TAG,
  withPreviewGuards,
} from "../../lib/viewers/format";
import {
  toggleInline,
  cycleHeading,
  toggleLinePrefix,
  makeLink,
  generateToc,
  slugify,
} from "../../lib/viewers/markdownEdit";

describe("format capabilities by path", () => {
  it("maps extensions to a backend formatter lang", () => {
    expect(formatLangForPath("/a/style.css")).toBe("css");
    expect(formatLangForPath("/a/app.tsx")).toBe("tsx");
    expect(formatLangForPath("/a/main.py")).toBe("python");
    expect(formatLangForPath("/a/mod.rs")).toBe("rust");
    expect(formatLangForPath("/a/notes.txt")).toBeNull();
  });

  it("treats .json as in-process (no external formatter)", () => {
    expect(isInProcessJson("/a/data.json")).toBe(true);
    expect(formatLangForPath("/a/data.json")).toBeNull();
    expect(isInProcessJson("/a/data.yaml")).toBe(false);
  });

  it("picks the validation language", () => {
    expect(validationLangForPath("/a/data.json")).toBe("json");
    expect(validationLangForPath("/a/conf.yaml")).toBe("yaml");
    expect(validationLangForPath("/a/conf.yml")).toBe("yaml");
    expect(validationLangForPath("/a/main.rs")).toBeNull();
  });

  it("picks the preview kind", () => {
    expect(previewKindForPath("/a/page.html")).toBe("html");
    expect(previewKindForPath("/a/logo.svg")).toBe("svg");
    expect(previewKindForPath("/a/style.css")).toBe("css");
    // SCSS/LESS need compilation, so they are edit-only (no preview).
    expect(previewKindForPath("/a/style.scss")).toBeNull();
    expect(previewKindForPath("/a/main.py")).toBeNull();
  });
});

describe("formatJsonText", () => {
  it("pretty-prints valid JSON with a trailing newline", () => {
    const res = formatJsonText('{"b":1,"a":2}');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe('{\n  "b": 1,\n  "a": 2\n}\n');
  });

  it("reports an error for invalid JSON", () => {
    const res = formatJsonText("{ not json }");
    expect(res.ok).toBe(false);
  });
});

describe("buildPreviewDoc", () => {
  it("wraps SVG in an HTML page as a data: image, behind the policy", () => {
    const doc = buildPreviewDoc("svg", "<svg>é</svg>");
    expect(doc).toContain(PREVIEW_CSP_TAG);
    expect(doc).toContain(`src="data:image/svg+xml;base64,${btoa("<svg>\u00c3\u00a9</svg>")}"`);
    expect(doc).not.toContain("<svg");
  });

  it("puts the policy in front of HTML source", () => {
    expect(buildPreviewDoc("html", "<h1>hi</h1>")).toBe(`${PREVIEW_CSP_TAG}<h1>hi</h1>`);
  });

  it("gives the CSS sample the policy too", () => {
    expect(buildPreviewDoc("css", "h1{}")).toContain(PREVIEW_CSP_TAG);
  });

  it("allows nothing remote and no <base>", () => {
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain("base-uri 'none'");
    expect(PREVIEW_CSP).toContain("form-action 'none'");
    expect(PREVIEW_CSP).not.toMatch(/https?:|\*/);
  });

  it("injects CSS into a sample document", () => {
    const doc = buildPreviewDoc("css", "h1 { color: red }");
    expect(doc).toContain("<style>");
    expect(doc).toContain("h1 { color: red }");
    expect(doc).toContain("<h1>Heading 1</h1>");
  });
});

describe("markdown toolbar transforms", () => {
  it("wraps and unwraps an inline marker", () => {
    const wrapped = toggleInline("ab", 0, 2, "**");
    expect(wrapped.value).toBe("**ab**");
    expect(wrapped.value.slice(wrapped.selStart, wrapped.selEnd)).toBe("ab");
    // Toggling again (markers just outside the selection) removes them.
    const back = toggleInline(wrapped.value, wrapped.selStart, wrapped.selEnd, "**");
    expect(back.value).toBe("ab");
  });

  it("cycles a heading none → # → ## → ### → none", () => {
    let v = "Title";
    v = cycleHeading(v, 0).value; expect(v).toBe("# Title");
    v = cycleHeading(v, 0).value; expect(v).toBe("## Title");
    v = cycleHeading(v, 0).value; expect(v).toBe("### Title");
    v = cycleHeading(v, 0).value; expect(v).toBe("Title");
  });

  it("toggles a bullet prefix across selected lines", () => {
    const v = "one\ntwo";
    const on = toggleLinePrefix(v, 0, v.length, "- ");
    expect(on.value).toBe("- one\n- two");
    const off = toggleLinePrefix(on.value, 0, on.value.length, "- ");
    expect(off.value).toBe("one\ntwo");
  });

  it("makes a link from a selection and selects the url placeholder", () => {
    const r = makeLink("see here", 4, 8); // "here"
    expect(r.value).toBe("see [here](url)");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("url");
  });
});

describe("table of contents", () => {
  it("nests headings by level and links to slugs", () => {
    const md = "# A\n## B C\n### D\n# A\n";
    expect(generateToc(md)).toBe(
      ["- [A](#a)", "  - [B C](#b-c)", "    - [D](#d)", "- [A](#a-1)"].join("\n"),
    );
  });

  it("ignores headings inside fenced code blocks", () => {
    const md = "# Real\n```\n# Not a heading\n```\n";
    expect(generateToc(md)).toBe("- [Real](#real)");
  });

  it("slugifies titles GitHub-style", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });
});

/** The policy `<meta>` must precede the file's own markup, and in-page anchors
 *  must not need a `<base>` (the policy forbids one). */
describe("withPreviewGuards", () => {
  it("goes after a leading doctype, before everything else", () => {
    const doc = withPreviewGuards('<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>');
    expect(doc).toBe(`<!DOCTYPE html>${PREVIEW_CSP_TAG}<html lang="en"><head><title>t</title></head><body></body></html>`);
  });

  it("goes at the very top when there is no doctype", () => {
    expect(withPreviewGuards("<p>x</p>")).toBe(`${PREVIEW_CSP_TAG}<p>x</p>`);
  });

  it("cannot be pushed into a comment by a <head> the file hides", () => {
    const doc = withPreviewGuards("<!-- <head> --><p>x</p>");
    expect(doc.startsWith(PREVIEW_CSP_TAG)).toBe(true);
    expect(withPreviewGuards("<title><head></title>").startsWith(PREVIEW_CSP_TAG)).toBe(true);
  });

  it("keeps a doctype that follows a closed comment", () => {
    expect(withPreviewGuards("<!-- c --><!doctype html><p>")).toBe(`<!-- c --><!doctype html>${PREVIEW_CSP_TAG}<p>`);
  });

  it("cannot be pushed past markup between two comments", () => {
    const doc = withPreviewGuards("<!-- a --><script>x()</script><!-- --><!doctype html><p>");
    expect(doc.startsWith(PREVIEW_CSP_TAG)).toBe(true);
  });

  it("stays fast on many comments and no doctype", () => {
    const html = "<!---->".repeat(20000) + "<!--" + "--><!--".repeat(20000);
    expect(withPreviewGuards(html).startsWith(PREVIEW_CSP_TAG)).toBe(true);
  });

  it("is case-insensitive about the doctype", () => {
    expect(withPreviewGuards("<!DocType HTML>\n<p>")).toBe(`<!DocType HTML>${PREVIEW_CSP_TAG}\n<p>`);
  });

  it("makes fragment links point at the document itself", () => {
    expect(withPreviewGuards('<a href="#top">up</a>')).toContain('<a href="about:srcdoc#top">');
    expect(withPreviewGuards("<a class=x href='#a'>")).toContain("href='about:srcdoc#a'");
    expect(withPreviewGuards("<a href=#a>")).toContain("href=about:srcdoc#a");
    expect(withPreviewGuards('<svg><use xlink:href="#g"/></svg>')).toContain('xlink:href="about:srcdoc#g"');
  });

  it("leaves other links and text alone", () => {
    expect(withPreviewGuards('<a href="page.html#a">x</a>')).toContain('<a href="page.html#a">');
    expect(withPreviewGuards("<p>href=\"#x\"</p>")).toContain('<p>href="#x"</p>');
  });
});
