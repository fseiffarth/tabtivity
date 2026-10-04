import type { TabRow } from "../api";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { ageLabel } from "../terminal/fileLabels";

/** The desktop tab strip's PLAN and GOAL pills (`TabAgentModeMarks`): the
 *  session's own status line reads plan mode, or a `/goal` is running. The
 *  desktop reads them off the pane and sends them on; the phone only shows
 *  them, with the desktop's own words. Nothing while neither is on. */
export function AgentModeMarks({ tab }: { tab: Pick<TabRow, "agent_plan" | "agent_goal"> }) {
  const t = useT();
  if (!tab.agent_plan && !tab.agent_goal) return null;
  return <>
    {tab.agent_plan && <small className="agent-mode-mark plan" title={t("tabBar.modePlanTitle")}>{t("tabBar.modePlan")}</small>}
    {tab.agent_goal && <small className="agent-mode-mark goal" title={t("tabBar.modeGoalTitle")}>{t("tabBar.modeGoal")}</small>}
    {isUntested("mobile.project.modeMarks") && <span className="untested">{t("mobile.newTab.untested")}</span>}
  </>;
}

/** How many subagents the tab's session has at work right now, as the
 *  desktop counts them off its transcript. Nothing while none are. With
 *  `onOpen` the pill is a button: a tap lists the session's subagents
 *  (`SubagentsSheet`). */
export function SubagentCount({ tab, onOpen }: { tab: Pick<TabRow, "agent_subagents" | "label">; onOpen?: () => void }) {
  const t = useT();
  const count = tab.agent_subagents ?? 0;
  if (count <= 0) return null;
  const text = count === 1 ? t("mobile.project.subagentsOne") : t("mobile.project.subagents", { count });
  return <>
    {onOpen
      ? <button type="button" className="agent-subagent-count" onClick={onOpen} aria-haspopup="dialog" aria-label={t("mobile.project.subagentsOpen", { label: tab.label })} title={t("mobile.project.subagentsOpen", { label: tab.label })}>{text}</button>
      : <small className="agent-subagent-count" title={t("mobile.project.subagentsTitle")}>{text}</small>}
    {isUntested("mobile.project.subagentCount") && <span className="untested">{t("mobile.newTab.untested")}</span>}
  </>;
}

/** How long the tab has been at work on its current turn, or was on its last
 *  one: `running` while the turn is not over (working, or paused on a
 *  question). Every number is the desktop's own clock — for a working tab
 *  `working_at` is the desktop's "now" — so the phone's clock never enters it.
 *  Nothing where the end is unknown: an interrupted turn fires no finish.
 *  `end` is when the turn stopped, or the desktop's now while it runs. */
export function turnDuration(tab: Pick<TabRow, "agent_status" | "turn_started_at" | "working_at" | "done_at">): { ms: number; running: boolean; end: number } | undefined {
  const start = tab.turn_started_at;
  if (start === undefined) return undefined;
  const running = tab.agent_status === "working" || tab.agent_status === "question";
  const end = tab.agent_status === "working"
    ? tab.working_at
    : [tab.done_at, tab.working_at].find((at) => at !== undefined && at >= start);
  if (end === undefined || end < start) return undefined;
  return { ms: end - start, running, end };
}

/** "42s", "4m", "1h 12m" — a turn's length, as the card says it. */
export function formatTurnDuration(ms: number, t: ReturnType<typeof useT>): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t("mobile.project.durationSecs", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("mobile.project.durationMins", { count: minutes });
  return t("mobile.project.durationHours", { hours: Math.floor(minutes / 60), mins: minutes % 60 });
}

/** The tab's turn length on its card: "4m so far" while the turn is going,
 *  "took 12m · finished 3 h ago" once it is over. Nothing where the desktop
 *  gave no reading. The age is the phone's clock against the desktop's
 *  stamp — a rough one, as on the Activity list, which says it on its own
 *  line and so passes `finished={false}`. */
export function TurnDuration({ tab, finished = true }: { tab: Pick<TabRow, "agent_status" | "turn_started_at" | "working_at" | "done_at">; finished?: boolean }) {
  const t = useT();
  const turn = turnDuration(tab);
  if (!turn) return null;
  const duration = formatTurnDuration(turn.ms, t);
  const ago = !turn.running && finished ? ageLabel(Math.max(0, (Date.now() - turn.end) / 1000)) : undefined;
  return <>
    <small className={`agent-turn-time${turn.running ? " running" : ""}`} title={t(turn.running ? "mobile.project.turnRunningTitle" : "mobile.project.turnTookTitle", { duration })}>
      {t(turn.running ? "mobile.project.turnRunning" : "mobile.project.turnTook", { duration })}
      {ago && ` · ${t("mobile.project.turnFinished", { ago })}`}
    </small>
    {ago && isUntested("mobile.project.turnFinishedAgo") && <span className="untested">{t("mobile.newTab.untested")}</span>}
    {isUntested("mobile.project.turnDuration") && <span className="untested">{t("mobile.newTab.untested")}</span>}
  </>;
}

/** The linked worktree the tab's agent works in — "⎇ fix-login", its branch
 *  beside it where that is named differently. Nothing for the project
 *  folder's own checkout, which is where a tab runs unless it says. */
export function WorktreeMark({ tab }: { tab: Pick<TabRow, "worktree"> }) {
  const t = useT();
  const worktree = tab.worktree;
  if (!worktree) return null;
  const branch = worktree.branch && worktree.branch !== worktree.label ? worktree.branch : undefined;
  const title = worktree.branch
    ? t("mobile.project.worktreeTitle", { label: worktree.label, branch: worktree.branch })
    : t("mobile.project.worktreeDetachedTitle", { label: worktree.label });
  return <>
    <small className="agent-worktree" title={title}>
      <span aria-hidden="true">⎇</span> {worktree.label}{branch && <span className="agent-worktree-branch"> · {branch}</span>}
    </small>
    {isUntested("mobile.project.worktree") && <span className="untested">{t("mobile.newTab.untested")}</span>}
  </>;
}

/** The card class that tints a tab's border for the mode it is in — plan
 *  first, as the rarer and the one that changes nothing. */
export function agentModeClass(tab: Pick<TabRow, "agent_plan" | "agent_goal">): string {
  return tab.agent_plan ? " in-plan" : tab.agent_goal ? " in-goal" : "";
}
