import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ModeToggle } from "./fileViewer/toolbar";
import { ViewerHeader } from "./fileViewer/ViewerHeader";
import { DiffMoreRow, DiffStateNote } from "./diff/DiffStates";
import { useDiffSource } from "./diff/useDiffSource";
import { useT } from "../../lib/i18n";
import {
  parseUnifiedDiff,
  wholeFileHunk,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
} from "../../lib/viewers/diff";
import { hunkWordMarks, splitByMarks, type WordMark } from "../../lib/viewers/wordDiff";
import {
  DIFF_LINE_BUDGET,
  DIFF_LINE_STEP,
  capDiffFiles,
  clampLineWindow,
  firstChangeIndex,
  growLineWindow,
  initialLineWindow,
  shortenDiffFiles,
  shortenLongLines,
  type LineWindow,
} from "../../lib/viewers/diffBudget";
import {
  anchorId,
  changeAnchors,
  changeStarts,
  fileLabel,
  fileStats,
  foldRanges,
  foldSegments,
  scrollTopFor,
  splitDiffRows,
  stepChange,
} from "../../lib/viewers/diffRows";
import { ArrowDownIcon, ArrowUpIcon, RefreshIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { Dropdown } from "../common/Dropdown";
import { storageKey } from "../../lib/brand";

/** The Changes / Whole file switch, remembered for every git diff tab. */
const WHOLE_KEY = storageKey("diffView.wholeFile");
/** The Unified / Split switch, remembered for every diff tab. */
const SPLIT_KEY = storageKey("diffView.split");

function readFlagPref(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored == null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

function writeFlagPref(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Not remembered — the switch still works for this tab.
  }
}

/** `text` with the changed stretches (`marks`) wrapped in `.diff-word`. Plain
 *  React children — the text is escaped, never HTML. */
export function MarkedText({ text, marks }: { text: string; marks?: readonly WordMark[] }) {
  if (!marks || marks.length === 0) return <>{text}</>;
  return (
    <>
      {splitByMarks(text, marks).map((part, i) =>
        part.marked ? (
          <span className="diff-word" key={i}>
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/** A single rendered diff line: two line-number gutter columns then the text.
 *  Add/del tints come from the `.diff-line.is-add` / `.is-del` theme classes;
 *  `marks` are the word-level changes inside it (see `hunkWordMarks`). Text is
 *  rendered as React children, which auto-escapes — no raw HTML. */
export function DiffLineRow({ line, marks }: { line: DiffLine; marks?: readonly WordMark[] }) {
  const muted = line.type === "hunk" || line.type === "meta" || line.type === "nonewline";
  const marker =
    line.type === "add" ? "+" : line.type === "del" ? "-" : line.type === "context" ? " " : "";
  return (
    <div
      className={line.type === "add" ? "diff-line is-add" : line.type === "del" ? "diff-line is-del" : "diff-line"}
      data-type={line.type}
      style={{
        display: "flex",
        color: muted ? "var(--text-secondary, #8b949e)" : "var(--text-primary)",
        whiteSpace: "pre",
      }}
    >
      <span
        className="diff-gutter"
        style={{
          flex: "0 0 auto",
          width: "3.5em",
          textAlign: "right",
          paddingRight: "0.5em",
          color: "var(--text-secondary, #8b949e)",
          opacity: 0.7,
          userSelect: "none",
        }}
      >
        {line.oldNo ?? ""}
      </span>
      <span
        className="diff-gutter"
        style={{
          flex: "0 0 auto",
          width: "3.5em",
          textAlign: "right",
          paddingRight: "0.5em",
          borderRight: "1px solid var(--border-color)",
          color: "var(--text-secondary, #8b949e)",
          opacity: 0.7,
          userSelect: "none",
        }}
      >
        {line.newNo ?? ""}
      </span>
      <span className="diff-text" style={{ flex: "1 1 auto", paddingLeft: "0.5em" }}>
        {line.type === "hunk" || line.type === "nonewline" ? (
          line.text
        ) : (
          <>
            {marker}
            <MarkedText text={line.text} marks={marks} />
          </>
        )}
      </span>
    </div>
  );
}

/** A hunk's lines, with the word-level marks between paired del/add lines. */
export function DiffHunkLines({ lines }: { lines: readonly DiffLine[] }) {
  const marks = useMemo(() => hunkWordMarks(lines), [lines]);
  return (
    <>
      {lines.map((line, li) => (
        <DiffLineRow line={line} marks={marks.get(line)} key={li} />
      ))}
    </>
  );
}

/** The one-line notes under a file's header: binary, copy, rename similarity,
 *  mode change. A rename's old path already stands in the header (`FileName`). */
function fileNotes(file: DiffFile, t: ReturnType<typeof useT>): string[] {
  const notes: string[] = [];
  const similar = file.similarity != null ? t("diffView.similar", { pct: String(file.similarity) }) : null;
  if (file.status === "copied") {
    notes.push(t("diffView.copiedFrom", { path: file.oldPath }) + (similar ? ` · ${similar}` : ""));
  } else if (file.status === "renamed" && similar) {
    notes.push(similar);
  }
  if (file.binary) notes.push(t("diffView.binary"));
  if (file.oldMode && file.newMode && file.oldMode !== file.newMode && file.status === "modified") {
    notes.push(t("diffView.modeChange", { from: file.oldMode, to: file.newMode }));
  }
  return notes;
}

/** One hunk's lines, unified or split. `folding` (the whole-file view) folds
 *  long runs of unchanged lines into a "Show N unchanged lines" row until
 *  `expanded` holds its key. A change's first line or row carries the
 *  `data-jump` the previous / next buttons scroll to; `current` marks the one
 *  they last landed on. */
const HunkBody = memo(function HunkBody({
  lines,
  fileIndex,
  hunkIndex,
  split,
  folding,
  current,
  expanded,
  onExpand,
}: {
  lines: readonly DiffLine[];
  fileIndex: number;
  hunkIndex: number;
  split: boolean;
  folding: boolean;
  current: string | undefined;
  expanded: ReadonlySet<string>;
  onExpand: (key: string) => void;
}) {
  const t = useT();
  const starts = useMemo(() => new Set(changeStarts(lines)), [lines]);
  const marks = useMemo(() => hunkWordMarks(lines), [lines]);
  const segments = useMemo(() => foldSegments(lines.length, folding ? foldRanges(lines) : []), [lines, folding]);
  return (
    <div className="diff-hunk">
      {segments.map((seg) => {
        const key = `${fileIndex}:${hunkIndex}:${seg.from}-${seg.to}`;
        if (seg.fold && !expanded.has(key)) {
          return (
            <button type="button" className="diff-fold" key={seg.from} onClick={() => onExpand(key)}>
              {t("diffView.showUnchanged", { count: seg.to - seg.from })}
            </button>
          );
        }
        const part = lines.slice(seg.from, seg.to);
        if (split) {
          return (
            <Fragment key={seg.from}>
              {splitDiffRows(part).map((row, index) => {
                if (row.note !== undefined) {
                  return <div className="terminal-changes-split-note" key={index}>{row.note}</div>;
                }
                const id = anchorId(fileIndex, hunkIndex, seg.from + row.at);
                return (
                  <div
                    className="terminal-changes-split-row"
                    key={index}
                    data-jump={row.start ? `c:${id}` : undefined}
                    data-current={row.start && current === id ? "true" : undefined}
                  >
                    <div className={row.before?.type === "del" ? "del" : ""}><span>{row.before?.oldNo}</span><code>{row.before && <MarkedText text={row.before.text} marks={marks.get(row.before)} />}</code></div>
                    <div className={row.after?.type === "add" ? "add" : ""}><span>{row.after?.newNo}</span><code>{row.after && <MarkedText text={row.after.text} marks={marks.get(row.after)} />}</code></div>
                  </div>
                );
              })}
            </Fragment>
          );
        }
        return (
          <Fragment key={seg.from}>
            {part.map((line, i) => {
              const li = seg.from + i;
              if (!starts.has(li)) return <DiffLineRow line={line} marks={marks.get(line)} key={li} />;
              const id = anchorId(fileIndex, hunkIndex, li);
              return (
                <div className="diff-anchor" key={li} data-jump={`c:${id}`} data-current={current === id ? "true" : undefined}>
                  <DiffLineRow line={line} marks={marks.get(line)} />
                </div>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
});

function ChangeCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="terminal-changes-counts">
      <span className="add">+{added}</span>
      <span className="del">−{removed}</span>
    </span>
  );
}

/** A file's name, with the path it was renamed from before it. */
function FileName({ file }: { file: Pick<DiffFile, "oldPath" | "newPath"> }) {
  const t = useT();
  const { path, from } = fileLabel(file);
  return (
    <span title={from ? t("diffView.renamedFrom", { path: from }) : path}>
      {from && <span className="diff-index-from">{from} → </span>}
      {path}
    </span>
  );
}

/** The key that steps the changes while the diff has focus: N / F7 next, P /
 *  Shift+F7 previous, Alt+↓ / Alt+↑ either way. */
function changeKeyDir(e: { key: string; altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): 1 | -1 | null {
  if (e.ctrlKey || e.metaKey) return null;
  if (e.key === "F7") return e.shiftKey ? -1 : 1;
  if (e.altKey) return e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : null;
  if (e.shiftKey) return null;
  return e.key === "n" ? 1 : e.key === "p" ? -1 : null;
}

/**
 * In-app unified-diff viewer (Dev 3 / TODO Group K). Renders a `.diff`/`.patch`
 * file's content, or — when `path` is a real source file — the working-tree diff
 * for that file fetched from the backend (`git_diff_file`). The diff is parsed
 * with `parseUnifiedDiff` and rendered with a two-column (old/new) line-number
 * gutter and add/del/context colouring. All line text is rendered as React
 * children (auto-escaped) — never as raw HTML. A git diff shows the whole
 * file by default — the working-tree diff spread over the file as it is on
 * disk (`wholeFileHunk`), opened at its first change; the header's switch
 * narrows it to the changes.
 */
export function DiffView({
  path,
  projectId,
  mode = "git",
  onOpenExternally,
  tabKey: _tabKey,
}: {
  path: string;
  projectId: string | null;
  /** `"git"` (default) diffs the working tree via `git_diff_file`; `"sync"`
   *  diffs the local mirror against the current host over `sync_diff` (SSH
   *  projects). Patch/diff files always render their own raw content regardless. */
  mode?: "git" | "sync";
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const t = useT();
  const [wholePref, setWholePref] = useState(() => readFlagPref(WHOLE_KEY, true));
  // Where the text comes from and in what state (patch file, git diff, sync
  // diff; loading / error / not a repo / not connected): `diff/useDiffSource`.
  const src = useDiffSource({ path, projectId, mode, wantWhole: wholePref });
  const { patchMode, whole, relPath } = src;

  // A trailing newline is harmless to the parser; trimmed for older diffs' sake.
  const files = useMemo(
    () => (src.text != null ? parseUnifiedDiff(src.text.replace(/\r?\n$/u, "")) : []),
    [src.text],
  );
  /** Whole mode: the one file's diff over the text it was taken against —
   * null when it doesn't fit (the file moved on mid-ask: the bare hunks show). */
  const wholeHunk = useMemo<DiffHunk | null>(
    () => (whole && src.against != null ? wholeFileHunk(files[0], src.against) : null),
    [whole, files, src.against],
  );

  // A big diff draws its first lines only (`lib/viewers/diffBudget`): the
  // Changes view grows downward, the Whole file view is a window around the
  // first change that grows both ways. Both reset when the tab shows another file.
  const [budget, setBudget] = useState({ path, lines: DIFF_LINE_BUDGET });
  const changeBudget = budget.path === path ? budget.lines : DIFF_LINE_BUDGET;
  const capped = useMemo(() => capDiffFiles(files, changeBudget), [files, changeBudget]);
  const [winState, setWinState] = useState<{ path: string; w: LineWindow } | null>(null);
  const wholeLines = wholeHunk?.lines ?? null;
  const win = useMemo<LineWindow | null>(() => {
    if (!wholeLines) return null;
    if (winState && winState.path === path) return clampLineWindow(winState.w, wholeLines.length);
    return initialLineWindow(wholeLines.length, firstChangeIndex(wholeLines));
  }, [wholeLines, winState, path]);
  // A very long line is cut until the user asks for it whole.
  const [fullLines, setFullLines] = useState(false);
  const drawn = useMemo(() => {
    if (wholeLines && win) {
      const part = wholeLines.slice(win.start, win.end);
      const r = fullLines ? { lines: part, shortened: 0 } : shortenLongLines(part);
      return { files: [] as DiffFile[], lines: r.lines, shortened: r.shortened };
    }
    const r = fullLines ? { files: capped.files, shortened: 0 } : shortenDiffFiles(capped.files);
    return { files: r.files, lines: [] as DiffLine[], shortened: r.shortened };
  }, [wholeLines, win, capped, fullLines]);

  const growChanges = (all: boolean) =>
    setBudget({ path, lines: all ? capped.total : changeBudget + DIFF_LINE_STEP });
  const growWhole = (dir: "up" | "down" | "all") => {
    if (win && wholeLines) setWinState({ path, w: growLineWindow(win, wholeLines.length, dir) });
  };

  /** What is on screen: the whole file's drawn window as a single hunk, or the
   *  drawn (capped) parsed files. */
  const shown = useMemo<DiffFile[]>(
    () =>
      wholeHunk && win
        ? [
            {
              ...((files[0] as DiffFile | undefined) ?? { status: "modified" as const, binary: false, combined: false, crlf: false }),
              oldPath: relPath,
              newPath: relPath,
              hunks: [{ ...wholeHunk, lines: drawn.lines }],
            },
          ]
        : drawn.files,
    [wholeHunk, win, files, relPath, drawn],
  );
  const stats = useMemo(() => shown.map(fileStats), [shown]);
  const anchors = useMemo(() => changeAnchors(shown), [shown]);

  const [splitPref, setSplitPref] = useState(() => readFlagPref(SPLIT_KEY, false));
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [cur, setCur] = useState(-1);
  const [jump, setJump] = useState<{ target: string; align: "center" | "start"; n: number } | null>(null);
  const jumpCount = useRef(0);
  const curIdx = cur < anchors.length ? cur : -1;
  const currentId = curIdx >= 0 ? anchors[curIdx].id : undefined;

  // Another file in the tab starts with every file open, every fold shut.
  useEffect(() => {
    setCollapsed(new Set());
    setExpanded(new Set());
    setCur(-1);
  }, [path]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const request = useCallback((target: string, align: "center" | "start") => {
    setJump({ target, align, n: ++jumpCount.current });
  }, []);
  const openFile = useCallback((fi: number) => {
    setCollapsed((prev) => {
      if (!prev.has(fi)) return prev;
      const next = new Set(prev);
      next.delete(fi);
      return next;
    });
  }, []);
  const go = useCallback(
    (dir: 1 | -1) => {
      const next = stepChange(curIdx, anchors.length, dir);
      if (next < 0) return;
      setCur(next);
      openFile(anchors[next].file);
      request(`c:${anchors[next].id}`, "center");
      scrollRef.current?.focus({ preventScroll: true });
    },
    [curIdx, anchors, openFile, request],
  );
  const goFile = useCallback(
    (fi: number) => {
      openFile(fi);
      request(`f:${fi}`, "start");
    },
    [openFile, request],
  );
  const toggleFile = useCallback((fi: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(fi)) next.add(fi);
      return next;
    });
  }, []);
  const expandFold = useCallback((key: string) => {
    setExpanded((prev) => new Set(prev).add(key));
  }, []);

  // Scroll inside the viewer's own scroller (never an ancestor's) once the
  // render a jump asked for is on screen.
  useLayoutEffect(() => {
    if (!jump) return;
    const scroller = scrollRef.current;
    const el = scroller?.querySelector<HTMLElement>(`[data-jump="${jump.target}"]`);
    if (!scroller || !el) return;
    const box = el.getBoundingClientRect();
    scroller.scrollTop = scrollTopFor(
      jump.align,
      { top: scroller.getBoundingClientRect().top, scrollTop: scroller.scrollTop, height: scroller.clientHeight },
      { top: box.top, height: box.height },
    );
  }, [jump]);

  // Open the whole file at its first change, once per file shown.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!wholeHunk) {
      // Back in the Changes view: the next Whole file view opens at the change again.
      if (!whole) scrolledFor.current = null;
      return;
    }
    if (scrolledFor.current === path) return;
    scrolledFor.current = path;
    if (anchors.length === 0) return;
    setCur(0);
    request(`c:${anchors[0].id}`, "center");
  }, [wholeHunk, whole, path, anchors, request]);

  return (
    <ViewerHeader onOpenExternally={onOpenExternally}>
      {mode === "git" && !patchMode && (
        <ModeToggle
          value={wholePref ? "whole" : "changes"}
          onChange={(value) => {
            setWholePref(value === "whole");
            writeFlagPref(WHOLE_KEY, value === "whole");
          }}
          options={[
            { value: "changes", label: t("diffView.changesOnly") },
            { value: "whole", label: t("diffView.wholeFile") },
          ]}
        />
      )}
      <Dropdown
        className="diff-view-style"
        value={splitPref ? "split" : "unified"}
        ariaLabel={t("diffView.layout")}
        title={t("diffView.layout")}
        options={[
          { value: "unified", label: t("diffView.unified") },
          { value: "split", label: t("diffView.split") },
        ]}
        onChange={(value) => {
          setSplitPref(value === "split");
          writeFlagPref(SPLIT_KEY, value === "split");
        }}
      />
      {anchors.length > 0 && (
        <div className="diff-nav">
          <button
            type="button"
            className="file-viewer-find-btn"
            title={t("diffView.prevChange")}
            aria-label={t("diffView.prevChange")}
            onClick={() => go(-1)}
          >
            <ArrowUpIcon />
          </button>
          <span className="file-viewer-find-count" aria-live="polite">
            {t("diffView.changeCount", { n: curIdx < 0 ? "–" : curIdx + 1, total: anchors.length })}
          </span>
          <button
            type="button"
            className="file-viewer-find-btn"
            title={t("diffView.nextChange")}
            aria-label={t("diffView.nextChange")}
            onClick={() => go(1)}
          >
            <ArrowDownIcon />
          </button>
          <UntestedTag id="diffView.layout" />
        </div>
      )}
      {src.canRefresh && (
        <button
          type="button"
          className="file-viewer-format-btn diff-refresh-btn"
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
          onClick={src.refresh}
        >
          <RefreshIcon />
        </button>
      )}
      <div
        ref={scrollRef}
        className="diff-viewer"
        tabIndex={-1}
        onKeyDown={(e) => {
          const dir = changeKeyDir(e);
          if (dir == null || e.defaultPrevented) return;
          e.preventDefault();
          go(dir);
        }}
        style={{
          position: "absolute",
          inset: 0,
          top: "var(--file-viewer-header-h, 36px)",
          overflow: "auto",
          background: "var(--bg-panel)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
          fontSize: "12px",
          lineHeight: "1.5",
        }}
      >
        {src.status !== "ready" || shown.length === 0 ? (
          <DiffStateNote
            status={src.status}
            error={src.error}
            empty={src.status === "ready"}
            onRetry={src.refresh}
          />
        ) : (
          <>
            {wholeHunk && files.length === 0 && <DiffMoreRow>{t("diffView.noChanges")}</DiffMoreRow>}
            {win && win.start > 0 && (
              <DiffMoreRow hint={t("diffView.linesAbove", { n: win.start })}>
                <button type="button" className="file-viewer-format-btn" onClick={() => growWhole("up")}>
                  {t("diffView.showEarlier", { n: Math.min(win.start, DIFF_LINE_STEP) })}
                </button>
                <button type="button" className="file-viewer-format-btn" onClick={() => growWhole("all")}>
                  {t("diffView.showAll", { total: wholeLines?.length ?? 0 })}
                </button>
              </DiffMoreRow>
            )}
            {shown.length > 1 && (
              <nav className="diff-index" aria-label={t("diffView.fileIndex")}>
                {shown.map((file, fi) => (
                  <button type="button" className="diff-index-row" key={`${file.newPath}:${fi}`} onClick={() => goFile(fi)}>
                    <span className="diff-index-path">
                      <FileName file={file} />
                    </span>
                    <ChangeCounts added={stats[fi].added} removed={stats[fi].removed} />
                  </button>
                ))}
              </nav>
            )}
            {shown.map((file, fi) => {
              const folded = collapsed.has(fi);
              return (
                <div className="diff-file" key={`${file.newPath}:${fi}`} data-jump={`f:${fi}`}>
                  <div
                    className="diff-file-header"
                    style={{
                      padding: "0.4em 0.75em",
                      background: "var(--bg-elevated, rgba(255,255,255,0.04))",
                      borderTop: fi > 0 ? "1px solid var(--border-color)" : undefined,
                      borderBottom: "1px solid var(--border-color)",
                      fontWeight: 600,
                      position: "sticky",
                      top: 0,
                    }}
                  >
                    <button
                      type="button"
                      className="diff-file-fold"
                      aria-expanded={!folded}
                      title={t(folded ? "diffView.unfoldFile" : "diffView.foldFile")}
                      onClick={() => toggleFile(fi)}
                    >
                      <span className={`diff-file-caret${folded ? " folded" : ""}`} aria-hidden="true">▾</span>
                      <FileName file={file} />
                    </button>
                    {wholeHunk ? <UntestedTag id="diffView.wholeFile" /> : <UntestedTag id="diffView.wordMarks" />}
                    <ChangeCounts added={stats[fi].added} removed={stats[fi].removed} />
                  </div>
                  {fileNotes(file, t).map((note) => (
                    <div className="diff-file-note" key={note}>
                      {note}
                    </div>
                  ))}
                  {!folded && (
                    <div className={splitPref ? "terminal-changes-split" : undefined}>
                      {splitPref && (
                        <div className="terminal-changes-split-heading">
                          <span>{t("terminal.changes.before")}</span>
                          <span>{t("terminal.changes.after")}</span>
                        </div>
                      )}
                      {file.hunks.map((hunk, hi) => (
                        <HunkBody
                          key={hi}
                          lines={hunk.lines}
                          fileIndex={fi}
                          hunkIndex={hi}
                          split={splitPref}
                          folding={!!wholeHunk}
                          current={currentId?.startsWith(`${fi}:${hi}:`) ? currentId : undefined}
                          expanded={expanded}
                          onExpand={expandFold}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {win && wholeLines && win.end < wholeLines.length && (
              <DiffMoreRow hint={t("diffView.linesBelow", { n: wholeLines.length - win.end })}>
                <button type="button" className="file-viewer-format-btn" onClick={() => growWhole("down")}>
                  {t("diffView.showMore", { n: Math.min(wholeLines.length - win.end, DIFF_LINE_STEP) })}
                </button>
                <button type="button" className="file-viewer-format-btn" onClick={() => growWhole("all")}>
                  {t("diffView.showAll", { total: wholeLines.length })}
                </button>
              </DiffMoreRow>
            )}
            {!wholeHunk && capped.shown < capped.total && (
              <DiffMoreRow hint={t("diffView.bigDiff", { shown: capped.shown, total: capped.total })}>
                <button type="button" className="file-viewer-format-btn" onClick={() => growChanges(false)}>
                  {t("diffView.showMore", { n: Math.min(capped.total - capped.shown, DIFF_LINE_STEP) })}
                </button>
                <button type="button" className="file-viewer-format-btn" onClick={() => growChanges(true)}>
                  {t("diffView.showAll", { total: capped.total })}
                </button>
                <UntestedTag id="diffView.states" />
              </DiffMoreRow>
            )}
          </>
        )}
        {src.status === "ready" && drawn.shortened > 0 && (
          <DiffMoreRow hint={t("diffView.longLines", { n: drawn.shortened })}>
            <button type="button" className="file-viewer-format-btn" onClick={() => setFullLines(true)}>
              {t("diffView.showFullLines")}
            </button>
            <UntestedTag id="diffView.states" />
          </DiffMoreRow>
        )}
      </div>
    </ViewerHeader>
  );
}
