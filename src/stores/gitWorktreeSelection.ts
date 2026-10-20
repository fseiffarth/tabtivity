import { create } from "zustand";

/**
 * The worktree each project's **git view** (`files/GitHistory`) has selected,
 * keyed by the repo root it shows. The "+" menu's agent entries start there
 * (`tabs/agentWorktrees`) instead of asking — the git view is where the user
 * already said which branch they are working on.
 *
 * A path is only ever a hint: the picker re-checks it against the live
 * worktree listing and falls back to the project root. No entry (or `null`)
 * means the git view shows the checkout the project itself is on.
 */
interface GitWorktreeSelectionState {
  byRoot: Record<string, string | null>;
  setSelected: (root: string, path: string | null) => void;
}

export const useGitWorktreeSelectionStore = create<GitWorktreeSelectionState>((set) => ({
  byRoot: {},
  setSelected: (root, path) =>
    set((s) => (s.byRoot[root] === path ? s : { byRoot: { ...s.byRoot, [root]: path } })),
}));
