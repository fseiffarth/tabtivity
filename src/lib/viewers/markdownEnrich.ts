/**
 * Mermaid + KaTeX enrichment for the markdown preview (Dev A).
 *
 * `renderMarkdown` (markdown.ts) stays a dependency-free, escape-first HTML
 * renderer. The heavyweight diagram/math libraries live HERE and run as a
 * post-render DOM pass: after the preview HTML is committed, `enrichMarkdownDom`
 * walks the container, finds the placeholders renderMarkdown emitted, and
 * renders them in place with `mermaid` / `katex`.
 *
 * Contract (do not change without updating markdown.ts + the MarkdownView call
 * site in FileViewerPane.tsx):
 *   - Mermaid: a fenced ```mermaid block renders to
 *       <pre class="md-code" data-lang="mermaid"><code …>SOURCE</code></pre>
 *     (the existing renderCodeBlock output, since "mermaid" is not a highlight
 *     language). This pass replaces such <pre> nodes with the rendered SVG.
 *   - Math: markdown.ts (Dev A) emits inline `$…$` as
 *       <span class="md-math" data-display="false">ESCAPED_TEX</span>
 *     and block `$$…$$` as
 *       <span class="md-math" data-display="true">ESCAPED_TEX</span>.
 *     This pass reads each node's textContent and renders it with KaTeX.
 *
 * SECURITY: KaTeX runs with `trust: false` / `throwOnError: false`; mermaid with
 * `securityLevel: "strict"`. Both consume already-escaped text content (never
 * raw HTML from the document), preserving the repo's escape-first invariant.
 *
 * IDEMPOTENCY: the effect re-runs whenever the draft changes, so every node is
 * tagged with a `data-*` flag once handled and skipped on subsequent passes.
 */

import mermaid from "mermaid";
import katex from "katex";
import "katex/dist/katex.min.css";
import { escapeHtml } from "../textSafety";

// Initialize mermaid once at module load. `startOnLoad:false` keeps mermaid from
// scanning the DOM on its own — we drive rendering explicitly per <pre> node.
// `securityLevel:"strict"` sanitizes the generated SVG (no inline scripts); the
// label HTML it keeps is defused by `neutralizeDiagram`.
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });

// Module-scoped counter for unique mermaid render ids (mermaid needs a DOM-safe,
// unique id per render). A monotonic counter avoids Date.now()/random collisions.
let mermaidSeq = 0;


async function renderMermaid(container: HTMLElement): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>(
    'pre.md-code[data-lang="mermaid"]:not([data-mermaid-done])',
  );
  for (const pre of Array.from(blocks)) {
    // Mark first so a thrown render (below) still flags the node and re-runs
    // don't retry a permanently-broken diagram.
    pre.setAttribute("data-mermaid-done", "");
    const code = pre.querySelector("code");
    const source = code?.textContent ?? "";
    const div = document.createElement("div");
    div.className = "md-mermaid";
    try {
      const { svg } = await mermaid.render(`md-mermaid-${mermaidSeq++}`, source);
      div.innerHTML = svg;
      neutralizeDiagram(div);
    } catch (err) {
      // Leave a small, escaped error note in place of the diagram.
      const msg = err instanceof Error ? err.message : String(err);
      div.innerHTML = `<span class="md-mermaid-error">Mermaid error: ${escapeHtml(msg)}</span>`;
    }
    pre.replaceWith(div);
  }
}

/**
 * Strict mode still keeps HTML in a node label (DOMPurify's defaults, and
 * mermaid restores an `<a>`'s `target`): an `<a target="_self">` or a
 * `<form action>` there would navigate the app window on a click (threat
 * recheck gap 38). Drop every `target` and unwrap every form (no control in it
 * can submit anything then), so the preview's link handler
 * (`onMarkdownLinkClick`) stops each diagram link like any other.
 */
export function neutralizeDiagram(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll("[target]"))) el.removeAttribute("target");
  // A control's `form`/`formaction` could still submit a form outside it.
  for (const el of Array.from(root.querySelectorAll("[form], [formaction]"))) {
    el.removeAttribute("form");
    el.removeAttribute("formaction");
  }
  for (const form of Array.from(root.querySelectorAll("form"))) {
    form.replaceWith(...Array.from(form.childNodes));
  }
}

function renderMath(container: HTMLElement): void {
  const spans = container.querySelectorAll<HTMLElement>(
    "span.md-math:not([data-math-done])",
  );
  for (const span of Array.from(spans)) {
    span.setAttribute("data-math-done", "");
    const tex = span.textContent ?? "";
    const displayMode = span.dataset.display === "true";
    // throwOnError:false makes KaTeX render an error indicator inline rather
    // than throw, so a single bad expression doesn't break the whole preview.
    katex.render(tex, span, { displayMode, throwOnError: false, trust: false });
  }
}

export async function enrichMarkdownDom(container: HTMLElement): Promise<void> {
  renderMath(container);
  await renderMermaid(container);
}
