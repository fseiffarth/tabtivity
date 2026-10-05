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
 * The one line Tabtivity adds to an HTML file's source before it becomes a
 * `srcdoc`: pins the document's base URL to its own address so in-page anchors
 * (`<a href="#section">`) stay in-page.
 *
 * Without it they do not. A srcdoc document's URL is `about:srcdoc`, but its
 * *base* URL falls back to the embedding page's — the app's own `tauri://
 * localhost/`. `#section` therefore resolves to `tauri://localhost/#section`,
 * which is not the document's URL, so the click is a full navigation of the
 * sandboxed frame instead of a fragment scroll: the preview goes blank, nothing
 * jumps. Measured on WebKitGTK 2.52 in an offscreen WebView (`sandbox` srcdoc,
 * click `#t`): plain srcdoc, `<base href="about:blank">`, and a `blob:` frame
 * all unloaded the frame; only `<base href="about:srcdoc">` resolved the link to
 * `about:srcdoc#t`, scrolled (2922px), and matched `:target`.
 *
 * It goes **first** in `<head>`, so it is the base that wins (the first `<base
 * href>` in a document is the one that counts): a file's own `<base>` cannot
 * point the frame's relative URLs somewhere else. Relative sub-resources of the
 * file (`<img src="pic.png">`) resolved against the app origin before and
 * against `about:srcdoc` now — broken either way, by design of `sandbox=""`.
 */
export const SRCDOC_BASE_TAG = '<base href="about:srcdoc">';

/** Insert {@link SRCDOC_BASE_TAG} at the start of the document's head without
 *  disturbing the doctype: after `<head>` if there is one, else after `<html>`
 *  (the parser puts it into the implied head), else after the doctype, else at
 *  the very top. Putting it *before* a doctype would drop the page into quirks
 *  mode, which is why the doctype case exists. */
export function withSrcdocBase(html: string): string {
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype\b[^>]*>/i]) {
    const m = re.exec(html);
    if (m) {
      const at = m.index + m[0].length;
      return html.slice(0, at) + SRCDOC_BASE_TAG + html.slice(at);
    }
  }
  return SRCDOC_BASE_TAG + html;
}

/**
 * Build the `srcDoc` for the rendered-preview iframe. The iframe is always
 * rendered with `sandbox=""` (no scripts), so even a hostile file is inert.
 *  - "html": the file's own source, plus {@link SRCDOC_BASE_TAG} so its
 *    in-page anchors work.
 *  - "svg": the file's own source is the document (`<base>` is an HTML
 *    element; an SVG document has no head for it).
 *  - "css": the stylesheet is injected into a sample document so its effect is
 *    visible.
 */
export function buildPreviewDoc(kind: PreviewKind, content: string): string {
  if (kind === "css") {
    return `<!doctype html><html><head><meta charset="utf-8"><style>\n${content}\n</style></head><body>${CSS_PREVIEW_SAMPLE}</body></html>`;
  }
  if (kind === "html") return withSrcdocBase(content);
  // SVG renders its own source directly.
  return content;
}
