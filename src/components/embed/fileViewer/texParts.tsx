import { useCallback, useEffect, useState } from "react";
import { type ViewerState } from "../../../stores/tabs";
import { useTexViewPrefStore, texViewScopeKey } from "../../../stores/viewers/texViewPref";
import { Dropdown } from "../../common/Dropdown";
import { type EditResult } from "../../../lib/viewers/markdownEdit";
import {
  BEAMER_OVERLAY_COMMANDS,
  beamerEditRange,
  buildOverlaySpec,
  insertPause,
  isOverlaySpecBody,
  nextOverlayNumber,
  overlayItems,
  wrapBeamerOverlay,
  type BeamerOverlayCommand,
  type RememberedSelection,
} from "../../../lib/viewers/tex/beamer";
import { UntestedTag } from "../../common/UntestedTag";
import { type TexRefCreation } from "../../../lib/viewers/tex/tex";
import { useT } from "../../../lib/i18n";
import { type EditorApi } from "./editableFile";
import { useViewerPref } from "./editorPrefs";

/** The hover preview's on/off (#tex-hover-preview): the PROJECT's, not the
 *  tab's — one click holds for every TeX pane of the project, across a project
 *  switch and a relaunch (`stores/viewers/texViewPref`). Seeded from the per-type
 *  `viewer_prefs.tex` default while no click has been made.
 *
 *  Unlike autocomplete it defaults **ON** (absent ⇒ on), and the difference
 *  is what the two cost: that calls a language model, this runs the
 *  TeX engine the viewer is already built around — on a fragment, once per
 *  distinct fragment, and only after the pointer has rested. */
export function useTexHoverPreview(scope: string | null): { on: boolean; toggle: () => void } {
  const pref = useViewerPref("tex");
  const def = pref?.hover_preview !== false;
  const key = texViewScopeKey(scope);
  const override = useTexViewPrefStore((s) => s.byProject[key]?.hoverPreview);
  const on = override ?? def;
  const toggle = useCallback(() => {
    useTexViewPrefStore.getState().set(key, { hoverPreview: !on });
  }, [key, on]);
  return { on, toggle };
}

/**
 * Beamer mode for the TeX editor (#tex-beamer): is the overlay bar shown? Per
 * PROJECT, like the hover preview, but its default is the DOCUMENT's — on when
 * any file of it loads `\documentclass{beamer}` (`detected`), off otherwise — so
 * a deck opens with the bar and a paper never sees it, and a click either way
 * is remembered for the project: every file of the deck, this sitting and the
 * next.
 */
export function useTexBeamerMode(
  scope: string | null,
  detected: boolean,
): { on: boolean; toggle: () => void } {
  const key = texViewScopeKey(scope);
  const override = useTexViewPrefStore((s) => s.byProject[key]?.beamer);
  const on = override ?? detected;
  const toggle = useCallback(() => {
    useTexViewPrefStore.getState().set(key, { beamer: !on });
  }, [key, on]);
  return { on, toggle };
}

/**
 * The beamer overlay bar (#tex-beamer): a command, a slide range, and three
 * actions over the editor's selection — Wrap (`\only<2->{…}` around it), Items
 * (`<n>` on each `\item` in the lines, counting up), Pause. The bar is chrome;
 * every edit is `lib/viewers/tex/beamer`'s and goes through the editor's `applyEdit`
 * so undo, the syntax overlay and the caret behave as for any other edit.
 *
 * The **from** field is empty by default and means "the next unused number in
 * this frame" (`nextOverlayNumber`), read from the draft at the moment of the
 * click — the number the author would otherwise have to look up. Typing a
 * number pins it; `to` and `onward` complete the range; and the spec field shows
 * what will be written and can be edited directly for the forms three number
 * fields cannot express (`<+->`, `<1,3>`, `<handout:0>`).
 */
export function BeamerBar({
  api,
  selection,
}: {
  api: React.MutableRefObject<EditorApi | null>;
  selection: React.MutableRefObject<RememberedSelection | null>;
}) {
  const t = useT();
  const [cmd, setCmd] = useState<BeamerOverlayCommand>("only");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [onward, setOnward] = useState(true);
  // A spec typed by hand overrides the three fields until one of them moves.
  const [raw, setRaw] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const num = (s: string): number | null => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // The spec the fields describe; a `from` left empty is filled in at apply time.
  const specFor = (fromN: number | null): string =>
    raw ?? buildOverlaySpec(fromN, num(to), onward);
  const preview = raw ?? buildOverlaySpec(num(from) ?? 0, num(to), onward);
  const previewShown = num(from) == null && raw == null
    ? preview.replace(/^0/, "n")
    : preview;
  const previewValid = raw == null || isOverlaySpecBody(raw);

  const run = (
    fn: (value: string, start: number, end: number, spec: string) => EditResult | null,
  ) => {
    setNote(null);
    api.current?.applyEdit((value, liveStart, liveEnd) => {
      const { start, end } = beamerEditRange(value, liveStart, liveEnd, selection.current);
      const spec = specFor(num(from) ?? nextOverlayNumber(value, start));
      if (!isOverlaySpecBody(spec)) {
        setNote(t("fileViewer.beamerSpecInvalid"));
        return { value, selStart: start, selEnd: end };
      }
      const res = fn(value, start, end, spec);
      if (!res) {
        setNote(t("fileViewer.beamerNoItems"));
        return { value, selStart: start, selEnd: end };
      }
      return res;
    });
  };

  const field = (
    label: string,
    title: string,
    value: string,
    set: (v: string) => void,
    placeholder = "",
  ) => (
    <label className="file-viewer-beamer-field" title={title}>
      {label}
      <input
        type="number"
        min={1}
        max={999}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { set(e.target.value); setRaw(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") run(wrap); }}
      />
    </label>
  );
  const wrap = (v: string, s: number, e: number, spec: string) =>
    wrapBeamerOverlay(v, s, e, cmd, spec);

  return (
    <div className="file-viewer-beamer-bar" role="group" aria-label={t("fileViewer.beamerBarLabel")}>
      <Dropdown
        title={t("fileViewer.beamerCommandTitle")}
        value={cmd}
        onChange={(v) => setCmd(v as BeamerOverlayCommand)}
        options={BEAMER_OVERLAY_COMMANDS.map((c) => ({ value: c, label: `\\${c}` }))}
      />
      {field(t("fileViewer.beamerFrom"), t("fileViewer.beamerFromTitle"), from, setFrom, "n")}
      {field(t("fileViewer.beamerTo"), t("fileViewer.beamerToTitle"), to, setTo)}
      <label className="file-viewer-beamer-field" title={t("fileViewer.beamerOnwardTitle")}>
        <input
          type="checkbox"
          checked={onward}
          onChange={(e) => { setOnward(e.target.checked); setRaw(null); }}
        />
        {t("fileViewer.beamerOnward")}
      </label>
      <label className="file-viewer-beamer-field" title={t("fileViewer.beamerSpecTitle")}>
        <span className="file-viewer-beamer-spec" aria-hidden="true">{"<"}</span>
        <input
          type="text"
          className={previewValid ? undefined : "is-invalid"}
          aria-label={t("fileViewer.beamerSpecTitle")}
          value={raw ?? previewShown}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run(wrap); }}
          spellCheck={false}
        />
        <span className="file-viewer-beamer-spec" aria-hidden="true">{">"}</span>
      </label>
      <span className="file-viewer-beamer-sep" aria-hidden="true" />
      <button
        type="button"
        className="file-viewer-beamer-apply"
        title={t("fileViewer.beamerWrapTitle", { cmd })}
        // mousedown + preventDefault keeps the editor's selection: the button
        // must not take focus, or the textarea blurs and WebKitGTK collapses
        // the very selection about to be wrapped.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run(wrap)}
      >
        {t("fileViewer.beamerWrap")}
      </button>
      <button
        type="button"
        title={t("fileViewer.beamerItemsTitle")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run((v, s, e, spec) => overlayItems(v, s, e, spec))}
      >
        {t("fileViewer.beamerItems")}
      </button>
      <button
        type="button"
        title={t("fileViewer.beamerPauseTitle")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setNote(null);
          api.current?.applyEdit((v, s, e) => insertPause(v, s, e));
        }}
      >
        {t("fileViewer.beamerPause")}
      </button>
      {note && <span className="file-viewer-beamer-note" role="status">{note}</span>}
    </div>
  );
}

/** How a `.tex` is built: the engine (`""` = let the backend pick) and the #54
 *  options. One value per *document*, not per file — see `TexView.compileOpts`. */
export type TexCompileOpts = { engine: string; outDir: string; extraFlags: string };
const EMPTY_TEX_COMPILE_OPTS: TexCompileOpts = { engine: "", outDir: "", extraFlags: "" };

/** A tab's persisted build configuration (see `ViewerState.texEngine`), with the
 *  defaults filled in for a tab that has never had one. */
export function texCompileOptsFrom(vs: ViewerState | undefined): TexCompileOpts {
  return {
    engine: vs?.texEngine ?? EMPTY_TEX_COMPILE_OPTS.engine,
    outDir: vs?.texOutDir ?? EMPTY_TEX_COMPILE_OPTS.outDir,
    extraFlags: vs?.texExtraFlags ?? EMPTY_TEX_COMPILE_OPTS.extraFlags,
  };
}

/** The same patch, in `ViewerState` spelling. Only the keys actually being
 *  changed are written, so a patch of one field never restates the other two. */
export function texCompileViewerState(patch: Partial<TexCompileOpts>): ViewerState {
  const vs: ViewerState = {};
  if (patch.engine !== undefined) vs.texEngine = patch.engine;
  if (patch.outDir !== undefined) vs.texOutDir = patch.outDir;
  if (patch.extraFlags !== undefined) vs.texExtraFlags = patch.extraFlags;
  return vs;
}

/**
 * "That file isn't there yet — make it?" — the answer to a Ctrl/⌘+click on an
 * `\input{…}` naming a file that does not exist (#tex-create-ref).
 *
 * A banner rather than a modal, deliberately: this is an offer, not a question
 * that has to be answered before anything else can happen. The click was aimed at
 * the editor, the caret is still where the user left it, and declining has to
 * cost nothing — a modal would take the keyboard away from a document somebody is
 * in the middle of typing. It wears the pane's own notice chrome
 * (`tex-install-banner`), which is what this viewer already uses to say
 * "something is missing, here is the button that fixes it".
 */
export function TexCreateRefBanner({
  creation,
  newFolder,
  busy,
  error,
  onCreate,
  onDismiss,
}: {
  creation: TexRefCreation;
  /** The file's folder is missing too and would be created along with it. */
  newFolder: boolean;
  busy: boolean;
  error: string | null;
  onCreate: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <div className="tex-install-banner" role="alert">
      <span className="tex-install-banner-text">
        {newFolder && creation.folder
          ? t("fileViewer.texMissingRefFolderMsg", {
              name: creation.rel,
              folder: creation.folder.rel,
            })
          : t("fileViewer.texMissingRefMsg", { name: creation.rel })}
        {error ? ` ${error}` : ""}
      </span>
      <UntestedTag id="fileViewerPane.5" />
      <button
        type="button"
        className="ollama-action-btn primary"
        onClick={onCreate}
        disabled={busy}
      >
        {busy ? t("fileViewer.texCreatingRef") : t("fileViewer.texCreateRefBtn")}
      </button>
      <button type="button" className="ollama-action-btn" onClick={onDismiss} disabled={busy}>
        {t("common.cancel")}
      </button>
    </div>
  );
}

/** One diagnostic as `file:line: message` — the shape TeX itself prints under
 *  `-file-line-error`, so a copied row pastes back into a search, a bug report
 *  or an agent prompt as the same text the log holds. A warning the log could
 *  not place carries the message alone rather than an invented location. */
export function texDiagnosticText(
  message: string,
  file: string | undefined,
  line: number | undefined,
): string {
  return file && line ? `${file}:${line}: ${message}` : message;
}

/**
 * The one-click way to get a compile diagnostic out of the card and into an
 * agent tab, a mail, or a search box (#tex).
 *
 * Every row of the error and warning lists is already a *jump* button, and the
 * app sets `user-select: none` globally (`styles/base.css`) — so the text of a
 * TeX error was, of all the text in this viewer, the least reachable: clicking
 * it moved the caret instead of selecting it. This sits beside the jump (never
 * inside it — a button in a button is not a button) and carries the same ⧉ → ✓
 * as the connection log, because it is the same promise: the *whole* thing on
 * the clipboard, not the part that happens to be on screen.
 */
export function TexCopyButton({
  text,
  label,
  className = "file-viewer-tex-copy",
}: {
  text: string;
  /** What this button copies, for the tooltip and the screen reader. */
  label: string;
  className?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  // The ✓ resets on a timer owned by the effect, so copying again during an
  // in-flight window restarts it instead of leaving a stale tick behind.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);
  const title = copied ? t("fileViewer.copied") : label;
  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={title}
      onClick={(e) => {
        // The row around this button jumps to the source location; copying is
        // not a request to move the caret there too.
        e.stopPropagation();
        if (!text) return;
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
      }}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}
