/**
 * Pure half of the agent-in-a-worktree story (#23) — see
 * `components/tabs/agentWorktrees.ts` for the why. Lives under `lib/` so the
 * tabs store can import it without pulling a component module (and the
 * store→component→store cycle that would make) into its graph.
 */
import type { TabKind } from "../../stores/tabs";
import { NAMES } from "../brand";

/** Mirrors `commands::git::Worktree` (serde field names). */
export interface GitWorktree {
  path: string;
  branch: string;
  head: string;
  is_main: boolean;
  is_locked: boolean;
  lock_reason: string;
  is_prunable: boolean;
  prunable_reason: string;
  is_bare: boolean;
  is_current: boolean;
}

/** The one place a worktree may live, relative to the project root. */
export const WORKTREES_SUBDIR = NAMES.worktreesDir;

function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, "");
}

/**
 * Is `cwd` a linked worktree of the project at `projectDir` — i.e. exactly one
 * directory under `<projectDir>/.tabtivity/worktrees/`? The name must be a single
 * plain segment: a `..` or an empty name is not a worktree, and neither is the
 * worktrees folder itself. Both separators are accepted so a Windows layout
 * round-trips.
 */
export function isProjectWorktreeCwd(cwd: string, projectDir: string): boolean {
  if (!cwd || !projectDir) return false;
  const root = stripTrailingSep(projectDir);
  if (!root) return false;
  const norm = (s: string) => s.replace(/\\/g, "/");
  const c = norm(stripTrailingSep(cwd));
  const prefix = `${norm(root)}/${WORKTREES_SUBDIR}/`;
  if (!c.startsWith(prefix)) return false;
  const name = c.slice(prefix.length);
  return name.length > 0 && !name.includes("/") && name !== "." && name !== "..";
}

/** A linked worktree's folder as the agents keep them: Tabtivity's own
 * (`.tabtivity/worktrees/<name>`), Claude Code's `--worktree` ones
 * (`.claude/worktrees/<name>`), or any other dot-folder's `worktrees`. */
const WORKTREE_IN_PATH = /[/\\]\.[^/\\]+[/\\]worktrees[/\\]([^/\\]+)/u;

/**
 * The name of the linked worktree `path` lies in, or undefined for a path that
 * is in none — read off the path alone, so it names what the agent's folder
 * is without asking git. The Reader's facts row shows it beside the path.
 */
export function worktreeOfPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const name = WORKTREE_IN_PATH.exec(path)?.[1];
  return name && name !== "." && name !== ".." ? name : undefined;
}

/** Same directory, modulo a trailing separator and separator style. */
function sameDir(a: string, b: string): boolean {
  const norm = (s: string) => stripTrailingSep(s).replace(/\\/g, "/");
  return norm(a).length > 0 && norm(a) === norm(b);
}

/**
 * The cwd a restored agent tab spawns in: its saved cwd when that is a place
 * the scope *derives* rather than remembers — a linked worktree under the
 * scope's own root, or (a box scope) one of the box's member roots or a
 * worktree under one, which is where the "+" menu's per-member Claude tab is
 * deliberately started — else the scope root. A cwd that is none of these is
 * a stale one from before a project move and resets, as before. Pure — the
 * seam `loadFromLayout` goes through; `agentRoots` is what the box restore
 * passes from `boxMembersOfScope`.
 */
export function restoredAgentCwd(
  savedCwd: string | undefined,
  defaultCwd: string,
  agentRoots: readonly string[] = [],
): string {
  if (!savedCwd) return defaultCwd;
  if (isProjectWorktreeCwd(savedCwd, defaultCwd)) return savedCwd;
  for (const root of agentRoots) {
    if (sameDir(savedCwd, root) || isProjectWorktreeCwd(savedCwd, root)) return savedCwd;
  }
  return defaultCwd;
}

/**
 * The worktrees an agent can be started in: bare entries have no checkout and
 * prunable ones have lost theirs. Main first, as git lists it. Returns an
 * empty list — "nothing to choose" — unless at least one *linked* worktree
 * survives the filter, so a project with only its main tree never sees the
 * dialog.
 */
export function agentWorktreeChoices(list: GitWorktree[]): GitWorktree[] {
  const usable = list.filter((w) => !w.is_bare && !w.is_prunable);
  return usable.some((w) => !w.is_main) ? usable : [];
}

/** The tab kinds the question applies to. */
export function isAgentMenuKind(kind: TabKind): boolean {
  return kind === "agent" || kind === "local_agent";
}

/** The trailing path segment — what a worktree is *called* in the listing. */
export function worktreeName(path: string): string {
  const parts = stripTrailingSep(path).split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}
