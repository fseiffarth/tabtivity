/**
 * `lib/viewers/markdownEnrich.ts` — the post-render pass that turns the
 * placeholders `renderMarkdown` emits into KaTeX/mermaid output. The two
 * libraries are mocked: what is under test is the CONTRACT between the
 * renderer and this pass (the placeholder shapes are produced by the real
 * `renderMarkdown`, so a drift on either side fails here), the security
 * options both libraries are called with, the escaped error note a broken
 * diagram leaves behind, and the idempotency flags that keep a re-run from
 * rendering the same node twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { katexRender, mermaidRender, mermaidInitialize } = vi.hoisted(() => ({
  katexRender: vi.fn(),
  mermaidRender: vi.fn(),
  mermaidInitialize: vi.fn(),
}));

vi.mock("katex", () => ({ default: { render: katexRender } }));
vi.mock("katex/dist/katex.min.css", () => ({}));
vi.mock("mermaid", () => ({ default: { render: mermaidRender, initialize: mermaidInitialize } }));

import { enrichMarkdownDom } from "../../lib/viewers/markdownEnrich";
import { renderMarkdown } from "../../lib/viewers/markdown";
import { onMarkdownLinkClick } from "../../lib/viewers/markdownLinks";
import type React from "react";

// Captured at module load: clearMocks wipes call history before each test.
const mermaidInitCalls = [...mermaidInitialize.mock.calls];

function container(markdown: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(markdown);
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  katexRender.mockImplementation((tex: string, el: HTMLElement) => {
    el.innerHTML = `<span class="katex">${tex}</span>`;
  });
  mermaidRender.mockImplementation(async (id: string) => ({ svg: `<svg data-id="${id}"></svg>` }));
});

afterEach(() => {
  document.body.innerHTML = "";
  katexRender.mockReset();
  mermaidRender.mockReset();
});

describe("mermaid is initialised once, locked down", () => {
  it("never scans the DOM on its own and sanitises its SVG", () => {
    expect(mermaidInitCalls).toHaveLength(1);
    expect(mermaidInitCalls[0][0]).toEqual(
      expect.objectContaining({ startOnLoad: false, securityLevel: "strict" }),
    );
  });
});

describe("math", () => {
  it("renders the renderer's inline and block placeholders with the matching display mode", async () => {
    const el = container("Inline $a^2$ and\n\n$$\\sum_i x_i$$");
    await enrichMarkdownDom(el);
    expect(katexRender).toHaveBeenCalledTimes(2);
    const [inlineTex, inlineNode, inlineOpts] = katexRender.mock.calls[0];
    const [blockTex, , blockOpts] = katexRender.mock.calls[1];
    expect(inlineTex).toBe("a^2");
    expect(blockTex).toBe("\\sum_i x_i");
    expect(inlineOpts.displayMode).toBe(false);
    expect(blockOpts.displayMode).toBe(true);
    expect(inlineNode).toBe(el.querySelector("span.md-math"));
  });

  it("hands KaTeX the DE-escaped TeX and runs it untrusted, never throwing", async () => {
    // The renderer HTML-escapes `<` into the span; KaTeX must see the original.
    const el = container("$a<b$");
    expect(el.innerHTML).toContain("a&lt;b");
    await enrichMarkdownDom(el);
    expect(katexRender.mock.calls[0][0]).toBe("a<b");
    expect(katexRender.mock.calls[0][2]).toMatchObject({ throwOnError: false, trust: false });
  });

  it("is idempotent: a second pass skips every node it already rendered", async () => {
    const el = container("$x$ then $y$");
    await enrichMarkdownDom(el);
    await enrichMarkdownDom(el);
    expect(katexRender).toHaveBeenCalledTimes(2);
    for (const span of Array.from(el.querySelectorAll("span.md-math"))) {
      expect(span.hasAttribute("data-math-done")).toBe(true);
    }
  });

  it("a fresh placeholder added later is picked up without re-rendering the old ones", async () => {
    const el = container("$x$");
    await enrichMarkdownDom(el);
    el.insertAdjacentHTML("beforeend", renderMarkdown("$z$"));
    await enrichMarkdownDom(el);
    expect(katexRender).toHaveBeenCalledTimes(2);
    expect(katexRender.mock.calls[1][0]).toBe("z");
  });
});

describe("mermaid", () => {
  it("replaces the mermaid <pre> with the rendered SVG in a .md-mermaid div", async () => {
    const el = container("```mermaid\ngraph TD; A-->B\n```");
    expect(el.querySelector('pre.md-code[data-lang="mermaid"]')).not.toBeNull();
    await enrichMarkdownDom(el);
    expect(el.querySelector("pre")).toBeNull();
    const div = el.querySelector("div.md-mermaid")!;
    expect(div.querySelector("svg")).not.toBeNull();
    expect(mermaidRender.mock.calls[0][1]).toBe("graph TD; A-->B");
  });

  it("hands mermaid the de-escaped source, not the HTML the renderer escaped", async () => {
    const el = container("```mermaid\ngraph LR; A-->B & C\n```");
    await enrichMarkdownDom(el);
    expect(mermaidRender.mock.calls[0][1]).toBe("graph LR; A-->B & C");
  });

  it("leaves other fenced code alone", async () => {
    const el = container("```js\nlet a = 1;\n```");
    await enrichMarkdownDom(el);
    expect(mermaidRender).not.toHaveBeenCalled();
    expect(el.querySelector("pre.md-code")).not.toBeNull();
  });

  it("mints a unique, DOM-safe id per render", async () => {
    const el = container("```mermaid\nA\n```\n\n```mermaid\nB\n```");
    await enrichMarkdownDom(el);
    const ids = mermaidRender.mock.calls.map((c) => c[0] as string);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^md-mermaid-\d+$/);
  });

  it("a broken diagram leaves an ESCAPED error note, and is never retried", async () => {
    mermaidRender.mockRejectedValue(new Error("Parse error <script>alert(1)</script>"));
    const el = container("```mermaid\nnot a diagram\n```");
    await enrichMarkdownDom(el);
    const note = el.querySelector(".md-mermaid .md-mermaid-error")!;
    expect(note.textContent).toBe("Mermaid error: Parse error <script>alert(1)</script>");
    expect(el.querySelector("script")).toBeNull();
    // The failed node was flagged and replaced — a re-run has nothing to retry.
    await enrichMarkdownDom(el);
    expect(mermaidRender).toHaveBeenCalledOnce();
  });

  // Review fix (threat recheck gap 38): mermaid's strict mode keeps HTML in a
  // node label, `target` included (`A["<a href=… target=_self>x</a>"]`
  // renders exactly that) and forms with an `action`. Either would navigate
  // the app window on a click; the shared link handler must stop every one.
  it("defuses label HTML that could navigate the app window", async () => {
    mermaidRender.mockImplementation(async () => ({
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg"><g>' +
        '<a href="https://evil.example/node"><rect></rect></a>' +
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">' +
        '<a href="https://evil.example/self" target="_self"><b>self</b></a>' +
        '<a href="https://evil.example/top" target="_top">top</a>' +
        '<form action="https://evil.example/form" method="get"><button>go</button><input type="submit"></form>' +
        '<button form="app-form" formaction="https://evil.example/fa">far</button>' +
        "</div></foreignObject></g></svg>",
    }));
    const el = container("```mermaid\nflowchart LR\n```");
    await enrichMarkdownDom(el);
    const diagram = el.querySelector(".md-mermaid")!;
    expect(diagram.querySelector("[target]")).toBeNull();
    expect(diagram.querySelector("form")).toBeNull();
    expect(diagram.querySelector("[form], [formaction]")).toBeNull();
    // The form's controls stay visible, just inert.
    expect(diagram.querySelector("button")?.textContent).toBe("go");
    // And a click on any diagram link is stopped by the shared handler.
    el.addEventListener("click", (e) => onMarkdownLinkClick(e as unknown as React.MouseEvent<HTMLElement>));
    const anchors = Array.from(diagram.querySelectorAll("a"));
    expect(anchors).toHaveLength(3);
    for (const a of anchors) {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      (a.firstElementChild ?? a).dispatchEvent(click);
      expect(click.defaultPrevented, a.outerHTML).toBe(true);
    }
  });

  it("a non-Error rejection is stringified into the note rather than thrown", async () => {
    mermaidRender.mockRejectedValue("boom");
    const el = container("```mermaid\nx\n```");
    await expect(enrichMarkdownDom(el)).resolves.toBeUndefined();
    expect(el.querySelector(".md-mermaid-error")!.textContent).toBe("Mermaid error: boom");
  });
});

describe("empty and mixed input", () => {
  it("does nothing on a container with no placeholders", async () => {
    const el = container("plain **prose** only");
    const before = el.innerHTML;
    await enrichMarkdownDom(el);
    expect(el.innerHTML).toBe(before);
    expect(katexRender).not.toHaveBeenCalled();
    expect(mermaidRender).not.toHaveBeenCalled();
  });

  it("renders math synchronously before awaiting the diagrams", async () => {
    let mathRenderedWhenMermaidRan = false;
    mermaidRender.mockImplementation(async () => {
      mathRenderedWhenMermaidRan = katexRender.mock.calls.length === 1;
      return { svg: "<svg></svg>" };
    });
    const el = container("$x$\n\n```mermaid\nA\n```");
    await enrichMarkdownDom(el);
    expect(mathRenderedWhenMermaidRan).toBe(true);
  });
});
