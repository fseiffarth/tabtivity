/**
 * A compact, dependency-free Markdown → HTML renderer for the built-in markdown
 * viewer (TODO Group K #40). It is a focused subset of CommonMark + the GitHub
 * flavour our project docs (README/STATUS/TODO/…) actually use: headings
 * (ATX + setext), fenced/indented code, blockquotes, GitHub alert callouts,
 * ordered/unordered/nested/task lists, pipe tables, horizontal rules,
 * paragraphs, and inline emphasis/code/links/images/auto-links.
 *
 * Fenced code blocks are syntax-highlighted by reusing the sibling
 * `highlight.ts` engine when the info string names a known language.
 *
 * SECURITY: the input is an arbitrary file's contents, so every raw run of text
 * is HTML-escaped FIRST; formatting is then layered on by emitting our own tags.
 * Raw HTML in the source is therefore shown as literal text, never injected, and
 * link hrefs are restricted to safe schemes. The highlighter shares the same
 * escape-first invariant. Keep this invariant if extending.
 */

import { escapeHtml, highlight, type Lang } from "./highlight";

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed || /^\/\//.test(trimmed)) return null;
  // Explicit schemes are opt-in. Everything else is a relative filesystem
  // target: Markdown commonly writes `[guide](docs/guide.md)`, without a `./`.
  // Keep Windows drive paths in that local category rather than mistaking `C:`
  // for an unrecognised URI scheme.
  if (/^(https?:|mailto:|tel:|file:|#)/i.test(trimmed)) return trimmed;
  if (/^[a-z]:[\\/]/i.test(trimmed)) return trimmed;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? null : trimmed;
}

/** Classify an image URL from `![alt](url)`. A `data:image/` target is emitted
 *  directly as the <img src>. A remote `http(s)` target is NOT: fetching it on
 *  render would let any document make the app contact any server (a tracking
 *  pixel, or a leak out of a VM/agent sandbox through the host), so it is
 *  reported as `remote` and rendered as a placeholder the markdown viewer fills
 *  only after the user presses Load (`commands::markdown`). Local targets
 *  (relative or absolute filesystem paths, or `file:`) can't be loaded by the
 *  webview from the app origin nor resolved here (the markdown file's directory
 *  is unknown), so they are reported as `local` for the viewer to resolve and
 *  inline from disk. Anything carrying another scheme (e.g. `javascript:`) is
 *  rejected. */
function imgSrc(url: string): { kind: "inline" | "remote" | "local"; url: string } | null {
  const u = url.trim();
  if (!u) return null;
  if (/^data:image\//i.test(u)) return { kind: "inline", url: u };
  if (/^https?:\/\//i.test(u)) return { kind: "remote", url: u };
  if (/^file:/i.test(u)) return { kind: "local", url: u };
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // other explicit scheme → reject
  return { kind: "local", url: u }; // no scheme → relative/absolute local path
}

/** The host a remote image would be fetched from, for a placeholder with no alt. */
function remoteHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** #49: true when a (already-safe) href points at a local file rather than a
 *  remote/anchor target, so the markdown viewer can mark it visibly clickable.
 *  Relative paths, absolute paths, and the `file:` scheme count; http(s)/
 *  mailto/tel and pure `#anchor` links do not. Exported for the relationship
 *  graph (`mdGraph.ts`), whose link extraction must classify targets exactly the
 *  way the renderer does — two copies of this rule would eventually show a graph
 *  node the preview never made clickable, or vice versa. */
export function isLocalHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || /^\/\//.test(trimmed)) return false;
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return false;
  return /^file:/i.test(trimmed)
    || /^[a-z]:[\\/]/i.test(trimmed)
    || !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

/** Split a trailing Markdown source-position hint from a local-file href.
 * `:line` and `:line:column` are accepted; the column is intentionally ignored.
 * A Windows drive colon is never considered a hint because digits must follow
 * the final path colon. Query/fragment suffixes remain attached to the href. */
export function splitLineHint(href: string): { href: string; line: number | null } {
  const suffixAt = href.search(/[?#]/);
  const body = suffixAt < 0 ? href : href.slice(0, suffixAt);
  const suffix = suffixAt < 0 ? "" : href.slice(suffixAt);
  const match = body.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (!match || !match[1]) return { href, line: null };
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1) return { href, line: null };
  return { href: `${match[1]}${suffix}`, line };
}

/** Map a fenced-code info string (the word after the opening ```) to a
 *  highlighter language, or null when we have no grammar for it. Covers the
 *  common aliases project docs use; unknown languages fall back to plain text. */
const FENCE_LANG: Record<string, Lang> = {
  js: "js", javascript: "js", ts: "js", typescript: "js", jsx: "js", tsx: "js",
  mjs: "js", cjs: "js", node: "js",
  rust: "rust", rs: "rust",
  py: "python", python: "python",
  go: "go", golang: "go",
  c: "c", h: "c", "c++": "c", cpp: "c", cxx: "c", hpp: "c", java: "c",
  kotlin: "c", kt: "c", cs: "c", "c#": "c", csharp: "c", swift: "c", php: "c",
  scala: "c", dart: "c", objc: "c",
  sh: "shell", bash: "shell", shell: "shell", zsh: "shell", console: "shell",
  "shell-session": "shell", fish: "shell", ps1: "shell", powershell: "shell",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "toml", conf: "toml", cfg: "toml", env: "toml", dotenv: "toml",
  css: "css", scss: "css", sass: "css", less: "css",
  sql: "sql",
  tex: "tex", latex: "tex",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup",
};

/** A slug for a heading's text, used as the heading `id` so in-document
 *  `#anchor` links resolve. Mirrors GitHub's scheme closely enough for our docs:
 *  lowercased, non-word characters dropped, spaces → hyphens. */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** The rendered-heading id a link fragment names, or null when none matches.
 *  `ids` are the `[id]` values present in the rendered preview (in document
 *  order); `fragment` is the raw text after `#` in the authored href. Tried in
 *  order: the percent-decoded fragment verbatim (the authored link already used
 *  the slug), then its slugified form (the link was written as the heading's
 *  visible text, e.g. `#Project Docs`). Case-insensitive fallback last, since
 *  GitHub slugs are lowercase but hand-written fragments often are not. */
export function matchAnchorId(ids: string[], fragment: string): string | null {
  let frag = fragment;
  try {
    frag = decodeURIComponent(fragment);
  } catch {
    /* keep the raw fragment */
  }
  if (ids.includes(frag)) return frag;
  const slug = slugify(frag);
  if (slug && ids.includes(slug)) return slug;
  const lower = frag.toLowerCase();
  return ids.find((id) => id.toLowerCase() === lower) ?? null;
}

/** The extracted-span stores backing one inline render. A link label is rendered
 *  by recursing, and the label has already had this pass's code/math/image
 *  placeholders substituted into it — so the recursion must resolve them against
 *  the SAME arrays. With a fresh store per call (the old shape), `[![badge](x)](y)`
 *  and ``[`code` link](y)`` both restored an out-of-range index and printed
 *  "undefined" where the image or code span belonged. */
type InlineSpans = { codeSpans: string[]; mathSpans: string[]; links: string[] };

/** Placeholders are delimited by NUL, a byte `renderMarkdown` strips from the
 *  source up front, so a marker can never collide with the document's own prose.
 *  They used to be space-padded (` L0 `), which had two consequences: a document
 *  that literally said "step L0 of the plan" had that phrase replaced by whatever
 *  link index 0 held, and every link was rendered with spurious spaces glued
 *  around it (`foo[a](x)bar` → `foo <a>a</a> bar`). NUL cannot appear in the
 *  input, so neither is reachable. */
const NUL = "\u0000";
const mark = (kind: "C" | "M" | "L", idx: number) => `${NUL}${kind}${idx}${NUL}`;

/** Escaped text for an attribute value that may already hold this pass's markers
 *  (`![$x$](…)` puts a math marker in the alt). Restoring a marker's HTML there
 *  would let the span's own quotes end the attribute early, so a marker
 *  contributes only its visible text: the stored HTML minus its tags, which is
 *  already escaped. The split spells the NUL delimiters as `\u0000` escapes:
 *  literal NUL bytes here read as spaces in most tools, which made this split
 *  look like it matched the old space-padded markers (threat model row 40). */
function attrText(raw: string, spans: InlineSpans): string {
  return raw
    .split(/(\u0000[CML]\d+\u0000)/)
    .map((part, i) => {
      if (i % 2 === 0) return escapeHtml(part);
      const idx = Number(part.slice(2, -1));
      const stored =
        part[1] === "C" ? spans.codeSpans[idx] : part[1] === "M" ? spans.mathSpans[idx] : spans.links[idx];
      return stripTags(stored ?? "");
    })
    .join("");
}

/** `html` minus its tags. A character scan, not a regex replace: it never emits
 *  `<` or `>`, whatever the input, so the result cannot hold a partial tag. */
function stripTags(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

/** Render inline constructs within already-block-split text. Input is raw
 *  (unescaped) markdown for one block; output is safe HTML. `spans` is passed
 *  only by the recursive link-label render, to share this pass's placeholders. */
function renderInline(raw: string, spans?: InlineSpans): string {
  const { codeSpans, mathSpans, links } = spans ?? {
    codeSpans: [],
    mathSpans: [],
    links: [],
  };
  const store: InlineSpans = { codeSpans, mathSpans, links };

  // Pull inline code spans out first so their contents are not formatted.
  let text = raw.replace(/`([^`]+)`/g, (_m, code: string) => {
    const idx = codeSpans.push(`<code>${escapeHtml(code)}</code>`) - 1;
    return mark("C", idx);
  });

  // Pull math out next so emphasis/escape never touches the TeX. We emit a
  // placeholder span that the post-render `enrichMarkdownDom` pass replaces with
  // KaTeX. The TeX is HTML-escaped here (escape-first invariant); KaTeX consumes
  // the de-escaped textContent, which is safe with trust:false.
  //
  // Heuristic to avoid treating prose dollar amounts ("It cost $5 today") as
  // math: a `$` only opens/closes math when it sits directly against a non-space
  // char on the inside, and no newline appears between the delimiters. Block math
  // (`$$…$$`) is pulled before inline (`$…$`) so the longer delimiter wins; the
  // single-line `$$x$$` form is handled here, which covers our docs in v1.
  const pushMath = (tex: string, display: boolean): string => {
    const idx =
      mathSpans.push(
        `<span class="md-math" data-display="${display}">${escapeHtml(tex)}</span>`,
      ) - 1;
    return mark("M", idx);
  };
  text = text.replace(/\$\$(?!\s)([^\n]+?)(?<!\s)\$\$/g, (_m, tex: string) =>
    pushMath(tex, true),
  );
  text = text.replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (_m, tex: string) =>
    pushMath(tex, false),
  );

  // Pull links/images out next so their text/url are not mangled by emphasis.
  // A URL holding a marker (`[a]($x$)`, `![a](`x`)`) is left as literal text: the
  // marker would otherwise be restored as HTML inside the href/src attribute.
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt: string, url: string) => {
    if (url.includes(NUL)) return m;
    const altEsc = attrText(alt, store);
    const img = imgSrc(url);
    // Local images get a placeholder (no `src`, so they don't 404 against the app
    // origin); the markdown viewer resolves `data-md-src` against the file's dir
    // and swaps in the bytes. Remote images get a chip showing their alt text
    // (or host) that the viewer fills only once the user allows it. Data images
    // are emitted directly.
    const html = !img
      ? `[${altEsc}]`
      : img.kind === "inline"
        ? `<img src="${escapeHtml(img.url)}" alt="${altEsc}" />`
        : img.kind === "remote"
          ? `<span class="md-img-remote" data-md-remote="${escapeHtml(img.url)}" title="${escapeHtml(img.url)}">${altEsc || escapeHtml(remoteHost(img.url))}</span>`
          : `<img class="md-img-local" data-md-src="${escapeHtml(img.url)}" alt="${altEsc}" />`;
    const idx = links.push(html) - 1;
    return mark("L", idx);
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label: string, url: string) => {
    if (url.includes(NUL)) return m;
    const href = safeHref(url);
    const inner = renderInline(label, store);
    // #49: a link to a local file (relative/absolute path or file: scheme) gets a
    // `file-link` class so it reads as clickable, matching the editor's dotted
    // underline. Remote/anchor links keep the plain style.
    const fileCls = href && isLocalHref(href) ? ' class="file-link"' : "";
    // Native file links are handled by MarkdownView, and fragment links should
    // stay in this preview. Only external links need a new browsing context.
    const target = href && (fileCls || href.startsWith("#"))
      ? ""
      : ' target="_blank" rel="noopener noreferrer"';
    const html = href
      ? `<a href="${escapeHtml(href)}"${fileCls}${target}>${inner}</a>`
      : `[${inner}]`;
    const idx = links.push(html) - 1;
    return mark("L", idx);
  });

  // Auto-link bare URLs (http(s):// or www.) into the same placeholder stream so
  // emphasis rules don't mangle their underscores. Trailing sentence punctuation
  // is left outside the link, matching GitHub.
  // A NUL counts as a boundary on both sides: it is only ever a placeholder
  // delimiter, and the URL class must stop at one so a bare URL sitting directly
  // against an earlier link's marker doesn't swallow it into its own href.
  text = text.replace(/(^|[\s(\u0000])((?:https?:\/\/|www\.)[^\s<\u0000]+)/g, (m, pre: string, rawUrl: string) => {
    let url = rawUrl;
    let trail = "";
    const tm = url.match(/[.,;:!?)\]}]+$/);
    if (tm) {
      trail = url.slice(url.length - tm[0].length);
      url = url.slice(0, url.length - tm[0].length);
    }
    const href = safeHref(url.startsWith("www.") ? `https://${url}` : url);
    if (!href) return m;
    const html = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    const idx = links.push(html) - 1;
    return `${pre}${mark("L", idx)}${trail}`;
  });

  // Escape everything else, then apply emphasis on the escaped text.
  text = escapeHtml(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  // CommonMark does not emphasise underscores embedded in a word, so a file
  // link label such as `build_output.md` must remain legible rather than turning
  // into `build<em>output</em>.md`. Keep underscore emphasis where it is
  // delimited by whitespace/punctuation, matching the asterisk behaviour above.
  text = text.replace(/(^|[^\w_])_([^\s_](?:[^_]*?[^\s_])?)_(?!\w)/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // Restore math, then links, then code spans. A marker with no entry behind it
  // should be unreachable (NUL is stripped from the source), so drop it rather
  // than let the array's `undefined` reach the page — that miss is what every
  // README badge line used to render as.
  text = text.replace(/\u0000M(\d+)\u0000/g, (_m, i: string) => mathSpans[Number(i)] ?? "");
  text = text.replace(/\u0000L(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? "");
  text = text.replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)] ?? "");
  return text;
}

/** Highlight a fenced code block body, falling back to plain escaped text when
 *  the language is unknown or the highlighter declines. */
function renderCodeBlock(lang: string, body: string): string {
  const key = lang ? FENCE_LANG[lang.toLowerCase()] : undefined;
  const highlighted = key ? highlight(body, key) : null;
  const inner = highlighted ?? escapeHtml(body);
  const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre class="md-code"${langAttr}><code${cls}>${inner}</code></pre>`;
}

// ── GitHub alert callouts ──────────────────────────────────────────────────
const ALERT_KINDS: Record<string, string> = {
  NOTE: "note",
  TIP: "tip",
  IMPORTANT: "important",
  WARNING: "warning",
  CAUTION: "caution",
};

const ALERT_TITLE: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

function renderBlockquote(rawLines: string[]): string {
  // GitHub alert syntax: first line is `[!NOTE]` (or TIP/IMPORTANT/WARNING/CAUTION),
  // the remainder is the body. Anything else is a plain blockquote.
  const first = rawLines[0]?.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i);
  if (first) {
    const kind = ALERT_KINDS[first[1].toUpperCase()];
    const body = rawLines.slice(1).join(" ").trim();
    const bodyHtml = body ? `<p>${renderInline(body)}</p>` : "";
    return (
      `<div class="md-alert md-alert-${kind}">` +
      `<p class="md-alert-title">${ALERT_TITLE[kind]}</p>` +
      bodyHtml +
      `</div>`
    );
  }
  return `<blockquote>${renderInline(rawLines.join(" "))}</blockquote>`;
}

// ── Tables ──────────────────────────────────────────────────────────────────
type Align = "left" | "right" | "center" | "";

/** Split a pipe-table row into cells, honouring `\|` escapes and trimming the
 *  optional leading/trailing pipes. */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  // Drop empty leading/trailing cells produced by border pipes.
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** Test whether `line` is a table delimiter row (e.g. `| --- | :--: |`). */
function isTableDelimiter(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitTableRow(line);
  if (!cells.length) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function alignFor(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function renderTable(header: string, delim: string, rows: string[]): string {
  const aligns = splitTableRow(delim).map(alignFor);
  const cell = (raw: string, tag: "th" | "td", i: number) => {
    const a = aligns[i] ?? "";
    const style = a ? ` style="text-align:${a}"` : "";
    return `<${tag}${style}>${renderInline(raw)}</${tag}>`;
  };
  const head =
    "<thead><tr>" +
    splitTableRow(header).map((c, i) => cell(c, "th", i)).join("") +
    "</tr></thead>";
  const body =
    "<tbody>" +
    rows
      .map(
        (r) =>
          "<tr>" + splitTableRow(r).map((c, i) => cell(c, "td", i)).join("") + "</tr>",
      )
      .join("") +
    "</tbody>";
  return `<table class="md-table">${head}${body}</table>`;
}

// ── Lists (nested + task items) ───────────────────────────────────────────────
type ListItem = {
  indent: number;
  type: "ul" | "ol";
  task: boolean | null;
  content: string[];
};

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Build the HTML for a collected list region using an indentation stack so
 *  nested lists render as nested <ul>/<ol>. Each item may be a GitHub task item
 *  (`- [ ]` / `- [x]`), rendered with a live checkbox: the preview toggles it and
 *  writes the `[ ]`/`[x]` back into the source (see `toggleTaskCheckbox`). The
 *  `data-md-task` attribute is the click handler's hook — checkboxes are emitted
 *  in document order, so their DOM order is the toggler's index. */
function renderList(items: ListItem[]): string {
  const parts: string[] = [];
  const stack: { type: "ul" | "ol"; indent: number }[] = [];

  const openItem = (it: ListItem): string => {
    const inner = renderInline(it.content.join(" "));
    if (it.task === null) return `<li>${inner}`;
    const checked = it.task ? " checked" : "";
    return (
      `<li class="task-item"><input type="checkbox" data-md-task${checked} />` +
      `<span>${inner}</span>`
    );
  };

  for (const it of items) {
    if (stack.length === 0) {
      stack.push({ type: it.type, indent: it.indent });
      parts.push(`<${it.type}>`, openItem(it));
      continue;
    }
    if (it.indent > stack[stack.length - 1].indent) {
      // Deeper: open a nested list inside the still-open <li>.
      stack.push({ type: it.type, indent: it.indent });
      parts.push(`<${it.type}>`, openItem(it));
      continue;
    }
    // Same level or shallower: close finished nested lists first.
    while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) {
      parts.push(`</li></${stack.pop()!.type}>`);
    }
    const top = stack[stack.length - 1];
    if (it.type !== top.type) {
      // Switching list kind at the same level: close and reopen.
      parts.push(`</li></${top.type}>`);
      stack.pop();
      stack.push({ type: it.type, indent: it.indent });
      parts.push(`<${it.type}>`, openItem(it));
    } else {
      parts.push(`</li>`, openItem(it));
    }
  }
  while (stack.length) parts.push(`</li></${stack.pop()!.type}>`);
  return parts.join("");
}

/** `breaks`: a single line break inside a paragraph stays a break (`<br>`),
 * as in a chat message, instead of joining the lines into one. */
export function renderMarkdown(src: string, { breaks = false }: { breaks?: boolean } = {}): string {
  // Drop NUL up front — it is the inline placeholder delimiter (`mark`), and
  // stripping it here is what makes a marker impossible to forge from document
  // text. A NUL in a file being viewed as markdown has nothing to render anyway.
  const lines = src.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      // Each line was trimmed, so the only newlines left are the joins.
      out.push(`<p>${breaks ? renderInline(paragraph.join("\n")).replace(/\n/g, "<br>") : renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      flushParagraph();
      const marker = fence[1][0];
      const lang = fence[2].trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or EOF)
      out.push(renderCodeBlock(lang, body.join("\n")));
      continue;
    }

    // Blank line: ends paragraph.
    if (/^\s*$/.test(line)) {
      flushParagraph();
      i++;
      continue;
    }

    // ATX heading.
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const id = slugify(heading[2]);
      const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
      out.push(`<h${level}${idAttr}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Setext heading: a text line underlined by === (h1) or --- (h2). The HR rule
    // below also matches `---`, so this is only a heading when a paragraph line
    // precedes it; we detect that via the pending `paragraph` buffer being a
    // single line. Handled here before the HR check.
    if (
      paragraph.length === 1 &&
      /^\s*(=+|-+)\s*$/.test(line) &&
      !/^\s*$/.test(paragraph[0])
    ) {
      const level = line.trim().startsWith("=") ? 1 : 2;
      const textRaw = paragraph[0];
      paragraph = [];
      const id = slugify(textRaw);
      const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
      out.push(`<h${level}${idAttr}>${renderInline(textRaw)}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      out.push("<hr />");
      i++;
      continue;
    }

    // Table: a header row containing a pipe, immediately followed by a delimiter
    // row. Rows continue until a blank or non-pipe line.
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      flushParagraph();
      const header = line;
      const delim = lines[i + 1];
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      out.push(renderTable(header, delim, rows));
      continue;
    }

    // Blockquote / GitHub alert (consecutive `>` lines merged).
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(renderBlockquote(quote));
      continue;
    }

    // List items (ordered/unordered/nested/task). Collect the whole list region,
    // tolerating a single blank line between items and indented continuations.
    if (LIST_ITEM_RE.test(line)) {
      flushParagraph();
      const items: ListItem[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (/^\s*$/.test(l)) {
          // A blank only continues the list if followed by another item or an
          // indented continuation line.
          const next = lines[i + 1];
          if (next != null && (LIST_ITEM_RE.test(next) || /^\s+\S/.test(next))) {
            i++;
            continue;
          }
          break;
        }
        const m = l.match(LIST_ITEM_RE);
        if (m) {
          const indent = m[1].replace(/\t/g, "    ").length;
          const ordered = /\d/.test(m[2]);
          let content = m[3];
          let task: boolean | null = null;
          const tm = !ordered && content.match(/^\[([ xX])\]\s+(.*)$/);
          if (tm) {
            task = tm[1].toLowerCase() === "x";
            content = tm[2];
          }
          items.push({ indent, type: ordered ? "ol" : "ul", task, content: [content] });
          i++;
          continue;
        }
        if (/^\s+\S/.test(l) && items.length) {
          // Indented continuation: fold into the previous item's text.
          items[items.length - 1].content.push(l.trim());
          i++;
          continue;
        }
        break;
      }
      out.push(renderList(items));
      continue;
    }

    // Plain text → accumulate into the current paragraph.
    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  return out.join("\n");
}

/** A GitHub task-list line: `- [ ] …` / `* [x] …` (unordered bullets only, to
 *  match the renderer, which emits a checkbox only for those). The captured
 *  groups bracket the state character so a toggle is a one-character splice that
 *  leaves the rest of the line — indent, bullet, trailing text — byte-for-byte. */
const TASK_LINE_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)/;

/** Toggle the `index`-th task checkbox (`[ ]` ⇄ `[x]`) in Markdown `src`, where
 *  `index` is the checkbox's position in document order — exactly the DOM order
 *  `renderMarkdown` emits them in, so the preview can pass the clicked box's
 *  ordinal straight through. Lines inside fenced code blocks are skipped with the
 *  same fence bookkeeping the renderer uses, so a `- [ ]` shown as code text is
 *  never miscounted. Returns the edited source, or `null` when `index` names no
 *  task (out of range) — the caller then does nothing. */
export function toggleTaskCheckbox(src: string, index: number): string | null {
  const lines = src.split("\n");
  const i = taskLineNumbers(lines)[index];
  if (i == null) return null;
  const line = lines[i];
  const m = line.match(TASK_LINE_RE)!;
  const next = m[2].toLowerCase() === "x" ? " " : "x";
  lines[i] = line.replace(TASK_LINE_RE, `$1${next}$3`);
  return lines.join("\n");
}

/** The source line of every task checkbox, in the order `toggleTaskCheckbox`
 *  counts them — so a caller holding a box's index against text that has since
 *  changed can find the same task again by its line. */
export function taskSourceLines(src: string): string[] {
  const lines = src.split("\n");
  return taskLineNumbers(lines).map((i) => lines[i]);
}

/** Indexes into `lines` of the task lines outside fenced code blocks, with the
 *  same fence bookkeeping the renderer uses. */
function taskLineNumbers(lines: string[]): number[] {
  const found: number[] = [];
  let fence: string | null = null; // the opening fence's marker char while open
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceM = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceM) {
      const marker = fenceM[1][0];
      if (fence == null) fence = marker;
      else if (marker === fence && new RegExp(`^\\s*\\${marker}{3,}\\s*$`).test(line))
        fence = null;
      continue;
    }
    if (fence != null) continue;
    if (TASK_LINE_RE.test(line)) found.push(i);
  }
  return found;
}
