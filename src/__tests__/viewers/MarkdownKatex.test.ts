/**
 * The markdown preview's math, rendered by the REAL KaTeX.
 *
 * `MarkdownEnrich.test.ts` mocks KaTeX and pins the call — which TeX, which
 * options. This file pins what those options DO in the version we ship: that a
 * broken expression leaves an error note instead of throwing (one bad `$…$`
 * must not blank the preview), that `trust: false` keeps `\href`, `\htmlClass`
 * and friends from becoming live elements in the app window, that input KaTeX
 * only warns about under the default `strict` still renders, and the
 * HTML + MathML shape the preview and its print path are built around. Only
 * mermaid is mocked (its renderer needs a real layout engine).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("mermaid", () => ({ default: { render: vi.fn(), initialize: vi.fn() } }));

import { enrichMarkdownDom } from "../../lib/viewers/markdownEnrich";
import { renderMarkdown } from "../../lib/viewers/markdown";
import { MARKDOWN_PRINT_CSS, buildPrintDoc } from "../../lib/viewers/print";

async function rendered(markdown: string): Promise<HTMLElement> {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(markdown);
  document.body.appendChild(el);
  await enrichMarkdownDom(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("KaTeX output shape", () => {
  it("renders inline math as KaTeX's HTML + MathML pair, inside the placeholder", async () => {
    const el = await rendered("Inline $a^2$ here");
    const span = el.querySelector("span.md-math")!;
    const katex = span.querySelector(":scope > .katex")!;
    expect(katex).not.toBeNull();
    expect(span.querySelector(".katex-display")).toBeNull();
    // The visual half is hidden from assistive tech; the MathML half carries the
    // semantics and the original TeX.
    expect(katex.querySelector(":scope > .katex-html")?.getAttribute("aria-hidden")).toBe("true");
    const math = katex.querySelector(":scope > .katex-mathml > math")!;
    expect(math.getAttribute("display")).not.toBe("block");
    expect(math.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe("a^2");
  });

  it("renders block math in display mode", async () => {
    const el = await rendered("$$\\sum_i x_i$$");
    const span = el.querySelector("span.md-math")!;
    expect(span.querySelector(":scope > .katex-display > .katex")).not.toBeNull();
    expect(span.querySelector("math")?.getAttribute("display")).toBe("block");
  });

  it("de-escapes the TeX the renderer escaped before KaTeX parses it", async () => {
    const el = await rendered("$a<b$");
    expect(el.querySelector(".katex-error")).toBeNull();
    expect(el.querySelector("annotation")?.textContent).toBe("a<b");
    expect(el.querySelector("math mo")?.textContent).toBe("<");
  });
});

describe("a broken expression", () => {
  it("leaves KaTeX's error note in place of that one expression, and never throws", async () => {
    const el = await rendered("Good $x^2$ then bad $\\frac{1}{$ then good $y$");
    const spans = Array.from(el.querySelectorAll("span.md-math"));
    expect(spans).toHaveLength(3);
    const note = spans[1].querySelector(".katex-error")!;
    expect(note).not.toBeNull();
    // The note shows the source as text and the parse error as its tooltip.
    expect(note.textContent).toBe("\\frac{1}{");
    expect(note.getAttribute("title")).toMatch(/^ParseError: KaTeX parse error/);
    // Its neighbours still render.
    expect(spans[0].querySelector(".katex")).not.toBeNull();
    expect(spans[2].querySelector(".katex")).not.toBeNull();
  });

  it("an undefined command renders as red source text, not an exception", async () => {
    const el = await rendered("$\\nosuchcommand{x}$");
    const flagged = Array.from(el.querySelectorAll<HTMLElement>(".katex-html *")).filter(
      (n) => n.style.color !== "" && n.textContent === "\\nosuchcommand",
    );
    expect(flagged.length).toBeGreaterThan(0);
  });
});

describe("untrusted TeX (trust: false)", () => {
  // A markdown file is project content — attacker-controlled. KaTeX's HTML
  // extensions would otherwise put a link, an id, a class or a style of the
  // file's choosing into the app window.
  it.each([
    ["\\href", "$\\href{javascript:alert(1)}{x}$", "a"],
    ["\\url", "$\\url{https://evil.example/}$", "a"],
    ["\\includegraphics", "$\\includegraphics{https://evil.example/x.png}$", "img"],
    ["\\htmlId", "$\\htmlId{app-root}{x}$", "#app-root"],
    ["\\htmlClass", "$\\htmlClass{evil-class}{x}$", ".evil-class"],
    ["\\htmlData", "$\\htmlData{action=go}{x}$", "[data-action]"],
    ["\\htmlStyle", "$\\htmlStyle{position:fixed}{x}$", '[style*="position:fixed"], [style*="position: fixed"]'],
  ])("%s renders no live element", async (_name, markdown, selector) => {
    const el = await rendered(markdown);
    expect(el.querySelector(".md-math .katex, .md-math .katex-error")).not.toBeNull();
    expect(el.querySelector(selector)).toBeNull();
  });
});

describe("input the default strict mode only warns about", () => {
  it("non-LaTeX unicode in math still renders as math", async () => {
    // 0.19 routes missing character metrics through `strict` too
    // (`symbolNotInFont`); under the default "warn" that is a console line,
    // not an error note. We pass no `strict`, so it must stay that way.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = await rendered("$é + 中$");
    expect(el.querySelector(".katex-error")).toBeNull();
    expect(el.querySelector(".md-math .katex math")).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("printing the preview", () => {
  it("prints each expression once, as its MathML", async () => {
    // What `handlePrint` hands the print pipeline: the enriched preview DOM in a
    // standalone document that has no katex.css and none of KaTeX's fonts.
    const el = await rendered("Inline $a^2$ and\n\n$$\\sum_i x_i$$");
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(buildPrintDoc(`<div class="markdown-body">${el.innerHTML}</div>`, MARKDOWN_PRINT_CSS));
    doc.close();
    const view = frame.contentWindow!;
    const htmlCopies = Array.from(doc.querySelectorAll(".katex-html"));
    const mathml = Array.from(doc.querySelectorAll(".katex-mathml"));
    expect(htmlCopies).toHaveLength(2);
    expect(mathml).toHaveLength(2);
    for (const node of htmlCopies) expect(view.getComputedStyle(node).display).toBe("none");
    for (const node of mathml) expect(view.getComputedStyle(node).display).not.toBe("none");
  });
});
