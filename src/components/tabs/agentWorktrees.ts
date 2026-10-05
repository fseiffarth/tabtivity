/**
 * Agent tabs and git worktrees (#23, Phase 4's "agent-per-branch" half).
 *
 * Two things had to be true for an agent to *live* in a linked worktree, and
 * neither was.
 *
 * **Starting there.** Every "+" menu entry landed at the project root, so the
 * only way to put an agent in a worktree was to `cd` inside it — which Claude
 * then keyed its session history to, silently. `useAgentWorktreePicker` asks
 * *before* the spawn, and only when there is something to choose: a project
 * with no linked worktrees never sees the dialog.
 *
 * **Coming back there.** `loadFromLayout` reset every agent tab's cwd to the
 * project root, on purpose — a stale saved cwd after a project move/rename put
 * the agent in the wrong directory. That reset was also what broke resume for
 * a worktree agent: Claude keys its history by cwd, so `--resume <id>` run from
 * the root found no such session and the restored tab came up as a fresh
 * conversation. `restoredAgentCwd` keeps the one class of saved cwd that is
 * *derived from* the project root rather than remembered from an old one —
 * `<root>/.tabtivity/worktrees/<name>`, the single place a worktree may live
 * (`commands::git::WorktreeCtx::worktrees_root`) — and resets everything else
 * exactly as before. A moved project is still safe: `rename_project_dir` rewrites
 * the prefix, and a cwd under a *different* root fails the check and resets.
 *
 * The listing is always taken from the **mirror side** (`site: "mirror"`): for
 * a local project the site is ignored, and for a remote one this is a local git
 * call against the mirror rather than an SSH round trip a "+" click must never
 * cost. Local agents on a remote project have their cwd pinned to the mirror
 * root at spawn (`localTabCwd`), so the picker is only offered for local
 * projects; the remote/host side is Phase 3/4 work still deferred.
 */
import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { useDialogs } from "../common/PromptDialogs";
import type { TabEntry } from "../../stores/tabs";
import type { StaticMenuItem } from "./newTabItems";
import { buildCloudTabSpec, buildStaticTabSpec } from "./newTabItems";
import {
  agentWorktreeChoices,
  isAgentMenuKind,
  worktreeName,
  type GitWorktree,
} from "../../lib/agents/agentWorktrees";
import { cleanCloudTask, type CloudLaunch } from "../../lib/agents/cloudSessions";

/**
 * The tab payload for an agent started in a linked worktree `wt`: cwd there,
 * and named after the branch on both the tab and the agent's own session so
 * two Claudes on two branches can be told apart at a glance. Shared with the
 * phone's ＋ (`MobileBridgeHost`), which picks the worktree by opaque id.
 */
export function worktreeAgentSpec(
  item: StaticMenuItem,
  wt: GitWorktree,
  projectName: string,
  t: ReturnType<typeof useT>,
): Omit<TabEntry, "key"> {
  const branch = wt.branch || worktreeName(wt.path);
  const spec = buildStaticTabSpec(
    item,
    wt.path,
    projectName ? `${projectName} (${branch})` : branch,
    t,
  );
  return { ...spec, label: t("newTabMenu.agentWorktreeLabel", { agent: spec.label, branch }) };
}

/**
 * The "+" menus' worktree question, shared by `TabBar` and the popout's
 * `NewTabMenu` so the two cannot drift. `specFor` resolves a static agent
 * item to its full tab payload: the plain project-root spec when the project
 * has no linked worktrees (no dialog, no extra round trip visible), the
 * chosen worktree's spec otherwise, or `null` when the user dismissed the
 * question. `asking` is true while the dialog is up — a host menu that closes
 * on outside clicks must hold still for it.
 */
export function useAgentWorktreePicker({
  projectCwd,
  projectName,
  enabled,
}: {
  projectCwd: string;
  projectName: string;
  enabled: boolean;
}) {
  const t = useT();
  const { chooseOption, promptText, dialogs } = useDialogs();
  const [asking, setAsking] = useState(false);

  const specFor = useCallback(
    async (item: StaticMenuItem): Promise<Omit<TabEntry, "key"> | null> => {
      const rootSpec = () => buildStaticTabSpec(item, projectCwd, projectName, t);
      if (!enabled || !isAgentMenuKind(item.kind) || !projectCwd) return rootSpec();
      let choices: GitWorktree[] = [];
      try {
        const list = await invoke<GitWorktree[]>("git_worktree_list", {
          projectDir: projectCwd,
          site: "mirror",
        });
        choices = agentWorktreeChoices(list ?? []);
      } catch {
        // Not a repo, or git unavailable — the root is the only answer.
      }
      if (choices.length === 0) return rootSpec();
      setAsking(true);
      let picked: string | null;
      try {
        picked = await chooseOption({
          title: t("newTabMenu.worktreePickTitle", { agent: item.label }),
          body: t("newTabMenu.worktreePickBody"),
          options: choices.map((w) => ({
            id: w.path,
            label: w.is_main
              ? t("newTabMenu.worktreeMain")
              : worktreeName(w.path),
            detail: w.branch || t("newTabMenu.worktreeDetached"),
            hint: w.path,
            // Default to where the project itself is — the answer a click on
            // the old menu gave, and the safe one to Enter through.
            current: w.is_main,
          })),
          untested: "agentWorktrees.1",
        });
      } finally {
        setAsking(false);
      }
      if (picked === null) return null;
      const wt = choices.find((w) => w.path === picked);
      if (!wt || wt.is_main) return rootSpec();
      return worktreeAgentSpec(item, wt, projectName, t);
    },
    [chooseOption, enabled, projectCwd, projectName, t],
  );

  /** A cloud launch (the "+" menu's "Cloud session" fly-out): asks for the
   *  task first when the CLI takes it on its command line, `null` when that
   *  question is dismissed. Always at the project root — the vendor's sandbox
   *  clones the repository, so a local worktree has nothing to give it. */
  const cloudSpecFor = useCallback(
    async (item: StaticMenuItem, launch: CloudLaunch): Promise<Omit<TabEntry, "key"> | null> => {
      let task = "";
      if (launch.needsTask) {
        setAsking(true);
        let typed: string | null;
        try {
          typed = await promptText({
            title: t("newTabMenu.cloudTaskTitle", { agent: item.label }),
            body: t("newTabMenu.cloudTaskBody"),
            label: t("newTabMenu.cloudTaskLabel"),
            confirmLabel: t("newTabMenu.cloudTaskStart"),
            validate: (value) => (cleanCloudTask(value) ? null : t("newTabMenu.cloudTaskInvalid")),
          });
        } finally {
          setAsking(false);
        }
        const clean = cleanCloudTask(typed ?? undefined);
        if (!clean) return null;
        task = clean;
      }
      return buildCloudTabSpec(item, launch, task, projectCwd, t);
    },
    [projectCwd, promptText, t],
  );

  return { specFor, cloudSpecFor, dialogs, asking };
}
