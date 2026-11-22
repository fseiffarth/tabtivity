/** Git working-state → theme token. The ONE map for every surface that paints
 *  a git status color (the tree's state chips, the git action bar's step dots)
 *  so the colors cannot drift between surfaces — and follow the theme: the light
 *  themes define their own --warning/--info, which hardcoded dark-palette hexes
 *  used to override.
 *
 *  Red is not here: `--danger` is for errors and destructive actions only
 *  (docs/files_panel_redesign_plan.md). Staged reads `--info`, not the accent,
 *  which the accent budget keeps for the active view, focus and the one primary
 *  action (docs/context/desktop_ui_system.md). */
export const GIT_STATE_COLOR: Record<string, string> = {
  modified: "var(--warning)", // tracked, unstaged working-tree change
  untracked: "var(--text-secondary)", // new, not yet tracked
  staged: "var(--info)", // staged, not committed
  unpushed: "var(--success)", // committed locally, not pushed
  ignored: "var(--text-muted)", // ignored by git
};
