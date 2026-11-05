import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModeToggle } from "./fileViewer/toolbar";
import { ViewerHeader } from "./fileViewer/ViewerHeader";
import { useReadonlyFile } from "./fileViewer/editableFile";
import { useT } from "../../lib/i18n";
import { useProjectsStore } from "../../stores/projects";
import { resolveProjectDirectory } from "../../types";
import { relFromAbs } from "../../lib/viewers/fileUtils";
import {
  diffFilePath,
  parseUnifiedDiff,
  wholeFileHunk,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
} from "../../lib/viewers/diff";
import { hunkWordMarks, splitByMarks, type WordMark } from "../../lib/viewers/wordDiff";
import { basename, dirname } from "../../lib/paths";
import { UntestedTag } from "../common/UntestedTag";
import { storageKey } from "../../lib/brand";

/** The Changes / Whole file switch, remembered for every git diff tab. */
const WHOLE_KEY = storageKey("diffView.wholeFile");

function readWholePref(): boolean {
  try {
    return localStorage.getItem(WHOLE_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeWholePref(whole: boolean): void {
  try {
    localStorage.setItem(WHOLE_KEY, whole ? "1" : "0");
  } catch {
    // Not remembered — the switch still works for this tab.
  }
}

/** True when `path` is a literal diff/patch file (read its raw content) rather
 *  than a source path (compute the diff via the backend). */
function isPatchFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".diff") || lower.endsWith(".patch");
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

/** The one-line notes under a file's header: binary, rename/copy, mode change. */
function fileNotes(file: DiffFile, t: ReturnType<typeof useT>): string[] {
  const notes: string[] = [];
  if (file.status === "renamed" || file.status === "copied") {
    const key = file.status === "renamed" ? "diffView.renamedFrom" : "diffView.copiedFrom";
    notes.push(t(key, { path: file.oldPath }) + (file.similarity != null ? ` · ${t("diffView.similar", { pct: String(file.similarity) })}` : ""));
  }
  if (file.binary) notes.push(t("diffView.binary"));
  if (file.oldMode && file.newMode && file.oldMode !== file.newMode && file.status === "modified") {
    notes.push(t("diffView.modeChange", { from: file.oldMode, to: file.newMode }));
  }
  return notes;
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
  const patchMode = isPatchFile(path);
  const [wholePref, setWholePref] = useState(readWholePref);
  const whole = mode === "git" && !patchMode && wholePref;

  // Hooks must run unconditionally. In patch mode we use this file's content; in
  // source mode we ignore it (and fetch the diff via the backend instead).
  const fileState = useReadonlyFile(path);

  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const projectDir = resolveProjectDirectory(project);
  // A file outside the project (or no project — the root console) asks git
  // from its own folder.
  const inProject = relFromAbs(projectDir, path);
  const gitDir = inProject ? projectDir : dirname(path);
  const relPath = inProject || basename(path);

  // Source-mode: fetch the diff on mount (and whenever the target changes) — the
  // working-tree diff via `git_diff_file`, or the host-vs-mirror diff via
  // `sync_diff` when this pane is a sync diff. The whole-file view asks once
  // the file is read and again whenever it is re-read, keeping the text each
  // answer was taken against: the shown pair stays until the next one lands.
  const against = whole ? fileState.content : null;
  const [gitAgainst, setGitAgainst] = useState<string | null>(null);
  const [gitText, setGitText] = useState<string | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  useEffect(() => {
    if (patchMode || (whole && against == null)) return;
    let cancelled = false;
    if (!whole) {
      setGitText(null);
      setGitError(null);
    }
    const req =
      mode === "sync"
        ? invoke<string>("sync_diff", { projectId, relPath })
        : invoke<string>("git_diff_file", { projectDir: gitDir, relPath });
    req
      .then((text) => {
        if (cancelled) return;
        setGitText(text);
        setGitAgainst(against);
        setGitError(null);
      })
      .catch((e) => {
        if (!cancelled) setGitError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [patchMode, whole, mode, projectId, gitDir, relPath, against]);

  const text = patchMode ? fileState.content : gitText;
  const error = patchMode || whole ? (fileState.error ?? gitError) : gitError;
  const loaded = text != null && (!whole || gitAgainst != null);

  const files = useMemo(() => (text != null ? parseUnifiedDiff(text) : []), [text]);
  /** Whole mode: the one file's diff over the text it was taken against —
   * null when it doesn't fit (the file moved on mid-ask: the bare hunks show). */
  const wholeHunk = useMemo<DiffHunk | null>(
    () => (whole && gitAgainst != null ? wholeFileHunk(files[0], gitAgainst) : null),
    [whole, files, gitAgainst],
  );

  // Open the whole file at its first change, once per file shown.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!wholeHunk || scrolledFor.current === path) return;
    scrolledFor.current = path;
    scrollRef.current
      ?.querySelector('.diff-line[data-type="add"], .diff-line[data-type="del"]')
      ?.scrollIntoView({ block: "center" });
  }, [wholeHunk, path]);

  return (
    <ViewerHeader onOpenExternally={onOpenExternally}>
      {mode === "git" && !patchMode && (
        <ModeToggle
          value={wholePref ? "whole" : "changes"}
          onChange={(value) => {
            setWholePref(value === "whole");
            writeWholePref(value === "whole");
          }}
          options={[
            { value: "changes", label: t("diffView.changesOnly") },
            { value: "whole", label: t("diffView.wholeFile") },
          ]}
        />
      )}
      <div
        ref={scrollRef}
        className="diff-viewer"
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
        {error != null ? (
          <div className="diff-error" style={{ padding: "1rem", color: "#f85149" }}>
            {error}
          </div>
        ) : !loaded ? (
          <div className="diff-loading" style={{ padding: "1rem", color: "var(--text-secondary, #8b949e)" }}>
            {t("diffView.loading")}
          </div>
        ) : wholeHunk ? (
          <div className="diff-file">
            <div
              className="diff-file-header"
              style={{
                padding: "0.4em 0.75em",
                background: "var(--bg-elevated, rgba(255,255,255,0.04))",
                borderBottom: "1px solid var(--border-color)",
                fontWeight: 600,
                position: "sticky",
                top: 0,
              }}
            >
              {relPath} <UntestedTag id="diffView.wholeFile" />
            </div>
            <div className="diff-hunk">
              <DiffHunkLines lines={wholeHunk.lines} />
            </div>
          </div>
        ) : files.length === 0 ? (
          <div className="diff-empty" style={{ padding: "1rem", color: "var(--text-secondary, #8b949e)" }}>
            {t("diffView.noChanges")}
          </div>
        ) : (
          files.map((file, fi) => (
            <div className="diff-file" key={`${file.newPath}:${fi}`}>
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
                {diffFilePath(file)} <UntestedTag id="diffView.wordMarks" />
              </div>
              {fileNotes(file, t).map((note) => (
                <div className="diff-file-note" key={note}>
                  {note}
                </div>
              ))}
              {file.hunks.map((hunk, hi) => (
                <div className="diff-hunk" key={hi}>
                  <DiffHunkLines lines={hunk.lines} />
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </ViewerHeader>
  );
}
