import { lineStarts, indexedLine } from "../lineIndex";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CompletionCache, completionLineLength, completionWindow, typeThrough, type CompletionGhost } from "../../../lib/viewers/completion/autocomplete";
import { OllamaCompletionProvider } from "../../../lib/viewers/completion/ollamaCompletionProvider";
import { CopilotCompletionProvider, CopilotFeedback, copilotServes } from "../../../lib/viewers/completion/copilotCompletionProvider";
import type { CompletionCandidate, CompletionProvider } from "../../../lib/viewers/completion/completionProvider";
import { completionContext } from "../../../lib/viewers/completion/completionContext";
import { bumpUsage } from "../../../stores/usage";
import { METRIC } from "../../../lib/usageMetrics";
import { ROOT_SCOPE, useTabsStore } from "../../../stores/tabs";
import { useSettingsStore } from "../../../stores/settings";
import { useExperimental } from "../../../lib/experimental";
import { useProjectsStore } from "../../../stores/projects";
import { useScrollSync } from "../../../stores/viewers/scrollSync";
import { highlight, languageForPath, lineCommentMarker } from "../../../lib/viewers/highlight";
import { basename, isPathWithin } from "../../../lib/paths";
import { resolveProjectDirectory, type AutocompleteMode, type GrammarIssue } from "../../../types";
import { ContextFilePicker } from "../ContextFilePicker";
import { useFileScope, usePaneVisible, readFileText } from "../../../lib/files/fileAccess";
import {
  type TexCompletions,
  type TexComplContext,
  findTexComplAt,
  texCompletionsFor,
  insertTexCommand,
  insertTexEnvironment,
  type TexCommandEntry,
  type TexEnvEntry,
  type TexLabelEntry,
  type BibEntry,
  lineStartOffset,
  offsetToLineCol,
  findTexDelimiterMatch,
  findUnclosedTexBrackets,
  findTexEnvNameMatch,
  syncTexEnvRename,
  texEnvNameRangeAt,
  texCommandAt,
  texCommandOccurrences,
  type TexSnippetRange,
} from "../../../lib/viewers/tex/tex";
import {
  actionMatches,
  chordLabel,
  modifierLabel,
  zoomFor,
  type ShortcutMap,
} from "../../../lib/shortcuts/shortcuts";
import { useChordHint } from "../../../lib/shortcuts/shortcutHint";
import { type TexPreview } from "../../../lib/viewers/tex/texPreview";
import { useT } from "../../../lib/i18n";
import { type EditorApi } from "./editableFile";
import {
  applyIndent,
  advanceTexBraceTabStop,
  applyLineComment,
  detectIndentUnit,
  applyAutoIndent,
  decorateIndentGuides,
  INDENT_GUIDE_LANGS,
} from "./indent";
import {
  decorateLinkRanges,
  decorateSnippetRanges,
  findMatches,
  decorateSearchRanges,
  decorateOccurrenceRanges,
  type BracketMatch,
  findMatchingBracket,
  decorateBracketMatch,
  decorateUnclosedBrackets,
  editSpan,
  CHANGE_TIERS,
  CHANGE_DECAY_MS,
  type ChangeRange,
  remapChangeRange,
  decorateChangeRanges,
  type GrammarRange,
  resolveGrammarRanges,
  decorateGrammarRanges,
  applyReplacements,
} from "./decorations";
import {
  useDevicePixelRatio,
  snapToDevicePx,
  type CaretMirrorOffsets,
  textareaWrapWidth,
  textareaMirrorToViewport,
  textareaCaretMirrorOffsets,
} from "./caretMirror";
import { nextAcMode, acModeLabel } from "./editorPrefs";
import { onCtrlWheelFont, useZoomModifierWheel } from "./fontZoom";
import { type BlameLine, isUncommitted, blameRelDate, authorAbbrev } from "./codeTools";

// The ghost-suggestion key legend's Alt chords, rendered once through
// `chordLabel` so they read ⌥ on macOS and Alt elsewhere; the handler itself is
// unchanged (`e.altKey`).
const AC_KEY_LABELS = {
  altRight: chordLabel({ key: "ArrowRight", alt: true }),
  altBrackets: `${chordLabel({ key: "[", alt: true })}/]`,
};

/** A small floating "{Ctrl}+Click to open" hint, anchored just above a hovered
 *  file link (#49). `at` is viewport coordinates of the link's top-left, or null
 *  to hide. Purely informational: pointer-events:none so it never blocks a click. */
export function LinkOpenHint({
  at,
  label,
}: {
  at: { left: number; top: number } | null;
  label?: string;
}) {
  const t = useT();
  if (!at) return null;
  return (
    <div className="link-open-hint" role="tooltip" style={{ left: at.left, top: at.top }}>
      {label ?? t("fileViewer.linkOpenHint", { modifier: modifierLabel() })}
    </div>
  );
}

// #45 automatic autocomplete: idle time after the last keystroke before a
// suggestion is requested for the focused editor. Long enough not to fire on
// every keystroke, short enough to feel responsive.
const AUTO_AC_DEBOUNCE_MS = 600;

// Dictionary spell check (the Hunspell `spell_check` command): idle time after
// the last keystroke before the draft is re-checked. A lookup, not a model call.
const SPELL_DEBOUNCE_MS = 800;

/** Keys that, typed immediately after an accepted completion, replace the
 *  auto-inserted trailing space (closing punctuation reads better tight). */
const NO_SPACE_BEFORE = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}"]);

/** Bare modifier presses, ignored by the smart-space handler so that e.g. the
 *  Shift held to type `?` doesn't prematurely commit the space. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** One row of the TeX completion dropdown. `entry` carries the table row a
 *  command/environment candidate came from, so accepting can seed its arguments
 *  and close its block; a key candidate has none — its `value` is the whole
 *  answer. */
interface TexComplItem {
  value: string;
  detail?: string;
  /** True for a candidate the DOCUMENT defines, which the row marks: a local
   *  macro is the one candidate whose meaning is not general knowledge. */
  local?: boolean;
  entry?: TexCommandEntry | TexEnvEntry;
}

/** Compact one-line description of a bib entry for the dropdown's second column:
 *  author (first surname et al.) and year, falling back to the title. */
function citeDetail(e: { title?: string; author?: string; year?: string }): string | undefined {
  const bits: string[] = [];
  if (e.author) {
    const first = e.author.split(/\s+and\s+/i)[0].trim();
    const surname = first.includes(",") ? first.split(",")[0] : first.split(/\s+/).pop() || first;
    bits.push(e.author.includes(" and ") ? `${surname} et al.` : surname);
  }
  if (e.year) bits.push(e.year);
  const head = bits.join(" ");
  if (head && e.title) return `${head} — ${e.title}`;
  return head || e.title;
}

/** Is the screen point `x,y` inside a `.file-link` span's box? A **collapsed**
 *  rect never counts, however the point compares to it: a zero-by-zero box is
 *  not a hit target — it is a span that isn't laid out (an unmounted or hidden
 *  link layer) — and `0 >= 0 && 0 <= 0` is true on both axes, so the naive
 *  comparison reports a hit on the FIRST link in the document for any click at
 *  the viewport origin. Under jsdom, where every `getBoundingClientRect()` is
 *  all-zeros and a synthetic click defaults to `clientX/clientY = 0`, that made
 *  every Ctrl+click resolve the file's first link regardless of where it landed. */
function linkRectHit(r: DOMRect, x: number, y: number): boolean {
  if (r.width <= 0 || r.height <= 0) return false;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** What the TeX viewer hands the editor to make hovering typeset something
 *  (#tex-hover-preview). Split this way so the editor stays document-agnostic:
 *  it never learns what a preamble is, and the viewer never learns where a span
 *  landed on screen. */
export interface HoverPreviewConfig {
  /** The previewable fragments of the current draft, as source ranges. */
  ranges: (source: string) => TexSnippetRange[];
  /** Typeset one fragment. `stillWanted` is polled by the compile queue, so a
   *  fragment the pointer has left is dropped before it reaches the engine;
   *  `undefined` back means exactly that and nothing should be shown. */
  render: (body: string, stillWanted: () => boolean) => Promise<TexPreview | undefined>;
  /** An already-rendered result for this fragment, if there is one — painted
   *  immediately, so a re-hover never shows a spinner it is about to replace. */
  cached: (body: string) => TexPreview | undefined;
}

/** How long the pointer must rest on a fragment before it is compiled. Long
 *  enough that crossing a page of equations on the way somewhere else starts
 *  nothing, short enough to feel like an answer to the hover rather than an
 *  event of its own. */
const HOVER_PREVIEW_DWELL_MS = 400;

/** How wide the hover card may get, and how far down the window an anchor may
 *  sit before the card opens upwards instead. */
const HOVER_PREVIEW_MAX_W = 520;
const HOVER_PREVIEW_FLIP_AT = 0.6;

export function CodeEditor({
  error,
  draft,
  setDraft,
  loaded,
  save,
  path,
  onFollowLink,
  linkRanges,
  undo,
  redo,
  autocomplete,
  spellCheck,
  texCompletions,
  hoverPreview,
  fontSize,
  lineHeight,
  incFont,
  decFont,
  resetFont,
  wrap,
  gotoLine,
  onGotoApplied,
  onCaretChange,
  onSelectionChange,
  caretApiRef,
  editorApiRef,
  showBlame,
  blame,
  breakpoints,
  onToggleBreakpoint,
  initialScrollTop,
  onScrollPersist,
  groupId,
}: {
  error: string | null;
  draft: string;
  setDraft: (value: string) => void;
  loaded: boolean;
  save: () => void;
  /** File path, used to pick the syntax-highlighting language by extension. */
  path: string;
  /** When set, Ctrl/Cmd+Click resolves the reference at the clicked caret index
   *  and opens it (the LaTeX viewer wires this to `\input{…}` follow). */
  onFollowLink?: (caret: number) => void;
  /** SyncTeX reverse-search target: move the caret to (1-based) `line`/`column`
   *  (`column` 0 = line start) and scroll it into view whenever `nonce` changes. */
  gotoLine?: { line: number; column?: number; nonce: number };
  /** Called once a `gotoLine` request has been applied, so the caller can clear
   *  it (consume the editorJump request). */
  onGotoApplied?: () => void;
  /** Reports the current caret offset (after clicks / key navigation), so the
   *  LaTeX viewer can run SyncTeX forward search from it on compile. */
  onCaretChange?: (offset: number) => void;
  /** Reports the selection `[start, end)` after clicks / key navigation, while
   *  the textarea is focused (the same blur guard as `onCaretChange`). The
   *  beamer bar (#tex-beamer) remembers the last real one: WebKitGTK collapses
   *  a textarea's selection when focus moves to the bar's own number field, so
   *  by the time Wrap is clicked the live selection may already be gone. */
  onSelectionChange?: (start: number, end: number) => void;
  /** When set, receives a getter for the textarea's *live* caret offset (or
   *  `null` if the editor isn't mounted/available). The LaTeX viewer reads this
   *  synchronously at compile time so forward search uses the real cursor even if
   *  no caret event fired this session — `onCaretChange`/its snapshot can be a
   *  stale 0 (e.g. the editor was never focused, or a WebKitGTK blur reset it). */
  caretApiRef?: React.MutableRefObject<(() => number | null) | null>;
  /** When set, receives an imperative editing API so a toolbar (the Markdown
   *  viewer's bold/italic/heading/… controls) can transform the current
   *  value+selection; edits commit through the normal path so undo/redo and the
   *  syntax overlay stay consistent. Cleared on unmount. */
  editorApiRef?: React.MutableRefObject<EditorApi | null>;
  /** When set, returns the source ranges to decorate as clickable file links
   *  (#49). Currently the LaTeX viewer's `\input{…}`/`\includegraphics{…}` args. */
  linkRanges?: (source: string) => { start: number; end: number; hit?: boolean }[];
  /** Undo/redo handlers (#46) — wired to Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. */
  undo?: () => void;
  redo?: () => void;
  /** Opt-in local autocomplete config (#45). Disabled when undefined/off.
   *  `preferred` is the user's active local model (🧠 menu); the completion runs
   *  against whichever model is *currently loaded* in Ollama memory at trigger
   *  time, preferring `preferred` when it is among the loaded set. */
  autocomplete?: { enabled: boolean; preferred?: string; preferredProse?: string; mode?: AutocompleteMode };
  /** Opt-in dictionary (Hunspell) spell check. When enabled the draft is
   *  checked by the backend's loaded dictionary after a short idle; `language`
   *  is the dictionary code (unset → the backend's default). Issues are
   *  underlined with a hover tooltip and one-click fix. */
  spellCheck?: { enabled: boolean; language?: string };
  /** Opt-in `\ref`/`\cite` key completion (LaTeX viewer only). When supplied, a
   *  dropdown of `\label` keys (refs) or `.bib` entry keys (cites) appears while
   *  typing inside a recognised command's braces; Enter/Tab accepts. */
  texCompletions?: TexCompletions;
  /** Opt-in hover preview of the TeX snippet under the pointer
   *  (#tex-hover-preview, LaTeX viewer only). When supplied, resting the pointer
   *  on a formula or a previewable environment typesets that fragment and shows
   *  it in a card over the source. The editor owns the *gesture* — which
   *  fragments are hit boxes, the dwell, the card — and the caller owns the
   *  *compile*, because only the viewer knows the document's preamble, its
   *  folder and the chosen engine. */
  hoverPreview?: HoverPreviewConfig;
  /** Editor font metrics (text-size control). Default 12px / 18px when unset. */
  fontSize?: number;
  lineHeight?: number;
  /** Text-size handlers, wired to Ctrl +/− and Ctrl+0. */
  incFont?: () => void;
  decFont?: () => void;
  resetFont?: () => void;
  /** Soft-wrap long lines to the editor width instead of scrolling horizontally
   *  (used by the LaTeX viewer, whose prose lines run wide). The highlight/link/
   *  ghost overlays wrap in lockstep via the `is-wrapped` class. */
  wrap?: boolean;
  /** Git-blame overlay (#blame). When `showBlame` is set, a per-line blame column
   *  is painted in the gutter (scroll-locked with the line numbers) and the
   *  caret's line gets a faint inline attribution; hovering a blame cell shows a
   *  hovercard. `blame` maps 1-based line numbers to their attribution. */
  showBlame?: boolean;
  blame?: Map<number, BlameLine>;
  /** Debug breakpoints (#py), as 1-based line numbers. When `onToggleBreakpoint`
   *  is wired the gutter becomes interactive: each line number is a click target
   *  that toggles a breakpoint, and a breakpointed line paints a red dot. Only the
   *  Python editor supplies these; every other file type gets the inert,
   *  aria-hidden gutter it had before. */
  breakpoints?: ReadonlySet<number>;
  onToggleBreakpoint?: (line: number) => void;
  /** Persisted vertical scroll (px) to restore once the file loads, so reopening
   *  it (or a Tabtivity restart) lands the reader where they left off (#viewerpos).
   *  Applied once on first load; user scrolling thereafter reports via
   *  `onScrollPersist`. */
  initialScrollTop?: number;
  /** Called (throttled) with the textarea's `scrollTop` as the reader scrolls, so
   *  the position can be persisted. */
  onScrollPersist?: (scrollTop: number) => void;
  /** When set, the subwindow (group) id hosting this editor, so its scroll is
   *  proportionally linked to a side-by-side viewer subwindow (scrollSync). */
  groupId?: string | null;
}) {
  const t = useT();
  const chordHint = useChordHint();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Proportional scroll-link to a paired subwindow (no-op unless linked).
  const reportScrollSync = useScrollSync(groupId, textareaRef);
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  const blameInnerRef = useRef<HTMLDivElement>(null);
  const blameInlineRef = useRef<HTMLDivElement>(null);
  const indentLayerRef = useRef<HTMLPreElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const linkLayerRef = useRef<HTMLPreElement>(null);
  const searchLayerRef = useRef<HTMLPreElement>(null);
  const changeLayerRef = useRef<HTMLPreElement>(null);
  const grammarLayerRef = useRef<HTMLPreElement>(null);
  const bracketLayerRef = useRef<HTMLPreElement>(null);
  const unclosedLayerRef = useRef<HTMLPreElement>(null);
  const snippetLayerRef = useRef<HTMLPreElement>(null);
  const occurrenceLayerRef = useRef<HTMLPreElement>(null);
  const ghostRef = useRef<HTMLPreElement>(null);
  const measureRef = useRef<HTMLPreElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  // Link affordances over a recognised link (#49), only when `onFollowLink` is
  // wired (the LaTeX source editor):
  //  - `linkHover` shows the pointer cursor, but ONLY while the follow modifier is
  //    held, so the editor doesn't read as clickable the rest of the time.
  //  - `linkTip` anchors a "Ctrl+Click to open" hint, shown on plain hover (no
  //    modifier) so the shortcut is discoverable.
  const [linkHover, setLinkHover] = useState(false);
  const [linkTip, setLinkTip] = useState<{ left: number; top: number } | null>(null);
  // Last pointer position, so pressing/releasing the modifier while already
  // hovering a link (no mouse move) can still update the cursor.
  const lastMouse = useRef<{ x: number; y: number } | null>(null);

  // Ctrl/Cmd+wheel resizes the font. Bound non-passively (see
  // useZoomModifierWheel) so it never falls through to native scrolling — and
  // only while the modifier is down, so a plain scroll of a long file isn't
  // main-thread-bound by a listener that would ignore it anyway.
  const wheelRef = useZoomModifierWheel((e) => onCtrlWheelFont(e, incFont, decFont));

  // Resolve the link affordances for the screen point `x,y`. The link layer is
  // scroll-synced to sit exactly over the textarea text, so its `.file-link` span
  // rects are the on-screen link hit boxes — no glyph metrics needed.
  const updateLinkHover = useCallback(
    (x: number, y: number, mod: boolean) => {
      const layer = linkLayerRef.current;
      if (!onFollowLink || !layer) {
        setLinkHover(false);
        setLinkTip(null);
        return;
      }
      let hit: DOMRect | null = null;
      for (const span of layer.querySelectorAll<HTMLElement>(".file-link, .file-link-hit")) {
        const r = span.getBoundingClientRect();
        if (linkRectHit(r, x, y)) {
          hit = r;
          break;
        }
      }
      setLinkHover(hit != null && mod);
      setLinkTip(hit ? { left: hit.left, top: hit.top } : null);
    },
    [onFollowLink],
  );

  // The source offset of the `.file-link` span under a screen point, or null.
  // Used by Ctrl/⌘+click: a modified click does NOT move a textarea's caret, so
  // `selectionStart` is stale there — the span the pointer is actually over is the
  // reliable target, and its `data-off` (see `decorateLinkRanges`) is a real
  // offset inside the reference the follow resolves.
  const linkOffsetAt = useCallback((x: number, y: number): number | null => {
    const layer = linkLayerRef.current;
    if (!layer) return null;
    for (const span of layer.querySelectorAll<HTMLElement>(".file-link, .file-link-hit")) {
      const r = span.getBoundingClientRect();
      if (linkRectHit(r, x, y)) {
        const off = span.getAttribute("data-off");
        return off != null ? Number(off) : null;
      }
    }
    return null;
  }, []);

  // #45 autocomplete: a pending ghost-text suggestion + the caret it applies at.
  const [suggestion, setSuggestion] = useState<CompletionGhost | null>(null);
  // A short status shown to the user when a completion is in flight, returns
  // nothing, or can't run (e.g. no local model loaded) — otherwise the feature
  // fails silently and reads as broken. A trailing "…" marks a transient
  // in-flight message; final messages auto-dismiss (see the effect below).
  const [acStatus, setAcStatus] = useState<string | null>(null);
  const acAbort = useRef<AbortController | null>(null);
  const acDocumentVersion = useRef(0);
  useLayoutEffect(() => { acDocumentVersion.current++; }, [draft, path]);
  const acVisible = usePaneVisible();
  const acCache = useRef(new CompletionCache());
  const acCandidate = useRef(0);
  const acCandidates = useRef<CompletionCandidate[]>([]);
  const acDismissed = useRef<{ draft: string; caret: number } | null>(null);
  const acOutcome = useRef<{ model: string; mode: AutocompleteMode | "copilot" } | null>(null);
  const acEndpoint = useSettingsStore((s) => JSON.stringify([
    s.settings?.ollama_host, s.settings?.ollama_allow_remote_host,
  ]));
  // #45 live completion-length mode: starts from the per-type default and is
  // cycled in-editor with Shift+Tab while a suggestion is showing. Re-seeded if
  // the per-type default changes (e.g. the user picks a new default in settings).
  const [acMode, setAcMode] = useState<AutocompleteMode>(autocomplete?.mode ?? "sentence");
  useEffect(() => {
    setAcMode(autocomplete?.mode ?? "sentence");
  }, [autocomplete?.mode]);

  // Auto-dismiss a finished autocomplete status after a few seconds; keep the
  // in-flight "…" message until the request resolves.
  useEffect(() => {
    if (!acStatus || acStatus.endsWith("…")) return;
    const id = window.setTimeout(() => setAcStatus(null), 4000);
    return () => window.clearTimeout(id);
  }, [acStatus]);

  // #45 context files: extra project files the user attaches as read-only context
  // for completion. Per-editor (not persisted); each entry caches the file's text
  // at attach time so requests don't re-read disk on every keystroke. `acPicker`
  // toggles the QuickOpen-style file picker.
  const [contextFiles, setContextFiles] = useState<
    { rel: string; path: string; content: string }[]
  >([]);
  const [acPicker, setAcPicker] = useState(false);
  const scope = useFileScope();

  // Count one outcome per offered candidate, including partial acceptance.
  const recordAcOutcome = useCallback((accepted: boolean) => {
    const offered = acOutcome.current;
    if (!offered) return;
    acOutcome.current = null;
    bumpUsage(scope ?? ROOT_SCOPE, `${accepted ? METRIC.AUTOCOMPLETE_ACCEPT : METRIC.AUTOCOMPLETE_DISMISS}.${offered.mode}.${offered.model}`);
  }, [scope]);

  // Resolve the project the edited file belongs to (the longest project directory
  // that is a prefix of `path`), falling back to the active project — so the
  // context-file picker lists the right project even in a detached window.
  const acProjectDir = useMemo(() => {
    const { projects, activeId } = useProjectsStore.getState();
    let best = "";
    for (const p of projects) {
      const dir = resolveProjectDirectory(p);
      if (dir && isPathWithin(path, dir) && dir.length > best.length) {
        best = dir;
      }
    }
    if (best) return best;
    const active = projects.find((p) => p.id === activeId);
    return active ? resolveProjectDirectory(active) : "";
  }, [path]);

  const addContextFile = useCallback(
    async (rel: string) => {
      if (!acProjectDir) return;
      const abs = `${acProjectDir}/${rel}`;
      if (contextFiles.some((f) => f.path === abs)) return; // already attached
      try {
        const content = await readFileText(abs, scope);
        setContextFiles((prev) =>
          prev.some((f) => f.path === abs) ? prev : [...prev, { rel, path: abs, content }],
        );
      } catch {
        /* unreadable file: silently skip */
      }
    },
    [acProjectDir, contextFiles, scope],
  );

  const removeContextFile = useCallback((abs: string) => {
    setContextFiles((prev) => prev.filter((f) => f.path !== abs));
  }, []);

  // \ref/\cite key completion (LaTeX viewer): the open dropdown's context, the
  // filtered items, the highlighted index, and the screen anchor. A caret tick
  // re-runs the detector when the caret moves without the text changing (arrow
  // keys / clicks). `complClosedAt` suppresses immediately reopening at the exact
  // caret we dismissed at (e.g. right after accepting a key).
  const [compl, setCompl] = useState<{
    ctx: TexComplContext;
    items: TexComplItem[];
    index: number;
    pos: { left: number; top: number; height: number };
  } | null>(null);
  const [caretTick, setCaretTick] = useState(0);
  const complClosedAt = useRef(-1);
  // The open dropdown's per-token work (see `refreshCompl`): the candidate list
  // for its family and the caret mirror's layout, valid while the text outside
  // `[start, end)` — held here as `prefix`/`suffix` — is unchanged.
  const complSession = useRef<{
    kind: TexComplContext["kind"];
    start: number;
    prefix: string;
    suffix: string;
    candidates: TexLabelEntry[] | BibEntry[] | TexCommandEntry[] | TexEnvEntry[];
    mirror: CaretMirrorOffsets;
  } | null>(null);
  const complListRef = useRef<HTMLUListElement>(null);
  // Keep the highlighted row in view. One effect per dropdown update, rather
  // than a ref callback on the active row: a fresh callback on every render
  // made React re-run it — and its layout-forcing `scrollIntoView` — on every
  // keystroke for every row.
  useEffect(() => {
    if (!compl) return;
    complListRef.current?.querySelector(".active")?.scrollIntoView?.({ block: "nearest" });
  }, [compl]);
  // Source index of a space auto-inserted after `}` when a completion was
  // accepted (else null). If the very next keystroke is closing punctuation, the
  // space is removed so it reads "\cite{x}." rather than "\cite{x} .".
  const autoSpace = useRef<number | null>(null);
  const bumpCaret = useCallback(() => setCaretTick((n) => n + 1), []);

  // Snap the line-height to whole device pixels so the textarea caret and the
  // highlight <pre> share a vertical grid and don't drift apart over a long file
  // under fractional display scaling (see snapToDevicePx).
  const dpr = useDevicePixelRatio();

  const draftLines = useMemo(
    () => (loaded ? draft.split("\n") : [""]),
    [loaded, draft],
  );
  const lineCount = Math.max(1, draftLines.length);

  // In soft-wrap mode (the LaTeX viewer) a logical line can span several visual
  // rows, so the gutter can't use fixed-height rows. We measure each logical
  // line's wrapped height from a hidden, full-width mirror (`measureRef`) and
  // size the gutter cells to match, keeping the numbers aligned. `lineHeights`
  // stays empty in non-wrap mode (where fixed rows are used) and until the first
  // measure; `measureNonce` re-triggers measurement on editor resize.
  const [lineHeights, setLineHeights] = useState<number[]>([]);
  const [measureNonce, bumpMeasure] = useReducer((n: number) => n + 1, 0);

  // Soft-wrap content width (wrap mode only): the textarea's box width less its
  // vertical scrollbar (`textareaWrapWidth`, fractional — a rounded `clientWidth`
  // wraps one row off at fractional box widths). The overlay <pre> layers live in a
  // scrollbar-free, overflow:hidden parent, so left at min-width:100% they wrap
  // at the full box width — wider than the textarea once a vertical scrollbar
  // appears — and the caret drifts from the coloured glyphs over wrapped lines.
  // Constraining the overlays to this width makes every layer wrap identically.
  const [wrapWidth, setWrapWidth] = useState<number | null>(null);
  // Last wrap width the textarea was re-broken at. A vertical scrollbar
  // appearing/disappearing as the document grows past the editor height changes
  // the wrap width WITHOUT changing the border box, so the ResizeObserver below
  // never fires and the textarea keeps its stale wrapping (WebKitGTK won't
  // re-break on its own — see the nudge there). The overlay <pre>s, sized to the
  // fresh width each keystroke, then wrap at a different width, so the
  // coloured glyphs and the last-change tint drift down a row. Tracking the
  // width here lets the wrap layout effect nudge a re-break when it shifts.
  const prevWrapWidth = useRef<number | null>(null);

  // Syntax-highlighted HTML rendered in a <pre> layer behind a transparent
  // textarea, so the file colours by type while staying fully editable. `null`
  // (unknown language or a file too large to re-highlight on each keystroke)
  // means we show the plain opaque textarea instead. A trailing newline mirrors
  // the textarea's own final empty line so scrolling stays aligned.
  const lang = useMemo(() => languageForPath(path), [path]);
  // #45a: Copilot serves this editor only for a consented local project's code
  // file, or its text file under the second opt-in; everything else stays on
  // Ollama. The backend enforces the same gates.
  const copilotEnabled = useExperimental("copilot_completion");
  const acRemote = useProjectsStore((s) => !!s.projects.find((p) => p.id === scope)?.remote);
  const acCopilot = useSettingsStore((s) => copilotServes(s.settings, copilotEnabled, scope, acRemote, lang, path));
  // Per mount, so a remount never inherits the previous mount's document versions.
  const [acEditorId] = useState(() => crypto.randomUUID());
  const acFeedback = useMemo(
    () => (acCopilot && scope ? new CopilotFeedback(scope, acEditorId) : null),
    [acCopilot, scope, acEditorId],
  );
  // Hidden pane, other file, other provider, unmount: the server forgets the
  // document. The next request after a show re-opens it with current content.
  useEffect(() => () => acFeedback?.close(), [acFeedback, path, acVisible, autocomplete?.enabled]);
  const highlighted = useMemo(
    () => (loaded ? highlight(draft, lang) : null),
    [loaded, draft, lang],
  );

  // #49 link-decoration layer (only when a ranges fn is supplied).
  const linkHtml = useMemo(
    () => (loaded && linkRanges ? decorateLinkRanges(draft, linkRanges(draft)) : null),
    [loaded, draft, linkRanges],
  );

  // #tex-hover-preview: the previewable fragments, and the transparent layer
  // whose span boxes are their on-screen hit targets.
  const snippetRanges = useMemo(
    () => (loaded && hoverPreview ? hoverPreview.ranges(draft) : []),
    [loaded, draft, hoverPreview],
  );
  const snippetHtml = useMemo(
    () => (snippetRanges.length ? decorateSnippetRanges(draft, snippetRanges) : null),
    [draft, snippetRanges],
  );

  // #tex-command-occurrences: double-clicking a control sequence in a LaTeX file
  // marks every OTHER use of it in the same file, so "where else do I call this
  // macro" is a gesture rather than a search. State is the command's NAME (plus
  // the offset of the one under the pointer, the one left unmarked because the
  // selection already shows it), not a list of ranges: the ranges are recomputed
  // from the live draft, so an edit elsewhere in the file cannot leave stale
  // marks painted over moved text. Cleared by the next keystroke or mouse-down.
  const [cmdMark, setCmdMark] = useState<{ name: string; at: number } | null>(null);
  const occurrenceRanges = useMemo(() => {
    if (!cmdMark || lang !== "tex") return [];
    return texCommandOccurrences(draft, cmdMark.name).filter((r) => r.start !== cmdMark.at);
  }, [cmdMark, draft, lang]);
  const occurrenceHtml = useMemo(
    () => (occurrenceRanges.length ? decorateOccurrenceRanges(draft, occurrenceRanges) : null),
    [draft, occurrenceRanges],
  );

  // Keep the gutter and the overlay (highlight/link) layers aligned with the
  // textarea scroll. Reads the live textarea so it can be re-run on events that
  // move the scroll WITHOUT firing a scroll event — notably a resize.
  //
  // We translate the layers with a transform rather than setting their own
  // scrollTop/scrollLeft. A long line gives the textarea (overflow:auto) a
  // horizontal scrollbar, which shrinks its client height and inflates its max
  // scrollTop by the scrollbar thickness; the overlays (overflow:hidden) have no
  // scrollbar and a smaller max scrollTop, so mirroring the value would CLAMP at
  // the bottom and shift the whole overlay ~a line out of register. A transform
  // is not clamped to the content, so it tracks the textarea exactly even past
  // the overlay's own scroll range.
  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const { scrollTop, scrollLeft } = ta;
    if (gutterInnerRef.current) {
      gutterInnerRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
    // Blame column + current-line inline hint scroll-lock vertically with the
    // numbers (they never shift horizontally, so translateY only).
    if (blameInnerRef.current) {
      blameInnerRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
    if (blameInlineRef.current) {
      blameInlineRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
    const transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    for (const ref of [
      indentLayerRef,
      highlightRef,
      linkLayerRef,
      searchLayerRef,
      changeLayerRef,
      grammarLayerRef,
      bracketLayerRef,
      unclosedLayerRef,
      snippetLayerRef,
      occurrenceLayerRef,
    ]) {
      if (ref.current) ref.current.style.transform = transform;
    }
    // The ghost layer keeps the inset/overflow:hidden model (it masks the layers
    // beneath with an opaque background, so it can't be sized to its own content
    // like the transform-synced layers); scroll it programmatically instead.
    if (ghostRef.current) {
      ghostRef.current.scrollTop = scrollTop;
      ghostRef.current.scrollLeft = scrollLeft;
    }
  }, []);

  // #viewerpos: restore the saved scroll once the file has loaded (and the
  // textarea can actually reach it), then persist subsequent scrolling. The
  // restore is one-shot so it never fights the reader after the first apply.
  const restoredScroll = useRef(false);
  useEffect(() => {
    if (restoredScroll.current || !loaded) return;
    const ta = textareaRef.current;
    if (!ta) return;
    restoredScroll.current = true;
    if (initialScrollTop && initialScrollTop > 0) {
      ta.scrollTop = initialScrollTop;
      syncScroll();
    }
  }, [loaded, initialScrollTop, syncScroll]);

  // Throttle scroll persistence so a flick of the wheel doesn't churn the store
  // (and its debounced disk save) every frame; the trailing edge captures the
  // final resting position.
  const persistTimer = useRef<number | null>(null);
  const onScroll = () => {
    // Report BEFORE syncing the overlays, and never the other way round. When
    // this pane is scroll-linked, `reportScrollSync` reads `scrollHeight` —
    // a layout-flushing read. Running it after `syncScroll` has just written a
    // `transform` to the gutter and every overlay layer means the read has to
    // flush those pending writes first, i.e. a forced style+layout pass over
    // the whole document on every scroll event. Reading first costs nothing:
    // scrolling on its own doesn't dirty layout, so the geometry is already
    // current, and the writes then land against a clean tree.
    reportScrollSync();
    syncScroll();
    if (!onScrollPersist || !restoredScroll.current) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const top = ta.scrollTop;
    if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => onScrollPersist(top), 200);
  };
  useEffect(
    () => () => {
      if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    },
    [],
  );

  // #67 in-editor search (Ctrl/Cmd+F) and find-and-replace (Ctrl/Cmd+R). A
  // floating bar over the editor with next/previous navigation, a live match
  // count, and a case toggle; matches are painted by a transparent overlay layer
  // (`decorateSearchRanges`) aligned to the textarea exactly like the highlight/
  // link layers. Ctrl/Cmd+R opens the same bar with the replace row revealed.
  const [findOpen, setFindOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(0);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(
    () => (loaded && findOpen && query ? findMatches(draft, query, caseSensitive) : []),
    [loaded, findOpen, draft, query, caseSensitive],
  );
  const searchHtml = useMemo(
    () => (matches.length > 0 ? decorateSearchRanges(draft, matches, current) : null),
    [draft, matches, current],
  );

  // 1-based line numbers that hold a match (and the current match's line), so the
  // gutter can mark where the hits are (#67). A line number is 1 + the count of
  // newlines before the match's start offset.
  const starts = useMemo(() => lineStarts(draft), [draft]);
  const matchLineSet = useMemo(() => {
    const set = new Set<number>();
    for (const m of matches) set.add(indexedLine(starts, m.start));
    return set;
  }, [matches, starts]);
  const currentMatchLine = useMemo(() => {
    const m = matches[current];
    return m ? indexedLine(starts, m.start) : 0;
  }, [matches, current, starts]);

  // Indent guides: one hairline at the start of every indentation level the file
  // actually uses. The unit is read out of the text (`detectIndentUnit`) rather
  // than assumed, and is the same one Enter indents by, so what the reader sees
  // and what typing produces cannot disagree. Both memos are keyed on `draft`,
  // which the whole-document `highlight` pass already is — this costs a single
  // extra walk per keystroke, not a new order of work.
  const indentUnit = useMemo(() => detectIndentUnit(draft), [draft]);
  const indentHtml = useMemo(
    () =>
      loaded && INDENT_GUIDE_LANGS(lang) ? decorateIndentGuides(draft, indentUnit) : null,
    [loaded, lang, draft, indentUnit],
  );

  // TeX structure diagnostics are persistent rather than caret-local: every
  // delimiter left without a partner is red, and every logical line holding one
  // is marked in the gutter. Other editor languages keep their existing
  // behaviour. Each range carries its own hover hint, since the three mistakes
  // the scanner separates — an opening delimiter with no end, a `\begin` with no
  // `\end`, an `\end` with no `\begin` — read as different sentences and the
  // environment ones can name the environment.
  const unclosedBrackets = useMemo(() => {
    if (!loaded || lang !== "tex") return [];
    return findUnclosedTexBrackets(draft).map((range) => ({
      ...range,
      hint:
        range.problem === "unmatchedEnd"
          ? t("fileViewer.unmatchedEndHint", { env: range.env ?? "" })
          : range.env != null
            ? t("fileViewer.unclosedEnvHint", { env: range.env })
            : t("fileViewer.unclosedBracketHint"),
    }));
  }, [loaded, lang, draft, t]);
  const unclosedHtml = useMemo(
    () =>
      unclosedBrackets.length > 0
        ? decorateUnclosedBrackets(draft, unclosedBrackets)
        : null,
    [draft, unclosedBrackets],
  );
  const unclosedLineSet = useMemo(() => {
    const set = new Set<number>();
    for (const range of unclosedBrackets) {
      set.add(indexedLine(starts, range.start));
    }
    return set;
  }, [starts, unclosedBrackets]);
  const [unclosedTip, setUnclosedTip] = useState<{
    left: number;
    top: number;
    hint: string;
  } | null>(null);

  // Bracket-match highlight: whichever bracket the caret sits just before/after
  // gets its partner highlighted too (`findMatchingBracket`/`decorateBracketMatch`
  // — mirrors the search overlay). For a `.tex` file, when the plain ()[]{}
  // matcher finds nothing, fall back to `lib/viewers/tex/tex.ts`'s LaTeX-aware
  // extras: math-mode toggles (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) and
  // `\begin{env}…\end{env}` structure blocks — LaTeX syntax the generic
  // matcher doesn't (and shouldn't, for every other file type) know about.
  // Re-run on every text change AND every caret move (`caretTick`, bumped by
  // `emitCaret`), reading the textarea's *live* selectionStart rather than a
  // stashed offset — the same reason `refreshCompl` does, since a keystroke
  // changes `draft` and the caret in the same tick and a stale offset would
  // highlight last render's position.
  const [bracketMatch, setBracketMatch] = useState<BracketMatch | null>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!loaded || !el) {
      setBracketMatch(null);
      return;
    }
    const offset = el.selectionStart;
    // For `.tex`, a caret inside a `\begin{…}`/`\end{…}` name marks the PARTNER's
    // name — checked ahead of the plain matcher, which at the name's edges would
    // otherwise pair that token's own `{`/`}` and say nothing about the partner.
    const envName = lang === "tex" ? findTexEnvNameMatch(draft, offset) : null;
    // A selection is not a caret and normally clears the overlay — with one
    // exception: the click-into-the-braces gesture selects exactly an environment
    // name, and that is precisely when the partner is worth pointing at.
    if (el.selectionStart !== el.selectionEnd) {
      const onName =
        envName != null &&
        [envName.open, envName.close].some(
          (s) => s.start === el.selectionStart && s.end === el.selectionEnd,
        );
      setBracketMatch(onName ? envName : null);
      return;
    }
    const match =
      envName ??
      findMatchingBracket(draft, offset) ??
      (lang === "tex" ? findTexDelimiterMatch(draft, offset) : null);
    setBracketMatch(match);
  }, [draft, caretTick, loaded, lang]);
  const bracketHtml = useMemo(
    () => (bracketMatch ? decorateBracketMatch(draft, bracketMatch) : null),
    [draft, bracketMatch],
  );

  // ── Git blame overlay (#blame) ─────────────────────────────────────────────
  // When `showBlame` is set, the gutter grows a per-line blame column (its own
  // inner, scroll-synced with the numbers), the caret's line gets a faint inline
  // attribution, and hovering a blame cell shows a hovercard. All read-only —
  // nothing here touches the editable textarea/highlight/save path.
  const [caretLine, setCaretLine] = useState(1);
  const [blameTip, setBlameTip] = useState<{ left: number; top: number; line: number } | null>(null);
  const effectiveLineHeight = lineHeight ?? Math.round((fontSize ?? 12) * 1.5);

  // Top offset (px, before scroll) of a 1-based line's first row. Mirrors the
  // gutter/editor 10px top padding and the wrap-mode measured `lineHeights`.
  const lineTop = useCallback(
    (line: number) => {
      let top = 10; // `.file-viewer-highlight/-editor` padding-top
      const idx = Math.max(0, line - 1);
      if (wrap && lineHeights.length) {
        for (let i = 0; i < idx && i < lineHeights.length; i++) top += lineHeights[i];
      } else {
        top += idx * effectiveLineHeight;
      }
      return top;
    },
    [wrap, lineHeights, effectiveLineHeight],
  );

  const caretBlame = showBlame ? blame?.get(caretLine) : undefined;

  // Age-tint a blame cell: newer commits are more saturated, decaying with age
  // so the column reads as a heat-map of recent activity. No tint for
  // uncommitted/unknown lines.
  const blameTint = useCallback((b: BlameLine | undefined): string | undefined => {
    if (!b || isUncommitted(b) || !b.author_time) return undefined;
    const ageDays = Math.max(0, (Date.now() / 1000 - b.author_time) / 86400);
    const a = 0.16 * Math.exp(-ageDays / 180);
    if (a < 0.01) return undefined;
    return `rgba(120, 150, 220, ${a.toFixed(3)})`;
  }, []);

  const onBlameMove = useCallback(
    (e: React.MouseEvent) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>(".file-viewer-blame-line");
      const line = cell ? Number(cell.dataset.line) : 0;
      const b = line ? blame?.get(line) : undefined;
      if (!cell || !b || isUncommitted(b)) {
        setBlameTip(null);
        return;
      }
      setBlameTip({ left: e.clientX, top: e.clientY, line });
    },
    [blame],
  );

  // Keep the current index in range as the draft (and so the match set) changes.
  useEffect(() => {
    if (current > 0 && current >= matches.length) {
      setCurrent(matches.length > 0 ? matches.length - 1 : 0);
    }
  }, [matches.length, current]);

  // Place the textarea selection on match `index` and scroll its line to roughly
  // the middle of the view. Focus stays in the find input so Enter keeps cycling;
  // the overlay's `current` highlight shows where we are. The line-based scroll
  // mirrors the SyncTeX `gotoLine` math (approximate under soft-wrap, exact else).
  const revealMatch = useCallback(
    (index: number) => {
      const el = textareaRef.current;
      const m = matches[index];
      if (!el || !m) return;
      el.selectionStart = m.start;
      el.selectionEnd = m.end;
      const line = indexedLine(starts, m.start); // 1-based
      // Wrap-aware vertical offset, mirroring the SyncTeX `gotoLine` math: under
      // soft-wrap (the TeX viewer) a logical line's top is the SUM of the measured
      // wrapped-row heights, not `(line-1)·lineHeight`. The naive form undershoots
      // on wide-prose files and scrolled the match off-screen, so the search never
      // appeared to jump to it. `lineTop` handles both wrap and fixed-row modes.
      const target = lineTop(line) - el.clientHeight / 2 + effectiveLineHeight / 2;
      el.scrollTop = Math.max(0, target);
      syncScroll();
    },
    [matches, starts, syncScroll, lineTop, effectiveLineHeight],
  );

  const goToMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches.length === 0) return;
      const next = (current + dir + matches.length) % matches.length;
      setCurrent(next);
      revealMatch(next);
    },
    [matches.length, current, revealMatch],
  );

  const openFind = useCallback((replace = false) => {
    const el = textareaRef.current;
    const sel =
      el && el.selectionStart !== el.selectionEnd
        ? el.value.slice(el.selectionStart, el.selectionEnd)
        : "";
    if (sel && !sel.includes("\n")) setQuery(sel);
    setFindOpen(true);
    if (replace) setReplaceOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setReplaceOpen(false);
    textareaRef.current?.focus();
  }, []);

  // Latest draft, read by closures (compile/forward-search/diff) that must see the
  // current text without re-subscribing.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Change-tint trail: tint recently typed runs with a sequential new→old colour
  // gradient that fades as typing continues. Every edit flows through `edit`,
  // which diffs old→new: the new run becomes tier 0 (newest), existing runs are
  // re-mapped through the edit so they keep tracking their characters and are
  // pushed one tier older; anything past CHANGE_TIERS or overwritten by the edit
  // drops off. `lastEditRef` lets the effect tell our own edits from a draft
  // change by another path (disk reload, undo/redo) and clear a now-stale trail.
  // Reloads go through the parent's `reset`, never `edit`, so they never light the
  // trail. A short idle decay retires the oldest run on a timer so the trail
  // fades away after typing stops. The whole feature is gated on the (default-ON)
  // `change_tint` setting.
  const changeTint = useSettingsStore((s) => s.settings?.change_tint !== false);
  // The editor's own chords (`editor*`, zoom), rebindable in Keyboard Shortcuts.
  const shortcutOverrides = useSettingsStore((s) => s.settings?.keyboard_shortcuts) as ShortcutMap | undefined;
  const changeTintRef = useRef(changeTint);
  changeTintRef.current = changeTint;
  const [changes, setChanges] = useState<ChangeRange[]>([]);
  const lastEditRef = useRef<string | null>(null);
  // Record ONE changed run in the trail. Split out of `edit` because a coupled
  // `\begin`/`\end` rename changes the document in two places at once, and
  // `editSpan` — which pares off a common prefix and suffix — can only report ONE
  // run: for the two it would hand back everything between them, tinting the
  // whole environment body. So such an edit is booked as its two real runs in
  // sequence, each against the text the previous one produced.
  const noteChangeTrail = useCallback((prevText: string, nextText: string) => {
    const span = editSpan(prevText, nextText);
    if (!span) return;
    setChanges((prev) => {
      const remapped = prev
        .map((r) => remapChangeRange(r, span))
        .filter((r): r is { start: number; end: number } => r != null);
      const merged =
        span.endNext > span.start
          ? [{ start: span.start, end: span.endNext }, ...remapped]
          : remapped;
      // newest-first → re-index so tier === age (0 = newest).
      return merged.slice(0, CHANGE_TIERS).map((r, i) => ({ ...r, tier: i }));
    });
  }, []);
  // Commit a new draft. `via` is the intermediate text an edit passed through
  // when it landed in two places — the document with only the user's own
  // keystroke in it — so the trail books "what was typed" and "what was mirrored"
  // as the two separate runs they are. Still ONE `setDraft`, so it stays one
  // undo step.
  const edit = useCallback(
    (next: string, via?: string) => {
      if (next !== draftRef.current) {
        acCandidates.current = [];
        acAbort.current?.abort();
        acAbort.current = null;
        setAcStatus(null);
        const before = draftRef.current;
        if (suggestion) {
          const inserted = next.slice(suggestion.at, suggestion.at + next.length - before.length);
          const matches = next.length > before.length && suggestion.text.startsWith(inserted) &&
            next === before.slice(0, suggestion.at) + inserted + before.slice(suggestion.at);
          recordAcOutcome(matches);
          if (matches) acFeedback?.accept(inserted);
        }
        setSuggestion((ghost) => typeThrough(before, next, ghost));
        if (changeTintRef.current) {
          const stages =
            via != null && via !== draftRef.current && via !== next ? [via, next] : [next];
          let from = draftRef.current;
          for (const stage of stages) {
            noteChangeTrail(from, stage);
            from = stage;
          }
        }
        lastEditRef.current = next;
      }
      setDraft(next);
    },
    [setDraft, noteChangeTrail, suggestion, recordAcOutcome, acFeedback],
  );

  // Where the caret and the view belong once React has re-rendered the textarea
  // with text we changed behind the user's back. Both are needed together, and
  // the SCROLL is the load-bearing half: a controlled textarea whose `value` prop
  // no longer matches the DOM is updated by assigning `.value`, which drops the
  // caret at the END of the document and scrolls there — so a mirrored rename two
  // lines into a long file threw the view to its last line on every keystroke.
  // Restoring in the layout effect below (before paint) rather than a rAF (after
  // it) is what makes the correction invisible instead of a visible bounce.
  const pendingSelRef = useRef<{ start: number; end: number } | null>(null);
  const pendingScrollRef = useRef<{ top: number; left: number } | null>(null);

  // The textarea's own change, with one LaTeX rule in front of it: renaming a
  // `\begin{env}` renames its `\end{env}` in the same keystroke (and the other
  // way round), so an environment can be retyped in place instead of leaving the
  // document briefly — or permanently — unbalanced. `syncTexEnvRename` decides
  // whether the edit was that; anything else falls through untouched (React then
  // leaves the DOM alone, since the new value is already what the user typed),
  // and either way it is ONE `edit` call, so a coupled rename is one undo step.
  const onTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      const value = el.value;
      if (lang === "tex") {
        const synced = syncTexEnvRename(draftRef.current, value, el.selectionStart);
        if (synced) {
          pendingSelRef.current = { start: synced.caret, end: synced.caret };
          pendingScrollRef.current = { top: el.scrollTop, left: el.scrollLeft };
          // `value` is the document with only what the user typed in it — the
          // trail books that run and the mirrored one separately (see `edit`).
          edit(synced.text, value);
          return;
        }
      }
      edit(value);
    },
    [edit, lang],
  );
  // Drop a stale trail when the draft changes by some path other than our own
  // `edit` (disk reload, undo/redo), and clear it when the feature is turned off.
  useEffect(() => {
    if (lastEditRef.current !== null && draft !== lastEditRef.current) {
      setChanges([]);
      lastEditRef.current = null;
    }
  }, [draft]);
  useEffect(() => {
    if (!changeTint) setChanges([]);
  }, [changeTint]);
  // Idle decay: each keystroke resets this timer (re-runs on every `changes`
  // update), so while typing the trail stays; once typing stops it retires the
  // oldest run every CHANGE_DECAY_MS until the trail is gone.
  useEffect(() => {
    if (changes.length === 0) return;
    const id = window.setTimeout(() => {
      setChanges((prev) => prev.slice(0, -1).map((r, i) => ({ ...r, tier: i })));
    }, CHANGE_DECAY_MS);
    return () => window.clearTimeout(id);
  }, [changes]);
  const changeHtml = useMemo(
    () => (loaded && changeTint && changes.length ? decorateChangeRanges(draft, changes) : null),
    [loaded, draft, changes, changeTint],
  );

  // ── Spell-check overlay ─────────────────────────────────────────────────────
  // The dictionary's issues are resolved to ranges against the live draft (so
  // they self-heal across small edits) and underlined, with a hover tooltip.
  const [spellIssues, setSpellIssues] = useState<GrammarIssue[]>([]);
  // One status report per session for a failing/missing dictionary — an error
  // on every idle pause would be noise; markless is the steady signal.
  const spellReported = useRef(false);
  const [grammarStatus, setGrammarStatus] = useState<string | null>(null);
  const [grammarTip, setGrammarTip] = useState<
    { left: number; top: number; range: GrammarRange } | null
  >(null);
  // Close the hover tooltip on a short delay, so the pointer can travel from the
  // underlined mark up into the tooltip (to click Apply) without it vanishing.
  const grammarTipTimer = useRef<number | null>(null);
  const cancelGrammarTipClose = useCallback(() => {
    if (grammarTipTimer.current != null) {
      window.clearTimeout(grammarTipTimer.current);
      grammarTipTimer.current = null;
    }
  }, []);
  const scheduleGrammarTipClose = useCallback(() => {
    cancelGrammarTipClose();
    grammarTipTimer.current = window.setTimeout(() => setGrammarTip(null), 250);
  }, [cancelGrammarTipClose]);
  useEffect(() => () => cancelGrammarTipClose(), [cancelGrammarTipClose]);

  const grammarRanges = useMemo(
    () => (loaded && spellIssues.length ? resolveGrammarRanges(draft, spellIssues) : []),
    [loaded, draft, spellIssues],
  );
  const grammarHtml = useMemo(
    () => (grammarRanges.length ? decorateGrammarRanges(draft, grammarRanges) : null),
    [draft, grammarRanges],
  );

  // Re-apply the scroll transform whenever an overlay layer's presence changes.
  // syncScroll only runs on scroll events and the one-shot restore, but the
  // change trail (and the search layer) mounts lazily — only once there's
  // an edit or an active find. A layer that first mounts while the textarea is
  // already scrolled starts at translate(0,0), i.e. `scrollTop` px too low, and
  // stays out of register until the next scroll. Syncing on mount pins it to the
  // current offset immediately. useLayoutEffect so it lands before paint.
  useLayoutEffect(() => {
    syncScroll();
  }, [
    loaded,
    highlighted,
    linkHtml,
    searchHtml,
    changeHtml,
    grammarHtml,
    syncScroll,
  ]);

  // Auto-dismiss a finished grammar status; keep an in-flight "…" message.
  useEffect(() => {
    if (!grammarStatus || grammarStatus.endsWith("…")) return;
    const id = window.setTimeout(() => setGrammarStatus(null), 4000);
    return () => window.clearTimeout(id);
  }, [grammarStatus]);

  // Dictionary spell check: re-check the draft a short while after the user
  // stops typing. A lookup rather than a model call, so it affords the shorter
  // debounce; marks clear the moment the feature is turned off. A missing
  // dictionary reports through the shared status line, once per session.
  useEffect(() => {
    if (!spellCheck?.enabled || !loaded) {
      setSpellIssues([]);
      // Re-arm the once-per-enable failure report: a check that fails again
      // after the chip is toggled off and on (or the dictionary changed
      // underneath) must say so again, not stay silent for the session.
      spellReported.current = false;
      return;
    }
    // A check still in flight when the draft changes (or the feature is turned
    // off) is superseded: its answer must not land over the newer one.
    let stale = false;
    const id = window.setTimeout(async () => {
      try {
        const issues = await invoke<GrammarIssue[]>("spell_check", {
          text: draftRef.current,
          language: spellCheck.language ?? "",
          doc: lang === "plain" ? "" : lang,
        });
        if (!stale) setSpellIssues(issues);
      } catch (e) {
        if (stale) return;
        setSpellIssues([]);
        if (!spellReported.current) {
          spellReported.current = true;
          setGrammarStatus(
            String(e).includes("no_dictionary")
              ? t("fileViewer.spellingUnavailable")
              : t("fileViewer.spellingFailed"),
          );
        }
      }
    }, SPELL_DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(id);
    };
    // Primitive deps (the config object's identity changes every render) so the
    // idle-check timer isn't reset by unrelated re-renders.
  }, [spellCheck?.enabled, spellCheck?.language, loaded, draft, lang, t]);

  // A new dictionary choice gets its own failure report (the flag above only
  // resets when the chip goes off).
  useEffect(() => {
    spellReported.current = false;
  }, [spellCheck?.language]);

  // Keep the grammar overlay aligned after it mounts/changes.
  useEffect(() => {
    if (grammarHtml) syncScroll();
  }, [grammarHtml, syncScroll]);

  // Keep the bracket-match overlay aligned after it mounts (it toggles on/off as
  // the caret moves onto/off a bracket, so a freshly-mounted <pre> would
  // otherwise sit un-scrolled at translate(0,0) until the next scroll event).
  useEffect(() => {
    if (bracketHtml) syncScroll();
  }, [bracketHtml, syncScroll]);

  // This layer mounts/unmounts as the document becomes balanced. Align a fresh
  // layer immediately when the editor is already scrolled.
  useEffect(() => {
    if (unclosedHtml) syncScroll();
    else setUnclosedTip(null);
  }, [unclosedHtml, syncScroll]);

  // The indent layer mounts the moment the first line is indented — align it
  // straight away, for the reason the two layers above are aligned.
  useEffect(() => {
    if (indentHtml) syncScroll();
  }, [indentHtml, syncScroll]);

  // Apply a single issue's suggested fix: replace its resolved range with the
  // suggestion and drop the issue so its mark clears (the rest re-resolve against
  // the new draft). Leaves the caret after the inserted text.
  const applyGrammarFix = useCallback(
    (range: GrammarRange) => {
      const repl = range.issue.suggestion;
      edit(applyReplacements(draftRef.current, [{ start: range.start, end: range.end }], repl));
      setSpellIssues((prev) => prev.filter((i) => i !== range.issue));
      setGrammarTip(null);
      const caret = range.start + repl.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) el.selectionStart = el.selectionEnd = caret;
      });
    },
    [edit],
  );

  // Hit-test the grammar overlay at a screen point, returning the range under the
  // cursor (its span carries `data-gi`, an index into `grammarRanges`). Mirrors
  // the link-layer hit-test: the layer is scroll-synced over the textarea text, so
  // its span rects are the on-screen marks.
  const grammarHitAt = useCallback(
    (x: number, y: number): GrammarRange | null => {
      const layer = grammarLayerRef.current;
      if (!layer) return null;
      for (const span of layer.querySelectorAll<HTMLElement>(".file-viewer-grammar-mark")) {
        const r = span.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const gi = Number(span.dataset.gi);
          return grammarRanges[gi] ?? null;
        }
      }
      return null;
    },
    [grammarRanges],
  );

  // The textarea owns pointer events, so hover-test the scroll-aligned diagnostic
  // layer's span boxes (the same technique used for grammar marks and links).
  const unclosedTipAt = useCallback(
    (x: number, y: number): { left: number; top: number; hint: string } | null => {
      const layer = unclosedLayerRef.current;
      if (!layer) return null;
      for (const span of layer.querySelectorAll<HTMLElement>(".file-viewer-unclosed-bracket")) {
        const r = span.getBoundingClientRect();
        if (linkRectHit(r, x, y)) {
          return { left: x, top: r.top, hint: span.dataset.hint ?? "" };
        }
      }
      return null;
    },
    [],
  );

  // ── #tex-hover-preview: the hover card ────────────────────────────────────
  // The pointer resting on a fragment typesets it. Three pieces of state, and
  // the split matters: `hoveredBody` is what the POINTER is on right now (a ref,
  // because the compile queue polls it to decide whether its run is still
  // wanted, and a state read inside a closure would be the value at hover time),
  // while `preview` is what the CARD is showing.
  const [preview, setPreview] = useState<{
    body: string;
    si: number; // index into `snippetRanges`: which span the card is about
    anchor: { left: number; top: number; bottom: number };
    result: TexPreview | null; // null = still compiling
  } | null>(null);
  const hoveredBody = useRef<string | null>(null);
  const previewTimer = useRef<number | null>(null);

  // Wash the fragment under the pointer. Toggled on the element rather than by a
  // `:hover` rule, because the layer takes no pointer events and an element that
  // is never hit-tested is never `:hover`ed — and rather than by re-rendering the
  // layer with the index in it, which would rebuild the whole document's HTML on
  // every pointer move. A stale ref left by a re-render is harmless: removing a
  // class from a detached node does nothing, and the next move re-marks.
  const hoveredSpan = useRef<HTMLElement | null>(null);
  const markHoveredSpan = useCallback((el: HTMLElement | null) => {
    if (hoveredSpan.current === el) return;
    hoveredSpan.current?.classList.remove("is-hovered");
    hoveredSpan.current = el;
    el?.classList.add("is-hovered");
  }, []);

  // Mark the fragment the CARD is showing — a stronger mark than the pointer
  // wash, and tied to the card rather than the pointer: the wash says "this is
  // previewable", this says "this is what you are looking at", and the two
  // differ for the whole dwell before a compile lands. Toggled as a class for
  // the same reason as the wash, but found by INDEX rather than kept as a node:
  // a keystroke rebuilds the layer (the card stays open — only leaving the
  // fragment closes it), which would detach the marked span and leave the open
  // card pointing at unmarked source. Re-finding the span whenever the layer's
  // HTML changes, and only while the fragment still reads as the card's body,
  // keeps the mark on the text for as long as the card is honest about it.
  const previewedSpan = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let el: HTMLElement | null = null;
    if (preview && snippetHtml != null) {
      const range = snippetRanges[preview.si];
      if (range && draft.slice(range.start, range.end) === preview.body) {
        el =
          snippetLayerRef.current?.querySelector<HTMLElement>(
            `.file-viewer-tex-snippet[data-si="${preview.si}"]`,
          ) ?? null;
      }
    }
    if (previewedSpan.current === el) return;
    previewedSpan.current?.classList.remove("is-previewed");
    previewedSpan.current = el;
    el?.classList.add("is-previewed");
  }, [preview, snippetHtml, snippetRanges, draft]);

  const cancelPreviewTimer = useCallback(() => {
    if (previewTimer.current != null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
  }, []);
  const closePreview = useCallback(() => {
    cancelPreviewTimer();
    hoveredBody.current = null;
    markHoveredSpan(null);
    setPreview(null);
  }, [cancelPreviewTimer, markHoveredSpan]);
  useEffect(() => () => cancelPreviewTimer(), [cancelPreviewTimer]);

  // Hit-test the snippet layer at a screen point: its spans carry `data-si`, an
  // index into `snippetRanges`. This runs on EVERY pointer move, so it must not
  // do what the (rarer) link/grammar hit-tests do — measure every span in the
  // layer — which on a page of equations is hundreds of getBoundingClientRect
  // calls per move. Instead the layer is hit-testable (see its pointer-events
  // note in viewers.css: the textarea above it still receives every real event)
  // and one `elementsFromPoint` asks the engine, which already knows the answer.
  // Plural, because `elementFromPoint` would only ever return the textarea on top.
  const snippetHitAt = useCallback(
    (x: number, y: number): { range: TexSnippetRange; si: number; rect: DOMRect; span: HTMLElement } | null => {
      const layer = snippetLayerRef.current;
      if (!layer) return null;
      if (typeof document.elementsFromPoint === "function") {
        for (const el of document.elementsFromPoint(x, y)) {
          if (el === layer) break; // reached the layer itself: no span here
          if (!(el instanceof HTMLElement) || !layer.contains(el)) continue;
          if (!el.classList.contains("file-viewer-tex-snippet")) continue;
          const si = Number(el.dataset.si);
          const range = snippetRanges[si];
          return range ? { range, si, rect: el.getBoundingClientRect(), span: el } : null;
        }
        return null;
      }
      // jsdom lays nothing out and has no elementsFromPoint; keep the measured
      // scan so the tests exercise the same downstream path.
      for (const span of layer.querySelectorAll<HTMLElement>(".file-viewer-tex-snippet")) {
        const r = span.getBoundingClientRect();
        if (linkRectHit(r, x, y)) {
          const si = Number(span.dataset.si);
          const range = snippetRanges[si];
          if (range) return { range, si, rect: r, span };
        }
      }
      return null;
    },
    [snippetRanges],
  );


  const updateSnippetHover = useCallback(
    (x: number, y: number) => {
      if (!hoverPreview) return;
      const hit = snippetHitAt(x, y);
      if (!hit) {
        // Leaving the fragment closes the card AND cancels the pending compile —
        // a preview nobody is waiting for is the one case this feature must not
        // pay the engine for.
        if (hoveredBody.current != null) closePreview();
        return;
      }
      markHoveredSpan(hit.span);
      const body = draftRef.current.slice(hit.range.start, hit.range.end);
      // The same fragment: the card is already open (or on its way) and must not
      // be re-anchored under the pointer as it drifts across the formula.
      if (hoveredBody.current === body) return;
      cancelPreviewTimer();
      hoveredBody.current = body;
      const at = { left: hit.rect.left, top: hit.rect.top, bottom: hit.rect.bottom };
      const cached = hoverPreview.cached(body);
      if (cached) {
        setPreview({ body, si: hit.si, anchor: at, result: cached });
        return;
      }
      setPreview(null);
      previewTimer.current = window.setTimeout(() => {
        previewTimer.current = null;
        if (hoveredBody.current !== body) return;
        setPreview({ body, si: hit.si, anchor: at, result: null });
        void hoverPreview
          .render(body, () => hoveredBody.current === body)
          .then((out) => {
            if (hoveredBody.current !== body || !out) return;
            setPreview((cur) => (cur && cur.body === body ? { ...cur, result: out } : cur));
          });
      }, HOVER_PREVIEW_DWELL_MS);
    },
    [hoverPreview, snippetHitAt, cancelPreviewTimer, closePreview, markHoveredSpan],
  );

  // Replace the current match (#67). We re-place the textarea selection on the
  // match first so the change history records a single, intelligible edit, then
  // splice `replaceWith` in via setDraft. The match set recomputes on the new
  // draft; the live `current` clamp keeps the index in range, leaving the next
  // occurrence selected so repeated Replace walks through them.
  const replaceCurrent = useCallback(() => {
    const m = matches[current];
    if (!m) return;
    edit(applyReplacements(draft, [m], replaceWith));
    // Put the caret just after the inserted text so a follow-up reveal lands here.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.selectionStart = el.selectionEnd = m.start + replaceWith.length;
    });
  }, [matches, current, draft, replaceWith, edit]);

  const replaceAll = useCallback(() => {
    if (matches.length === 0) return;
    edit(applyReplacements(draft, matches, replaceWith));
  }, [matches, draft, replaceWith, edit]);

  // Reset to the first match whenever the query/case changes or the bar opens, so
  // typing jumps to the first hit. Reveal is deferred a frame so the recomputed
  // `matches` and the just-mounted overlay are in place.
  useEffect(() => {
    if (!findOpen) return;
    setCurrent(0);
    const id = requestAnimationFrame(() => revealMatch(0));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, findOpen]);

  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

  // In the replace field, Enter replaces the current match (Ctrl/Cmd+Enter does
  // Replace All), and Escape closes the bar.
  const onReplaceKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) replaceAll();
      else replaceCurrent();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

  // Ctrl/Cmd+F opens the find bar; Ctrl/Cmd+R opens it with the replace row
  // (both as bound: `editorFind` / `editorReplace`). Bound on the container so
  // it fires whenever focus is anywhere in the editor pane (the cursor is in
  // the tab), not only when the textarea holds focus — it catches the key as
  // it bubbles up. Ctrl/Cmd+R is also always intercepted so it never falls
  // through to the webview's page reload, which would tear down the app.
  const onContainerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const overrides = shortcutOverrides;
    const reload = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r";
    if (actionMatches("editorFind", overrides, e)) {
      e.preventDefault();
      openFind();
    } else if (actionMatches("editorReplace", overrides, e)) {
      e.preventDefault();
      if (replaceOpen) replaceInputRef.current?.focus();
      else openFind(true);
    } else if (reload) {
      // The webview's reload, still kept off Ctrl+R when replace moved away.
      e.preventDefault();
    }
  };

  // Re-sync the overlay layers whenever the editor is resized (window resize,
  // pane/divider drag, panel toggle). A resize can clamp the textarea's
  // scrollLeft/scrollTop without emitting a scroll event, which otherwise leaves
  // the coloured glyphs — and so the visible caret — shifted from the text. A
  // ResizeObserver on the textarea catches every cause (it is full-width, so a
  // window resize changes its box too). Guarded for jsdom, where it's absent.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      // WebKitGTK quirk: a soft-wrap textarea re-breaks its lines when its box
      // shrinks but NOT when it grows, so after the editor widens the text stays
      // wrapped at the old, narrower width and leaves blank space on the right.
      // Nudge it to re-lay-out at the new width by toggling its wrap off→on within
      // a single synchronous reflow (no paint between, so no flicker; the value —
      // and thus caret/selection — is untouched).
      if (wrap) {
        ta.style.whiteSpace = "pre";
        void ta.offsetWidth;
        ta.style.whiteSpace = "";
      }
      syncScroll();
      bumpMeasure();
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [syncScroll, loaded, wrap]);

  // Measure each logical line's wrapped height (wrap mode only) so the gutter
  // cells line up with the editor. Runs before paint to avoid a flash of
  // misaligned numbers. The mirror is sized to the textarea's exact wrap width
  // (its fractional box less the vertical scrollbar) so it wraps line-for-line.
  useLayoutEffect(() => {
    if (!wrap || !loaded) {
      setWrapWidth(null);
      prevWrapWidth.current = null;
      return;
    }
    const measure = measureRef.current;
    const ta = textareaRef.current;
    if (!measure || !ta) return;
    const cw = textareaWrapWidth(ta);
    // If the content width changed since the last measure — most often a vertical
    // scrollbar toggling as the doc crosses the editor height, which the
    // ResizeObserver can't see — force the textarea to re-break to the new width
    // with the same whiteSpace nudge used on resize (synchronous, pre-paint, so
    // no flicker and the value/caret are untouched). Keeps its wrapping in lockstep
    // with the overlay layers pinned to `cw`, so the last-change tint stays put.
    if (prevWrapWidth.current !== cw) {
      prevWrapWidth.current = cw;
      ta.style.whiteSpace = "pre";
      void ta.offsetWidth;
      ta.style.whiteSpace = "";
    }
    setWrapWidth(cw);
    measure.style.width = `${cw}px`;
    const next = Array.from(
      measure.children,
      (c) => (c as HTMLElement).offsetHeight,
    );
    setLineHeights((prev) =>
      prev.length === next.length && prev.every((h, i) => h === next[i])
        ? prev
        : next,
    );
  }, [wrap, loaded, draftLines, fontSize, lineHeight, measureNonce]);

  // Report the caret position so the LaTeX viewer can run SyncTeX forward search
  // from it. Cheap; only wired when `onCaretChange` is supplied.
  //
  // Guard on focus: WebKitGTK collapses a textarea's selection to offset 0 as it
  // loses focus and fires a spurious `select` event for that reset. Clicking the
  // Compile button blurs the editor, so without this guard that 0 would clobber
  // the caret the viewer uses for forward search — the cursor would appear to
  // jump to the top of the file and SyncTeX would look up line 1 (the preamble,
  // which has no output mapping) instead of the real caret. Only report while
  // the textarea is actually focused so a blur-time reset is ignored.
  const emitCaret = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      if (document.activeElement === el) {
        onCaretChange?.(el.selectionStart);
        onSelectionChange?.(el.selectionStart, el.selectionEnd);
      }
      // Track the caret's line for the blame inline hint (cheap; only read).
      setCaretLine(offsetToLineCol(el.value, el.selectionStart).line);
    }
    bumpCaret();
  }, [onCaretChange, onSelectionChange, bumpCaret]);

  // Re-apply the scroll transform to the blame layers whenever they (re)mount or
  // the caret line changes: a freshly-mounted node starts at translateY(0), so
  // without this the column/inline hint would sit un-scrolled until the next
  // scroll event. syncScroll reads the live textarea scrollTop.
  useEffect(() => {
    if (showBlame) syncScroll();
  }, [showBlame, caretLine, blame, syncScroll]);

  // Publish a live caret getter so the viewer can read the *current* cursor at
  // compile time rather than relying on the last-reported snapshot. The Compile
  // button keeps focus (its onMouseDown preventDefault), so at the moment compile
  // runs `selectionStart` is the real cursor — robust even when no caret event
  // ever fired (the snapshot would still be its initial 0). Cleared on unmount so
  // a stale closure can't outlive the editor.
  useEffect(() => {
    if (!caretApiRef) return;
    caretApiRef.current = () => textareaRef.current?.selectionStart ?? null;
    return () => {
      caretApiRef.current = null;
    };
  }, [caretApiRef]);

  // Imperative editing API for a toolbar (the Markdown viewer). `applyEdit` runs
  // a pure transform on the current value+selection and commits it through
  // `edit`; the requested selection (and the view it was made in) is stashed in
  // the pending refs above and restored by the layout effect below once React has
  // re-rendered the textarea with the new value.
  useEffect(() => {
    if (!editorApiRef) return;
    editorApiRef.current = {
      applyEdit: (fn) => {
        const el = textareaRef.current;
        const start = el?.selectionStart ?? draftRef.current.length;
        const end = el?.selectionEnd ?? start;
        const res = fn(draftRef.current, start, end);
        pendingSelRef.current = { start: res.selStart, end: res.selEnd };
        if (el) pendingScrollRef.current = { top: el.scrollTop, left: el.scrollLeft };
        el?.focus();
        edit(res.value);
      },
    };
    return () => {
      editorApiRef.current = null;
    };
  }, [editorApiRef, edit]);
  // Put the caret and the view back where the edit was made. Scroll first, then
  // selection: assigning `.value` has already thrown the textarea to the end of
  // the document, and the overlay layers (highlight/link/change) are re-aligned
  // by hand rather than left to the scroll event, which arrives a frame later —
  // i.e. after the paint this effect exists to get right.
  useLayoutEffect(() => {
    const sel = pendingSelRef.current;
    const view = pendingScrollRef.current;
    pendingSelRef.current = null;
    pendingScrollRef.current = null;
    if (!sel) return;
    const el = textareaRef.current;
    if (!el) return;
    if (view) {
      el.scrollTop = view.top;
      el.scrollLeft = view.left;
    }
    el.selectionStart = sel.start;
    el.selectionEnd = sel.end;
    if (view) syncScroll();
  }, [draft, syncScroll]);

  // SyncTeX reverse search: on a new `gotoLine` nonce, place the caret at the
  // target line/column and scroll it to roughly the middle of the view. SyncTeX
  // reports a column (0 when it has none); we offset into the line by it, clamped
  // to the line's end so a stale column can't spill onto the next line.
  useEffect(() => {
    if (!gotoLine || !loaded) return;
    const el = textareaRef.current;
    if (!el) return;
    const text = draftRef.current;
    const lineStart = lineStartOffset(text, gotoLine.line);
    let offset = lineStart;
    if (gotoLine.column && gotoLine.column > 1) {
      const nl = text.indexOf("\n", lineStart);
      const lineEnd = nl === -1 ? text.length : nl;
      offset = Math.min(lineStart + (gotoLine.column - 1), lineEnd);
    }
    el.focus();
    el.selectionStart = el.selectionEnd = offset;
    // Light the target line in the gutter straight away: assigning selectionStart
    // fires no `select` event, so `emitCaret` never runs and the caret-line
    // highlight would otherwise stay on wherever the cursor last was.
    setCaretLine(gotoLine.line);
    // Centre the target line's visual top. `lineTop` accounts for the gutter's
    // 10px padding and, under soft-wrap (the LaTeX editor), the measured per-line
    // wrapped heights — so a target below several wrapped lines lands centred
    // instead of drifting up a row per wrap, which the old (line-1)·lineHeight
    // math got wrong for exactly the wide-prose files reverse search runs on.
    const target = lineTop(gotoLine.line) - el.clientHeight / 2 + effectiveLineHeight / 2;
    el.scrollTop = Math.max(0, target);
    syncScroll();
    onGotoApplied?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoLine?.nonce, loaded]);

  const dismissSuggestion = useCallback(() => {
    acCandidates.current = [];
    const el = textareaRef.current;
    if (el) acDismissed.current = { draft: draftRef.current, caret: el.selectionStart };
    recordAcOutcome(false);
    acAbort.current?.abort();
    acAbort.current = null;
    setSuggestion(null);
    setAcStatus(null);
  }, [recordAcOutcome]);

  // Cancel on hiding, disabling, switching document/context/default mode, and unmount.
  useEffect(() => {
    dismissSuggestion();
    return dismissSuggestion;
  }, [acVisible, autocomplete?.enabled, path, scope, autocomplete?.preferred, autocomplete?.preferredProse, autocomplete?.mode, acEndpoint, contextFiles, acCopilot, dismissSuggestion]);

  // External changes (reload / undo) bypass edit(). Invalidate their generation.
  useEffect(() => {
    acAbort.current?.abort();
    acAbort.current = null;
    setAcStatus(null);
    acCandidates.current = [];
    if (draft !== lastEditRef.current) {
      recordAcOutcome(false);
      setSuggestion(null);
    }
  }, [draft, recordAcOutcome]);

  const requestCompletion = useCallback(async (opts?: { auto?: boolean; mode?: AutocompleteMode; candidate?: number }) => {
    const auto = opts?.auto === true;
    const mode = opts?.mode ?? acMode;
    const el = textareaRef.current;
    if (!el || !autocomplete?.enabled || !acVisible || el.selectionStart !== el.selectionEnd) return;
    if (auto && document.activeElement !== el) return;
    const caret = el.selectionStart;
    const snapshot = draftRef.current;
    if (auto && acDismissed.current?.draft === snapshot && acDismissed.current.caret === caret) return;
    const version = acDocumentVersion.current;
    acDismissed.current = null;
    const { prefix } = completionWindow(snapshot, caret);
    if (auto && prefix.replace(/\s+/g, "").length < 3) return;
    recordAcOutcome(false);
    acCandidates.current = [];
    acCandidate.current = opts?.candidate ?? 0;
    const candidate = acCandidate.current;
    acAbort.current?.abort();
    const ctl = new AbortController();
    acAbort.current = ctl;
    setSuggestion(null);
    setAcStatus(acCopilot ? t("fileViewer.copilotStatus") : t("fileViewer.autocompleteStatus", { mode: acModeLabel(mode, t) }));
    const publish = (candidates: CompletionCandidate[]) => {
      if (ctl.signal.aborted || acDocumentVersion.current !== version || draftRef.current !== snapshot ||
          el.selectionStart !== caret || el.selectionEnd !== caret) return;
      // Copilot returns its alternatives at once; Alt+[/] walks that list.
      if (acCopilot) acCandidates.current = candidates;
      const item = candidates[0];
      acOutcome.current = item ? { model: `${item.provider}/${item.model ?? item.provider}`, mode: acCopilot ? "copilot" : item.mode ?? mode } : null;
      setSuggestion(item ? { text: item.text, at: item.at, candidate: item } : null);
      if (item) setAcStatus(null);
    };
    try {
      const tabs = useTabsStore.getState();
      const context = (signal: AbortSignal) => completionContext({
        path, root: acProjectDir, draft: snapshot,
        openPaths: (tabs.tabsByScope[scope ?? ROOT_SCOPE] ?? tabs.tabs)
          .filter((tab) => (!tab.scope || tab.scope === (scope ?? ROOT_SCOPE)) &&
            ["text", "markdown", "tex", "texworkspace"].includes(tab.viewer ?? ""))
          .flatMap((tab) => tab.embedPath ? [tab.embedPath] : []),
        manual: contextFiles.map((f) => ({ name: f.rel, content: f.content })),
        keys: lang === "tex" ? [
          ...[...snapshot.matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1]),
          ...(texCompletions?.labels.map((l) => l.key) ?? []),
          ...(texCompletions?.cites.map((c) => c.key) ?? []),
        ].join("\n") : undefined,
        read: (file) => readFileText(file, scope), signal,
      });
      const provider: CompletionProvider = acCopilot && scope ? new CopilotCompletionProvider({
        projectId: scope, editor: acEditorId, automatic: auto,
        tabSize: indentUnit.width || 4, insertSpaces: !indentUnit.text.startsWith("\t"),
      }) : new OllamaCompletionProvider({
        endpoint: acEndpoint, scope: scope ?? undefined, preferred: autocomplete.preferred,
        preferredProse: autocomplete.preferredProse, mode, candidate, context,
      }, acCache.current);
      const result = await provider.complete({
        path, text: snapshot, caret, language: lang, version,
      }, ctl.signal, publish);
      if (ctl.signal.aborted) return;
      setAcStatus(result.length || auto ? null : t("fileViewer.noSuggestion"));
    } catch (e) {
      if (ctl.signal.aborted) return;
      acOutcome.current = null;
      setSuggestion(null);
      const reason = String(e);
      if (reason.includes("copilot_cancelled") || reason.includes("copilot_stale_document")) { setAcStatus(null); return; }
      // Sign-in and setup problems would otherwise be invisible with automatic
      // suggestions on, so those two are shown even for an automatic request.
      const setup = reason.includes("copilot_not_signed_in") ? "fileViewer.copilotNotSignedIn"
        : reason.includes("copilot_not_installed") ? "fileViewer.copilotNotInstalled" : null;
      setAcStatus(setup ? t(setup) : auto ? null : t(reason.includes("not_running")
        ? "fileViewer.autocompleteUnavailable"
        : acCopilot ? "fileViewer.copilotFailed" : "fileViewer.autocompleteFailed"));
    } finally {
      ctl.abort();
      if (acAbort.current === ctl) acAbort.current = null;
    }
  }, [autocomplete, lang, acMode, contextFiles, acVisible, acEndpoint, path, scope, acProjectDir, texCompletions, recordAcOutcome, t, acCopilot, acEditorId, indentUnit]);

  // #45 automatic suggestions: when the per-type toggle is on, request a
  // completion a short while after the user stops typing. Re-runs on each draft
  // change; the cleanup clears the prior timer, so only an idle pause fires it.
  // Skipped while a suggestion is already showing or the \ref/\cite dropdown is
  // open. The focus/caret/context guards live in `requestCompletion`.
  useEffect(() => {
    if (!autocomplete?.enabled || !loaded || !acVisible) return;
    if (suggestion || compl) return;
    const id = window.setTimeout(() => void requestCompletion({ auto: true }), AUTO_AC_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [autocomplete?.enabled, loaded, draft, suggestion, compl, requestCompletion, acVisible]);

  // The ghost mounts fresh (scrollTop 0) each time a suggestion appears; align it
  // to the editor's current scroll so the inserted preview lands at the caret.
  useEffect(() => {
    if (suggestion) syncScroll();
  }, [suggestion, syncScroll]);

  useEffect(() => acFeedback?.show(suggestion?.candidate), [suggestion, acFeedback]);

  const acceptSuggestion = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !suggestion) return;
    const at = suggestion.at;
    const next = draft.slice(0, at) + suggestion.text + draft.slice(at);
    edit(next);
    const caret = at + suggestion.text.length;
    setSuggestion(null);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
    });
  }, [suggestion, draft, edit]);

  // #45 partial accept (→ Right arrow): insert only the next "word" of the pending
  // suggestion and keep the remainder ghosted, so the user can walk a long
  // suggestion in word-sized steps. A word = any leading whitespace (including a
  // newline + indentation) plus the following run of non-space characters.
  const acceptWord = useCallback((line = false) => {
    const el = textareaRef.current;
    if (!el || !suggestion) return;
    const { text, at } = suggestion;
    const m = text.match(/^\s*\S+/);
    const take = line ? completionLineLength(text) : m ? m[0].length : text.length;
    const chunk = text.slice(0, take);
    const rest = text.slice(take);
    const next = draft.slice(0, at) + chunk + draft.slice(at);
    edit(next);
    const caret = at + chunk.length;
    // Keep the rest ghosted at the new caret; clear once it's fully consumed.
    setSuggestion(rest ? { ...suggestion, text: rest, at: caret } : null);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
    });
  }, [suggestion, draft, edit]);

  // \ref/\cite completion: cap the dropdown so a huge .bib can't render
  // thousands of rows; the prefix filter usually narrows it well below this.
  const COMPL_LIMIT = 80;

  // Recompute the completion dropdown for the current caret. No-ops (closes the
  // dropdown) unless `texCompletions` is wired and the collapsed caret sits in a
  // recognised \ref/\cite argument. Items are prefix-then-substring ranked; the
  // highlighted index is preserved while the same token is being extended.
  const refreshCompl = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !texCompletions) { setCompl(null); return; }
    const caret = el.selectionStart;
    if (caret !== el.selectionEnd) { setCompl(null); return; }
    if (caret === complClosedAt.current) return; // suppressed at this exact caret
    complClosedAt.current = -1;
    const ctx = findTexComplAt(draft, caret);
    if (!ctx) { complSession.current = null; setCompl(null); return; }
    // One token, one session: the candidate list (which parses the draft) and
    // the mirror layout (which lays out everything before the caret) are both
    // functions of the document OUTSIDE the token being typed, so they are
    // computed when the dropdown opens and reused for every keystroke that only
    // extends or shortens that token. "Outside the token is unchanged" is
    // checked literally — same family, same start, and the text before and after
    // the token byte-identical — so an edit anywhere else starts a fresh
    // session rather than trusting a stale one.
    const prev = complSession.current;
    const session =
      prev &&
      prev.kind === ctx.kind &&
      prev.start === ctx.start &&
      draft.length - ctx.end === prev.suffix.length &&
      draft.startsWith(prev.prefix) &&
      draft.endsWith(prev.suffix)
        ? prev
        : {
            kind: ctx.kind,
            start: ctx.start,
            prefix: draft.slice(0, ctx.start),
            suffix: draft.slice(ctx.end),
            candidates: texCompletionsFor(texCompletions, draft, ctx.kind),
            mirror: textareaCaretMirrorOffsets(el, ctx.start),
          };
    complSession.current = session;
    const q = ctx.query.toLowerCase();
    let items: TexComplItem[];
    if (ctx.kind === "cite") {
      items = (session.candidates as BibEntry[])
        .filter(
          (e) =>
            !q ||
            e.key.toLowerCase().includes(q) ||
            e.title?.toLowerCase().includes(q) ||
            e.author?.toLowerCase().includes(q),
        )
        .map((e) => ({ value: e.key, detail: citeDetail(e) }));
    } else if (ctx.kind === "cmd") {
      // #245: a command is matched by PREFIX only. A substring match over a table
      // of two hundred names offers `\varepsilon` for `\ps`, which is noise on
      // every keystroke — a key list is browsed, a command name is typed.
      items = (session.candidates as TexCommandEntry[])
        .filter((c) => !q || c.name.toLowerCase().startsWith(q))
        .map((c) => ({
          value: c.name,
          // The signature, not a description: it is the one thing about a command
          // that is not in its name, and it needs no translation.
          detail: c.args > 0 ? "{…}".repeat(c.args) : undefined,
          local: c.local,
          entry: c,
        }));
    } else if (ctx.kind === "env") {
      items = (session.candidates as TexEnvEntry[])
        .filter((e) => !q || e.name.toLowerCase().includes(q))
        .map((e) => ({ value: e.name, detail: e.seed, local: e.local, entry: e }));
    } else {
      items = (session.candidates as TexLabelEntry[])
        .filter(
          (l) => !q || l.key.toLowerCase().includes(q) || l.section?.toLowerCase().includes(q),
        )
        .map((l) => ({ value: l.key, detail: l.section }));
    }
    if (q) {
      items.sort(
        (a, b) =>
          (a.value.toLowerCase().startsWith(q) ? 0 : 1) -
          (b.value.toLowerCase().startsWith(q) ? 0 : 1),
      );
    }
    items = items.slice(0, COMPL_LIMIT);
    if (items.length === 0) { setCompl(null); return; }
    // Re-anchoring is the cheap half: the textarea's screen rect and scroll.
    const pos = textareaMirrorToViewport(el, session.mirror);
    setCompl((prev) => {
      const same =
        prev != null &&
        prev.ctx.kind === ctx.kind &&
        prev.ctx.start === ctx.start &&
        prev.ctx.query === ctx.query;
      return { ctx, items, index: same ? Math.min(prev!.index, items.length - 1) : 0, pos };
    });
  }, [draft, texCompletions]);

  // Accept a completion (Tab): replace the token with the key. When it's the
  // last/only key in the braces, close them if needed, jump the caret OUT past
  // `}`, and add a trailing space (tracked in `autoSpace` for smart removal). For
  // a multi-key list (\cite{a,b}) it stays just after the inserted key instead.
  // `complClosedAt` keeps the dropdown from instantly reopening on that caret.
  const acceptCompl = useCallback(
    (item: TexComplItem) => {
      const el = textareaRef.current;
      if (!el || !compl) return;
      const value = item.value;
      // #245: a command and an environment are not keys, so neither is accepted
      // the way one is — the decision (seed the arguments, open the block) is a
      // pure function in `tex.ts`, and this only splices its answer in.
      if (compl.ctx.kind === "cmd" || compl.ctx.kind === "env") {
        const applied =
          compl.ctx.kind === "cmd"
            ? insertTexCommand(draft, compl.ctx, (item.entry as TexCommandEntry) ?? { name: value, args: 0 })
            : insertTexEnvironment(draft, compl.ctx, (item.entry as TexEnvEntry) ?? { name: value });
        autoSpace.current = null;
        complClosedAt.current = applied.caret;
        setCompl(null);
        edit(applied.text);
        requestAnimationFrame(() => {
          el.focus();
          el.selectionStart = el.selectionEnd = applied.caret;
        });
        return;
      }
      const { start, end } = compl.ctx;
      const head = draft.slice(0, start) + value;
      const rest = draft.slice(end);
      const closeRel = rest.indexOf("}");
      const beforeClose = closeRel >= 0 ? rest.slice(0, closeRel) : rest;
      let next: string;
      let caret: number;
      if (/\S/.test(beforeClose)) {
        // More keys remain inside the braces → keep the caret after this key.
        next = head + rest;
        caret = head.length;
        autoSpace.current = null;
      } else {
        // Last/only key: drop any spaces up to the brace, ensure a closing `}`,
        // then a single space, reusing one already after `}` if present.
        const afterBrace = closeRel >= 0 ? rest.slice(closeRel + 1) : rest;
        const sep = /^\s/.test(afterBrace) ? "}" : "} ";
        next = head + sep + afterBrace;
        autoSpace.current = head.length + 1; // index of the space right after `}`
        caret = head.length + 2; // past `}` and the space
      }
      complClosedAt.current = caret;
      setCompl(null);
      edit(next);
      requestAnimationFrame(() => {
        el.focus();
        el.selectionStart = el.selectionEnd = caret;
      });
    },
    [compl, draft, edit],
  );

  const closeCompl = useCallback(() => {
    const el = textareaRef.current;
    complClosedAt.current = el ? el.selectionStart : -1;
    setCompl(null);
  }, []);

  // Re-detect the completion context on every text change and caret move.
  useEffect(() => {
    refreshCompl();
  }, [draft, caretTick, refreshCompl]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let the IME own composition keys; input events validate any type-through.
    if (e.nativeEvent.isComposing || e.key === "Process") return;
    if (onFollowLink && (e.ctrlKey || e.metaKey) && lastMouse.current) {
      updateLinkHover(lastMouse.current.x, lastMouse.current.y, true);
    }

    // The occurrence marks answer one gesture and outlive it by nothing: the
    // next real keystroke drops them. Bare modifiers don't count — holding Ctrl
    // to copy the selection the double-click just made must not wipe them.
    if (cmdMark && !MODIFIER_KEYS.has(e.key)) setCmdMark(null);

    // Smart space after accepting a \ref/\cite: the first real keystroke decides
    // the auto space's fate. Closing punctuation right after it replaces it
    // (\cite{x}. not \cite{x} .); any other character commits it. Bare modifier
    // presses (e.g. Shift for `?`) are ignored so they don't drop the space.
    if (autoSpace.current != null && !MODIFIER_KEYS.has(e.key)) {
      const el = textareaRef.current;
      const at = autoSpace.current;
      if (
        e.key.length === 1 &&
        NO_SPACE_BEFORE.has(e.key) &&
        el &&
        el.selectionStart === el.selectionEnd &&
        el.selectionStart === at + 1
      ) {
        e.preventDefault();
        autoSpace.current = null;
        const next = draft.slice(0, at) + e.key + draft.slice(at + 1);
        edit(next);
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = at + 1;
        });
        return;
      }
      autoSpace.current = null; // any other real key commits the space
    }

    // TeX dropdown: arrows move the highlight, Enter/Tab accept, Esc closes.
    // Handled first so its accept keys do not become a newline or indentation.
    if (compl && compl.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCompl((c) => (c ? { ...c, index: (c.index + 1) % c.items.length } : c));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCompl((c) =>
          c ? { ...c, index: (c.index - 1 + c.items.length) % c.items.length } : c,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptCompl(compl.items[compl.index]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeCompl();
        return;
      }
    }

    // #45: Ctrl+Space requests a suggestion. While a ghost suggestion is showing:
    //  - Tab accepts the whole suggestion,
    //  - Shift+Tab toggles the completion-length mode (Sentence → Block → Scope)
    //    and re-requests in it,
    //  - → (Right) accepts only the next word (repeat to walk word-by-word),
    //  - Esc dismisses.
    const overrides = shortcutOverrides;
    if (actionMatches("editorAutocomplete", overrides, e)) {
      e.preventDefault();
      void requestCompletion();
      return;
    }
    if (suggestion) {
      // Alt+[ / Alt+]. The US key positions count too: on German QWERTZ the
      // brackets sit behind AltGr, so Alt+Ü / Alt++ is the reachable chord.
      const bracket = e.key === "[" || e.code === "BracketLeft" ? "[" : e.key === "]" || e.code === "BracketRight" ? "]" : null;
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && bracket) {
        e.preventDefault();
        if (acCopilot) {
          const items = acCandidates.current;
          if (items.length > 1 && items[0].version === acDocumentVersion.current) {
            recordAcOutcome(false);
            acCandidate.current = (acCandidate.current + (bracket === "]" ? 1 : items.length - 1)) % items.length;
            const item = items[acCandidate.current];
            acOutcome.current = { model: `${item.provider}/${item.model ?? item.provider}`, mode: "copilot" };
            setSuggestion({ text: item.text, at: item.at, candidate: item });
          }
        } else void requestCompletion({ candidate: (acCandidate.current + (bracket === "]" ? 1 : 2)) % 3 });
        return;
      }
      if (e.key === "ArrowRight" && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        acceptWord(true);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey && acCopilot) {
          // The language server has no length modes; nothing to switch.
        } else if (e.shiftKey) {
          // Toggle to the next mode and re-request, so the ghost switches to that
          // mode's completion in place.
          const m = nextAcMode(acMode);
          setAcMode(m);
          void requestCompletion({ mode: m });
        } else {
          acceptSuggestion();
        }
        return;
      }
      // Plain Right arrow accepts the next word; modified Right (select/word-move)
      // falls through and dismisses so native navigation still works.
      if (e.key === "ArrowRight" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        acceptWord();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissSuggestion();
        return;
      }
      // Let input events consume matching text (including paste and IME).
      if (Array.from(e.key).length !== 1 && e.key !== "Enter" && !MODIFIER_KEYS.has(e.key)) dismissSuggestion();
    }

    if (!MODIFIER_KEYS.has(e.key) && (e.key.startsWith("Arrow") ||
        ["Home", "End", "PageUp", "PageDown", "Escape"].includes(e.key))) dismissSuggestion();

    // #46 undo/redo (Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z unless rebound).
    if (actionMatches("editorRedo", overrides, e)) {
      e.preventDefault();
      redo?.();
      return;
    }
    if (actionMatches("editorUndo", overrides, e)) {
      e.preventDefault();
      undo?.();
      return;
    }

    if (actionMatches("editorSave", overrides, e)) {
      e.preventDefault();
      save();
      return;
    }
    // Text-size: Ctrl/Cmd +/-/0 on any layout. stopPropagation keeps the
    // window-level UI zoom (useKeyboard / DetachedApp) from also zooming the
    // whole window — the editor zooms its text, as an agent pane zooms its font.
    const zoom = zoomFor(e, overrides);
    if (zoom) {
      e.preventDefault();
      e.stopPropagation();
      (zoom === "in" ? incFont : zoom === "out" ? decFont : resetFont)?.();
      return;
    }
    // Ctrl/Cmd+Shift+C (as bound) — comment out the touched lines, or
    // uncomment them when they already are. `%` in TeX, the language's own
    // marker elsewhere; falls through untouched in a language with no line
    // comment.
    if (actionMatches("editorComment", overrides, e)) {
      const marker = lineCommentMarker(lang);
      if (!marker) return;
      const toggled = applyLineComment(e.currentTarget, marker);
      if (!toggled) return;
      e.preventDefault();
      edit(toggled.value);
      const ta = e.currentTarget;
      requestAnimationFrame(() => {
        ta.selectionStart = toggled.selStart;
        ta.selectionEnd = toggled.selEnd;
      });
      return;
    }
    // Enter, aligned with the block it continues (Python and TeX — see
    // `applyAutoIndent`). Modified Enter is left alone: Ctrl/Cmd+Enter and
    // Alt+Enter are other surfaces' gestures, and Shift+Enter is the plain
    // newline every editor keeps as the way out of a rule that guessed wrong.
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const next = applyAutoIndent(e.currentTarget, lang, indentUnit);
      if (!next) return;
      e.preventDefault();
      edit(next.value);
      const el = e.currentTarget;
      requestAnimationFrame(() => {
        el.selectionStart = next.selStart;
        el.selectionEnd = next.selEnd;
      });
      return;
    }
    if (e.key === "Tab") {
      // After a TeX completion has seeded an argument (`\\begin{}` is the
      // common case), Tab leaves that argument rather than inserting spaces.
      // A visible completion menu above already captured Tab, so it can still
      // accept its highlighted item.
      if (!e.shiftKey && lang === "tex") {
        const caret = advanceTexBraceTabStop(e.currentTarget);
        if (caret != null) {
          e.preventDefault();
          const el = e.currentTarget;
          requestAnimationFrame(() => {
            el.selectionStart = el.selectionEnd = caret;
          });
          return;
        }
      }
      const next = applyIndent(e.currentTarget, e.shiftKey);
      if (!next) return;
      e.preventDefault();
      edit(next.value);
      const el = e.currentTarget;
      requestAnimationFrame(() => {
        el.selectionStart = next.selStart;
        el.selectionEnd = next.selEnd;
      });
    }
  };

  // After a click the textarea's caret (selectionStart) is at the click point,
  // so a Ctrl/Cmd+Click resolves the reference there. The modifier gates it so
  // ordinary clicks keep placing the caret as usual.
  // Clicking between the braces of `\begin{…}`/`\end{…}` selects the whole
  // environment name, so swapping an environment is click-and-type — and with the
  // coupled rename above, retyping it here rewrites the partner as you go. Only a
  // plain collapsed click qualifies: a drag-select, double- or shift-click has
  // already stated what it wanted selected, and a modifier click is the
  // link-follow gesture.
  const selectEnvName = (el: HTMLTextAreaElement) => {
    if (lang !== "tex" || el.selectionStart !== el.selectionEnd) return;
    const range = texEnvNameRangeAt(el.value, el.selectionStart);
    if (!range || range.end === range.start) return; // `\begin{}` — nothing to select
    el.setSelectionRange(range.start, range.end);
    emitCaret();
  };

  // #tex-command-occurrences: a double-click on a control sequence extends the
  // selection over the whole `\command` — the browser's word rules stop at the
  // backslash and hand back the letters alone — and marks every other use of it
  // in the file. A double-click on anything else (prose, a brace, `\\`) just
  // clears whatever was marked and keeps the native word selection.
  const onDoubleClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    if (lang !== "tex") return;
    const el = e.currentTarget;
    const cmd = texCommandAt(el.value, el.selectionStart);
    if (!cmd) {
      setCmdMark(null);
      return;
    }
    el.setSelectionRange(cmd.start, cmd.end);
    emitCaret();
    setCmdMark({ name: cmd.name, at: cmd.start });
  };

  const onClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    dismissSuggestion();
    emitCaret();
    if (e.ctrlKey || e.metaKey) {
      // Prefer the link span under the pointer: a Ctrl/⌘+click leaves the caret
      // where it was, so `selectionStart` points at the old position, not the
      // link that was clicked. Fall back to the caret for a forward-sync click
      // that landed on no link.
      if (onFollowLink) {
        const off = linkOffsetAt(e.clientX, e.clientY);
        onFollowLink(off ?? e.currentTarget.selectionStart);
      }
      return;
    }
    selectEnvName(e.currentTarget);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    lastMouse.current = { x: e.clientX, y: e.clientY };
    updateLinkHover(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
    setUnclosedTip(unclosedBrackets.length ? unclosedTipAt(e.clientX, e.clientY) : null);
    updateSnippetHover(e.clientX, e.clientY);
    // Grammar tooltip: open it over a hovered mark, else schedule a close so the
    // pointer can still reach the open tooltip's Apply button.
    if (grammarRanges.length) {
      const hit = grammarHitAt(e.clientX, e.clientY);
      if (hit) {
        cancelGrammarTipClose();
        setGrammarTip({ left: e.clientX, top: e.clientY, range: hit });
      } else if (grammarTip) {
        scheduleGrammarTipClose();
      }
    }
  };

  if (error != null) return <div className="file-viewer-error">{error}</div>;
  if (!loaded) return <div className="file-viewer-loading">{t("common.loading")}</div>;

  // Ghost text: while a suggestion is pending, render the WHOLE projected
  // document — prefix + suggestion + the existing suffix shifted past it — over
  // an opaque background that masks the real layers beneath. This pushes the
  // text after the caret aside (horizontally and, for multi-line suggestions,
  // downward) instead of painting the proposal on top of it.
  const hasGhost = suggestion != null;

  // In wrap mode, pin every overlay <pre> to the textarea's content width so
  // they wrap line-for-line with it (see wrapWidth). A no-op otherwise.
  const overlayWidthStyle =
    wrap && wrapWidth != null ? { width: wrapWidth } : undefined;

  return (
    <div
      className="file-viewer-code"
      ref={wheelRef}
      onKeyDown={onContainerKeyDown}
      style={
        fontSize
          ? ({
              "--code-font-size": `${fontSize}px`,
              "--code-line-height": `${snapToDevicePx(
                lineHeight ?? Math.round(fontSize * 1.5),
                dpr,
              )}px`,
            } as React.CSSProperties)
          : undefined
      }
    >
      {/* Git-blame column (#blame). Sits left of the numbers, shares their cell
          heights (incl. wrap-mode `lineHeights`) and is scroll-locked via its own
          inner transform. Each cell shows the last author + relative date;
          uncommitted/unknown lines get a muted dot. Age-tinted like a heat-map. */}
      {showBlame && (
        <div
          className="file-viewer-blame-gutter"
          aria-hidden="true"
          onMouseMove={onBlameMove}
          onMouseLeave={() => setBlameTip(null)}
        >
          <div className="file-viewer-blame-inner" ref={blameInnerRef}>
            {Array.from({ length: lineCount }, (_, i) => {
              const b = blame?.get(i + 1);
              const h = wrap ? lineHeights[i] : undefined;
              const known = b != null && !isUncommitted(b);
              const style: React.CSSProperties = {};
              if (h != null) style.height = h;
              const tint = blameTint(b);
              if (tint) style.background = tint;
              return (
                <div
                  key={i}
                  className={`file-viewer-blame-line${known ? "" : " uncommitted"}${
                    i + 1 === caretLine ? " current" : ""
                  }`}
                  data-line={i + 1}
                  style={style}
                >
                  {known ? (
                    <>
                      <span className="fv-blame-author">{authorAbbrev(b!.author)}</span>
                      <span className="fv-blame-date">{blameRelDate(b!.author_time)}</span>
                    </>
                  ) : (
                    <span className="fv-blame-none">·</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* Line-number gutter. Fixed-height rows normally; in wrap mode (the LaTeX
          viewer) a logical line can span several visual rows, so each cell is
          sized to its measured wrapped height (`lineHeights`). Lines holding a
          search match are marked, the current match brightest (#67).

          When `onToggleBreakpoint` is wired (the Python editor, #py) the cells
          become real buttons that set/clear a debug breakpoint, so the gutter
          stops being decoration and the whole column drops its `aria-hidden` —
          hiding a control from the accessibility tree would make the feature
          unreachable without a mouse. */}
      <div className="file-viewer-gutter" aria-hidden={onToggleBreakpoint ? undefined : "true"}>
        <div className="file-viewer-gutter-inner" ref={gutterInnerRef}>
          {Array.from({ length: lineCount }, (_, i) => {
            const n = i + 1;
            const h = wrap ? lineHeights[i] : undefined;
            const broken = breakpoints?.has(n) ?? false;
            const cls =
              (n === currentMatchLine
                ? "file-viewer-gutter-line current-match"
                : matchLineSet.has(n)
                  ? "file-viewer-gutter-line has-match"
                  : "file-viewer-gutter-line") +
              (n === caretLine ? " caret" : "") +
              (unclosedLineSet.has(n) ? " has-unclosed-bracket" : "") +
              (onToggleBreakpoint ? " is-breakable" : "") +
              (broken ? " has-breakpoint" : "");
            const style = h != null ? { height: h } : undefined;

            if (!onToggleBreakpoint) {
              return (
                <div key={i} className={cls} style={style}>
                  {n}
                </div>
              );
            }
            return (
              <button
                key={i}
                type="button"
                className={cls}
                style={style}
                // Keep the caret where it is: clicking the gutter sets a
                // breakpoint, it does not move the cursor or steal focus.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onToggleBreakpoint(n)}
                title={
                  broken
                    ? t("fileViewer.removeBreakpoint", { line: n })
                    : t("fileViewer.addBreakpoint", { line: n })
                }
                aria-pressed={broken}
                aria-label={
                  broken
                    ? t("fileViewer.removeBreakpoint", { line: n })
                    : t("fileViewer.addBreakpoint", { line: n })
                }
              >
                {n}
              </button>
            );
          })}
        </div>
      </div>
      <div
        className={`file-viewer-code-area${highlighted != null ? " highlighted" : ""}${
          linkHover ? " link-hover" : ""
        }${wrap ? " is-wrapped" : ""}${hasGhost ? " has-suggestion" : ""}`}
      >
        {/* Hidden full-width mirror used only to measure each logical line's
            wrapped height for the gutter (wrap mode). Sized to the textarea's
            content width in the layout effect; never painted. */}
        {wrap && (
          <pre className="file-viewer-gutter-measure" ref={measureRef} aria-hidden="true">
            {draftLines.map((ln, i) => (
              <div key={i} className="fv-measure-line">{ln === "" ? "\u200B" : ln}</div>
            ))}
          </pre>
        )}
        {/* Indent guides. First of the layers, so the hairlines sit behind the
            coloured glyphs rather than across them. */}
        {indentHtml != null && (
          <pre
            ref={indentLayerRef}
            className="file-viewer-indent-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: indentHtml + "\n" }}
          />
        )}
        {highlighted != null && (
          <pre
            ref={highlightRef}
            className="file-viewer-highlight"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: highlighted + "\n" }}
          />
        )}
        {bracketHtml != null && (
          <pre
            ref={bracketLayerRef}
            className="file-viewer-bracket-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: bracketHtml + "\n" }}
          />
        )}
        {unclosedHtml != null && (
          <pre
            ref={unclosedLayerRef}
            className="file-viewer-unclosed-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: unclosedHtml + "\n" }}
          />
        )}
        {changeHtml != null && (
          <pre
            ref={changeLayerRef}
            className="file-viewer-change-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: changeHtml + "\n" }}
          />
        )}
        {searchHtml != null && (
          <pre
            ref={searchLayerRef}
            className="file-viewer-search-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: searchHtml + "\n" }}
          />
        )}
        {grammarHtml != null && (
          <pre
            ref={grammarLayerRef}
            className="file-viewer-grammar-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: grammarHtml + "\n" }}
          />
        )}
        {snippetHtml != null && (
          <pre
            ref={snippetLayerRef}
            className="file-viewer-tex-snippet-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: snippetHtml + "\n" }}
          />
        )}
        {occurrenceHtml != null && (
          <pre
            ref={occurrenceLayerRef}
            className="file-viewer-occurrence-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: occurrenceHtml + "\n" }}
          />
        )}
        {linkHtml != null && (
          <pre
            ref={linkLayerRef}
            className="file-viewer-link-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: linkHtml + "\n" }}
          />
        )}
        {hasGhost && (
          <pre
            ref={ghostRef}
            className="file-viewer-ghost"
            aria-hidden="true"
            style={overlayWidthStyle}
          >
            {draft.slice(0, suggestion!.at)}
            <span className="file-viewer-ghost-text">{suggestion!.text}</span>
            {draft.slice(suggestion!.at)}
          </pre>
        )}
        <textarea
          ref={textareaRef}
          className="file-viewer-editor file-viewer-code-editor"
          value={draft}
          spellCheck={false}
          wrap={wrap ? "soft" : "off"}
          onChange={onTextChange}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => { if (!(e.ctrlKey || e.metaKey)) setLinkHover(false); emitCaret(); }}
          // Fires before the double-click that re-arms them, so a plain click
          // is what clears the occurrence marks.
          onMouseDown={() => { if (cmdMark) setCmdMark(null); }}
          onDoubleClick={onDoubleClick}
          onBlur={() => { setLinkHover(false); setLinkTip(null); setUnclosedTip(null); dismissSuggestion(); setCompl(null); closePreview(); }}
          onMouseMove={onMouseMove}
          onMouseLeave={() => { setLinkHover(false); setLinkTip(null); setUnclosedTip(null); scheduleGrammarTipClose(); closePreview(); }}
          onClick={onClick}
          onSelect={emitCaret}
          onScroll={onScroll}
        />
        {/* Current-line blame hint (#blame): a faint, right-aligned annotation on
            the caret's line. Absolutely positioned at the line's top offset and
            scroll-locked with the blame column. */}
        {showBlame && caretBlame && !isUncommitted(caretBlame) && (
          <div
            ref={blameInlineRef}
            className="file-viewer-blame-inline"
            aria-hidden="true"
            style={{ top: lineTop(caretLine), lineHeight: `${effectiveLineHeight}px` }}
          >
            {caretBlame.author} · {blameRelDate(caretBlame.author_time)} · {caretBlame.summary}
          </div>
        )}
      </div>
      {onFollowLink && <LinkOpenHint at={linkTip} />}
      {unclosedTip && (
        <div
          className="file-viewer-unclosed-tip"
          style={{ left: unclosedTip.left, top: unclosedTip.top }}
          role="tooltip"
        >
          {unclosedTip.hint || t("fileViewer.unclosedBracketHint")}
        </div>
      )}
      {suggestion && !acStatus && (
        <div className="file-viewer-ac-status" role="status">
          {acCopilot ? t("fileViewer.copilotControls", AC_KEY_LABELS) : t("fileViewer.autocompleteControls", { ...AC_KEY_LABELS, candidate: acCandidate.current + 1 })}
        </div>
      )}
      {acStatus && (
        <div className="file-viewer-ac-status" role="status">
          {/* A trailing "…" marks an in-flight request — show a spinner. */}
          {acStatus.endsWith("…") && (
            <span className="file-viewer-ac-spinner" aria-hidden="true" />
          )}
          {acStatus}
        </div>
      )}
      {grammarStatus && (
        <div className="file-viewer-grammar-status" role="status">
          {grammarStatus.endsWith("…") && (
            <span className="file-viewer-ac-spinner" aria-hidden="true" />
          )}
          {grammarStatus}
        </div>
      )}
      {/* #tex-hover-preview: the typeset fragment, over the source. Never takes
          the pointer (`pointer-events: none` in CSS) — the card sits ON the
          text the pointer is resting on, so anything it could catch would be a
          gesture aimed at the editor underneath. It opens under the fragment and
          flips above it in the lower part of the window, the rule the remark
          card and the selection bar already flip by. */}
      {preview && (
        <div
          className={`file-viewer-tex-preview${preview.result?.error ? " is-error" : ""}`}
          role="status"
          style={
            preview.anchor.bottom > window.innerHeight * HOVER_PREVIEW_FLIP_AT
              ? {
                  left: Math.max(8, Math.min(preview.anchor.left, window.innerWidth - HOVER_PREVIEW_MAX_W - 8)),
                  bottom: window.innerHeight - preview.anchor.top + 8,
                }
              : {
                  left: Math.max(8, Math.min(preview.anchor.left, window.innerWidth - HOVER_PREVIEW_MAX_W - 8)),
                  top: preview.anchor.bottom + 8,
                }
          }
        >
          {preview.result == null ? (
            <span className="file-viewer-tex-preview-busy">
              <span className="file-viewer-tex-spinner" aria-hidden="true" />
              {t("fileViewer.texPreviewCompiling")}
            </span>
          ) : preview.result.url ? (
            <>
              {/* Half the raster's pixels: it is typeset at 4x its point size so
                  the formula stays crisp, and 2x natural is the size it is
                  actually readable at over 12px source. */}
              <img
                className="file-viewer-tex-preview-img"
                src={preview.result.url}
                alt={t("fileViewer.texPreviewAlt")}
                style={{ width: Math.min((preview.result.width ?? 0) / 2, HOVER_PREVIEW_MAX_W) }}
              />
              {preview.result.fallback && (
                <div className="file-viewer-tex-preview-note">
                  {t("fileViewer.texPreviewFallback")}
                </div>
              )}
            </>
          ) : (
            <div className="file-viewer-tex-preview-error">
              <span className="file-viewer-tex-preview-error-head">
                {t("fileViewer.texPreviewFailed")}
              </span>
              <span className="file-viewer-tex-preview-error-msg">{preview.result.error}</span>
            </div>
          )}
        </div>
      )}
      {grammarTip && (
        <div
          className={`file-viewer-grammar-tip cat-${grammarTip.range.issue.category}`}
          style={{ left: grammarTip.left, top: grammarTip.top }}
          role="tooltip"
          onMouseEnter={cancelGrammarTipClose}
          onMouseLeave={scheduleGrammarTipClose}
        >
          <div className="file-viewer-grammar-tip-cat">{grammarTip.range.issue.category}</div>
          {grammarTip.range.issue.message && (
            <div className="file-viewer-grammar-tip-msg">{grammarTip.range.issue.message}</div>
          )}
          {grammarTip.range.issue.suggestion && (
            <button
              type="button"
              className="file-viewer-grammar-tip-fix"
              // mousedown keeps the textarea from stealing focus before the click.
              onMouseDown={(e) => { e.preventDefault(); applyGrammarFix(grammarTip.range); }}
            >
              {t("fileViewer.grammarFix")} <span className="file-viewer-grammar-tip-sugg">{grammarTip.range.issue.suggestion}</span>
            </button>
          )}
          <button
            type="button"
            className="file-viewer-grammar-tip-fix"
            // mousedown keeps the textarea from stealing focus before the click.
            onMouseDown={(e) => {
              e.preventDefault();
              const word = grammarTip.range.issue.bad;
              void invoke("spell_add_word", { word }).catch(() => undefined);
              // Every mark of the same word clears — the word is now known.
              setSpellIssues((prev) => prev.filter((i) => i.bad !== word));
              setGrammarTip(null);
            }}
          >
            {t("fileViewer.addToDictionary")}
          </button>
        </div>
      )}
      {/* Blame hovercard (#blame): full attribution for the hovered gutter cell. */}
      {blameTip && (() => {
        const b = blame?.get(blameTip.line);
        if (!b || isUncommitted(b)) return null;
        return (
          <div
            className="file-viewer-blame-tip"
            style={{ left: blameTip.left, top: blameTip.top }}
            role="tooltip"
          >
            <div className="file-viewer-blame-tip-head">
              <span className="file-viewer-blame-tip-hash">{b.short}</span>
              <span className="file-viewer-blame-tip-author">{b.author}</span>
            </div>
            <div className="file-viewer-blame-tip-date">{t("fileViewer.blameAgo", { time: blameRelDate(b.author_time) })}</div>
            <div className="file-viewer-blame-tip-summary">{b.summary}</div>
          </div>
        );
      })()}
      {/* #45 context files: a button to attach project files plus chips for the
          attached ones, shown only when autocomplete is enabled for this type. */}
      {autocomplete?.enabled && !acCopilot && (
        <div className="file-viewer-ac-context">
          <button
            type="button"
            className="file-viewer-ac-context-add"
            onClick={() => setAcPicker(true)}
            title={t("fileViewer.addContextTitle")}
          >
            {t("fileViewer.addContext")}{contextFiles.length ? ` (${contextFiles.length})` : ""}
          </button>
          {contextFiles.map((f) => (
            <span key={f.path} className="file-viewer-ac-context-chip" title={f.rel}>
              {basename(f.rel)}
              <button
                type="button"
                aria-label={t("fileViewer.removeFromContext", { file: f.rel })}
                onClick={() => removeContextFile(f.path)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {acPicker && (
        <ContextFilePicker
          projectDir={acProjectDir}
          attached={contextFiles.map((f) => f.rel)}
          onPick={(rel) => void addContextFile(rel)}
          onClose={() => setAcPicker(false)}
        />
      )}
      {compl && (
        <ul
          ref={complListRef}
          className={`file-viewer-tex-compl${compl.ctx.kind === "cite" ? " is-cite" : ""}`}
          role="listbox"
          style={{ left: compl.pos.left, top: compl.pos.top + compl.pos.height }}
        >
          {compl.items.map((it, i) => (
            <li
              key={it.value + i}
              role="option"
              aria-selected={i === compl.index}
              className={`file-viewer-tex-compl-item${i === compl.index ? " active" : ""}`}
              // mousedown (not click) + preventDefault so the textarea keeps focus
              // — otherwise the blur handler would close the dropdown first.
              onMouseDown={(e) => { e.preventDefault(); acceptCompl(it); }}
              onMouseEnter={() => setCompl((c) => (c ? { ...c, index: i } : c))}
            >
              <span className="file-viewer-tex-compl-key">
                {compl.ctx.kind === "cmd" ? `\\${it.value}` : it.value}
              </span>
              {it.local && (
                <span className="file-viewer-tex-compl-local" title={t("fileViewer.complLocalTitle")}>
                  {t("fileViewer.complLocalTag")}
                </span>
              )}
              {it.detail && <span className="file-viewer-tex-compl-detail">{it.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {findOpen && (
        <div className="file-viewer-find" role="search">
          <div className="file-viewer-find-row">
            {/* Chevron expands/collapses the replace row from a find-only bar. */}
            <button
              className={`file-viewer-find-toggle${replaceOpen ? " active" : ""}`}
              onClick={() => setReplaceOpen((v) => !v)}
              aria-pressed={replaceOpen}
              aria-label={replaceOpen ? t("fileViewer.hideReplace") : t("fileViewer.showReplace")}
              title={replaceOpen ? t("fileViewer.hideReplace") : chordHint(t("fileViewer.showReplaceTitle"), "editorReplace")}
            >
              {replaceOpen ? "▾" : "▸"}
            </button>
            <input
              ref={findInputRef}
              className="file-viewer-find-input"
              type="text"
              value={query}
              placeholder={t("pdfViewer.findLabel")}
              aria-label={t("pdfViewer.findLabel")}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFindKeyDown}
            />
            <span className="file-viewer-find-count" aria-live="polite">
              {matches.length > 0 ? `${current + 1}/${matches.length}` : query ? "0/0" : ""}
            </span>
            <button
              className={`file-viewer-find-btn${caseSensitive ? " active" : ""}`}
              onClick={() => setCaseSensitive((v) => !v)}
              aria-pressed={caseSensitive}
              title={t("pdfViewer.matchCaseTitle")}
              aria-label={t("pdfViewer.matchCaseTitle")}
            >
              Aa
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={() => goToMatch(-1)}
              disabled={matches.length === 0}
              title={t("pdfViewer.prevMatchTitle")}
              aria-label={t("pdfViewer.prevMatchLabel")}
            >
              ↑
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={() => goToMatch(1)}
              disabled={matches.length === 0}
              title={t("pdfViewer.nextMatchTitle")}
              aria-label={t("pdfViewer.nextMatchLabel")}
            >
              ↓
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={closeFind}
              title={t("pdfViewer.closeFindTitle")}
              aria-label={t("pdfViewer.closeFindLabel")}
            >
              ✕
            </button>
          </div>
          {replaceOpen && (
            <div className="file-viewer-find-row file-viewer-replace-row">
              <input
                ref={replaceInputRef}
                className="file-viewer-find-input"
                type="text"
                value={replaceWith}
                placeholder={t("fileViewer.replacePlaceholder")}
                aria-label={t("fileViewer.replaceWithLabel")}
                spellCheck={false}
                onChange={(e) => setReplaceWith(e.target.value)}
                onKeyDown={onReplaceKeyDown}
              />
              <button
                className="file-viewer-find-btn file-viewer-replace-btn"
                onClick={replaceCurrent}
                disabled={matches.length === 0}
                title={t("fileViewer.replaceCurrentTitle")}
                aria-label={t("fileViewer.replaceLabel")}
              >
                {t("fileViewer.replaceLabel")}
              </button>
              <button
                className="file-viewer-find-btn file-viewer-replace-btn"
                onClick={replaceAll}
                disabled={matches.length === 0}
                title={chordHint(t("fileViewer.replaceAllTitle"), { key: "Enter", ctrl: true })}
                aria-label={t("fileViewer.replaceAllLabel")}
              >
                {t("fileViewer.replaceAllBtn")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
