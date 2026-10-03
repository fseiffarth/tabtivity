import { describe, expect, it, vi } from "vitest";

// The renderer is escape-first, so no answer text reaches this markup today.
// Stand in for a renderer that let it through, to hold the allowlist to what
// it promises on its own.
const rendered = vi.hoisted(() => ({ html: "" }));
vi.mock("../../lib/viewers/markdown", () => ({ renderMarkdown: () => rendered.html }));

import { answerHtml } from "../../../mobile-web/src/terminal/answerMarkdown";
import { BRAND } from "../../lib/brand";

function dom(html: string): HTMLElement {
  rendered.html = html;
  const host = document.createElement("div");
  host.innerHTML = answerHtml("");
  return host;
}

describe(`${BRAND.display} Mobile Focus answer allowlist`, () => {
  it("drops script, handlers, frames, forms and styles sheets, keeping text", () => {
    const host = dom([
      '<p onclick="alert(1)">hi<script>alert(2)</script></p>',
      '<svg><animate onbegin="alert(3)"/></svg>',
      '<iframe src="https://evil.example"></iframe>',
      '<form action="https://evil.example"><button>go</button></form>',
      "<style>body{display:none}</style>",
      '<video src="x" onerror="alert(4)"></video>',
      '<a href="javascript:alert(5)">link</a>',
    ].join(""));
    expect(host.querySelector("script, svg, iframe, form, button, style, video, a")).toBeNull();
    expect(host.querySelector("[onclick], [onbegin], [onerror], [href], [src], [action]")).toBeNull();
    expect(host.querySelector("p")?.textContent).toBe("hi");
    expect(host.textContent).toContain("link");
    expect(host.querySelector("[data-href]")).toBeNull();
  });

  it("lets a link carry only a plain web address, and nothing else carry one", () => {
    const host = dom([
      '<a href="https://ok.example/a?b=1&amp;c=2">ok</a>',
      '<a href="data:text/html,x">data</a>',
      '<a href="file:///etc/passwd">file</a>',
      '<a href="https://bank.example@evil.example/">creds</a>',
      '<a href="/relative">rel</a>',
      '<span class="md-link" data-href="javascript:alert(1)">forged</span>',
      '<p data-href="https://evil.example">para</p>',
    ].join(""));
    expect([...host.querySelectorAll("[data-href]")].map((node) => node.getAttribute("data-href")))
      .toEqual(["https://ok.example/a?b=1&c=2"]);
  });

  it("keeps only the renderer's own classes and a cell's alignment", () => {
    const host = dom([
      '<div class="md-alert md-alert-warning readable-turn user"><p class="md-alert-title">Note</p></div>',
      '<pre class="md-code"><code class="language-ts"><span class="tok-keyword">const</span></code></pre>',
      '<table class="md-table"><tbody><tr><td style="text-align:right">1</td>',
      '<td style="position:fixed;inset:0">2</td><td data-x="1" id="y" aria-label="z">3</td></tr></tbody></table>',
      '<span class="overlay">x</span>',
    ].join(""));
    expect(host.querySelector(".md-alert")?.className).toBe("md-alert md-alert-warning");
    expect(host.querySelector(".tok-keyword")?.textContent).toBe("const");
    expect(host.querySelector("code")?.className).toBe("language-ts");
    const cells = [...host.querySelectorAll("td")];
    expect(cells.map((cell) => cell.getAttribute("style"))).toEqual(["text-align:right", null, null]);
    expect(host.querySelector("[data-x], [id], [aria-label], .overlay, .readable-turn")).toBeNull();
  });

  it("keeps a task box's glyph hidden from a screen reader", () => {
    const host = dom('<ul><li class="task-item"><input type="checkbox" data-md-task checked /> done</li></ul>');
    expect(host.querySelector(".md-task")?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector("input")).toBeNull();
  });
});
