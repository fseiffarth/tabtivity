import { useCallback, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { usePoll, type PollRun } from "../../lib/usePoll";
import { worktreeChoiceText, worktreeName, type GitWorktree } from "../../lib/agents/agentWorktrees";
import { agentSwitchChoicesIn, moveAgentToWorktree, worktreeMoveDir } from "../../stores/agents/agentWorktreeSwitch";
import { useProjectsStore } from "../../stores/projects";
import type { TabEntry } from "../../stores/tabs";
import { Dropdown } from "../common/Dropdown";

export interface ReaderToolbarFile {
  path: string;
  label: string;
  open: () => void;
}

/** Only populated menus appear; file entries come from this conversation's
 * resolved links/inbox, and workspaces reuse the existing local worktree move. */
export function ReaderToolbarNavigation({ scope, tab, visible, busy, files }: {
  scope: string;
  tab: TabEntry;
  visible: boolean;
  busy: boolean;
  files: readonly ReaderToolbarFile[];
}) {
  const t = useT();
  const project = useProjectsStore((state) => state.projects.find((entry) => entry.id === scope));
  const projectDir = worktreeMoveDir(tab, project, !!tab.assistant);
  const [read, setRead] = useState<{ dir: string; choices: GitWorktree[] } | null>(null);
  const [moving, setMoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const poll = useCallback(async (run: PollRun) => {
    const choices = await agentSwitchChoicesIn(projectDir);
    if (!run.stopped) setRead({ dir: projectDir, choices });
  }, [projectDir]);
  usePoll(poll, 30_000, { enabled: visible && !!projectDir });
  const choices = useMemo(() => read?.dir === projectDir ? read.choices : [], [read, projectDir]);
  const move = (path: string) => {
    const to = choices.find((choice) => choice.path === path);
    if (!to || busy || moving) return;
    setMoving(true);
    setFailed(false);
    void moveAgentToWorktree(scope, tab, choices, to, t)
      .then((result) => setFailed(result === "failed"))
      .catch(() => setFailed(true))
      .finally(() => setMoving(false));
  };
  return <>
    {choices.length > 0 && <Dropdown
      className="reader-toolbar-dropdown"
      value=""
      placeholder={t("terminal.reader.workspaces", { count: choices.length })}
      ariaLabel={t("terminal.reader.workspaces", { count: choices.length })}
      title={t("terminal.reader.worktreeSwitchHint")}
      options={choices.map((choice) => ({ value: choice.path, label: worktreeChoiceText({ branch: choice.branch, name: worktreeName(choice.path), main: choice.is_main }, t).label }))}
      onChange={move}
      disabled={busy || moving}
    />}
    {files.length > 0 && <Dropdown
      className="reader-toolbar-dropdown"
      value=""
      placeholder={t("terminal.reader.files", { count: files.length })}
      ariaLabel={t("terminal.reader.files", { count: files.length })}
      options={files.map((file) => ({ value: file.path, label: file.label }))}
      onChange={(path) => files.find((file) => file.path === path)?.open()}
    />}
    {failed && <span className="reader-toolbar-error" role="alert">{t("terminal.reader.worktreeFailed")}</span>}
  </>;
}
