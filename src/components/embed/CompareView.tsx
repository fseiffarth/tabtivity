import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import { useUnsavedWork } from "../../lib/window/unsavedWork";
import { useProjectsStore } from "../../stores/projects";
import { resolveProjectDirectory } from "../../types";
import { isPathWithin } from "../../lib/paths";
import { relFromAbs } from "../../lib/viewers/fileUtils";
import { highlight, languageForPath } from "../../lib/viewers/highlight";
import {
  diffLines,
  groupChanges,
  buildMerged,
  applyBlockToggle,
  canToggle,
  locateBlock,
  type AlignRow,
  type ChangeBlock,
  type Decision,
} from "../../lib/viewers/linediff";
import { ArrowLeftIcon, ArrowRightIcon, UndoIcon } from "../common/icons/Icon";

/** Mirrors the Rust `GitCommit` (serde default snake→camel via serde? no — the
 *  struct is plain, so fields arrive as declared: hash/short/subject/… ). */
interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
  refs: string;
  is_head: boolean;
  parents: string[];
}

// Reuse the diff viewer's low-alpha add/del tints so it reads in both themes.
const ADD_BG = "rgba(63, 185, 80, 0.15)";
const DEL_BG = "rgba(248, 81, 73, 0.15)";
// Sync-merge tints: the two sides are local (green) vs remote (amber), so the
// changed lines take the locality-tag colors instead of add/del red-green.
const LOCAL_BG = "color-mix(in srgb, var(--success) 15%, transparent)";
const REMOTE_BG = "color-mix(in srgb, var(--warning) 15%, transparent)";

/** Resolve the owning project directory for `path` exactly like `useBlame`:
 *  the longest project dir that contains the path, else the active project. */
function projectDirFor(path: string): string {
  const { projects, activeId } = useProjectsStore.getState();
  let best = "";
  for (const p of projects) {
    const dir = resolveProjectDirectory(p);
    if (dir && isPathWithin(path, dir) && dir.length > best.length) best = dir;
  }
  if (!best) {
    const active = projects.find((p) => p.id === activeId);
    best = active ? resolveProjectDirectory(active) : "";
  }
  return best;
}

/** A read-only column (old or new) rendered line-by-line with per-line tinting
 *  and reused syntax highlighting. Only lines present on that side are shown.
 *
 *  When merge props are supplied it also draws a per-change **take arrow** at the
 *  first line of every change block: on the left column a "→" that pulls the left
 *  side into the result (decision `reject`), on the right column a "←" that pulls
 *  the right side in (decision `accept`). The arrow lights up when its side is the
 *  one currently chosen, so each hunk shows which way it resolved at a glance. */
function SideColumn({
  title,
  rows,
  side,
  path,
  scrollRef,
  onScroll,
  blocks,
  isActive,
  onTake,
  enabledOf,
  onJump,
  syncMode,
}: {
  title: string;
  rows: AlignRow[];
  side: "left" | "right";
  path: string;
  scrollRef: React.RefObject<HTMLDivElement>;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  /** Change blocks to anchor take-arrows against; omit to draw a plain column. */
  blocks?: ChangeBlock[];
  /** Sync merge: tint changed lines by locality (green local / amber remote). */
  syncMode?: boolean;
  /** Whether this side is the block's currently-chosen decision. */
  isActive?: (b: ChangeBlock) => boolean;
  /** Resolve this block to this side. */
  onTake?: (b: ChangeBlock) => void;
  /** Whether the block can still be (re)assigned (false once hand-edited off-anchor). */
  enabledOf?: (b: ChangeBlock) => boolean;
  /** Snap all panes to a block (from a ruler-bar click). */
  onJump?: (b: ChangeBlock) => void;
}) {
  const t = useT();
  const lang = useMemo(() => languageForPath(path), [path]);
  const lines = useMemo(() => {
    const out: { text: string; tint: string | undefined; no: number; ri: number }[] = [];
    let no = 0;
    rows.forEach((r, ri) => {
      const text = side === "left" ? r.left : r.right;
      if (text == null) return; // absent on this side
      no++;
      const changed =
        r.kind === "change" ||
        (r.kind === "del" && side === "left") ||
        (r.kind === "add" && side === "right");
      const tint = !changed
        ? undefined
        : syncMode
          ? side === "left"
            ? LOCAL_BG
            : REMOTE_BG
          : side === "left"
            ? DEL_BG
            : ADD_BG;
      out.push({ text, tint, no, ri });
    });
    return out;
  }, [rows, side, syncMode]);

  const lineHtml = useMemo(() => lines.map((l) => highlight(l.text, lang)), [lines, lang]);

  // Anchor each block's take-arrow to the first rendered line at/after its start
  // row (clamped to the last line when this side has no line inside the block —
  // e.g. a pure addition on the other side), keyed by line index for O(1) lookup.
  const anchors = useMemo(() => {
    const m = new Map<number, ChangeBlock>();
    if (!blocks) return m;
    for (const b of blocks) {
      let k = lines.findIndex((l) => l.ri >= b.startRow);
      if (k < 0) k = lines.length - 1;
      if (k >= 0 && !m.has(k)) m.set(k, b);
    }
    return m;
  }, [blocks, lines]);

  // Take-arrows live in an overlay layer positioned in pixels and synced to the
  // body's vertical scroll — NOT inline in each line, which would let a long
  // (horizontally scrolling) line carry the arrow off-screen. LINE_H mirrors the
  // CSS (font-size 12 × line-height 1.5). The overlay is scrolled by translating
  // an inner layer via a ref in the scroll handler — NOT by React state, which
  // would re-render every line on every scroll frame and make scrolling stutter.
  const LINE_H = 18;
  const takeScrollRef = useRef<HTMLDivElement>(null);
  const label = side === "left" ? t("compareView.takeLabelLeft") : t("compareView.takeLabelRight");

  return (
    <div className="file-viewer-compare-col">
      <div className="file-viewer-compare-col-head">{title}</div>
      <div className="file-viewer-compare-col-body-wrap">
        <DiffRuler blocks={blocks} totalRows={rows.length} side={side} onJump={onJump} />
        <div
          className="file-viewer-compare-col-body"
          ref={scrollRef}
          onScroll={(e) => {
            if (takeScrollRef.current) {
              takeScrollRef.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`;
            }
            onScroll(e);
          }}
        >
          {lines.map((l, i) => {
            const html = lineHtml[i];
            const blockStart = anchors.has(i);
            return (
              <div
                className={`file-viewer-compare-line${blockStart ? " is-block-start" : ""}`}
                style={{ background: l.tint }}
                key={i}
              >
                <span className="file-viewer-compare-lno">{l.no}</span>
                {html != null ? (
                  <span className="file-viewer-compare-code" dangerouslySetInnerHTML={{ __html: html }} />
                ) : (
                  <span className="file-viewer-compare-code">{l.text}</span>
                )}
              </div>
            );
          })}
        </div>
        {onTake && anchors.size > 0 && (
          <div className={`file-viewer-compare-take-layer ${side}`}>
            <div className="file-viewer-compare-take-scroll" ref={takeScrollRef}>
              {[...anchors.entries()].map(([i, b]) => {
                const enabled = enabledOf ? enabledOf(b) : true;
                const active = !!isActive?.(b);
                return (
                  <button
                    className={`file-viewer-compare-take ${side}${active ? " active" : ""}${enabled ? "" : " disabled"}`}
                    key={b.id}
                    style={{ top: i * LINE_H }}
                    title={
                      enabled
                        ? side === "left"
                          ? t("compareView.takeFromLeftTitle")
                          : t("compareView.takeFromRightTitle")
                        : t("compareView.editedManuallyTitle")
                    }
                    onClick={() => enabled && onTake(b)}
                  >
                    {side === "left" ? <>{label} <ArrowRightIcon /></> : <><ArrowLeftIcon /> {label}</>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** An overview ruler painted over a column's scrollbar edge: one bar per change
 *  block, positioned by its fractional row span so the diffs are visible at a
 *  glance across the whole file, not just the scrolled-in slice. Row-fraction
 *  (not pixel) placement keeps the bars aligned across the three columns. Each
 *  bar is clickable — it snaps all three panes to that resolve position. */
function DiffRuler({
  blocks,
  totalRows,
  side,
  onJump,
}: {
  blocks?: ChangeBlock[];
  totalRows: number;
  side: "left" | "right" | "mid";
  onJump?: (b: ChangeBlock) => void;
}) {
  const t = useT();
  if (!blocks || blocks.length === 0 || totalRows === 0) return null;
  return (
    <div className="file-viewer-compare-ruler">
      {blocks.map((b) => (
        <div
          className={`file-viewer-compare-ruler-mark ${side}${onJump ? " clickable" : ""}`}
          key={b.id}
          title={onJump ? t("compareView.jumpToChangeTitle") : undefined}
          onClick={onJump ? () => onJump(b) : undefined}
          style={{
            top: `${(b.startRow / totalRows) * 100}%`,
            height: `${Math.max(((b.endRow - b.startRow) / totalRows) * 100, 0.8)}%`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * Three-column compare/merge view for the in-app text editors. Left is the file
 * at a chosen commit (its own history, via `git_file_log`), right is the live
 * editor content, and the middle is an editable merged result. Each change block
 * can be accepted (keep the new/right lines) or rejected (restore the old/left
 * lines); the middle buffer stays freely editable and toggles splice into it by
 * context anchor. "Apply to file" feeds the merged text back into the editor's
 * normal draft/save flow.
 */
export function CompareView({
  path,
  rightText,
  onApply,
  onClose,
  left,
  rightTitle,
  applyLabel,
}: {
  path: string;
  /** The live editor content (the "new" side). */
  rightText: string;
  /** Absent → a look-only compare (the git pull preview): no Apply button. */
  onApply?: (merged: string) => void;
  onClose: () => void;
  /** When provided, the left ("old") side is a fixed text rather than a commit
   *  picked from this file's git history — this is the "sync merge" mode where
   *  the left side is the local mirror. In that mode the commit dropdown is
   *  hidden and no git history is fetched. Absent → the git-compare behaviour. */
  left?: { text: string; title: string };
  /** Header for the right column. Defaults to "Current (editor)". */
  rightTitle?: string;
  /** Label for the apply button. Defaults to "Apply to file". */
  applyLabel?: string;
}) {
  const t = useT();
  const syncMode = left != null;
  const projectDir = useMemo(() => projectDirFor(path), [path]);
  const relPath = useMemo(() => relFromAbs(projectDir, path), [projectDir, path]);

  const [history, setHistory] = useState<GitCommit[]>([]);
  const [rev, setRev] = useState<string>("");
  const [gitOldText, setGitOldText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load this file's commit history and default to its most recent commit (the
  // "previous version" relative to the working copy). Skipped in sync mode —
  // there the left side is a caller-supplied fixed text, not a git revision.
  useEffect(() => {
    if (syncMode) return;
    let cancelled = false;
    setError(null);
    invoke<GitCommit[]>("git_file_log", { projectDir, relPath, limit: 100 })
      .then((commits) => {
        if (cancelled) return;
        setHistory(commits);
        setRev((cur) => cur || (commits[0]?.hash ?? ""));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [syncMode, projectDir, relPath]);

  // Fetch the file at the selected revision (the "old" side). Skipped in sync
  // mode (the left text is provided directly).
  useEffect(() => {
    if (syncMode || !rev) {
      setGitOldText(null);
      return;
    }
    let cancelled = false;
    setGitOldText(null);
    invoke<string>("git_file_at_rev", { projectDir, relPath, rev })
      .then((text) => {
        if (!cancelled) setGitOldText(text);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [syncMode, projectDir, relPath, rev]);

  // The left/"old" side: the caller's fixed text in sync mode, else the fetched
  // git revision.
  const oldText = syncMode ? left!.text : gitOldText;

  const rows = useMemo(() => diffLines(oldText ?? "", rightText), [oldText, rightText]);
  const blocks = useMemo(() => groupChanges(rows), [rows]);

  // Merge state: a decision per block plus the authoritative editable buffer.
  // `manual` flips once the user hand-edits, switching toggles from a wholesale
  // recompute to a context-anchored splice that preserves those edits.
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [resultText, setResultText] = useState<string>("");
  const [manual, setManual] = useState(false);

  // Re-seed the merge whenever the compared versions change: default every block
  // to "accept", so the result starts equal to the live editor content.
  useEffect(() => {
    setDecisions({});
    setManual(false);
    setResultText(oldText == null ? rightText : buildMerged(rows, blocks, {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oldText, rightText]);

  // A merge in progress (GitMergeView's conflict resolve, SyncMergeView): picks
  // or hand edits not yet applied live only here. Plain diffs (no `onApply`)
  // hold nothing to lose.
  useUnsavedWork(onApply != null && (manual || Object.keys(decisions).length > 0));

  const decisionOf = (b: ChangeBlock): Decision => decisions[b.id] ?? "accept";

  const toggle = (b: ChangeBlock) => {
    const cur = decisionOf(b);
    if (!manual) {
      const next = { ...decisions, [b.id]: cur === "accept" ? ("reject" as Decision) : ("accept" as Decision) };
      setDecisions(next);
      setResultText(buildMerged(rows, blocks, next));
      return;
    }
    const res = applyBlockToggle(resultText, b, cur);
    if (!res) return; // unanchored — button is disabled anyway
    setResultText(res.text);
    setDecisions({ ...decisions, [b.id]: res.decision });
  };

  const setAll = (d: Decision) => {
    const next: Record<number, Decision> = {};
    for (const b of blocks) next[b.id] = d;
    setDecisions(next);
    setManual(false);
    setResultText(buildMerged(rows, blocks, next));
  };

  // Force a block to a specific side (used by the per-hunk take arrows). Since a
  // decision is binary, forcing the value it isn't already at is exactly a toggle;
  // when it already holds `d` this is a no-op, so re-clicking the lit arrow does
  // nothing rather than flipping the hunk back.
  const setDecision = (b: ChangeBlock, d: Decision) => {
    if (decisionOf(b) !== d) toggle(b);
  };

  const toggleEnabled = (b: ChangeBlock): boolean =>
    !manual || canToggle(resultText, b, decisionOf(b));

  // Syntax-highlight the editable result so the middle column reads like the two
  // side columns instead of flat monochrome text. The highlighted lines paint a
  // backdrop that the transparent-text textarea sits on top of (its caret and
  // selection stay live); scroll is mirrored from the textarea in its onScroll.
  const lang = useMemo(() => languageForPath(path), [path]);
  const resultLines = useMemo(() => resultText.split("\n"), [resultText]);
  const resultHtml = useMemo(() => resultLines.map((line) => highlight(line, lang)), [resultLines, lang]);

  // Which result lines currently belong to a change block — used to tint the
  // changed regions in the middle backdrop (the same blue as the mid ruler bars).
  // Located by context against the live buffer so it survives hand-edits and the
  // per-hunk toggles; a block that can't be uniquely located just isn't marked.
  const changedLines = useMemo(() => {
    const s = new Set<number>();
    for (const b of blocks) {
      const loc = locateBlock(resultLines, b, decisionOf(b));
      if (loc) for (let k = 0; k < loc.len; k++) s.add(loc.start + k);
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, resultLines, decisions]);

  // Proportional scroll-sync across the three panes (content heights differ, so
  // this is by ratio, not line-for-line). Feedback is suppressed by *echo
  // matching*, not a time-based guard: assigning `scrollTop` fires the target's
  // own `scroll` event on a LATER frame, so an rAF-cleared "syncing" flag has
  // usually already reset by the time that echo lands — and if the echo hits a
  // short pane sitting near its top, its ratio reads ~0 and slams every pane back
  // to the top (the "jumps to top" bug). Instead we remember the exact scrollTop
  // we drove each pane to; when that pane reports a scroll matching it (±1px for
  // the browser's integer rounding), we know it's our own echo and ignore it.
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const midRef = useRef<HTMLTextAreaElement>(null);
  const midHlRef = useRef<HTMLDivElement>(null);
  const echo = useRef(new Map<HTMLElement, number>());
  const syncFrom = (src: HTMLElement) => {
    const expected = echo.current.get(src);
    if (expected != null && Math.abs(src.scrollTop - expected) <= 1) {
      // Our own programmatic scroll bouncing back — consume it, drive nothing.
      echo.current.delete(src);
      return;
    }
    const denom = src.scrollHeight - src.clientHeight;
    const ratio = denom > 0 ? src.scrollTop / denom : 0;
    for (const el of [leftRef.current, rightRef.current, midRef.current]) {
      if (!el || el === src) continue;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) continue;
      const target = ratio * max;
      echo.current.set(el, target);
      el.scrollTop = target;
    }
  };

  // Snap every pane to a change block: place its start row a few lines below the
  // top so there is a little leading context. Row-fraction based, matching the
  // ruler and the proportional scroll-sync, and driven instantly (echo-matched)
  // so it doesn't fight the sync loop.
  const scrollToBlock = (b: ChangeBlock) => {
    const total = rows.length || 1;
    const ratio = Math.max(0, b.startRow - 2) / total;
    for (const el of [leftRef.current, rightRef.current, midRef.current]) {
      if (!el) continue;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) continue;
      const target = ratio * max;
      echo.current.set(el, target);
      el.scrollTop = target;
    }
    if (midHlRef.current && midRef.current) {
      midHlRef.current.scrollTop = midRef.current.scrollTop;
    }
  };

  const revLabel = (c: GitCommit) => `${c.short}${c.is_head ? " (HEAD)" : ""} · ${c.subject}`;
  const options =
    history.length > 0
      ? history.map((c) => ({ value: c.hash, label: revLabel(c) }))
      : [{ value: "", label: t("compareView.noHistoryOption") }];
  const selected = history.find((c) => c.hash === rev);
  const loading = rev !== "" && oldText == null && error == null;

  return (
    <div className={`file-viewer-compare${syncMode ? " sync" : ""}`}>
      <div className="file-viewer-compare-bar">
        {syncMode ? (
          // Sync merge: left/right are fixed (local mirror vs remote host), so
          // there is no commit to pick — just name the two sides.
          <span className="file-viewer-compare-label">
            {left!.title} ⇄ {rightTitle ?? t("compareView.currentFallback")}
          </span>
        ) : (
          <>
            <span className="file-viewer-compare-label">{t("compareView.compareAgainst")}</span>
            <Dropdown
              value={rev}
              options={options}
              onChange={setRev}
              className="file-viewer-compare-rev"
              title={t("compareView.pickCommitTitle")}
              placeholder={t("compareView.selectCommitPlaceholder")}
            />
            {selected && <span className="file-viewer-compare-date">{selected.date}</span>}
          </>
        )}
        {syncMode && <UntestedTag id="compareView.1" />}
        <div className="file-viewer-compare-bar-gap" />
        {syncMode ? (
          // Sync merge: name the two sides by what they are (local mirror vs
          // remote host), and order the buttons left→right to match the columns
          // — left column (Local) first, right column (Remote) second.
          <>
            <button
              className="file-viewer-format-btn file-viewer-compare-take-all local"
              onClick={() => setAll("reject")}
              disabled={blocks.length === 0}
              title={t("compareView.takeAllLocalTitle")}
            >
              {t("compareView.takeAllLocal")}
            </button>
            <button
              className="file-viewer-format-btn file-viewer-compare-take-all remote"
              onClick={() => setAll("accept")}
              disabled={blocks.length === 0}
              title={t("compareView.takeAllRemoteTitle")}
            >
              {t("compareView.takeAllRemote")}
            </button>
          </>
        ) : (
          <>
            <button
              className="file-viewer-format-btn"
              onClick={() => setAll("accept")}
              disabled={blocks.length === 0}
              title={t("compareView.acceptAllTitle")}
            >
              {t("compareView.acceptAll")}
            </button>
            <button
              className="file-viewer-format-btn"
              onClick={() => setAll("reject")}
              disabled={blocks.length === 0}
              title={t("compareView.rejectAllTitle")}
            >
              {t("compareView.rejectAll")}
            </button>
          </>
        )}
        {onApply && (
          <button
            className="file-viewer-format-btn file-viewer-compare-apply"
            onClick={() => onApply(resultText)}
            title={syncMode ? t("compareView.applyTitleSync") : t("compareView.applyTitleGit")}
          >
            {applyLabel ?? t("compareView.applyToFile")}
          </button>
        )}
        <button className="file-viewer-format-btn" onClick={onClose} title={t("compareView.closeTitle")}>
          {t("common.close")}
        </button>
      </div>

      {error != null ? (
        <div className="file-viewer-error">{error}</div>
      ) : loading ? (
        <div className="file-viewer-loading">{t("compareView.loadingVersion")}</div>
      ) : (
        <div className="file-viewer-compare-cols">
          <SideColumn
            title={
              syncMode
                ? left!.title
                : selected
                  ? t("compareView.oldWithRev", { rev: selected.short })
                  : t("compareView.oldFallback")
            }
            rows={rows}
            side="left"
            path={path}
            scrollRef={leftRef}
            onScroll={(e) => syncFrom(e.currentTarget)}
            blocks={blocks}
            isActive={(b) => decisionOf(b) === "reject"}
            onTake={(b) => setDecision(b, "reject")}
            enabledOf={toggleEnabled}
            onJump={scrollToBlock}
            syncMode={syncMode}
          />

          <div className="file-viewer-compare-col file-viewer-compare-col-mid">
            <div className="file-viewer-compare-col-head">
              <span>{t("compareView.result")}</span>
              {blocks.length > 0 && (
                <div className="file-viewer-compare-chips">
                  {blocks.map((b, i) => {
                    const dec = decisionOf(b);
                    const enabled = toggleEnabled(b);
                    return (
                      <span
                        className={`file-viewer-compare-chip ${dec === "accept" ? "accept" : "reject"}${enabled ? "" : " disabled"}`}
                        key={b.id}
                        title={
                          enabled
                            ? dec === "accept"
                              ? t("compareView.chipKeptTitle")
                              : t("compareView.chipRevertedTitle")
                            : t("compareView.chipDisabledTitle")
                        }
                        onClick={() => {
                          scrollToBlock(b);
                          if (enabled) toggle(b);
                        }}
                      >
                        {dec === "accept" ? "✓" : <UndoIcon />} {i + 1}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="file-viewer-compare-result-wrap">
              <DiffRuler blocks={blocks} totalRows={rows.length} side="mid" onJump={scrollToBlock} />
              <div className="file-viewer-compare-result-hl" ref={midHlRef} aria-hidden="true">
                {resultLines.map((line, i) => {
                  const html = resultHtml[i];
                  const cls = `file-viewer-compare-hl-line${changedLines.has(i) ? " changed" : ""}`;
                  return html != null ? (
                    <div
                      className={cls}
                      key={i}
                      dangerouslySetInnerHTML={{ __html: html || "​" }}
                    />
                  ) : (
                    <div className={cls} key={i}>
                      {line || "​"}
                    </div>
                  );
                })}
              </div>
              <textarea
                ref={midRef}
                className="file-viewer-compare-result"
                value={resultText}
                spellCheck={false}
                onChange={(e) => {
                  setResultText(e.target.value);
                  setManual(true);
                }}
                onScroll={(e) => {
                  const ta = e.currentTarget;
                  if (midHlRef.current) {
                    midHlRef.current.scrollTop = ta.scrollTop;
                    midHlRef.current.scrollLeft = ta.scrollLeft;
                  }
                  syncFrom(ta);
                }}
              />
            </div>
          </div>

          <SideColumn
            title={rightTitle ?? t("compareView.currentEditor")}
            rows={rows}
            side="right"
            path={path}
            scrollRef={rightRef}
            onScroll={(e) => syncFrom(e.currentTarget)}
            blocks={blocks}
            isActive={(b) => decisionOf(b) === "accept"}
            onTake={(b) => setDecision(b, "accept")}
            enabledOf={toggleEnabled}
            onJump={scrollToBlock}
            syncMode={syncMode}
          />
        </div>
      )}
    </div>
  );
}
