/** A checkout on an explicit side of the project repository. */
export interface GitWorktreeSelection {
  path: string;
  site: "host" | "mirror";
}

/** Keep the default payload compatible with commands in older running binaries. */
export function gitWorktreeArgs(worktree?: GitWorktreeSelection | null): { worktree?: GitWorktreeSelection } {
  return worktree ? { worktree } : {};
}
