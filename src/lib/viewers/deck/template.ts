import { BRAND } from "../../brand";
/**
 * Starter LaTeX for a new presentation.
 *
 * This is the "from blank" entry point: it exists so that **making a deck does
 * not require knowing TeX**, while leaving a real `.tex` on disk for anyone who
 * does. Tabtivity never writes to it again — the deck's layers live in the sidecar —
 * so the author owns the file from the moment it is created.
 *
 * Beamer is used because it is what an academic audience already has installed
 * and already knows how to edit; nothing in Tabtivity understands `\frame` or
 * `\pause`, and nothing needs to. The one Tabtivity-specific choice is `aspectratio=169`:
 * the deck's normalized geometry adapts to any page box, but a 4:3 default in
 * 2026 is a worse first impression than any layer editor can rescue.
 */

/**
 * Escape the characters that break a LaTeX title or author field.
 *
 * **One pass, not a chain of `.replace()`s.** Chained replaces re-scan their own
 * output: escaping `\` to `\textbackslash{}` and *then* escaping braces turns it
 * into `\textbackslash\{\}`, which is a syntax error. A single regex with a
 * lookup table cannot re-enter its own replacements.
 */
const TEX_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

export function texEscape(s: string): string {
  return s.replace(/[\\&%$#_{}~^]/g, (c) => TEX_ESCAPES[c] ?? c);
}

export interface TemplateOptions {
  title: string;
  author?: string;
  /** A first section, so the deck opens with something to look at. */
  section?: string;
}

/** A minimal, compilable Beamer deck: title frame, outline, one content frame. */
export function starterTex({ title, author, section }: TemplateOptions): string {
  const sec = section?.trim() || "Introduction";
  return `% Created by ${BRAND.display} as the base for a presentation.
%
% This file is yours: ${BRAND.display} compiles it to a PDF and lays its own editable
% layers on top, in the .eldeck.json sidecar beside it. It never writes back to
% this file, so edit it freely — recompiling keeps the layers, which re-anchor to
% the slides they were placed on.

\\documentclass[aspectratio=169]{beamer}

\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{graphicx}

\\title{${texEscape(title)}}
${author ? `\\author{${texEscape(author)}}` : "% \\author{Your name}"}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\section{${texEscape(sec)}}

\\begin{frame}{${texEscape(sec)}}
  \\begin{itemize}
    \\item First point
    \\item Second point
    \\item Third point
  \\end{itemize}
\\end{frame}

\\begin{frame}{Results}
  % A frame left deliberately empty: drop a figure, a table or ${BRAND.display} layers here.
\\end{frame}

\\end{document}
`;
}

/**
 * A blank, ready-to-compile TeX source for a single **figure** placed on a
 * slide (the deck toolbar's TeX FAB) — as opposed to {@link starterTex}, which
 * generates the whole deck's base plate.
 *
 * `standalone` crops the compiled PDF to its content's bounding box, which is
 * exactly what belongs on a slide as an image: no page furniture, no margins to
 * fight. TikZ and amsmath are preloaded since a formula or a diagram are the two
 * things this FAB exists for.
 */
export function starterTexFigure(): string {
  return `% A figure for one slide, compiled to a PDF and placed as an image.
%
% ${BRAND.display} rasterizes the compiled PDF's first page onto the slide and updates it
% every time you recompile here — nothing to do on the deck's side but wait for
% the change to appear. This file is yours; edit and compile it like any other.

\\documentclass[border=4pt]{standalone}

\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb}
\\usepackage{tikz}

\\begin{document}

% Replace this with a formula, a TikZ picture, a table — anything standalone
% can crop to its own size.
$$E = mc^2$$

\\end{document}
`;
}

/** `talk.eldeck.json` → a sensible presentation title. */
export function titleFromPath(deckOrPdfPath: string): string {
  const base = deckOrPdfPath.split(/[\\/]/).pop() ?? "Presentation";
  const stem = base.replace(/\.(eldeck\.json|tex|pdf)$/i, "");
  // `my-great-talk` / `my_great_talk` → `My great talk`.
  const words = stem.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Presentation";
}

/** The `.tex` a deck's base plate is generated from. */
export function texPathForDeck(deckPath: string): string {
  return `${deckPath.replace(/\.eldeck\.json$/i, "")}.tex`;
}
