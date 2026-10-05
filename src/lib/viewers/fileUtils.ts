import type { TranslationKey } from "../i18n";
import { relativePathWithin } from "../paths";
import { LEGACY_BRAND } from "../brand";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_secs?: number | null;
  created_secs?: number | null;
  extension: string | null;
  mime: string | null;
}

export const STANDARD_PROJECT_FILES = new Set([
  "PROJECT.md",
  "README.md",
  "ROADMAP.md",
  "TODO.md",
  "REMARKS.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "STATUS.md",
  "DOCUMENTATION.md",
  ".gitignore",
  ".claude",
  ".git",
]);

export const INTERNAL_PROJECT_FILES = new Set([
  "open_apps.json",
  "project.json",
  "project_default_apps.json",
  `.${LEGACY_BRAND.slug}_colors.json`,
]);

export type SortKey = "name" | "type" | "size" | "created" | "modified";

/** Which built-in Tabtivity viewer can render a file in-tab (drag from the right
 *  panel onto a tab bar). Independent of any external default app. */
export type InternalViewer =
  | "pdf"
  | "image"
  | "markdown"
  | "text"
  | "tex"
  | "table"
  | "notebook"
  | "diff"
  // SSH-sync host-vs-mirror diff. Never auto-selected by extension — only opened
  // explicitly from a diverged (amber) file's diff button; routed to `DiffView`
  // in sync mode (backend `sync_diff`).
  | "syncdiff"
  // SSH-sync three-way merge (PyCharm-style): local mirror ⇄ editable result ⇄
  // remote host, with per-block take-left/right. Never auto-selected — only
  // opened from a diverged (amber) file in the orange list; routed to
  // `SyncMergeView`. Apply resolves the divergence (writes mirror + force-push).
  | "syncmerge"
  // Git pull's merge/diff view: the same three-way `CompareView`, fed by git —
  // ours ⇄ theirs of a conflicted merge (Apply writes + stages), else HEAD ⇄
  // upstream as a look-only preview. Never auto-selected; opened from the Git
  // panel's pull preview / merge bar; routed to `GitMergeView`.
  | "gitmerge"
  | "odt"
  | "media"
  | "gif"
  | "html"
  | "sqlite"
  | "yaml"
  // A BibTeX/BibLaTeX bibliography (`.bib`) as a list of cards — one per entry,
  // with its `field = {value}` pairs (see BibCards). Falls back to the plain code
  // editor when opted out, the way the YAML tree does: turning the cards off is a
  // vote against the cards, not against editing a `.bib` in Tabtivity.
  | "bib"
  // The native presenter's deck sidecar (`*.eldeck.json`, EXPERIMENTAL — see
  // `docs/deck_presenter_plan.md`). A deck is JSON, so this must be matched by
  // FILENAME before the generic `.json` rule; see `naturalViewerFor`.
  | "eldeck"
  // The LaTeX WORKSPACE: a single tab that hosts a main `.tex`, a left structure
  // sidebar of its `\input`/`\include`/`\subfile` children and `\includegraphics`
  // graphics, a center that switches between the TeX editor and the image viewer
  // for the selected entry, and a docked SyncTeX PDF pane. Never auto-selected by
  // extension (`internalViewerFor(.tex)` stays `"tex"` for a standalone/child
  // file); it is chosen only at the open site (`openTexWorkspace`), which resolves
  // the build root so there is exactly one workspace tab per main document.
  | "texworkspace";

// Audio/video formats the webview plays natively via <audio>/<video> from a
// Blob URL (Dev D). Kept separate from IMAGE_EXTS so the media viewer wins.
const MEDIA_EXTS = new Set([
  ".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus",
  ".mp4", ".webm", ".mov", ".mkv", ".m4v", ".ogv",
]);

// SQLite database files → the table-browser viewer (Dev C). These are binary, so
// they are deliberately NOT in TEXT_EXTS; the viewer reads them via the backend.
const SQLITE_EXTS = new Set([".db", ".sqlite", ".sqlite3"]);

// Spreadsheet workbooks the table viewer renders via the calamine backend (Dev
// G). Binary, so not in TEXT_EXTS.
const SPREADSHEET_EXTS = new Set([".xlsx", ".xls", ".xlsm"]);

const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);

// Raster image formats the webview renders natively via a Blob URL. SVG stays
// in TEXT_EXTS so its XML source can be read/edited instead.
const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".jfif", ".gif", ".webp", ".bmp", ".ico",
  ".avif", ".apng",
]);

// Extensions we treat as plain text for the built-in text viewer. Kept broad but
// explicit so binaries never slip in; extensionless well-known text files are
// handled by TEXT_FILENAMES below.
const TEXT_EXTS = new Set([
  ".txt", ".text", ".log", ".csv", ".tsv", ".json", ".jsonc", ".json5",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".properties",
  ".xml", ".svg", ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".rs", ".py",
  ".pyi", ".pyw", ".rb", ".rake", ".gemspec", ".go", ".c", ".h", ".cpp", ".cc",
  ".hpp", ".cxx", ".hh", ".hxx", ".ipp", ".inl", ".ino", ".cu", ".cuh",
  ".java", ".kt", ".kts", ".swift", ".m", ".mm", ".cs", ".php", ".pl", ".pm",
  ".lua", ".r", ".jl", ".zig", ".nim", ".proto", ".tf", ".hcl", ".cmake",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".sql", ".graphql", ".gql",
  ".vue", ".svelte", ".astro", ".dart", ".ex", ".exs", ".erl", ".hs", ".elm",
  ".clj", ".scala", ".groovy", ".gradle", ".dockerfile", ".gitignore",
  ".gitattributes", ".editorconfig", ".diff", ".patch", ".rst", ".tex", ".bib",
]);

// Extensionless filenames that are conventionally plain text.
const TEXT_FILENAMES = new Set([
  "dockerfile", "makefile", "license", "licence", "readme", "authors",
  "contributing", "changelog", "notice", "copying", "install", ".gitignore",
  ".gitattributes", ".editorconfig", ".env", ".npmrc", ".nvmrc", ".prettierrc",
  ".eslintrc", ".babelrc", "gnumakefile", "gemfile", "rakefile", "vagrantfile",
  ".bashrc", ".zshrc", ".profile",
]);

/**
 * The built-in viewer that should render `entry` in-tab, or null if none.
 *
 * PDFs, markdown, and text files always resolve to a viewer so they can be
 * dragged onto a tab bar regardless of (and independent of) whatever external
 * app is the system default — see TODO Group K #40.
 */
export function internalViewerFor(
  entry: FileEntry,
  disabled?: ReadonlySet<InternalViewer>,
): InternalViewer | null {
  const viewer = naturalViewerFor(entry);
  // When the user has opted this type out (#48), return null so the file falls
  // through to the external-app path (commitFileDrop routes it via embedExec) —
  // unless the type has a native fallback that is itself still enabled. YAML is
  // the case: turning off its tree is a vote against the *tree*, not against
  // editing YAML in Tabtivity at all, so it drops back to the plain code editor
  // (which is where .yaml opened before the tree existed).
  if (viewer && disabled?.has(viewer)) {
    const fallback = VIEWER_FALLBACK[viewer];
    return fallback && !disabled.has(fallback) ? fallback : null;
  }
  return viewer;
}

/** Where a type lands when its own viewer is opted out (#48), before the
 *  external-app path. Only for types whose bytes another native viewer can still
 *  render honestly. */
const VIEWER_FALLBACK: Partial<Record<InternalViewer, InternalViewer>> = {
  yaml: "text",
  // Same bargain as YAML: without the cards a `.bib` is still text we edit well
  // (and where it opened before the card view existed).
  bib: "text",
  // Opting out the GIF transport UI is not a vote against viewing GIFs in-app:
  // the plain image viewer still animates them honestly (the webview animates
  // <img> GIFs natively) — it just offers no frame control.
  gif: "image",
  // A deck IS JSON, so opting the presenter out should leave you editing the
  // sidecar by hand in the tree rather than handing a `.json` to an external app.
  eldeck: "yaml",
};

/** A presentation deck sidecar: `<name>.eldeck.json`, case-insensitive. Exported
 *  so the deck viewer and its "new presentation" flow name the file exactly one
 *  way. `.eldeck.json` alone (an empty stem) is deliberately NOT a deck. */
export const DECK_SUFFIX = ".eldeck.json";
const DECK_SUFFIX_RE = /.+\.eldeck\.json$/i;

/** Whether `name` (or a path ending in one) is a deck sidecar. */
export function isDeckFile(name: string): boolean {
  return DECK_SUFFIX_RE.test(name);
}

/** The viewer a file *type* maps to, ignoring any user opt-out. */
function naturalViewerFor(entry: FileEntry): InternalViewer | null {
  if (entry.is_dir) return null;
  const ext = (entry.extension ?? "").toLowerCase();
  if (ext === ".pdf") return "pdf";
  // .gif gets the dedicated animated-GIF viewer (frame transport: pause, step,
  // scrub — #gifviewer). It is also in IMAGE_EXTS, so this early return must
  // win — exactly like .tex/.csv below.
  if (ext === ".gif") return "gif";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  // .tex gets the dedicated LaTeX viewer (compile to a PDF tab when a TeX engine
  // is installed; otherwise it degrades to the plain code editor). This early
  // return must win even though .tex is also in TEXT_EXTS.
  if (ext === ".tex") return "tex";
  // .bib gets the bibliography card view — one card per entry, its fields as
  // key/value rows (see BibCards). `.bib` is also in TEXT_EXTS, so this specific
  // return must win, like .tex above; opting it out lands on the plain code editor
  // (VIEWER_FALLBACK), which is where a `.bib` opened before the cards existed.
  if (ext === ".bib" || ext === ".bibtex") return "bib";
  // .csv/.tsv get the table viewer, .ipynb the notebook viewer, .diff/.patch the
  // diff viewer. .csv/.tsv/.diff/.patch are also in TEXT_EXTS, so these specific
  // returns must win — exactly like .tex above. .ipynb is intentionally NOT in
  // TEXT_EXTS so that, when the notebook viewer is opted out (#48), it opens
  // externally rather than as raw JSON.
  if (ext === ".csv" || ext === ".tsv") return "table";
  if (ext === ".ipynb") return "notebook";
  if (ext === ".diff" || ext === ".patch") return "diff";
  // .odt gets the lightweight OpenDocument Text viewer: it unzips the archive and
  // renders content.xml to a readable HTML subset (headings/lists/tables/images).
  // The faithful path stays "Open externally"; opting the viewer out (#48) routes
  // it there. The remaining office/spreadsheet formats are still deferred below.
  if (ext === ".odt") return "odt";
  // Audio/video → the native media player (Dev D).
  if (MEDIA_EXTS.has(ext)) return "media";
  // SQLite databases → the table-browser viewer (Dev C).
  if (SQLITE_EXTS.has(ext)) return "sqlite";
  // Spreadsheets → the CSV/TSV table viewer, which loads them via the backend
  // (Dev G). Retires the .xlsx part of the deferred #51 office gap.
  if (SPREADSHEET_EXTS.has(ext)) return "table";
  // .html/.htm/.svg get the rendered-preview viewer with a Preview/Source toggle
  // (Dev E). These are also in TEXT_EXTS, so this specific return must win — like
  // .tex above. Opting it out (#48) falls back to the plain text editor.
  if (ext === ".html" || ext === ".htm" || ext === ".svg") return "html";
  // .yaml/.yml/.json get the structured tree editor with a Tree/Source toggle
  // (#yaml). JSON is YAML's flow syntax — the same tree renders it, written back
  // in the stricter dialect — so the two share a viewer rather than duplicating
  // one. All three are also in TEXT_EXTS, so this specific return must win, like
  // .tex above. Opting it out (#48) falls back to the plain code editor, not the
  // external app (see VIEWER_FALLBACK).
  // A presentation deck (`talk.eldeck.json`) is matched on the FILENAME, not the
  // extension, and must win over the `.json` rule below. `entry.extension` is only
  // the last dotted component — the backend builds it with `Path::extension()` —
  // so a deck arrives here claiming to be a plain `.json` and would otherwise open
  // as a YAML tree. Opting the viewer out lands it there deliberately instead (see
  // VIEWER_FALLBACK); the experimental gate is applied at the dispatch site, not
  // here, so a deck still resolves to a viewer for drag-to-tab either way.
  if (DECK_SUFFIX_RE.test(entry.name)) return "eldeck";
  if (ext === ".yaml" || ext === ".yml" || ext === ".json") return "yaml";
  if (ext && TEXT_EXTS.has(ext)) return "text";
  if (!ext && TEXT_FILENAMES.has(entry.name.toLowerCase())) return "text";
  // DEFERRED (#51, DECISION B): the remaining OpenDocument / spreadsheet formats
  // (.ods/.xlsx/.docx and siblings) do NOT get a native in-app renderer yet —
  // faithful rendering needs a heavy dependency (e.g. calamine + a table/layout
  // renderer). We return null and let them fall through to the external-app path
  // (the "Open externally" affordance). Revisit per-format as lightweight
  // renderers land (.odt already has one above).
  return null;
}

/**
 * The set of native viewers the user has opted out of (#48), derived from
 * `settings.viewer_prefs[id].enabled === false`. Absent/true means enabled, so
 * an empty/missing prefs map yields an empty set (all viewers on). Pass the
 * result to `internalViewerFor` at file-open sites to honour the opt-out.
 */
export function disabledViewers(
  viewerPrefs?: Record<string, { enabled?: boolean }>,
): Set<InternalViewer> {
  const out = new Set<InternalViewer>();
  if (!viewerPrefs) return out;
  for (const t of VIEWER_PREF_TYPES) {
    if (viewerPrefs[t.id]?.enabled === false) out.add(t.id);
  }
  return out;
}

/**
 * Office/spreadsheet formats whose in-app rendering is deferred (#51): they have
 * no native viewer and open in the external app. Exported so the file tree / drop
 * code can recognise them explicitly rather than treating them as generic "no
 * viewer" binaries.
 */
export const DEFERRED_OFFICE_EXTS = new Set([
  ".ods", ".odp", ".docx", ".doc", ".pptx", ".ppt",
]);

/** True when a file is a deferred office/spreadsheet type (#51). */
export function isDeferredOfficeFile(entry: FileEntry): boolean {
  return DEFERRED_OFFICE_EXTS.has((entry.extension ?? "").toLowerCase());
}

/**
 * Native-viewer types surfaced in the per-type settings UI (#48), keyed by the
 * `InternalViewer` id. `autocomplete` marks editable types that support the
 * opt-in local completion (#45). Documented in README under "Native viewers".
 */
export interface ViewerTypeMeta {
  /** Stable key used in `settings.viewer_prefs` and as the React key. */
  id: InternalViewer;
  /** i18n key for the settings UI's label. */
  labelKey: TranslationKey;
  /** Representative extensions, for the settings UI description. */
  extensions: string[];
  /** Whether opt-in local autocomplete applies (#45 — editable text types). */
  autocomplete: boolean;
}

export const VIEWER_PREF_TYPES: ViewerTypeMeta[] = [
  {
    id: "text",
    labelKey: "viewerType.text",
    extensions: [".txt", ".py", ".ts", ".cpp", ".rs", ".java", ".toml", "…"],
    autocomplete: true,
  },
  {
    id: "tex",
    labelKey: "viewerType.tex",
    extensions: [".tex"],
    autocomplete: true,
  },
  {
    id: "markdown",
    labelKey: "viewerType.markdown",
    extensions: [".md", ".markdown", ".mdx"],
    autocomplete: true,
  },
  {
    id: "yaml",
    labelKey: "viewerType.yaml",
    extensions: [".yaml", ".yml", ".json"],
    autocomplete: true,
  },
  {
    id: "bib",
    labelKey: "viewerType.bib",
    extensions: [".bib", ".bibtex"],
    // Autocomplete applies: the Source half of this viewer is the ordinary code
    // editor, and a `.bib` is exactly the kind of prose-in-fields a completion
    // helps with.
    autocomplete: true,
  },
  {
    id: "image",
    labelKey: "viewerType.image",
    extensions: [".png", ".jpg", ".bmp", ".webp", "…"],
    autocomplete: false,
  },
  {
    id: "gif",
    labelKey: "viewerType.gif",
    extensions: [".gif"],
    autocomplete: false,
  },
  { id: "pdf", labelKey: "viewerType.pdf", extensions: [".pdf"], autocomplete: false },
  {
    id: "table",
    labelKey: "viewerType.table",
    extensions: [".csv", ".tsv", ".xlsx", ".xls"],
    autocomplete: false,
  },
  {
    id: "notebook",
    labelKey: "viewerType.notebook",
    extensions: [".ipynb"],
    autocomplete: false,
  },
  {
    id: "diff",
    labelKey: "viewerType.diff",
    extensions: [".diff", ".patch"],
    autocomplete: false,
  },
  {
    id: "odt",
    labelKey: "viewerType.odt",
    extensions: [".odt"],
    autocomplete: false,
  },
  {
    id: "media",
    labelKey: "viewerType.media",
    extensions: [".mp3", ".mp4", ".webm", ".wav", "…"],
    autocomplete: false,
  },
  {
    id: "html",
    labelKey: "viewerType.html",
    extensions: [".html", ".htm", ".svg"],
    autocomplete: false,
  },
  {
    id: "sqlite",
    labelKey: "viewerType.sqlite",
    extensions: [".db", ".sqlite", ".sqlite3"],
    autocomplete: false,
  },
  {
    id: "eldeck",
    labelKey: "viewerType.eldeck",
    extensions: [".eldeck.json"],
    autocomplete: false,
  },
];

/**
 * The line ending `text` uses: CRLF when any line ends that way, else LF.
 *
 * The "any CRLF ⇒ CRLF" rule rather than a majority vote, matching `bib.ts`'s
 * own `lineEndingOf` and `table.ts` — a mixed file is being repaired towards one
 * convention either way, and picking the Windows one never loses a `\r` somebody
 * else's tooling put there.
 */
export function lineEndingOf(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Rewrite every line ending in `text` as `eol`.
 *
 * Idempotent in both directions — it matches `\r?\n` rather than `\n`, so text
 * that already uses the target ending is returned unchanged instead of being
 * doubled into `\r\r\n`. That matters because the caller cannot generally know
 * which convention a buffer is in: an editor buffer is LF once a `<textarea>`
 * has normalized it, but the SEED of that same buffer still holds the file's
 * own endings until the first keystroke goes through the DOM.
 */
export function applyLineEnding(text: string, eol: "\r\n" | "\n"): string {
  return eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
}

export function joinRel(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export function parentRel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function relFromAbs(projectDir: string, absPath: string): string {
  return relativePathWithin(projectDir, absPath) ?? "";
}

// ── File-tree multi-selection (pure logic, unit-tested) ──────────────────────
// Selection is a set of entry *absolute paths*; `ordered` is the flat list of
// visible rows in on-screen order (regular, then scaffold, then gitignored),
// which is what a shift-range spans.

/** The contiguous slice of `ordered` between `anchor` and `target` (inclusive),
 *  order-independent. If either endpoint isn't in `ordered`, falls back to just
 *  `target`. */
export function rangeSelect(ordered: string[], anchor: string, target: string): string[] {
  const a = ordered.indexOf(anchor);
  const b = ordered.indexOf(target);
  if (a === -1 || b === -1) return [target];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return ordered.slice(lo, hi + 1);
}

/** Next selection + anchor after a click on `path`, given the current selection,
 *  the visible order, and the modifier keys:
 *   - shift (with an anchor)  → replace with the anchor→path range.
 *   - toggle (ctrl/cmd)       → flip `path`; anchor becomes `path`.
 *   - plain                   → select only `path`; anchor becomes `path`.
 *  Shift without a prior anchor behaves like a plain click. */
export function nextSelection(
  cur: ReadonlySet<string>,
  ordered: string[],
  anchor: string | null,
  path: string,
  mods: { shift: boolean; toggle: boolean },
): { selected: Set<string>; anchor: string } {
  if (mods.shift && anchor) {
    return { selected: new Set(rangeSelect(ordered, anchor, path)), anchor };
  }
  if (mods.toggle) {
    const selected = new Set(cur);
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    return { selected, anchor: path };
  }
  return { selected: new Set([path]), anchor: path };
}

export function visibleEntries(
  entries: FileEntry[],
  options: {
    showHidden: boolean;
    showStandardFiles: boolean;
    query?: string;
    sortKey?: SortKey;
    descending?: boolean;
    hiddenEndings?: string[];
    // Skip the hiddenEndings exclusion below instead of dropping the match —
    // for a caller (the file tree) that wants those entries kept around so it
    // can bucket them into its own collapsed "hidden by extension" group,
    // rather than have them vanish from the listing entirely.
    keepHiddenEndings?: boolean;
    relPath?: string;
    hiddenPaths?: string[];
    shownPaths?: string[];
  },
): FileEntry[] {
  const query = (options.query ?? "").trim().toLowerCase();
  const sortKey = options.sortKey ?? "name";
  const descending = options.descending ?? false;
  const relPath = (options.relPath ?? "").replace(/^\/+|\/+$/g, "");
  const hiddenEndings = (options.hiddenEndings ?? [])
    .map((ending) => ending.trim().toLowerCase())
    .filter(Boolean);
  const hiddenPaths = new Set((options.hiddenPaths ?? []).map(normalizeRulePath));
  const shownPaths = new Set((options.shownPaths ?? []).map(normalizeRulePath));

  return entries
    .filter((entry) => {
      const entryRelPath = normalizeRulePath(relPath ? `${relPath}/${entry.name}` : entry.name);
      const explicitlyShown = shownPaths.has(entryRelPath);
      if (hiddenPaths.has(entryRelPath) && !explicitlyShown) return false;
      if (explicitlyShown) return true;
      return !INTERNAL_PROJECT_FILES.has(entry.name);
    })
    .filter((entry) => {
      if (options.keepHiddenEndings) return true;
      const entryRelPath = normalizeRulePath(relPath ? `${relPath}/${entry.name}` : entry.name);
      if (shownPaths.has(entryRelPath)) return true;
      return !hiddenEndings.some((ending) => entry.name.toLowerCase().endsWith(ending));
    })
    .filter((entry) => {
      const entryRelPath = normalizeRulePath(relPath ? `${relPath}/${entry.name}` : entry.name);
      // `.gitignore` stays visible by default so it can be opened directly; the
      // hiddenPaths / hiddenEndings filters above still apply to it.
      if (entry.name === ".gitignore") return true;
      return shownPaths.has(entryRelPath) || options.showHidden || !entry.name.startsWith(".");
    })
    .filter((entry) => {
      const entryRelPath = normalizeRulePath(relPath ? `${relPath}/${entry.name}` : entry.name);
      return shownPaths.has(entryRelPath) || options.showStandardFiles || !STANDARD_PROJECT_FILES.has(entry.name);
    })
    .filter((entry) => !query || entry.name.toLowerCase().includes(query))
    .sort((a, b) => compareEntries(a, b, sortKey, descending));
}

function normalizeRulePath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}

// The same match `visibleEntries` uses to drop a hiddenEndings entry, exposed
// so a caller that kept those entries (via `keepHiddenEndings`) can bucket
// them out again — e.g. the file tree's collapsed "hidden by extension" group.
export function isHiddenByEnding(
  entry: FileEntry,
  hiddenEndings: string[],
  relPath: string,
  shownPaths: string[],
): boolean {
  const endings = hiddenEndings.map((ending) => ending.trim().toLowerCase()).filter(Boolean);
  if (endings.length === 0) return false;
  const rel = relPath.replace(/^\/+|\/+$/g, "");
  const entryRelPath = normalizeRulePath(rel ? `${rel}/${entry.name}` : entry.name);
  if (shownPaths.some((p) => normalizeRulePath(p) === entryRelPath)) return false;
  return endings.some((ending) => entry.name.toLowerCase().endsWith(ending));
}

/**
 * A folder's size for sorting. Listings carry `size: 0` for every folder (its
 * recursive size is a separate, async walk), so by default a folder's size is
 * unknown; a caller that has walked folders passes `sizeOf` to sort on the
 * same figure its rows show.
 */
export type EntrySizeOf = (entry: FileEntry) => number | undefined;

const defaultSizeOf: EntrySizeOf = (e) => (e.is_dir ? undefined : e.size);

/** Folders first, then by `sortKey`; see `compareEntries`. Returns a new array. */
export function sortEntries(
  entries: FileEntry[],
  sortKey: SortKey,
  descending: boolean,
  sizeOf: EntrySizeOf = defaultSizeOf,
): FileEntry[] {
  return [...entries].sort((a, b) => compareEntries(a, b, sortKey, descending, sizeOf));
}

// Natural order ("file2" before "file10"), case-insensitive, like file managers.
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "accent" });

function compareNames(a: string, b: string): number {
  return NAME_COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function compareEntries(
  a: FileEntry,
  b: FileEntry,
  sortKey: SortKey,
  descending: boolean,
  sizeOf: EntrySizeOf = defaultSizeOf,
): number {
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;

  const byName = compareNames(a.name, b.name);
  if (sortKey === "name") return descending ? -byName : byName;

  let result: number;
  if (sortKey === "type") {
    // A folder has no type; a dot in its name ("v1.2") is not an extension.
    result = NAME_COLLATOR.compare(a.is_dir ? "" : a.extension ?? "", b.is_dir ? "" : b.extension ?? "");
  } else {
    const [x, y] =
      sortKey === "size" ? [sizeOf(a), sizeOf(b)]
      : sortKey === "created" ? [a.created_secs, b.created_secs]
      : [a.modified_secs, b.modified_secs];
    // An unknown value (an unwalked folder, no creation time over SFTP) sorts
    // after every known one in both directions, rather than posing as 0.
    if (x == null || y == null) {
      if (x != null) return -1;
      if (y != null) return 1;
      return byName;
    }
    result = x - y;
  }
  // Ties stay A→Z whichever way the key runs.
  if (result === 0) return byName;
  return descending ? -result : result;
}

/** Which drawn icon a file row shows; `components/common/icons/FileIcon` renders it. */
export type FileIconKind = "code" | "text" | "data" | "book" | "image" | "script" | "file";

export function fileIconKind(ext: string | null): FileIconKind {
  switch (ext) {
    case ".py":
    case ".rs":
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".go":
    case ".c":
    case ".h":
    case ".cpp":
    case ".cc":
    case ".hpp":
    case ".java":
    case ".kt":
    case ".cs":
    case ".swift":
    case ".rb":
    case ".php":
    case ".lua": return "code";
    case ".md": return "text";
    case ".json": return "data";
    case ".bib": return "book";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".svg": return "image";
    case ".sh": return "script";
    default: return "file";
  }
}

/**
 * Structural equality for two directory listings, field-by-field. Used by the
 * FileTree fs-watch refresh to decide whether a re-fetch actually changed the
 * listing before swapping React state (Eff #1) — replacing a double
 * `JSON.stringify` of the full arrays on every fs-change tick, which is O(n) in
 * both serialization and allocation under an actively-writing agent.
 */
export function fileEntriesEqual(a: FileEntry[], b: FileEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.name !== y.name ||
      x.path !== y.path ||
      x.is_dir !== y.is_dir ||
      x.size !== y.size ||
      x.modified_secs !== y.modified_secs ||
      x.created_secs !== y.created_secs ||
      x.extension !== y.extension ||
      x.mime !== y.mime
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Structural equality for two `string → string` maps (e.g. git status maps),
 * avoiding a `JSON.stringify` round-trip on every fs-change tick (Eff #1).
 */
export function stringMapsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  if (a === b) return true;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// The canonical implementation moved to `lib/formatBytes` (§9.1); the name
// stays for this module's many importers.
export { formatBytes as fmtSize } from "../formatBytes";

export function fmtModified(seconds?: number | null): string {
  if (!seconds) return "";
  const ageMs = Date.now() - seconds * 1000;
  const ageH = ageMs / 3_600_000;
  if (ageH < 1) {
    const mins = Math.floor(ageMs / 60_000);
    return mins <= 1 ? "just now" : `${mins} min ago`;
  }
  if (ageH < 24) {
    const h = Math.floor(ageH);
    return `${h} h ago`;
  }
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
