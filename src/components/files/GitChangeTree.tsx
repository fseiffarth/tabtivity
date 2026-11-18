import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { gitWorktreeArgs, type GitWorktreeSelection } from "../../lib/gitWorktree";
import { useT } from "../../lib/i18n";
import { FolderIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";

export interface FileChange {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  needs_count?: boolean;
}

export type ChangeScope = "unstaged" | "staged" | "unpushed";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  added: number;
  deleted: number;
  binary: boolean;
  needs_count?: boolean;
  children: TreeNode[];
}

/**
 * Folds the flat `path → stats` list from `git_change_stats` into a directory
 * tree. Directory rows aggregate the line stats of everything beneath them; a
 * dir is binary only if every changed file under it is binary. Children are
 * sorted folders-first, then alphabetically — the order a file tree reads in.
 */
export function buildTree(changes: FileChange[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, added: 0, deleted: 0, binary: true, children: [] };

  for (const change of changes) {
    const parts = change.path.split("/").filter(Boolean);
    let node = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const last = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: acc,
          isDir: !last,
          added: 0,
          deleted: 0,
          binary: true,
          children: [],
        };
        node.children.push(child);
      }
      if (last) {
        child.isDir = false;
        child.added = change.added;
        child.deleted = change.deleted;
        child.binary = change.binary;
        child.needs_count = change.needs_count;
      }
      node = child;
    });
  }

  const fold = (n: TreeNode) => {
    if (!n.isDir) return;
    let added = 0;
    let deleted = 0;
    let allBinary = n.children.length > 0;
    for (const c of n.children) {
      fold(c);
      added += c.added;
      deleted += c.deleted;
      if (!c.binary) allBinary = false;
      if (c.needs_count) n.needs_count = true;
    }
    n.added = added;
    n.deleted = deleted;
    n.binary = allBinary;
    n.children.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
    );
  };
  fold(root);
  return root;
}

function Stat({ added, deleted, binary }: { added: number; deleted: number; binary: boolean }) {
  if (binary) return <span className="git-change-stat git-change-stat--bin">bin</span>;
  return (
    <span className="git-change-stat">
      {added > 0 && <span className="git-change-add">+{added}</span>}
      {deleted > 0 && <span className="git-change-del">-{deleted}</span>}
      {added === 0 && deleted === 0 && <span className="git-change-zero">0</span>}
    </span>
  );
}

function Row({
  node,
  depth,
  collapsed,
  toggle,
  actions,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  actions: (node: TreeNode) => React.ReactNode;
}) {
  const isCollapsed = collapsed.has(node.path);
  return (
    <>
      <div
        className={`git-change-row${node.isDir ? " is-dir" : ""}`}
        style={{ paddingLeft: 6 + depth * 13 }}
        onClick={node.isDir ? () => toggle(node.path) : undefined}
        role={node.isDir ? "button" : undefined}
        title={node.path}
        data-count-path={!node.isDir && node.needs_count ? node.path : undefined}
      >
        <span className="git-change-caret">{node.isDir ? (isCollapsed ? "▸" : "▾") : ""}</span>
        <span className="git-change-name">
          {node.isDir ? <><FolderIcon /> </> : null}
          {node.name}
        </span>
        {node.needs_count ? <span className="git-change-zero">—</span> : <Stat added={node.added} deleted={node.deleted} binary={node.binary} />}
        {!node.isDir && actions(node)}
      </div>
      {node.isDir &&
        !isCollapsed &&
        node.children.map((c) => (
          <Row key={c.path} node={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} actions={actions} />
        ))}
    </>
  );
}

interface Props {
  projectDir: string;
  scope: ChangeScope;
  worktree?: GitWorktreeSelection | null;
  onChanged?: () => void;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  comparisonCheckout?: string;
  comparisonHead?: string;
  comparisonTracking?: string;
}

/**
 * Click-opened, navigable folder tree of the files behind an Add/Commit/Push
 * action, each row annotated with its `+added / -deleted` line stats. Folders
 * collapse/expand on click; the parent owns open/close (Escape, outside-click).
 */
export function GitChangeTree({ projectDir, scope, worktree, onChanged, disabled, onBusy, comparisonCheckout, comparisonHead, comparisonTracking }: Props) {
  const t = useT();
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [revision, setRevision] = useState(0);
  const [counts, setCounts] = useState<Map<string, FileChange>>(new Map());
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  // The flyout is CSS-anchored to the action bar's right edge and grows left, so
  // when the file viewer is docked on the LEFT of the window it runs off the left
  // screen border. Measure the rendered box and shift it back on-screen (either
  // edge). We measure the box with its own shift cleared, so the correction is a
  // fixed reference and converges in one pass instead of chasing its transform.
  const treeRef = useRef<HTMLDivElement>(null);
  const [shiftX, setShiftX] = useState(0);

  useEffect(() => {
    let live = true;
    setChanges(null);
    setCounts(new Map());
    setDiff(null);
    setError(null);
    invoke<FileChange[]>("git_change_stats", {
      projectDir, ...gitWorktreeArgs(worktree), scope,
      ...(comparisonCheckout && comparisonHead && comparisonTracking ? {
        branchComparison: { checkout: comparisonCheckout, head: comparisonHead, tracking: comparisonTracking },
      } : {}),
    })
      .then((c) => live && setChanges(c))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [projectDir, scope, worktree, revision, comparisonCheckout, comparisonHead, comparisonTracking]);

  const tree = useMemo(() => changes && buildTree(changes.map((c) => counts.get(c.path) ?? c)), [changes, counts]);

  useEffect(() => {
    const el = treeRef.current;
    if (!changes?.some((c) => c.needs_count) || !el || typeof IntersectionObserver === "undefined") return;
    let live = true;
    let reading = false;
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const path = (entry.target as HTMLElement).dataset.countPath;
        if (!path) continue;
        if (entry.isIntersecting) visible.add(path);
        else visible.delete(path);
      }
      void readVisible();
    }, { root: el });
    async function readVisible() {
      if (reading) return;
      reading = true;
      while (live && visible.size) {
        const path = visible.values().next().value!;
        visible.delete(path);
        const rows = await invoke<FileChange[]>("git_change_stats", { projectDir, ...gitWorktreeArgs(worktree), scope: "untracked-count", relPath: path }).catch(() => []);
        if (live && rows?.[0]) setCounts((prev) => new Map(prev).set(path, rows[0]));
      }
      reading = false;
    }
    el.querySelectorAll("[data-count-path]").forEach((row) => observer.observe(row));
    return () => { live = false; observer.disconnect(); };
  }, [changes, collapsed, projectDir, worktree]);

  async function act(path: string, preview: boolean) {
    setBusy(true);
    if (!preview) onBusy?.(true);
    setError(null);
    try {
      const args = { projectDir, ...gitWorktreeArgs(worktree), relPath: path };
      if (preview) {
        const text = await invoke<string>("git_diff_file", { ...args, staged: true });
        setDiff({ path, text });
      } else {
        await invoke("git_add_path", { ...args, unstage: scope === "staged" });
        setRevision((n) => n + 1);
        onChanged?.();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      if (!preview) onBusy?.(false);
    }
  }

  // An older backend ignores the unstage/staged options on these commands.
  // Its rows predate needs_count and must only expose the original stats.
  const canEdit = scope !== "unpushed" && changes?.some((row) => typeof row.needs_count === "boolean");
  const actions = (node: TreeNode) => canEdit && <>
    {scope === "staged" && <button className="toolbar-btn" disabled={busy || disabled} onClick={() => void act(node.path, true)}>{t("gitChangeTree.diff")}</button>}
    <button className="toolbar-btn" disabled={busy || disabled} onClick={() => void act(node.path, false)}>
      {t(scope === "staged" ? "gitChangeTree.unstage" : "gitChangeTree.stage")}
    </button>
  </>;

  useLayoutEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    // Measure the NATURAL box with any prior shift removed, so the correction is
    // computed from a fixed reference and can't chase its own transform. (A real
    // browser folds the applied translateX into rect.left, so `rect − shiftX`
    // would also converge — but an env that does NOT reflect the transform into
    // layout, e.g. jsdom under test, makes that subtraction drift by `margin`
    // every render into an infinite loop. Clearing the transform first is stable
    // in both.)
    const prev = el.style.transform;
    el.style.transform = "none";
    const rect = el.getBoundingClientRect();
    el.style.transform = prev;
    const margin = 8;
    let dx = 0;
    if (rect.left < margin) dx = margin - rect.left; // clips left → push right
    else if (rect.right > window.innerWidth - margin)
      dx = window.innerWidth - margin - rect.right; // clips right → push left
    if (dx !== shiftX) setShiftX(dx);
  }, [tree, error, shiftX]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div
      ref={treeRef}
      className="git-change-tree"
      data-testid="git-change-tree"
      style={shiftX ? { transform: `translateX(${shiftX}px)` } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      {error && <div className="git-change-empty">{error}</div>}
      {canEdit && <UntestedTag id="gitSelectiveCommit" />}
      {!error && !tree && <div className="git-change-empty">{t("gitChangeTree.loading")}</div>}
      {tree && tree.children.length === 0 && (
        <div className="git-change-empty">{t("gitChangeTree.noChanges")}</div>
      )}
      {tree && tree.children.length > 0 && (
        <div className="git-change-rows menu-scroll-region">
          {tree.children.map((c) => (
            <Row key={c.path} node={c} depth={0} collapsed={collapsed} toggle={toggle} actions={actions} />
          ))}
          {diff && <section className="git-change-preview" ref={(el) => el?.scrollIntoView?.({ block: "nearest" })}>
            <strong>{diff.path}</strong>
            <pre>{diff.text || t("gitChangeTree.noChanges")}</pre>
          </section>}
        </div>
      )}
    </div>
  );
}
