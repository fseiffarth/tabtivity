/**
 * Pure per-format helpers for the built-in text viewer's "extra" features
 * (Group K follow-up): which formatter a file uses, in-process JSON
 * prettifying, which files get inline JSON/YAML validation, and which files get
 * a rendered-preview pane (HTML/SVG/CSS). Kept dependency-free and side-effect
 * free so they unit-test without React or Tauri.
 *
 * The heavy lifting (running prettier/black/… and parsing JSON/YAML for exact
 * error positions) lives in the Rust `commands::format` module; these helpers
 * only decide *what* applies to a given path and build the preview document.
 */

/** Lowercase extension of `path` including the dot (e.g. ".css"), or "". */
function extOf(path: string): string {
  const name = (path.split(/[/\\]/).filter(Boolean).pop() ?? path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

// Extension → the formatter `lang` id understood by the Rust `format_source`
// command. JSON is intentionally absent here: it is formatted in-process by
// `formatJsonText` (no external tool needed). Languages whose only formatter is
// a heavy/rare external tool we don't auto-wire are simply omitted.
const FORMAT_LANG: Record<string, string> = {
  ".css": "css", ".scss": "scss", ".less": "less",
  ".html": "html", ".htm": "html",
  ".js": "js", ".cjs": "js", ".mjs": "js", ".jsx": "jsx",
  ".ts": "ts", ".tsx": "tsx", ".vue": "vue",
  ".yaml": "yaml", ".yml": "yaml",
  ".graphql": "graphql", ".gql": "graphql",
  ".md": "markdown", ".markdown": "markdown",
  ".py": "python", ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
};

/**
 * The backend formatter `lang` for `path`, or `null` when no external formatter
 * is wired for the type. `.json` returns `null` here because JSON is formatted
 * in-process — see {@link jsonFormatLangForPath}.
 */
export function formatLangForPath(path: string): string | null {
  return FORMAT_LANG[extOf(path)] ?? null;
}

/** True when `path` is a `.json` family file we prettify in-process (no tool). */
export function isInProcessJson(path: string): boolean {
  return extOf(path) === ".json";
}

export type FormatResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Pretty-print JSON in-process via `JSON.parse`/`JSON.stringify` with a
 * `indent`-space indent. Returns the formatted text, or a parse error message
 * (so the viewer can surface it rather than silently no-op'ing). A trailing
 * newline is added to match what on-disk formatters produce.
 */
export function formatJsonText(text: string, indent = 2): FormatResult {
  try {
    const value = JSON.parse(text);
    return { ok: true, text: JSON.stringify(value, null, indent) + "\n" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Language to inline-validate `path` against, or `null` for none. */
export function validationLangForPath(path: string): "json" | "yaml" | null {
  const ext = extOf(path);
  if (ext === ".json") return "json";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  return null;
}

export type PreviewKind = "html" | "svg" | "css";

/** The rendered-preview kind for `path` (HTML/SVG/CSS), or `null` for none.
 *  Only plain `.css` previews — SCSS/LESS need compilation the webview can't do,
 *  so they stay edit-only (but keep their Format action). */
export function previewKindForPath(path: string): PreviewKind | null {
  const ext = extOf(path);
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".svg") return "svg";
  if (ext === ".css") return "css";
  return null;
}

// A small representative document the CSS preview applies the stylesheet to, so
// the reader sees their rules take effect (headings, text, links, controls,
// lists, a table). Authored as plain markup; the user's CSS is injected via a
// <style> tag (see buildPreviewDoc).
const CSS_PREVIEW_SAMPLE = `
<h1>Heading 1</h1>
<h2>Heading 2</h2>
<p>The quick brown fox jumps over the lazy dog. Here is a
<a href="#">link</a>, some <strong>bold</strong> and <em>italic</em> text,
and <code>inline code</code>.</p>
<blockquote>A short blockquote for styling.</blockquote>
<button>Button</button>
<input placeholder="Input field" />
<ul><li>First item</li><li>Second item</li><li>Third item</li></ul>
<table>
  <thead><tr><th>Name</th><th>Value</th></tr></thead>
  <tbody><tr><td>Alpha</td><td>1</td></tr><tr><td>Beta</td><td>2</td></tr></tbody>
</table>
`;

/**
 * The policy Tabtivity puts on every rendered preview document, as a `<meta>`.
 *
 * The preview frame is `sandbox=""` (no script), and until now stopped a hostile
 * file's remote beacons (`<img src="https://…">`, `@import`, `<link>`, a form)
 * only because WebKit carries the app's CSP into `about:srcdoc`. That is a
 * policy living somewhere else, so the document carries its own: nothing loads
 * (`default-src 'none'`) but inline styles and `data:` images and fonts; no
 * `<base>` (`base-uri 'none'`), no form submission.
 */
export const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
export const PREVIEW_CSP_TAG = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

/** Where {@link PREVIEW_CSP_TAG} goes. A policy `<meta>` binds only what comes
 *  after it, so it must precede every byte of the file's own markup — never
 *  "after the first `<head>`", which a file can park inside a comment or a
 *  `<title>` to push the policy somewhere inert. Right after a leading doctype
 *  (the only thing that may precede it without dropping the page into quirks
 *  mode; closed comments before it are harmless), else at the very top. */
const LEADING_DOCTYPE = /^(?:\s|<!--[\s\S]*?-->)*<!doctype\b[^>]*>/i;

/** In-page anchors need no `<base>` (the policy forbids one). A srcdoc
 *  document's base URL falls back to the embedding page's — the app's own
 *  `tauri://localhost/` — so a bare `#section` resolved there and a click was a
 *  full navigation of the frame (blank preview) instead of a scroll. Spelling the
 *  fragment out as `about:srcdoc#section`, the document's own address, keeps it
 *  a fragment navigation (measured on WebKitGTK 2.52 with a `<base>` of that
 *  value: the link resolved to `about:srcdoc#t` and scrolled). */
const FRAGMENT_HREF = /(<[a-z][^<>]*?\s(?:xlink:)?href\s*=\s*["']?)#/gi;

/** An HTML file's source as the preview document: the CSP first, and its own
 *  fragment links made absolute (see {@link FRAGMENT_HREF}). */
export function withPreviewGuards(html: string): string {
  const guarded = html.replace(FRAGMENT_HREF, "$1about:srcdoc#");
  const doctype = LEADING_DOCTYPE.exec(guarded);
  const at = doctype ? doctype[0].length : 0;
  return guarded.slice(0, at) + PREVIEW_CSP_TAG + guarded.slice(at);
}

/** Base64 of the UTF-8 bytes of `text`, for a `data:` URL. */
function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Build the `srcDoc` for the rendered-preview iframe. The iframe is always
 * rendered with `sandbox=""` (no scripts), so even a hostile file is inert, and
 * every document carries {@link PREVIEW_CSP}.
 *  - "html": the file's own source, behind the policy.
 *  - "svg": wrapped in an HTML page as an `<img>` of a `data:` URL — an
 *    image-context SVG runs nothing and loads nothing external, and an SVG
 *    document has no head for the policy.
 *  - "css": the stylesheet is injected into a sample document so its effect is
 *    visible.
 */
export function buildPreviewDoc(kind: PreviewKind, content: string): string {
  if (kind === "css") {
    return `<!doctype html><html><head>${PREVIEW_CSP_TAG}<meta charset="utf-8"><style>\n${content}\n</style></head><body>${CSS_PREVIEW_SAMPLE}</body></html>`;
  }
  if (kind === "html") return withPreviewGuards(content);
  return `<!doctype html><html><head>${PREVIEW_CSP_TAG}<meta charset="utf-8"></head><body style="margin:0"><img alt="" style="max-width:100%" src="data:image/svg+xml;base64,${utf8Base64(content)}"></body></html>`;
}
