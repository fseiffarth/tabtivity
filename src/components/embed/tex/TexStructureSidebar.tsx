import { useCallback, useMemo, useState } from "react";
import type { InternalViewer } from "../../../lib/viewers/fileUtils";
import { FileIcon } from "../../common/icons/FileIcon";
import { ChevronLeftIcon, ChevronRightIcon, FileImageIcon } from "../../common/icons/Icon";
import type {
  TexFileDiagnostics,
  TexFileNode,
  TexGraphicNode,
  TexStructure,
} from "../../../lib/viewers/tex/tex";
import { useT } from "../../../lib/i18n";
import { UntestedTag } from "../../common/UntestedTag";

/** The chrome the workspace's two navigation steps share (#tex-structure-up):
 *  what a click does, what the button's title names, and the chord the title
 *  advertises (resolved by the host through `lib/shortcuts/shortcuts`, so a rebound key
 *  is what the tooltip shows). `onX` absent = the step has nowhere to go. */
export interface TexNavProps {
  /** Go back to the previously centered file; absent = nothing to go back to. */
  onBack?: () => void;
  /** Basename of what `onBack` would return to, for the button's title. */
  backLabel?: string;
  /** Go up to the parent that `\input`s the centered file, caret on that line;
   *  absent = the main document is centered. */
  onUp?: () => void;
  /** Basename of the parent `onUp` would go to, and the 1-based line of the
   *  `\input` there (absent when the reference's position is unknown). */
  upLabel?: string;
  upLine?: number;
  /** Human labels of the two chords, for the titles ("Alt+Shift+↓"). */
  backChord?: string;
  upChord?: string;
}

/**
 * The workspace's "back to the file I was on" button, rendered in both the
 * sidebar's header and its folded rail — one component, so the two cannot end up
 * describing the same step differently.
 *
 * Shown DISABLED rather than hidden when there is nowhere to go back to: this is
 * the only navigation control the workspace has, and one that appears the moment
 * a file is opened is a control nobody finds before they need it.
 */
function TexBackButton({ onBack, backLabel, backChord }: TexNavProps) {
  const t = useT();
  const title = onBack
    ? backChord
      ? t("texWorkspace.backChord", { name: backLabel ?? "", chord: backChord })
      : t("texWorkspace.back", { name: backLabel ?? "" })
    : t("texWorkspace.backEmpty");
  return (
    <button
      type="button"
      className="tex-structure-chrome-btn tex-structure-back"
      title={title}
      aria-label={title}
      disabled={!onBack}
      onClick={onBack}
    >
      ←
    </button>
  );
}

/**
 * The workspace's "up to the document that inputs this one" button
 * (#tex-structure-up), ←'s sibling on both surfaces. Back retraces where the
 * center has BEEN; Up climbs the document's own tree — from a chapter to the
 * `\input{chapter}` line in its parent, whether or not the parent was ever
 * centered this sitting. Same disabled-not-hidden rule as Back: on the main
 * document it is inert, and the title says why.
 */
function TexUpButton({ onUp, upLabel, upLine, upChord }: TexNavProps) {
  const t = useT();
  const title = onUp
    ? t("texWorkspace.up", { name: upLabel ?? "", line: String(upLine ?? "?"), chord: upChord ?? "" })
    : t("texWorkspace.upEmpty");
  return (
    <button
      type="button"
      className="tex-structure-chrome-btn tex-structure-up"
      title={title}
      aria-label={title}
      disabled={!onUp}
      onClick={onUp}
    >
      ↑
    </button>
  );
}

/**
 * The folded structure sidebar: a thin vertical rail carrying the way back out
 * of the fold and the Back button beside it. The fold never leaves a bare pane
 * edge — a sidebar that can only be recovered from a settings panel (or not at
 * all) is a one-way door, and this tab has no other chrome to put the control in.
 */
export function TexStructureRail({
  onShow,
  ...nav
}: TexNavProps & {
  onShow: () => void;
}) {
  const t = useT();
  return (
    <div className="tex-structure-rail">
      <button
        type="button"
        className="tex-structure-chrome-btn"
        title={t("texWorkspace.showStructure")}
        aria-label={t("texWorkspace.showStructure")}
        onClick={onShow}
      >
        <ChevronRightIcon />
      </button>
      <TexBackButton {...nav} />
      <TexUpButton {...nav} />
    </div>
  );
}

/** Extension of a basename, lower-cased, for `FileIcon`. */
function extOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : null;
}

/**
 * The error/warning pills on one file's row, from the last build.
 *
 * A count, not a list: the sidebar's job is *which file*, and the Errors and
 * Warnings cards already hold the messages. Clicking one centers that file with
 * the caret on its first error (or first locatable warning) — the step a reader
 * who spotted the badge was about to take by hand, and the reason these are
 * their own buttons rather than decoration inside the row's.
 *
 * A warning-only file shows only the amber pill; a file with both shows both,
 * errors first. Nothing is drawn for a clean file — a tree of green ticks would
 * cost the one thing the badges are worth, which is that a red pill is rare
 * enough to be seen without looking for it.
 */
function TexDiagBadges({
  diag,
  name,
  onJump,
}: {
  diag: TexFileDiagnostics;
  /** Basename of the file the badges belong to, for their titles. */
  name: string;
  /** Center the file with the caret on `line` (undefined = no known line, in
   *  which case the file is centered where it was). */
  onJump: (line?: number) => void;
}) {
  const t = useT();
  const errTitle =
    diag.errors === 1
      ? t("texWorkspace.diagErrorOne", { name })
      : t("texWorkspace.diagErrorMany", { count: diag.errors, name });
  const warnTitle =
    diag.warnings === 1
      ? t("texWorkspace.diagWarnOne", { name })
      : t("texWorkspace.diagWarnMany", { count: diag.warnings, name });
  return (
    <>
      {diag.errors > 0 && (
        <button
          type="button"
          className="tex-structure-diag is-error"
          title={errTitle}
          aria-label={errTitle}
          onClick={() => onJump(diag.errorLine)}
        >
          {diag.errors}
        </button>
      )}
      {diag.warnings > 0 && (
        <button
          type="button"
          className="tex-structure-diag is-warning"
          title={warnTitle}
          aria-label={warnTitle}
          onClick={() => onJump(diag.warningLine)}
        >
          {diag.warnings}
        </button>
      )}
    </>
  );
}

/** A file (child `.tex`) and its graphics, bucketed under the sectioning heading
 *  they sit beneath in their parent — the grouping the sidebar renders. */
interface SectionBucket {
  section: string; // "" = no heading (the file preamble / un-sectioned front)
  children: TexFileNode[];
  graphics: TexGraphicNode[];
}

/** Group a node's direct children and graphics by their `section`, preserving
 *  first-appearance order of the headings and, within each, child files before
 *  their graphics (the plan's v1 ordering). */
function bucketize(node: TexFileNode): SectionBucket[] {
  const order: string[] = [];
  const map = new Map<string, SectionBucket>();
  const ensure = (section?: string): SectionBucket => {
    const key = section ?? "";
    let b = map.get(key);
    if (!b) {
      b = { section: key, children: [], graphics: [] };
      map.set(key, b);
      order.push(key);
    }
    return b;
  };
  for (const c of node.children) ensure(c.section).children.push(c);
  for (const g of node.graphics) ensure(g.section).graphics.push(g);
  return order.map((k) => map.get(k)!);
}

/**
 * The TeX workspace's LEFT STRUCTURE SIDEBAR: a read-only tree of the main
 * document's inputted `.tex` children and its `\includegraphics` graphics,
 * grouped by the section heading each sits under. Clicking an entry asks the
 * host to switch the workspace's center view to that file (a child `.tex` → the
 * TeX editor, a graphic → the image viewer) — it NEVER opens a tab.
 *
 * Purely presentational: it takes the already-parsed `structure`, the active
 * path, and `onSelect`, and owns nothing but its own hover/resize interaction.
 * It deliberately imports only i18n, the shared icons and the `UntestedTag`
 * pill (never `FileViewerPane`), so the leaf stays out of the viewer's import
 * graph.
 */
export function TexStructureSidebar({
  structure,
  activePath,
  width,
  onSelect,
  diagnostics,
  onResize,
  onHide,
  onNewFile,
  ...nav
}: TexNavProps & {
  structure: TexStructure;
  /** Absolute path of the file currently centered, for the active highlight. */
  activePath: string;
  /** Current sidebar width in px. */
  width: number;
  /** Switch the center to `path`, rendered with `viewer`; `line` (1-based) puts
   *  the caret there, for a jump to a file's first error. */
  onSelect: (path: string, viewer: InternalViewer, line?: number) => void;
  /** The last build's errors and warnings, keyed by absolute path. Absent (or
   *  empty) until this document has been compiled once this sitting — the
   *  sidebar never claims a file is clean, only that a build reported nothing
   *  in it. */
  diagnostics?: Map<string, TexFileDiagnostics>;
  /** Persist a drag-resized width (fired on pointer-up, not per move). */
  onResize: (width: number) => void;
  /** Fold the sidebar away to its rail. */
  onHide: () => void;
  /** Open the host's "add a file to this document" prompt (#tex-structure-newfile).
   *  Absent = the host has nowhere to create one, and the button is not shown. */
  onNewFile?: () => void;
}) {
  const t = useT();
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const shownWidth = liveWidth ?? width;

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const startX = e.clientX;
      const startW = shownWidth;
      let last = startW;
      const onMove = (ev: PointerEvent) => {
        last = Math.max(140, Math.min(520, startW + (ev.clientX - startX)));
        setLiveWidth(last);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setLiveWidth(null);
        if (last !== startW) onResize(last);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [shownWidth, onResize],
  );

  const root = structure.root;

  // The whole tree flattened for keyboard nav is overkill for v1; render the
  // root as the "main" row, then its section-grouped buckets recursively.
  const rootBuckets = useMemo(() => bucketize(root), [root]);

  // A row is a LINE, not a button: the file's own button plus whatever badges
  // its last build earned, which are buttons of their own (nesting one inside
  // the row's would be invalid markup and unreachable by keyboard). The line
  // carries the hover/active paint so it covers the badges too.
  const renderFileRow = (node: TexFileNode, depth: number) => {
    const active = node.path === activePath;
    const diag = diagnostics?.get(node.path);
    return (
      <div key={`f:${node.path}`} className={`tex-structure-rowline${active ? " is-active" : ""}`}>
        <button
          type="button"
          className={`tex-structure-row tex-structure-file${active ? " is-active" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-current={active ? "true" : undefined}
          title={node.path}
          onClick={() => onSelect(node.path, "tex")}
        >
          <span className="tex-structure-icon" aria-hidden="true"><FileIcon ext={extOf(node.label)} /></span>
          <span className="tex-structure-label">{node.label}</span>
        </button>
        {diag && (
          <TexDiagBadges
            diag={diag}
            name={node.label}
            onJump={(line) => onSelect(node.path, "tex", line)}
          />
        )}
      </div>
    );
  };

  const renderGraphicRow = (g: TexGraphicNode, depth: number) => {
    const active = g.path === activePath;
    return (
      <div key={`g:${g.path}`} className={`tex-structure-rowline${active ? " is-active" : ""}`}>
        <button
          type="button"
          className={`tex-structure-row tex-structure-graphic${active ? " is-active" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-current={active ? "true" : undefined}
          title={g.path}
          onClick={() => onSelect(g.path, g.viewer)}
        >
          <span className="tex-structure-icon" aria-hidden="true"><FileImageIcon /></span>
          <span className="tex-structure-label">{g.label}</span>
        </button>
      </div>
    );
  };

  // Recursively render a node's buckets. A child file row is followed by its own
  // buckets one level deeper, so the tree reads as the document's nesting.
  const renderBuckets = (node: TexFileNode, depth: number): React.ReactNode =>
    bucketize(node).map((b, i) => (
      <div key={`b:${node.path}:${i}`} className="tex-structure-section">
        {b.section && (
          <div className="tex-structure-heading" style={{ paddingLeft: 8 + depth * 14 }}>
            {b.section}
          </div>
        )}
        {b.children.map((c) => (
          <div key={`c:${c.path}`}>
            {renderFileRow(c, depth)}
            {renderBuckets(c, depth + 1)}
          </div>
        ))}
        {b.graphics.map((g) => renderGraphicRow(g, depth))}
      </div>
    ));

  return (
    <div className="tex-structure-sidebar" style={{ width: shownWidth }}>
      <div className="tex-structure-header">
        <TexBackButton {...nav} />
        <TexUpButton {...nav} />
        <span className="tex-structure-title">{t("texWorkspace.structureTitle")}</span>
        <UntestedTag id="texStructureSidebar.1" />
        {onNewFile && (
          <button
            type="button"
            className="tex-structure-chrome-btn tex-structure-new"
            title={t("texWorkspace.newFile")}
            aria-label={t("texWorkspace.newFile")}
            onClick={onNewFile}
          >
            ＋
          </button>
        )}
        <button
          type="button"
          className="tex-structure-chrome-btn tex-structure-fold"
          title={t("texWorkspace.hideStructure")}
          aria-label={t("texWorkspace.hideStructure")}
          onClick={onHide}
        >
          <ChevronLeftIcon />
        </button>
      </div>
      <div className="tex-structure-body">
        {renderFileRow(root, 0)}
        {rootBuckets.map((b, i) => (
          <div key={`rb:${i}`} className="tex-structure-section">
            {b.section && (
              <div className="tex-structure-heading" style={{ paddingLeft: 8 }}>
                {b.section}
              </div>
            )}
            {b.children.map((c) => (
              <div key={`c:${c.path}`}>
                {renderFileRow(c, 1)}
                {renderBuckets(c, 2)}
              </div>
            ))}
            {b.graphics.map((g) => renderGraphicRow(g, 1))}
          </div>
        ))}
        {rootBuckets.length === 0 && (
          <div className="tex-structure-empty">{t("texWorkspace.structureEmpty")}</div>
        )}
      </div>
      <div
        className="tex-structure-resize"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startResize}
      />
    </div>
  );
}
