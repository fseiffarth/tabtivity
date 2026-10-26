import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../../stores/projects";
import {
  useEditorJumpStore,
  registerEditor,
  unregisterEditor,
} from "../../../stores/viewers/editorJump";
import { relFromAbs } from "../../../lib/viewers/fileUtils";
import { remapBreakpoints, snapBreakpointLine } from "../../../lib/viewers/python";
import { argsFromLines, argsToLines } from "../../../lib/terminal/runArgsFormat";
import { PythonInterpreterSelect } from "../../projects/PythonInterpreterSelect";
import {
  directiveValue,
  COMMON_SBATCH_KEYS,
  type InteractiveResources,
} from "../../../lib/remote/hpc/slurm";
import { UntestedTag } from "../../common/UntestedTag";
import { isPathWithin } from "../../../lib/paths";
import { resolveProjectDirectory, type ProjectEntry } from "../../../types";
import { useT, type TranslationKey } from "../../../lib/i18n";
import { BoltIcon, BugIcon, PlayIcon, UploadIcon } from "../../common/icons/Icon";
import { useViewerState } from "./viewerState";

/**
 * In-tab code editor for plain-text/source files. A monospace textarea with a
 * scroll-synced line-number gutter, Tab/Shift+Tab indentation, and Ctrl/Cmd+S
 * (or the Save button) to write the file back to disk.
 */
/** Subscribe an editor for `path` to pending SyncTeX reverse-search jumps,
 *  yielding the `gotoLine`/`onGotoApplied` props for `CodeEditor`. */
export function useEditorJump(path: string) {
  const req = useEditorJumpStore((s) => s.requestsByPath[path] ?? null);
  const consume = useEditorJumpStore((s) => s.consume);
  const onGotoApplied = useCallback(() => consume(path), [consume, path]);
  // Advertise this editor to reverse search so a Ctrl+click in the PDF — even in
  // a detached window whose tabs never reach `useTabsStore` — scrolls it here
  // instead of being delegated to the main window (#42).
  useEffect(() => {
    registerEditor(path);
    return () => unregisterEditor(path);
  }, [path]);
  return {
    gotoLine: req ? { line: req.line, column: req.column, nonce: req.nonce } : undefined,
    onGotoApplied,
  };
}

/** One source line's git-blame attribution; mirrors the Rust `GitBlameLine`
 *  (snake_case, read verbatim). */
export interface BlameLine {
  line_no: number;
  hash: string;
  short: string;
  author: string;
  author_time: number;
  summary: string;
}

/** True for git's working-tree "Not Committed Yet" pseudo-commit (all-zeros or
 *  empty sha) — those lines get no attribution / hovercard. */
export function isUncommitted(b: BlameLine): boolean {
  return b.hash === "" || /^0+$/.test(b.hash);
}

/** Compact relative age ("now", "3d", "2mo", "5y") from a unix epoch (seconds). */
export function blameRelDate(epochSecs: number): string {
  if (!epochSecs) return "";
  const secs = Math.max(0, Date.now() / 1000 - epochSecs);
  const day = 86400;
  if (secs < 60) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < day) return `${Math.floor(secs / 3600)}h`;
  if (secs < day * 30) return `${Math.floor(secs / day)}d`;
  if (secs < day * 365) return `${Math.floor(secs / (day * 30))}mo`;
  return `${Math.floor(secs / (day * 365))}y`;
}

/** Shorten an author for the narrow gutter ("Ada Lovelace" → "A. Lovelace"). */
export function authorAbbrev(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0]) return name;
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

/** Fetches per-line git blame for `path` when `enabled`, keyed by 1-based line
 *  number. Resolves the owning project directory exactly like the autocomplete
 *  path (longest project dir that prefixes `path`, falling back to the active
 *  project) and calls the backend `git_blame` — which dispatches local vs remote
 *  (SSH) transparently. A non-repo dir, a disconnected remote, or any error
 *  yields an empty map (blame just shows nothing); it never throws. */
export function useBlame(path: string, enabled: boolean): Map<number, BlameLine> {
  const [byLine, setByLine] = useState<Map<number, BlameLine>>(() => new Map());
  useEffect(() => {
    if (!enabled) {
      setByLine(new Map());
      return;
    }
    const { projects, activeId } = useProjectsStore.getState();
    let projectDir = "";
    for (const p of projects) {
      const dir = resolveProjectDirectory(p);
      if (dir && isPathWithin(path, dir) && dir.length > projectDir.length) projectDir = dir;
    }
    if (!projectDir) {
      const active = projects.find((p) => p.id === activeId);
      projectDir = active ? resolveProjectDirectory(active) : "";
    }
    if (!projectDir) {
      setByLine(new Map());
      return;
    }
    const relPath = relFromAbs(projectDir, path);
    let cancelled = false;
    invoke<BlameLine[]>("git_blame", { projectDir, relPath })
      .then((lines) => {
        if (cancelled) return;
        const map = new Map<number, BlameLine>();
        for (const l of lines) map.set(l.line_no, l);
        setByLine(map);
      })
      .catch(() => {
        if (!cancelled) setByLine(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);
  return byLine;
}

/** "Blame" toolbar toggle. When active the code editor paints a per-line blame
 *  column in the gutter plus a faint current-line inline annotation. */
export function BlameButton({ active, toggle }: { active: boolean; toggle: () => void }) {
  const t = useT();
  return (
    <button
      className={`file-viewer-format-btn file-viewer-blame-btn${active ? " active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
      title={active ? t("fileViewer.blameHideTitle") : t("fileViewer.blameShowTitle")}
      aria-label={t("fileViewer.blameToggleLabel")}
      aria-pressed={active}
    >
      {t("fileViewer.blameBtn")}
    </button>
  );
}

/**
 * The editor's debug breakpoints (#py) — the gutter's red dots.
 *
 * Two things make this more than a `Set<number>`:
 *
 *  - **They must survive edits.** A breakpoint names a line, so typing a new
 *    import at the top of the file silently re-points every dot below it at the
 *    wrong statement. Each draft change is therefore diffed against the previous
 *    one and the lines are remapped (`remapBreakpoints`).
 *  - **They must be settable only where pdb can break.** Clicking a blank line or
 *    a comment snaps down to the next executable line rather than setting a
 *    breakpoint pdb would reject at startup (`snapBreakpointLine`).
 *
 * They persist in the tab's `ViewerState`, so they survive closing the file and
 * a Tabtivity restart — the same plumbing (and the same `project.json` write) as the
 * reader's scroll position.
 */
export function useBreakpoints(
  enabled: boolean,
  draft: string,
  loaded: boolean,
  viewPos: ReturnType<typeof useViewerState>,
) {
  const [lines, setLines] = useState<number[]>(() =>
    enabled ? (viewPos.initial?.breakpoints ?? []) : [],
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // The draft the current lines were resolved against. Seeded on first load: the
  // editor's ""→content transition is not an edit, and diffing across it would
  // look like "every line was replaced" and drop every restored breakpoint.
  const prevDraft = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !loaded) return;
    const before = prevDraft.current;
    prevDraft.current = draft;
    if (before === null || before === draft) return;
    setLines((cur) => {
      if (cur.length === 0) return cur;
      const next = remapBreakpoints(before, draft, cur);
      // Keep the identity stable when nothing moved, so the gutter doesn't
      // re-render on every keystroke.
      return next.length === cur.length && next.every((l, i) => l === cur[i]) ? cur : next;
    });
  }, [enabled, loaded, draft]);

  // Persist on change only — never on mount, which would rewrite the tab with the
  // value we just read out of it.
  const persistedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const key = lines.join(",");
    if (persistedKey.current === null) {
      persistedKey.current = key;
      return;
    }
    if (persistedKey.current === key) return;
    persistedKey.current = key;
    viewPos.persist({ breakpoints: lines });
  }, [enabled, lines, viewPos]);

  const toggle = useCallback((line: number) => {
    setLines((cur) => {
      if (cur.includes(line)) return cur.filter((l) => l !== line);
      const snapped = snapBreakpointLine(draftRef.current, line);
      if (snapped == null) return cur; // nothing executable below — no-op
      if (cur.includes(snapped)) return cur.filter((l) => l !== snapped);
      return [...cur, snapped].sort((a, b) => a - b);
    });
  }, []);

  const set = useMemo(() => new Set(lines), [lines]);
  return { lines, set, toggle };
}

/** Run / Debug (#py). Run executes the file in a fresh terminal tab; Debug does
 *  the same under `pdb`, pre-loaded with the gutter's breakpoints.
 *
 *  Right-clicking Run opens a small popover to type **arguments** (`sys.argv`) —
 *  appended to the command line and reused by every subsequent Run/Debug, so a
 *  plain left-click re-runs with them (the tooltip shows what they are) — and
 *  to pick the project's **interpreter** (venv/conda/system) for every Run. */
export function RunDebugButtons({
  breakpointCount,
  busy,
  showDebug,
  args,
  setArgs,
  onRun,
  onDebug,
  project,
}: {
  breakpointCount: number;
  busy: boolean;
  /** Debug (pdb + breakpoint gutter) is behind the experimental gate; Run isn't. */
  showDebug: boolean;
  /** The current argument string, and its setter (right-click popover edits it). */
  args: string;
  setArgs: (v: string) => void;
  onRun: () => void;
  onDebug: () => void;
  /** The file's project, whose pinned interpreter the popover edits; absent in
   *  the root scope (nothing to pin it on), and the picker is left out. */
  project?: ProjectEntry;
}) {
  const t = useT();
  const [argsOpen, setArgsOpen] = useState(false);
  // Hovering the Run/Debug buttons shows the saved args in an in-DOM popover — the
  // native `title` tooltip is unreliable under WebKitGTK, so it can't be the only
  // place the args are shown.
  const [hovering, setHovering] = useState(false);
  // Local draft so typing doesn't rebuild the run command on every keystroke; it
  // is committed to the shared `args` on Run or when the popover closes.
  // Edited as a list, one option per line (`runArgsFormat`), and joined back
  // into the one-line string on commit.
  const [draft, setDraft] = useState(() => argsToLines(args));
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const open = useCallback(() => {
    setDraft(argsToLines(args));
    setArgsOpen(true);
  }, [args]);
  const commit = useCallback(() => {
    setArgs(argsFromLines(draft));
    setArgsOpen(false);
  }, [draft, setArgs]);

  // Focus the field when the popover opens, and close it on an outside click or Esc.
  useEffect(() => {
    if (!argsOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) commit();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [argsOpen, commit]);

  return (
    <div
      className="file-viewer-run-controls"
      ref={wrapRef}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        className="file-viewer-format-btn"
        // Right-click opens the args popover. We act on mousedown, not the
        // contextmenu event: preventing the button's default focus-steal (needed
        // to keep the editor caret) suppresses `contextmenu` under WebKitGTK, so
        // that event never arrives. Left-click still runs via onClick.
        onMouseDown={(e) => {
          e.preventDefault();
          if (e.button === 2) open();
        }}
        onClick={onRun}
        onContextMenu={(e) => e.preventDefault()}
        disabled={busy}
        title={`${t("fileViewer.runFileTitle")}\n${t("fileViewer.rightClickArgs")}`}
        aria-label={t("fileViewer.runFileLabel")}
      >
        <PlayIcon /> {t("fileViewer.runLabel")}{args ? " *" : ""}
      </button>
      {showDebug && (
      <button
        className="file-viewer-format-btn"
        onMouseDown={(e) => {
          e.preventDefault();
          if (e.button === 2) open();
        }}
        onClick={onDebug}
        onContextMenu={(e) => e.preventDefault()}
        disabled={busy}
        title={
          (breakpointCount > 0
            ? t(
                breakpointCount === 1 ? "fileViewer.debugPdbLinesOne" : "fileViewer.debugPdbLinesMany",
                { count: breakpointCount },
              )
            : t("fileViewer.debugPdbFirstLine")) +
          `\n${t("fileViewer.rightClickArgs")}`
        }
        aria-label={t("fileViewer.debugFileLabel")}
      >
        <BugIcon /> {t("fileViewer.debugLabel")}
      </button>
      )}
      {/* Saved-args hover hint. Shown only while hovering, only when args are set,
          and never over the editor popover (which shows them already). */}
      {hovering && args && !argsOpen && (
        <div className="file-viewer-run-argshint" role="tooltip">
          <span className="file-viewer-run-argshint-label">{t("fileViewer.argsHintLabel")}</span>
          <span className="file-viewer-run-argshint-val">{argsToLines(args)}</span>
        </div>
      )}
      {argsOpen && (
        <div className="file-viewer-run-args" role="dialog" aria-label={t("fileViewer.runArgumentsDialog")}>
          <label className="file-viewer-run-args-label">{t("fileViewer.argsFieldLabel")}</label>
          <textarea
            ref={inputRef}
            className="file-viewer-run-args-input file-run-args-list"
            value={draft}
            spellCheck={false}
            wrap="off"
            rows={Math.min(8, Math.max(2, draft.split("\n").length))}
            placeholder={"--epochs 5\ndata.csv"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                setArgs(argsFromLines(draft));
                setArgsOpen(false);
                onRun();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setArgsOpen(false);
              }
            }}
          />
          {project && (
            <PythonInterpreterSelect
              project={project}
              labelClassName="file-viewer-run-args-label"
              selectClassName="file-viewer-run-args-input"
            />
          )}
          <div className="file-viewer-run-args-row">
            <button
              type="button"
              className="file-viewer-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setArgs(argsFromLines(draft));
                setArgsOpen(false);
                onRun();
              }}
            >
              <PlayIcon /> {t("fileViewer.runLabel")}
            </button>
            <button
              type="button"
              className="file-viewer-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setDraft("");
                setArgs("");
              }}
              disabled={!draft}
              title={t("fileViewer.clearArgsTitle")}
            >
              {t("fileViewer.clearArgsBtn")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Human labels for the `#SBATCH` keys the directive form surfaces. Mirrors
 *  `HpcPipelineWizard.tsx`'s `SBATCH_LABEL_KEYS` (same field set, same keys). */
const SBATCH_FIELD_LABEL_KEYS: Record<string, TranslationKey> = {
  "job-name": "hpcWizard.sbatchJobName",
  account: "hpcWizard.sbatchAccount",
  partition: "hpcWizard.sbatchPartition",
  time: "hpcWizard.sbatchTime",
  nodes: "hpcWizard.sbatchNodes",
  ntasks: "hpcWizard.sbatchTasks",
  "cpus-per-task": "hpcWizard.sbatchCpusPerTask",
  mem: "hpcWizard.sbatchMemory",
  gres: "hpcWizard.sbatchGres",
  output: "hpcWizard.sbatchOutput",
};

/** Placeholder hints per key, so an empty field still teaches the format. */
const SBATCH_FIELD_HINTS: Record<string, string> = {
  "job-name": "myjob",
  account: "your-group",
  partition: "gpu",
  time: "01:00:00",
  nodes: "1",
  ntasks: "1",
  "cpus-per-task": "4",
  mem: "8G",
  gres: "gpu:1",
  output: "slurm-%j.out",
};

/**
 * The SLURM control bar (HPC), shown beside the Python Run bar for a `#SBATCH`
 * script on a host that has SLURM. **Submit job** submits it and opens a log tab;
 * **Variables** toggles the `#SBATCH` directive form (render rows, edit text — each
 * edit splices the draft, an ordinary undoable change); **Interactive session…**
 * opens a resource mini-form that launches an `srun --pty` shell on a compute node.
 * Carries an `UntestedTag` until QA'd on a real cluster.
 */
export function SlurmBar({
  busy,
  fields,
  onField,
  onSubmit,
  onInteractive,
}: {
  busy: boolean;
  fields: { key: string; value: string }[];
  onField: (key: string, value: string) => void;
  onSubmit: () => void;
  onInteractive: (res: InteractiveResources) => void;
}) {
  const t = useT();
  const [varsOpen, setVarsOpen] = useState(false);
  const [interOpen, setInterOpen] = useState(false);
  // Per-field typed drafts, so a splice (and its undo step) happens on commit
  // (blur/Enter), not on every keystroke.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [inter, setInter] = useState<InteractiveResources>({
    time: "01:00:00",
    cpus: "4",
    mem: "8G",
    gpus: "",
    partition: "",
    account: "",
  });

  const valueFor = (key: string) =>
    edits[key] ?? directiveValue(fields, key);
  const commit = (key: string) => {
    const v = edits[key];
    if (v === undefined) return;
    onField(key, v);
  };

  return (
    <div className="file-viewer-run-controls">
      <button
        className="file-viewer-format-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSubmit}
        disabled={busy}
        title={t("fileViewer.submitSlurmTitle")}
        aria-label={t("fileViewer.submitSlurmLabel")}
      >
        <UploadIcon /> {t("fileViewer.submitJobLabel")}
      </button>
      <button
        className={`file-viewer-format-btn${varsOpen ? " active" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { setVarsOpen((v) => !v); setInterOpen(false); }}
        title={t("fileViewer.editSbatchTitle")}
        aria-pressed={varsOpen}
      >
        {t("fileViewer.variablesBtn")}
      </button>
      <button
        className={`file-viewer-format-btn${interOpen ? " active" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { setInterOpen((v) => !v); setVarsOpen(false); }}
        title={t("fileViewer.openInteractiveTitle")}
        aria-pressed={interOpen}
      >
        <BoltIcon /> {t("fileViewer.interactiveSessionLabel")}
      </button>
      <UntestedTag id="fileViewerPane.1" />

      {varsOpen && (
        <div className="file-viewer-run-args" role="dialog" aria-label={t("fileViewer.sbatchVariablesDialog")}>
          <label className="file-viewer-run-args-label">{t("fileViewer.sbatchDirectivesLabel")}</label>
          <div className="slurm-directive-grid">
            {COMMON_SBATCH_KEYS.map((key) => (
              <label key={key} className="slurm-directive-field">
                <span className="slurm-directive-key">
                  {SBATCH_FIELD_LABEL_KEYS[key] ? t(SBATCH_FIELD_LABEL_KEYS[key]) : key}
                </span>
                <input
                  className="file-viewer-run-args-input"
                  value={valueFor(key)}
                  spellCheck={false}
                  placeholder={SBATCH_FIELD_HINTS[key] ?? ""}
                  onChange={(e) => setEdits((m) => ({ ...m, [key]: e.target.value }))}
                  onBlur={() => commit(key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commit(key);
                    }
                  }}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      {interOpen && (
        <div className="file-viewer-run-args" role="dialog" aria-label={t("fileViewer.interactiveSessionDialog")}>
          <label className="file-viewer-run-args-label">{t("fileViewer.interactiveSessionFieldLabel")}</label>
          <div className="slurm-directive-grid">
            {([
              ["account", "hpcWizard.sbatchAccount", "your-group"],
              ["partition", "hpcWizard.sbatchPartition", "gpu"],
              ["time", "hpcWizard.sbatchTime", "01:00:00"],
              ["cpus", "hpcWizard.sbatchCpusPerTask", "4"],
              ["mem", "hpcWizard.sbatchMemory", "8G"],
              ["gpus", "fileViewer.sbatchGpus", "1"],
            ] as const).map(([k, labelKey, hint]) => (
              <label key={k} className="slurm-directive-field">
                <span className="slurm-directive-key">{t(labelKey)}</span>
                <input
                  className="file-viewer-run-args-input"
                  value={inter[k] ?? ""}
                  spellCheck={false}
                  placeholder={hint}
                  onChange={(e) => setInter((s) => ({ ...s, [k]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <div className="file-viewer-run-args-row">
            <button
              type="button"
              className="file-viewer-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setInterOpen(false); onInteractive(inter); }}
            >
              <BoltIcon /> {t("fileViewer.startLabel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
