import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Toggle } from "../common/Toggle";
import { invoke } from "@tauri-apps/api/core";
import { invokeTrusted } from "../../lib/execTrust";
import { listen } from "@tauri-apps/api/event";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { useDialogs } from "../common/PromptDialogs";
import { useTabsStore } from "../../stores/tabs";
import { useT, type TranslationKey } from "../../lib/i18n";
import { GitMergeBar, GitPullPanel, type MergeState } from "./GitPullPanel";
import { LockIcon, UnlockIcon, WarningIcon } from "../common/icons/Icon";
import { gitWorktreeArgs, type GitWorktreeSelection } from "../../lib/gitWorktree";
import { ErrorNote } from "../common/ErrorNote";
import { NAMES, storageKey } from "../../lib/brand";

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

interface GitBranch {
  name: string;
  is_current: boolean;
  is_remote: boolean;
  /** Configured upstream (`origin/main`); "" for none. Optional: an older backend. */
  upstream?: string;
  /** Against that upstream, as of the last fetch. */
  ahead?: number;
  behind?: number;
}

interface Worktree {
  path: string;
  branch: string;
  head: string;
  is_main: boolean;
  is_locked: boolean;
  /** git's own words for why — the whole content of a lock. */
  lock_reason: string;
  /** The admin entry survives but the checkout is gone; only `prune` clears it. */
  is_prunable: boolean;
  prunable_reason: string;
  is_bare: boolean;
  /** This worktree is the one Tabtivity is working in — never removable (#23 D4). */
  is_current: boolean;
}

/** The create form's fields. `branch` means different things per mode: an existing
 *  branch to check out, or the NEW branch's name — which is why the control has to
 *  swap between a dropdown and a text input (#23 B1). */
interface WorktreeForm {
  name: string;
  branch: string;
  newBranch: boolean;
  /** Only meaningful when `newBranch`: where the new branch starts. */
  startPoint: string;
}

/** A peer's HEAD as reported by the git-lockstep backend (#28n). */
type HeadRef =
  | { kind: "branch"; name: string; sha: string }
  | { kind: "detached"; sha: string }
  | { kind: "unborn" };

type LockstepStatus =
  | "synchronized"
  | "syncing"
  | "desynchronized"
  /** #28p D4: the SSH pool is cold, so nothing is known about the host — and, crucially,
   *  nothing is claimed. This used to render as a green "synchronized". */
  | "disconnected";

/** The files an initial pairing refused to overwrite (#28p D3). */
interface PairingConflict {
  /** True when the repo side is the local mirror, i.e. the files at risk are the host's. */
  sourceIsLocal: boolean;
  paths: string[];
}

/** One `refs/tabtivity/backup/*` safety ref (#28p D6). */
interface BackupRef {
  peer: "local" | "remote";
  refname: string;
  ts: number;
  branch: string;
  sha: string;
  subject: string;
}

/** Mirrors `services::git_peer::GitPeerState` (camelCase). */
interface GitPeerState {
  enabled: boolean;
  status: LockstepStatus;
  detail: string | null;
  localHead: HeadRef | null;
  remoteHead: HeadRef | null;
  lastSyncTs: number | null;
  localSubject: string | null;
  remoteSubject: string | null;
  pairingConflict: PairingConflict | null;
}

/** `<short sha> subject` for a peer's HEAD — shown so a Use-local/Use-remote choice is
 *  informed rather than blind (#28p D8). */
function headLabel(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  head: HeadRef | null,
  subject: string | null,
): string {
  if (!head || head.kind === "unborn") return "—";
  const sha = head.sha.slice(0, 7);
  const name = head.kind === "branch" ? head.name : t("gitHistory.detached");
  return subject ? `${name} ${sha} · ${subject}` : `${name} ${sha}`;
}

interface Props {
  projectDir: string;
  /** Project id — only supplied for SSH remote projects, enabling git lockstep (#28n). */
  projectId?: string;
  /** True for SSH remote projects (gates the lockstep UI). */
  remote?: boolean;
  /** The project whose git credentials a fetch uses — any project kind, unlike
   *  `projectId`; absent on a nested repo (its own remote, no provider token). */
  authProjectId?: string;
  /** Called after a checkout/reword so the parent can refresh git status. */
  onChanged?: () => void;
  /** Bumped by the parent to open the pull preview for the checked-out branch
   *  (the git bar's Pull button). 0 = never asked. */
  pullRequest?: number;
  onWorktreeChanged?: (selection: GitWorktreeSelection | null) => void;
  actionsBusy?: boolean;
  connected?: boolean;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * The one place a worktree may live for this project, derived from the **main
 * worktree's own path** in the listing rather than from `projectDir` — for a
 * remote project those are two different machines' paths, and the listing is
 * always the side the command actually ran on (#23 I2/I3).
 *
 * Mirrors `commands::git::WorktreeCtx::worktrees_root`; the backend re-derives
 * and enforces it, so this is a preview, never the gate.
 */
function worktreesRoot(worktrees: Worktree[]): string {
  const main = worktrees.find((w) => w.is_main);
  if (!main) return "";
  const root = main.path.replace(/[/\\]+$/, "");
  const sep = /^[a-zA-Z]:[\\/]/.test(root) || root.includes("\\") ? "\\" : "/";
  return `${root}${sep}${NAMES.projectDir}${sep}worktrees`;
}

function parseRefs(refs: string): string[] {
  return refs
    .split(",")
    .map((r) => r.trim().replace(/^HEAD -> /, ""))
    .filter((r) => r && r !== "HEAD");
}

// ── Commit graph layout ─────────────────────────────────────────────────────

/** Joins two comma-separated lane name lists, keeping order, dropping repeats. */
function joinNames(a: string | null, b: string[]): string | null {
  const out = a ? a.split(", ") : [];
  for (const n of b) if (!out.includes(n)) out.push(n);
  return out.length ? out.join(", ") : null;
}

const LANE_PALETTE = [
  "#58a6ff", "#3fb950", "#e3b341", "#bc8cff",
  "#39c5cf", "#f0883e", "#db61a2", "#f85149",
];
const laneColor = (i: number) => LANE_PALETTE[((i % LANE_PALETTE.length) + LANE_PALETTE.length) % LANE_PALETTE.length];

interface RowLayout {
  col: number;          // column of this commit's dot
  laneCount: number;    // lanes occupied at this row (for width)
  verticals: number[];  // lane indices passing straight through this row
  merges: number[];     // child lane indices (≠ col) merging into the dot from above
  topToDot: boolean;    // a lane arrives from above directly into the dot
  trunk: boolean;       // first parent continues straight down from the dot
  branches: number[];   // parent lane indices (≠ col) leaving the dot downward
  /** Branch names each lane carries entering this row (null: no ref names it
   *  in the loaded history, e.g. a merged-and-deleted branch). */
  laneNames: (string | null)[];
  dotName: string | null;           // this commit's lane, incl. its own refs; also the trunk's
  branchNames: (string | null)[];   // parallel to `branches`
}

/**
 * Assigns each commit a column and records the edges entering/leaving its row,
 * mirroring how `git log --graph` threads branches. Commits must be in the
 * newest-first order returned by git log. Lanes are kept positionally stable
 * (freed slots are reused, never compacted) so a branch keeps one column —
 * and therefore one colour — until it merges.
 */
function computeGraph(commits: GitCommit[]): RowLayout[] {
  const lanes: (string | null)[] = []; // hash each column is currently waiting for
  // Branch names per lane: a lane is named by the branch refs of the commits
  // on it, and the names flow down its first-parent line. A tip further down
  // the same line (`main` behind `feature`), or a first parent that is already
  // another lane's, joins that lane's name list from there on.
  const names: (string | null)[] = [];
  const indexOf = (h: string) => lanes.findIndex((l) => l === h);
  const alloc = (h: string) => {
    const empty = lanes.findIndex((l) => l === null);
    if (empty === -1) {
      lanes.push(h);
      return lanes.length - 1;
    }
    lanes[empty] = h;
    return empty;
  };

  const rows: RowLayout[] = [];
  for (const commit of commits) {
    let col = indexOf(commit.hash);
    const topToDot = col !== -1;
    if (col === -1) {
      col = alloc(commit.hash);
      names[col] = null;
    }
    const laneNames = lanes.map((_, i) => names[i] ?? null);
    const own = parseRefs(commit.refs).filter((r) => !r.startsWith("tag: "));
    const dotName = joinNames(laneNames[col], own);

    const merges: number[] = [];
    const verticals: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) {
        if (i !== col) merges.push(i);
      } else if (lanes[i] !== null) {
        verticals.push(i);
      }
    }

    const beforeLen = lanes.length;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) {
        lanes[i] = null;
        names[i] = null;
      }
    }

    let trunk = false;
    const branches: number[] = [];
    const branchNames: (string | null)[] = [];
    commit.parents.forEach((parent, idx) => {
      const existing = indexOf(parent);
      if (idx === 0 && existing === -1) {
        lanes[col] = parent; // first parent continues this commit's column
        names[col] = dotName;
        trunk = true;
      } else if (existing !== -1) {
        branches.push(existing); // parent already tracked → connect to its lane
        if (idx === 0) {
          // This commit's own line runs into that lane, so it carries both.
          names[existing] = joinNames(names[existing], dotName ? dotName.split(", ") : []);
          branchNames.push(dotName);
        } else {
          branchNames.push(names[existing] ?? null);
        }
      } else {
        const j = alloc(parent);
        names[j] = null; // a merged-in side line: named only if a ref sits on it
        branches.push(j);
        branchNames.push(null);
      }
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    names.length = lanes.length;

    rows.push({
      col,
      laneCount: Math.max(beforeLen, lanes.length, col + 1),
      verticals,
      merges,
      topToDot,
      trunk,
      branches,
      laneNames,
      dotName,
      branchNames,
    });
  }
  return rows;
}

const LANE_W = 14;
const GRAPH_ROW_H = 22;
const cx = (col: number) => col * LANE_W + LANE_W / 2;

/**
 * One graph line. Hovering it names the branch its lane carries: the 1.5px
 * stroke is too thin to aim at, so a wider transparent copy takes the hover,
 * and its `<title>` outranks the row's subject tooltip.
 */
function GraphEdge({ d, color, name }: { d: string; color: string; name: string | null }) {
  return (
    <g>
      {name && <title>{name}</title>}
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} />
      {name && <path d={d} fill="none" stroke="transparent" strokeWidth={6} pointerEvents="stroke" />}
    </g>
  );
}

function CommitGraphCell({
  row,
  height,
  lanes,
  head,
  tip,
}: {
  row: RowLayout;
  height: number;
  lanes: number;
  head: boolean;
  tip: boolean;
}) {
  const mid = height / 2;
  const width = lanes * LANE_W;
  const x = (c: number) => cx(c);
  const dotX = x(row.col);

  return (
    <svg className="git-graph-cell" width={width} height={height} style={{ flexShrink: 0 }} aria-hidden>
      {row.verticals.map((i) => (
        <GraphEdge key={`v${i}`} d={`M ${x(i)} 0 V ${height}`} color={laneColor(i)} name={row.laneNames[i]} />
      ))}
      {row.topToDot && (
        <GraphEdge d={`M ${dotX} 0 V ${mid}`} color={laneColor(row.col)} name={row.dotName} />
      )}
      {row.merges.map((i) => (
        <GraphEdge
          key={`m${i}`}
          d={`M ${x(i)} 0 C ${x(i)} ${mid} ${dotX} 0 ${dotX} ${mid}`}
          color={laneColor(i)}
          name={row.laneNames[i]}
        />
      ))}
      {row.trunk && (
        <GraphEdge d={`M ${dotX} ${mid} V ${height}`} color={laneColor(row.col)} name={row.dotName} />
      )}
      {row.branches.map((j, k) => (
        <GraphEdge
          key={`b${j}`}
          d={`M ${dotX} ${mid} C ${dotX} ${height} ${x(j)} ${mid} ${x(j)} ${height}`}
          color={laneColor(j)}
          name={row.branchNames[k]}
        />
      ))}
      <g>
        {row.dotName && <title>{row.dotName}</title>}
        {/* Branch tips get a hollow ring in their lane color so the heads stand
            out from ordinary commits along the same lane. */}
        {tip && (
          <circle cx={dotX} cy={mid} r={head ? 7 : 6} fill="none" stroke={laneColor(row.col)} strokeWidth={1.5} />
        )}
        <circle cx={dotX} cy={mid} r={head ? 4.5 : 3.5} fill={laneColor(row.col)} stroke="var(--bg-panel)" strokeWidth={head ? 1.5 : 1} />
      </g>
    </svg>
  );
}

const GRAPH_MODE_KEY = storageKey("gitHistoryGraph");

/**
 * How many commits one page of history is. The list used to ask for exactly this
 * many and stop there, which silently truncated any repo with a longer history;
 * it now pages the rest in as the bottom of the list comes into view.
 */
const COMMIT_PAGE = 100;

/** Most matches one commit search returns. */
const SEARCH_LIMIT = 200;

const LOCKSTEP_STATUS_KEY: Record<LockstepStatus, TranslationKey> = {
  synchronized: "gitHistory.statusSynchronized",
  syncing: "gitHistory.statusSyncing",
  desynchronized: "gitHistory.statusDesynchronized",
  disconnected: "gitHistory.statusDisconnected",
};

export function GitHistory(props: Props) {
  return <GitHistoryView key={props.projectDir} {...props} />;
}

function GitHistoryView({ projectDir, projectId, remote, authProjectId, onChanged, pullRequest, onWorktreeChanged, actionsBusy = false, connected = true }: Props) {
  const t = useT();
  // Every destructive git question below is asked in the panel's own dialog —
  // the native `confirm()` these used arrives themeless, titled with the page
  // origin, and (worse for a `reset --hard` warning that *lists paths*) collapses
  // to one unreadable line.
  const { promptText, confirmAction, dialogs } = useDialogs();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  /** A full page came back, so there is probably at least one more to fetch. */
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Cleared when a page fails, so the observer stops retrying on every scroll. */
  const [autoPage, setAutoPage] = useState(true);
  // Read inside `loadMore` rather than closed over, so paging never re-creates
  // (and re-fires) the callback the scroll sentinel is watching with.
  const commitsRef = useRef<GitCommit[]>([]);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLButtonElement | null>(null);
  /**
   * How many commits a plain refresh re-fetches. A reload after a commit, a
   * checkout or a lockstep sync would otherwise snap a history the user had
   * paged deep into back to its first page.
   */
  const loadedRef = useRef(COMMIT_PAGE);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [selectionSupported, setSelectionSupported] = useState<boolean | null>(null);
  const [worktreeSelection, setWorktreeSelection] = useState<GitWorktreeSelection | null>(null);
  const gitArgs = useMemo(() => gitWorktreeArgs(worktreeSelection), [worktreeSelection]);
  const contextVersion = useRef(0);
  // Git lockstep (#28n): only meaningful for SSH remote projects.
  const lockstepEligible = !!(remote && projectId);
  const [lockstep, setLockstep] = useState<GitPeerState | null>(null);
  const [lockstepBusy, setLockstepBusy] = useState(false);
  // #28p D6: null = the Backups list is closed.
  const [backups, setBackups] = useState<BackupRef[] | null>(null);
  const [wtForm, setWtForm] = useState<WorktreeForm | null>(null);
  // The pull preview: null = closed; `branch` null = the checked-out branch.
  const [pullTarget, setPullTarget] = useState<{ branch: string | null } | null>(null);
  const [mergeState, setMergeState] = useState<MergeState | null>(null);
  const [fetching, setFetching] = useState(false);
  /**
   * Which side's worktrees these are (#23 I2). For a remote project `projectDir`
   * is the **local mirror** while the repo of record is on the host, so resolving
   * this from the directory alone created host worktrees at mirror-shaped paths
   * and left the mirror's own repo unmanageable. Defaults to the host, which is
   * what the rest of this panel reflects. Meaningless (and hidden) for a local
   * project, where there is only one side.
   */
  const [wtSite, setWtSite] = useState<"host" | "mirror">("host");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GitCommit | null>(null);
  // Commit search: the backend scans the whole history, not just the pages
  // loaded so far. `results` is null while no search is active.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GitCommit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [graphMode, setGraphMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GRAPH_MODE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggleGraphMode = useCallback(() => {
    setGraphMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(GRAPH_MODE_KEY, next ? "1" : "0");
      } catch {
        /* ignore storage failures */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let live = true;
    invoke<boolean>("git_worktree_selection_supported")
      .then((supported) => { if (live) setSelectionSupported(supported === true); })
      .catch(() => { if (live) setSelectionSupported(false); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    onWorktreeChanged?.(worktreeSelection);
  }, [onWorktreeChanged, worktreeSelection]);

  const selectWorktree = (wt: Worktree) => {
    if (!selectionSupported || loading || fetching || actionsBusy || !connected || wt.is_prunable || wt.is_bare) return;
    setWorktreeSelection(wtSite === "host" && wt.is_current ? null : { path: wt.path, site: wtSite });
  };

  const load = useCallback(async () => {
    if (!projectDir || !connected) {
      ++contextVersion.current;
      setLoading(false);
      return;
    }
    const version = ++contextVersion.current;
    setLoading(true);
    setError(null);
    // `allSettled`, not `all`: these are three independent reads, and one of them
    // rejecting used to reject the whole batch — so a git build that does not know
    // `git_worktree_list`, or a worktree probe that failed on its own, blanked the
    // commit list and the branch pills too. Each result now stands or falls alone
    // and only the failures are reported.
    const want = loadedRef.current;
    const [log, br, wt, ms] = await Promise.allSettled([
      invoke<GitCommit[]>("git_log", { projectDir, ...gitArgs, limit: want, skip: 0 }),
      invoke<GitBranch[]>("git_branches", { projectDir, ...gitArgs }),
      invoke<Worktree[]>("git_worktree_list", { projectDir, site: wtSite }),
      invoke<MergeState>("git_merge_state", { projectDir, ...gitArgs }),
    ]);
    if (version !== contextVersion.current) return;
    // Best-effort and not reported: a backend without the command just never
    // shows the merge bar.
    setMergeState(ms.status === "fulfilled" ? ms.value : null);
    if (log.status === "fulfilled") {
      const list = log.value ?? [];
      setCommits(list);
      setHasMore(list.length >= want);
      setAutoPage(true);
    }
    if (br.status === "fulfilled") setBranches(br.value ?? []);
    if (wt.status === "fulfilled") {
      const list = wt.value ?? [];
      setWorktrees(list);
      if (worktreeSelection?.path && !list.some((w) => w.path === worktreeSelection.path && !w.is_prunable && !w.is_bare)) {
        setWorktreeSelection(wtSite === "mirror" ? { path: "", site: "mirror" } : null);
      } else if (worktreeSelection && !worktreeSelection.path) {
        const current = list.find((w) => w.is_current && !w.is_prunable && !w.is_bare);
        if (current) setWorktreeSelection({ path: current.path, site: wtSite });
      }
    }
    const failed = [log, br, wt].filter((r) => r.status === "rejected");
    setError(failed.length ? String((failed[0] as PromiseRejectedResult).reason) : null);
    setLoading(false);
  }, [projectDir, wtSite, gitArgs, connected, worktreeSelection]);

  // Back to one page when the project changes, so a small repo opened after a big
  // one does not re-ask for the big one's page depth. Declared *before* the load
  // effect: effects run in order, and `load` reads this depth when it is called.
  useEffect(() => {
    ++contextVersion.current;
    setCommits([]);
    commitsRef.current = [];
    setBranches([]);
    setSelected(null);
    setResults(null);
    setQuery("");
    setPullTarget(null);
    setMergeState(null);
    loadedRef.current = COMMIT_PAGE;
    setHasMore(false);
    setAutoPage(true);
  }, [projectDir, gitArgs]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    commitsRef.current = commits;
  }, [commits]);

  // Debounced search. A stale answer (the query moved on, or the project
  // changed) is dropped so results never show under the wrong text.
  useEffect(() => {
    const q = query.trim();
    if (!projectDir || !connected || !q) {
      setResults(null);
      setSearching(false);
      return;
    }
    let live = true;
    setSearching(true);
    const timer = setTimeout(() => {
      invoke<GitCommit[]>("git_log_search", { projectDir, ...gitArgs, query: q, limit: SEARCH_LIMIT })
        .then((r) => {
          if (live) setResults(r ?? []);
        })
        .catch((e) => {
          if (live) {
            setResults([]);
            setError(String(e));
          }
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, projectDir, commits, gitArgs, connected]);

  const loadMore = useCallback(async () => {
    if (!projectDir || !connected || loadingMoreRef.current) return;
    const version = contextVersion.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const skip = commitsRef.current.length;
      const more = await invoke<GitCommit[]>("git_log", {
        projectDir,
        ...gitArgs,
        limit: COMMIT_PAGE,
        skip,
      });
      if (version !== contextVersion.current) return;
      const page = more ?? [];
      // A commit landing between two pages shifts every later one down by a row,
      // which `--skip` would hand us twice; hashes settle it.
      setCommits((prev) => {
        const seen = new Set(prev.map((c) => c.hash));
        const next = [...prev, ...page.filter((c) => !seen.has(c.hash))];
        loadedRef.current = Math.max(loadedRef.current, next.length);
        return next;
      });
      setHasMore(page.length >= COMMIT_PAGE);
    } catch (e) {
      if (version !== contextVersion.current) return;
      setError(String(e));
      // Stop the observer re-firing against a backend that just refused — the
      // row stays, and clicking it arms the automatic paging again.
      setAutoPage(false);
    } finally {
      setLoadingMore(false);
      loadingMoreRef.current = false;
    }
  }, [projectDir, gitArgs, connected]);

  // Page the next chunk in when the end of the list comes into view. `root: null`
  // because the scroller is an ancestor (the side panel's body), and an observer
  // against the viewport already accounts for every clipping ancestor — which is
  // also what keeps it quiet in a hidden pane. Re-armed on each page: an observer
  // reports a *change*, so a sentinel still on screen after the new rows mount
  // would never fire again and the list would stall one page in.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || !autoPage || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, autoPage, loadMore, commits.length]);

  // Load git-lockstep status + subscribe to backend status pushes (#28n).
  useEffect(() => {
    if (!lockstepEligible || !projectId || !connected) {
      setLockstep(null);
      return;
    }
    let alive = true;
    invoke<GitPeerState>("git_peer_status", { projectId })
      .then((s) => alive && setLockstep(s))
      .catch(() => {});
    const un = listen<{ projectId: string; state: GitPeerState }>("git-peer-status", (e) => {
      if (alive && e.payload.projectId === projectId) setLockstep(e.payload.state);
    });
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, [lockstepEligible, projectId, connected]);

  const toggleLockstep = useCallback(async () => {
    if (!projectId) return;
    setLockstepBusy(true);
    setError(null);
    try {
      const s = await invoke<GitPeerState>("git_peer_set_enabled", {
        projectId,
        enabled: !(lockstep?.enabled ?? false),
      });
      setLockstep(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setLockstepBusy(false);
    }
  }, [projectId, lockstep?.enabled]);

  const lockstepSyncNow = useCallback(async () => {
    if (!projectId) return;
    setLockstepBusy(true);
    setError(null);
    try {
      const s = await invoke<GitPeerState>("git_peer_sync_now", { projectId });
      setLockstep(s);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setLockstepBusy(false);
    }
  }, [projectId, load]);

  // Use-local / Use-remote divergence resolution (#28n Phase 2): the chosen side
  // becomes authoritative and the loser's overwritten tips are backed up to
  // refs/tabtivity/backup/* before it is reset. Confirm first — it discards commits
  // on the losing side (recoverable only via those backup refs).
  const lockstepResolve = useCallback(
    async (authority: "local" | "remote") => {
      if (!projectId) return;
      const authorityLabel = t(
        authority === "local" ? "gitHistory.authorityLocal" : "gitHistory.authorityRemoteHost",
      );
      const other = t(
        authority === "local" ? "gitHistory.authorityRemoteHost" : "gitHistory.authorityLocalMirror",
      );
      const ok = await confirmAction({
        title: t("gitHistory.resolveTitle"),
        body: t("gitHistory.confirmResolve", { authority: authorityLabel, other }),
        confirmLabel: t("gitHistory.resolveAction", { authority: authorityLabel }),
        danger: true,
      });
      if (!ok) return;
      setLockstepBusy(true);
      setError(null);
      try {
        const s = await invoke<GitPeerState>("git_peer_resolve", {
          projectId,
          authority,
        });
        setLockstep(s);
        await load();
        onChanged?.();
      } catch (e) {
        setError(String(e));
      } finally {
        setLockstepBusy(false);
      }
    },
    [projectId, load, onChanged, t, confirmAction],
  );

  // #28p D3: pairing refused because the empty side holds files that differ from what
  // it would be reset to. `reset --hard` destroys those silently, so the overwrite only
  // happens on an explicit confirmation that has *named* them.
  const lockstepPairConfirm = useCallback(async () => {
    const conflict = lockstep?.pairingConflict;
    if (!projectId || !conflict) return;
    const side = t(
      conflict.sourceIsLocal ? "gitHistory.authorityRemoteHost" : "gitHistory.authorityLocalMirror",
    );
    const list = conflict.paths.slice(0, 10).join("\n  ");
    const more =
      conflict.paths.length > 10
        ? t("gitHistory.andMore", { count: conflict.paths.length - 10 })
        : "";
    const ok = await confirmAction({
      title: t("gitHistory.overwritePairDialogTitle"),
      body: t("gitHistory.confirmOverwritePair", {
        count: conflict.paths.length,
        side,
        list,
        more,
      }),
      confirmLabel: t("gitHistory.overwritePairAction"),
      danger: true,
    });
    if (!ok) return;
    setLockstepBusy(true);
    setError(null);
    try {
      const s = await invoke<GitPeerState>("git_peer_pair_confirm", { projectId });
      setLockstep(s);
      await load();
      onChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setLockstepBusy(false);
    }
  }, [projectId, lockstep?.pairingConflict, load, onChanged, t, confirmAction]);

  // #28p D6: the backup refs every resolve/restore creates were write-only — they
  // pinned objects forever and nothing could list or restore them, which also hollowed
  // out the "it's recoverable" promise of Use-local/Use-remote.
  const loadBackups = useCallback(async () => {
    if (!projectId) return;
    setLockstepBusy(true);
    setError(null);
    try {
      const list = await invoke<BackupRef[]>("git_peer_backups", { projectId });
      setBackups(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLockstepBusy(false);
    }
  }, [projectId]);

  const restoreBackup = useCallback(
    async (b: BackupRef) => {
      if (!projectId) return;
      const ok = await confirmAction({
        title: t("gitHistory.restoreDialogTitle"),
        body: t("gitHistory.confirmRestore", {
          peer: b.peer,
          branch: b.branch,
          sha: b.sha.slice(0, 7),
          subject: b.subject || t("gitHistory.noSubject"),
        }),
        confirmLabel: t("gitHistory.restoreAction"),
        danger: true,
      });
      if (!ok) return;
      setLockstepBusy(true);
      setError(null);
      try {
        const s = await invoke<GitPeerState>("git_peer_restore_backup", {
          projectId,
          peer: b.peer,
          refname: b.refname,
        });
        setLockstep(s);
        await loadBackups();
        await load();
        onChanged?.();
      } catch (e) {
        setError(String(e));
      } finally {
        setLockstepBusy(false);
      }
    },
    [projectId, load, loadBackups, onChanged, t, confirmAction],
  );

  // #28p D8: a genuine two-sided divergence used to offer only "pick a winner". Open a
  // local shell in the mirror instead — the peer's tip is already parked at
  // refs/tabtivity/peer/<branch> by the reconcile that detected the divergence, so the user
  // can merge or rebase with plain git and the next pass fast-forwards the host normally.
  const resolveInTerminal = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const mirror = await invoke<string>("git_peer_mirror_dir", { projectId });
      const branch =
        lockstep?.localHead?.kind === "branch" ? lockstep.localHead.name : undefined;
      useTabsStore.getState().addTab({
        label: "resolve",
        cmd: "",
        cwd: mirror,
        kind: "shell",
        // The mirror is a LOCAL working copy; a remote-located shell would cd into the
        // host tree, where the peer ref isn't.
        location: "local",
        initialInput: branch
          ? `git log --oneline --graph HEAD ${NAMES.gitRefPeer}/${branch}`
          : undefined,
      });
    } catch (e) {
      setError(String(e));
    }
  }, [projectId, lockstep?.localHead]);

  // The git bar's Pull button lives in the parent; it asks by bumping a counter.
  // Seeded with the value at mount, so a remount (view switch) does not replay
  // an old click.
  const seenPullRef = useRef(pullRequest);
  useEffect(() => {
    if (!pullRequest || pullRequest === seenPullRef.current) return;
    seenPullRef.current = pullRequest;
    setPullTarget({ branch: null });
  }, [pullRequest]);
  // A project switch closes a preview that belonged to the old repo.
  useEffect(() => {
    setPullTarget(null);
  }, [projectDir]);

  /** Update the tracking refs, so every branch's behind count is current. */
  async function fetchNow() {
    setFetching(true);
    setError(null);
    try {
      await invoke("git_fetch", { projectDir, ...gitArgs, projectId: authProjectId ?? null });
      await load();
      onChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setFetching(false);
    }
  }

  const afterPull = () => {
    void load();
    onChanged?.();
  };

  async function checkout(target: string) {
    setLoading(true);
    setError(null);
    try {
      // With git lockstep enabled, route through the coordinator so the paired
      // local mirror + remote host tree switch together (#28n). The Git UI here
      // reflects the host tree, so the host initiates.
      if (lockstepEligible && projectId && lockstep?.enabled && !worktreeSelection) {
        const s = await invoke<GitPeerState>("git_peer_checkout", {
          projectId,
          target,
          initiatingSide: "remote",
        });
        setLockstep(s);
      } else {
        await invoke("git_checkout", { projectDir, ...gitArgs, target });
      }
      setSelected(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  async function createWorktree() {
    if (!wtForm) return;
    setLoading(true);
    setError(null);
    try {
      await invoke("git_worktree_add", {
        projectDir,
        site: wtSite,
        // A NAME, not a path: the backend owns where a worktree lives (#23 I3).
        path: wtForm.name.trim() || wtForm.branch.trim(),
        branch: wtForm.branch.trim(),
        newBranch: wtForm.newBranch,
        startPoint: wtForm.newBranch ? wtForm.startPoint || null : null,
      });
      setWtForm(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  /**
   * Remove a worktree, asking first and naming what goes (#23 B2/B3).
   *
   * `git worktree remove` refuses a *dirty* tree but does **not** refuse on
   * **ignored** files — it deletes the tree wholesale, so a `node_modules`, a
   * `.venv` and a `.env` full of keys all go with it. There is no undo and no
   * trash, which is exactly why the sibling destructive actions in this file
   * (lockstep resolve, pairing overwrite, backup restore) all confirm first.
   *
   * `force` is a **count**: git answers a locked worktree with "use 'remove -f -f'
   * to override or unlock first" and exits 128 for a single `--force`. So a
   * refusal is re-offered at the next level rather than dead-ending — the state
   * that used to be escapable only from a terminal.
   */
  async function removeWorktree(wt: Worktree, force = 0) {
    if (force === 0) {
      const ok = await confirmAction({
        title: t("gitHistory.removeWorktreeDialogTitle"),
        body: t("gitHistory.confirmRemoveWorktree", { path: wt.path }),
        confirmLabel: t("common.remove"),
        danger: true,
      });
      if (!ok) return;
    }
    setLoading(true);
    setError(null);
    try {
      await invoke("git_worktree_remove", { projectDir, path: wt.path, force, site: wtSite });
      await load();
      onChanged?.();
    } catch (e) {
      const msg = String(e);
      setLoading(false);
      // git names its own escape in the failure. Offer exactly that one, once.
      const next = /use\s+'?remove\s+-f\s+-f|locked working tree/i.test(msg)
        ? 2
        : /use --force|use `--force`/i.test(msg)
          ? 1
          : 0;
      if (next > force) {
        const key =
          next === 2 ? "gitHistory.confirmForceRemoveLocked" : "gitHistory.confirmForceRemoveDirty";
        const forced = await confirmAction({
          title: t("gitHistory.removeWorktreeDialogTitle"),
          body: t(key, { path: wt.path }),
          confirmLabel: t("gitHistory.removeWorktreeForceAction"),
          danger: true,
        });
        if (forced) {
          await removeWorktree(wt, next);
          return;
        }
      }
      setError(msg);
    }
  }

  async function setWorktreeLock(wt: Worktree, lock: boolean) {
    setLoading(true);
    setError(null);
    try {
      if (lock) {
        // Empty is a legitimate answer — git locks without a reason — so the
        // dialog accepts a blank field; only dismissing it cancels.
        const reason = await promptText({
          title: t("gitHistory.lockDialogTitle"),
          body: t("gitHistory.lockReasonPrompt", { path: wt.path }),
          label: t("gitHistory.lockReasonLabel"),
          confirmLabel: t("gitHistory.lockWorktreeAction"),
          allowEmpty: true,
        });
        if (reason === null) {
          setLoading(false);
          return;
        }
        await invoke("git_worktree_lock", { projectDir, path: wt.path, reason, site: wtSite });
      } else {
        await invoke("git_worktree_unlock", { projectDir, path: wt.path, site: wtSite });
      }
      await load();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  /** Drop the administrative entries of worktrees whose checkout is gone. The
   *  command has existed since #23 landed and was never invoked from anywhere. */
  async function pruneWorktrees() {
    setLoading(true);
    setError(null);
    try {
      await invoke("git_worktree_prune", { projectDir, site: wtSite });
      await load();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  // The graph layout is computed regardless of view mode so the per-lane colors
  // can also tint the branch selector and the ref labels in list view; only the
  // SVG cell itself is gated on graphMode below.
  const graph = useMemo(() => computeGraph(commits), [commits]);
  const graphLanes = useMemo(
    () => graph.reduce((max, r) => Math.max(max, r.laneCount), 1),
    [graph],
  );

  // Map each ref (branch tip / remote / tag) to the color of the lane its commit
  // occupies in the graph, so a branch wears one consistent color everywhere it
  // appears: the selector pill, its ref label, and its lane in the graph. Tag
  // refs ("tag: …") are skipped — only branch heads get a color. First write wins
  // when several refs share a commit (they share the lane anyway).
  const branchColor = useMemo(() => {
    const m = new Map<string, string>();
    commits.forEach((c, i) => {
      const col = graph[i]?.col;
      if (col == null) return;
      for (const r of parseRefs(c.refs)) {
        if (r.startsWith("tag: ") || m.has(r)) continue;
        m.set(r, laneColor(col));
      }
    });
    return m;
  }, [commits, graph]);

  // While a search is active the list shows its matches instead of the paged
  // history, without the graph (filtered rows lose their parents).
  const searchActive = query.trim() !== "" && results !== null;
  const shown = searchActive ? results : commits;

  const selectedWorktree = worktreeSelection?.path
    ? worktrees.find((wt) => wt.path === worktreeSelection.path)
    : worktrees.find((wt) => wt.is_current);
  const current = branches.find((b) => b.is_current)?.name;
  const localBranches = branches.filter((b) => !b.is_remote);
  const remoteBranches = branches.filter((b) => b.is_remote);
  const currentBranch = current;

  // A branch already checked out anywhere — the main worktree included — cannot be
  // checked out again: git answers `'x' is already used by worktree at '…'`. Offering
  // it was a guaranteed failure one click away. `Worktree.branch` and `GitBranch.name`
  // are the same string space, so this is an exact match, not a heuristic.
  const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));
  const addableBranches = localBranches.filter((b) => !checkedOut.has(b.name));
  const wtRoot = worktreesRoot(worktrees);

  if (!projectDir) {
    return <div className="file-tree-empty">{t("common.noProjectSelected")}</div>;
  }

  return (
    <div className="git-history">
      {dialogs}
      <div className="git-worktree-context" title={t("gitHistory.selectedWorktree", { name: selectedWorktree?.path ?? projectDir })}>
        <span>{t("gitHistory.selectedWorktree", { name: basename(selectedWorktree?.path ?? projectDir) })}</span>
        {remote && <span>{t(wtSite === "host" ? "gitHistory.worktreeSiteHost" : "gitHistory.worktreeSiteMirror")}</span>}
        <UntestedTag id="gitHistory.worktreeSelection" />
      </div>
      <div className="git-history-toolbar">
        <span className="git-history-branch" title={t("gitHistory.currentBranchTitle")}>
          ⎇ {current ?? t("gitHistory.detached")}
        </span>
        <button
          className={`toolbar-btn git-history-mode${graphMode ? " active" : ""}`}
          onClick={toggleGraphMode}
          aria-pressed={graphMode}
          title={t(graphMode ? "gitHistory.switchToListView" : "gitHistory.switchToGraphView")}
        >
          {t(graphMode ? "gitHistory.graphModeGraph" : "gitHistory.graphModeList")}
        </button>
        <button
          className="toolbar-btn git-history-mode"
          onClick={() => void fetchNow()}
          title={t("gitPull.fetchTitle")}
          disabled={loading || fetching || actionsBusy || !connected}
        >
          {fetching ? t("gitPull.fetchingShort") : t("gitPull.fetch")}
        </button>
        <button className="toolbar-btn git-history-refresh" onClick={load} title={t("common.refresh")} disabled={loading || actionsBusy || !connected}>
          ⟳
        </button>
      </div>

      {mergeState?.merging && (
        <GitMergeBar projectDir={projectDir} worktree={worktreeSelection} state={mergeState} canOpenFiles={!remote || (wtSite === "mirror" && !!worktreeSelection?.path)} onChanged={afterPull} />
      )}
      {pullTarget && !mergeState?.merging && (
        <GitPullPanel
          key={`${projectDir}:${worktreeSelection?.path ?? ""}:${wtSite}:${pullTarget.branch ?? ""}`}
          projectDir={projectDir}
          worktree={worktreeSelection}
          projectId={authProjectId ?? null}
          branch={pullTarget.branch}
          canOpenFiles={!remote || (wtSite === "mirror" && !!worktreeSelection?.path)}
          onClose={() => setPullTarget(null)}
          onDone={afterPull}
        />
      )}

      {lockstepEligible && !worktreeSelection && (
        <div className="git-lockstep-bar" style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 6px", borderBottom: "1px solid var(--border-color)", fontSize: 10 }}>
          <button
            className={`toolbar-btn${lockstep?.enabled ? " active" : ""}`}
            onClick={toggleLockstep}
            disabled={lockstepBusy}
            aria-pressed={!!lockstep?.enabled}
            title={t(lockstep?.enabled ? "gitHistory.lockstepOnTitle" : "gitHistory.lockstepOffTitle")}
          >
            {t("gitHistory.lockstepLabel")} {t(lockstep?.enabled ? "gitHistory.on" : "gitHistory.off")}
          </button>
          {lockstep?.enabled && (
            <>
              <span
                title={lockstep.detail ?? undefined}
                style={{
                  padding: "1px 6px",
                  borderRadius: "var(--radius)",
                  color: "var(--accent-contrast)",
                  background:
                    lockstep.status === "synchronized"
                      ? "var(--success)"
                      : lockstep.status === "syncing"
                        ? "var(--warning)"
                        : lockstep.status === "disconnected"
                          ? "var(--text-muted)"
                          : "var(--danger)",
                }}
              >
                {t(LOCKSTEP_STATUS_KEY[lockstep.status])}
              </span>
              <button
                className="toolbar-btn"
                onClick={lockstepSyncNow}
                // Nothing to sync against without a connection — the button would only
                // produce another "disconnected" (#28p D4).
                disabled={lockstepBusy || lockstep.status === "disconnected"}
                title={t(
                  lockstep.status === "disconnected"
                    ? "gitHistory.syncDisabledTitle"
                    : "gitHistory.syncNowTitle",
                )}
              >
                {t(lockstep.status === "desynchronized" ? "gitHistory.retry" : "gitHistory.syncNow")}
              </button>
              {lockstep.status === "desynchronized" && lockstep.pairingConflict ? (
                // Pairing was refused: the ONLY action offered is the one that names what
                // it would destroy (#28p D3) — Use-local/Use-remote would be meaningless
                // here (there is nothing paired yet to pick a winner between).
                <button
                  className="toolbar-btn"
                  onClick={lockstepPairConfirm}
                  disabled={lockstepBusy}
                  title={t("gitHistory.overwritePairTitle", {
                    side: t(lockstep.pairingConflict.sourceIsLocal ? "gitHistory.host" : "gitHistory.mirror"),
                  })}
                >
                  {t("gitHistory.overwriteAndPair", { count: lockstep.pairingConflict.paths.length })}
                </button>
              ) : (
                lockstep.status === "desynchronized" && (
                  <>
                    <button
                      className="toolbar-btn"
                      onClick={() => lockstepResolve("local")}
                      disabled={lockstepBusy}
                      title={t("gitHistory.useLocalTitle")}
                    >
                      {t("gitHistory.useLocal")}
                    </button>
                    <button
                      className="toolbar-btn"
                      onClick={() => lockstepResolve("remote")}
                      disabled={lockstepBusy}
                      title={t("gitHistory.useRemoteTitle")}
                    >
                      {t("gitHistory.useRemote")}
                    </button>
                    <button
                      className="toolbar-btn"
                      onClick={resolveInTerminal}
                      disabled={lockstepBusy}
                      title={t("gitHistory.resolveInTerminalTitle")}
                    >
                      {t("gitHistory.resolveInTerminal")}
                    </button>
                  </>
                )
              )}
              <button
                className="toolbar-btn"
                onClick={() => (backups ? setBackups(null) : loadBackups())}
                disabled={lockstepBusy || lockstep.status === "disconnected"}
                aria-pressed={!!backups}
                title={t("gitHistory.backupsTitle")}
              >
                {t("gitHistory.backups")}
              </button>
              {lockstep.status === "desynchronized" && lockstep.detail && (
                <span style={{ color: "var(--danger)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={lockstep.detail}>
                  {lockstep.detail}
                </span>
              )}
              {/* Both heads, so a Use-local/Use-remote choice is informed (#28p D8). */}
              {lockstep.status === "desynchronized" && !lockstep.pairingConflict && (
                <span style={{ marginLeft: "auto", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {t("gitHistory.localLabel")} {headLabel(t, lockstep.localHead, lockstep.localSubject)} ·{" "}
                  {t("gitHistory.remoteLabel")} {headLabel(t, lockstep.remoteHead, lockstep.remoteSubject)}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {lockstepEligible && !worktreeSelection && backups && (
        <div className="git-lockstep-backups" style={{ borderBottom: "1px solid var(--border-color)", padding: "3px 6px", fontSize: 10, maxHeight: 140, overflowY: "auto" }}>
          {backups.length === 0 ? (
            <div style={{ color: "var(--text-muted)" }}>{t("gitHistory.noBackupRefs")}</div>
          ) : (
            backups.map((b) => (
              <div key={`${b.peer}:${b.refname}`} style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 0" }}>
                <span style={{ color: "var(--text-muted)" }}>{b.peer}</span>
                <span>{b.branch}</span>
                <span style={{ color: "var(--text-muted)" }}>{b.sha.slice(0, 7)}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={b.subject}>
                  {b.subject}
                </span>
                <span style={{ color: "var(--text-muted)" }}>
                  {new Date(b.ts * 1000).toLocaleString()}
                </span>
                <button
                  className="toolbar-btn"
                  onClick={() => restoreBackup(b)}
                  disabled={lockstepBusy}
                  title={t("gitHistory.restoreTitle", { peer: b.peer, branch: b.branch })}
                >
                  {t("gitHistory.restore")}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {(localBranches.length > 0 || remoteBranches.length > 0) && (
        <div className="git-worktree-section">
          <div className="git-worktree-header"><span className="git-worktree-title">{t("gitHistory.branches")}</span></div>
          <div className="git-branch-list">
          {localBranches.map((b) => {
            const occupied = worktrees.find((wt) => wt.branch === b.name && wt.path !== selectedWorktree?.path);
            return (
            <button
              key={b.name}
              className={`git-branch-pill${b.is_current ? " current" : ""}${occupied ? " occupied" : ""}`}
              onClick={() => occupied ? selectWorktree(occupied) : !b.is_current && checkout(b.name)}
              disabled={loading || fetching || actionsBusy || !connected || b.is_current || !!occupied?.is_prunable || !!occupied?.is_bare || (!!occupied && !selectionSupported)}
              title={occupied
                ? t("gitHistory.openBranchWorktree", { name: b.name, worktree: basename(occupied.path) })
                : t(b.is_current ? "gitHistory.onBranchTitle" : "gitHistory.checkoutBranchTitle", { name: b.name })}
            >
              {branchColor.has(b.name) && (
                <span className="git-branch-dot" style={{ background: branchColor.get(b.name) }} aria-hidden />
              )}
              {b.name}{occupied ? " " : ""}
              {occupied && <span className="git-branch-worktree">{t("gitHistory.usedInWorktree", { name: basename(occupied.path) })}</span>}
            </button>
            );
          }).flatMap((pill, i) => {
            // A branch behind its upstream gets a pull chip right after its pill.
            const b = localBranches[i];
            if (!b.behind) return [pill];
            return [
              pill,
              <button
                key={`${b.name}:pull`}
                className="git-branch-pill git-branch-pull"
                onClick={() => setPullTarget({ branch: b.name })}
                disabled={loading || fetching || actionsBusy || !connected || !!mergeState?.merging || worktrees.some((wt) => wt.branch === b.name && wt.path !== selectedWorktree?.path)}
                title={t("gitPull.branchChipTitle", {
                  name: b.name,
                  upstream: b.upstream ?? "",
                  count: b.behind,
                })}
              >
                ↓{b.behind}
              </button>,
            ];
          })}
          {remoteBranches.map((b) => (
            <button
              key={b.name}
              className="git-branch-pill remote"
              onClick={() => checkout(b.name)}
              disabled={loading || fetching || actionsBusy || !connected}
              title={t("gitHistory.checkoutBranchTitle", { name: b.name })}
            >
              {branchColor.has(b.name) && (
                <span className="git-branch-dot" style={{ background: branchColor.get(b.name) }} aria-hidden />
              )}
              {b.name}
            </button>
          ))}
          </div>
        </div>
      )}

      <div className="git-worktree-section">
        <div className="git-worktree-header">
          <span className="git-worktree-title">{t("gitHistory.worktrees")}</span>
          <UntestedTag id="gitHistory.1" />
          {remote && (
            // #23 I2: two repos, two answers. `git_publish`'s "Publish from"
            // selector is the precedent — where the bytes are is not where the
            // operation runs, and for a remote project `projectDir` is the mirror.
            <Dropdown
              className="git-worktree-site"
              value={wtSite}
              title={t("gitHistory.worktreeSiteLabel")}
              onChange={(v) => {
                setWtForm(null);
                const site = v === "mirror" ? "mirror" : "host";
                setWorktrees([]);
                setWtSite(site);
                setWorktreeSelection(site === "mirror" ? { path: "", site } : null);
              }}
              disabled={!selectionSupported || loading || fetching || actionsBusy || !connected}
              options={[
                { value: "host", label: t("gitHistory.worktreeSiteHost") },
                { value: "mirror", label: t("gitHistory.worktreeSiteMirror") },
              ]}
            />
          )}
          <span className="git-worktree-spacer" />
          {worktrees.some((w) => w.is_prunable) && (
            <button
              className="toolbar-btn"
              onClick={pruneWorktrees}
              disabled={loading || actionsBusy || !connected}
              title={t("gitHistory.pruneWorktreesTitle")}
            >
              {t("gitHistory.pruneWorktrees")}
            </button>
          )}
          <button
            className="toolbar-btn"
            onClick={() =>
              setWtForm((f) =>
                f
                  ? null
                  : {
                      name: "",
                      branch: addableBranches[0]?.name ?? "",
                      newBranch: addableBranches.length === 0,
                      startPoint: "",
                    },
              )
            }
            disabled={loading || actionsBusy || !connected}
            title={t("gitHistory.addWorktreeTitle")}
          >
            {t(wtForm ? "gitHistory.cancel" : "gitHistory.addWorktree")}
          </button>
        </div>
        {lockstep?.enabled && (
          // #23 I5: `worktree add` does not route through the lockstep coordinator
          // the way `checkout` does, and a branch checked out in a worktree is one
          // lockstep will now refuse to move rather than corrupt (#23 D1).
          <div className="git-worktree-note">{t("gitHistory.worktreeLockstepNote")}</div>
        )}
        {selectionSupported === false && <div className="git-worktree-note">{t("gitHistory.worktreeBackendRequired")}</div>}
        {worktrees.length > 0 && (
          <div className="git-branch-list git-worktree-list">
            {worktrees.map((wt) => {
              const label = wt.branch || wt.head.slice(0, 7) || t("gitHistory.detached");
              const state = wt.is_prunable
                ? t("gitHistory.worktreeGone", {
                    reason: wt.prunable_reason || t("gitHistory.worktreeGoneReason"),
                  })
                : wt.is_locked
                  ? t("gitHistory.worktreeLocked", {
                      reason: wt.lock_reason || t("gitHistory.worktreeNoReason"),
                    })
                  : "";
              return (
                <span
                  key={wt.path}
                  className={
                    `git-branch-pill git-worktree-pill${wt.path === selectedWorktree?.path ? " current" : ""}` +
                    `${wt.is_prunable ? " prunable" : ""}`
                  }
                  title={state ? `${wt.path}\n${state}` : wt.path}
                >
                  {wt.is_locked && (
                    <span className="git-worktree-flag" aria-label={t("gitHistory.locked")}>
                      <LockIcon />
                    </span>
                  )}
                  {wt.is_prunable && (
                    <span className="git-worktree-flag" aria-label={t("gitHistory.prunable")}>
                      <WarningIcon />
                    </span>
                  )}
                  <button
                    className="git-worktree-select"
                    onClick={() => selectWorktree(wt)}
                    disabled={!selectionSupported || loading || fetching || actionsBusy || !connected || wt.is_prunable || wt.is_bare}
                    aria-pressed={wt.path === selectedWorktree?.path}
                    aria-label={t("gitHistory.selectWorktree", { name: basename(wt.path) })}
                  >
                    <span className="git-worktree-name">{basename(wt.path)}</span>
                    <span className="git-worktree-branch">⎇ {label}</span>
                    {wt.is_main && <span className="git-worktree-main">{t("gitHistory.mainWorktree")}</span>}
                  </button>
                  {!wt.is_main && (
                    <button
                      className="git-worktree-btn"
                      onClick={() => setWorktreeLock(wt, !wt.is_locked)}
                      disabled={loading || actionsBusy || !connected}
                      aria-label={t(
                        wt.is_locked ? "gitHistory.unlockWorktreeTitle" : "gitHistory.lockWorktreeTitle",
                        { path: wt.path },
                      )}
                      title={t(
                        wt.is_locked ? "gitHistory.unlockWorktreeTitle" : "gitHistory.lockWorktreeTitle",
                        { path: wt.path },
                      )}
                    >
                      {wt.is_locked ? <UnlockIcon /> : <LockIcon />}
                    </button>
                  )}
                  {/* `is_main` is not the question a Remove control has to answer:
                      git deletes the tree you are standing in without complaint
                      (#23 D4), and the backend refuses that separately. */}
                  {!wt.is_main && !wt.is_current && wt.path !== selectedWorktree?.path && (
                    <button
                      className="git-worktree-btn git-worktree-remove"
                      onClick={() => removeWorktree(wt)}
                      disabled={loading || actionsBusy || !connected}
                      aria-label={t("gitHistory.removeWorktreeTitle", { path: wt.path })}
                      title={t("gitHistory.removeWorktreeTitle", { path: wt.path })}
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {wtForm && (
          <div className="git-worktree-form">
            <label className="git-worktree-newbranch">
              <Toggle
                size="sm"
                checked={wtForm.newBranch}
                onChange={(e) =>
                  setWtForm({
                    ...wtForm,
                    newBranch: e.target.checked,
                    // The field means a different thing in each mode, so it is
                    // cleared rather than carried across: an existing branch name
                    // is precisely the one value `-b` can never accept.
                    branch: e.target.checked ? "" : (addableBranches[0]?.name ?? ""),
                    startPoint: e.target.checked ? (currentBranch || localBranches[0]?.name || "") : "",
                  })
                }
              />
              {t("gitHistory.newBranchLabel")}
            </label>
            {wtForm.newBranch ? (
              <>
                {/* B1: with the toggle on, this MUST be free text. It was a listbox
                    of existing branches, so `-b <existing>` was the only payload the
                    form could send and git always answered "already exists". */}
                <input
                  type="text"
                  className="git-worktree-input"
                  placeholder={t("gitHistory.newBranchPlaceholder")}
                  value={wtForm.branch}
                  onChange={(e) => setWtForm({ ...wtForm, branch: e.target.value })}
                  aria-label={t("gitHistory.newBranchPlaceholder")}
                />
                <Dropdown
                  value={wtForm.startPoint}
                  title={t("gitHistory.startPointLabel")}
                  onChange={(v) => setWtForm({ ...wtForm, startPoint: v })}
                  options={[...localBranches, ...remoteBranches].map((b) => ({
                    value: b.name,
                    label: b.name,
                  }))}
                  placeholder={t("gitHistory.startPointLabel")}
                />
              </>
            ) : (
              <Dropdown
                value={wtForm.branch}
                title={t("gitHistory.branchLabel")}
                onChange={(v) => setWtForm({ ...wtForm, branch: v })}
                options={addableBranches.map((b) => ({ value: b.name, label: b.name }))}
                placeholder={t("gitHistory.branchLabel")}
              />
            )}
            <input
              type="text"
              className="git-worktree-input"
              placeholder={t("gitHistory.worktreeNamePlaceholder")}
              value={wtForm.name}
              onChange={(e) => setWtForm({ ...wtForm, name: e.target.value })}
              aria-label={t("gitHistory.worktreeNamePlaceholder")}
            />
            <button
              className="toolbar-btn"
              onClick={createWorktree}
              disabled={loading || !wtForm.branch.trim()}
            >
              {t("gitHistory.create")}
            </button>
            {/* One legal location, so the path is shown rather than chosen. */}
            {wtRoot && (
              <div className="git-worktree-path" title={wtRoot}>
                {`${wtRoot}${wtRoot.includes("\\") ? "\\" : "/"}${
                  wtForm.name.trim() || wtForm.branch.trim() || "…"
                }`}
              </div>
            )}
            {!wtForm.newBranch && addableBranches.length === 0 && (
              <div className="git-worktree-note">{t("gitHistory.noBranchesToAdd")}</div>
            )}
          </div>
        )}
      </div>

      {error && <ErrorNote className="file-tree-error" error={error} />}
      {loading && commits.length === 0 && <div className="file-tree-loading">{t("common.loading")}</div>}
      {!loading && commits.length === 0 && !error && !query.trim() && (
        <div className="file-tree-empty">{t("gitHistory.noCommitsYet")}</div>
      )}

      <div className="git-commit-search">
        <input
          type="search"
          className="git-worktree-input"
          placeholder={t("gitHistory.searchPlaceholder")}
          aria-label={t("gitHistory.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        <UntestedTag id="gitHistory.search" />
      </div>
      {query.trim() && (
        <div className="git-commit-search-status" aria-live="polite">
          {searching || results === null
            ? t("gitHistory.searching")
            : results.length === 0
              ? t("gitHistory.searchNoMatches")
              : t(
                  results.length >= SEARCH_LIMIT
                    ? "gitHistory.searchCapped"
                    : "gitHistory.searchCount",
                  { n: results.length },
                )}
        </div>
      )}

      <div className={`git-commit-list${graphMode && !searchActive ? " graph" : ""}`}>
        {shown.map((c, i) => {
          const refs = parseRefs(c.refs);
          // A branch tip carries at least one non-tag ref; mark it in the graph.
          const isTip = refs.some((r) => !r.startsWith("tag: "));
          return (
            <button
              key={c.hash}
              className={`git-commit-row${c.is_head ? " head" : ""}`}
              onClick={() => setSelected(c)}
              title={c.subject}
            >
              {graphMode && !searchActive && (
                <CommitGraphCell
                  row={graph[i]}
                  height={GRAPH_ROW_H}
                  lanes={graphLanes}
                  head={c.is_head}
                  tip={isTip}
                />
              )}
              <span className="git-commit-hash">{c.short}</span>
              <span className="git-commit-subject">{c.subject}</span>
              {refs.map((r) => {
                const color = branchColor.get(r);
                return (
                  <span
                    key={r}
                    className="git-commit-ref"
                    style={color ? { background: color } : undefined}
                  >
                    {r}
                  </span>
                );
              })}
              <span className="git-commit-date">{c.date}</span>
            </button>
          );
        })}
        {/* The sentinel *is* the button (as in `BibCards`): scrolling to it pages
            the next chunk in, and clicking it does the same where there is no
            IntersectionObserver (jsdom) or where the pane is too short to ever
            scroll it into view. */}
        {hasMore && !searchActive && (
          <button
            ref={sentinelRef}
            className="git-commit-row git-commit-more"
            onClick={() => {
              setAutoPage(true);
              loadMore();
            }}
            disabled={loadingMore || !connected}
          >
            {loadingMore
              ? t("gitHistory.loadingMoreCommits")
              : t("gitHistory.loadMoreCommits")}
            <UntestedTag id="gitHistory.loadMoreCommits" />
          </button>
        )}
      </div>

      {selected && createPortal(
        <CommitWindow
          projectDir={projectDir}
          worktree={worktreeSelection}
          commit={selected}
          onClose={() => setSelected(null)}
          onCheckout={() => checkout(selected.hash)}
          onReworded={async () => {
            setSelected(null);
            await load();
            onChanged?.();
          }}
        />,
        document.body,
      )}
    </div>
  );
}

interface CommitWindowProps {
  projectDir: string;
  worktree?: GitWorktreeSelection | null;
  commit: GitCommit;
  onClose: () => void;
  onCheckout: () => void;
  onReworded: () => void;
}

function CommitWindow({ projectDir, worktree, commit, onClose, onCheckout, onReworded }: CommitWindowProps) {
  const t = useT();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<string>("git_commit_message", { projectDir, ...gitWorktreeArgs(worktree), hash: commit.hash })
      .then(setMessage)
      .catch((e) => setError(String(e)));
  }, [projectDir, worktree, commit.hash]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const msg = await invoke<string>("git_generate_commit_message", { projectDir, ...gitWorktreeArgs(worktree) });
      setMessage(msg);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reword() {
    setBusy(true);
    setError(null);
    try {
      await invokeTrusted("git_reword_head", { projectDir, ...gitWorktreeArgs(worktree), message });
      onReworded();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="commit-window" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{t("gitHistory.commitTitle", { short: commit.short })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="commit-window-meta">
          <span>{commit.author}</span>
          <span>·</span>
          <span>{commit.date}</span>
          {commit.is_head && <span className="git-commit-ref">HEAD</span>}
        </div>
        <textarea
          className="commit-window-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={8}
          readOnly={!commit.is_head}
          spellCheck={false}
        />
        {!commit.is_head && (
          <p className="settings-help">{t("gitHistory.onlyHeadReworded")}</p>
        )}
        {error && <ErrorNote className="settings-error" error={error} />}
        <div className="commit-window-actions">
          {commit.is_head && (
            <>
              <button type="button" disabled={busy} onClick={generate} title={t("gitHistory.generateTitle")}>
                {t("gitHistory.generateAgent")}
              </button>
              <button type="button" className="primary" disabled={busy || !message.trim()} onClick={reword}>
                {t("gitHistory.saveAmend")}
              </button>
            </>
          )}
          <button type="button" disabled={busy} onClick={onCheckout} title={t("gitHistory.checkoutCommitTitle")}>
            {t("gitHistory.checkout")}
          </button>
          <button type="button" onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
