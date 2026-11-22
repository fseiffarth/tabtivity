import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { gitWorktreeArgs, type GitWorktreeSelection } from "../../lib/gitWorktree";
import { useT } from "../../lib/i18n";
import { GIT_STATE_COLOR } from "../../lib/theme/gitColors";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, DiffIcon, FolderIcon, PageIcon } from "../common/icons/Icon";
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

/** Every folder path in a tree, for starting a long list folded. */
function dirPaths(node: TreeNode, out: string[] = []): string[] {
  for (const c of node.children) {
    if (c.isDir) {
      out.push(c.path);
      dirPaths(c, out);
    }
  }
  return out;
}

/** Past this many files a group opens with its folders folded, so one big
 *  untracked tree does not push the history a screen down. */
const FOLD_FOLDERS_OVER = 40;

/** The git state a change-list row stands for: its letter, word and colour. */
type GitState = "untracked" | "modified" | "staged" | "unpushed";
const GIT_LETTER: Record<GitState, string> = { untracked: "U", modified: "M", staged: "S", unpushed: "P" };
const GIT_WORD: Record<GitState, "fileTree.statusUntracked" | "fileTree.statusModified" | "fileTree.statusStaged" | "fileTree.statusUnpushed"> = {
  untracked: "fileTree.statusUntracked",
  modified: "fileTree.statusModified",
  staged: "fileTree.statusStaged",
  unpushed: "fileTree.statusUnpushed",
};

/** The `.sp-chip` letter of a git state: the letter in the state colour, the
 *  word as its title (the same letters the file tree shows). */
export function GitStateChip({ state }: { state: GitState }) {
  const t = useT();
  return (
    <span className="sp-chip" title={t(GIT_WORD[state])} style={{ color: GIT_STATE_COLOR[state] }}>
      {GIT_LETTER[state]}
    </span>
  );
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
  stateOf,
  toggleFor,
  extra,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  stateOf: (node: TreeNode) => GitState;
  toggleFor: (node: TreeNode) => React.ReactNode;
  extra: (node: TreeNode) => React.ReactNode;
}) {
  const isCollapsed = collapsed.has(node.path);
  return (
    <>
      <div
        className={`sp-row git-change-row${node.isDir ? " is-dir" : ""}`}
        onClick={node.isDir ? () => toggle(node.path) : undefined}
        role={node.isDir ? "button" : undefined}
        aria-expanded={node.isDir ? !isCollapsed : undefined}
        title={node.path}
        data-count-path={!node.isDir && node.needs_count ? node.path : undefined}
      >
        <span className="sp-row-state"><GitStateChip state={stateOf(node)} /></span>
        <span className="sp-row-act">
          {node.isDir
            ? <span className="git-change-caret">{isCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}</span>
            : toggleFor(node)}
        </span>
        <span className="sp-row-main" style={depth ? { paddingLeft: depth * 16 } : undefined}>
          <span className="git-change-icon">{node.isDir ? <FolderIcon /> : <PageIcon />}</span>
          <span className="sp-row-name">{node.name}</span>
        </span>
        <span className="sp-row-meta">
          {!node.isDir && extra(node)}
          {node.needs_count ? <span className="git-change-zero">—</span> : <Stat added={node.added} deleted={node.deleted} binary={node.binary} />}
        </span>
      </div>
      {node.isDir &&
        !isCollapsed &&
        node.children.map((c) => (
          <Row key={c.path} node={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} stateOf={stateOf} toggleFor={toggleFor} extra={extra} />
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
  /** Changes whenever the repo's status does: the list re-reads in place
   *  (no "Loading…" flash), so staging in one group shows in the other. */
  refreshKey?: string;
}

/**
 * The navigable folder tree of the files behind an Add/Commit/Push action, each
 * row a `.sp-row` with its git state chip, its stage toggle and its
 * `+added / -deleted` line stats. Folders fold on click. Shown inline in the
 * Git view, one per `GitChangeGroup`.
 */
export function GitChangeTree({ projectDir, scope, worktree, onChanged, disabled, onBusy, comparisonCheckout, comparisonHead, comparisonTracking, refreshKey }: Props) {
  const t = useT();
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [revision, setRevision] = useState(0);
  const [counts, setCounts] = useState<Map<string, FileChange>>(new Map());
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  // What the list is OF. A change here starts it over; a mere refresh of the
  // same list keeps the rows on screen until the new read lands.
  const identity = JSON.stringify([projectDir, scope, worktree?.site ?? "", worktree?.path ?? "", comparisonCheckout ?? "", comparisonHead ?? "", comparisonTracking ?? ""]);
  const identityRef = useRef<string | null>(null);
  const foldedOnce = useRef(false);

  useEffect(() => {
    let live = true;
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      foldedOnce.current = false;
      setChanges(null);
      setDiff(null);
    }
    setError(null);
    invoke<FileChange[]>("git_change_stats", {
      projectDir, ...gitWorktreeArgs(worktree), scope,
      ...(comparisonCheckout && comparisonHead && comparisonTracking ? {
        branchComparison: { checkout: comparisonCheckout, head: comparisonHead, tracking: comparisonTracking },
      } : {}),
    })
      .then((c) => {
        if (!live) return;
        setChanges(c);
        setCounts(new Map());
        if (!foldedOnce.current) {
          foldedOnce.current = true;
          if (c.length > FOLD_FOLDERS_OVER) setCollapsed(new Set(dirPaths(buildTree(c))));
        }
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [projectDir, scope, worktree, revision, comparisonCheckout, comparisonHead, comparisonTracking, refreshKey, identity]);

  const tree = useMemo(() => changes && buildTree(changes.map((c) => counts.get(c.path) ?? c)), [changes, counts]);
  // Untracked rows are the ones `git_change_stats` could not count yet.
  const untracked = useMemo(() => new Set((changes ?? []).filter((c) => c.needs_count).map((c) => c.path)), [changes]);

  useEffect(() => {
    const el = treeRef.current;
    if (!changes?.some((c) => c.needs_count) || !el || typeof IntersectionObserver === "undefined") return;
    let live = true;
    let reading = false;
    const visible = new Set<string>();
    // The implicit root: the panel's own scroller clips the rows, so only the
    // ones on screen count, wherever in the view the group sits.
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const path = (entry.target as HTMLElement).dataset.countPath;
        if (!path) continue;
        if (entry.isIntersecting) visible.add(path);
        else visible.delete(path);
      }
      void readVisible();
    });
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
  const stateOf = (node: TreeNode): GitState => {
    if (scope === "staged") return "staged";
    if (scope === "unpushed") return "unpushed";
    const all = (n: TreeNode): boolean => (n.isDir ? n.children.every(all) : untracked.has(n.path));
    return all(node) ? "untracked" : "modified";
  };
  // Column 2: the row's stage toggle, a box that is ticked once staged.
  const toggleFor = (node: TreeNode) => canEdit && (
    <button
      type="button"
      className={`git-stage-toggle${scope === "staged" ? " is-on" : ""}`}
      aria-pressed={scope === "staged"}
      aria-label={t(scope === "staged" ? "gitChangeTree.unstage" : "gitChangeTree.stage")}
      title={`${t(scope === "staged" ? "gitChangeTree.unstage" : "gitChangeTree.stage")}: ${node.path}`}
      disabled={busy || disabled}
      onClick={() => void act(node.path, false)}
    >
      {scope === "staged" && <CheckIcon />}
    </button>
  );
  const extra = (node: TreeNode) => canEdit && scope === "staged" && (
    <button
      type="button"
      className="btn-quiet git-change-diff"
      aria-label={t("gitChangeTree.diff")}
      title={t("gitChangeTree.diff")}
      disabled={busy || disabled}
      onClick={() => void act(node.path, true)}
    >
      <DiffIcon />
    </button>
  );

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div ref={treeRef} className="git-change-tree" data-testid="git-change-tree">
      {error && <p className="sp-note git-change-error">{error}</p>}
      {canEdit && <UntestedTag id="gitSelectiveCommit" />}
      {!error && !tree && <p className="sp-note">{t("gitChangeTree.loading")}</p>}
      {tree && tree.children.length === 0 && (
        <p className="sp-note">{t("gitChangeTree.noChanges")}</p>
      )}
      {tree && tree.children.length > 0 && (
        <div className="git-change-rows">
          {tree.children.map((c) => (
            <Row key={c.path} node={c} depth={0} collapsed={collapsed} toggle={toggle} stateOf={stateOf} toggleFor={toggleFor} extra={extra} />
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

/**
 * One group of the Git view's change list (Not staged, Staged, Outgoing): a
 * folding `.sp-head` over its `GitChangeTree`. A folded group does not read its
 * list at all, so folding is also how to keep a huge one off the git refresh.
 */
export function GitChangeGroup({ title, meta, ...tree }: Props & { title: string; meta?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="git-change-group" data-scope={tree.scope}>
      <button type="button" className="sp-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <span>{title}</span>
        {meta && <span className="sp-head-meta">{meta}</span>}
      </button>
      {open && <GitChangeTree {...tree} />}
    </section>
  );
}
